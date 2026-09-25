// The one wrapper every I/O tool runs through, so the order of checks is fixed
// in one place (HLD 02 §2 and §3, D2, D19, D20, D26, D27, D42, D45):
//
//   signal -> budget -> scope -> gate -> not configured -> mock or real
//   -> audit -> stage to /data -> model-facing redaction -> envelope
//
// Every decision writes exactly one audit line, refusals included. Refusals
// come back as short model-facing text and the run continues. Two things
// throw on purpose: an aborted signal (before the budget is touched) and a
// strict mock miss (a loud tool error that names the semantic key). A
// connector error that is not a refusal comes back as "did not answer" and
// is also recorded for the run (connector-failures.ts), which is what lets
// stop_blocked park the run on that system (D55).
//
// Staging is owned here and nowhere else: stageRows() writes the full result
// to /data/<toolCallId>.json in the sandbox. On the virtual sandbox it writes
// model-facing text; e2b and daytona leave the machine, so they get
// persisted-profile text only (D45).

import type { FlueLogger, Sandbox } from '@flue/runtime';
import type { Config } from '../../config/env.ts';
import { makeAuditLine } from '../../gate/audit.ts';
import { checkScope, type LogsMode } from '../../gate/scope.ts';
import { redactModelFacing, redactPersisted } from '../../gate/redact.ts';
import { FixtureMissError } from '../../mock/errors.ts';
import type { FixtureEntity, FixtureKind, SemanticKey } from '../../mock/types.ts';
import type { AuditDecision, AuditTransport } from '../../types/audit.ts';
import type { Entity } from '../../types/core.ts';
import { notConfigured, ok, refused, type ToolEnvelope, unreachable } from '../../types/tool-result.ts';
import type { ToolContext } from '../types.ts';
import { recordConnectorFailure } from './connector-failures.ts';
import { scopeSetOf } from './context.ts';

// ------------------------------------------------------------------ types

/** The steps of runIoTool, in order. onStep reports each one as it starts. */
export const PIPELINE_STEPS = [
  'signal',
  'budget',
  'scope',
  'gate',
  'not_configured',
  'io',
  'audit',
  'stage',
  'redact',
  'envelope',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** A tool-specific gate result. rule_index and action go on the audit line (http_call, cbs_call). */
export type GateDecision =
  | { readonly ok: true; readonly rule_index?: number | 'default'; readonly action?: 'allow' | 'block' }
  | {
      readonly ok: false;
      /** Short text for the model: what was refused and what to do instead. */
      readonly message: string;
      /** For the audit line. Passes the persisted profile there. */
      readonly reason: string;
      readonly rule_index?: number | 'default';
      readonly action?: 'allow' | 'block';
    };

/**
 * The env var behind the call. A registry Capability fits: status 'ok' means
 * the value is set. Only envName ever reaches an audit line; the value never
 * reaches this module.
 */
export type BackingRef = { readonly envName: string; readonly status: string };

export type ScopeOptions = {
  /** What to check. Defaults to spec.input. */
  readonly params?: unknown;
  readonly systemic?: boolean;
  /** From the SQL parser: true when the select list is aggregate-only. */
  readonly sqlAggregateOnly?: boolean;
  readonly logsMode?: LogsMode;
};

export type FixtureRef<K extends FixtureKind> = {
  readonly kind: K;
  /** Built with semanticKey(kind, facts) from src/mock/key.ts. */
  readonly key: SemanticKey<K>;
  /** Defaults to the tool's entity, or 'global' when it has none. */
  readonly entity?: FixtureEntity;
};

export type IoToolSpec<K extends FixtureKind, T> = {
  /** Model-facing tool name, for the budget and the audit line. */
  readonly tool: string;
  /** Registry service, for the audit line and the not-configured text. */
  readonly service: string;
  /** The validated tool input. */
  readonly input: unknown;
  readonly backing: BackingRef;
  /** 'skip' only for tools that take no id-shaped input (code tools). */
  readonly scope: ScopeOptions | 'skip';
  /** Pure checks specific to the tool (SQL parser, URL builder, rules). */
  readonly gate?: () => GateDecision;
  /** The fixture for this call. Called only after every check passed. */
  readonly fixture: () => FixtureRef<K>;
  /** The real call through a connector. Never called in mock mode. */
  readonly real: (signal: AbortSignal) => Promise<T>;
  /** The capped, model-facing summary of the full result. */
  readonly render: (value: T) => unknown;
  /** The full result to stage as /data/<toolCallId>.json. Row-returning tools only. */
  readonly stage?: (value: T) => unknown;
  /** Audit summary for an allowed call. Passes the persisted profile. */
  readonly summary?: (value: T) => string;
  /** Count-only tools (decrypt_fields, encrypt_lookup_value): values handled. */
  readonly count?: number;
  /** Overrides the context entity, for the few tools that act across entities. */
  readonly entity?: Entity | null;
};

/** The sandbox surface staging needs: a harness tool's harness. */
export type StagingHarness = { readonly sandbox: Pick<Sandbox, 'writeFile'> };

/** What runIoTool needs from the tool: its context plus Flue's run context. */
export type IoRunContext = {
  readonly toolContext: ToolContext;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
  readonly log: FlueLogger;
  /** Present on harness: true tools. Without it nothing is staged. */
  readonly harness?: StagingHarness;
  /** Told as each step starts. Observes only; it cannot change the outcome. */
  readonly onStep?: (step: PipelineStep) => void;
};

// ------------------------------------------------------------------ staging

export type StageProfile = 'model_facing' | 'persisted';

export type StageResult =
  | { readonly staged: true; readonly path: string; readonly profile: StageProfile }
  | { readonly staged: false; readonly reason: string };

export type StageOptions = {
  /** Ingress names for the persisted profile (D24). */
  readonly names?: readonly string[];
  /** Where a staging failure is reported. */
  readonly log?: Pick<FlueLogger, 'warn'>;
};

const REMOTE_SANDBOXES: ReadonlySet<string> = new Set(['e2b', 'daytona']);

/** The profile staged text passes for the configured sandbox provider (D45). */
export function stageProfileFor(config: Pick<Config, 'sandbox'>): StageProfile | null {
  const provider = config.sandbox.provider;
  if (provider === 'virtual') return 'model_facing';
  if (REMOTE_SANDBOXES.has(provider)) return 'persisted';
  // local is refused by config and the doctor; never stage into it.
  return null;
}

/** /data/<id>.json with the id reduced to safe characters, so it cannot leave /data. */
export function stagePath(toolCallId: string): string | null {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  if (safe.replace(/_/g, '').length === 0) return null;
  return `/data/${safe}.json`;
}

/**
 * Writes the full result of a call to /data/<toolCallId>.json. Never throws:
 * a failure is logged and reported in the result, and the call goes on.
 */
export async function stageRows(
  harness: StagingHarness | undefined,
  toolCallId: string,
  rows: unknown,
  config: Pick<Config, 'sandbox'>,
  opts: StageOptions = {},
): Promise<StageResult> {
  if (harness === undefined) return { staged: false, reason: 'no harness' };
  const profile = stageProfileFor(config);
  if (profile === null) return { staged: false, reason: `sandbox provider ${config.sandbox.provider} is not staged into` };
  const path = stagePath(toolCallId);
  if (path === null) return { staged: false, reason: 'tool call id has no usable characters' };
  try {
    const safe =
      profile === 'persisted'
        ? redactPersisted(rows, opts.names !== undefined ? { names: opts.names } : {}).value
        : redactModelFacing(rows);
    const text = JSON.stringify(safe ?? null);
    // harness.sandbox throws when the agent has no sandbox, so read it here.
    await harness.sandbox.writeFile(path, text);
    return { staged: true, path, profile };
  } catch (err) {
    // Name only: an error message could quote the data being staged.
    const name = err instanceof Error ? err.name : typeof err;
    opts.log?.warn(`staging ${path} failed (${name}); the call result is still returned`, { tool_call_id: toolCallId });
    return { staged: false, reason: `staging failed (${name})` };
  }
}

// ------------------------------------------------------------------ pipeline

type AuditExtra = {
  readonly decision: AuditDecision;
  readonly exit: number | string;
  readonly transport: AuditTransport;
  readonly reason?: string;
  readonly summary?: string;
  readonly gate?: GateDecision;
};

// Connector error codes (T04.1) that mean a policy refusal rather than an outage.
const REFUSAL_CODES: ReadonlySet<string> = new Set(['refused', 'readonly_role_required', 'cap_exceeded']);

function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Runs one I/O tool call through the fixed pipeline and returns the envelope.
 * Throws only for an aborted signal and a strict mock miss.
 */
export async function runIoTool<K extends FixtureKind, T>(
  spec: IoToolSpec<K, T>,
  ctx: IoRunContext,
): Promise<ToolEnvelope> {
  const step = (name: PipelineStep): void => ctx.onStep?.(name);
  const { toolContext } = ctx;

  step('signal');
  ctx.signal?.throwIfAborted();

  const deps = toolContext.deps;
  const now = deps.now;
  const started = now().getTime();
  const entity = spec.entity !== undefined ? spec.entity : toolContext.entity;
  const where = `${entity ?? 'global'}:${spec.service}`;
  const names = deps.run.redactionNames;
  const mockMode = deps.fixtures.settings.mockMode;

  const audit = (extra: AuditExtra): void => {
    step('audit');
    const gate = extra.gate;
    const line = makeAuditLine(
      {
        run_id: toolContext.runId,
        ts: now().toISOString(),
        interface: deps.run.interface,
        entity,
        tool: spec.tool,
        decision: extra.decision,
        ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        service: spec.service,
        target: spec.backing.envName,
        transport: extra.transport,
        summary: extra.summary ?? `${spec.tool} ${where}`,
        duration_ms: Math.max(0, now().getTime() - started),
        exit: extra.exit,
        ...(gate?.rule_index !== undefined && gate.action !== undefined
          ? { rule_index: gate.rule_index, action: gate.action }
          : {}),
        ...(spec.count !== undefined ? { count: spec.count } : {}),
      },
      { names },
    );
    deps.audit.write(line);
  };

  // Denies before any I/O: the transport is what the run is configured for.
  const noIoTransport: AuditTransport = mockMode ? 'mock' : 'real';

  const finish = (build: (text: string) => ToolEnvelope, text: string): ToolEnvelope => {
    step('redact');
    const safe = redactModelFacing(text);
    step('envelope');
    return build(safe);
  };
  const refuse = (text: string): ToolEnvelope => finish((t) => refused(t, now), text);
  const notConfiguredEnvelope = (): ToolEnvelope =>
    entity === null
      ? refuse(`not configured for ${spec.service}`)
      : finish(() => notConfigured(entity, spec.service, now), '');

  // 1. Budget.
  step('budget');
  const budget = deps.budget.consumeToolCall(spec.tool, entity ?? undefined);
  if (!budget.ok) {
    if (budget.reason !== 'entity_calls') deps.escalation.markBudgetExhausted();
    audit({ decision: 'deny', exit: 'refused', transport: noIoTransport, reason: `budget: ${budget.reason}` });
    return refuse(budget.message);
  }

  // 2. Scope: every id-shaped value must be in the run's IdChain (D26).
  if (spec.scope !== 'skip') {
    step('scope');
    const options = spec.scope;
    const result = checkScope({
      tool: spec.tool,
      params: options.params !== undefined ? options.params : spec.input,
      scopeSet: scopeSetOf(deps),
      ...(options.systemic !== undefined ? { systemic: options.systemic } : {}),
      ...(options.sqlAggregateOnly !== undefined ? { sqlAggregateOnly: options.sqlAggregateOnly } : {}),
      ...(options.logsMode !== undefined ? { logsMode: options.logsMode } : {}),
    });
    if (!result.ok) {
      audit({ decision: 'deny', exit: 'refused', transport: noIoTransport, reason: result.reason });
      return refuse(
        `Refused: ${result.reason}. Use only ids from the brief or the ID chain; ` +
          "for counts across customers use scope: 'systemic'.",
      );
    }
  }

  // 3. Tool-specific gate.
  let gate: GateDecision = { ok: true };
  if (spec.gate !== undefined) {
    step('gate');
    gate = spec.gate();
    if (!gate.ok) {
      audit({ decision: 'deny', exit: 'refused', transport: noIoTransport, reason: gate.reason, gate });
      return refuse(gate.message);
    }
  }

  // 4. Not configured: the backing env var is blank or missing.
  step('not_configured');
  if (spec.backing.status !== 'ok') {
    audit({
      decision: 'deny',
      exit: 'not_configured',
      transport: noIoTransport,
      reason: `not configured: ${spec.backing.envName} is blank`,
      gate,
    });
    return notConfiguredEnvelope();
  }

  // 5. Mock or real. resolveIo never calls real() in mock mode (D19).
  step('io');
  const fixture = spec.fixture();
  const signal = ctx.signal ?? new AbortController().signal;
  let outcome: Awaited<ReturnType<typeof deps.fixtures.resolveIo<K, T>>>;
  try {
    outcome = await deps.fixtures.resolveIo({
      kind: fixture.kind,
      entity: fixture.entity ?? entity ?? 'global',
      key: fixture.key,
      real: spec.real,
      signal,
      run_id: toolContext.runId,
      redaction_names: names,
    });
  } catch (err) {
    if (signal.aborted) {
      audit({ decision: 'allow', exit: 'aborted', transport: noIoTransport, gate });
      throw err;
    }
    if (err instanceof FixtureMissError) {
      audit({ decision: 'allow', exit: 'fixture_miss', transport: 'mock', summary: `${spec.tool} ${where}: strict fixture miss`, gate });
      throw err;
    }
    const code = errorCode(err);
    if (code === 'strict_miss') {
      audit({ decision: 'allow', exit: 'fixture_miss', transport: 'mock', summary: `${spec.tool} ${where}: strict fixture miss`, gate });
      throw err;
    }
    // Fixed texts only: a connector error message could carry a host or DSN.
    ctx.log.warn(`${spec.tool} ${where} failed (${code ?? (err instanceof Error ? err.name : 'error')})`);
    if (code === 'not_configured') {
      audit({ decision: 'deny', exit: 'not_configured', transport: 'real', reason: `not configured: ${spec.backing.envName}`, gate });
      return notConfiguredEnvelope();
    }
    if (code !== undefined && REFUSAL_CODES.has(code)) {
      audit({ decision: 'deny', exit: code, transport: 'real', reason: `connector: ${code}`, gate });
      return refuse(`Refused by the ${where} connector (${code}). Record the gap and try another source.`);
    }
    audit({ decision: 'allow', exit: code ?? 'error', transport: 'real', gate });
    // The one outcome stop_blocked may later cite (D55). Only the codes the
    // block record knows; anything else is an 'error'.
    recordConnectorFailure(toolContext.runId, {
      system: where,
      tool: spec.tool,
      code: code === 'unreachable' || code === 'timeout' ? code : 'error',
      at: now().toISOString(),
    });
    return finish(
      (t) => unreachable(t, now),
      `${where} did not answer (${code ?? 'error'}). Record the gap and try another source.`,
    );
  }

  if (outcome.fixture_miss) {
    audit({ decision: 'allow', exit: 'fixture_miss', transport: 'mock', summary: `${spec.tool} ${where}: no fixture`, gate });
    return refuse(`No ${fixture.kind} fixture for this call (mock mode). Treat it as no data and record the gap.`);
  }

  // 6. Audit the allowed call.
  const value = outcome.value;
  audit({
    decision: 'allow',
    exit: 'ok',
    transport: outcome.transport,
    ...(spec.summary !== undefined ? { summary: spec.summary(value) } : {}),
    gate,
  });

  // 7. Stage the full result. A failure is logged and does not fail the call.
  let stagedPath: string | undefined;
  if (spec.stage !== undefined) {
    step('stage');
    const staged = await stageRows(ctx.harness, ctx.toolCallId, spec.stage(value), toolContext.config, {
      names,
      log: ctx.log,
    });
    if (staged.staged) stagedPath = staged.path;
  }

  // 8. Model-facing redaction, then 9. the envelope.
  const rendered = spec.render(value);
  const data = stagedPath !== undefined && isPlainObject(rendered) ? { ...rendered, staged_file: stagedPath } : rendered;
  step('redact');
  const safe = redactModelFacing(data);
  step('envelope');
  return ok(asJson(safe), now);
}

// Flue JSON-stringifies tool output; round-tripping here makes the envelope
// plain JSON (dates become strings, undefined fields drop) and turns a value
// that cannot be serialised into a loud error instead of a broken result.
function asJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
