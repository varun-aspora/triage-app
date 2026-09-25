// The postgres runner against a fake pool. No pg connection is opened: every
// test injects a pool factory that records calls.

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ConfigError } from '../config/errors.ts';
import {
  createPgRunner,
  getSharedPgRunner,
  type PgClientLike,
  type PgPoolLike,
  type PgPoolOptions,
  type PoolFactory,
  type RetryEvent,
} from './pg.ts';
import { NO_RETRY } from './pg-retry.ts';

const DSN = 'postgresql://triage_rw:not-a-real-password@db.invalid:5432/triage';

type Call = { on: string; text: string; params?: unknown[] };

type FakePool = PgPoolLike & {
  calls: Call[];
  released: (Error | boolean | undefined)[];
  ended: number;
  connects: number;
  errorListeners: number;
  /** The client's 'error' listener count at each client query, in order. */
  clientListeners: number[];
  clients: EventEmitter[];
};

/** pg's words for a socket that closed under a query. */
const DROPPED = 'Connection terminated unexpectedly';

// Clients are EventEmitters like pg's. dropOn closes the socket under that
// query the way pg reports it: 'error' on the client from a macrotask, then
// the query rejects. Without a listener on the client that emit is an
// uncaught exception, which is the crash under test. dropTimes caps how many
// clients drop (default: every one); refuseConnects makes that many connects
// fail with ECONNREFUSED first.
type FakePoolOptions = { failOn?: string; dropOn?: string; dropTimes?: number; refuseConnects?: number };

function fakePool(opts: FakePoolOptions = {}): { pool: FakePool; factory: PoolFactory; options: PgPoolOptions[] } {
  const options: PgPoolOptions[] = [];
  let clientSeq = 0;
  let refusals = 0;
  let drops = 0;
  const pool: FakePool = {
    calls: [],
    released: [],
    ended: 0,
    connects: 0,
    errorListeners: 0,
    clientListeners: [],
    clients: [],
    async query(text, params) {
      pool.calls.push({ on: 'pool', text, params });
      return { rows: [{ via: 'pool' }] };
    },
    async connect(): Promise<PgClientLike> {
      pool.connects += 1;
      if (refusals < (opts.refuseConnects ?? 0)) {
        refusals += 1;
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      }
      const id = `client${++clientSeq}`;
      let dead = false;
      const client: PgClientLike & EventEmitter = Object.assign(new EventEmitter(), {
        query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
          pool.calls.push({ on: id, text, params });
          pool.clientListeners.push(client.listenerCount('error'));
          if (dead) return Promise.reject(new Error('Client has encountered a connection error and is not queryable'));
          if (opts.dropOn !== undefined && text === opts.dropOn && drops < (opts.dropTimes ?? Infinity)) {
            drops += 1;
            dead = true;
            return new Promise((_, reject) =>
              setImmediate(() => {
                const err = new Error(DROPPED);
                client.emit('error', err);
                reject(err);
              }),
            );
          }
          if (opts.failOn !== undefined && text === opts.failOn) return Promise.reject(new Error(`${text} failed`));
          return Promise.resolve({ rows: [{ via: id }] });
        },
        release(err?: Error | boolean) {
          pool.released.push(err);
        },
      });
      pool.clients.push(client);
      return client;
    },
    async end() {
      pool.ended += 1;
    },
    on(event) {
      if (event === 'error') pool.errorListeners += 1;
      return pool;
    },
  };
  const factory: PoolFactory = (o) => {
    options.push(o);
    return pool;
  };
  return { pool, factory, options };
}

describe('createPgRunner', () => {
  test('builds one bounded pool from the DSN and listens for idle errors', () => {
    const { pool, factory, options } = fakePool();
    createPgRunner(DSN, { poolFactory: factory });
    expect(options).toHaveLength(1);
    expect(options[0]?.connectionString).toBe(DSN);
    expect(options[0]?.max).toBeGreaterThan(0);
    expect(options[0]?.max).toBeLessThanOrEqual(10);
    expect(pool.errorListeners).toBe(1);
    expect(pool.connects).toBe(0);
  });

  test('query checks a client out, runs the statement on it and returns the rows', async () => {
    const { pool, factory } = fakePool();
    const runner = createPgRunner(DSN, { poolFactory: factory });
    const rows = await runner.query('SELECT $1::int AS n', [1]);
    expect(rows).toEqual([{ via: 'client1' }]);
    expect(pool.calls).toEqual([{ on: 'client1', text: 'SELECT $1::int AS n', params: [1] }]);
    expect(pool.released).toEqual([undefined]);
    expect(pool.clientListeners).toEqual([1]);
    expect(pool.clients[0]?.listenerCount('error')).toBe(0);
  });

  test('a statement that fails discards its client and rethrows', async () => {
    const { pool, factory } = fakePool({ failOn: 'SELECT 1' });
    const runner = createPgRunner(DSN, { poolFactory: factory });
    await expect(runner.query('SELECT 1')).rejects.toThrow('SELECT 1 failed');
    expect(pool.released).toHaveLength(1);
    expect(pool.released[0]).toBeInstanceOf(Error);
  });

  test('transaction issues BEGIN, queries on the same client, COMMIT, release', async () => {
    const { pool, factory } = fakePool();
    const runner = createPgRunner(DSN, { poolFactory: factory });
    const result = await runner.transaction(async (tx) => {
      const a = await tx.query('SELECT 1');
      const b = await tx.query('SELECT $1', ['x']);
      return [a, b];
    });
    expect(result).toEqual([[{ via: 'client1' }], [{ via: 'client1' }]]);
    expect(pool.connects).toBe(1);
    expect(pool.calls.map((c) => `${c.on}:${c.text}`)).toEqual([
      'client1:BEGIN',
      'client1:SELECT 1',
      'client1:SELECT $1',
      'client1:COMMIT',
    ]);
    expect(pool.released).toEqual([undefined]);
  });

  test('throw inside fn rolls back, releases and rethrows the same error', async () => {
    const { pool, factory } = fakePool();
    const runner = createPgRunner(DSN, { poolFactory: factory });
    const boom = new Error('boom');
    let caught: unknown;
    try {
      await runner.transaction(async (tx) => {
        await tx.query('INSERT 1');
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(pool.calls.map((c) => `${c.on}:${c.text}`)).toEqual(['client1:BEGIN', 'client1:INSERT 1', 'client1:ROLLBACK']);
    expect(pool.released).toEqual([undefined]);
  });

  test('a failed COMMIT rolls back and releases', async () => {
    const { pool, factory } = fakePool({ failOn: 'COMMIT' });
    const runner = createPgRunner(DSN, { poolFactory: factory });
    await expect(runner.transaction(async () => 1)).rejects.toThrow('COMMIT failed');
    expect(pool.calls.map((c) => c.text)).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(pool.released).toHaveLength(1);
  });

  test('a failed ROLLBACK discards the client and still rethrows the original error', async () => {
    const { pool, factory } = fakePool({ failOn: 'ROLLBACK' });
    const runner = createPgRunner(DSN, { poolFactory: factory });
    await expect(
      runner.transaction(async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    expect(pool.released).toHaveLength(1);
    expect(pool.released[0]).toBeInstanceOf(Error);
  });

  test('listens on the client only while it is checked out', async () => {
    const { pool, factory } = fakePool();
    const runner = createPgRunner(DSN, { poolFactory: factory });
    await runner.transaction(async (tx) => tx.query('SELECT 1'));
    expect(pool.clientListeners).toEqual([1, 1, 1]);
    expect(pool.clients[0]?.listenerCount('error')).toBe(0);
  });

  test('a socket that closes mid-transaction rejects the call, sends no ROLLBACK, discards the client and leaves no listener behind', async () => {
    const { pool, factory } = fakePool({ dropOn: 'SELECT 1' });
    const runner = createPgRunner(DSN, { poolFactory: factory });
    await expect(runner.transaction(async (tx) => tx.query('SELECT 1'))).rejects.toThrow(DROPPED);
    expect(pool.calls.map((c) => c.text)).toEqual(['BEGIN', 'SELECT 1']);
    expect(pool.released).toHaveLength(1);
    expect((pool.released[0] as Error).message).toBe(DROPPED);
    expect(pool.clients[0]?.listenerCount('error')).toBe(0);
  });

  test('close() ends the pool once', async () => {
    const { pool, factory } = fakePool();
    const runner = createPgRunner(DSN, { poolFactory: factory });
    await runner.close();
    await runner.close();
    expect(pool.ended).toBe(1);
  });

  test('a non-postgresql:// DSN fails naming TRIAGE_DB_URL only', () => {
    const { factory, options } = fakePool();
    const bad = 'mysql://root:hunter2-SECRET@db.invalid:3306/x';
    let caught: unknown;
    try {
      createPgRunner(bad, { poolFactory: factory });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.keys).toEqual(['TRIAGE_DB_URL']);
    for (const part of [bad, 'hunter2-SECRET', 'db.invalid', 'root']) {
      expect(err.message).not.toContain(part);
      expect(String(err.stack)).not.toContain(part);
    }
    expect(options).toHaveLength(0);
  });
});

describe('retry (D57)', () => {
  // The cap makes the second wait 150, not 200; random() = 1 takes the top of the jitter range.
  const POLICY = { attempts: 3, delayMs: 100, maxDelayMs: 150 };

  function retrying(opts: FakePoolOptions = {}) {
    const { pool, factory } = fakePool(opts);
    const waits: number[] = [];
    const events: RetryEvent[] = [];
    const runner = createPgRunner(DSN, {
      poolFactory: factory,
      retry: POLICY,
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 1,
      onRetry: (e) => events.push(e),
    });
    return { pool, runner, waits, events };
  }

  test('a refused connect is tried again, with the sink told and the wait doubling; a write included', async () => {
    const { pool, runner, waits, events } = retrying({ refuseConnects: 2 });
    const rows = await runner.query('INSERT INTO t VALUES (1)');
    expect(rows).toEqual([{ via: 'client1' }]);
    expect(pool.connects).toBe(3);
    expect(waits).toEqual([100, 150]);
    expect(events).toEqual([
      { op: 'connect', attempt: 1, code: 'ECONNREFUSED' },
      { op: 'connect', attempt: 2, code: 'ECONNREFUSED' },
    ]);
  });

  test('the wait carries jitter from the upper half of the range', async () => {
    const { pool, factory } = fakePool({ refuseConnects: 2 });
    const waits: number[] = [];
    const runner = createPgRunner(DSN, {
      poolFactory: factory,
      retry: POLICY,
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0.5,
    });
    expect(await runner.query('SELECT 1')).toEqual([{ via: 'client1' }]);
    expect(pool.connects).toBe(3);
    expect(waits).toEqual([75, 113]);
  });

  test('a read cut off mid-statement runs again on a fresh client; a write does not', async () => {
    const read = retrying({ dropOn: 'SELECT 1', dropTimes: 1 });
    expect(await read.runner.query('SELECT 1')).toEqual([{ via: 'client2' }]);
    expect(read.pool.calls.map((c) => `${c.on}:${c.text}`)).toEqual(['client1:SELECT 1', 'client2:SELECT 1']);
    expect((read.pool.released[0] as Error).message).toBe(DROPPED);
    expect(read.pool.released[1]).toBeUndefined();
    expect(read.waits).toEqual([100]);
    expect(read.events).toEqual([{ op: 'query', attempt: 1, code: 'connection_lost' }]);

    const write = retrying({ dropOn: 'UPDATE t SET x = 1', dropTimes: 1 });
    await expect(write.runner.query('UPDATE t SET x = 1')).rejects.toThrow(DROPPED);
    expect(write.pool.connects).toBe(1);
    expect(write.waits).toEqual([]);
    expect(write.events).toEqual([]);
    expect((write.pool.released[0] as Error).message).toBe(DROPPED);
  });

  test('a transaction cut off before COMMIT runs its function again; one cut off at COMMIT does not', async () => {
    const early = retrying({ dropOn: 'SELECT 1', dropTimes: 1 });
    let runs = 0;
    const result = await early.runner.transaction(async (tx) => {
      runs += 1;
      return tx.query('SELECT 1');
    });
    expect(result).toEqual([{ via: 'client2' }]);
    expect(runs).toBe(2);
    expect(early.pool.calls.map((c) => `${c.on}:${c.text}`)).toEqual([
      'client1:BEGIN',
      'client1:SELECT 1',
      'client2:BEGIN',
      'client2:SELECT 1',
      'client2:COMMIT',
    ]);
    expect(early.waits).toEqual([100]);
    expect(early.events).toEqual([{ op: 'transaction', attempt: 1, code: 'connection_lost' }]);
    expect(early.pool.released).toHaveLength(2);
    expect(early.pool.released[1]).toBeUndefined();

    const late = retrying({ dropOn: 'COMMIT', dropTimes: 1 });
    let lateRuns = 0;
    await expect(
      late.runner.transaction(async (tx) => {
        lateRuns += 1;
        return tx.query('SELECT 1');
      }),
    ).rejects.toThrow(DROPPED);
    expect(lateRuns).toBe(1);
    expect(late.waits).toEqual([]);
    expect(late.events).toEqual([]);
    expect((late.pool.released[0] as Error).message).toBe(DROPPED);
  });

  test('a refused connect before a transaction is tried again too', async () => {
    const { pool, runner, events } = retrying({ refuseConnects: 1 });
    expect(await runner.transaction(async (tx) => tx.query('SELECT 1'))).toEqual([{ via: 'client1' }]);
    expect(pool.connects).toBe(2);
    expect(events).toEqual([{ op: 'connect', attempt: 1, code: 'ECONNREFUSED' }]);
  });

  test('once the attempts are used up the last error is thrown', async () => {
    const { pool, runner, waits } = retrying({ refuseConnects: 5 });
    await expect(runner.query('SELECT 1')).rejects.toThrow('ECONNREFUSED');
    expect(pool.connects).toBe(3);
    expect(waits).toEqual([100, 150]);
  });

  test('a query error is not tried again', async () => {
    const { pool, runner, waits, events } = retrying({ failOn: 'SELECT 1' });
    await expect(runner.query('SELECT 1')).rejects.toThrow('SELECT 1 failed');
    expect(pool.connects).toBe(1);
    expect(waits).toEqual([]);
    expect(events).toEqual([]);
  });

  test('a sink that throws does not stop the retry', async () => {
    const { pool, factory } = fakePool({ refuseConnects: 1 });
    const runner = createPgRunner(DSN, {
      poolFactory: factory,
      retry: POLICY,
      sleep: async () => undefined,
      onRetry: () => {
        throw new Error('sink broke');
      },
    });
    expect(await runner.query('SELECT 1')).toEqual([{ via: 'client1' }]);
    expect(pool.connects).toBe(2);
  });

  test('createPgRunner has no retry unless given one; getSharedPgRunner takes config.db.retry', async () => {
    const plain = fakePool({ refuseConnects: 1 });
    await expect(createPgRunner(DSN, { poolFactory: plain.factory }).query('SELECT 1')).rejects.toThrow('ECONNREFUSED');
    const shared = fakePool({ refuseConnects: 1 });
    const runner = getSharedPgRunner(
      { db: { provider: 'postgres', url: DSN, retry: { attempts: 2, delayMs: 0, maxDelayMs: 0 } } },
      { poolFactory: shared.factory, sleep: async () => undefined },
    );
    expect(await runner.query('SELECT 1')).toEqual([{ via: 'client1' }]);
    expect(shared.pool.connects).toBe(2);
    await runner.close();
  });
});

describe('getSharedPgRunner', () => {
  const config = { db: { provider: 'postgres' as const, url: DSN, retry: NO_RETRY } };

  test('returns the same runner and pool for the same DSN and factory', async () => {
    const { factory, options } = fakePool();
    const a = getSharedPgRunner(config, { poolFactory: factory });
    const b = getSharedPgRunner(config, { poolFactory: factory });
    expect(a).toBe(b);
    expect(options).toHaveLength(1);
    await a.close();
  });

  test('a closed runner is replaced by a fresh one', async () => {
    const { factory, options } = fakePool();
    const a = getSharedPgRunner(config, { poolFactory: factory });
    await a.close();
    const b = getSharedPgRunner(config, { poolFactory: factory });
    expect(b).not.toBe(a);
    expect(options).toHaveLength(2);
    await b.close();
  });

  test('closing a private runner does not drop the shared one', async () => {
    const { factory } = fakePool();
    const shared = getSharedPgRunner(config, { poolFactory: factory });
    const own = createPgRunner(DSN, { poolFactory: factory });
    await own.close();
    expect(getSharedPgRunner(config, { poolFactory: factory })).toBe(shared);
    await shared.close();
  });

  test('refuses the sqlite provider, naming TRIAGE_DB_PROVIDER only', () => {
    const { factory, options } = fakePool();
    let caught: unknown;
    try {
      getSharedPgRunner({ db: { provider: 'sqlite', url: '/tmp/secret-name.sqlite', retry: NO_RETRY } }, { poolFactory: factory });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).keys).toEqual(['TRIAGE_DB_PROVIDER']);
    expect((caught as Error).message).not.toContain('secret-name');
    expect(options).toHaveLength(0);
  });
});
