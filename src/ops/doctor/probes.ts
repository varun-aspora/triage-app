// The doctor's network probes (HLD §7 Doctor, §3 mock.ts; D19, D27, D33, D44).
//
// Checks never talk to a database, Quickwit or a socket themselves. They call
// the Probes interface, which has two implementations:
//
// - createRealProbes: over the T04 SQL connector, an injected fetch and a TCP
//   connect. The only SQL it sends is DOCTOR_SELECT_ONE_SQL and
//   ROLE_CHECK_SQL, both fixed constants, inside the connector's read-only
//   transaction. No customer table is read and no model SQL is used. The
//   Quickwit probe is one GET of /health/livez; it never searches.
// - createMockProbes: answers from doctor_probe fixtures keyed
//   'doctor|<probe>|<entity>|<env-key-name>'. A miss is 'skipped', never a
//   throw, even under strict mock mode, and nothing real is called.
//
// Results name env keys, never values. A probe returns a result for every
// expected failure; it throws only for programming errors.

import net from 'node:net';
import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import type { MockPort } from '../../connectors/mock.ts';
import { searchUrl, type FetchLike } from '../../connectors/quickwit/http-transport.ts';
import { createSqlConnector, type SqlConnector } from '../../connectors/sql/pg-client.ts';
import { ROLE_CHECK_SQL, RoleCheckCache } from '../../connectors/sql/readonly-role.ts';
import { isConnectorError, type ConnectorContext } from '../../connectors/types.ts';
import { NO_RETRY } from '../../db/pg-retry.ts';
import type { FixtureEntity } from '../../mock/types.ts';
import type { Entity } from '../../types/core.ts';

/** The reachability statement. A trusted constant with no parameters. */
export const DOCTOR_SELECT_ONE_SQL = 'SELECT 1';

/** Every data statement the doctor may send. The second is the connector's role check. */
export const DOCTOR_SQL: readonly string[] = Object.freeze([DOCTOR_SELECT_ONE_SQL, ROLE_CHECK_SQL]);

export const PROBE_NAMES = ['db_select_one', 'db_writable', 'quickwit_http_live', 'tcp'] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

export type DbRole = { readonly writable: boolean; readonly reader: boolean };

export const PROBE_TIMEOUTS = Object.freeze({ tcpMs: 1_500, httpMs: 10_000 });

export type ProbeFailureCode = 'unreachable' | 'timeout' | 'refused' | 'not_configured' | 'error';

export type ProbeResult<T> =
  | { readonly status: 'ok'; readonly value: T; readonly transport: 'real' | 'mock' }
  | { readonly status: 'failed'; readonly code: ProbeFailureCode; readonly message: string; readonly transport: 'real' | 'mock' }
  | { readonly status: 'skipped'; readonly reason: string };

export interface Probes {
  /** Runs SELECT 1 against entity:service. ok means the database answered. */
  dbSelectOne(entity: Entity, service: string): Promise<ProbeResult<true>>;
  /**
   * Whether the role behind entity:service can INSERT, UPDATE or DELETE on
   * some user table, and whether the server is a replica (pg_is_in_recovery()).
   */
  dbWritable(entity: Entity, service: string): Promise<ProbeResult<DbRole>>;
  /** GET <ENTITY>_QUICKWIT_URL/health/livez. Never a search, count or histogram. */
  quickwitHttpLive(entity: Entity): Promise<ProbeResult<true>>;
  /** Whether host:port accepts a TCP connection. */
  tcp(host: string, port: number): Promise<ProbeResult<boolean>>;
  /** Ends any pools the probes opened. */
  close?(): Promise<void>;
}

// ------------------------------------------------------------------ keys

/** The probe field of a doctor_probe fixture key. */
export function probeKey(probe: ProbeName, entity: FixtureEntity, keyName: string): string {
  return `doctor|${probe}|${entity}|${keyName}`;
}

/** The env key name a DB probe is about, or undefined when the service has no database. */
export function dbKeyName(registry: Pick<Registry, 'serviceDb'>, entity: Entity, service: string): string | undefined {
  return registry.serviceDb(entity, service)?.envName;
}

function quickwitUrlKey(registry: Pick<Registry, 'spec'>, entity: Entity): string {
  return registry.spec(entity).quickwit.http?.url ?? `${entity.toUpperCase()}_QUICKWIT_URL`;
}

/** The tcp probe has no env key; host and port stand in for it. */
function tcpKeyName(host: string, port: number): string {
  return `${host}:${port}`;
}

const failed = (code: ProbeFailureCode, message: string, transport: 'real' | 'mock'): ProbeResult<never> =>
  Object.freeze({ status: 'failed', code, message, transport });
const okResult = <T>(value: T, transport: 'real' | 'mock'): ProbeResult<T> => Object.freeze({ status: 'ok', value, transport });
const skipped = (reason: string): ProbeResult<never> => Object.freeze({ status: 'skipped', reason });

// ------------------------------------------------------------------ mock

export type MockProbesOptions = {
  readonly registry: Pick<Registry, 'serviceDb' | 'spec'>;
  /** Fixture lookup. Only lookup() is used, so a strict port never throws here. */
  readonly mock: Pick<MockPort, 'lookup'>;
};

/**
 * Fixture results:
 *   db_select_one       { reachable: boolean }
 *   db_writable         { writable: boolean, reader?: boolean }   reader defaults to false
 *   quickwit_http_live  { live: boolean }
 *   tcp                 { open: boolean }
 */
export function createMockProbes(options: MockProbesOptions): Probes {
  const { registry, mock } = options;

  async function answer(probe: ProbeName, entity: FixtureEntity, keyName: string): Promise<ProbeResult<unknown>> {
    const probeName = probeKey(probe, entity, keyName);
    const found = await mock.lookup('doctor_probe', { entity, probe: probeName });
    if (!found.hit) return skipped(`mock mode: no doctor_probe fixture for ${probeName}`);
    return okResult(found.value, 'mock');
  }

  function field(result: ProbeResult<unknown>, name: string, probeName: string): ProbeResult<boolean> {
    if (result.status !== 'ok') return result as ProbeResult<never>;
    const value = (result.value as Record<string, unknown> | null)?.[name];
    if (typeof value !== 'boolean') return failed('error', `the doctor_probe fixture for ${probeName} has no boolean ${name}`, 'mock');
    return okResult(value, 'mock');
  }

  const noDb = (entity: Entity, service: string): ProbeResult<never> => skipped(`${entity}:${service} has no database key`);

  return Object.freeze({
    async dbSelectOne(entity: Entity, service: string): Promise<ProbeResult<true>> {
      const key = dbKeyName(registry, entity, service);
      if (key === undefined) return noDb(entity, service);
      const r = field(await answer('db_select_one', entity, key), 'reachable', probeKey('db_select_one', entity, key));
      if (r.status !== 'ok') return r as ProbeResult<never>;
      return r.value ? okResult(true as const, 'mock') : failed('unreachable', `the fixture says the database behind ${key} is unreachable`, 'mock');
    },
    async dbWritable(entity: Entity, service: string): Promise<ProbeResult<DbRole>> {
      const key = dbKeyName(registry, entity, service);
      if (key === undefined) return noDb(entity, service);
      const probeName = probeKey('db_writable', entity, key);
      const found = await answer('db_writable', entity, key);
      const r = field(found, 'writable', probeName);
      if (r.status !== 'ok') return r as ProbeResult<never>;
      const reader = (found.status === 'ok' ? (found.value as Record<string, unknown> | null)?.['reader'] : undefined) ?? false;
      if (typeof reader !== 'boolean') return failed('error', `the doctor_probe fixture for ${probeName} has a non-boolean reader`, 'mock');
      return okResult({ writable: r.value, reader }, 'mock');
    },
    async quickwitHttpLive(entity: Entity): Promise<ProbeResult<true>> {
      const key = quickwitUrlKey(registry, entity);
      const r = field(await answer('quickwit_http_live', entity, key), 'live', probeKey('quickwit_http_live', entity, key));
      if (r.status !== 'ok') return r as ProbeResult<never>;
      return r.value ? okResult(true as const, 'mock') : failed('unreachable', `the fixture says Quickwit at ${key} is not live`, 'mock');
    },
    async tcp(host: string, port: number): Promise<ProbeResult<boolean>> {
      const key = tcpKeyName(host, port);
      return field(await answer('tcp', 'global', key), 'open', probeKey('tcp', 'global', key));
    },
  });
}

// ------------------------------------------------------------------ real

/** Connects to host:port and reports whether it accepted within timeoutMs. Never throws. */
export type TcpConnect = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const netTcpConnect: TcpConnect = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

export type RealProbesOptions = {
  readonly config: Config;
  readonly registry: Registry;
  /** The T04 SQL connector. Built from config and registry with its own role cache when left out. */
  readonly sql?: Pick<SqlConnector, 'runSelect' | 'checkReadOnlyRole' | 'close'>;
  /** Used for the Quickwit liveness GET only. */
  readonly fetch: FetchLike;
  readonly tcpConnect?: TcpConnect;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
};

// Real mode never reads fixtures. The port is here only because the
// connector context needs one; its lookup must never be reached.
const REAL_MODE_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: true,
  lookup: () => Promise.reject(new Error('doctor probes: fixture lookup in real mode')),
});

const DB_FAILURE_CODES: ReadonlySet<string> = new Set(['unreachable', 'timeout', 'refused', 'not_configured']);

export function createRealProbes(options: RealProbesOptions): Probes {
  const { config, registry } = options;
  // The doctor reports a database that does not answer at once: no retry (D57).
  const sql =
    options.sql ?? createSqlConnector({ registry, config, roleCache: new RoleCheckCache(), poolMax: 1, retry: NO_RETRY });
  const tcpConnect = options.tcpConnect ?? netTcpConnect;
  const signal = options.signal ?? new AbortController().signal;

  function context(): ConnectorContext {
    return Object.freeze({ signal, now: options.now ?? (() => new Date()), mock: REAL_MODE_PORT, runId: 'doctor' });
  }

  function dbFailure(err: unknown): ProbeResult<never> {
    if (isConnectorError(err) && DB_FAILURE_CODES.has(err.code)) {
      // Connector messages name the entity, service and env var only.
      return failed(err.code as ProbeFailureCode, err.message, 'real');
    }
    if (isConnectorError(err)) return failed('error', err.message, 'real');
    return failed('error', `the probe threw ${err instanceof Error ? err.name : 'a non-error value'}`, 'real');
  }

  async function dbSelectOne(entity: Entity, service: string): Promise<ProbeResult<true>> {
    const { statementTimeoutMs, lockTimeoutMs } = config.sql;
    try {
      await sql.runSelect(context(), {
        entity,
        service,
        plan: [
          'BEGIN READ ONLY',
          `SET LOCAL statement_timeout = ${statementTimeoutMs}`,
          `SET LOCAL lock_timeout = ${lockTimeoutMs}`,
          DOCTOR_SELECT_ONE_SQL,
          'COMMIT',
        ],
        params: [],
        keyInput: { entity, service, tables: ['doctor_select_one'], params: [] },
      });
      return okResult(true as const, 'real');
    } catch (err) {
      // The connector runs the role check before the first call per env
      // var and blocks here when the role can write and
      // TRIAGE_REQUIRE_READONLY_DB_ROLE=true. The server answered, so the
      // database is reachable; dbWritable reports the role itself.
      if (isConnectorError(err) && err.code === 'readonly_role_required') return okResult(true as const, 'real');
      return dbFailure(err);
    }
  }

  async function dbWritable(entity: Entity, service: string): Promise<ProbeResult<DbRole>> {
    try {
      const check = await sql.checkReadOnlyRole(context(), entity, service);
      return okResult({ writable: check.writable, reader: check.reader }, 'real');
    } catch (err) {
      return dbFailure(err);
    }
  }

  async function quickwitHttpLive(entity: Entity): Promise<ProbeResult<true>> {
    const cap = registry.quickwit(entity);
    const spec = registry.spec(entity).quickwit;
    const urlKey = quickwitUrlKey(registry, entity);
    if (cap.status !== 'ok' || cap.transport !== 'http') return skipped(`${entity} is not on the http Quickwit transport`);
    const names = { url: urlKey, auth: spec.http?.auth ?? `${entity.toUpperCase()}_QUICKWIT_AUTH`, ...(spec.http?.token ? { token: spec.http.token } : {}) };
    let url: string;
    try {
      // searchUrl only validates the base here; the search path is never called.
      searchUrl(cap.url, cap.index, names);
      const base = new URL(cap.url);
      url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/health/livez`;
    } catch (err) {
      return isConnectorError(err) ? failed('not_configured', err.message, 'real') : failed('not_configured', `${urlKey} is not a valid URL`, 'real');
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cap.auth === 'bearer' && cap.token !== undefined) headers.authorization = `Bearer ${cap.token}`;

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min(config.budgets.httpTimeoutMs, PROBE_TIMEOUTS.httpMs));
    try {
      const res = await options.fetch(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      void res.body?.cancel().catch(() => {});
      const s = res.status;
      if (s >= 200 && s < 300) return okResult(true as const, 'real');
      if (s === 401 || s === 403) {
        const check = names.token === undefined ? names.auth : `${names.auth} and ${names.token}`;
        return failed('refused', `Quickwit at ${urlKey} refused the credentials (HTTP ${s}); check ${check}`, 'real');
      }
      if (res.type === 'opaqueredirect' || (s >= 300 && s < 400)) {
        return failed('refused', `Quickwit at ${urlKey} answered with a redirect; redirects are refused`, 'real');
      }
      return failed('unreachable', `Quickwit at ${urlKey} answered HTTP ${s} on /health/livez`, 'real');
    } catch {
      if (timedOut) return failed('timeout', `Quickwit at ${urlKey} did not answer within the timeout`, 'real');
      return failed('unreachable', `Quickwit at ${urlKey} could not be reached`, 'real');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function tcp(host: string, port: number): Promise<ProbeResult<boolean>> {
    try {
      return okResult(await tcpConnect(host, port, PROBE_TIMEOUTS.tcpMs), 'real');
    } catch {
      return okResult(false, 'real');
    }
  }

  return Object.freeze({
    dbSelectOne,
    dbWritable,
    quickwitHttpLive,
    tcp,
    close: () => sql.close(),
  });
}
