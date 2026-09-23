// Postgres runner shared by Flue persistence (src/db.ts) and the run store's
// postgres provider (D43: one DSN, one pool). It wraps a bounded pg Pool in
// the runner shape @flue/postgres expects. Node only.
//
// Nothing here logs, and no error built here carries the DSN. Errors thrown by
// pg itself pass through unchanged.

import type { PostgresParameter, PostgresRunner, PostgresQuery } from '@flue/postgres';
import { Pool } from 'pg';
import type { Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';

type Rows = Record<string, unknown>[];

// The parts of pg's PoolClient and Pool the runner uses. Tests pass fakes.
export type PgClientLike = {
  query(text: string, params?: PostgresParameter[]): Promise<{ rows: Rows }>;
  release(err?: Error | boolean): void;
};

export type PgPoolLike = {
  query(text: string, params?: PostgresParameter[]): Promise<{ rows: Rows }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on?(event: 'error', listener: (err: Error) => void): unknown;
};

export type PgPoolOptions = {
  readonly connectionString: string;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  readonly application_name: string;
};

export type PoolFactory = (options: PgPoolOptions) => PgPoolLike;

export type PgRunnerDeps = { readonly poolFactory?: PoolFactory };

export type PgRunner = PostgresRunner;

const DSN = /^postgres(ql)?:\/\//i;

// Small and fixed: one process, a handful of concurrent runs.
const POOL_DEFAULTS = {
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'triage-app',
} as const;

export const defaultPoolFactory: PoolFactory = (options) => new Pool({ ...options });

export function assertPostgresDsn(dsn: string): void {
  if (!DSN.test(dsn.trim())) {
    throw ConfigError.of('TRIAGE_DB_URL', 'must be a postgresql:// DSN for the postgres provider');
  }
}

export function createPgRunner(dsn: string, deps: PgRunnerDeps = {}): PgRunner {
  assertPostgresDsn(dsn);
  const factory = deps.poolFactory ?? defaultPoolFactory;
  const pool = factory({ connectionString: dsn.trim(), ...POOL_DEFAULTS });
  // pg emits 'error' when an idle client drops. Without a listener that
  // crashes the process; the next query reports the failure instead.
  pool.on?.('error', () => {});

  let closed: Promise<void> | undefined;

  const query: PostgresQuery = async (text, params) => (await pool.query(text, params)).rows;

  const runner: PgRunner = {
    query,
    async transaction<T>(fn: (tx: { query: PostgresQuery }) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (text, params) => (await client.query(text, params)).rows,
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // The connection is in an unknown state; tell pg to discard it.
          broken = rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },
    close(): Promise<void> {
      closed ??= pool.end().finally(() => forget(runnerKey(factory, dsn), runner));
      return closed;
    },
  };
  return runner;
}

// One runner per pool factory and DSN. Production has one factory and one DSN,
// so Flue persistence and the run store share a pool. Tests pass their own
// factory and get their own runner.
const shared = new Map<string, PgRunner>();
const factoryIds = new WeakMap<PoolFactory, number>();
let nextFactoryId = 0;

function runnerKey(factory: PoolFactory, dsn: string): string {
  let id = factoryIds.get(factory);
  if (id === undefined) {
    id = nextFactoryId++;
    factoryIds.set(factory, id);
  }
  return `${id}\u0000${dsn.trim()}`;
}

function forget(key: string, runner: PgRunner): void {
  if (shared.get(key) === runner) shared.delete(key);
}

export function getSharedPgRunner(config: Pick<Config, 'db'>, deps: PgRunnerDeps = {}): PgRunner {
  if (config.db.provider !== 'postgres') {
    throw ConfigError.of('TRIAGE_DB_PROVIDER', 'must be postgres to use the postgres runner');
  }
  assertPostgresDsn(config.db.url);
  const factory = deps.poolFactory ?? defaultPoolFactory;
  const key = runnerKey(factory, config.db.url);
  let runner = shared.get(key);
  if (runner === undefined) {
    runner = createPgRunner(config.db.url, { poolFactory: factory });
    shared.set(key, runner);
  }
  return runner;
}
