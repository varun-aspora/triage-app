// Per-run budgets: tool calls, task delegations, rows, Quickwit hits and bytes.
// Every I/O tool asks its run's budget before doing anything else. All limits
// arrive as arguments (config and the entity registry supply them); this
// module reads no env. Budgets live in a process-level registry keyed by
// run_id, so counters for different runs never share state.
import * as v from 'valibot';
import { type Entity, EntitySchema, type RunId, RunIdSchema } from '../types/core.ts';

export const BUDGET_EXHAUSTED_MESSAGE = 'budget exhausted, finish with what you have';

// These tools let the model wrap up, so they pass even after exhaustion and
// are not counted.
export const BUDGET_EXEMPT_TOOLS: readonly string[] = ['finish_report', 'note_evidence'];

export type ExhaustedReason = 'tool_calls' | 'tasks' | 'bytes';

export interface EntityLimits {
  maxCalls?: number;
  maxHits: number;
}

export interface RunBudgetLimits {
  runId: RunId;
  maxToolCalls: number;
  maxTasks: number;
  maxRowsPerCall: number;
  maxBytesPerCall: number;
  maxBytesPerRun: number;
  perEntity?: Partial<Record<Entity, EntityLimits>>;
}

export type BudgetRefusalReason = ExhaustedReason | 'entity_calls';

export type BudgetDecision =
  | { ok: true }
  | { ok: false; message: typeof BUDGET_EXHAUSTED_MESSAGE; reason: BudgetRefusalReason };

// keepBytes is how much of the response the tool may keep; truncate is true
// when a single response is larger than maxBytesPerCall.
export type BytesDecision =
  | { ok: true; truncate: boolean; keepBytes: number }
  | { ok: false; message: typeof BUDGET_EXHAUSTED_MESSAGE; reason: ExhaustedReason };

export interface BudgetState {
  calls: number;
  tasks: number;
  bytes: number;
  entityCalls: Partial<Record<Entity, number>>;
  exhausted: boolean;
  exhaustedReason?: ExhaustedReason;
}

export interface RunBudget {
  readonly runId: RunId;
  consumeToolCall(tool: string, entity?: Entity): BudgetDecision;
  consumeTask(): BudgetDecision;
  clampRows(n?: number): number;
  clampHits(entity: Entity, n?: number): number;
  accountBytes(n: number): BytesDecision;
  state(): BudgetState;
}

export class BudgetConfigError extends Error {
  override readonly name = 'BudgetConfigError';
}

const registry = new Map<RunId, RunBudget>();

function requirePositiveInt(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BudgetConfigError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function requireRequest(name: string, n: number): number {
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`${name} must be a non-negative number, got ${String(n)}`);
  }
  return Math.floor(n);
}

function validateEntityLimits(perEntity: RunBudgetLimits['perEntity']): Map<Entity, EntityLimits> {
  const out = new Map<Entity, EntityLimits>();
  for (const [key, limits] of Object.entries(perEntity ?? {})) {
    if (!v.is(EntitySchema, key)) throw new BudgetConfigError(`unknown entity in perEntity: ${key}`);
    if (limits === undefined) continue;
    const maxHits = requirePositiveInt(`perEntity.${key}.maxHits`, limits.maxHits);
    const entry: EntityLimits = { maxHits };
    if (limits.maxCalls !== undefined) {
      entry.maxCalls = requirePositiveInt(`perEntity.${key}.maxCalls`, limits.maxCalls);
    }
    out.set(key, entry);
  }
  return out;
}

// Builds the budget for one run and registers it. A second budget for the same
// run_id throws, because silently replacing it would reset the counters.
export function createRunBudget(limits: RunBudgetLimits): RunBudget {
  if (!v.is(RunIdSchema, limits.runId)) {
    throw new BudgetConfigError(`invalid runId: ${String(limits.runId)}`);
  }
  const runId = limits.runId;
  const maxToolCalls = requirePositiveInt('maxToolCalls', limits.maxToolCalls);
  const maxTasks = requirePositiveInt('maxTasks', limits.maxTasks);
  const maxRowsPerCall = requirePositiveInt('maxRowsPerCall', limits.maxRowsPerCall);
  const maxBytesPerCall = requirePositiveInt('maxBytesPerCall', limits.maxBytesPerCall);
  const maxBytesPerRun = requirePositiveInt('maxBytesPerRun', limits.maxBytesPerRun);
  const perEntity = validateEntityLimits(limits.perEntity);
  if (registry.has(runId)) throw new BudgetConfigError(`budget already exists for run ${runId}`);

  let calls = 0;
  let tasks = 0;
  let bytes = 0;
  const entityCalls = new Map<Entity, number>();
  let exhaustedReason: ExhaustedReason | undefined;

  const refuse = <R extends BudgetRefusalReason>(
    reason: R,
  ): { ok: false; message: typeof BUDGET_EXHAUSTED_MESSAGE; reason: R } => ({
    ok: false,
    message: BUDGET_EXHAUSTED_MESSAGE,
    reason,
  });

  // Exhaustion is sticky: the first reason is kept for the escalation check.
  const exhaust = (reason: ExhaustedReason): void => {
    exhaustedReason ??= reason;
  };

  const budget: RunBudget = {
    runId,

    consumeToolCall(tool, entity) {
      if (BUDGET_EXEMPT_TOOLS.includes(tool)) return { ok: true };
      if (exhaustedReason !== undefined) return refuse(exhaustedReason);
      if (calls >= maxToolCalls) {
        exhaust('tool_calls');
        return refuse('tool_calls');
      }
      if (entity !== undefined) {
        if (!v.is(EntitySchema, entity)) throw new RangeError(`unknown entity: ${String(entity)}`);
        // A per-entity cap refuses that entity only; the run is not exhausted.
        const cap = perEntity.get(entity)?.maxCalls;
        const used = entityCalls.get(entity) ?? 0;
        if (cap !== undefined && used >= cap) return refuse('entity_calls');
        entityCalls.set(entity, used + 1);
      }
      calls += 1;
      return { ok: true };
    },

    consumeTask() {
      if (exhaustedReason !== undefined) return refuse(exhaustedReason);
      if (tasks >= maxTasks) {
        exhaust('tasks');
        return refuse('tasks');
      }
      tasks += 1;
      return { ok: true };
    },

    clampRows(n) {
      if (n === undefined) return maxRowsPerCall;
      return Math.min(requireRequest('rows', n), maxRowsPerCall);
    },

    clampHits(entity, n) {
      const limits = perEntity.get(entity);
      if (limits === undefined) throw new BudgetConfigError(`no hit cap configured for entity ${entity}`);
      if (n === undefined) return limits.maxHits;
      return Math.min(requireRequest('hits', n), limits.maxHits);
    },

    accountBytes(n) {
      const size = requireRequest('bytes', n);
      if (exhaustedReason !== undefined) return refuse(exhaustedReason);
      const truncate = size > maxBytesPerCall;
      const keepBytes = Math.min(size, maxBytesPerCall);
      if (bytes + keepBytes > maxBytesPerRun) {
        exhaust('bytes');
        return refuse('bytes');
      }
      bytes += keepBytes;
      return { ok: true, truncate, keepBytes };
    },

    state() {
      const snapshot: BudgetState = {
        calls,
        tasks,
        bytes,
        entityCalls: Object.fromEntries(entityCalls),
        exhausted: exhaustedReason !== undefined,
      };
      if (exhaustedReason !== undefined) snapshot.exhaustedReason = exhaustedReason;
      return snapshot;
    },
  };

  registry.set(runId, budget);
  return budget;
}

export function getRunBudget(runId: RunId): RunBudget | undefined {
  return registry.get(runId);
}

// Drops a finished run's budget so the registry does not grow for the life of
// the process. Returns false when there was nothing to drop.
export function releaseRunBudget(runId: RunId): boolean {
  return registry.delete(runId);
}
