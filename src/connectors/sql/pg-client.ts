// Postgres connector for sql_select and the trusted internal statements (D7, D33).
//
// runSelect() takes the statement list from buildReadOnlyTxn() in
// src/gate/sql-txn.ts, never a raw string:
//
//   BEGIN READ ONLY
//   SET LOCAL statement_timeout = <ms>
//   SET LOCAL lock_timeout = <ms>
//   <one capped SELECT, parameters bound as $n>
//   COMMIT
//
// Any other shape is refused before a client is checked out. All statements
// run on one checked-out client; any failure after that sends ROLLBACK and
// releases the client. A socket that closes under a query is reported by pg
// as an 'error' event on the client as well as a rejected query; the client
// is listened to while it is checked out, so that event ends the call, not
// the process, and the client is discarded. Postgres enforces READ ONLY
// server-side whatever the role can do, and the same statements are accepted
// on a hot-standby reader, so primaries and readers share this code path.
//
// A lost connection is tried again (D57): a call that failed because the
// connection was refused, reset or closed under a query runs again on a
// fresh client, up to the configured attempts, with a wait that doubles.
// Every call is a read-only transaction, so any point of failure is safe to
// repeat. Before each retry the reconnect hook may bring the network path
// back (the SSFB tunnel in local mode). A query error, a server-side
// timeout, a refused login or an abort is never repeated.
//
// Pools: one lazy, bounded pg.Pool per env var name. The pool config carries
// options '-c default_transaction_read_only=on' as a separate field; the DSN
// string is never edited. A DSN that carries its own options parameter would
// override that field inside pg, so it is refused.
//
// Nothing here puts the DSN, or any part of it, into an error, result or
// callback. Errors name the entity, service and env var name only.
import pg from 'pg';
import type { Config } from '../../config/env.ts';
import type { Capability, Registry } from '../../config/registry.ts';
import {
  errorCode,
  isConnectionLoss,
  mayRetry,
  NETWORK_CODES,
  retryDelayMs,
  sleep as realSleep,
  type Random,
  type RetryPolicy,
  type Sleep,
} from '../../db/pg-retry.ts';
import { MAX_TIMEOUT_MS, readOnlyConnectionOptions } from '../../gate/sql-txn.ts';
import type { SqlSelectFacts } from '../../mock/key.ts';
import type { Entity } from '../../types/core.ts';
import { withMock } from '../mock.ts';
import {
  ConnectorError,
  envVarName,
  isConnectorError,
  MAX_SQL_RESULT_BYTES,
  type ConnectorContext,
  type ConnectorOutcome,
  type EnvVarName,
} from '../types.ts';
import {
  createRolePolicy,
  parseRoleCheckRows,
  ROLE_CHECK_SQL,
  type RoleCheck,
  type RoleCheckCache,
  type RolePolicyOutcome,
} from './readonly-role.ts';

// ------------------------------------------------------------ pg port

export type PgQuery = {
  readonly text: string;
  readonly values?: readonly unknown[];
  /** 'extended' makes the server accept exactly one statement for this query. */
  readonly queryMode?: 'extended';
};

export type PgQueryResult = {
  readonly rows: readonly Record<string, unknown>[];
  readonly fields?: readonly { readonly name: string }[];
};

/** The part of a pg PoolClient the connector uses. */
export interface PgClientLike {
  query(query: PgQuery): Promise<PgQueryResult>;
  /** A truthy argument destroys the connection instead of returning it to the pool. */
  release(destroy?: Error | boolean): void;
  /** pg's PoolClient is an EventEmitter. A fake may leave these out. */
  on?(event: 'error', listener: (err: Error) => void): unknown;
  off?(event: 'error', listener: (err: Error) => void): unknown;
}

/** The part of a pg.Pool the connector uses. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on?(event: 'error', listener: (err: Error) => void): unknown;
  /** Best-effort server-side cancel of the query running on client. */
  cancel?(client: PgClientLike): Promise<void>;
}

export type PgPoolConfig = {
  /** The DSN from the env var. Passed to pg as is; never logged or returned. */
  readonly connectionString: string;
  readonly options: string;
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  readonly application_name: string;
  readonly allowExitOnIdle: boolean;
};

export type PgPoolFactory = (config: PgPoolConfig) => PgPoolLike;

/** The real pool. Only reached in real mode, on the first call per env var name. */
export const defaultPgFactory: PgPoolFactory = (config) => {
  const pool = new pg.Pool({ ...config });
  return {
    connect: () => pool.connect() as unknown as Promise<PgClientLike>,
    end: () => pool.end(),
    on: (event, listener) => pool.on(event, listener),
    async cancel(client) {
      const pid = (client as { processID?: unknown }).processID;
      if (typeof pid !== 'number') return;
      // pg_cancel_backend is a plain function call, allowed in a read-only
      // session, and a role may cancel its own backends.
      const canceller = new pg.Client({ ...config });
      canceller.on('error', () => {});
      try {
        await canceller.connect();
        await canceller.query({ text: 'SELECT pg_cancel_backend($1)', values: [pid] });
      } finally {
        await canceller.end().catch(() => {});
      }
    },
  };
};

// ------------------------------------------------------------ plan checks

const DATA_INDEX = 3;
const STATEMENT_TIMEOUT = /^SET LOCAL statement_timeout = ([1-9][0-9]{0,9})$/;
const LOCK_TIMEOUT = /^SET LOCAL lock_timeout = ([1-9][0-9]{0,9})$/;
const DATA_START = /^\s*(SELECT|WITH)\b/i;

function refusePlan(reason: string): never {
  throw new ConnectorError('refused', `Refused: ${reason}`);
}

/**
 * Checks that plan is exactly the five statements buildReadOnlyTxn() returns,
 * with timeouts no higher than the configured ones. Returns the plan as a
 * frozen copy so a caller cannot change it after the check.
 */
export function checkReadOnlyPlan(plan: unknown, limits: Config['sql']): readonly string[] {
  if (typeof plan === 'string') refusePlan('the SQL connector runs a read-only transaction plan, never a raw string');
  if (!Array.isArray(plan) || !plan.every((s) => typeof s === 'string')) {
    refusePlan('the plan must be the statement list from buildReadOnlyTxn()');
  }
  const steps = Object.freeze([...(plan as string[])]);
  if (steps[0] !== 'BEGIN READ ONLY') refusePlan('the plan must start with BEGIN READ ONLY');
  checkTimeout(steps[1], STATEMENT_TIMEOUT, 'statement_timeout', limits.statementTimeoutMs);
  checkTimeout(steps[2], LOCK_TIMEOUT, 'lock_timeout', limits.lockTimeoutMs);
  if (steps.length !== 5) refusePlan('the plan must hold exactly one data statement between the SET LOCAL timeouts and COMMIT');
  if (steps[4] !== 'COMMIT') refusePlan('the plan must end with COMMIT');
  const data = steps[DATA_INDEX] as string;
  if (!DATA_START.test(data)) refusePlan('the data statement must be a SELECT');
  return steps;
}

function checkTimeout(step: string | undefined, pattern: RegExp, name: string, max: number): void {
  const match = step === undefined ? null : pattern.exec(step);
  if (match === null) refusePlan(`the plan must set SET LOCAL statement_timeout and SET LOCAL lock_timeout, in that order, after BEGIN READ ONLY`);
  const ms = Number(match[1]);
  const ceiling = Math.min(max, MAX_TIMEOUT_MS);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > ceiling) refusePlan(`SET LOCAL ${name} must be from 1 to ${ceiling} ms`);
}

type BindValue = string | number | boolean | null;

function checkParams(params: unknown): readonly BindValue[] {
  if (!Array.isArray(params)) refusePlan('params must be an array');
  for (const p of params) {
    const ok = p === null || typeof p === 'string' || typeof p === 'boolean' || (typeof p === 'number' && Number.isFinite(p));
    if (!ok) refusePlan('params must be strings, finite numbers, booleans or null');
  }
  return Object.freeze([...(params as BindValue[])]);
}

// ------------------------------------------------------------ results

export type SqlRows = {
  readonly rows: readonly Record<string, unknown>[];
  /** Rows returned after any cut, not rows the query matched. */
  readonly row_count: number;
  readonly columns: readonly string[];
};

/** The connector outcome, plus the role warning when the policy only warns. */
export type SqlSelectOutcome = ConnectorOutcome<SqlRows> & { readonly role_warning?: string };

/** Keeps whole rows while the serialised JSON array stays within maxBytes. */
export function capRows(
  rows: readonly Record<string, unknown>[],
  maxBytes: number,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  const kept: Record<string, unknown>[] = [];
  let bytes = 2; // the [ and ] of the array
  for (const row of rows) {
    const size = Buffer.byteLength(serialise(row), 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) return { rows: kept, truncated: true };
    bytes += size;
    kept.push(row);
  }
  return { rows: kept, truncated: false };
}

function serialise(row: unknown): string {
  try {
    return JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null';
  } catch {
    return String(row);
  }
}

// ------------------------------------------------------------ errors

/** pg's own words for a socket that closed under a query, and for a client it then refuses to use. */
const CONNECTION_LOST = /^(Connection terminated|Client has encountered a connection error)/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_MESSAGE = 300;

/** Pieces of a DSN that must never show up in text we pass on. */
export function dsnSecrets(dsn: string): string[] {
  const out = new Set<string>([dsn]);
  try {
    const url = new URL(dsn);
    for (const raw of [url.username, url.password, url.hostname, url.host, url.pathname.replace(/^\//, '')]) {
      if (raw === '') continue;
      out.add(raw);
      try {
        out.add(decodeURIComponent(raw));
      } catch {
        // keep the raw form only
      }
    }
  } catch {
    // Not a URL (keyword form). The whole string is still scrubbed.
  }
  return [...out].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('<redacted>');
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}...` : out;
}

/** Maps a pg or network error to a ConnectorError. Only SQLSTATE query errors keep Postgres's text, scrubbed. */
export function mapPgError(err: unknown, where: string, envName: EnvVarName, secrets: readonly string[]): ConnectorError {
  if (isConnectorError(err)) return err;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : '';
  const pgMessage = typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : '';

  if (SQLSTATE.test(code)) {
    if (code === '57014') return new ConnectorError('timeout', `${where}: the statement timed out or was cancelled (57014)`);
    if (code === '55P03') return new ConnectorError('timeout', `${where}: lock_timeout reached (55P03)`);
    if (code === '25006') {
      return new ConnectorError('refused', `${where}: Postgres refused a write inside the read-only transaction (25006)`);
    }
    if (code.startsWith('08') || code === '53300' || code.startsWith('57P')) {
      return new ConnectorError('unreachable', `${where}: could not use the database behind ${envName} (${code})`);
    }
    if (code.startsWith('28') || code === '3D000') {
      return new ConnectorError('refused', `${where}: the server refused the login for ${envName} (${code})`);
    }
    return new ConnectorError('refused', `${where}: query failed (${code}): ${scrub(pgMessage, secrets)}`);
  }
  if (NETWORK_CODES.has(code)) return new ConnectorError('unreachable', `${where}: could not reach ${envName} (${code})`);
  if (CONNECTION_LOST.test(pgMessage)) return new ConnectorError('unreachable', `${where}: the connection to ${envName} dropped`);
  return new ConnectorError('unreachable', `${where}: the call through ${envName} failed`);
}

// ------------------------------------------------------------ abort helpers

function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const onAbort = (): void => reject(new AbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  promise.catch(() => {});
  return { promise, dispose };
}

class AbortedError extends Error {
  override readonly name = 'AbortedError';
}

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  const abort = abortPromise(signal);
  try {
    return await Promise.race([work, abort.promise]);
  } finally {
    abort.dispose();
  }
}

const CLEANUP_WAIT_MS = 2000;

async function bounded(work: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (work === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([work.catch(() => {}), wait]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ connector

export type SqlConnectorOptions = {
  readonly registry: Pick<Registry, 'serviceDb'>;
  readonly config: Pick<Config, 'sql'>;
  readonly pgFactory?: PgPoolFactory;
  /** Defaults to the process-wide cache in readonly-role.ts. */
  readonly roleCache?: RoleCheckCache;
  /** Clients per pool. Default 2. */
  readonly poolMax?: number;
  /** Lower byte cap for tests. Never above MAX_SQL_RESULT_BYTES. */
  readonly maxResultBytes?: number;
  /** Told about idle-client errors. Gets the env var name and an error code, never the message. */
  readonly onPoolError?: (target_env: EnvVarName, code: string) => void;
  /** Attempts per call on a lost connection and the first wait (D57). Defaults to config.sql.retry. */
  readonly retry?: RetryPolicy;
  /** Called before each retry: a chance to bring the network path back (the SSFB tunnel). A rejection is ignored. */
  readonly reconnect?: (target: RetryTarget, signal: AbortSignal) => Promise<void>;
  /** Told about each retry. Gets names and a code, never a message. */
  readonly onRetry?: (info: RetryInfo) => void;
  /** The wait between attempts. Tests pass a fake. */
  readonly sleep?: Sleep;
  /** The jitter source. Defaults to Math.random; tests pass a constant. */
  readonly random?: Random;
};

/** The call being retried: names only, never a value. */
export type RetryTarget = {
  readonly entity: Entity;
  readonly service: string;
  readonly target_env: EnvVarName;
  readonly run_id: string;
};

export type RetryInfo = RetryTarget & {
  /** The attempt that failed, 1-based. */
  readonly attempt: number;
  /** The pg or network error code, or connection_lost. */
  readonly code: string;
};

export type RunSelectInput = {
  readonly entity: Entity;
  readonly service: string;
  /** From buildReadOnlyTxn(). */
  readonly plan: readonly string[];
  /** Every bind value for the data statement, the row cap included. */
  readonly params: readonly BindValue[];
  /** From the T02 parse: {entity, service, tables, params}. */
  readonly keyInput: SqlSelectFacts;
};

export type SqlConnector = {
  runSelect(ctx: ConnectorContext, input: RunSelectInput): Promise<SqlSelectOutcome>;
  /** Runs the role check now in its own read-only transaction. Real mode only. */
  checkReadOnlyRole(ctx: ConnectorContext, entity: Entity, service: string): Promise<RoleCheck>;
  /** Cached per env var name. Throws readonly_role_required when the policy blocks. */
  enforceRolePolicy(ctx: ConnectorContext, entity: Entity, service: string): Promise<RolePolicyOutcome>;
  /** Ends every pool this connector opened. */
  close(): Promise<void>;
};

type Target = { readonly envName: EnvVarName; readonly dsn: string | null };

const OWN_OPTIONS = /(?:^|[?&\s])options\s*=/i;

export function createSqlConnector(options: SqlConnectorOptions): SqlConnector {
  const { registry, config } = options;
  const factory = options.pgFactory ?? defaultPgFactory;
  const maxBytes = Math.min(options.maxResultBytes ?? MAX_SQL_RESULT_BYTES, MAX_SQL_RESULT_BYTES);
  const retry = options.retry ?? config.sql.retry;
  const wait = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const pools = new Map<string, PgPoolLike>();

  function lookup(entity: Entity, service: string): { cap: Capability | undefined; where: string } {
    const where = `${entity}:${service}`;
    try {
      return { cap: registry.serviceDb(entity, service), where };
    } catch (err) {
      // RegistryError messages name keys and files only.
      throw new ConnectorError('not_configured', `sql is not configured for ${where}: ${(err as Error).message}`);
    }
  }

  /** The env var name and, when set, the DSN. mock:true accepts a blank value. */
  function target(entity: Entity, service: string, mock: boolean): Target {
    const { cap, where } = lookup(entity, service);
    if (cap === undefined) throw new ConnectorError('not_configured', `sql is not configured for ${where}: the service has no database`);
    const envName = envVarName(cap.envName);
    if (cap.status !== 'ok') {
      if (mock) return { envName, dsn: null };
      throw new ConnectorError('not_configured', `sql is not configured for ${where}: ${envName} is blank`);
    }
    return { envName, dsn: cap.value };
  }

  function poolFor(t: Target, where: string): PgPoolLike {
    const known = pools.get(t.envName);
    if (known !== undefined) return known;
    const dsn = t.dsn as string;
    if (OWN_OPTIONS.test(dsn)) {
      throw new ConnectorError(
        'refused',
        `${where}: ${t.envName} sets its own options parameter, which would replace default_transaction_read_only=on; remove it`,
      );
    }
    const pool = factory(
      Object.freeze({
        connectionString: dsn,
        options: readOnlyConnectionOptions(),
        max: options.poolMax ?? 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        application_name: 'triage-app',
        allowExitOnIdle: true,
      }),
    );
    pool.on?.('error', (err) => {
      const raw = (err as { code?: unknown }).code;
      const code = typeof raw === 'string' ? raw : 'unknown';
      try {
        options.onPoolError?.(t.envName, code);
      } catch {
        // A broken sink must not crash the process.
      }
    });
    pools.set(t.envName, pool);
    return pool;
  }

  async function checkout(pool: PgPoolLike, signal: AbortSignal): Promise<PgClientLike> {
    const pending = pool.connect();
    try {
      return await raceAbort(pending, signal);
    } catch (err) {
      // A client that arrives after the abort goes straight back.
      if (err instanceof AbortedError) pending.then((c) => c.release(), () => {});
      throw err;
    }
  }

  /** Runs a checked plan, again on a fresh client when the connection was lost, per the retry policy (D57). */
  async function execute(
    pool: PgPoolLike,
    plan: readonly string[],
    params: readonly BindValue[],
    signal: AbortSignal,
    target: RetryTarget,
  ): Promise<PgQueryResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runPlan(pool, plan, params, signal);
      } catch (err) {
        if (err instanceof AbortedError || signal.aborted || !mayRetry(retry, attempt) || !isConnectionLoss(err)) throw err;
        try {
          options.onRetry?.({ ...target, attempt, code: errorCode(err) || 'connection_lost' });
        } catch {
          // A broken sink must not stop the retry.
        }
        // The wait, then the network path, then the next attempt. An abort
        // during the wait rejects here and is reported as cancelled.
        await wait(retryDelayMs(retry, attempt, random), signal);
        await options.reconnect?.(target, signal).catch(() => undefined);
      }
    }
  }

  /** Runs a checked plan once, on one client. ROLLBACK on error, destroy on abort or a dropped socket. */
  async function runPlan(
    pool: PgPoolLike,
    plan: readonly string[],
    params: readonly BindValue[],
    signal: AbortSignal,
  ): Promise<PgQueryResult> {
    signal.throwIfAborted();
    const client = await checkout(pool, signal);
    // pg-pool listens for 'error' on a client only while it is idle, and pg
    // emits it on the client when the socket closes under a query. With no
    // listener Node ends the process. The query in flight rejects on its
    // own; this listener only marks the client so release() discards it.
    let dropped: Error | undefined;
    const onError = (err: Error): void => {
      dropped ??= err;
    };
    client.on?.('error', onError);
    const release = (destroy?: Error): void => {
      client.off?.('error', onError);
      client.release(destroy ?? dropped);
    };
    let data: PgQueryResult | undefined;
    try {
      for (let i = 0; i < plan.length; i++) {
        const text = plan[i] as string;
        const query: PgQuery = i === DATA_INDEX ? { text, values: params, queryMode: 'extended' } : { text };
        const result = await raceAbort(client.query(query), signal);
        if (i === DATA_INDEX) data = result;
      }
    } catch (err) {
      if (err instanceof AbortedError || signal.aborted) {
        await bounded(pool.cancel?.(client), CLEANUP_WAIT_MS);
        release(new Error('sql call aborted'));
        throw new AbortedError();
      }
      if (dropped !== undefined) {
        // The socket is gone: nothing to roll back, and the client is discarded.
        release();
        throw err;
      }
      try {
        await client.query({ text: 'ROLLBACK' });
        release();
      } catch {
        release(new Error('rollback failed'));
      }
      throw err;
    }
    release();
    return data as PgQueryResult;
  }

  function limits(): Config['sql'] {
    return config.sql;
  }

  async function runRoleCheck(ctx: ConnectorContext, entity: Entity, service: string): Promise<RoleCheck> {
    const where = `${entity}:${service}`;
    if (ctx.mock.enabled) throw new ConnectorError('refused', `${where}: the read-only role check runs only in real mode`);
    const t = target(entity, service, false);
    const secrets = dsnSecrets(t.dsn as string);
    const plan = rolePlan();
    try {
      const result = await execute(poolFor(t, where), plan, [], ctx.signal, { entity, service, target_env: t.envName, run_id: ctx.runId });
      return Object.freeze({ ...parseRoleCheckRows(result.rows), target_env: t.envName });
    } catch (err) {
      throw toConnectorError(err, where, t.envName, secrets, ctx.signal);
    }
  }

  function rolePlan(): readonly string[] {
    const { statementTimeoutMs, lockTimeoutMs } = limits();
    return checkReadOnlyPlan(
      [
        'BEGIN READ ONLY',
        `SET LOCAL statement_timeout = ${statementTimeoutMs}`,
        `SET LOCAL lock_timeout = ${lockTimeoutMs}`,
        ROLE_CHECK_SQL,
        'COMMIT',
      ],
      limits(),
    );
  }

  const policy = createRolePolicy({
    requireReadonlyRole: config.sql.requireReadonlyRole,
    runCheck: runRoleCheck,
    envNameOf: (entity, service) => target(entity, service, true).envName,
    ...(options.roleCache !== undefined ? { cache: options.roleCache } : {}),
  });

  async function runSelect(ctx: ConnectorContext, input: RunSelectInput): Promise<SqlSelectOutcome> {
    const where = `${input.entity}:${input.service}`;
    const plan = checkReadOnlyPlan(input.plan, limits());
    const params = checkParams(input.params);
    const t = target(input.entity, input.service, ctx.mock.enabled);
    const secrets = t.dsn === null ? [] : dsnSecrets(t.dsn);
    let role_warning: string | undefined;

    try {
      const outcome = await withMock(
        ctx,
        'sql_select',
        input.keyInput,
        async (signal) => {
          const role = await policy.enforceRolePolicy(ctx, input.entity, input.service);
          role_warning = role.warning;
          const result = await execute(poolFor(t, where), plan, params, signal, {
            entity: input.entity,
            service: input.service,
            target_env: t.envName,
            run_id: ctx.runId,
          });
          const capped = capRows(result.rows, maxBytes);
          const data: SqlRows = Object.freeze({
            rows: Object.freeze(capped.rows),
            row_count: capped.rows.length,
            columns: Object.freeze((result.fields ?? []).map((f) => f.name)),
          });
          return capped.truncated ? { data, truncated: true } : { data };
        },
        { target_env: t.envName },
      );
      return role_warning === undefined ? outcome : Object.freeze({ ...outcome, role_warning });
    } catch (err) {
      throw toConnectorError(err, where, t.envName, secrets, ctx.signal);
    }
  }

  function toConnectorError(
    err: unknown,
    where: string,
    envName: EnvVarName,
    secrets: readonly string[],
    signal?: AbortSignal,
  ): ConnectorError {
    if (isConnectorError(err)) return err;
    if (err instanceof AbortedError || signal?.aborted === true) {
      return new ConnectorError('timeout', `${where}: the sql call was cancelled`);
    }
    return mapPgError(err, where, envName, secrets);
  }

  async function close(): Promise<void> {
    const all = [...pools.values()];
    pools.clear();
    await Promise.all(all.map((p) => p.end().catch(() => {})));
  }

  return Object.freeze({
    runSelect,
    checkReadOnlyRole: policy.checkReadOnlyRole,
    enforceRolePolicy: policy.enforceRolePolicy,
    close,
  });
}
