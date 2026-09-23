import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { escalationFor, releaseEscalation } from '../../src/agents/escalation.ts';
import type { Config } from '../../src/config/env.ts';
import type { RunSelectInput, SqlConnector, SqlSelectOutcome } from '../../src/connectors/sql/pg-client.ts';
import { ConnectorError, envVarName } from '../../src/connectors/types.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { serializeAuditLine } from '../../src/gate/audit.ts';
import { createRunBudget, releaseRunBudget, type RunBudget } from '../../src/gate/budget.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyString, semanticKey } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps } from '../../src/tools/_lib/context.ts';
import { allToolNames, conformanceCases, conformanceProblems, toolsFor } from '../../src/tools/index.ts';
import { RESOLVE_IDENTITY, type SeedResult, toolModule } from '../../src/tools/resolve-identity.tool.ts';
import { toolModule as sqlSelectModule } from '../../src/tools/sql-select.tool.ts';
import type { ToolDeps } from '../../src/tools/types.ts';
import { KNOWN_ID_KEYS } from '../../src/types/core.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';

// ------------------------------------------------------------------ fixtures

const NOW = new Date('2026-09-24T11:00:00.000Z');

// Made-up DSNs. The .invalid host never resolves and nothing here dials.
const FAKE_PASSWORD = 'resolveid-fakepw-4242';
const FAKE_HOST = 'resolveid-fake-db.invalid';
const dsn = (db: string): string => ['postgres://triage_fake:', FAKE_PASSWORD, '@', FAKE_HOST, ':6543/', db].join('');
const DSNS = {
  SSFB_HARBOR_DB_URL: dsn('harbor_fake'),
  SSFB_RHYTHM_DB_URL: dsn('rhythm_fake'),
  SSFB_WORKFLOW_DB_URL: dsn('workflow_fake'),
  SSFB_GUARDIAN_DB_URL: dsn('guardian_fake'),
  RTL_WORKFLOW_DB_URL: dsn('rtl_workflow_fake'),
};
const IDENTITY_ENVS = Object.keys(DSNS);

// Synthetic ids. UUIDs so the scope rule treats them as ids.
const CUST = 'c0ffee00-1111-4222-8333-444455556666';
const FORM = 'f0f0f0f0-2222-4333-8444-555566667777';
const FORM2 = 'f1f1f1f1-2222-4333-8444-555566667777';
const USER = 'a1a1a1a1-3333-4444-8555-666677778888';
const DEVICE = 'dddddddd-4444-4555-8666-777788889999';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const STRANGER_FORM = 'beefbeef-8888-4777-8666-555544443333';
const STRANGER_CUST = 'cafecafe-7777-4666-8555-444433332222';

const BASE_CHAIN: IdChain = { ids: { customer_id: CUST }, hops: [], basic_state: [] };

const keyFor = (hop: string, key: string, value: string): string =>
  keyString(semanticKey('resolve_identity', { hop, ids: [[key, value]] } as never));
const fx = (hop: string, key: string, value: string, rows: Record<string, unknown>[]): [string, unknown] => [
  keyFor(hop, key, value),
  { rows },
];

/** Fixtures for FORM: the form belongs to USER and to the chain's customer CUST. */
const FORM_FIXTURES = Object.fromEntries([
  fx('account_form_id', 'account_form_id', FORM, [{ form_id: FORM, external_user_ref: USER }]),
  fx('account_form_id.customer', 'account_form_id', FORM, [{ customer_id: CUST, account_form_id: FORM }]),
  fx('state.account_form', 'account_form_id', FORM, [{ status_v2: 'SUBMITTED' }]),
]);

/** Fixtures for STRANGER: a user whose form and customer are not the run's. */
const STRANGER_FIXTURES = Object.fromEntries([
  fx('user_id', 'user_id', STRANGER, [{ form_id: STRANGER_FORM, external_user_ref: STRANGER }]),
  fx('account_form_id', 'account_form_id', STRANGER_FORM, [{ form_id: STRANGER_FORM, external_user_ref: STRANGER }]),
  fx('account_form_id.customer', 'account_form_id', STRANGER_FORM, [
    { customer_id: STRANGER_CUST, account_form_id: STRANGER_FORM },
  ]),
  fx('state.harbor_customer', 'customer_id', STRANGER_CUST, [{ state: 'ONBOARDED', sub_state: 'NONE' }]),
]);

const SQL_BY_FORM = 'SELECT form_id, status_v2 FROM account_forms WHERE form_id = $1';

// ------------------------------------------------------------------ harness

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let runSeq = 0;

type FakeSql = SqlConnector & { calls: RunSelectInput[] };

function fakeSql(fail?: ConnectorError): FakeSql {
  const calls: RunSelectInput[] = [];
  const unused = (): never => {
    throw new Error('not used here');
  };
  return {
    calls,
    async runSelect(ctx, input): Promise<SqlSelectOutcome> {
      calls.push(input);
      if (fail !== undefined) throw fail;
      return {
        data: { rows: [], row_count: 0, columns: [] },
        transport: 'real',
        target_env: envVarName('SSFB_HARBOR_DB_URL'),
        taken_at: ctx.now().toISOString(),
        duration_ms: 0,
      };
    },
    checkReadOnlyRole: unused,
    enforceRolePolicy: unused,
    close: async () => {},
  };
}

type Setup = {
  readonly env?: Record<string, string | undefined>;
  readonly chain?: IdChain;
  readonly fixtures?: Record<string, unknown>;
  readonly sql?: FakeSql | null;
  readonly maxToolCalls?: number;
};

type H = {
  readonly deps: ToolDeps;
  readonly tool: ToolDefinition;
  readonly sqlTool: ToolDefinition;
  readonly audit: MemoryAuditSink;
  readonly budget: RunBudget;
  readonly config: Config;
  readonly reads: string[];
  readonly sql: FakeSql | null;
  readonly runId: string;
};

function setup(opts: Setup = {}): H {
  runSeq += 1;
  const runId = `run_resolve_id_${runSeq}_${Date.now().toString(36)}`;
  const config = makeTestConfig({ TRIAGE_ENTITIES: 'ssfb,rtl', TRIAGE_MOCK_STRICT: 'false', ...DSNS, ...opts.env });
  const budget = createRunBudget({
    runId,
    maxToolCalls: opts.maxToolCalls ?? 20,
    maxTasks: 5,
    maxRowsPerCall: config.sql.maxRows,
    maxBytesPerCall: 100_000,
    maxBytesPerRun: 1_000_000,
  });
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
  });
  const entries = opts.fixtures ?? {};
  const reads: string[] = [];
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, entity, key) {
      if (kind === 'sql_select') {
        const result = { rows: [{ status_v2: 'SUBMITTED' }] };
        return { scope: 'shared', path: 'x', hash: '0123456789abcdef', fixture: { kind, result } as never };
      }
      const ks = keyString(semanticKey('resolve_identity', key as never));
      reads.push(`${kind} ${entity} ${ks}`);
      if (!Object.hasOwn(entries, ks)) return null;
      return { scope: 'shared', path: 'x', hash: '0123456789abcdef', fixture: { kind, result: entries[ks] } as never };
    },
    async list() {
      return [];
    },
  };
  const audit = createMemoryAuditSink();
  const sql = opts.sql === undefined ? fakeSql() : opts.sql;
  const deps = createToolDeps({
    runId,
    config,
    interface: 'cli',
    idChain: opts.chain ?? BASE_CHAIN,
    connectors: sql === null ? {} : { sql },
    runStore: {} as RunStore,
    budget,
    audit,
    fixtures: createMockLayer(config, { store }),
    now: () => NOW,
  });
  const triage = makeToolContext({ config, runId, entity: null, deps });
  const investigator = makeToolContext({ config, runId, entity: 'ssfb', deps });
  return {
    deps,
    tool: toolModule.create(triage, 'triage'),
    sqlTool: sqlSelectModule.create(investigator, 'investigator'),
    audit,
    budget,
    config,
    reads,
    sql,
    runId,
  };
}

async function call(tool: ToolDefinition, data: unknown, signal = new AbortController().signal): Promise<ToolEnvelope> {
  const parsed = v.safeParse(tool.input as v.GenericSchema, data);
  if (!parsed.success) throw new Error(`input does not match the schema: ${parsed.issues.map((i) => i.message).join('; ')}`);
  const run = tool.run as (c: unknown) => Promise<unknown>;
  const out = await run({
    data: parsed.output,
    toolCallId: 'toolu_resolve_1',
    signal,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return v.parse(ToolEnvelopeSchema, out);
}

type Data = { results: SeedResult[]; id_chain: IdChain; entity_hint?: string };
const dataOf = (env: ToolEnvelope): Data => env.output.data as Data;
const resultFor = (env: ToolEnvelope, key: string): SeedResult | undefined =>
  dataOf(env).results.find((r) => r.key === key);

const selectForm = (h: H, id: string): Promise<ToolEnvelope> =>
  call(h.sqlTool, { service: 'harbor', sql: SQL_BY_FORM, params: [id] });

// ------------------------------------------------------------------ schema

describe('resolve_identity: schema', () => {
  const entriesOf = (schema: unknown): Record<string, unknown> => {
    const s = schema as { entries?: Record<string, unknown>; wrapped?: unknown; pipe?: unknown[] };
    if (s.entries !== undefined) return s.entries;
    if (s.wrapped !== undefined) return entriesOf(s.wrapped);
    const inner = s.pipe?.[0];
    return inner !== undefined && inner !== schema ? entriesOf(inner) : {};
  };

  test('the input has ids and entity_hint only; ids holds KnownIds keys only', () => {
    const tool = toolModule.create(makeToolContext(), 'triage');
    const top = entriesOf(tool.input);
    expect(Object.keys(top).sort()).toEqual(['entity_hint', 'ids']);
    expect(Object.keys(entriesOf(top['ids'])).sort()).toEqual([...KNOWN_ID_KEYS].sort());
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
  });

  test('schema has no free-form query fields at any level', () => {
    const tool = toolModule.create(makeToolContext(), 'triage');
    const names = new Set<string>();
    const walk = (schema: unknown): void => {
      for (const [k, s] of Object.entries(entriesOf(schema))) {
        names.add(k);
        walk(s);
      }
    };
    walk(tool.input);
    for (const bad of ['sql', 'path', 'query', 'entity', 'run_id', 'runId', 'service', 'statement', 'table']) {
      expect(names.has(bad)).toBe(false);
    }
  });

  test('unknown keys inside ids, SQL-looking values and blank ids are refused by the schema', () => {
    const tool = toolModule.create(makeToolContext(), 'triage');
    const parse = (data: unknown) => v.safeParse(tool.input as v.GenericSchema, data).success;
    expect(parse({ ids: { customer_id: CUST } })).toBe(true);
    expect(parse({ ids: { customer_id: CUST }, entity_hint: 'ssfb' })).toBe(true);
    expect(parse({ ids: { sql: 'SELECT 1' } })).toBe(false);
    expect(parse({ ids: { customer_id: "x' OR 1=1 --" } })).toBe(false);
    expect(parse({ ids: { customer_id: '   ' } })).toBe(false);
    expect(parse({ ids: { customer_id: 'a'.repeat(129) } })).toBe(false);
    expect(parse({ ids: {}, entity_hint: 'nope' })).toBe(false);
  });

  test('mounted on triage only, picked up by the generated tool list, create() and enabled() never touch deps', () => {
    expect(toolModule.mounts).toEqual(['triage']);
    expect(allToolNames()).toContain(RESOLVE_IDENTITY);
    for (const { mount, entity } of conformanceCases(toolModule)) {
      const ctx = makeToolContext({ entity });
      expect(toolModule.enabled(ctx, mount)).toEqual({ on: true });
      expect(conformanceProblems(toolModule, toolModule.create(ctx, mount))).toEqual([]);
    }
    const names = (mount: 'triage' | 'investigator', entity: 'ssfb' | null) =>
      toolsFor(mount, makeToolContext({ entity })).map((t) => t.name);
    expect(names('triage', null)).toContain(RESOLVE_IDENTITY);
    expect(names('investigator', 'ssfb')).not.toContain(RESOLVE_IDENTITY);
  });

  test('disabled when neither ssfb nor rtl is enabled', () => {
    const ctx = makeToolContext({ env: { TRIAGE_ENTITIES: 'atspl' } });
    expect(toolModule.enabled(ctx, 'triage')).toMatchObject({ on: false });
  });
});

// ------------------------------------------------------------------ mock mode

describe('resolve_identity: mock mode', () => {
  test('mock hit returns IdChain and links the new form to the run customer', async () => {
    const h = setup({ fixtures: FORM_FIXTURES });
    const env = await call(h.tool, { ids: { account_form_id: FORM }, entity_hint: 'ssfb' });

    expect(env.output.status).toBe('ok');
    expect(env.output.taken_at).toBe(NOW.toISOString());
    const result = resultFor(env, 'account_form_id') as SeedResult;
    expect(result.status).toBe('linked');
    expect([...result.added].sort()).toEqual(['account_form_id', 'form_id', 'user_id']);
    const chain = dataOf(env).id_chain;
    expect(chain.ids).toMatchObject({ customer_id: CUST, account_form_id: FORM, form_id: FORM, user_id: USER });
    expect(dataOf(env).entity_hint).toBe('ssfb');
    // The run chain is the one returned.
    expect(h.deps.idChain().ids).toEqual(chain.ids);

    // The SQL connector is never called in mock mode.
    expect(h.sql?.calls.length).toBe(0);
    expect(h.reads.length).toBeGreaterThan(3);
    for (const r of h.reads) expect(r.startsWith('resolve_identity global ')).toBe(true);
  });

  test('output carries taken_at on every hop and state item', async () => {
    const h = setup({ fixtures: FORM_FIXTURES });
    const chain = dataOf(await call(h.tool, { ids: { account_form_id: FORM } })).id_chain;
    expect(chain.hops.length).toBeGreaterThan(0);
    expect(chain.basic_state.length).toBeGreaterThan(0);
    for (const hop of chain.hops) expect(hop.taken_at).toBe(NOW.toISOString());
    for (const item of chain.basic_state) expect(item.taken_at).toBe(NOW.toISOString());
    expect(chain.basic_state.find((s) => s.item === 'account_form_status_v2')).toMatchObject({
      value: 'SUBMITTED',
      status: 'read',
    });
  });

  test('one audit line per fixed statement, env var names only, all mock', async () => {
    const h = setup({ fixtures: FORM_FIXTURES });
    await call(h.tool, { ids: { account_form_id: FORM } });
    const lines = h.audit.lines.filter((l) => l.decision === 'allow');
    expect(lines.length).toBe(h.reads.length);
    for (const line of lines) {
      expect(line.tool).toBe(RESOLVE_IDENTITY);
      expect(line.transport).toBe('mock');
      expect(IDENTITY_ENVS).toContain(line.target);
    }
    const text = h.audit.lines.map(serializeAuditLine).join('\n');
    for (const secret of [FAKE_PASSWORD, FAKE_HOST, ...Object.values(DSNS)]) expect(text).not.toContain(secret);
  });

  test('strict miss throws, audits the miss and leaves the chain as it was', async () => {
    const h = setup({ env: { TRIAGE_MOCK_STRICT: 'true' } });
    const before = h.deps.idChain();
    let caught: unknown;
    try {
      await call(h.tool, { ids: { account_form_id: FORM } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).code).toBe('strict_miss');
    expect((caught as Error).message).toContain('resolve_identity');
    expect(h.deps.idChain()).toBe(before);
    expect(h.audit.lines.some((l) => l.exit === 'fixture_miss' && l.transport === 'mock')).toBe(true);
    expect(h.sql?.calls.length).toBe(0);
  });

  test('an id already in the chain is re-resolved as in_chain', async () => {
    const h = setup({
      fixtures: Object.fromEntries([fx('state.harbor_customer', 'customer_id', CUST, [{ state: 'ONBOARDED', sub_state: 'X' }])]),
    });
    const env = await call(h.tool, { ids: { customer_id: CUST } });
    expect(resultFor(env, 'customer_id')?.status).toBe('in_chain');
    expect(h.deps.idChain().basic_state.find((s) => s.item === 'harbor_customer_state')?.value).toBe('ONBOARDED');
  });
});

// ------------------------------------------------------------------ scope

describe('resolve_identity: scope', () => {
  test('IdChain extension widens scope: sql_select with the new form id is refused before and passes after', async () => {
    const h = setup({ fixtures: FORM_FIXTURES });
    const before = await selectForm(h, FORM);
    expect(before.output.status).toBe('refused');
    expect(before.output.message).toContain('scope');

    await call(h.tool, { ids: { account_form_id: FORM } });

    const after = await selectForm(h, FORM);
    expect(after.output.status).toBe('ok');
  });

  test('deny: model-supplied foreign id with no hop to the chain -> unverified, IdChain unchanged, next scope check denies it', async () => {
    const h = setup({ fixtures: STRANGER_FIXTURES });
    const before = h.deps.idChain();
    const env = await call(h.tool, { ids: { user_id: STRANGER } });

    expect(env.output.status).toBe('ok');
    const result = resultFor(env, 'user_id') as SeedResult;
    expect(result.status).toBe('unverified');
    expect(result.added).toEqual([]);
    expect(h.deps.idChain()).toBe(before);
    expect(dataOf(env).id_chain).toEqual(before);

    // The foreign customer's ids are not handed to the model.
    const text = JSON.stringify(env);
    expect(text).not.toContain(STRANGER_FORM);
    expect(text).not.toContain(STRANGER_CUST);

    // The decision is audited as a deny, with keys and statuses only.
    const deny = h.audit.lines.find((l) => l.decision === 'deny');
    expect(deny?.reason).toContain('user_id unverified');
    expect(serializeAuditLine(deny as never)).not.toContain(STRANGER);

    for (const id of [STRANGER, STRANGER_FORM, STRANGER_CUST]) {
      const denied = await selectForm(h, id);
      expect(denied.output.status).toBe('refused');
      expect(denied.output.message).toContain('scope');
    }
  });

  test('deny: a chain id sent next to a foreign id does not carry the foreign id in', async () => {
    const h = setup({ fixtures: STRANGER_FIXTURES });
    const env = await call(h.tool, { ids: { customer_id: CUST, user_id: STRANGER } });
    expect(resultFor(env, 'customer_id')?.status).toBe('in_chain');
    expect(resultFor(env, 'user_id')?.status).toBe('unverified');
    expect(h.deps.idChain().ids.user_id).toBeUndefined();
    expect((await selectForm(h, STRANGER)).output.status).toBe('refused');
  });

  test('deny: a device id whose unverified guardian hop gives the chain user does not join', async () => {
    const h = setup({
      chain: { ids: { user_id: USER }, hops: [], basic_state: [] },
      fixtures: Object.fromEntries([fx('device_id', 'device_id', DEVICE, [{ subject: USER }])]),
    });
    const env = await call(h.tool, { ids: { device_id: DEVICE } });
    const result = resultFor(env, 'device_id') as SeedResult;
    expect(result.status).toBe('unverified');
    expect(result.hops.find((hop) => hop.from === 'device_id')?.status).toBe('unverified');
    expect(h.deps.idChain().ids.device_id).toBeUndefined();
  });

  test('an id that finds nothing is not_found and does not join', async () => {
    const h = setup();
    const env = await call(h.tool, { ids: { account_form_id: FORM } });
    expect(resultFor(env, 'account_form_id')?.status).toBe('not_found');
    expect(h.deps.idChain().ids.account_form_id).toBeUndefined();
    expect((await selectForm(h, FORM)).output.status).toBe('refused');
  });

  test('a linked id whose key is taken joins scope but the chain keeps its first value', async () => {
    const h = setup({
      chain: { ids: { customer_id: CUST, account_form_id: FORM }, hops: [], basic_state: [] },
      fixtures: Object.fromEntries([
        fx('account_form_id', 'account_form_id', FORM2, [{ form_id: FORM2, external_user_ref: USER }]),
        fx('account_form_id.customer', 'account_form_id', FORM2, [{ customer_id: CUST, account_form_id: FORM2 }]),
      ]),
    });
    const env = await call(h.tool, { ids: { account_form_id: FORM2 } });
    const result = resultFor(env, 'account_form_id') as SeedResult;
    expect(result.status).toBe('linked');
    expect(result.in_scope_only).toContain('account_form_id');
    expect(h.deps.idChain().ids.account_form_id).toBe(FORM);
    expect((await selectForm(h, FORM2)).output.status).toBe('ok');
    expect((await selectForm(h, FORM)).output.status).toBe('ok');
  });
});

// ------------------------------------------------------------------ real mode with fakes

describe('resolve_identity: unreachable', () => {
  test('unreachable hops continue: every hop is marked and an ok envelope comes back', async () => {
    const sql = fakeSql(new ConnectorError('unreachable', 'tunnel down'));
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false' }, sql });
    const before = h.deps.idChain();
    const env = await call(h.tool, { ids: { account_form_id: FORM } });

    expect(env.output.status).toBe('ok');
    const result = resultFor(env, 'account_form_id') as SeedResult;
    expect(result.status).toBe('unreachable');
    expect(result.hops.length).toBeGreaterThan(0);
    expect(result.hops.some((hop) => hop.status === 'unreachable')).toBe(true);
    for (const hop of result.hops) expect(hop.taken_at).toBe(NOW.toISOString());
    expect(h.deps.idChain()).toBe(before);
    expect(sql.calls.length).toBeGreaterThan(0);
    // Real transport, env var names only, and no connector text on the lines.
    for (const line of h.audit.lines) {
      expect(line.transport).toBe('real');
      expect(IDENTITY_ENVS).toContain(line.target);
    }
    expect(h.audit.lines.map(serializeAuditLine).join('\n')).not.toContain('tunnel down');
  });

  test('a blank DSN and no connector mark hops unreachable without a throw', async () => {
    const h = setup({ env: { TRIAGE_MOCK_MODE: 'false', SSFB_HARBOR_DB_URL: '' }, sql: null });
    const env = await call(h.tool, { ids: { customer_id: CUST } });
    expect(env.output.status).toBe('ok');
    const hops = dataOf(env).id_chain.hops;
    expect(hops.some((hop) => hop.status === 'unreachable')).toBe(true);
    expect(h.audit.lines.some((l) => l.exit === 'not_configured' && l.target === 'SSFB_HARBOR_DB_URL')).toBe(true);
    const text = h.audit.lines.map(serializeAuditLine).join('\n');
    for (const secret of [FAKE_PASSWORD, FAKE_HOST]) expect(text).not.toContain(secret);
  });
});

// ------------------------------------------------------------------ refusals

describe('resolve_identity: refusals', () => {
  test('budget exhaustion refuses and audits, before any lookup', async () => {
    const h = setup({ fixtures: FORM_FIXTURES, maxToolCalls: 1 });
    expect(h.budget.consumeToolCall('sql_select').ok).toBe(true);

    const env = await call(h.tool, { ids: { account_form_id: FORM } });
    expect(env.output.status).toBe('refused');
    expect(h.reads).toEqual([]);
    expect(h.audit.lines.length).toBe(1);
    const line = h.audit.lines[0];
    expect(line?.decision).toBe('deny');
    expect(line?.reason).toContain('budget');
    expect(line?.target).toBe('SSFB_HARBOR_DB_URL');
    expect(escalationFor(h.runId).snapshot().budgetExhausted).toBe(true);
    expect(h.deps.idChain().ids.account_form_id).toBeUndefined();
  });

  test('no ids is refused and audited', async () => {
    const h = setup();
    const env = await call(h.tool, { ids: {} });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('at least one id');
    expect(h.audit.lines.map((l) => l.decision)).toEqual(['deny']);
    expect(h.reads).toEqual([]);
  });

  test('an aborted signal throws before the budget is touched', async () => {
    const h = setup({ fixtures: FORM_FIXTURES, maxToolCalls: 1 });
    const ctl = new AbortController();
    ctl.abort();
    await expect(call(h.tool, { ids: { account_form_id: FORM } }, ctl.signal)).rejects.toThrow();
    // The single call the budget allows is still there.
    expect(h.budget.consumeToolCall('sql_select').ok).toBe(true);
    expect(h.audit.lines).toEqual([]);
  });
});
