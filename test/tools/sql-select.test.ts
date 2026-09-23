import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import type { Config } from '../../src/config/env.ts';
import type { RunSelectInput, SqlConnector, SqlSelectOutcome } from '../../src/connectors/sql/pg-client.ts';
import { ConnectorError, envVarName } from '../../src/connectors/types.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import { FixtureMissError } from '../../src/mock/errors.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyString, semanticKey } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps } from '../../src/tools/_lib/context.ts';
import type { StagingHarness } from '../../src/tools/_lib/pipeline.ts';
import { toolModule } from '../../src/tools/sql-select.tool.ts';
import { conformanceCases, conformanceProblems, toolsFor } from '../../src/tools/index.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import type { Entity } from '../../src/types/core.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

// ------------------------------------------------------------------ fixtures

const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const ACCOUNT_NO = '123456789012';
const PAN = '4111111111111111'; // Luhn-valid test card number (primary account number)
const FIXED_NOW = new Date('2026-09-24T10:00:00.000Z');
const FAKE_DSN = 'postgresql://triage_ro:Sup3rS3cretPw@package-db.internal.example:5432/package_db';
const CHAIN: IdChain = { ids: { customer_id: CUSTOMER }, hops: [], basic_state: [] };

const SELECT_ONE =
  'SELECT id, status, vendor, created_at FROM delivery_requests WHERE external_ref_id = $1 ORDER BY created_at DESC';

type Row = Record<string, unknown>;
const row = (i: number): Row => ({ id: `row-${i}`, status: 'PENDING', account_number: ACCOUNT_NO, pan: PAN });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let runSeq = 0;

type FakeSql = SqlConnector & { calls: RunSelectInput[] };

function fakeSql(rows: Row[] = [row(1)], opts: { fail?: ConnectorError } = {}): FakeSql {
  const calls: RunSelectInput[] = [];
  const unused = (): never => {
    throw new Error('not used by sql_select');
  };
  return {
    calls,
    async runSelect(_ctx, input): Promise<SqlSelectOutcome> {
      calls.push(input);
      if (opts.fail !== undefined) throw opts.fail;
      return {
        data: { rows, row_count: rows.length, columns: Object.keys(rows[0] ?? {}) },
        transport: 'real',
        target_env: envVarName('ATSPL_PACKAGE_DB_URL'),
        taken_at: FIXED_NOW.toISOString(),
        duration_ms: 1,
      };
    },
    checkReadOnlyRole: unused,
    enforceRolePolicy: unused,
    close: async () => {},
  };
}

type Setup = {
  readonly env?: Record<string, string | undefined>;
  readonly entity?: Entity;
  readonly fixtureResult?: unknown;
  readonly sql?: FakeSql;
};

type H = {
  readonly ctx: ToolContext;
  readonly tool: ToolDefinition;
  readonly audit: MemoryAuditSink;
  readonly sql: FakeSql;
  readonly config: Config;
  readonly storeKeys: { kind: string; entity: string; key: unknown }[];
};

function setup(opts: Setup = {}): H {
  runSeq += 1;
  const runId = `run_sql_select_${runSeq}_${Date.now().toString(36)}`;
  const config = makeTestConfig({ ATSPL_PACKAGE_DB_URL: FAKE_DSN, TRIAGE_SQL_MAX_ROWS: '3', ...opts.env });
  const entity = opts.entity ?? 'atspl';
  const budget = createRunBudget({
    runId,
    maxToolCalls: 20,
    maxTasks: 5,
    maxRowsPerCall: config.sql.maxRows,
    maxBytesPerCall: 100_000,
    maxBytesPerRun: 1_000_000,
  });
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
  });
  const storeKeys: H['storeKeys'] = [];
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, fixtureEntity, key) {
      storeKeys.push({ kind, entity: fixtureEntity, key });
      if (opts.fixtureResult === undefined) return null;
      return {
        scope: 'shared',
        path: '/triage-test/fixtures/x.json',
        hash: '0123456789abcdef',
        fixture: { kind, result: opts.fixtureResult } as never,
      };
    },
    async list() {
      return [];
    },
  };
  const audit = createMemoryAuditSink();
  const sql = opts.sql ?? fakeSql();
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: CHAIN,
    connectors: { sql },
    runStore: {} as RunStore,
    budget,
    audit,
    fixtures: createMockLayer(config, { store }),
    now: () => FIXED_NOW,
  });
  const ctx = makeToolContext({ config, runId, entity, deps });
  return { ctx, tool: toolModule.create(ctx, 'investigator'), audit, sql, config, storeKeys };
}

type Written = { path: string; text: string };

async function call(h: H, data: unknown, harness?: StagingHarness): Promise<ToolEnvelope> {
  const parsed = v.safeParse(h.tool.input as v.GenericSchema, data);
  if (!parsed.success) throw new Error(`input does not match the schema: ${parsed.issues.map((i) => i.message).join('; ')}`);
  const run = h.tool.run as (c: unknown) => Promise<unknown>;
  const out = await run({
    data: parsed.output,
    toolCallId: 'toolu_sql_1',
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...(harness !== undefined ? { harness } : {}),
  });
  return v.parse(ToolEnvelopeSchema, out);
}

function fakeHarness(): { harness: StagingHarness; written: Written[] } {
  const written: Written[] = [];
  return {
    written,
    harness: {
      sandbox: {
        async writeFile(path: string, content: string | Uint8Array) {
          written.push({ path, text: String(content) });
        },
      },
    },
  };
}

const REAL = { TRIAGE_MOCK_MODE: 'false' };

type Data = { service: string; rows: Row[]; row_count: number; truncated: boolean; columns?: string[]; staged_file?: string };
const dataOf = (env: ToolEnvelope): Data => env.output.data as Data;

// ------------------------------------------------------------------ schema

describe('sql_select: schema', () => {
  const entries = (tool: ToolDefinition): Record<string, unknown> =>
    (tool.input as unknown as { entries: Record<string, unknown> }).entries;
  const picklist = (tool: ToolDefinition): string[] => {
    const service = entries(tool)['service'] as { options?: string[]; pipe?: { options?: string[] }[] };
    const options = service.options ?? service.pipe?.find((p) => Array.isArray(p.options))?.options;
    return [...(options ?? [])].sort();
  };

  test('the input has service, sql, params and scope only; no entity or run_id', () => {
    const ctx = makeToolContext({ entity: 'atspl' });
    const tool = toolModule.create(ctx, 'investigator');
    expect(Object.keys(entries(tool)).sort()).toEqual(['params', 'scope', 'service', 'sql']);
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
  });

  test('create() and enabled() never touch deps (the default fake deps throw on access)', () => {
    for (const { mount, entity } of conformanceCases(toolModule)) {
      const ctx = makeToolContext({ entity });
      expect(toolModule.enabled(ctx, mount)).toEqual({ on: true });
      expect(conformanceProblems(toolModule, toolModule.create(ctx, mount))).toEqual([]);
    }
  });

  test('the service picklist is the closure entity\'s DB services only', () => {
    for (const entity of ['ssfb', 'atspl', 'rtl'] as const) {
      const ctx = makeToolContext({ entity });
      const expected = ctx.registry
        .services(entity)
        .filter((s) => ctx.registry.service(entity, s).db !== undefined)
        .sort();
      expect(picklist(toolModule.create(ctx, 'investigator'))).toEqual(expected);
    }
    expect(picklist(toolModule.create(makeToolContext({ entity: 'atspl' }), 'investigator'))).toEqual(['package', 'pulse']);
    const ssfb = picklist(toolModule.create(makeToolContext({ entity: 'ssfb' }), 'investigator'));
    expect(ssfb).toContain('harbor');
    expect(ssfb).not.toContain('package');
  });

  test('another entity\'s service and extra entity or run_id fields do not pass the schema', () => {
    const tool = toolModule.create(makeToolContext({ entity: 'atspl' }), 'investigator');
    const schema = tool.input as v.GenericSchema;
    expect(v.is(schema, { service: 'harbor', sql: 'SELECT 1' })).toBe(false);
    expect(v.is(schema, { service: 'package', sql: 'SELECT 1', scope: 'wide' })).toBe(false);
    expect(v.is(schema, { service: 'package', sql: 'SELECT 1', params: [{ a: 1 }] })).toBe(false);
    // valibot's object() drops unknown keys, so an entity sent by the model never reaches run().
    const parsed = v.parse(schema, { service: 'package', sql: 'SELECT 1', entity: 'ssfb', run_id: 'run_x' });
    expect(parsed).toEqual({ service: 'package', sql: 'SELECT 1' });
  });

  test('mounted for investigators (and deep), not for triage or code_walker', () => {
    expect(toolModule.mounts).toEqual(['investigator']);
    expect(toolModule.enabled(makeToolContext({ entity: null }), 'triage')).toEqual({
      on: false,
      reason: 'sql_select needs an entity',
    });
    const deep = toolsFor('investigator_deep', makeToolContext({ entity: 'atspl' }));
    expect(deep.map((t) => t.name)).toContain('sql_select');
    const triage = toolsFor('triage', makeToolContext({ entity: null }));
    expect(triage.map((t) => t.name)).not.toContain('sql_select');
  });

  test('declared as a harness tool so it can stage rows', () => {
    const tool = toolModule.create(makeToolContext({ entity: 'atspl' }), 'investigator');
    expect((tool as { harness?: boolean }).harness).toBe(true);
  });
});

// ------------------------------------------------------------------ SQL gate denies

describe('sql_select: non-SELECT forms are refused before any I/O', () => {
  const cases: [string, string, unknown[]][] = [
    ['UPDATE', "UPDATE delivery_requests SET status = 'RETRY' WHERE id = $1", [CUSTOMER]],
    ['INSERT', 'INSERT INTO delivery_requests (id) VALUES ($1)', [CUSTOMER]],
    ['DELETE', 'DELETE FROM delivery_requests WHERE id = $1', [CUSTOMER]],
    ['two statements', 'SELECT 1; SELECT 2', []],
    ['SET', 'SET statement_timeout = 0', []],
    ['RESET', 'RESET statement_timeout', []],
    ['SHOW', 'SHOW statement_timeout', []],
    ['data-modifying CTE', 'WITH d AS (DELETE FROM delivery_requests WHERE id = $1 RETURNING id) SELECT * FROM d', [CUSTOMER]],
  ];

  for (const mode of ['real', 'mock'] as const) {
    for (const [name, sql, params] of cases) {
      test(`${name} (${mode} mode)`, async () => {
        const h = setup({ env: mode === 'real' ? REAL : {} });
        const env = await call(h, { service: 'package', sql, params });
        expect(env.output.status).toBe('refused');
        expect(env.output.message).toStartWith('Refused: only SELECT is allowed');
        expect(env.output.message).toContain('recommend it under actions in the report');
        expect(h.sql.calls).toHaveLength(0);
        expect(h.storeKeys).toHaveLength(0);
        expect(h.audit.lines).toHaveLength(1);
        const line = h.audit.lines[0]!;
        expect(line.decision).toBe('deny');
        expect(line.tool).toBe('sql_select');
        expect(line.entity).toBe('atspl');
        expect(line.target).toBe('ATSPL_PACKAGE_DB_URL');
        expect(line.transport).toBe(mode);
        expect(line.reason).toStartWith('sql: ');
      });
    }
  }

  test('other gate refusals pass the gate text on and still skip I/O', async () => {
    const h = setup({ env: REAL });
    const env = await call(h, { service: 'package', sql: 'SELECT * FROM pg_catalog.pg_user' });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toStartWith('Refused: system catalogs');
    expect(h.sql.calls).toHaveLength(0);
    expect(h.audit.lines.map((l) => l.decision)).toEqual(['deny']);
  });

  test('a $n count that does not match params is refused', async () => {
    const h = setup({ env: REAL });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [] });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('uses 1 parameter(s)');
    const extra = await call(h, { service: 'package', sql: 'SELECT 1', params: [CUSTOMER] });
    expect(extra.output.status).toBe('refused');
    expect(h.sql.calls).toHaveLength(0);
    expect(h.audit.lines.map((l) => l.decision)).toEqual(['deny', 'deny']);
  });
});

// ------------------------------------------------------------------ scope

describe('sql_select: scope', () => {
  test('a param that is not in the IdChain is denied', async () => {
    const h = setup({ env: REAL });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [STRANGER] });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain("not in the run's ID chain");
    expect(env.output.message).not.toContain(STRANGER);
    expect(h.sql.calls).toHaveLength(0);
    const line = h.audit.lines[0]!;
    expect(line.decision).toBe('deny');
    expect(line.reason).toStartWith('scope:');
    expect(JSON.stringify(h.audit.lines)).not.toContain(STRANGER);
  });

  test('an out-of-scope id written as a literal in the SQL is denied too', async () => {
    const h = setup({ env: REAL });
    const env = await call(h, {
      service: 'package',
      sql: `SELECT id FROM delivery_requests WHERE external_ref_id = '${STRANGER}'`,
    });
    expect(env.output.status).toBe('refused');
    expect(h.sql.calls).toHaveLength(0);
  });

  test("systemic with a non-aggregate select list is denied", async () => {
    const h = setup({ env: REAL });
    const env = await call(h, {
      service: 'package',
      sql: 'SELECT id, status FROM delivery_requests WHERE external_ref_id = $1',
      params: [STRANGER],
      scope: 'systemic',
    });
    expect(env.output.status).toBe('refused');
    expect(h.sql.calls).toHaveLength(0);
    expect(h.audit.lines[0]!.reason).toContain('aggregate-only');
  });

  test('the same aggregate query is denied without systemic and allowed with it', async () => {
    const sql = 'SELECT status, count(*) AS n FROM delivery_requests WHERE external_ref_id = $1 GROUP BY status';
    const denied = setup({ env: REAL });
    const env1 = await call(denied, { service: 'package', sql, params: [STRANGER] });
    expect(env1.output.status).toBe('refused');
    expect(denied.sql.calls).toHaveLength(0);

    const allowed = setup({ env: REAL, sql: fakeSql([{ status: 'PENDING', n: 4 }]) });
    const env2 = await call(allowed, { service: 'package', sql, params: [STRANGER], scope: 'systemic' });
    expect(env2.output.status).toBe('ok');
    expect(dataOf(env2).rows).toEqual([{ status: 'PENDING', n: 4 }]);
    expect(allowed.sql.calls).toHaveLength(1);
    expect(allowed.audit.lines[0]!.decision).toBe('allow');
    expect(allowed.audit.lines[0]!.summary_redacted).toContain('systemic');
  });
});

// ------------------------------------------------------------------ not configured

describe('sql_select: not configured', () => {
  for (const mode of ['real', 'mock'] as const) {
    test(`a blank ATSPL_PACKAGE_DB_URL answers not configured (${mode} mode)`, async () => {
      const h = setup({ env: { ATSPL_PACKAGE_DB_URL: '', ...(mode === 'real' ? REAL : {}) }, fixtureResult: { rows: [] } });
      const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
      expect(env.output.status).toBe('not_configured');
      expect(env.output.message).toBe('not configured for atspl:package');
      expect(h.sql.calls).toHaveLength(0);
      expect(h.storeKeys).toHaveLength(0);
      const line = h.audit.lines[0]!;
      expect(line.decision).toBe('deny');
      expect(line.exit).toBe('not_configured');
      expect(line.target).toBe('ATSPL_PACKAGE_DB_URL');
    });
  }

  test('a run without an sql connector answers not configured in real mode', async () => {
    const h = setup({ env: REAL });
    const noConnector = { ...h.ctx, deps: Object.freeze({ ...h.ctx.deps, connectors: {} }) } as ToolContext;
    const tool = toolModule.create(noConnector, 'investigator');
    const env = await call({ ...h, tool }, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    expect(env.output.status).toBe('not_configured');
    expect(env.output.message).toBe('not configured for atspl:package');
  });
});

// ------------------------------------------------------------------ mock hit

describe('sql_select: mock mode', () => {
  test('a fixture hit returns its rows with row_count and taken_at, and never calls the connector', async () => {
    const rows = [row(1), row(2)];
    const h = setup({ fixtureResult: { rows, columns: ['id', 'status', 'account_number', 'pan'] } });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    expect(env.output.status).toBe('ok');
    expect(env.output.taken_at).toBe(FIXED_NOW.toISOString());
    const data = dataOf(env);
    expect(data.row_count).toBe(2);
    expect(data.rows.map((r) => r['id'])).toEqual(['row-1', 'row-2']);
    expect(data.truncated).toBe(false);
    expect(h.sql.calls).toHaveLength(0);
    const line = h.audit.lines[0]!;
    expect(line.decision).toBe('allow');
    expect(line.transport).toBe('mock');
  });

  test('the fixture is keyed by entity, service, tables and sorted params', async () => {
    const h = setup({ fixtureResult: { rows: [] } });
    const sql = 'SELECT d.id FROM delivery_requests d JOIN vendors v ON v.id = d.vendor_id WHERE d.external_ref_id = $2 AND d.status = $1';
    await call(h, { service: 'package', sql, params: ['PENDING', CUSTOMER] });
    expect(h.storeKeys).toHaveLength(1);
    const got = h.storeKeys[0]!;
    expect(got.kind).toBe('sql_select');
    expect(got.entity).toBe('atspl');
    const expected = semanticKey('sql_select', {
      entity: 'atspl',
      service: 'package',
      tables: ['vendors', 'delivery_requests'],
      params: [CUSTOMER, 'PENDING'],
    });
    expect(keyString(got.key as never)).toBe(keyString(expected));
  });

  test('rows beyond TRIAGE_SQL_MAX_ROWS are cut and truncated is true', async () => {
    const rows = [row(1), row(2), row(3), row(4), row(5)];
    const h = setup({ fixtureResult: { rows } });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    const data = dataOf(env);
    expect(h.config.sql.maxRows).toBe(3);
    expect(data.rows).toHaveLength(3);
    expect(data.row_count).toBe(3);
    expect(data.truncated).toBe(true);
  });

  test('a strict fixture miss is a loud error', async () => {
    const h = setup({ env: { TRIAGE_MOCK_STRICT: 'true' } });
    await expect(call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] })).rejects.toBeInstanceOf(FixtureMissError);
  });

  test('a non-strict miss is refused as no data', async () => {
    const h = setup({ env: { TRIAGE_MOCK_STRICT: 'false' } });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('No sql_select fixture');
  });
});

// ------------------------------------------------------------------ real mode

describe('sql_select: real mode', () => {
  test('runs the read-only plan with bound params and the cap as the last $n', async () => {
    const h = setup({ env: REAL });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    expect(env.output.status).toBe('ok');
    expect(h.sql.calls).toHaveLength(1);
    const input = h.sql.calls[0]!;
    expect(input.entity).toBe('atspl');
    expect(input.service).toBe('package');
    expect(input.plan).toHaveLength(5);
    expect(input.plan[0]).toBe('BEGIN READ ONLY');
    expect(input.plan[1]).toBe(`SET LOCAL statement_timeout = ${h.config.sql.statementTimeoutMs}`);
    expect(input.plan[2]).toBe(`SET LOCAL lock_timeout = ${h.config.sql.lockTimeoutMs}`);
    expect(input.plan[3]).toStartWith('SELECT * FROM (');
    expect(input.plan[3]).toEndWith(') _capped LIMIT $2');
    expect(input.plan[4]).toBe('COMMIT');
    // One more row than the cap, to tell a cut result apart.
    expect(input.params).toEqual([CUSTOMER, 4]);
    expect(input.keyInput).toEqual({ entity: 'atspl', service: 'package', tables: ['delivery_requests'], params: [CUSTOMER] });
    expect(h.audit.lines[0]!.transport).toBe('real');
  });

  test('a real result over the cap is cut and marked truncated', async () => {
    const h = setup({ env: REAL, sql: fakeSql([row(1), row(2), row(3), row(4)]) });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    const data = dataOf(env);
    expect(data.rows).toHaveLength(3);
    expect(data.truncated).toBe(true);
  });

  test('full rows are staged to /data; the model gets the capped rows and the path', async () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const h = setup({ env: REAL, sql: fakeSql(rows) });
    const { harness, written } = fakeHarness();
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] }, harness);
    expect(written).toHaveLength(1);
    expect(written[0]!.path).toBe('/data/toolu_sql_1.json');
    const staged = JSON.parse(written[0]!.text) as { rows: Row[] };
    expect(staged.rows).toHaveLength(4);
    expect(written[0]!.text).not.toContain(PAN);
    expect(dataOf(env).staged_file).toBe('/data/toolu_sql_1.json');
    expect(dataOf(env).rows).toHaveLength(3);
  });

  test('a connector refusal comes back as refused without the connector message', async () => {
    const fail = new ConnectorError('refused', `atspl:package: query failed (42P01): ${FAKE_DSN}`);
    const h = setup({ env: REAL, sql: fakeSql([], { fail }) });
    const env = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    expect(env.output.status).toBe('refused');
    expect(JSON.stringify(env)).not.toContain('Sup3rS3cretPw');
    expect(JSON.stringify(h.audit.lines)).not.toContain('Sup3rS3cretPw');
  });
});

// ------------------------------------------------------------------ redaction and audit

describe('sql_select: redaction and audit', () => {
  test('row values pass the model-facing profile: a PAN is masked, an account number is kept', async () => {
    for (const env of [REAL, {}]) {
      const h = setup({ env, sql: fakeSql([row(1)]), fixtureResult: { rows: [row(1)] } });
      const out = await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
      const text = JSON.stringify(out);
      expect(text).not.toContain(PAN);
      expect(dataOf(out).rows[0]!['account_number']).toBe(ACCOUNT_NO);
      expect(dataOf(out).rows[0]!['id']).toBe('row-1');
    }
  });

  test('the audit target is the env var name, never the DSN', async () => {
    const h = setup({ env: REAL });
    await call(h, { service: 'package', sql: SELECT_ONE, params: [CUSTOMER] });
    await call(h, { service: 'package', sql: 'DELETE FROM delivery_requests' });
    expect(h.audit.lines).toHaveLength(2);
    for (const line of h.audit.lines) {
      expect(line.target).toBe('ATSPL_PACKAGE_DB_URL');
      expect(line.service).toBe('package');
    }
    const text = JSON.stringify(h.audit.lines);
    for (const part of [FAKE_DSN, 'Sup3rS3cretPw', 'package-db.internal.example', 'triage_ro:']) {
      expect(text).not.toContain(part);
    }
  });

  test('another entity uses its own env var name', async () => {
    const h = setup({ env: { ...REAL, SSFB_HARBOR_DB_URL: FAKE_DSN }, entity: 'ssfb' });
    await call(h, { service: 'harbor', sql: 'SELECT id FROM customer WHERE id = $1', params: [CUSTOMER] });
    expect(h.audit.lines[0]!.target).toBe('SSFB_HARBOR_DB_URL');
    expect(h.audit.lines[0]!.entity).toBe('ssfb');
  });
});

describe('sql_select: description', () => {
  test('tells the model the rules: one SELECT, $n params, the row cap, Refused, not configured and writes', () => {
    const ctx = makeToolContext({ entity: 'atspl', env: { TRIAGE_SQL_MAX_ROWS: '150' } });
    const text = toolModule.create(ctx, 'investigator').description;
    expect(text).toContain('exactly one SELECT');
    expect(text).toContain('$1, $2');
    expect(text).toContain('At most 150 rows');
    expect(text).toContain('"Refused: ..."');
    expect(text).toContain('"not configured for <entity>:<service>"');
    expect(text).toContain('recommend it under actions in the report');
  });
});
