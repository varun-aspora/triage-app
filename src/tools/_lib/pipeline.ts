// The one wrapper every I/O tool runs through, so the order of checks is fixed
// in one place (HLD 02 §2 and §3, D2, D19, D20, D26, D27, D42, D45):
//
//   signal -> repeat -> budget -> scope -> gate -> not configured
//   -> mock or real -> audit -> derived leads -> stage to /data
//   -> model-facing redaction -> result cap -> envelope
//
// Derived leads (D97): a tool that sets spec.leads hands over the records of
// its full result. When the call was tied to an id in scope, every new
// id-shaped value in them joins the run's chain (deriveLeads in
// src/gate/scope.ts, addLeads in context.ts). Each added lead and each field
// that added none is written to the run event log, values masked.
//
// Model-facing redaction follows TRIAGE_MODEL_REDACTION (D107, redactForModel):
// off, the default, masks credentials only, so the model reads raw data; on
// is the model-facing profile.
//
// Repeat (D79): a tool that sets spec.repeat opts into the run's repeat
// cache (src/runlog/actions.ts). An exact repeat of an earlier ok call in the
// same run gets that result back with a note naming who ran it and when,
// writes one audit line with exit 'reused' and uses no budget. The earlier
// call passed scope and the gate with the same input, and scope only grows
// during a run, so the lookup can come first. Refusals and errors are never
// kept, so they run again.
//
// Every decision writes exactly one audit line, refusals included. Refusals
// come back as short model-facing text and the run continues. Two things
// throw on purpose: an aborted signal (before the budget is touched) and a
// strict mock miss (a loud tool error that names the semantic key). A
// connector error that is not a refusal comes back as "did not answer" and
// is also recorded for the run (connector-failures.ts), which is what lets
// stop_blocked park the run on that system (D55). Every connector error the
// model sees carries its real reason (scrubbed, capped, model-facing
// redaction) and a hint for what to try next.
//
// Staging is owned here and nowhere else: stageRows() writes the full result
// to /data/<toolCallId>.json in the sandbox. On the virtual sandbox it writes
// what the model sees: raw with TRIAGE_MODEL_REDACTION=off (credentials still
// masked), model-facing text with on. e2b and daytona leave the machine, so
// they get persisted-profile text only (D45).
//
// The result cap (D104) is owned here too: after redaction, a result whose
// JSON is over TRIAGE_MAX_MODEL_BYTES_PER_CALL is replaced by a summary
// (capModelResult) that keeps the counts, the first few rows or hits and the
// staged_file path, and says how to read the rest with read_staged or how
// to narrow the call. runCodeTool calls the same helper, so repo_* results
// are capped the same way.

import type { FlueLogger, Sandbox } from '@flue/runtime';
import type { Config } from '../../config/env.ts';
import { errorText, excerpt, safeErrorText, scrubSecrets, stripAddresses } from '../../connectors/error-text.ts';
import { makeAuditLine } from '../../gate/audit.ts';
import { isExhausted } from '../../gate/budget.ts';
import { checkScope, deriveLeads, type LogsMode, maskId, type LeadCall } from '../../gate/scope.ts';
import type { RowKeys } from '../../gate/sql.ts';
import { classifySqlState, isSqlState, maskSqlValues, sqlErrorMessage, type SqlStateInfo } from '../../gate/sql-errors.ts';
import { redactForModel, redactPersisted } from '../../gate/redact.ts';
import { FixtureMissError } from '../../mock/errors.ts';
import { keyString } from '../../mock/key.ts';
import type { FixtureEntity, FixtureKind, SemanticKey } from '../../mock/types.ts';
import { findRepeat, rememberRepeat } from '../../runlog/actions.ts';
import { logRunEvent } from '../../runlog/event-log.ts';
import type { AuditDecision, AuditTransport } from '../../types/audit.ts';
import type { Entity } from '../../types/core.ts';
import { notConfigured, ok, refused, type ToolEnvelope, unreachable } from '../../types/tool-result.ts';
import type { ToolContext } from '../types.ts';
import { recordConnectorFailure } from './connector-failures.ts';
import { addLeads, scopeSetOf } from './context.ts';

// ------------------------------------------------------------------ types

/** The steps of runIoTool, in order. onStep reports each one as it starts. */
export const PIPELINE_STEPS = [
  'signal',
  'repeat',
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

/** A tool-specific gate result. rule_index and action go on the audit line (http_call). */
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
export type BackingRef = {
  readonly envName: string;
  readonly status: string;
  /** Why it is off when that is more than a blank env var. Goes to the model and the audit line. */
  readonly reason?: string;
};

export type ScopeOptions = {
  /** What to check. Defaults to spec.input. */
  readonly params?: unknown;
  readonly systemic?: boolean;
  /** From the SQL parser: true when the select list is aggregate-only. */
  readonly sqlAggregateOnly?: boolean;
  readonly logsMode?: LogsMode;
  /** Correlation ids seen in earlier results of the run (D77). */
  readonly observed?: ReadonlySet<string>;
  /** The query reads only its service's scope_exempt_tables (D89). */
  readonly sqlConfigTablesOnly?: boolean;
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
  /**
   * The records of the full result to read for derived leads (D97), with the
   * SQL parser's row keys for sql_select. Leave it out for tools whose
   * results never add ids.
   */
  readonly leads?: (value: T) => { readonly records: readonly unknown[]; readonly rowKeys?: RowKeys };
  /** Audit summary for an allowed call. Passes the persisted profile. */
  readonly summary?: (value: T) => string;
  /** Count-only tools (decrypt_fields, encrypt_lookup_value): values handled. */
  readonly count?: number;
  /** Overrides the context entity, for the few tools that act across entities. */
  readonly entity?: Entity | null;
  /**
   * Opts the call into the run's repeat cache (D79). Returns what makes two
   * calls the same (the validated input, plus the window the tool resolved
   * when the model gave none), or false when this call must run again (a
   * read of "now", a write). Leave it out for tools with side effects.
   */
  readonly repeat?: () => unknown;
  /**
   * The tool's own summary when the result is over the cap (D104). Leave it
   * out for the generic one. It passes the model-facing redaction, and gets
   * the over_cap fields and the note added.
   */
  readonly overCap?: (value: T, cap: number) => unknown;
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

/** raw: TRIAGE_MODEL_REDACTION=off on the virtual sandbox, credentials still masked (D107). */
export type StageProfile = 'raw' | 'model_facing' | 'persisted';

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
export function stageProfileFor(config: Pick<Config, 'sandbox' | 'redaction'>): StageProfile | null {
  const provider = config.sandbox.provider;
  if (provider === 'virtual') return config.redaction.model === 'off' ? 'raw' : 'model_facing';
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
  config: Pick<Config, 'sandbox' | 'redaction'>,
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
        : redactForModel(rows, config);
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
  readonly sqlstate?: string;
};

// Connector error codes (T04.1) that mean a policy refusal rather than an outage.
const REFUSAL_CODES: ReadonlySet<string> = new Set(['refused', 'readonly_role_required', 'cap_exceeded']);

function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
}

// The SQLSTATE a SQL connector error carries (SqlStateError), checked for shape.
function sqlStateOf(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const sqlstate = (err as { sqlstate?: unknown }).sqlstate;
  return isSqlState(sqlstate) ? sqlstate : undefined;
}

// What the model is told to do next after a connector refusal. None of them
// ends at "give up": each names a change to try first.
const REFUSAL_HINTS: Readonly<Record<string, string>> = {
  refused: 'Change the call to fit what the message says and retry; if this source cannot answer it, try another source and record the gap if none can.',
  readonly_role_required:
    'Reads on this database are blocked until its role is made read-only. Try another source for the same facts; record the gap if none has them.',
  cap_exceeded: 'The answer was too large. Narrow the call (shorter time window, fewer rows, fields or hits) and retry.',
};
const TIMEOUT_HINT = 'Retry once, or narrow the call (shorter time window, smaller result); if it still fails, try another source and record the gap if none answers.';
const UNREACHABLE_HINT = 'Retry once later or try another source for the same facts; record the gap if nothing else answers.';

/** Error detail on the audit line: shorter than what the model gets. */
const AUDIT_DETAIL_CHARS = 300;

// The server's own text on a SQL connector error (SqlStateError.serverMessage).
// pg-client masks stored values at the source; masking again here (it is
// idempotent) covers a connector that did not.
function serverMessageOf(err: unknown, sqlstate: string): string | undefined {
  const text = (err as { serverMessage?: unknown } | null)?.serverMessage;
  return typeof text === 'string' && text.trim() !== '' ? safeErrorText(maskSqlValues(sqlstate, stripAddresses(scrubSecrets(text)))) : undefined;
}

// The connector's message (for a ConnectorError only that: the connector
// built it from the cause with its secrets taken out) or an error's text and
// scrubbed causes, scrubbed again and capped, without the
// "<entity>:<service>: " prefix most connector messages start with. URLs and
// addresses are replaced as well, in case a connector passed on a DSN or an
// endpoint it did not know to scrub. A SQL error has its stored values masked.
function errorDetail(err: unknown, where: string, sqlstate: string | undefined): string {
  const server = sqlstate !== undefined ? serverMessageOf(err, sqlstate) : undefined;
  if (server !== undefined) return server;
  let text = errorText(err);
  if (text.startsWith(`${where}: `)) text = text.slice(where.length + 2);
  text = stripAddresses(scrubSecrets(text));
  return safeErrorText(sqlstate !== undefined ? maskSqlValues(sqlstate, text) : text);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
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
        ...(extra.sqlstate !== undefined ? { sqlstate: extra.sqlstate } : {}),
      },
      { names },
    );
    deps.audit.write(line);
  };

  // Denies before any I/O: the transport is what the run is configured for.
  const noIoTransport: AuditTransport = mockMode ? 'mock' : 'real';

  const finish = <V>(build: (safe: V) => ToolEnvelope, value: V): ToolEnvelope => {
    step('redact');
    const safe = redactForModel(value, toolContext.config);
    step('envelope');
    return build(safe);
  };
  const refuse = (text: string): ToolEnvelope => finish((t) => refused(t, now), text);
  const notConfiguredEnvelope = (reason?: string): ToolEnvelope =>
    entity === null
      ? refuse(`not configured for ${spec.service}`)
      : finish(() => notConfigured(entity, spec.service, now, reason), '');

  // 1. Repeat: an exact repeat of an earlier ok call in this run. A spent run
  // budget skips it, so the model reads the budget message instead.
  const repeatKey = repeatKeyOf(spec.tool, where, spec.repeat);
  if (repeatKey !== undefined) {
    step('repeat');
    const earlier = deps.budget.state().exhausted ? undefined : findRepeat(toolContext.runId, repeatKey, now());
    if (earlier !== undefined) {
      audit({ decision: 'allow', exit: 'reused', transport: noIoTransport, summary: `${spec.tool} ${where}: result reused` });
      return earlier;
    }
  }

  // 2. Budget.
  step('budget');
  const budget = deps.budget.consumeToolCall(spec.tool, entity ?? undefined, { dataTool: true });
  if (!budget.ok) {
    // An entity or per-tool cap or the time rule (D87) refuses this call only; the run goes on.
    if (isExhausted(budget.reason)) deps.escalation.markBudgetExhausted();
    audit({ decision: 'deny', exit: 'refused', transport: noIoTransport, reason: `budget: ${budget.reason}` });
    return refuse(budget.message);
  }

  // 3. Scope: every id-shaped value must be in the run's IdChain (D26).
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
      ...(options.observed !== undefined ? { observed: options.observed } : {}),
      ...(options.sqlConfigTablesOnly !== undefined ? { sqlConfigTablesOnly: options.sqlConfigTablesOnly } : {}),
      maxLeadDepth: toolContext.config.budgets.maxLeadDepth,
    });
    if (!result.ok) {
      audit({ decision: 'deny', exit: 'refused', transport: noIoTransport, reason: result.reason });
      return refuse(
        `Refused: ${result.reason}. Use only ids from the brief or the ID chain; ` +
          "for counts across customers use scope: 'systemic'.",
      );
    }
  }

  // 4. Tool-specific gate.
  let gate: GateDecision = { ok: true };
  if (spec.gate !== undefined) {
    step('gate');
    gate = spec.gate();
    if (!gate.ok) {
      audit({ decision: 'deny', exit: 'refused', transport: noIoTransport, reason: gate.reason, gate });
      return refuse(gate.message);
    }
  }

  // 5. Not configured: the backing env var is blank or missing.
  step('not_configured');
  if (spec.backing.status !== 'ok') {
    audit({
      decision: 'deny',
      exit: 'not_configured',
      transport: noIoTransport,
      reason: `not configured: ${spec.backing.reason ?? `${spec.backing.envName} is blank`}`,
      gate,
    });
    return notConfiguredEnvelope(spec.backing.reason);
  }

  // 6. Mock or real. resolveIo never calls real() in mock mode (D19).
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
    const code = errorCode(err);
    if (err instanceof FixtureMissError || code === 'strict_miss') {
      audit({ decision: 'allow', exit: 'fixture_miss', transport: 'mock', summary: `${spec.tool} ${where}: strict fixture miss`, gate });
      throw err;
    }
    // The real reason goes back to the model, so it can fix the call or pick
    // the next step: the connector's message (connectors scrub what they know
    // of DSNs, URLs and tokens; scrubSecrets runs again here for anything
    // shaped like a credential), capped, then the model-facing redaction in
    // finish(). A SQL error adds its SQLSTATE, the fixed description and the
    // advice for it (src/gate/sql-errors.ts), with stored values masked. The
    // audit reason carries a shorter excerpt and passes the persisted
    // profile; the log line and the failure record keep codes only. The
    // model-facing text is also persisted (the run event log, the Flue
    // session history), and the persisted profile only knows the run
    // customer's names, so what could name anyone else is taken out at the
    // source, in the connectors and here, not by that profile.
    const sqlstate = sqlStateOf(err);
    const sql = sqlstate !== undefined ? classifySqlState(sqlstate) : undefined;
    const detail = errorDetail(err, where, sqlstate);
    const sqlMessage = (info: SqlStateInfo): string => sqlErrorMessage(info, where, serverMessageOf(err, info.sqlstate));
    const noted = (reason: string): string => (detail === '' ? reason : `${reason}: ${excerpt(detail, AUDIT_DETAIL_CHARS)}`);
    ctx.log.warn(
      `${spec.tool} ${where} failed (${code ?? (err instanceof Error ? err.name : 'error')}${sqlstate !== undefined ? ` ${sqlstate}` : ''})`,
      ...(sqlstate !== undefined ? [{ sqlstate }] : []),
    );
    if (code === 'not_configured') {
      audit({ decision: 'deny', exit: 'not_configured', transport: 'real', reason: `not configured: ${spec.backing.envName}`, gate });
      return notConfiguredEnvelope();
    }
    if (sql?.category === 'query') {
      // The gate allowed it and the database rejected it: the model can fix
      // the query, so this is neither a gap nor a failure of the system.
      audit({
        decision: 'allow',
        exit: 'query_error',
        transport: 'real',
        reason: noted(`sqlstate ${sql.sqlstate}: ${sql.description}`),
        gate,
        sqlstate: sql.sqlstate,
      });
      return refuse(sqlMessage(sql));
    }
    if (code !== undefined && REFUSAL_CODES.has(code)) {
      audit({
        decision: 'deny',
        exit: code,
        transport: 'real',
        reason: noted(sql !== undefined ? `connector: ${code}, sqlstate ${sql.sqlstate}: ${sql.description}` : `connector: ${code}`),
        gate,
        ...(sql !== undefined ? { sqlstate: sql.sqlstate } : {}),
      });
      return refuse(
        sql !== undefined
          ? sqlMessage(sql)
          : `${sentence(`${spec.tool} on ${where} was refused (${code})${detail !== '' ? `: ${detail}` : ''}`)} ${REFUSAL_HINTS[code] ?? REFUSAL_HINTS['refused']}`,
      );
    }
    audit({
      decision: 'allow',
      exit: code ?? 'error',
      transport: 'real',
      gate,
      ...(detail !== '' ? { reason: noted(`connector: ${code ?? 'error'}`) } : {}),
      ...(sql !== undefined ? { sqlstate: sql.sqlstate } : {}),
    });
    // The one outcome stop_blocked may later cite (D55). Only the codes the
    // block record knows; anything else is an 'error'. A passing server
    // condition (a deadlock, a serialization failure, memory pressure: SQL
    // category 'retryable') is not recorded: the model is told to retry, and
    // one deadlock must not let stop_blocked park the run.
    if (sql?.category !== 'retryable') {
      recordConnectorFailure(toolContext.runId, {
        system: where,
        tool: spec.tool,
        code: code === 'unreachable' || code === 'timeout' ? code : 'error',
        at: now().toISOString(),
      });
    }
    return finish(
      (t) => unreachable(t, now),
      sql !== undefined
        ? sqlMessage(sql)
        : `${sentence(`${where} did not answer (${code ?? 'error'})${detail !== '' ? `: ${detail}` : ''}`)} ${code === 'timeout' ? TIMEOUT_HINT : UNREACHABLE_HINT}`,
    );
  }

  if (outcome.fixture_miss) {
    audit({ decision: 'allow', exit: 'fixture_miss', transport: 'mock', summary: `${spec.tool} ${where}: no fixture`, gate });
    return refuse(`No ${fixture.kind} fixture for this call (mock mode). Treat it as no data and record the gap.`);
  }

  // 7. Audit the allowed call.
  const value = outcome.value;
  audit({
    decision: 'allow',
    exit: 'ok',
    transport: outcome.transport,
    ...(spec.summary !== undefined ? { summary: spec.summary(value) } : {}),
    gate,
  });

  // 8. Derived leads from the full result (D97).
  if (spec.leads !== undefined && spec.scope !== 'skip') {
    const { records, rowKeys } = spec.leads(value);
    const scope = spec.scope;
    const call: LeadCall = {
      tool: spec.tool,
      toolCallId: ctx.toolCallId,
      params: scope.params !== undefined ? scope.params : spec.input,
      ...(rowKeys !== undefined ? { rowKeys } : {}),
      ...(scope.systemic !== undefined ? { systemic: scope.systemic } : {}),
    };
    recordLeads(toolContext, call, records);
  }

  // 9. Stage the full result. A failure is logged and does not fail the call.
  let staged: StageResult | undefined;
  if (spec.stage !== undefined) {
    step('stage');
    staged = await stageRows(ctx.harness, ctx.toolCallId, spec.stage(value), toolContext.config, { names, log: ctx.log });
  }
  const stagedPath = staged?.staged === true ? staged.path : undefined;

  // 10. Model-facing redaction, the result cap (D104), then 11. the envelope.
  // An over-cap result of a tool that stages nothing gets its rendered value
  // staged now, so the summary can still point at a file.
  const rendered = spec.render(value);
  const data = stagedPath !== undefined && isPlainObject(rendered) ? { ...rendered, staged_file: stagedPath } : rendered;
  step('redact');
  const safe = asJson(redactForModel(data, toolContext.config));
  const cap = toolContext.config.budgets.maxModelBytesPerCall;
  const overCap = spec.overCap;
  const capped = await fitModelResult(safe, {
    cap,
    ...(stagedPath !== undefined ? { stagedFile: stagedPath } : {}),
    ...(staged === undefined
      ? { stage: () => stageRows(ctx.harness, ctx.toolCallId, rendered, toolContext.config, { names, log: ctx.log }) }
      : !staged.staged
        ? { notStaged: staged.reason }
        : {}),
    ...(overCap !== undefined ? { custom: () => asJson(redactForModel(overCap(value, cap), toolContext.config)) } : {}),
  });
  step('envelope');
  const envelope = ok(capped, now);
  if (repeatKey !== undefined) {
    rememberRepeat(toolContext.runId, repeatKey, envelope, toolContext.agent ?? 'an earlier call', now().toISOString());
  }
  return envelope;
}

// ------------------------------------------------------------------ derived leads (D97)

// Adds the call's derived leads to the run's chain and writes one run event
// per added lead and per skipped field. Values are masked; a skip carries
// counts only.
function recordLeads(toolContext: ToolContext, call: LeadCall, records: readonly unknown[]): void {
  const deps = toolContext.deps;
  const { budgets } = toolContext.config;
  const found = deriveLeads(deps.idChain(), scopeSetOf(deps), call, records, {
    maxDepth: budgets.maxLeadDepth,
    maxPerField: budgets.maxDerivedPerField,
  });
  for (const lead of found.leads.length > 0 ? addLeads(deps, found.leads) : []) {
    logRunEvent(toolContext.runId, 'lead', {
      value: maskId({ kind: lead.kind, normalised: lead.value }),
      kind: lead.kind,
      depth: lead.depth,
      parent: lead.parent,
      tool: call.tool,
      tool_call_id: call.toolCallId,
      field: lead.via?.field,
    });
  }
  for (const skip of found.skipped) {
    logRunEvent(toolContext.runId, 'lead_skipped', { ...skip, tool: call.tool, tool_call_id: call.toolCallId });
  }
}

// ------------------------------------------------------------------ result cap (D104)

// Fields an over-cap summary keeps as they are: counts, the query, paging and
// notes, plus the other keys the run action log reads (outcomeOf in
// src/runlog/actions.ts).
const OVER_CAP_KEEP: ReadonlySet<string> = new Set([
  'service',
  'row_count',
  'num_hits',
  'count',
  'tally_base',
  'truncated',
  'status',
  'query',
  'window',
  'offset',
  'next_offset',
  'notes',
  'distinct',
  'matches',
  'evidence_id',
]);
// Arrays already ordered by count: their summary is the top items.
const OVER_CAP_TOP: ReadonlySet<string> = new Set(['groups', 'message_groups']);
// The summary's own fields, which a tool's result or custom summary cannot override.
const OVER_CAP_HEAD = ['over_cap', 'bytes', 'cap', 'staged_file', 'note'];
/** Long strings in a summary are cut to this many characters. */
export const OVER_CAP_STRING_CHARS = 200;
/** A body (http_call) is cut to this many characters. */
export const OVER_CAP_BODY_CHARS = 2048;
// Items kept from each array, tried in order until the summary fits.
const OVER_CAP_ITEMS = [20, 10, 5, 3, 1, 0];
// Nesting below this depth is shown as cut JSON text.
const OVER_CAP_DEPTH = 3;
const NARROW = 'count or group_by first, fewer columns, a shorter window';

/** The UTF-8 byte length of a value's JSON, as the model gets it. */
export function modelBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null));
}

export type OverCapOptions = {
  /** TRIAGE_MAX_MODEL_BYTES_PER_CALL. */
  readonly cap: number;
  /** The file with the full result. Defaults to the result's own staged_file. */
  readonly stagedFile?: string;
  /** Why nothing was staged, when there is no file. */
  readonly notStaged?: string;
  /** A tool's own summary, already redacted (IoToolSpec.overCap). */
  readonly custom?: unknown;
};

/**
 * The redacted result as it is when its JSON fits the cap, otherwise a
 * summary that does: over_cap, bytes, cap and staged_file, the fields in
 * OVER_CAP_KEEP as they are, every array as { total, first } (or top), long
 * strings cut, a body cut to about 2 KB, and a note on what to do next.
 * Fewer items are kept until it fits. Pure.
 */
export function capModelResult(safe: unknown, opts: OverCapOptions): unknown {
  const bytes = modelBytes(safe);
  if (bytes <= opts.cap) return safe;
  const own = isPlainObject(safe) && typeof safe.staged_file === 'string' ? safe.staged_file : undefined;
  const file = opts.stagedFile ?? own;
  const head = { over_cap: true, bytes, cap: opts.cap, ...(file !== undefined ? { staged_file: file } : {}) };
  const note =
    file !== undefined
      ? `Over ${opts.cap} bytes; the full result is in staged_file. Read a slice with read_staged (jq or lines), or narrow the call: ${NARROW}.`
      : `Over ${opts.cap} bytes and not staged (${opts.notStaged ?? 'nothing to stage'}); narrow the call: ${NARROW}.`;
  const fits = (value: unknown): boolean => modelBytes(value) <= opts.cap;

  if (isPlainObject(opts.custom)) {
    const summary = { ...head, ...withoutHead(opts.custom), note };
    if (fits(summary)) return summary;
  }
  const base = opts.custom !== undefined ? opts.custom : safe;
  for (const items of OVER_CAP_ITEMS) {
    const summary = { ...head, ...summarise(base, items), note };
    if (fits(summary)) return summary;
  }
  // Still too big (a huge query or notes): the numbers only.
  const numbers = isPlainObject(base)
    ? Object.fromEntries(Object.entries(base).filter(([k, v]) => OVER_CAP_KEEP.has(k) && (typeof v === 'number' || typeof v === 'boolean')))
    : {};
  const last = { ...head, ...numbers, note };
  return fits(last) ? last : { ...head, note };
}

export type FitOptions = Omit<OverCapOptions, 'custom'> & {
  /** Stages the full result, called only when it is over the cap and nothing is staged. */
  readonly stage?: () => Promise<StageResult>;
  /** The tool's own summary, redacted. Called only when over the cap. */
  readonly custom?: () => unknown;
};

/** capModelResult, staging the full result first when it is over the cap and has no file yet. */
export async function fitModelResult(safe: unknown, opts: FitOptions): Promise<unknown> {
  if (modelBytes(safe) <= opts.cap) return safe;
  let stagedFile = opts.stagedFile;
  let notStaged = opts.notStaged;
  if (stagedFile === undefined && opts.stage !== undefined) {
    const staged = await opts.stage();
    if (staged.staged) stagedFile = staged.path;
    else notStaged = staged.reason;
  }
  return capModelResult(safe, {
    cap: opts.cap,
    ...(stagedFile !== undefined ? { stagedFile } : {}),
    ...(notStaged !== undefined ? { notStaged } : {}),
    ...(opts.custom !== undefined ? { custom: opts.custom() } : {}),
  });
}

function withoutHead(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !OVER_CAP_HEAD.includes(k)));
}

/** text cut to chars characters, with its full length shown after the cut. */
export function cutText(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars)}… [${text.length} chars]`;
}

// The top-level fields of a summary, keeping `items` of each array.
function summarise(value: unknown, items: number): Record<string, unknown> {
  if (Array.isArray(value)) return { items: listSummary(value, items, 'first') };
  if (typeof value === 'string') return { text: cutText(value, OVER_CAP_BODY_CHARS) };
  if (!isPlainObject(value)) return { value };
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(withoutHead(value))) {
    if (OVER_CAP_KEEP.has(key)) out[key] = field;
    else if (Array.isArray(field)) out[key] = listSummary(field, items, OVER_CAP_TOP.has(key) ? 'top' : 'first');
    else if (key === 'body') out[key] = cutText(typeof field === 'string' ? field : JSON.stringify(field) ?? '', OVER_CAP_BODY_CHARS);
    else out[key] = shrink(field, items, 1);
  }
  return out;
}

function listSummary(list: readonly unknown[], items: number, label: 'first' | 'top'): Record<string, unknown> {
  return { total: list.length, [label]: list.slice(0, items).map((item) => shrink(item, items, 1)) };
}

// Strings cut, arrays kept to `items`, deep nesting shown as cut JSON text.
function shrink(value: unknown, items: number, depth: number): unknown {
  if (typeof value === 'string') return cutText(value, OVER_CAP_STRING_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= OVER_CAP_DEPTH) return cutText(JSON.stringify(value) ?? '', OVER_CAP_STRING_CHARS);
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => shrink(item, items, depth + 1));
    return value.length <= items ? kept : { total: value.length, first: kept };
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, items, depth + 1)]));
}

// The repeat cache key: tool, target and the facts spec.repeat returns, as
// canonical JSON (src/mock/key.ts). Not the fixture's semantic key: that one
// leaves out the SQL text and the logs window and paging, so different
// questions would share it.
function repeatKeyOf(tool: string, where: string, repeat: (() => unknown) | undefined): string | undefined {
  if (repeat === undefined) return undefined;
  try {
    const facts = repeat();
    return facts === false ? undefined : keyString({ tool, where, facts });
  } catch {
    return undefined;
  }
}

// Flue JSON-stringifies tool output; round-tripping here makes the envelope
// plain JSON (dates become strings, undefined fields drop) and turns a value
// that cannot be serialised into a loud error instead of a broken result.
function asJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
