// What repo_read and repo_grep share: the repo picklist, the enabled() rule
// and the run wrapper (signal, budget, audit line, model-facing redaction,
// envelope). They read local disk only, so they do not go through the mock
// layer: in mock mode they read the same TRIAGE_REPOS_DIR and the audit line
// says transport mock (D19, D42).

import type { Config } from '../../../config/env.ts';
import type { Registry } from '../../../config/registry.ts';
import { loadRepos, type RepoPin, repoEnum } from '../../../config/repos.ts';
import { makeAuditLine } from '../../../gate/audit.ts';
import { redactModelFacing } from '../../../gate/redact.ts';
import type { AuditTransport } from '../../../types/audit.ts';
import type { Entity } from '../../../types/core.ts';
import { ok, refused, type ToolEnvelope } from '../../../types/tool-result.ts';
import type { ToolContext, ToolEnabled } from '../../types.ts';
// Brings in the ToolDeps fields (budget, audit, fixtures, ...).
import type {} from '../../_lib/context.ts';

export const REPOS_DIR_KEY = 'TRIAGE_REPOS_DIR';
/** The service name on audit lines. */
export const REPO_SERVICE = 'repo';

// repos.json is read once per config object, so enabled() and prompt renders stay cheap.
const pinsByConfig = new WeakMap<Config, readonly RepoPin[] | Error>();

/** The repos.json pins for this config, or the error loading them. Cached per config object. */
export function pinsFor(config: Config, registry: Registry): readonly RepoPin[] | Error {
  let pins = pinsByConfig.get(config);
  if (pins === undefined) {
    try {
      pins = loadRepos(config, registry);
    } catch (err) {
      pins = err instanceof Error ? err : new Error('repos.json did not load');
    }
    pinsByConfig.set(config, pins);
  }
  return pins;
}

function entitiesFor(ctx: Pick<ToolContext, 'entity' | 'config' | 'registry'>): readonly Entity[] {
  if (ctx.entity !== null) return [ctx.entity];
  return ctx.registry.entities.filter((e) => ctx.config.entities.includes(e));
}

/**
 * The repo names a code tool may take here: repos.json pins and registry
 * repos for the context's entity, or for every enabled entity on code_walker.
 */
export function repoNamesFor(ctx: Pick<ToolContext, 'entity' | 'config' | 'registry'>): readonly string[] {
  const pins = pinsFor(ctx.config, ctx.registry);
  if (pins instanceof Error) return [];
  return repoEnum(ctx.registry, pins, entitiesFor(ctx)).names;
}

export function codeToolEnabled(ctx: ToolContext): ToolEnabled {
  const dir = ctx.config.paths.reposDir;
  if (dir === undefined || dir.trim() === '') return { on: false, reason: `${REPOS_DIR_KEY} is blank` };
  if (pinsFor(ctx.config, ctx.registry) instanceof Error) return { on: false, reason: 'resources/repos.json did not load' };
  if (repoNamesFor(ctx).length === 0) return { on: false, reason: 'no repos for this entity in resources/repos.json' };
  return { on: true };
}

export type CodeOutcome =
  | { readonly ok: true; readonly data: unknown; readonly summary: string }
  | { readonly ok: false; readonly message: string; readonly reason: string };

export type CodeRunSpec = {
  readonly tool: string;
  readonly ctx: ToolContext;
  readonly signal?: AbortSignal;
  /** The work itself. Only called after the budget allowed the call. */
  readonly work: () => Promise<CodeOutcome>;
};

/**
 * Runs one code tool call and returns the envelope. Every decision writes
 * one audit line. Throws only when the signal is aborted.
 */
export async function runCodeTool(spec: CodeRunSpec): Promise<ToolEnvelope> {
  spec.signal?.throwIfAborted();
  const { ctx } = spec;
  const deps = ctx.deps;
  const now = deps.now;
  const started = now().getTime();
  const transport: AuditTransport = deps.fixtures.settings.mockMode ? 'mock' : 'real';

  const audit = (decision: 'allow' | 'deny', exit: string, summary: string, reason?: string): void => {
    deps.audit.write(
      makeAuditLine(
        {
          run_id: ctx.runId,
          ts: now().toISOString(),
          interface: deps.run.interface,
          entity: ctx.entity,
          tool: spec.tool,
          decision,
          ...(reason !== undefined ? { reason } : {}),
          service: REPO_SERVICE,
          target: REPOS_DIR_KEY,
          transport,
          summary,
          duration_ms: Math.max(0, now().getTime() - started),
          exit,
        },
        { names: deps.run.redactionNames },
      ),
    );
  };
  const refuse = (message: string): ToolEnvelope => refused(redactModelFacing(message), now);

  const budget = deps.budget.consumeToolCall(spec.tool, ctx.entity ?? undefined);
  if (!budget.ok) {
    if (budget.reason !== 'entity_calls') deps.escalation.markBudgetExhausted();
    audit('deny', 'refused', spec.tool, `budget: ${budget.reason}`);
    return refuse(budget.message);
  }

  const outcome = await spec.work();
  if (!outcome.ok) {
    audit('deny', 'refused', spec.tool, outcome.reason);
    return refuse(outcome.message);
  }

  const safe = asJson(redactModelFacing(outcome.data));
  const bytes = deps.budget.accountBytes(Math.max(1, Buffer.byteLength(JSON.stringify(safe))));
  if (!bytes.ok) {
    deps.escalation.markBudgetExhausted();
    audit('deny', 'refused', outcome.summary, `budget: ${bytes.reason}`);
    return refuse(bytes.message);
  }
  audit('allow', 'ok', outcome.summary);
  return ok(safe, now);
}

function asJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
