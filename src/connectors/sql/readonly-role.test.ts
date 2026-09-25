import { describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../../config/registry.ts';
import { buildReadOnlyTxn, wrapWithCap } from '../../gate/sql-txn.ts';
import type { SqlSelectFacts } from '../../mock/key.ts';
import { makeTestConfig } from '../../../test/support/fake-tool-context.ts';
import type { MockLookup, MockPort } from '../mock.ts';
import { ConnectorError, envVarName, type ConnectorContext } from '../types.ts';
import { createSqlConnector } from './pg-client.ts';
import { fakePg, type FakePgOptions } from './pg-fake.ts';
import {
  createRolePolicy,
  parseRoleCheckRows,
  processRoleCache,
  ROLE_CHECK_SQL,
  RoleCheckCache,
  type RoleCheck,
} from './readonly-role.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE_DSN = 'postgres://role_fake_user:rolefakepw-99@role-fake-3311.invalid:6543/fake_package_db';
const FAKE_DSN_2 = 'postgres://role_fake_user:rolefakepw-99@role-fake-3311.invalid:6543/fake_pulse_db';

function setup(opts: { require?: boolean; fake?: FakePgOptions; cache?: RoleCheckCache } = {}) {
  const config = makeTestConfig({
    TRIAGE_ENTITIES: 'ssfb,atspl,rtl',
    ATSPL_PACKAGE_DB_URL: FAKE_DSN,
    ATSPL_PULSE_DB_URL: FAKE_DSN_2,
    TRIAGE_SQL_STATEMENT_TIMEOUT_MS: '4000',
    TRIAGE_SQL_LOCK_TIMEOUT_MS: '500',
    TRIAGE_REQUIRE_READONLY_DB_ROLE: opts.require === true ? 'true' : 'false',
  });
  const registry = loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
  const pg = fakePg(opts.fake);
  const factory = mock(pg.factory);
  const cache = opts.cache ?? new RoleCheckCache();
  const connector = createSqlConnector({ registry, config, pgFactory: factory, roleCache: cache });
  return { config, pg, factory, connector, cache };
}

const realPort: MockPort = {
  enabled: false,
  strict: true,
  lookup: () => {
    throw new Error('real mode must not read fixtures');
  },
};

function ctxOf(port: MockPort = realPort): ConnectorContext {
  return { signal: new AbortController().signal, now: () => new Date('2026-09-23T10:00:00.000Z'), mock: port, runId: 'run_test_0001' };
}

const INNER = 'SELECT id FROM delivery_requests WHERE external_ref_id = $1';
const KEY: SqlSelectFacts = { entity: 'atspl', service: 'package', tables: ['delivery_requests'], params: ['cust-1'] };

function input(service = 'package') {
  return {
    entity: 'atspl' as const,
    service,
    plan: buildReadOnlyTxn({ statementTimeoutMs: 4000, lockTimeoutMs: 500 }, wrapWithCap(INNER, 1).sql),
    params: ['cust-1', 200],
    keyInput: { ...KEY, service },
  };
}

function roleRuns(pg: ReturnType<typeof fakePg>): number {
  return pg.roleClients().length;
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

describe('the role check statement', () => {
  test('asks for INSERT, UPDATE or DELETE over user tables with bool_or', () => {
    expect(ROLE_CHECK_SQL).toContain('bool_or(');
    for (const priv of ['INSERT', 'UPDATE', 'DELETE']) expect(ROLE_CHECK_SQL).toContain(`has_table_privilege(c.oid, '${priv}')`);
    expect(ROLE_CHECK_SQL).toContain("n.nspname <> 'information_schema'");
    expect(ROLE_CHECK_SQL).toContain('pg_is_in_recovery() AS reader');
    expect(ROLE_CHECK_SQL.startsWith('SELECT')).toBe(true);
    expect(ROLE_CHECK_SQL).not.toContain(';');
    expect(ROLE_CHECK_SQL).not.toContain('$');
  });

  test('runs inside BEGIN READ ONLY with both SET LOCAL timeouts, then COMMIT', async () => {
    const { pg, connector } = setup();
    const check = await connector.checkReadOnlyRole(ctxOf(), 'atspl', 'package');
    expect(check).toEqual({ writable: false, reader: false, target_env: envVarName('ATSPL_PACKAGE_DB_URL') });
    const [client] = pg.roleClients();
    expect(client!.queries.map((q) => q.text)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 4000',
      'SET LOCAL lock_timeout = 500',
      ROLE_CHECK_SQL,
      'COMMIT',
    ]);
    expect(client!.queries[3]!.values).toEqual([]);
    expect(client!.releases).toEqual([undefined]);
    expect(pg.configs[0]!.options).toBe('-c default_transaction_read_only=on');
  });

  test('an unexpected result is an error, not a guess', () => {
    expect(() => parseRoleCheckRows([])).toThrow(ConnectorError);
    expect(() => parseRoleCheckRows([{ reader: false, writable: 't' }])).toThrow(ConnectorError);
    expect(() => parseRoleCheckRows([{ reader: 'f', writable: true }])).toThrow(ConnectorError);
    expect(() => parseRoleCheckRows([{ writable: true }])).toThrow(ConnectorError);
    expect(() => parseRoleCheckRows([{ reader: false, writable: true }, { reader: false, writable: false }])).toThrow(ConnectorError);
    expect(parseRoleCheckRows([{ reader: false, writable: true }])).toEqual({ writable: true, reader: false });
    expect(parseRoleCheckRows([{ reader: true, writable: true }])).toEqual({ writable: true, reader: true });
  });

  test('a blank DB env var is not_configured and nothing is checked', async () => {
    const config = makeTestConfig({ TRIAGE_ENTITIES: 'ssfb,atspl,rtl', ATSPL_PACKAGE_DB_URL: '' });
    const registry = loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
    const pg = fakePg();
    const connector = createSqlConnector({ registry, config, pgFactory: pg.factory, roleCache: new RoleCheckCache() });
    const err = await failure(connector.checkReadOnlyRole(ctxOf(), 'atspl', 'package'));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('ATSPL_PACKAGE_DB_URL');
    expect(pg.connects()).toBe(0);
  });

  test('the role check refuses to run in mock mode', async () => {
    const { factory, connector } = setup();
    const err = await failure(connector.checkReadOnlyRole(ctxOf({ ...realPort, enabled: true }), 'atspl', 'package'));
    expect(err.code).toBe('refused');
    expect(factory).toHaveBeenCalledTimes(0);
  });
});

describe('policy', () => {
  test('writable role, TRIAGE_REQUIRE_READONLY_DB_ROLE=false: warning, and the call proceeds', async () => {
    const { pg, connector } = setup({ fake: { writable: true } });
    const policy = await connector.enforceRolePolicy(ctxOf(), 'atspl', 'package');
    expect(policy.writable).toBe(true);
    expect(policy.warning).toContain('ATSPL_PACKAGE_DB_URL');
    expect(policy.warning).toContain('atspl:package');
    expect(policy.warning).not.toContain('rolefakepw-99');

    const out = await connector.runSelect(ctxOf(), input());
    expect(out.transport).toBe('real');
    expect(out.role_warning).toBe(policy.warning);
    expect(pg.selectClients()).toHaveLength(1);
    expect(pg.selectClients()[0]!.queries.at(-1)!.text).toBe('COMMIT');
  });

  test('writable role, TRIAGE_REQUIRE_READONLY_DB_ROLE=true: real calls get readonly_role_required', async () => {
    const { pg, connector } = setup({ require: true, fake: { writable: true } });
    const err = await failure(connector.runSelect(ctxOf(), input()));
    expect(err.code).toBe('readonly_role_required');
    expect(err.message).toContain('atspl:package');
    expect(err.message).toContain('ATSPL_PACKAGE_DB_URL');
    expect(err.message).not.toContain('rolefakepw-99');
    // The data statement never ran.
    expect(pg.selectClients()).toHaveLength(0);
    expect(pg.outstanding()).toBe(0);

    const again = await failure(connector.enforceRolePolicy(ctxOf(), 'atspl', 'package'));
    expect(again.code).toBe('readonly_role_required');
  });

  test('read-only role: no warning, with or without the require flag', async () => {
    for (const require of [false, true]) {
      const { connector } = setup({ require, fake: { writable: false } });
      const policy = await connector.enforceRolePolicy(ctxOf(), 'atspl', 'package');
      expect(policy.writable).toBe(false);
      expect(policy.warning).toBeUndefined();
      const out = await connector.runSelect(ctxOf(), input());
      expect(out.role_warning).toBeUndefined();
      expect(out.transport).toBe('real');
    }
  });

  test('a writable role on a replica passes without a warning, even with the require flag on', async () => {
    for (const require of [false, true]) {
      const { pg, connector } = setup({ require, fake: { writable: true, reader: true } });
      const policy = await connector.enforceRolePolicy(ctxOf(), 'atspl', 'package');
      expect(policy).toEqual({ writable: true, reader: true, target_env: envVarName('ATSPL_PACKAGE_DB_URL') });
      const out = await connector.runSelect(ctxOf(), input());
      expect(out.role_warning).toBeUndefined();
      expect(out.transport).toBe('real');
      expect(pg.selectClients()).toHaveLength(1);
    }
  });

  test('mock mode never runs the role check, even with the require flag on', async () => {
    const { factory, connector } = setup({ require: true, fake: { writable: true } });
    const lookup = async (): Promise<MockLookup> => ({ hit: true, value: { rows: [], row_count: 0, columns: [] }, hash: 'h' });
    const out = await connector.runSelect(ctxOf({ enabled: true, strict: true, lookup }), input());
    expect(out.transport).toBe('mock');
    expect(factory).toHaveBeenCalledTimes(0);
  });
});

describe('once per env var name', () => {
  test('the check runs once for many calls on the same env var name', async () => {
    const { pg, connector } = setup({ fake: { writable: true } });
    await connector.runSelect(ctxOf(), input());
    await connector.runSelect(ctxOf(), input());
    await connector.enforceRolePolicy(ctxOf(), 'atspl', 'package');
    expect(roleRuns(pg)).toBe(1);
    expect(pg.selectClients()).toHaveLength(2);
  });

  test('a second env var name gets its own check', async () => {
    const { pg, connector } = setup();
    await connector.runSelect(ctxOf(), input('package'));
    await connector.runSelect(ctxOf(), input('pulse'));
    await connector.runSelect(ctxOf(), input('pulse'));
    expect(roleRuns(pg)).toBe(2);
  });

  test('concurrent first calls share one check', async () => {
    const { pg, connector } = setup();
    await Promise.all([connector.runSelect(ctxOf(), input()), connector.runSelect(ctxOf(), input()), connector.runSelect(ctxOf(), input())]);
    expect(roleRuns(pg)).toBe(1);
  });

  test('the cache is shared across connectors in a process', async () => {
    const cache = new RoleCheckCache();
    const a = setup({ cache });
    const b = setup({ cache });
    await a.connector.runSelect(ctxOf(), input());
    await b.connector.runSelect(ctxOf(), input());
    expect(roleRuns(a.pg) + roleRuns(b.pg)).toBe(1);
  });

  test('a failed check is not cached, so the next call checks again', async () => {
    let fail = true;
    const { pg, connector } = setup({
      fake: {
        respond: (q) => {
          if (q.text === ROLE_CHECK_SQL && fail) {
            fail = false;
            return Promise.reject(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
          }
          return undefined;
        },
      },
    });
    const err = await failure(connector.runSelect(ctxOf(), input()));
    expect(err.code).toBe('unreachable');
    expect(pg.selectClients()).toHaveLength(0);
    await connector.runSelect(ctxOf(), input());
    expect(roleRuns(pg)).toBe(2);
    await connector.runSelect(ctxOf(), input());
    expect(roleRuns(pg)).toBe(2);
  });

  test('checkReadOnlyRole itself always runs, without the cache', async () => {
    const { pg, connector } = setup();
    await connector.checkReadOnlyRole(ctxOf(), 'atspl', 'package');
    await connector.checkReadOnlyRole(ctxOf(), 'atspl', 'package');
    expect(roleRuns(pg)).toBe(2);
  });

  test('connectors use the process cache by default', () => {
    expect(processRoleCache).toBeInstanceOf(RoleCheckCache);
  });
});

describe('createRolePolicy on its own', () => {
  const target_env = envVarName('ATSPL_PACKAGE_DB_URL');

  test('warns, blocks and caches as configured', async () => {
    const runCheck = mock(async (): Promise<RoleCheck> => ({ writable: true, reader: false, target_env }));
    const warn = createRolePolicy({ requireReadonlyRole: false, runCheck, envNameOf: () => target_env, cache: new RoleCheckCache() });
    const first = await warn.enforceRolePolicy(ctxOf(), 'atspl', 'package');
    await warn.enforceRolePolicy(ctxOf(), 'atspl', 'package');
    expect(first.warning).toBeDefined();
    expect(runCheck).toHaveBeenCalledTimes(1);

    const block = createRolePolicy({ requireReadonlyRole: true, runCheck, envNameOf: () => target_env, cache: new RoleCheckCache() });
    const err = await failure(block.enforceRolePolicy(ctxOf(), 'atspl', 'package'));
    expect(err.code).toBe('readonly_role_required');
  });

  test('RoleCheckCache drops a rejected check', async () => {
    const cache = new RoleCheckCache();
    await expect(cache.get('X_DB_URL', () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    await Promise.resolve();
    expect(cache.has('X_DB_URL')).toBe(false);
    const ok = await cache.get('X_DB_URL', async () => ({ writable: false, reader: false, target_env }));
    expect(ok.writable).toBe(false);
    expect(cache.has('X_DB_URL')).toBe(true);
  });
});
