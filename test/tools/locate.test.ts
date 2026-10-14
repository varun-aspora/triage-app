import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import type { Config } from '../../src/config/env.ts';
import type { Registry } from '../../src/config/registry.ts';
import { logsKeyInput } from '../../src/connectors/quickwit/client.ts';
import { type RunSelectInput, type SqlConnector, type SqlSelectOutcome, SqlStateError } from '../../src/connectors/sql/pg-client.ts';
import { ConnectorError, envVarName } from '../../src/connectors/types.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import { buildLogsQuery, quickwitGateConfig } from '../../src/gate/quickwit.ts';
import { releaseObservedIds } from '../../src/gate/scope.ts';
import { FixtureMissError } from '../../src/mock/errors.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyString, semanticKey } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import { releaseActions } from '../../src/runlog/actions.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps } from '../../src/tools/_lib/context.ts';
import type { StagingHarness } from '../../src/tools/_lib/pipeline.ts';
import { CATALOGUE_SQL, CATALOGUE_TABLES, countSql } from '../../src/tools/_lib/schema-catalogue.ts';
import { toolsFor } from '../../src/tools/index.ts';
import { LOCATE, locateProbesUsed, releaseLocateState, runLocate, toolModule } from '../../src/tools/locate.tool.ts';
import type { Mount, ToolContext } from '../../src/tools/types.ts';
import type { Entity } from '../../src/types/core.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

// ------------------------------------------------------------------ fixtures

const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const FIXED_NOW = new Date('2026-09-24T10:00:00.000Z');
const CHAIN: IdChain = { ids: { aspora_user_id: CUSTOMER }, hops: [], basic_state: [] };

// Two entities keep the tests small; RTL logs get an http transport so they are configured.
const BASE_ENV: Record<string, string> = {
  TRIAGE_ENTITIES: 'ssfb,rtl',
  TRIAGE_MOCK_STRICT: 'false',
  RTL_QUICKWIT_TRANSPORT: 'http',
  RTL_QUICKWIT_INDEX: 'app-logs',
  RTL_QUICKWIT_URL: 'http://quickwit.invalid:7280',
  RTL_QUICKWIT_AUTH: 'none',
};

type Row = Record<string, unknown>;
const catRow = (table: string, column: string, type: string, indexed = false, schema = 'public'): Row => ({
  table_schema: schema,
  table_name: table,
  column_name: column,
  data_type: type,
  indexed,
});

const catalogueKey = (entity: Entity, service: string) =>
  semanticKey('sql_select', { entity, service, tables: [...CATALOGUE_TABLES], params: [] });
const probeKey = (entity: Entity, service: string, column: string, value = CUSTOMER) =>
  semanticKey('sql_select', { entity, service, tables: [column], params: [value] });

function logsKey(registry: Registry, entity: Entity, value = CUSTOMER) {
  const cfg = quickwitGateConfig(registry, entity);
  if (cfg === undefined) throw new Error(`${entity} logs are not configured in the test env`);
  const input = { terms: [value], group_by: ['service'] };
  const q = buildLogsQuery(cfg, input);
  if (!q.ok) throw new Error(q.reason);
  return semanticKey('logs_search', logsKeyInput(cfg, input, q.mode, q.groupBy));
}

// ------------------------------------------------------------------ harness

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let runSeq = 0;

type FakeSql = SqlConnector & { calls: RunSelectInput[] };

/** A SQL connector for real-mode tests: catalogue rows for the catalogue plan, a count or an error per probe. */
function fakeSql(catalogue: Record<string, Row[]>, counts: Record<string, number | Error>): FakeSql {
  const calls: RunSelectInput[] = [];
  const unused = (): never => {
    throw new Error('not used by locate');
  };
  const answer = (rows: Row[]): SqlSelectOutcome => ({
    data: { rows, row_count: rows.length, columns: Object.keys(rows[0] ?? {}) },
    transport: 'real',
    target_env: envVarName('RTL_WORKFLOW_DB_URL'),
    taken_at: FIXED_NOW.toISOString(),
    duration_ms: 1,
  });
  return {
    calls,
    async runSelect(_ctx, input) {
      calls.push(input);
      const data = input.plan[3] as string;
      if (data === CATALOGUE_SQL) return answer(catalogue[`${input.entity}:${input.service}`] ?? []);
      const count = counts[`${input.entity}:${input.service}:${input.keyInput.tables[0]}`] ?? 0;
      if (count instanceof Error) throw count;
      return answer([{ count: String(count) }]);
    },
    checkReadOnlyRole: unused,
    enforceRolePolicy: unused,
    close: async () => {},
  };
}

type Setup = {
  readonly env?: Record<string, string>;
  readonly fixtures?: readonly (readonly [unknown, unknown])[];
  readonly sql?: FakeSql;
  readonly entity?: Entity | null;
  readonly mount?: Mount;
  readonly registry?: (r: Registry) => Registry;
  readonly chain?: IdChain;
};

type H = {
  readonly ctx: ToolContext;
  readonly tool: ToolDefinition;
  readonly audit: MemoryAuditSink;
  readonly config: Config;
  readonly registry: Registry;
  readonly lookups: { kind: string; entity: string; key: string }[];
};

function setup(opts: Setup = {}): H {
  runSeq += 1;
  const runId = `run_locate_${runSeq}_${Date.now().toString(36)}`;
  const config = makeTestConfig({ ...BASE_ENV, ...opts.env });
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
    releaseActions(runId);
    releaseObservedIds(runId);
    releaseLocateState(runId);
  });
  const base = makeToolContext({ config, runId }).registry;
  const registry = opts.registry?.(base) ?? base;
  const answers = new Map((opts.fixtures ?? []).map(([key, result]) => [keyString(key), result]));
  const lookups: H['lookups'] = [];
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, entity, key) {
      const k = keyString(key);
      lookups.push({ kind, entity, key: k });
      if (!answers.has(k)) return null;
      return { scope: 'shared', path: '/triage-test/fixtures/x.json', hash: '0123456789abcdef', fixture: { kind, result: answers.get(k) } as never };
    },
    async list() {
      return [];
    },
  };
  const audit = createMemoryAuditSink();
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: opts.chain ?? CHAIN,
    connectors: opts.sql !== undefined ? { sql: opts.sql } : {},
    runStore: {} as RunStore,
    budget,
    audit,
    fixtures: createMockLayer(config, { store }),
    now: () => FIXED_NOW,
  });
  const entity = opts.entity === undefined ? null : opts.entity;
  const ctx = makeToolContext({ config, runId, entity, deps, registry });
  const mount = opts.mount ?? (entity === null ? 'agent' : 'investigator');
  return { ctx, tool: toolModule.create(ctx, mount), audit, config, registry, lookups };
}

type Written = { path: string; text: string };

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

async function call(h: H, data: unknown, harness?: StagingHarness): Promise<ToolEnvelope> {
  const parsed = v.safeParse(h.tool.input as v.GenericSchema, data);
  if (!parsed.success) throw new Error(`input does not match the schema: ${parsed.issues.map((i) => i.message).join('; ')}`);
  const run = h.tool.run as (c: unknown) => Promise<unknown>;
  const out = await run({
    data: parsed.output,
    toolCallId: `toolu_locate_${runSeq}`,
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...(harness !== undefined ? { harness } : {}),
  });
  return v.parse(ToolEnvelopeSchema, out);
}

type Data = { ranked: string[]; hits: number; probes: number; probes_left: number; staged_file?: string; notes?: string[] };
const dataOf = (env: ToolEnvelope): Data => {
  expect(env.output.status).toBe('ok');
  return env.output.data as Data;
};

// The RTL workflow and SSFB guardian catalogues and answers most tests use.
function standardFixtures(registry: Registry): (readonly [unknown, unknown])[] {
  return [
    [
      catalogueKey('rtl', 'workflow'),
      {
        rows: [
          catRow('workflow_executions', 'reference_id', 'character varying', true),
          catRow('workflow_executions', 'status', 'text'),
          catRow('workflow_steps', 'external_ref', 'text'),
          catRow('workflow_definitions', 'owner_id', 'uuid', true),
        ],
      },
    ],
    [probeKey('rtl', 'workflow', 'public.workflow_executions.reference_id'), { rows: [{ count: '2' }] }],
    [probeKey('rtl', 'workflow', 'public.workflow_steps.external_ref'), { rows: [{ count: 0 }] }],
    [
      catalogueKey('ssfb', 'guardian'),
      {
        rows: [
          catRow('device_auth_attempts', 'user_id', 'uuid', true),
          catRow('refresh_tokens', 'user_id', 'uuid'),
          catRow('refresh_tokens', 'token', 'text'),
        ],
      },
    ],
    [
      logsKey(registry, 'rtl'),
      {
        groups: [
          { key: 'verification-service', count: 3328 },
          { key: 'workflow-op-service', count: 56 },
        ],
        num_hits: 3384,
        tally_base: 3384,
        window: { from: '2026-08-25T00:00:00.000Z', to: '2026-09-24T10:00:00.000Z' },
        truncated: false,
      },
    ],
    [logsKey(registry, 'ssfb'), { groups: [], num_hits: 0, tally_base: 0, window: { from: 'x', to: 'y' }, truncated: false }],
  ];
}

const registryFor = (env: Record<string, string> = {}): Registry =>
  makeToolContext({ config: makeTestConfig({ ...BASE_ENV, ...env }) }).registry;

function standard(opts: Omit<Setup, 'fixtures'> = {}): H {
  return setup({ ...opts, fixtures: standardFixtures(registryFor(opts.env)) });
}

// ------------------------------------------------------------------ tests

describe('locate in mock mode', () => {
  test('ranks hits first across logs and databases, then entities with nothing', async () => {
    const h = standard();
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.ranked.slice(0, 4)).toEqual([
      'rtl logs verification-service 3328',
      'rtl logs workflow-op-service 56',
      'rtl db workflow public.workflow_executions.reference_id 2',
      'ssfb: nothing (logs 0, 2 columns, 1 indexed)',
    ]);
    expect(data.hits).toBe(3);
    // Logs for two entities, rtl workflow owner_id is a config table (exempt), two rtl and two ssfb columns.
    expect(data.probes).toBe(6);
    expect(data.probes_left).toBe(h.config.discovery.locate.maxProbesPerRun - 6);
    expect(data.ranked.join('\n')).not.toContain('workflow_definitions');
  });

  test('a database with no catalogue fixture has no columns to probe; strict mode throws on the miss', async () => {
    const h = standard();
    await call(h, { value: CUSTOMER });
    expect(h.lookups.some((l) => l.key === keyString(catalogueKey('ssfb', 'harbor')))).toBe(true);
    expect(h.lookups.some((l) => l.key.includes('harbor') && l.key.includes('public.'))).toBe(false);

    const strict = standard({ env: { TRIAGE_MOCK_STRICT: 'true' } });
    await expect(call(strict, { value: CUSTOMER })).rejects.toBeInstanceOf(FixtureMissError);
    const lines = strict.audit.lines.filter((l) => l.tool === LOCATE);
    expect(lines.map((l) => l.exit)).toEqual(['fixture_miss']);
  });

  test('writes one audit line per call with the probe count, and stages the full result', async () => {
    const h = standard();
    const { harness, written } = fakeHarness();
    const data = dataOf(await call(h, { value: CUSTOMER }, harness));
    const lines = h.audit.lines.filter((l) => l.tool === LOCATE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ decision: 'allow', exit: 'ok', transport: 'mock', count: 6, target: 'TRIAGE_ENTITIES', entity: null });
    expect(lines[0]?.summary_redacted).not.toContain(CUSTOMER);
    expect(written).toHaveLength(1);
    expect(data.staged_file).toBe(written[0]?.path);
    const staged = JSON.parse(written[0]?.text ?? '{}') as { places: { status: string; column?: string }[] };
    expect(staged.places.find((p) => p.column === 'public.workflow_steps.external_ref')?.status).toBe('zero');
  });

  test('logs are counted per entity with one grouped query by service', async () => {
    const h = standard();
    await call(h, { value: CUSTOMER });
    const logs = h.lookups.filter((l) => l.kind === 'logs_search');
    expect(logs.map((l) => l.entity).sort()).toEqual(['rtl', 'ssfb']);
    for (const l of logs) expect(JSON.parse(l.key)).toMatchObject({ group_by: 'service', terms: [CUSTOMER] });
  });

  test('over the hit limit, logs report the total without a service split', async () => {
    const h = setup({
      fixtures: [[logsKey(registryFor(), 'rtl'), { num_hits: 12_000, window: { from: 'x', to: 'y' }, truncated: true, reason: 'over 5000 hits' }]],
    });
    const data = dataOf(await call(h, { value: CUSTOMER, entities: ['rtl'] }));
    expect(data.ranked[0]).toBe('rtl logs 12000 (over 5000 hits, not split by service)');
  });

  test('the same value again in the run is reused and costs no probes', async () => {
    const h = standard();
    const first = dataOf(await call(h, { value: CUSTOMER }));
    const again = await call(h, { value: CUSTOMER });
    expect(again.output.message).toContain('result reused');
    expect(locateProbesUsed(h.ctx.runId)).toBe(first.probes);
  });

  test('never adds leads: the chain is the same after a hit', async () => {
    const h = standard();
    const before = JSON.stringify(h.ctx.deps.idChain());
    await call(h, { value: CUSTOMER });
    expect(JSON.stringify(h.ctx.deps.idChain())).toBe(before);
  });
});

describe('scope and input', () => {
  test('a value not in the ID chain is refused by the scope gate, with no reads', async () => {
    const h = standard();
    const env = await call(h, { value: STRANGER });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain("not in the run's ID chain for locate");
    expect(env.output.message).toContain('usable once it is in the requester');
    expect(h.lookups).toEqual([]);
    expect(h.audit.lines.filter((l) => l.tool === LOCATE).map((l) => [l.decision, l.exit])).toEqual([['deny', 'refused']]);
    expect(locateProbesUsed(h.ctx.runId)).toBe(0);
  });

  test('a seed lead is in scope like a chain id', async () => {
    const h = standard({
      chain: { ids: {}, hops: [], basic_state: [], leads: [{ value: CUSTOMER, kind: 'uuid', source: 'thread', status: 'seed' }] },
    });
    expect((await call(h, { value: CUSTOMER })).output.status).toBe('ok');
  });

  test('anything but one whole id is refused before a read', async () => {
    const h = standard();
    for (const value of [`${CUSTOMER} OR 1=1`, 'workflow_executions', 'hello']) {
      const env = await call(h, { value });
      expect(env.output.status).toBe('refused');
      expect(env.output.message).toContain('exactly one id');
    }
    expect(h.lookups).toEqual([]);
  });

  test('the input takes a value (and entities on the agent mount) and nothing else', () => {
    const h = standard();
    const input = h.tool.input as v.GenericSchema;
    expect(v.safeParse(input, { value: CUSTOMER, table: 'users' }).success).toBe(false);
    expect(v.safeParse(input, { value: CUSTOMER, column: 'id' }).success).toBe(false);
    expect(v.safeParse(input, { value: CUSTOMER, entities: ['atspl'] }).success).toBe(false);
    expect(v.safeParse(input, { value: CUSTOMER, entities: ['rtl'] }).success).toBe(true);
  });
});

describe('identifiers come from the catalogue only (real mode, fake connector)', () => {
  test('each probe is the catalogue column, quoted, with the value bound as $1', async () => {
    const sql = fakeSql(
      {
        'rtl:workflow': [catRow('Odd"Table', 'reference_id', 'text', true), catRow('workflow_executions', 'reference_id', 'uuid')],
      },
      { 'rtl:workflow:public.Odd"Table.reference_id': 4 },
    );
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false' }, sql, entity: 'rtl' });
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.ranked[0]).toBe('rtl db workflow public.Odd"Table.reference_id 4');
    const probes = sql.calls.filter((c) => c.plan[3] !== CATALOGUE_SQL);
    expect(probes.map((c) => c.plan[3])).toEqual([
      countSql({ schema: 'public', table: 'Odd"Table', column: 'reference_id' }),
      countSql({ schema: 'public', table: 'workflow_executions', column: 'reference_id' }),
    ]);
    for (const c of sql.calls) {
      expect(c.plan[0]).toBe('BEGIN READ ONLY');
      expect(c.plan[4]).toBe('COMMIT');
    }
    for (const c of probes) {
      expect(c.params).toEqual([CUSTOMER]);
      expect(c.plan[1]).toBe(`SET LOCAL statement_timeout = ${h.config.discovery.locate.timeoutMs}`);
      expect(c.plan[3]).not.toContain(CUSTOMER);
    }
    expect(h.audit.lines.find((l) => l.tool === LOCATE)?.transport).toBe('real');
  });

  test('a probe that times out is reported for its place and the call goes on', async () => {
    const timeout = new SqlStateError('timeout', 'rtl:workflow: canceling statement due to statement timeout', '57014', 'timeout');
    const sql = fakeSql(
      { 'rtl:workflow': [catRow('a', 'user_id', 'uuid', true), catRow('b', 'user_id', 'uuid', true)] },
      { 'rtl:workflow:public.a.user_id': timeout, 'rtl:workflow:public.b.user_id': 7 },
    );
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false', TRIAGE_LOCATE_TIMEOUT_MS: '1500' }, sql, entity: 'rtl' });
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.ranked).toContain('rtl db workflow public.b.user_id 7');
    expect(data.ranked).toContain('rtl db workflow public.a.user_id: timed out after 1500 ms');
    expect(data.probes).toBe(2);
  });

  test('a result with a failed place is not kept, so the same call probes again', async () => {
    const timeout = new SqlStateError('timeout', 'rtl:workflow: canceling statement due to statement timeout', '57014', 'timeout');
    const sql = fakeSql({ 'rtl:workflow': [catRow('a', 'user_id', 'uuid', true)] }, { 'rtl:workflow:public.a.user_id': timeout });
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false' }, sql, entity: 'rtl' });
    await call(h, { value: CUSTOMER });
    const again = await call(h, { value: CUSTOMER });
    expect(again.output.message ?? '').not.toContain('result reused');
    expect(sql.calls.filter((c) => c.plan[3] !== CATALOGUE_SQL)).toHaveLength(2);
  });

  test('a connector failure gives its scrubbed reason; a SQL error gives only its SQLSTATE name', async () => {
    const refused = new ConnectorError('refused', 'rtl:workflow: the plan was refused at postgres://user:pw@db.internal:5432/x');
    const server = new SqlStateError('refused', 'rtl:workflow: invalid input syntax: "secret-row-value"', '22P02', 'query');
    const sql = fakeSql(
      { 'rtl:workflow': [catRow('a', 'user_id', 'uuid', true), catRow('b', 'user_id', 'uuid', true)] },
      { 'rtl:workflow:public.a.user_id': refused, 'rtl:workflow:public.b.user_id': server },
    );
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false' }, sql, entity: 'rtl' });
    const text = dataOf(await call(h, { value: CUSTOMER })).ranked.join('\n');
    expect(text).toContain('rtl db workflow public.a.user_id: failed (refused: the plan was refused at');
    expect(text).not.toContain('pw@');
    expect(text).toContain('public.b.user_id: failed (SQLSTATE 22P02');
    expect(text).not.toContain('secret-row-value');
  });

  test('a database that stops answering has its other probes skipped and given back', async () => {
    const down = new SqlStateError('unreachable', 'rtl:workflow: connection refused', '08006', 'unavailable');
    const sql = fakeSql(
      { 'rtl:workflow': [catRow('a', 'user_id', 'uuid', true), catRow('b', 'user_id', 'uuid'), catRow('c', 'user_id', 'uuid')] },
      { 'rtl:workflow:public.a.user_id': down },
    );
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false' }, sql, entity: 'rtl' });
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.ranked).toContain('rtl db workflow: 2 columns not probed (its database did not answer)');
    expect(sql.calls.filter((c) => c.plan[3] !== CATALOGUE_SQL)).toHaveLength(1);
    expect(locateProbesUsed(h.ctx.runId)).toBe(1);
  });

  test('the catalogue is read once per run and database', async () => {
    const other = 'c0ffee00-2222-4222-8333-444455556666';
    const sql = fakeSql({ 'rtl:workflow': [catRow('a', 'user_id', 'uuid', true)] }, {});
    const h = setup({
      env: { TRIAGE_MOCK_MODE: 'false' },
      sql,
      entity: 'rtl',
      chain: { ids: { aspora_user_id: CUSTOMER, customer_id: other }, hops: [], basic_state: [] },
    });
    await call(h, { value: CUSTOMER });
    await call(h, { value: other });
    expect(sql.calls.filter((c) => c.plan[3] === CATALOGUE_SQL && c.service === 'workflow')).toHaveLength(1);
    expect(sql.calls.filter((c) => c.plan[3] !== CATALOGUE_SQL).map((c) => c.params)).toEqual([[CUSTOMER], [other]]);
  });
});

describe('exclusions', () => {
  const withLocate = (r: Registry): Registry => ({
    ...r,
    spec: (e: Entity) => (e === 'rtl' ? { ...r.spec(e), locate: { exclude_tables: ['workflow_steps'], exclude_services: ['banking'] } } : r.spec(e)),
  });

  test('excluded tables, exempt config tables and excluded services are skipped and said so', async () => {
    const h = standard({ registry: withLocate, entity: 'rtl' });
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.ranked).toContain('rtl db banking: excluded by the locate config');
    expect(data.ranked).toContain('rtl db workflow: 2 columns skipped (excluded or config tables)');
    expect(h.lookups.some((l) => l.key.includes('workflow_steps'))).toBe(false);
    expect(h.lookups.some((l) => l.key.includes('workflow_definitions'))).toBe(false);
    expect(h.lookups.some((l) => JSON.parse(l.key).service === 'banking')).toBe(false);
  });
});

describe('the probe budget', () => {
  test('past the budget the remaining places are listed as not probed, and a spent budget reads nothing', async () => {
    const h = standard({ env: { TRIAGE_LOCATE_MAX_PROBES_PER_RUN: '4' } });
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.probes).toBe(4);
    expect(data.probes_left).toBe(0);
    // Logs for both entities first, then one indexed column per database.
    expect(data.ranked).toContain('rtl db workflow public.workflow_executions.reference_id 2');
    expect(data.ranked).toContain('rtl db workflow: 1 column not probed (probe budget)');
    expect(data.ranked).toContain('ssfb db guardian: 1 column not probed (probe budget)');

    const before = h.lookups.length;
    const other = await call(h, { value: CUSTOMER.toUpperCase() });
    const spent = dataOf(other);
    expect(spent.probes).toBe(0);
    expect(spent.ranked).toContain('rtl logs: not probed (probe budget)');
    expect(spent.ranked).toContain('ssfb db guardian: not probed (probe budget)');
    expect(h.lookups.length).toBe(before);
  });
});

describe('the stuck count (P6)', () => {
  test("the model's refused and empty calls add to it and a hit resets it; runLocate does not add", async () => {
    const h = standard({ env: { TRIAGE_STUCK_AFTER: '2' } });
    expect((await call(h, { value: STRANGER })).output.message).not.toContain('calls in a row');
    // Had the scout's refusal counted, this would be the third in a row and carry no note.
    await runLocate(h.ctx, { value: STRANGER }, { toolCallId: 'toolu_scout', log: { warn: () => {} } });
    expect((await call(h, { value: 'hello' })).output.message).toContain('2 calls in a row were refused or found nothing');

    // Three in a row, then a hit: without the reset the next refusal would be the fourth and carry the note.
    await call(h, { value: STRANGER });
    expect((await call(h, { value: CUSTOMER })).output.status).toBe('ok');
    expect((await call(h, { value: STRANGER })).output.message).not.toContain('calls in a row');
  });

  test('a call with no hit anywhere counts as found nothing', async () => {
    const h = standard({ env: { TRIAGE_STUCK_AFTER: '2' } });
    await call(h, { value: STRANGER });
    const env = await call(h, { value: CUSTOMER, entities: ['ssfb'] });
    expect(env.output.status).toBe('ok');
    expect(env.output.message).toContain('2 calls in a row');
  });
});

describe('mounts', () => {
  test('a split investigator searches only its own entity and has no entities input', async () => {
    const h = standard({ entity: 'rtl' });
    const input = h.tool.input as v.GenericSchema & { entries: Record<string, unknown> };
    expect(Object.keys(input.entries)).toEqual(['value']);
    const data = dataOf(await call(h, { value: CUSTOMER }));
    expect(data.ranked.some((l) => l.startsWith('ssfb'))).toBe(false);
    expect(new Set(h.lookups.map((l) => l.entity))).toEqual(new Set(['rtl']));
    expect(h.audit.lines.find((l) => l.tool === LOCATE)?.entity).toBe('rtl');
  });

  test('the agent mount narrows to the entities asked for', async () => {
    const h = standard();
    const data = dataOf(await call(h, { value: CUSTOMER, entities: ['ssfb'] }));
    expect(data.ranked[0]).toBe('ssfb: nothing (logs 0, 2 columns, 1 indexed)');
    expect(data.ranked.some((l) => l.startsWith('rtl'))).toBe(false);
    expect(new Set(h.lookups.map((l) => l.entity))).toEqual(new Set(['ssfb']));
  });

  test('mounted once on the agent and on each investigator, never on the split root', () => {
    const config = makeTestConfig(BASE_ENV);
    const names = (mount: Mount, entity: Entity | null): string[] => toolsFor(mount, makeToolContext({ config, entity })).map((t) => t.name);
    expect(names('agent', null).filter((n) => n === LOCATE)).toHaveLength(1);
    expect(names('investigator', 'rtl')).toContain(LOCATE);
    expect(names('investigator_deep', 'ssfb')).toContain(LOCATE);
    expect(names('triage', null)).not.toContain(LOCATE);
  });
});
