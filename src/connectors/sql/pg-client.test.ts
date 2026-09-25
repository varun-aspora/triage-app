import { describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { loadRegistry } from '../../config/registry.ts';
import { buildReadOnlyTxn, wrapWithCap } from '../../gate/sql-txn.ts';
import type { SqlSelectFacts } from '../../mock/key.ts';
import { makeTestConfig } from '../../../test/support/fake-tool-context.ts';
import type { MockLookup, MockPort } from '../mock.ts';
import { ConnectorError, MAX_SQL_RESULT_BYTES, type ConnectorContext } from '../types.ts';
import { capRows, createSqlConnector, type PgQuery, type SqlConnectorOptions, type SqlSelectOutcome } from './pg-client.ts';
import { fakePg, type FakePgOptions } from './pg-fake.ts';
import { RoleCheckCache } from './readonly-role.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// A made-up DSN. The .invalid host never resolves, and the fake pool never dials anyway.
const FAKE_USER = 'triage_fake_user';
const FAKE_PASSWORD = 'fakepw-4242-zz';
const FAKE_HOST = 'db-fake-7788.invalid';
const FAKE_DSN = `postgres://${FAKE_USER}:${FAKE_PASSWORD}@${FAKE_HOST}:6543/fake_package_db`;
const FAKE_DSN_2 = `postgres://${FAKE_USER}:${FAKE_PASSWORD}@${FAKE_HOST}:6543/fake_pulse_db`;
const SECRETS = [FAKE_DSN, FAKE_DSN_2, FAKE_PASSWORD, FAKE_HOST, FAKE_USER];

function setup(env: Record<string, string> = {}, options: Partial<SqlConnectorOptions> & { fake?: FakePgOptions } = {}) {
  const config = makeTestConfig({
    TRIAGE_ENTITIES: 'ssfb,atspl,rtl',
    ATSPL_PACKAGE_DB_URL: FAKE_DSN,
    ATSPL_PULSE_DB_URL: '',
    TRIAGE_SQL_STATEMENT_TIMEOUT_MS: '12345',
    TRIAGE_SQL_LOCK_TIMEOUT_MS: '678',
    TRIAGE_REQUIRE_READONLY_DB_ROLE: 'false',
    ...env,
  });
  const registry = loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
  const pg = fakePg(options.fake);
  const factory = mock(pg.factory);
  const { fake: _fake, ...rest } = options;
  const connector = createSqlConnector({
    registry,
    config,
    pgFactory: factory,
    roleCache: new RoleCheckCache(),
    ...rest,
  });
  return { config, registry, pg, factory, connector };
}

function realPort(): MockPort {
  return {
    enabled: false,
    strict: true,
    lookup: () => {
      throw new Error('real mode must not read fixtures');
    },
  };
}

function ctxOf(port: MockPort = realPort(), signal: AbortSignal = new AbortController().signal): ConnectorContext {
  return { signal, now: () => new Date('2026-09-23T10:00:00.000Z'), mock: port, runId: 'run_test_0001' };
}

const INNER = 'SELECT id, status FROM delivery_requests WHERE external_ref_id = $1';

function goodPlan(statementTimeoutMs = 12345, lockTimeoutMs = 678): string[] {
  return buildReadOnlyTxn({ statementTimeoutMs, lockTimeoutMs }, wrapWithCap(INNER, 1).sql);
}

const KEY: SqlSelectFacts = { entity: 'atspl', service: 'package', tables: ['delivery_requests'], params: ['cust-1'] };

function input(overrides: Record<string, unknown> = {}) {
  return { entity: 'atspl' as const, service: 'package', plan: goodPlan(), params: ['cust-1', 200], keyInput: KEY, ...overrides };
}

async function failure(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConnectorError) return err;
    throw err;
  }
  throw new Error('expected a ConnectorError');
}

function expectNoSecret(text: string): void {
  for (const s of SECRETS) expect(text).not.toContain(s);
}

function everyForm(err: unknown): string {
  return [String(err), (err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 5 }), JSON.stringify(err)].join('\n');
}

const truncatedOf = (out: SqlSelectOutcome): boolean | undefined => ('truncated' in out ? out.truncated : undefined);

const dataQueryOf = (queries: readonly PgQuery[]): PgQuery | undefined => queries[3];

describe('statement order and binding', () => {
  test('runs BEGIN READ ONLY, both SET LOCAL timeouts, the SELECT and COMMIT on one client', async () => {
    const { pg, connector } = setup({}, {
      fake: { respond: (q) => (q.text.startsWith('SELECT * FROM') ? { rows: [{ id: 'r1', status: 'ok' }], fields: [{ name: 'id' }, { name: 'status' }] } : undefined) },
    });
    const out = await connector.runSelect(ctxOf(), input());

    const [select] = pg.selectClients();
    expect(select).toBeDefined();
    expect(select!.queries.map((q) => q.text)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 12345',
      'SET LOCAL lock_timeout = 678',
      `SELECT * FROM (${INNER}\n) _capped LIMIT $2`,
      'COMMIT',
    ]);
    expect(select!.releases).toEqual([undefined]);
    expect(pg.outstanding()).toBe(0);

    expect(out.transport).toBe('real');
    expect(String(out.target_env)).toBe('ATSPL_PACKAGE_DB_URL');
    expect(out.data).toEqual({ rows: [{ id: 'r1', status: 'ok' }], row_count: 1, columns: ['id', 'status'] });
    expect(truncatedOf(out)).toBeUndefined();
  });

  test('binds params as $n values on the data statement and never interpolates them', async () => {
    const { pg, connector } = setup();
    await connector.runSelect(ctxOf(), input({ params: ["x' OR '1'='1", 200] }));
    const [select] = pg.selectClients();
    const data = dataQueryOf(select!.queries)!;
    expect(data.values).toEqual(["x' OR '1'='1", 200]);
    expect(data.queryMode).toBe('extended');
    expect(data.text).not.toContain("x' OR");
    for (const q of select!.queries.filter((q) => q !== data)) expect(q.values).toBeUndefined();
  });

  test('refuses params that are not scalars, before any checkout', async () => {
    const { pg, factory, connector } = setup();
    for (const params of [[{ a: 1 }], [Number.NaN], [1n], 'cust-1']) {
      const err = await failure(connector.runSelect(ctxOf(), input({ params })));
      expect(err.code).toBe('refused');
    }
    expect(factory).toHaveBeenCalledTimes(0);
    expect(pg.connects()).toBe(0);
  });
});

describe('rollback and release', () => {
  test('a failing data statement sends ROLLBACK and returns the client to the pool', async () => {
    const { pg, connector } = setup({}, {
      fake: {
        respond: (q) => {
          if (q.text.startsWith('SELECT * FROM')) throw Object.assign(new Error('column "nope" does not exist'), { code: '42703' });
          return undefined;
        },
      },
    });
    const err = await failure(connector.runSelect(ctxOf(), input()));
    expect(err.code).toBe('refused');
    expect(err.message).toContain('42703');
    expect(err.message).toContain('column "nope" does not exist');
    const [select] = pg.selectClients();
    expect(select!.queries.map((q) => q.text).slice(-1)).toEqual(['ROLLBACK']);
    expect(select!.queries.map((q) => q.text)).not.toContain('COMMIT');
    expect(select!.releases).toEqual([undefined]);
    expect(pg.outstanding()).toBe(0);
  });

  test('a failing SET LOCAL also rolls back', async () => {
    const { pg, connector } = setup({}, {
      fake: {
        // The first transaction on a new env var name is the role check, so that is the one that fails here.
        respond: (q) => {
          if (q.text.startsWith('SET LOCAL lock_timeout')) {
            throw Object.assign(new Error('invalid value'), { code: '22023' });
          }
          return undefined;
        },
      },
    });
    await failure(connector.runSelect(ctxOf(), input()));
    const last = pg.clients.at(-1)!;
    expect(last.queries.map((q) => q.text)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 12345',
      'SET LOCAL lock_timeout = 678',
      'ROLLBACK',
    ]);
    expect(pg.outstanding()).toBe(0);
  });

  test('a failed ROLLBACK destroys the client instead of reusing it', async () => {
    const { pg, connector } = setup({}, {
      fake: {
        respond: (q) => {
          if (q.text.startsWith('SELECT * FROM')) throw Object.assign(new Error('boom'), { code: '08006' });
          if (q.text === 'ROLLBACK') throw Object.assign(new Error('connection gone'), { code: '08006' });
          return undefined;
        },
      },
    });
    const err = await failure(connector.runSelect(ctxOf(), input()));
    expect(err.code).toBe('unreachable');
    const [select] = pg.selectClients();
    expect(select!.releases).toHaveLength(1);
    expect(select!.releases[0]).toBeInstanceOf(Error);
    expect(pg.outstanding()).toBe(0);
  });
});

describe('a socket that closes under a query', () => {
  test('the client is listened to while it is checked out, and not after', async () => {
    const { pg, connector } = setup();
    await connector.runSelect(ctxOf(), input());
    expect(pg.clients.length).toBeGreaterThan(0);
    for (const client of pg.clients) {
      expect(client.errorListeners.slice(0, -1).every((n) => n === 1)).toBe(true);
      expect(client.errorListeners.at(-1)).toBe(0);
    }
  });

  test('gives unreachable, sends no ROLLBACK, discards the client and leaves no listener behind', async () => {
    const { pg, connector } = setup({}, { fake: { drop: (q) => q.text.startsWith('SELECT * FROM') } });
    const err = await failure(connector.runSelect(ctxOf(), input()));
    expect(err.code).toBe('unreachable');
    expect(err.message).toBe('atspl:package: the connection to ATSPL_PACKAGE_DB_URL dropped');
    expectNoSecret(everyForm(err));
    const [select] = pg.selectClients();
    expect(select!.queries.map((q) => q.text)).not.toContain('ROLLBACK');
    expect(select!.releases).toHaveLength(1);
    expect((select!.releases[0] as Error).message).toBe('Connection terminated unexpectedly');
    expect(select!.errorListeners.at(-1)).toBe(0);
    expect(pg.outstanding()).toBe(0);
  });

  test('the pool is usable after a drop', async () => {
    let once = false;
    const { pg, connector } = setup({}, {
      fake: {
        drop: (q) => {
          if (once || !q.text.startsWith('SELECT * FROM')) return false;
          once = true;
          return true;
        },
      },
    });
    await failure(connector.runSelect(ctxOf(), input()));
    await connector.runSelect(ctxOf(), input());
    expect(pg.outstanding()).toBe(0);
    expect(pg.selectClients().at(-1)?.releases).toEqual([undefined]);
  });
});

describe('pool', () => {
  test('carries -c default_transaction_read_only=on in the pg config and leaves the DSN as it is', async () => {
    const { pg, connector } = setup();
    await connector.runSelect(ctxOf(), input());
    expect(pg.configs).toHaveLength(1);
    const cfg = pg.configs[0]!;
    expect(cfg.options).toBe('-c default_transaction_read_only=on');
    expect(cfg.connectionString).toBe(FAKE_DSN);
    expect(cfg.max).toBeGreaterThan(0);
    expect(cfg.max).toBeLessThanOrEqual(5);
  });

  test('keeps one lazy pool per env var name', async () => {
    const { factory, connector } = setup({ ATSPL_PULSE_DB_URL: FAKE_DSN_2 });
    expect(factory).toHaveBeenCalledTimes(0);
    await connector.runSelect(ctxOf(), input());
    await connector.runSelect(ctxOf(), input());
    expect(factory).toHaveBeenCalledTimes(1);
    await connector.runSelect(ctxOf(), input({ service: 'pulse', keyInput: { ...KEY, service: 'pulse' } }));
    expect(factory).toHaveBeenCalledTimes(2);
    await connector.close();
  });

  test('close() ends every pool', async () => {
    const { pg, connector } = setup();
    await connector.runSelect(ctxOf(), input());
    await connector.close();
    expect(pg.ended()).toBe(1);
  });

  test('refuses a DSN that sets its own options parameter, without echoing it', async () => {
    const dsn = `${FAKE_DSN}?options=-c%20default_transaction_read_only%3Doff`;
    const { factory, connector } = setup({ ATSPL_PACKAGE_DB_URL: dsn });
    const err = await failure(connector.runSelect(ctxOf(), input()));
    expect(err.code).toBe('refused');
    expect(err.message).toContain('ATSPL_PACKAGE_DB_URL');
    expect(everyForm(err)).not.toContain(dsn);
    expectNoSecret(everyForm(err));
    expect(factory).toHaveBeenCalledTimes(0);
  });
});

describe('plan refusals happen before any checkout', () => {
  const wrapped = wrapWithCap(INNER, 1).sql;
  const cases: [string, unknown][] = [
    ['a raw string', wrapped],
    ['a raw string that looks like a plan', goodPlan().join('; ')],
    ['not an array of strings', ['BEGIN READ ONLY', 1, 2, wrapped, 'COMMIT']],
    ['an empty plan', []],
    ['plain BEGIN', ['BEGIN', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['BEGIN READ WRITE', ['BEGIN READ WRITE', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['no BEGIN at all', ['SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['no SET LOCAL timeouts', ['BEGIN READ ONLY', wrapped, 'COMMIT']],
    ['only statement_timeout', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', wrapped, 'COMMIT']],
    ['only lock_timeout', ['BEGIN READ ONLY', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['timeouts in the wrong order', ['BEGIN READ ONLY', 'SET LOCAL lock_timeout = 100', 'SET LOCAL statement_timeout = 100', wrapped, 'COMMIT']],
    ['SET instead of SET LOCAL', ['BEGIN READ ONLY', 'SET statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['statement_timeout = 0', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 0', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['statement_timeout above config', goodPlan(12346, 678)],
    ['lock_timeout above config', goodPlan(12345, 679)],
    ['a timeout with trailing text', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100; RESET ALL', 'SET LOCAL lock_timeout = 100', wrapped, 'COMMIT']],
    ['two data statements', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, wrapped, 'COMMIT']],
    ['a data statement then a write', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, 'DELETE FROM t', 'COMMIT']],
    ['no data statement', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', 'COMMIT']],
    ['no COMMIT', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', wrapped, 'ROLLBACK']],
    ['a data statement that is not a SELECT', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', 'UPDATE t SET a = 1', 'COMMIT']],
    ['a SET as the data statement', ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 100', 'SET LOCAL lock_timeout = 100', 'SET default_transaction_read_only = off', 'COMMIT']],
  ];

  for (const [name, plan] of cases) {
    test(`refuses ${name}`, async () => {
      const { pg, factory, connector } = setup();
      const err = await failure(connector.runSelect(ctxOf(), input({ plan })));
      expect(err.code).toBe('refused');
      expect(err.message.startsWith('Refused:')).toBe(true);
      expect(factory).toHaveBeenCalledTimes(0);
      expect(pg.connects()).toBe(0);
    });
  }

  test('refuses a malformed plan in mock mode too, before the fixture lookup', async () => {
    const { connector } = setup();
    const lookup = mock(async (): Promise<MockLookup> => ({ hit: true, value: { rows: [], row_count: 0, columns: [] }, hash: 'h' }));
    const err = await failure(connector.runSelect(ctxOf({ enabled: true, strict: true, lookup }), input({ plan: wrapped })));
    expect(err.code).toBe('refused');
    expect(lookup).toHaveBeenCalledTimes(0);
  });

  test('accepts the plan buildReadOnlyTxn makes with timeouts at or under the config', async () => {
    const { connector } = setup();
    await connector.runSelect(ctxOf(), input({ plan: goodPlan(100, 50) }));
  });
});

describe('not_configured', () => {
  test('a blank DB env var names <entity>:<service> and the env var name only', async () => {
    const { pg, factory, connector } = setup();
    const err = await failure(connector.runSelect(ctxOf(), input({ service: 'pulse', keyInput: { ...KEY, service: 'pulse' } })));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('atspl:pulse');
    expect(err.message).toContain('ATSPL_PULSE_DB_URL');
    expectNoSecret(everyForm(err));
    expect(factory).toHaveBeenCalledTimes(0);
    expect(pg.connects()).toBe(0);
  });

  test('a service without a database is not_configured', async () => {
    const { factory, connector } = setup();
    const err = await failure(
      connector.runSelect(ctxOf(), input({ entity: 'ssfb', service: 'eventbus', keyInput: { ...KEY, entity: 'ssfb', service: 'eventbus' } })),
    );
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('ssfb:eventbus');
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('an unknown service is not_configured', async () => {
    const { connector } = setup();
    const err = await failure(connector.runSelect(ctxOf(), input({ service: 'nope', keyInput: { ...KEY, service: 'nope' } })));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('atspl:nope');
  });
});

describe('byte cap', () => {
  const row = (i: number) => ({ id: `row-${i}`, pad: 'x'.repeat(20) });

  test('a result over the byte cap is cut to whole rows with truncated=true', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i));
    const { connector } = setup({}, {
      maxResultBytes: 150,
      fake: { respond: (q) => (q.text.startsWith('SELECT * FROM') ? { rows, fields: [{ name: 'id' }, { name: 'pad' }] } : undefined) },
    });
    const out = await connector.runSelect(ctxOf(), input());
    expect(truncatedOf(out)).toBe(true);
    const data = out.data!;
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.length).toBeLessThan(10);
    expect(data.row_count).toBe(data.rows.length);
    expect(Buffer.byteLength(JSON.stringify(data.rows))).toBeLessThanOrEqual(150);
    expect(data.rows).toEqual(rows.slice(0, data.rows.length));
  });

  test('a result under the cap is whole and not marked truncated', async () => {
    const rows = [row(1), row(2)];
    const { connector } = setup({}, {
      fake: { respond: (q) => (q.text.startsWith('SELECT * FROM') ? { rows } : undefined) },
    });
    const out = await connector.runSelect(ctxOf(), input());
    expect(truncatedOf(out)).toBeUndefined();
    expect(out.data!.row_count).toBe(2);
  });

  test('the default cap is MAX_SQL_RESULT_BYTES and an option cannot raise it', () => {
    const big = 'y'.repeat(3 * 1024 * 1024);
    const rows = [{ v: big }, { v: big }, { v: big }];
    const cut = capRows(rows, MAX_SQL_RESULT_BYTES);
    expect(cut.truncated).toBe(true);
    expect(cut.rows).toHaveLength(2);
    expect(capRows(rows.slice(0, 2), MAX_SQL_RESULT_BYTES).truncated).toBe(false);
  });

  test('maxResultBytes above the hard cap is clamped', async () => {
    const big = 'y'.repeat(3 * 1024 * 1024);
    const rows = [{ v: big }, { v: big }, { v: big }];
    const { connector } = setup({}, {
      maxResultBytes: MAX_SQL_RESULT_BYTES * 4,
      fake: { respond: (q) => (q.text.startsWith('SELECT * FROM') ? { rows } : undefined) },
    });
    const out = await connector.runSelect(ctxOf(), input());
    expect(truncatedOf(out)).toBe(true);
    expect(out.data!.row_count).toBe(2);
  });
});

describe('abort', () => {
  test('an abort during the query cancels it, destroys the client and gives timeout', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const reached = new Promise<void>((r) => (started = r));
    const { pg, connector } = setup({}, {
      fake: {
        respond: (q) => {
          if (!q.text.startsWith('SELECT * FROM')) return undefined;
          started();
          return new Promise(() => {});
        },
      },
    });
    const run = connector.runSelect(ctxOf(realPort(), controller.signal), input());
    await reached;
    controller.abort();
    const err = await failure(run);
    expect(['timeout', 'refused']).toContain(err.code);
    expect(err.code).toBe('timeout');

    const [select] = pg.selectClients();
    expect(pg.cancels).toEqual([select!.id]);
    expect(select!.releases).toHaveLength(1);
    expect(select!.releases[0]).toBeInstanceOf(Error);
    expect(select!.queries.map((q) => q.text)).not.toContain('COMMIT');
    expect(pg.outstanding()).toBe(0);
  });

  test('the pool is usable after an abort', async () => {
    const controller = new AbortController();
    let hang = true;
    let started!: () => void;
    const reached = new Promise<void>((r) => (started = r));
    const { pg, factory, connector } = setup({}, {
      fake: {
        respond: (q) => {
          if (!hang || !q.text.startsWith('SELECT * FROM')) return undefined;
          started();
          return new Promise(() => {});
        },
      },
    });
    const run = connector.runSelect(ctxOf(realPort(), controller.signal), input());
    await reached;
    controller.abort();
    await failure(run);
    hang = false;
    const out = await connector.runSelect(ctxOf(), input());
    expect(out.transport).toBe('real');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(pg.outstanding()).toBe(0);
  });

  test('an already aborted signal gives timeout without a checkout', async () => {
    const controller = new AbortController();
    controller.abort();
    const { pg, connector } = setup();
    const err = await failure(connector.runSelect(ctxOf(realPort(), controller.signal), input()));
    expect(err.code).toBe('timeout');
    expect(pg.connects()).toBe(0);
  });

  test('an abort while waiting for a pool client returns the late client', async () => {
    const controller = new AbortController();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let waiting!: () => void;
    const reached = new Promise<void>((r) => (waiting = r));
    const { pg, connector } = setup({}, {
      fake: {
        connectGate: () => {
          waiting();
          return gate;
        },
      },
    });
    const run = connector.runSelect(ctxOf(realPort(), controller.signal), input());
    await reached;
    controller.abort();
    const err = await failure(run);
    expect(err.code).toBe('timeout');
    open();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(pg.outstanding()).toBe(0);
  });
});

describe('Postgres error mapping', () => {
  const cases: [string, string, string][] = [
    ['57014', 'canceling statement due to statement timeout', 'timeout'],
    ['55P03', 'could not obtain lock on relation', 'timeout'],
    ['25006', 'cannot execute INSERT in a read-only transaction', 'refused'],
    ['42501', 'permission denied for table t', 'refused'],
    ['08006', 'connection failure', 'unreachable'],
    ['57P01', 'terminating connection due to administrator command', 'unreachable'],
  ];
  for (const [code, message, expected] of cases) {
    test(`${code} maps to ${expected}`, async () => {
      const { connector } = setup({}, {
        fake: { respond: (q) => (q.text.startsWith('SELECT * FROM') ? Promise.reject(Object.assign(new Error(message), { code })) : undefined) },
      });
      const err = await failure(connector.runSelect(ctxOf(), input()));
      expect(err.code).toBe(expected as ConnectorError['code']);
      expect(err.message).toContain(code);
    });
  }
});

describe('mock mode', () => {
  test('answers from the fixture and never constructs the pg factory', async () => {
    const { factory, pg, connector } = setup();
    const lookup = mock(async (): Promise<MockLookup> => ({
      hit: true,
      value: { rows: [{ id: 'm1' }], row_count: 1, columns: ['id'] },
      hash: 'abc',
    }));
    const out = await connector.runSelect(ctxOf({ enabled: true, strict: true, lookup }), input());
    expect(out.transport).toBe('mock');
    expect(out.data).toEqual({ rows: [{ id: 'm1' }], row_count: 1, columns: ['id'] });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]).toEqual(['sql_select', KEY] as never);
    expect(factory).toHaveBeenCalledTimes(0);
    expect(pg.connects()).toBe(0);
  });

  test('works with a blank DSN, since fixtures need only the env var name', async () => {
    const { factory, connector } = setup();
    const lookup = async (): Promise<MockLookup> => ({ hit: true, value: { rows: [], row_count: 0, columns: [] }, hash: 'h' });
    const out = await connector.runSelect(
      ctxOf({ enabled: true, strict: true, lookup }),
      input({ service: 'pulse', keyInput: { ...KEY, service: 'pulse' } }),
    );
    expect(String(out.target_env)).toBe('ATSPL_PULSE_DB_URL');
    expect(factory).toHaveBeenCalledTimes(0);
  });

  test('a strict miss throws strict_miss and still never touches pg', async () => {
    const { factory, connector } = setup();
    const lookup = async (): Promise<MockLookup> => ({ hit: false, key_string: '{"entity":"atspl"}', hash: 'deadbeefdeadbeef' });
    const err = await failure(connector.runSelect(ctxOf({ enabled: true, strict: true, lookup }), input()));
    expect(err.code).toBe('strict_miss');
    expect(factory).toHaveBeenCalledTimes(0);
  });
});

describe('the DSN is never echoed', () => {
  const failures: [string, FakePgOptions][] = [
    ['connect refused', { connectError: () => Object.assign(new Error(`connect ECONNREFUSED ${FAKE_HOST}:6543`), { code: 'ECONNREFUSED' }) }],
    ['dns failure', { connectError: () => Object.assign(new Error(`getaddrinfo ENOTFOUND ${FAKE_HOST}`), { code: 'ENOTFOUND' }) }],
    ['auth failure', { connectError: () => Object.assign(new Error(`password authentication failed for user "${FAKE_USER}"`), { code: '28P01' }) }],
    ['unknown database', { connectError: () => Object.assign(new Error('database "fake_package_db" does not exist'), { code: '3D000' }) }],
    ['plain error with the DSN in it', { connectError: () => new Error(`bad url ${FAKE_DSN}`) }],
    [
      'query error quoting DSN parts',
      {
        respond: (q) =>
          q.text.startsWith('SELECT * FROM')
            ? Promise.reject(Object.assign(new Error(`relation "${FAKE_HOST}" at ${FAKE_DSN} for ${FAKE_USER}`), { code: '42P01' }))
            : undefined,
      },
    ],
  ];

  for (const [name, fake] of failures) {
    test(name, async () => {
      const { connector } = setup({}, { fake });
      const err = await failure(connector.runSelect(ctxOf(), input()));
      expect(err.message).toContain('atspl:package');
      expectNoSecret(everyForm(err));
    });
  }

  test('results, pool error callbacks and the connector itself carry no DSN', async () => {
    const seen: string[] = [];
    const { pg, connector } = setup({}, {
      onPoolError: (env, code) => seen.push(`${env} ${code}`),
      fake: { respond: (q) => (q.text.startsWith('SELECT * FROM') ? { rows: [{ id: 1 }] } : undefined) },
    });
    const out = await connector.runSelect(ctxOf(), input());
    for (const l of pg.poolErrorListeners) l(Object.assign(new Error(`idle client error ${FAKE_DSN}`), { code: 'ECONNRESET' }));
    expect(seen).toEqual(['ATSPL_PACKAGE_DB_URL ECONNRESET']);
    const texts = [JSON.stringify(out), inspect(out, { depth: 10 }), inspect(connector, { depth: 10 }), JSON.stringify(connector), ...seen];
    for (const t of texts) expectNoSecret(t ?? '');
  });
});

describe('role warning on results', () => {
  test('a writable role with the default policy runs the call and attaches the warning', async () => {
    const { connector } = setup({}, { fake: { writable: true } });
    const out = await connector.runSelect(ctxOf(), input());
    expect(out.transport).toBe('real');
    expect(out.role_warning).toContain('ATSPL_PACKAGE_DB_URL');
    expect(out.role_warning).toContain('TRIAGE_REQUIRE_READONLY_DB_ROLE');
    expectNoSecret(out.role_warning!);
  });
});
