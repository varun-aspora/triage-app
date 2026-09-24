import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { createFakeRunner } from '../../src/connectors/exec-fake.ts';
import {
  type AutoSyncDeps,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  readSyncState,
  RETRY_AFTER_MS,
  runWarnings,
  startRepoSyncTimer,
  SYNC_LOCK_DIR,
  SYNC_STATE_FILE,
  syncBeforeRun,
  syncDue,
  syncIfDue,
  syncNow,
  type SyncState,
  TIMER_TICK_MS,
  timerOffReason,
  tryAcquireSyncLock,
} from '../../src/ops/repos-autosync.ts';
import type { SyncReport } from '../../src/ops/repos.ts';
import { testEnvRecord } from '../support/home.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-24T10:00:00.000Z');

let scratch: string;
let reposDir: string;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'triage-autosync-')));
  reposDir = join(scratch, 'repos');
  mkdirSync(reposDir);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function configWith(overrides: Record<string, string> = {}): Config {
  return configFromRecord({ ...testEnvRecord(), TRIAGE_MOCK_MODE: 'false', TRIAGE_REPOS_DIR: reposDir, ...overrides }, join(scratch, 'home'));
}

const done = (ok: string[], failed: string[] = [], skipped: string[] = []): SyncReport => ({
  status: 'done',
  results: [
    ...ok.map((repo) => ({ repo, status: 'ok' as const, warnings: [], line: `${repo}: ok` })),
    ...failed.map((repo) => ({ repo, status: 'failed' as const, reason: 'x', warnings: [], line: `${repo}: failed` })),
    ...skipped.map((repo) => ({ repo, status: 'skipped' as const, reason: 'dirty', warnings: [], line: `${repo}: skipped` })),
  ],
  ok,
  skipped,
  failed,
});

/** Deps whose syncRepos is counted and answers `report`. The runner refuses every call. */
function deps(report: SyncReport, opts: { clock?: () => number; overrides?: Record<string, string>; sleep?: AutoSyncDeps['sleep'] } = {}) {
  const counter = { calls: 0 };
  const d: AutoSyncDeps = {
    config: configWith(opts.overrides),
    runner: createFakeRunner([]),
    clock: opts.clock ?? (() => T0),
    repos: [{ repo: 'harbor', entities: ['ssfb'] }],
    syncRepos: async () => {
      counter.calls++;
      return report;
    },
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
  };
  return { d, counter };
}

function state(over: Partial<SyncState>): SyncState {
  return { last_attempt_at: new Date(T0).toISOString(), trigger: 'timer', ok: [], skipped: [], failed: [], ...over };
}

function writeState(s: SyncState): void {
  writeFileSync(join(reposDir, SYNC_STATE_FILE), JSON.stringify(s));
}

// ------------------------------------------------------------ syncDue

describe('syncDue', () => {
  test('no record is due', () => {
    expect(syncDue(undefined, DAY, T0)).toEqual({ due: true, reason: 'never synced' });
  });

  test('a good sync younger than the interval is fresh, with the next time', () => {
    const at = new Date(T0 - 2 * HOUR).toISOString();
    const due = syncDue(state({ last_attempt_at: at, last_ok_at: at }), DAY, T0);
    expect(due).toEqual({ due: false, reason: 'fresh', next_at: new Date(T0 - 2 * HOUR + DAY).toISOString() });
  });

  test('a good sync older than the interval is due', () => {
    const at = new Date(T0 - 7 * HOUR).toISOString();
    expect(syncDue(state({ last_attempt_at: at, last_ok_at: at }), 6 * HOUR, T0)).toEqual({ due: true, reason: 'stale' });
  });

  test('a failed attempt waits RETRY_AFTER_MS, then is due again', () => {
    const ok = new Date(T0 - 2 * DAY).toISOString();
    const failedAt = new Date(T0 - 10 * 60 * 1000).toISOString();
    const s = state({ last_attempt_at: failedAt, last_ok_at: ok, failed: ['harbor'] });
    expect(syncDue(s, DAY, T0)).toEqual({ due: false, reason: 'retry wait', next_at: new Date(Date.parse(failedAt) + RETRY_AFTER_MS).toISOString() });
    expect(syncDue(s, DAY, Date.parse(failedAt) + RETRY_AFTER_MS)).toEqual({ due: true, reason: 'stale' });
  });
});

// ------------------------------------------------------------ syncing and the state file

describe('syncIfDue and syncNow', () => {
  test('a first run syncs and records a good sync', async () => {
    const { d, counter } = deps(done(['harbor', 'rhythm']));
    const r = await syncIfDue('run', d);
    expect(r.status).toBe('synced');
    expect(counter.calls).toBe(1);
    expect(readSyncState(reposDir)).toEqual({
      last_attempt_at: new Date(T0).toISOString(),
      last_ok_at: new Date(T0).toISOString(),
      trigger: 'run',
      ok: ['harbor', 'rhythm'],
      skipped: [],
      failed: [],
    });
    expect(existsSync(join(reposDir, SYNC_LOCK_DIR))).toBe(false);
  });

  test('a fresh record means no sync', async () => {
    const at = new Date(T0 - HOUR).toISOString();
    writeState(state({ last_attempt_at: at, last_ok_at: at, ok: ['harbor'] }));
    const { d, counter } = deps(done(['harbor']));
    const r = await syncIfDue('timer', d);
    expect(r).toMatchObject({ status: 'not_due', due: { reason: 'fresh' } });
    expect(counter.calls).toBe(0);
  });

  test('the interval comes from TRIAGE_REPOS_SYNC_INTERVAL', async () => {
    const at = new Date(T0 - 3 * HOUR).toISOString();
    writeState(state({ last_attempt_at: at, last_ok_at: at }));
    const { d, counter } = deps(done(['harbor']), { overrides: { TRIAGE_REPOS_SYNC_INTERVAL: '2h' } });
    expect((await syncIfDue('timer', d)).status).toBe('synced');
    expect(counter.calls).toBe(1);
  });

  test('some repos failing still counts as a good sync; every repo failing does not', async () => {
    const partial = deps(done(['harbor'], ['rhythm']));
    await syncIfDue('run', partial.d);
    expect(readSyncState(reposDir)).toMatchObject({ last_ok_at: new Date(T0).toISOString(), failed: ['rhythm'] });

    rmSync(join(reposDir, SYNC_STATE_FILE));
    const all = deps(done([], ['harbor', 'rhythm']));
    await syncIfDue('run', all.d);
    const s = readSyncState(reposDir);
    expect(s?.last_ok_at).toBeUndefined();
    expect(s?.failed).toEqual(['harbor', 'rhythm']);
    // The next run inside the retry window does not sync again.
    const again = deps(done(['harbor']), { clock: () => T0 + 60_000 });
    expect(await syncIfDue('run', again.d)).toMatchObject({ status: 'not_due', due: { reason: 'retry wait' } });
    expect(again.counter.calls).toBe(0);
  });

  test('syncNow always syncs; a one-repo sync writes no record', async () => {
    const at = new Date(T0 - HOUR).toISOString();
    writeState(state({ last_attempt_at: at, last_ok_at: at }));
    const { d, counter } = deps(done(['harbor']));
    expect((await syncNow('http', {}, d)).status).toBe('synced');
    expect(readSyncState(reposDir)?.trigger).toBe('http');
    const before = readFileSync(join(reposDir, SYNC_STATE_FILE), 'utf8');
    const one = await syncNow('cli', { repo: 'harbor' }, d);
    expect(one.status).toBe('synced');
    expect(readFileSync(join(reposDir, SYNC_STATE_FILE), 'utf8')).toBe(before);
    expect(counter.calls).toBe(2);
  });

  test('concurrent runs in one process share one sync', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const d: AutoSyncDeps = {
      config: configWith(),
      runner: createFakeRunner([]),
      clock: () => T0,
      syncRepos: async () => {
        calls++;
        await gate;
        return done(['harbor']);
      },
    };
    const a = syncIfDue('run', d);
    const b = syncIfDue('run', d);
    const c = syncNow('http', {}, d);
    expect(await c).toEqual({ status: 'busy', reason: 'a sync is already running in this process' });
    release();
    expect((await a).status).toBe('synced');
    expect(await b).toMatchObject({ status: 'not_due', due: { reason: 'fresh' } });
    expect(calls).toBe(1);
  });

  test("a run waits for another process's sync and then uses its record", async () => {
    const other = tryAcquireSyncLock(reposDir, () => T0);
    if (other === undefined) throw new Error('expected the lock');
    let slept = 0;
    const { d, counter } = deps(done(['harbor']), {
      sleep: async () => {
        slept++;
        // The other process finishes: it records a good sync and lets go.
        writeState(state({ last_ok_at: new Date(T0).toISOString(), ok: ['harbor'] }));
        other.release();
      },
    });
    const r = await syncIfDue('run', d);
    expect(r).toMatchObject({ status: 'not_due', due: { reason: 'fresh' } });
    expect(slept).toBe(1);
    expect(counter.calls).toBe(0);
  });

  test(`a run gives up waiting after ${LOCK_WAIT_MS / 60000} min and the timer does not wait`, async () => {
    const other = tryAcquireSyncLock(reposDir, () => T0);
    if (other === undefined) throw new Error('expected the lock');
    let now = T0;
    const { d, counter } = deps(done(['harbor']), {
      clock: () => now,
      sleep: async () => {
        now += 60_000;
      },
    });
    expect(await syncIfDue('timer', d)).toEqual({ status: 'busy', reason: 'another process is syncing the repos' });
    const r = await syncIfDue('run', d);
    expect(r.status).toBe('busy');
    expect(now - T0).toBeGreaterThanOrEqual(LOCK_WAIT_MS);
    expect(counter.calls).toBe(0);
    other.release();
  });

  test('a blank TRIAGE_REPOS_DIR is not configured and writes nothing', async () => {
    const { d, counter } = deps(done(['harbor']), { overrides: { TRIAGE_REPOS_DIR: '' } });
    expect(await syncIfDue('run', d)).toMatchObject({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR' });
    expect(counter.calls).toBe(0);
  });
});

// ------------------------------------------------------------ lock

describe('tryAcquireSyncLock', () => {
  test('one holder at a time; release lets the next one in', () => {
    const a = tryAcquireSyncLock(reposDir);
    expect(a).toBeDefined();
    expect(tryAcquireSyncLock(reposDir)).toBeUndefined();
    a?.release();
    const b = tryAcquireSyncLock(reposDir);
    expect(b).toBeDefined();
    b?.release();
  });

  test('a lock whose process is gone is taken over', () => {
    const dir = join(reposDir, SYNC_LOCK_DIR);
    mkdirSync(dir);
    // Above the largest pid Linux or macOS hands out, so no such process exists.
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 1, token: 'gone', started_at: new Date().toISOString() }));
    const lock = tryAcquireSyncLock(reposDir);
    expect(lock).toBeDefined();
    lock?.release();
  });

  test(`a lock older than ${LOCK_STALE_MS / HOUR} h is taken over even when its process lives`, () => {
    const dir = join(reposDir, SYNC_LOCK_DIR);
    mkdirSync(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'old', started_at: new Date(T0).toISOString() }));
    expect(tryAcquireSyncLock(reposDir, () => T0 + HOUR)).toBeUndefined();
    const lock = tryAcquireSyncLock(reposDir, () => T0 + LOCK_STALE_MS + 1);
    expect(lock).toBeDefined();
    lock?.release();
  });

  test('a lock dir without an owner file is fresh for a minute, then stale', () => {
    const dir = join(reposDir, SYNC_LOCK_DIR);
    mkdirSync(dir);
    expect(tryAcquireSyncLock(reposDir)).toBeUndefined();
    const old = (Date.now() - 5 * 60 * 1000) / 1000;
    utimesSync(dir, old, old);
    const lock = tryAcquireSyncLock(reposDir);
    expect(lock).toBeDefined();
    lock?.release();
  });

  test("release does not remove a lock someone else took over", () => {
    const a = tryAcquireSyncLock(reposDir, () => T0);
    if (a === undefined) throw new Error('expected the lock');
    const b = tryAcquireSyncLock(reposDir, () => T0 + LOCK_STALE_MS + 1);
    expect(b).toBeDefined();
    a.release();
    expect(existsSync(join(reposDir, SYNC_LOCK_DIR))).toBe(true);
    b?.release();
    expect(existsSync(join(reposDir, SYNC_LOCK_DIR))).toBe(false);
  });
});

// ------------------------------------------------------------ before a run

describe('syncBeforeRun and runWarnings', () => {
  test('an interface not in TRIAGE_REPOS_SYNC_INTERFACES does not sync', async () => {
    const { d, counter } = deps(done(['harbor']), { overrides: { TRIAGE_REPOS_SYNC_INTERFACES: 'http' } });
    expect(await syncBeforeRun('cli', d)).toEqual([]);
    expect(counter.calls).toBe(0);
    expect(await syncBeforeRun('http', d)).toEqual([]);
    expect(counter.calls).toBe(1);
  });

  test('none turns it off for every interface', async () => {
    const { d, counter } = deps(done(['harbor']), { overrides: { TRIAGE_REPOS_SYNC_INTERFACES: 'none' } });
    for (const iface of ['cli', 'http', 'claude-code', 'slack'] as const) expect(await syncBeforeRun(iface, d)).toEqual([]);
    expect(counter.calls).toBe(0);
  });

  test('failed and dirty repos become warnings on the run', async () => {
    const { d } = deps(done(['harbor'], ['rhythm'], ['guardian']));
    const warnings = await syncBeforeRun('cli', d);
    expect(warnings.map((w) => w.message)).toEqual([
      'repo sync failed for rhythm; those checkouts are as they were',
      'not updated because of local changes: guardian',
    ]);
    expect(warnings.every((w) => w.step === 'repos')).toBe(true);
  });

  test('a fresh record with failed repos, a retry wait and a busy lock are warnings; a clean fresh record is not', () => {
    const at = new Date(T0).toISOString();
    expect(runWarnings({ status: 'not_due', due: { due: false, reason: 'fresh', next_at: at }, state: state({ last_ok_at: at }) })).toEqual([]);
    expect(
      runWarnings({ status: 'not_due', due: { due: false, reason: 'fresh', next_at: at }, state: state({ last_ok_at: at, failed: ['rhythm'] }) })[0]?.message,
    ).toContain('failed for rhythm');
    expect(runWarnings({ status: 'not_due', due: { due: false, reason: 'retry wait', next_at: at }, state: state({ failed: ['a'] }) })[0]?.message).toContain(
      'from before any good sync',
    );
    expect(runWarnings({ status: 'busy', reason: 'another process is syncing the repos' })[0]?.message).toBe(
      'another process is syncing the repos; this run uses the checkouts as they are',
    );
    expect(runWarnings({ status: 'not_configured', key: 'TRIAGE_REPOS_DIR', message: 'x' })).toEqual([]);
  });

  test('a sync that throws is a warning, not a failed run', async () => {
    const d: AutoSyncDeps = {
      config: configWith(),
      runner: createFakeRunner([]),
      clock: () => T0,
      syncRepos: async () => {
        throw new TypeError('boom');
      },
    };
    const warnings = await syncBeforeRun('cli', d);
    expect(warnings[0]?.message).toBe('repo sync did not run (TypeError); this run uses the checkouts as they are');
  });
});

// ------------------------------------------------------------ timer

describe('startRepoSyncTimer', () => {
  function fakeTimers() {
    const t = {
      set: [] as number[],
      cleared: 0,
      setInterval(_fn: () => void, ms: number) {
        t.set.push(ms);
        return t.set.length;
      },
      clearInterval() {
        t.cleared++;
      },
    };
    return t;
  }

  test('is off in mock mode, without http in the interfaces and with a blank repos dir', () => {
    expect(timerOffReason(configWith({ TRIAGE_MOCK_MODE: 'true' }))).toBe('mock mode');
    expect(timerOffReason(configWith({ TRIAGE_REPOS_SYNC_INTERFACES: 'cli' }))).toBe('TRIAGE_REPOS_SYNC_INTERFACES does not list http');
    expect(timerOffReason(configWith({ TRIAGE_REPOS_DIR: '' }))).toBe('TRIAGE_REPOS_DIR is blank');
    const timers = fakeTimers();
    const t = startRepoSyncTimer(configWith({ TRIAGE_MOCK_MODE: 'true' }), () => deps(done([])).d, { timers });
    expect(t.on).toBe(false);
    expect(timers.set).toEqual([]);
  });

  test('syncs at start when due, ticks every 5 min at most and stops', async () => {
    const timers = fakeTimers();
    const lines: string[] = [];
    const { d, counter } = deps(done(['harbor'], ['rhythm']));
    const t = startRepoSyncTimer(d.config, () => d, { timers, log: (l) => lines.push(l) });
    await t.idle();
    expect(t.on).toBe(true);
    expect(timers.set).toEqual([TIMER_TICK_MS]);
    expect(counter.calls).toBe(1);
    expect(lines).toEqual(['triage repos: synced 1 ok, 0 skipped, 1 failed (rhythm)']);
    t.stop();
    t.stop();
    expect(timers.cleared).toBe(1);
  });

  test('an interval shorter than the tick sets the tick', () => {
    const timers = fakeTimers();
    const config = configWith({ TRIAGE_REPOS_SYNC_INTERVAL: '1m' });
    const t = startRepoSyncTimer(config, () => deps(done([]), { overrides: { TRIAGE_REPOS_SYNC_INTERVAL: '1m' } }).d, { timers, log: () => {} });
    expect(timers.set).toEqual([60_000]);
    t.stop();
  });
});
