// The postgres runner against a fake pool. No pg connection is opened: every
// test injects a pool factory that records calls.

import { describe, expect, test } from 'bun:test';
import { ConfigError } from '../config/errors.ts';
import {
  createPgRunner,
  getSharedPgRunner,
  type PgClientLike,
  type PgPoolLike,
  type PgPoolOptions,
  type PoolFactory,
} from './pg.ts';

const DSN = 'postgresql://triage_rw:not-a-real-password@db.invalid:5432/triage';

type Call = { on: string; text: string; params?: unknown[] };

type FakePool = PgPoolLike & {
  calls: Call[];
  released: (Error | boolean | undefined)[];
  ended: number;
  connects: number;
  errorListeners: number;
};

function fakePool(opts: { failOn?: string } = {}): { pool: FakePool; factory: PoolFactory; options: PgPoolOptions[] } {
  const options: PgPoolOptions[] = [];
  let clientSeq = 0;
  const pool: FakePool = {
    calls: [],
    released: [],
    ended: 0,
    connects: 0,
    errorListeners: 0,
    async query(text, params) {
      pool.calls.push({ on: 'pool', text, params });
      return { rows: [{ via: 'pool' }] };
    },
    async connect(): Promise<PgClientLike> {
      pool.connects += 1;
      const id = `client${++clientSeq}`;
      return {
        async query(text, params) {
          pool.calls.push({ on: id, text, params });
          if (opts.failOn !== undefined && text === opts.failOn) throw new Error(`${text} failed`);
          return { rows: [{ via: id }] };
        },
        release(err) {
          pool.released.push(err);
        },
      };
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

  test('query goes through the pool and returns rows', async () => {
    const { pool, factory } = fakePool();
    const runner = createPgRunner(DSN, { poolFactory: factory });
    const rows = await runner.query('SELECT $1::int AS n', [1]);
    expect(rows).toEqual([{ via: 'pool' }]);
    expect(pool.calls).toEqual([{ on: 'pool', text: 'SELECT $1::int AS n', params: [1] }]);
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

describe('getSharedPgRunner', () => {
  const config = { db: { provider: 'postgres' as const, url: DSN } };

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
      getSharedPgRunner({ db: { provider: 'sqlite', url: '/tmp/secret-name.sqlite' } }, { poolFactory: factory });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).keys).toEqual(['TRIAGE_DB_PROVIDER']);
    expect((caught as Error).message).not.toContain('secret-name');
    expect(options).toHaveLength(0);
  });
});
