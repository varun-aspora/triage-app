// A scripted pg pool for the SQL connector tests. It never opens a socket:
// every query is recorded per checked-out client and answered by the
// respond() hook. Role check statements answer from `writable` unless
// respond() handles them.
import type { PgClientLike, PgPoolConfig, PgPoolFactory, PgPoolLike, PgQuery, PgQueryResult } from './pg-client.ts';
import { ROLE_CHECK_SQL } from './readonly-role.ts';

export type FakeClientLog = {
  readonly id: number;
  readonly queries: PgQuery[];
  /** Each release() argument, in order. undefined means returned to the pool. */
  readonly releases: unknown[];
};

export type Respond = (query: PgQuery, client: FakeClientLog) => PgQueryResult | Promise<PgQueryResult> | undefined;

export type FakePgOptions = {
  readonly respond?: Respond;
  /** The role check answer. Default false. */
  readonly writable?: boolean | (() => boolean);
  /** Makes connect() wait on this promise first. */
  readonly connectGate?: () => Promise<void>;
  /** Makes connect() reject with this error. */
  readonly connectError?: () => unknown;
};

export type FakePg = {
  readonly factory: PgPoolFactory;
  readonly configs: PgPoolConfig[];
  readonly clients: FakeClientLog[];
  readonly cancels: number[];
  readonly poolErrorListeners: ((err: Error) => void)[];
  /** Clients checked out and not yet released. */
  outstanding(): number;
  connects(): number;
  ended(): number;
  /** Clients that ran the role check statement. */
  roleClients(): FakeClientLog[];
  /** Clients that ran anything other than the role check. */
  selectClients(): FakeClientLog[];
};

export function fakePg(options: FakePgOptions = {}): FakePg {
  const configs: PgPoolConfig[] = [];
  const clients: FakeClientLog[] = [];
  const cancels: number[] = [];
  const poolErrorListeners: ((err: Error) => void)[] = [];
  let outstanding = 0;
  let connects = 0;
  let ended = 0;

  const writable = (): boolean =>
    typeof options.writable === 'function' ? options.writable() : options.writable === true;

  function makeClient(): PgClientLike {
    const log: FakeClientLog = { id: clients.length + 1, queries: [], releases: [] };
    clients.push(log);
    let released = false;
    const client: PgClientLike & { log: FakeClientLog } = {
      log,
      async query(query) {
        log.queries.push(query);
        const scripted = await options.respond?.(query, log);
        if (scripted !== undefined) return scripted;
        if (query.text === ROLE_CHECK_SQL) return { rows: [{ writable: writable() }], fields: [{ name: 'writable' }] };
        return { rows: [] };
      },
      release(destroy) {
        if (released) throw new Error('fake pg: client released twice');
        released = true;
        outstanding -= 1;
        log.releases.push(destroy);
      },
    };
    return client;
  }

  const factory: PgPoolFactory = (config) => {
    configs.push(config);
    const pool: PgPoolLike = {
      async connect() {
        connects += 1;
        if (options.connectGate !== undefined) await options.connectGate();
        if (options.connectError !== undefined) throw options.connectError();
        outstanding += 1;
        return makeClient();
      },
      async end() {
        ended += 1;
      },
      on(event, listener) {
        if (event === 'error') poolErrorListeners.push(listener);
        return pool;
      },
      async cancel(client) {
        cancels.push((client as unknown as { log: FakeClientLog }).log.id);
      },
    };
    return pool;
  };

  return {
    factory,
    configs,
    clients,
    cancels,
    poolErrorListeners,
    outstanding: () => outstanding,
    connects: () => connects,
    ended: () => ended,
    roleClients: () => clients.filter((c) => c.queries.some((q) => q.text === ROLE_CHECK_SQL)),
    selectClients: () => clients.filter((c) => !c.queries.some((q) => q.text === ROLE_CHECK_SQL)),
  };
}
