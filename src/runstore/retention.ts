// Retention and erasure for the run store (D43, HLD 02 §7).
//
// Retention is time based: TRIAGE_RUNS_RETENTION_DAYS days after a run was
// created, pruneExpired deletes it through the store. Blank means keep, and
// no run is looked at. Flue has no scheduler, so pruning runs from
// `triage runs prune` or from startRetentionTimer in the HTTP server process.
//
// Erasure (eraseRun, `triage runs delete`) clears the run store only. It does
// not reach Flue's conversation stream, the global audit log or other runs
// that received this run as a prior case. ERASURE_LIMITS says so, and callers
// print it. Nothing here touches Flue's own tables or the audit file.

import type { Config } from '../config/env.ts';
import type { RunId } from '../types/core.ts';
import { assertRunId, RunNotFoundError, RunStoreError, type RunStore } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionConfig = { readonly runs: Pick<Config['runs'], 'retentionDays'> };

export type PruneResult = {
  /** Runs removed from the store. */
  readonly deleted: number;
  /** Expired idempotency claims removed. */
  readonly idempotency_cleared: number;
  /** The window in days, or null when retention is off. */
  readonly retention_days: number | null;
  /** Runs created before this time were expired, or null when retention is off. */
  readonly cutoff: string | null;
};

/** Some expired runs could not be deleted. The others were. Carries run ids and counts only. */
export class RetentionPruneError extends RunStoreError {
  override name = 'RetentionPruneError';
  readonly failed: readonly RunId[];
  readonly result: PruneResult;
  constructor(failed: readonly RunId[], result: PruneResult) {
    super(`could not delete ${failed.length} expired run(s): ${failed.join(', ')}; deleted ${result.deleted}`);
    this.failed = failed;
    this.result = result;
  }
}

/** The retention window in days, or undefined when retention is off. */
export function retentionDays(config: RetentionConfig): number | undefined {
  const days = config.runs.retentionDays;
  if (days === undefined) return undefined;
  if (!Number.isInteger(days) || days < 1) throw new RunStoreError('retention days must be a whole number of at least 1');
  return days;
}

/**
 * Deletes every run created more than the retention window before now, then
 * clears expired idempotency claims. With retention off no run is listed or
 * deleted; expired claims are still cleared, since they are past their own
 * TTL and hold no run data.
 *
 * A run that fails to delete does not stop the others. When any failed, the
 * claims are still cleared and a RetentionPruneError is thrown at the end.
 */
export async function pruneExpired(store: RunStore, config: RetentionConfig, now: Date | number = Date.now()): Promise<PruneResult> {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(nowMs)) throw new RunStoreError('invalid prune time');
  const days = retentionDays(config);

  let deleted = 0;
  const failed: RunId[] = [];
  let cutoff: Date | null = null;
  if (days !== undefined) {
    cutoff = new Date(nowMs - days * DAY_MS);
    for (const runId of await store.listExpired(cutoff)) {
      try {
        if (await store.deleteRun(runId)) deleted++;
      } catch {
        failed.push(runId);
      }
    }
  }
  const cleared = await store.clearExpiredIdempotencyKeys();

  const result: PruneResult = {
    deleted,
    idempotency_cleared: cleared,
    retention_days: days ?? null,
    cutoff: cutoff?.toISOString() ?? null,
  };
  if (failed.length > 0) throw new RetentionPruneError(failed, result);
  return result;
}

// ------------------------------------------------------------------ erasure

/** What erasing a run does not reach. Fixed text, printed by `triage runs delete`. */
export const ERASURE_LIMITS: readonly string[] = Object.freeze([
  "Flue's conversation stream for this run is not deleted. It lives in Flue's own persistence, which this command does not touch.",
  'The global audit log (TRIAGE_AUDIT_LOG) is append-only and is not changed. Its entries for this run stay.',
  "Other runs that received this run as a prior case keep it in their initial data and reports.",
]);

export type EraseResult = {
  readonly run_id: RunId;
  readonly deleted: true;
  readonly provider: RunStore['provider'];
  readonly not_reached: readonly string[];
};

/**
 * Removes one run from the store and returns the limits statement. An unknown
 * run id throws RunNotFoundError before anything is deleted, so the store's
 * cleanup of idempotency claims does not run for it either.
 */
export async function eraseRun(store: RunStore, runId: string): Promise<EraseResult> {
  const id = assertRunId(runId);
  if ((await store.getRun(id)) === null) throw new RunNotFoundError(id);
  // Another process may have deleted it since the check.
  if (!(await store.deleteRun(id))) throw new RunNotFoundError(id);
  return { run_id: id, deleted: true, provider: store.provider, not_reached: ERASURE_LIMITS };
}

// ------------------------------------------------------------------ timer

export type RetentionTimerHandle = unknown;

export type RetentionTimers = {
  setInterval(fn: () => void, ms: number): RetentionTimerHandle;
  clearInterval(handle: RetentionTimerHandle): void;
};

export type RetentionTimerOptions = {
  /** Time between prunes. Defaults to one day. */
  readonly intervalMs?: number;
  /** Epoch milliseconds. Tests pass a fake clock. */
  readonly now?: () => number;
  /** Where failures and results are logged. Defaults to stderr. */
  readonly log?: (line: string) => void;
  /** Tests pass fake timers. */
  readonly timers?: RetentionTimers;
};

export type RetentionTimer = {
  /** Stops the timer. A prune already running finishes. Safe to call twice. */
  stop(): void;
  /** Resolves when no prune is running. */
  idle(): Promise<void>;
};

const defaultTimers: RetentionTimers = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    // The timer alone must not keep the process alive.
    handle.unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Prunes once now and then every intervalMs, for the HTTP server process
 * (T07.10). Errors are logged by name and counts only and never thrown out of
 * the timer. A tick that fires while a prune is still running is skipped.
 */
export function startRetentionTimer(store: RunStore, config: RetentionConfig, options: RetentionTimerOptions = {}): RetentionTimer {
  const intervalMs = options.intervalMs ?? DAY_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RunStoreError('retention interval must be a positive number');
  const now = options.now ?? Date.now;
  const log = options.log ?? defaultLog;
  const timers = options.timers ?? defaultTimers;

  let stopped = false;
  let running: Promise<void> | null = null;

  const tick = (): void => {
    if (stopped || running !== null) return;
    running = runOnce().finally(() => {
      running = null;
    });
  };

  const runOnce = async (): Promise<void> => {
    try {
      const result = await pruneExpired(store, config, now());
      if (result.deleted > 0 || result.idempotency_cleared > 0) {
        safeLog(log, `triage retention: deleted ${result.deleted} run(s), cleared ${result.idempotency_cleared} idempotency key(s)`);
      }
    } catch (err) {
      safeLog(log, `triage retention: prune failed (${describe(err)})`);
    }
  };

  const handle = timers.setInterval(tick, intervalMs);
  tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(handle);
    },
    async idle() {
      while (running !== null) await running;
    },
  };
}

function safeLog(log: (line: string) => void, line: string): void {
  try {
    log(line);
  } catch {
    // A broken logger must not break the timer.
  }
}

// The error name only, plus the run ids and counts of a partial prune. Store
// and driver messages can carry connection details, so they are not logged.
function describe(err: unknown): string {
  if (err instanceof RetentionPruneError) return `${err.name}: ${err.failed.length} run(s) not deleted, ${err.result.deleted} deleted`;
  if (err instanceof Error) return err.name;
  return 'unknown error';
}
