// pruneExpired, eraseRun and startRetentionTimer over the folder provider in
// temp directories with a fake clock, plus source checks that retention never
// reaches Flue's tables or the audit log. No network, no real .env.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactPersisted } from '../gate/redact.ts';
import { CONTRACT_EPOCH, RUN_A, RUN_B, RUN_C, makeClock, sampleRequest, type ContractClock } from './contract.ts';
import { createFolderRunStore } from './folder.ts';
import {
  DAY_MS,
  ERASURE_LIMITS,
  RetentionPruneError,
  eraseRun,
  pruneExpired,
  startRetentionTimer,
  type RetentionConfig,
  type RetentionTimers,
} from './retention.ts';
import { RunNotFoundError, RunStoreError, type RunStore } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeStore(clock: ContractClock): RunStore {
  const root = mkdtempSync(join(tmpdir(), 'runstore-retention-'));
  dirs.push(root);
  return createFolderRunStore({ runsDir: join(root, 'runs'), dataDir: join(root, 'data'), now: clock.now });
}

const days = (n: number | undefined): RetentionConfig => ({ runs: { retentionDays: n } });

async function createAt(store: RunStore, clock: ContractClock, runId: string, at: number): Promise<void> {
  clock.set(at);
  await store.createRun(runId, redactPersisted(sampleRequest(runId)));
}

type Calls = { listExpired: Date[]; deleteRun: string[]; clear: number };

/** Wraps a store and records the retention calls. */
function spy(store: RunStore, overrides: Partial<RunStore> = {}): { store: RunStore; calls: Calls } {
  const calls: Calls = { listExpired: [], deleteRun: [], clear: 0 };
  const wrapped: RunStore = Object.create(store);
  Object.assign(wrapped, {
    provider: store.provider,
    listExpired: async (before: Date) => {
      calls.listExpired.push(before);
      return (overrides.listExpired ?? store.listExpired.bind(store))(before);
    },
    deleteRun: async (runId: string) => {
      calls.deleteRun.push(runId);
      return (overrides.deleteRun ?? store.deleteRun.bind(store))(runId);
    },
    clearExpiredIdempotencyKeys: async () => {
      calls.clear++;
      return (overrides.clearExpiredIdempotencyKeys ?? store.clearExpiredIdempotencyKeys.bind(store))();
    },
    getRun: overrides.getRun ?? store.getRun.bind(store),
    createRun: store.createRun.bind(store),
    claimIdempotencyKey: store.claimIdempotencyKey.bind(store),
  });
  return { store: wrapped, calls };
}

describe('pruneExpired', () => {
  test('days=30 with runs at 10 and 40 days deletes only the 40-day run', async () => {
    const clock = makeClock();
    const base = makeStore(clock);
    await createAt(base, clock, RUN_A, CONTRACT_EPOCH - 40 * DAY_MS);
    await createAt(base, clock, RUN_B, CONTRACT_EPOCH - 10 * DAY_MS);
    clock.set(CONTRACT_EPOCH);
    const { store, calls } = spy(base);

    const result = await pruneExpired(store, days(30), new Date(CONTRACT_EPOCH));

    expect(result.deleted).toBe(1);
    expect(result.retention_days).toBe(30);
    expect(result.cutoff).toBe(new Date(CONTRACT_EPOCH - 30 * DAY_MS).toISOString());
    expect(calls.listExpired.map((d) => d.getTime())).toEqual([CONTRACT_EPOCH - 30 * DAY_MS]);
    expect(calls.deleteRun).toEqual([RUN_A]);
    expect(await base.getRun(RUN_A)).toBeNull();
    expect((await base.getRun(RUN_B))?.run_id).toBe(RUN_B);
  });

  test('a run exactly at the cutoff is kept', async () => {
    const clock = makeClock();
    const store = makeStore(clock);
    await createAt(store, clock, RUN_A, CONTRACT_EPOCH - 30 * DAY_MS);
    const result = await pruneExpired(store, days(30), CONTRACT_EPOCH);
    expect(result.deleted).toBe(0);
    expect(await store.getRun(RUN_A)).not.toBeNull();
  });

  test('blank days deletes nothing and never calls listExpired', async () => {
    const clock = makeClock();
    const base = makeStore(clock);
    await createAt(base, clock, RUN_A, CONTRACT_EPOCH - 4000 * DAY_MS);
    clock.set(CONTRACT_EPOCH);
    const { store, calls } = spy(base);

    const result = await pruneExpired(store, days(undefined), CONTRACT_EPOCH);

    expect(result).toEqual({ deleted: 0, idempotency_cleared: 0, retention_days: null, cutoff: null });
    expect(calls.listExpired).toHaveLength(0);
    expect(calls.deleteRun).toHaveLength(0);
    expect(await base.getRun(RUN_A)).not.toBeNull();
  });

  test('expired idempotency keys are cleared and live ones kept', async () => {
    const clock = makeClock();
    const store = makeStore(clock);
    await store.claimIdempotencyKey('key-old', RUN_A, 60_000);
    clock.advance(30_000);
    await store.claimIdempotencyKey('key-live', RUN_B, 60_000);
    clock.advance(40_000); // key-old expired 10s ago; key-live has 20s left

    const result = await pruneExpired(store, days(30), clock.now());

    expect(result.idempotency_cleared).toBe(1);
    // The expired key can be claimed afresh; the live one still points at its first run.
    expect(await store.claimIdempotencyKey('key-old', RUN_C, 60_000)).toBe(RUN_C);
    expect(await store.claimIdempotencyKey('key-live', RUN_C, 60_000)).toBe(RUN_B);
  });

  test('expired keys are cleared even when retention is off', async () => {
    const clock = makeClock();
    const store = makeStore(clock);
    await store.claimIdempotencyKey('key-old', RUN_A, 1_000);
    clock.advance(2_000);
    expect((await pruneExpired(store, days(undefined), clock.now())).idempotency_cleared).toBe(1);
  });

  test('one failing delete does not stop the others; the error names ids and counts', async () => {
    const clock = makeClock();
    const base = makeStore(clock);
    await createAt(base, clock, RUN_A, CONTRACT_EPOCH - 50 * DAY_MS);
    await createAt(base, clock, RUN_B, CONTRACT_EPOCH - 45 * DAY_MS);
    clock.set(CONTRACT_EPOCH);
    const { store, calls } = spy(base, {
      deleteRun: async (runId) => {
        if (runId === RUN_A) throw new Error('postgresql://user:secret@db.internal/x refused');
        return base.deleteRun(runId);
      },
    });

    const err = await pruneExpired(store, days(30), CONTRACT_EPOCH).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetentionPruneError);
    const e = err as RetentionPruneError;
    expect(e.failed).toEqual([RUN_A]);
    expect(e.result.deleted).toBe(1);
    expect(e.message).not.toContain('secret');
    expect(calls.deleteRun).toEqual([RUN_A, RUN_B]);
    expect(calls.clear).toBe(1);
    expect(await base.getRun(RUN_B)).toBeNull();
  });

  test('a bad window or time is refused before the store is used', async () => {
    const { store, calls } = spy(makeStore(makeClock()));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(pruneExpired(store, days(bad), CONTRACT_EPOCH)).rejects.toBeInstanceOf(RunStoreError);
    }
    await expect(pruneExpired(store, days(30), new Date('not a date'))).rejects.toBeInstanceOf(RunStoreError);
    expect(calls.listExpired).toHaveLength(0);
    expect(calls.clear).toBe(0);
  });
});

describe('eraseRun', () => {
  test('deletes the run and returns the limits text naming the Flue stream and the audit log', async () => {
    const clock = makeClock();
    const store = makeStore(clock);
    await createAt(store, clock, RUN_A, CONTRACT_EPOCH);
    await createAt(store, clock, RUN_B, CONTRACT_EPOCH);

    const result = await eraseRun(store, RUN_A);

    expect(result.run_id).toBe(RUN_A);
    expect(result.deleted).toBe(true);
    expect(result.provider).toBe('folder');
    expect(result.not_reached).toBe(ERASURE_LIMITS);
    const text = result.not_reached.join('\n');
    expect(text).toContain("Flue's conversation stream");
    expect(text).toContain('audit log (TRIAGE_AUDIT_LOG)');
    expect(text).toContain('prior case');
    expect(await store.getRun(RUN_A)).toBeNull();
    expect(await store.getRun(RUN_B)).not.toBeNull();
  });

  test('an unknown run id throws RunNotFoundError and calls no delete', async () => {
    const clock = makeClock();
    const base = makeStore(clock);
    // A claim held by the unknown run id must survive: nothing is deleted.
    await base.claimIdempotencyKey('key-1', RUN_C, 60_000);
    const { store, calls } = spy(base);

    await expect(eraseRun(store, RUN_C)).rejects.toBeInstanceOf(RunNotFoundError);
    expect(calls.deleteRun).toHaveLength(0);
    expect(await base.claimIdempotencyKey('key-1', RUN_A, 60_000)).toBe(RUN_C);
  });

  test('a run deleted between the check and the delete is reported as not found', async () => {
    const clock = makeClock();
    const base = makeStore(clock);
    await createAt(base, clock, RUN_A, CONTRACT_EPOCH);
    const { store } = spy(base, { deleteRun: async () => false });
    await expect(eraseRun(store, RUN_A)).rejects.toBeInstanceOf(RunNotFoundError);
  });

  test('an invalid run id is refused before the store is read', async () => {
    let reads = 0;
    const { store } = spy(makeStore(makeClock()), {
      getRun: async () => {
        reads++;
        return null;
      },
    });
    for (const bad of ['', '../etc', 'a b', 'x'.repeat(65)]) {
      await expect(eraseRun(store, bad)).rejects.toBeInstanceOf(RunStoreError);
    }
    expect(reads).toBe(0);
  });
});

// ------------------------------------------------------------------ timer

type FakeTimers = RetentionTimers & { fire(): void; cleared: number; active: () => boolean; intervals: number[] };

function fakeTimers(): FakeTimers {
  let fn: (() => void) | null = null;
  const state = {
    cleared: 0,
    intervals: [] as number[],
    setInterval(cb: () => void, ms: number) {
      fn = cb;
      state.intervals.push(ms);
      return 'handle';
    },
    clearInterval(handle: unknown) {
      if (handle === 'handle') {
        fn = null;
        state.cleared++;
      }
    },
    fire() {
      fn?.();
    },
    active: () => fn !== null,
  };
  return state;
}

function throwingStore(counter: { calls: number }): RunStore {
  const fail = async (): Promise<never> => {
    counter.calls++;
    throw new Error('connect ECONNREFUSED postgresql://user:secret@10.0.0.9/triage');
  };
  return { provider: 'postgres', listExpired: fail, clearExpiredIdempotencyKeys: fail } as unknown as RunStore;
}

describe('startRetentionTimer', () => {
  test('prunes once at start and then on every tick', async () => {
    const clock = makeClock();
    const base = makeStore(clock);
    const { store, calls } = spy(base);
    const timers = fakeTimers();
    const timer = startRetentionTimer(store, days(30), { timers, now: clock.now, log: () => {} });
    await timer.idle();
    expect(calls.clear).toBe(1);
    expect(timers.intervals).toEqual([DAY_MS]);

    await createAt(base, clock, RUN_A, CONTRACT_EPOCH);
    clock.set(CONTRACT_EPOCH + 31 * DAY_MS);
    timers.fire();
    await timer.idle();
    expect(calls.clear).toBe(2);
    expect(calls.deleteRun).toEqual([RUN_A]);
    timer.stop();
  });

  test('a store that throws is logged, the timer keeps running, and stop() clears it', async () => {
    const counter = { calls: 0 };
    const logs: string[] = [];
    const timers = fakeTimers();
    let timer: ReturnType<typeof startRetentionTimer> | undefined;
    expect(() => {
      timer = startRetentionTimer(throwingStore(counter), days(30), { timers, intervalMs: 1000, log: (l) => logs.push(l) });
    }).not.toThrow();
    const t = timer!;
    await t.idle();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('prune failed (Error)');
    expect(logs.join('\n')).not.toContain('secret');
    expect(logs.join('\n')).not.toContain('10.0.0.9');

    timers.fire();
    await t.idle();
    timers.fire();
    await t.idle();
    expect(logs).toHaveLength(3);
    expect(timers.active()).toBe(true);

    t.stop();
    expect(timers.cleared).toBe(1);
    expect(timers.active()).toBe(false);
    t.stop();
    expect(timers.cleared).toBe(1);
    timers.fire();
    await t.idle();
    expect(logs).toHaveLength(3);
  });

  test('a throwing logger does not escape the timer', async () => {
    const timers = fakeTimers();
    const timer = startRetentionTimer(throwingStore({ calls: 0 }), days(30), {
      timers,
      log: () => {
        throw new Error('log sink down');
      },
    });
    await expect(timer.idle()).resolves.toBeUndefined();
    timer.stop();
  });

  test('a tick during a running prune is skipped', async () => {
    let release: () => void = () => {};
    let clears = 0;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = {
      provider: 'folder',
      listExpired: async () => [],
      clearExpiredIdempotencyKeys: async () => {
        clears++;
        await gate;
        return 0;
      },
    } as unknown as RunStore;
    const timers = fakeTimers();
    const timer = startRetentionTimer(store, days(30), { timers, log: () => {} });
    timers.fire();
    timers.fire();
    release();
    await timer.idle();
    expect(clears).toBe(1);
    timer.stop();
  });

  test('the real timer is unref-ed and stops', async () => {
    const store = spy(makeStore(makeClock())).store;
    const timer = startRetentionTimer(store, days(undefined), { intervalMs: 60_000, log: () => {} });
    await timer.idle();
    timer.stop();
  });

  test('a bad interval is refused', () => {
    const store = makeStore(makeClock());
    for (const bad of [0, -5, Number.NaN]) {
      expect(() => startRetentionTimer(store, days(30), { intervalMs: bad })).toThrow(RunStoreError);
    }
  });
});

// ------------------------------------------------------------------ source checks

describe('source checks', () => {
  const files = [
    join(HERE, 'retention.ts'),
    join(HERE, '../cli/commands/runs-delete.command.ts'),
    join(HERE, '../cli/commands/runs-prune.command.ts'),
  ];

  test("retention code never names flue_ tables or writes the audit log", () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/flue_/i);
      // No handle on the audit log path, and no file writes or truncation at all.
      expect(src).not.toMatch(/auditLog|paths\.audit/);
      expect(src).not.toMatch(/\bnode:fs\b|from 'fs'|writeFile|appendFile|truncate|createWriteStream|\bunlink\b|\brm\(/);
      expect(src).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/);
    }
  });

  test('retention code uses no Bun APIs and no console', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/\bBun\.|from 'bun:|console\./);
    }
  });
});
