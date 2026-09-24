// Automatic repo sync (D47): keeps the checkouts under TRIAGE_REPOS_DIR no
// older than TRIAGE_REPOS_SYNC_INTERVAL.
//
// - Triggers: the HTTP server's timer, the start of a run on an interface in
//   TRIAGE_REPOS_SYNC_INTERFACES (the run waits for the sync), `triage repos
//   sync` and POST /repos/sync. The timer and runs sync only when the last
//   good sync is older than the interval; the two manual triggers always
//   sync. Nothing here decides about mock mode: the timer is not started and
//   runs skip this step in mock mode, as they skip preflight.
// - <reposDir>/.triage-sync.json records the last attempt and the last good
//   sync: one where some repo synced, or none failed. A repo that keeps
//   failing (no access, say) does not make every run sync again; runs are
//   told which repos failed. A sync where every repo failed (off VPN, no key)
//   is a failed attempt, and the timer and runs wait RETRY_AFTER_MS before
//   the next try. A sync of one repo (--repo) records nothing.
// - <reposDir>/.triage-sync.lock/ is held while a sync runs, so the server,
//   CLI runs and `triage repos sync` never sync at the same time. It records
//   the pid; a lock whose process is gone, or older than LOCK_STALE_MS, is
//   taken over. Callers in one process share one sync.
// - A run that finds another process syncing waits for it, up to
//   LOCK_WAIT_MS, then uses the checkouts as they are.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import { writeFileAtomic } from '../runstore/atomic.ts';
import type { PreflightWarning } from '../types/classification.ts';
import type { Interface } from '../types/core.ts';
import { REPOS_DIR_KEY } from './codegraph.ts';
import { checkSelection, type ReposDeps, type ReposNotConfigured, type RepoSelection, type SyncReport, syncRepos } from './repos.ts';

export const SYNC_STATE_FILE = '.triage-sync.json';
export const SYNC_LOCK_DIR = '.triage-sync.lock';
const LOCK_OWNER_FILE = 'owner.json';

/** After a failed sync, the timer and runs wait this long before the next try. */
export const RETRY_AFTER_MS = 30 * 60 * 1000;
/** A lock older than this is left over from a crash, whatever its pid says. */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
/** Longest a run waits for another process's sync. */
export const LOCK_WAIT_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 2000;
/** A lock directory without its owner file yet is fresh for this long. */
const LOCK_WRITE_GRACE_MS = 60 * 1000;
/** How often the server timer checks whether a sync is due. */
export const TIMER_TICK_MS = 5 * 60 * 1000;

export type SyncTrigger = 'timer' | 'run' | 'cli' | 'http';

// ------------------------------------------------------------ state file

export const SyncStateSchema = v.object({
  last_attempt_at: v.string(),
  /** Absent until a sync finishes with no failed repo. */
  last_ok_at: v.optional(v.string()),
  trigger: v.picklist(['timer', 'run', 'cli', 'http']),
  ok: v.array(v.string()),
  skipped: v.array(v.string()),
  failed: v.array(v.string()),
});
export type SyncState = v.InferOutput<typeof SyncStateSchema>;

export type AutoSyncConfig = Pick<Config, 'paths' | 'repos'>;

function reposDirOf(config: Pick<Config, 'paths'>): string | undefined {
  const dir = config.paths.reposDir;
  return dir === undefined || dir.trim() === '' ? undefined : dir;
}

/** The state file, or undefined when there is none or it does not parse. */
export function readSyncState(reposDir: string): SyncState | undefined {
  let text: string;
  try {
    text = readFileSync(join(reposDir, SYNC_STATE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = v.safeParse(SyncStateSchema, JSON.parse(text));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

function stateAfter(report: Extract<SyncReport, { status: 'done' }>, trigger: SyncTrigger, at: string, before: SyncState | undefined): SyncState {
  const good = report.ok.length > 0 || report.failed.length === 0;
  const lastOk = good ? at : before?.last_ok_at;
  return {
    last_attempt_at: at,
    ...(lastOk !== undefined ? { last_ok_at: lastOk } : {}),
    trigger,
    ok: [...report.ok],
    skipped: [...report.skipped],
    failed: [...report.failed],
  };
}

// ------------------------------------------------------------ due check

export type Due =
  | { readonly due: true; readonly reason: 'never synced' | 'stale' }
  | { readonly due: false; readonly reason: 'fresh' | 'retry wait'; readonly next_at: string };

/** Whether the timer or a run should sync now. */
export function syncDue(state: SyncState | undefined, intervalMs: number, now: number): Due {
  if (state === undefined) return { due: true, reason: 'never synced' };
  const lastOk = state.last_ok_at === undefined ? undefined : Date.parse(state.last_ok_at);
  if (lastOk !== undefined && Number.isFinite(lastOk) && now - lastOk < intervalMs) {
    return { due: false, reason: 'fresh', next_at: new Date(lastOk + intervalMs).toISOString() };
  }
  const attempt = Date.parse(state.last_attempt_at);
  const failedLast = state.last_ok_at !== state.last_attempt_at;
  if (failedLast && Number.isFinite(attempt) && now - attempt < RETRY_AFTER_MS) {
    return { due: false, reason: 'retry wait', next_at: new Date(attempt + RETRY_AFTER_MS).toISOString() };
  }
  return { due: true, reason: lastOk === undefined ? 'never synced' : 'stale' };
}

// ------------------------------------------------------------ lock

type LockOwner = { readonly pid: number; readonly token: string; readonly started_at: string };

export type SyncLock = { release(): void };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EPERM';
  }
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), 'utf8')) as Partial<LockOwner>;
    if (typeof raw.pid === 'number' && typeof raw.token === 'string' && typeof raw.started_at === 'string') {
      return { pid: raw.pid, token: raw.token, started_at: raw.started_at };
    }
  } catch {
    // Missing or half written.
  }
  return undefined;
}

function lockIsStale(lockDir: string, now: number): boolean {
  const owner = readOwner(lockDir);
  if (owner === undefined) {
    // Another process may be between mkdir and writing its owner file.
    try {
      return now - statSync(lockDir).mtimeMs > LOCK_WRITE_GRACE_MS;
    } catch {
      return true;
    }
  }
  const started = Date.parse(owner.started_at);
  if (!Number.isFinite(started) || now - started > LOCK_STALE_MS) return true;
  return !pidAlive(owner.pid);
}

/** Takes the sync lock without waiting, or returns undefined when another live process holds it. */
export function tryAcquireSyncLock(reposDir: string, now: () => number = Date.now): SyncLock | undefined {
  const lockDir = join(reposDir, SYNC_LOCK_DIR);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err;
      if (!lockIsStale(lockDir, now())) return undefined;
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    const owner: LockOwner = { pid: process.pid, token: randomUUID(), started_at: new Date(now()).toISOString() };
    writeFileSync(join(lockDir, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`);
    return {
      release() {
        // Only this holder's lock is removed; a taken-over lock belongs to someone else.
        if (readOwner(lockDir)?.token === owner.token) rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
  return undefined;
}

// ------------------------------------------------------------ syncing

export type AutoSyncDeps = ReposDeps & {
  /** Epoch milliseconds. Defaults to Date.now. */
  readonly clock?: () => number;
  /** Waits between lock polls. Tests pass a fast one. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaces syncRepos, for tests. */
  readonly syncRepos?: typeof syncRepos;
};

export type AutoSyncResult =
  | { readonly status: 'synced'; readonly report: SyncReport; readonly state?: SyncState }
  | { readonly status: 'not_due'; readonly due: Extract<Due, { due: false }>; readonly state?: SyncState }
  | { readonly status: 'busy'; readonly reason: string }
  | ReposNotConfigured;

// One sync per repos dir per process; later callers share it.
const inflight = new Map<string, Promise<AutoSyncResult>>();

/** True while this process is syncing the repos dir. */
export function syncInFlight(config: Pick<Config, 'paths'>): boolean {
  const dir = reposDirOf(config);
  return dir !== undefined && inflight.has(dir);
}

function notConfigured(): ReposNotConfigured {
  return Object.freeze({ status: 'not_configured', key: REPOS_DIR_KEY, message: `repos not configured: ${REPOS_DIR_KEY} is blank` });
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

type Mode = { readonly trigger: SyncTrigger; readonly checkDue: boolean; readonly wait: boolean; readonly sel: RepoSelection };

async function runLocked(mode: Mode, deps: AutoSyncDeps, reposDir: string): Promise<AutoSyncResult> {
  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.config.repos.syncIntervalMs;
  const deadline = clock() + LOCK_WAIT_MS;
  mkdirSync(reposDir, { recursive: true });

  for (;;) {
    const before = readSyncState(reposDir);
    if (mode.checkDue) {
      const due = syncDue(before, intervalMs, clock());
      if (!due.due) return { status: 'not_due', due, ...(before !== undefined ? { state: before } : {}) };
    }
    const lock = tryAcquireSyncLock(reposDir, clock);
    if (lock === undefined) {
      if (!mode.wait) return { status: 'busy', reason: 'another process is syncing the repos' };
      if (clock() >= deadline) return { status: 'busy', reason: `another process was still syncing the repos after ${LOCK_WAIT_MS / 60000} min` };
      await sleep(LOCK_POLL_MS, deps.signal);
      continue;
    }
    try {
      // Another process may have finished a sync between the check and the lock.
      if (mode.checkDue) {
        const now = readSyncState(reposDir);
        const due = syncDue(now, intervalMs, clock());
        if (!due.due) return { status: 'not_due', due, ...(now !== undefined ? { state: now } : {}) };
      }
      const report = await (deps.syncRepos ?? syncRepos)(mode.sel, deps);
      if (report.status !== 'done' || mode.sel.repo !== undefined) return { status: 'synced', report };
      const state = stateAfter(report, mode.trigger, new Date(clock()).toISOString(), readSyncState(reposDir));
      await writeFileAtomic(join(reposDir, SYNC_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
      return { status: 'synced', report, state };
    } finally {
      lock.release();
    }
  }
}

function start(mode: Mode, deps: AutoSyncDeps): Promise<AutoSyncResult> {
  const reposDir = reposDirOf(deps.config);
  if (reposDir === undefined) return Promise.resolve(notConfigured());
  const running = inflight.get(reposDir);
  if (running !== undefined) {
    // A run waits for this process's sync and then reads the state it left.
    if (mode.wait) {
      const again = (): Promise<AutoSyncResult> => start(mode, deps);
      return running.then(again, again);
    }
    return Promise.resolve({ status: 'busy', reason: 'a sync is already running in this process' });
  }
  const p = runLocked(mode, deps, reposDir).finally(() => {
    if (inflight.get(reposDir) === p) inflight.delete(reposDir);
  });
  inflight.set(reposDir, p);
  return p;
}

/** The timer and runs: sync only when due. A run waits for a sync already under way. */
export function syncIfDue(trigger: 'timer' | 'run' | 'cli', deps: AutoSyncDeps): Promise<AutoSyncResult> {
  return start({ trigger, checkDue: true, wait: trigger === 'run', sel: {} }, deps);
}

/** `triage repos sync` and POST /repos/sync: sync now, or answer busy. Throws UnknownRepoError for a bad --repo, before any lock or write. */
export function syncNow(trigger: 'cli' | 'http', sel: RepoSelection, deps: AutoSyncDeps): Promise<AutoSyncResult> {
  if (sel.repo !== undefined) checkSelection(sel, deps);
  return start({ trigger, checkDue: false, wait: false, sel }, deps);
}

// ------------------------------------------------------------ before a run

/** Whether runs on this interface sync first. */
export function syncsOn(config: Pick<Config, 'repos'>, iface: Interface): boolean {
  return config.repos.syncInterfaces.includes(iface);
}

/**
 * The run step: sync when due and the interface is listed, then turn the
 * outcome into preflight warnings. Never throws for a sync problem; the run
 * goes on with the checkouts as they are.
 */
export async function syncBeforeRun(iface: Interface, deps: AutoSyncDeps): Promise<PreflightWarning[]> {
  if (!syncsOn(deps.config, iface)) return [];
  let result: AutoSyncResult;
  try {
    result = await syncIfDue('run', deps);
  } catch (err) {
    deps.signal?.throwIfAborted();
    return [repoWarning(`repo sync did not run (${err instanceof Error ? err.name : 'error'}); this run uses the checkouts as they are`)];
  }
  return runWarnings(result);
}

function repoWarning(message: string): PreflightWarning {
  return { step: 'repos', message, fix: 'run triage repos sync to see each repo' };
}

/** What a run should know about the checkouts it is about to read. */
export function runWarnings(result: AutoSyncResult): PreflightWarning[] {
  switch (result.status) {
    case 'not_configured':
      return [];
    case 'busy':
      return [repoWarning(`${result.reason}; this run uses the checkouts as they are`)];
    case 'not_due': {
      if (result.due.reason === 'fresh') {
        const failed = result.state?.failed ?? [];
        if (failed.length === 0) return [];
        return [repoWarning(`the last repo sync (${result.state?.last_attempt_at}) failed for ${failed.join(', ')}; those checkouts may be old`)];
      }
      const last = result.state?.last_ok_at;
      return [
        repoWarning(
          `the last repo sync failed, so the checkouts are ${last === undefined ? 'from before any good sync' : `from ${last}`}; the next try is after ${result.due.next_at}`,
        ),
      ];
    }
    case 'synced': {
      const report = result.report;
      if (report.status !== 'done') return [];
      const out: PreflightWarning[] = [];
      if (report.failed.length > 0) out.push(repoWarning(`repo sync failed for ${report.failed.join(', ')}; those checkouts are as they were`));
      const dirty = report.results.filter((r) => r.status === 'skipped' && r.reason === 'dirty').map((r) => r.repo);
      if (dirty.length > 0) out.push(repoWarning(`not updated because of local changes: ${dirty.join(', ')}`));
      return out;
    }
  }
}

// ------------------------------------------------------------ server timer

export type RepoSyncTimerHandle = unknown;

export type RepoSyncTimers = {
  setInterval(fn: () => void, ms: number): RepoSyncTimerHandle;
  clearInterval(handle: RepoSyncTimerHandle): void;
};

export type RepoSyncTimerOptions = {
  /** Where results and failures are logged. Defaults to stderr. */
  readonly log?: (line: string) => void;
  /** Tests pass fake timers. */
  readonly timers?: RepoSyncTimers;
  /** Builds the sync deps for one tick. Defaults to the real exec runner. */
  readonly deps?: () => AutoSyncDeps;
};

export type RepoSyncTimer = {
  /** False when the timer did not start, with the reason. */
  readonly on: boolean;
  readonly reason?: string;
  stop(): void;
  /** Resolves when no tick is running. */
  idle(): Promise<void>;
};

const defaultTimers: RepoSyncTimers = {
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

/** Why the server does not run the sync timer, or undefined when it does. */
export function timerOffReason(config: Pick<Config, 'mock' | 'paths' | 'repos'>): string | undefined {
  if (config.mock.enabled) return 'mock mode';
  if (!syncsOn(config, 'http')) return 'TRIAGE_REPOS_SYNC_INTERFACES does not list http';
  if (reposDirOf(config) === undefined) return `${REPOS_DIR_KEY} is blank`;
  return undefined;
}

/**
 * For the HTTP server process: checks at start and then every TIMER_TICK_MS
 * (or the interval, when shorter) whether a sync is due, and syncs when it
 * is. Logs one line per sync. Never throws out of a tick.
 */
export function startRepoSyncTimer(config: Config, deps: () => AutoSyncDeps, options: RepoSyncTimerOptions = {}): RepoSyncTimer {
  const off = timerOffReason(config);
  if (off !== undefined) return { on: false, reason: off, stop() {}, idle: async () => {} };
  const log = options.log ?? defaultLog;
  const timers = options.timers ?? defaultTimers;

  let stopped = false;
  let running: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    try {
      const result = await syncIfDue('timer', deps());
      if (result.status === 'synced' && result.report.status === 'done') {
        const r = result.report;
        safeLog(log, `triage repos: synced ${r.ok.length} ok, ${r.skipped.length} skipped, ${r.failed.length} failed${r.failed.length > 0 ? ` (${r.failed.join(', ')})` : ''}`);
      }
    } catch (err) {
      safeLog(log, `triage repos: sync failed (${err instanceof Error ? err.name : 'error'})`);
    }
  };
  const tick = (): void => {
    if (stopped || running !== null) return;
    running = runOnce().finally(() => {
      running = null;
    });
  };

  const handle = timers.setInterval(tick, Math.min(TIMER_TICK_MS, config.repos.syncIntervalMs));
  tick();
  return {
    on: true,
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
    // Logging must not break the timer.
  }
}
