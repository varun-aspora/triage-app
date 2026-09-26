// Postgres runner shared by Flue persistence (src/db.ts) and the run store's
// postgres provider (D43: one DSN, one pool). It wraps a bounded pg Pool in
// the runner shape @flue/postgres expects. Node only.
//
// A lost connection (D56, D57). pg-pool listens for 'error' on a client only
// while it is idle, and pg emits it on the client when the socket closes
// under a query, so every checked-out client is listened to here and a
// dropped one is discarded on release. A call that failed because the
// connection was lost or refused is repeated per the retry policy, with a
// wait that doubles: a connect that failed, a read (SELECT or WITH) cut off
// at any point, and a transaction cut off before COMMIT was sent, whose
// function then runs again on a fresh client. A write cut off mid-statement
// and a COMMIT cut off are not repeated: they may have landed.
//
// Nothing here logs, and no error built here carries the DSN. Errors thrown by
// pg itself pass through unchanged.

import type { PostgresParameter, PostgresRunner, PostgresQuery } from '@flue/postgres';
import { Pool } from 'pg';
import type { Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import {
  errorCode,
  isConnectionLoss,
  mayRetry,
  NO_RETRY,
  retryDelayMs,
  sleep as realSleep,
  type Random,
  type RetryPolicy,
} from './pg-retry.ts';

type Rows = Record<string, unknown>[];

// The parts of pg's PoolClient and Pool the runner uses. Tests pass fakes.
export type PgClientLike = {
  query(text: string, params?: PostgresParameter[]): Promise<{ rows: Rows }>;
  release(err?: Error | boolean): void;
  /** pg's PoolClient is an EventEmitter. A fake may leave these out. */
  on?(event: 'error', listener: (err: Error) => void): unknown;
  off?(event: 'error', listener: (err: Error) => void): unknown;
};

export type PgPoolLike = {
  /** Not used by the runner, which checks clients out itself; kept so pg's Pool and the fakes fit as they are. */
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

export type RetryEvent = {
  /** What failed: the connect, a single statement, or a transaction before its COMMIT. */
  readonly op: 'connect' | 'query' | 'transaction';
  /** The attempt that failed, 1-based. */
  readonly attempt: number;
  /** The pg or network error code, or connection_lost. */
  readonly code: string;
};

export type PgRunnerDeps = {
  readonly poolFactory?: PoolFactory;
  /** Defaults to NO_RETRY. getSharedPgRunner passes config.db.retry. */
  readonly retry?: RetryPolicy;
  /** The wait between attempts. Tests pass a fake. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The jitter source. Defaults to Math.random; tests pass a constant. */
  readonly random?: Random;
  /** Told about each retry. Gets a code, never a message. */
  readonly onRetry?: (event: RetryEvent) => void;
};

export type PgRunner = PostgresRunner;

const DSN = /^postgres(ql)?:\/\//i;
/** A statement that may be repeated whatever happened to its connection. */
const READ_ONLY = /^\s*(SELECT|WITH)\b/i;

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

/** A checked-out client with its 'error' listener on. dropped is set once pg reported the socket gone. */
type Held = {
  readonly client: PgClientLike;
  dropped: Error | undefined;
  /** Takes the listener off and returns the client, discarding it when err is set or the socket dropped. */
  release(err?: Error): void;
};

function hold(client: PgClientLike): Held {
  const onError = (err: Error): void => {
    held.dropped ??= err;
  };
  const held: Held = {
    client,
    dropped: undefined,
    release(err) {
      client.off?.('error', onError);
      client.release(err ?? held.dropped);
    },
  };
  client.on?.('error', onError);
  return held;
}

export function createPgRunner(dsn: string, deps: PgRunnerDeps = {}): PgRunner {
  assertPostgresDsn(dsn);
  const factory = deps.poolFactory ?? defaultPoolFactory;
  const retry = deps.retry ?? NO_RETRY;
  const wait = deps.sleep ?? ((ms: number) => realSleep(ms));
  const random = deps.random ?? Math.random;
  const pool = factory({ connectionString: dsn.trim(), ...POOL_DEFAULTS });
  // pg emits 'error' when an idle client drops. Without a listener that
  // crashes the process; the next call reports the failure instead.
  pool.on?.('error', () => {});

  let closed: Promise<void> | undefined;

  /** Tells the sink and waits before the next attempt. */
  async function backoff(op: RetryEvent['op'], attempt: number, err: unknown): Promise<void> {
    try {
      deps.onRetry?.({ op, attempt, code: errorCode(err) || 'connection_lost' });
    } catch {
      // A broken sink must not stop the retry.
    }
    await wait(retryDelayMs(retry, attempt, random));
  }

  /** A client from the pool, or null when the connect failed and the policy allows another attempt. */
  async function checkout(attempt: number): Promise<Held | null> {
    try {
      return hold(await pool.connect());
    } catch (err) {
      if (!mayRetry(retry, attempt) || !isConnectionLoss(err)) throw err;
      await backoff('connect', attempt, err);
      return null;
    }
  }

  const query: PostgresQuery = async (text, params) => {
    const repeatable = READ_ONLY.test(text);
    for (let attempt = 1; ; attempt++) {
      const held = await checkout(attempt);
      if (held === null) continue;
      try {
        const result = await held.client.query(text, params);
        held.release();
        return result.rows;
      } catch (err) {
        // A client whose statement failed is discarded, as pg-pool's own query() does.
        held.release(err instanceof Error ? err : new Error('query failed'));
        // A read may be repeated at any point; a write cut off mid-statement may have landed.
        const lost = held.dropped !== undefined || isConnectionLoss(err);
        if (!repeatable || !lost || !mayRetry(retry, attempt)) throw err;
        await backoff('query', attempt, err);
      }
    }
  };

  const runner: PgRunner = {
    query,
    async transaction<T>(fn: (tx: { query: PostgresQuery }) => Promise<T>): Promise<T> {
      for (let attempt = 1; ; attempt++) {
        const held = await checkout(attempt);
        if (held === null) continue;
        const { client } = held;
        let committing = false;
        try {
          await client.query('BEGIN');
          const result = await fn({
            query: async (text, params) => (await client.query(text, params)).rows,
          });
          committing = true;
          await client.query('COMMIT');
          held.release();
          return result;
        } catch (err) {
          let broken: Error | undefined = held.dropped;
          if (broken === undefined) {
            try {
              await client.query('ROLLBACK');
            } catch (rollbackErr) {
              // The connection is in an unknown state; tell pg to discard it.
              broken = rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
            }
          }
          held.release(broken);
          // Cut off before COMMIT was sent, nothing landed, so the whole
          // transaction runs again on a fresh client. A COMMIT cut off may
          // have landed, and any other error is the caller's.
          const lost = held.dropped !== undefined || isConnectionLoss(err);
          if (!lost || committing || !mayRetry(retry, attempt)) throw err;
          await backoff('transaction', attempt, err);
        }
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

/**
 * Ends every shared pool. The CLI calls it once its command has finished:
 * idle connections otherwise keep the process alive for idleTimeoutMillis
 * after the output is printed. A later getSharedPgRunner builds a new runner.
 */
export async function closeSharedPgRunners(): Promise<void> {
  await Promise.allSettled([...shared.values()].map(async (runner) => runner.close()));
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
    runner = createPgRunner(config.db.url, { ...deps, poolFactory: factory, retry: deps.retry ?? config.db.retry });
    shared.set(key, runner);
  }
  return runner;
}
