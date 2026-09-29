import { afterEach, describe, expect, test } from 'bun:test';
import { releaseEscalation } from '../../agents/escalation.ts';
import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import { logsKeyInput } from '../../connectors/quickwit/client.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../gate/audit-sink.ts';
import { getRunBudget, releaseRunBudget } from '../../gate/budget.ts';
import { buildLogsQuery, quickwitGateConfig } from '../../gate/quickwit.ts';
import { releaseObservedIds } from '../../gate/scope.ts';
import { createMockLayer } from '../../mock/index.ts';
import { keyString, semanticKey } from '../../mock/key.ts';
import type { FixtureStore } from '../../mock/store.ts';
import { releaseActions } from '../../runlog/actions.ts';
import type { RunStore } from '../../runstore/types.ts';
import type { Entity, RunId } from '../../types/core.ts';
import type { IdChain, Lead } from '../../types/id-chain.ts';
import { locateProbesUsed, releaseLocateState, runLocate } from '../locate.tool.ts';
import { makeTestConfig, makeToolContext } from '../../../test/support/fake-tool-context.ts';
import { createToolDeps } from './context.ts';
import { CATALOGUE_TABLES } from './schema-catalogue.ts';
import { MAX_SCOUT_VALUES, runScout, SCOUT_AGENT, type ScoutInput, scoutValues } from './scout.ts';

// All values are synthetic.
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const OTHER = 'deadbeef-9999-4888-8777-666655554444';
const EMAIL = 'asha.test@example.com';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const WINDOW = { from: '2026-08-25T00:00:00.000Z', to: '2026-09-24T10:00:00.000Z' };

const BASE_ENV: Record<string, string> = {
  TRIAGE_ENTITIES: 'ssfb,rtl',
  TRIAGE_MOCK_STRICT: 'false',
  RTL_QUICKWIT_TRANSPORT: 'http',
  RTL_QUICKWIT_INDEX: 'app-logs',
  RTL_QUICKWIT_URL: 'http://quickwit.invalid:7280',
  RTL_QUICKWIT_AUTH: 'none',
};

const seed = (value: string, kind: Lead['kind']): Lead => ({ value, kind, source: 'thread', status: 'seed' });

// ------------------------------------------------------------------ harness

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let runSeq = 0;

type H = {
  readonly runId: RunId;
  readonly config: Config;
  readonly registry: Registry;
  readonly audit: MemoryAuditSink;
  readonly env: Parameters<typeof runScout>[0];
  input(chain: IdChain, signal?: AbortSignal): ScoutInput;
};

function setup(opts: { env?: Record<string, string>; fixtures?: (registry: Registry) => (readonly [unknown, unknown])[] } = {}): H {
  runSeq += 1;
  const runId = `01JSCOUT${String(runSeq).padStart(4, '0')}AAAAAAAAAAAAAA` as RunId;
  const config = makeTestConfig({ ...BASE_ENV, ...opts.env });
  const registry = makeToolContext({ config, runId }).registry;
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
    releaseActions(runId);
    releaseObservedIds(runId);
    releaseLocateState(runId);
  });
  const answers = new Map((opts.fixtures?.(registry) ?? []).map(([key, result]) => [keyString(key), result]));
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, _entity, key) {
      const k = keyString(key);
      if (!answers.has(k)) return null;
      return { scope: 'shared', path: '/triage-test/fixtures/x.json', hash: '0123456789abcdef', fixture: { kind, result: answers.get(k) } as never };
    },
    async list() {
      return [];
    },
  };
  const audit = createMemoryAuditSink();
  const env = { config, registry, connectors: {}, runStore: {} as RunStore, audit, fixtures: createMockLayer(config, { store }), now: () => NOW };
  return {
    runId,
    config,
    registry,
    audit,
    env,
    input: (chain, signal) => ({
      runId,
      idChain: chain,
      interface: 'cli',
      window: WINDOW,
      redactionNames: [],
      signal: signal ?? new AbortController().signal,
    }),
  };
}

const catRow = (table: string, column: string, type: string, indexed = false) => ({
  table_schema: 'public',
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

function fixtures(registry: Registry): (readonly [unknown, unknown])[] {
  return [
    [catalogueKey('rtl', 'workflow'), { rows: [catRow('workflow_executions', 'reference_id', 'character varying', true)] }],
    [probeKey('rtl', 'workflow', 'public.workflow_executions.reference_id'), { rows: [{ count: '2' }] }],
    [catalogueKey('ssfb', 'guardian'), { rows: [catRow('device_auth_attempts', 'user_id', 'uuid', true)] }],
    [
      logsKey(registry, 'rtl'),
      { groups: [{ key: 'verification-service', count: 3328 }], num_hits: 3328, tally_base: 3328, window: WINDOW, truncated: false },
    ],
    [logsKey(registry, 'ssfb'), { groups: [], num_hits: 0, tally_base: 0, window: WINDOW, truncated: false }],
  ];
}

// ------------------------------------------------------------------ values

describe('scoutValues', () => {
  test('chain ids in key order, then seed leads; one whole id each, no repeats, no derived leads', () => {
    const chain: IdChain = {
      ids: { country: 'IN', customer_id: OTHER, aspora_user_id: CUSTOMER },
      hops: [],
      basic_state: [],
      leads: [
        seed(CUSTOMER.toUpperCase(), 'uuid'),
        seed(EMAIL, 'email'),
        { ...seed('123456789012', 'digits'), source: 'derived', status: 'derived', depth: 1 },
      ],
    };
    expect(scoutValues(chain)).toEqual([
      { value: CUSTOMER, kind: 'uuid' },
      { value: OTHER, kind: 'uuid' },
      { value: EMAIL, kind: 'email' },
    ]);
  });

  test(`at most ${MAX_SCOUT_VALUES} values`, () => {
    const leads = Array.from({ length: 8 }, (_, i) => seed(`9876543210${i}`, 'digits'));
    expect(scoutValues({ ids: {}, hops: [], basic_state: [], leads })).toHaveLength(MAX_SCOUT_VALUES);
  });
});

// ------------------------------------------------------------------ runScout

describe('runScout', () => {
  test('one masked line per value with the ranked places, from the run probe budget', async () => {
    const h = setup({ fixtures });
    const out = await runScout(h.env, h.input({ ids: { aspora_user_id: CUSTOMER }, hops: [], basic_state: [] }));
    expect(out.lines).toHaveLength(1);
    const line = out.lines[0] as string;
    expect(line.startsWith('uuid:***6666 -> rtl logs verification-service 3328; rtl db workflow public.workflow_executions.reference_id 2')).toBe(true);
    expect(line).toContain('ssfb: nothing');
    expect(line).not.toContain(CUSTOMER);
    expect(out.values).toEqual([{ value: 'uuid:***6666', kind: 'uuid', status: 'ok', hits: 2 }]);
    expect(out.gaps).toEqual([]);
    expect(out.probes).toBeGreaterThan(0);
    expect(out.probes).toBe(locateProbesUsed(h.runId));
    const audit = h.audit.lines.filter((l) => l.tool === 'locate');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(CUSTOMER);
  });

  test("the agent's locate on the same value reuses the scout's result and costs no probe", async () => {
    const h = setup({ fixtures });
    const chain: IdChain = { ids: { aspora_user_id: CUSTOMER }, hops: [], basic_state: [] };
    const out = await runScout(h.env, h.input(chain));
    const deps = createToolDeps({ runId: h.runId, config: h.config, registry: h.registry, interface: 'cli', idChain: chain, connectors: {}, runStore: {} as RunStore, audit: h.audit, fixtures: h.env.fixtures, now: () => NOW });
    const ctx = { runId: h.runId, entity: null, agent: 'triage', config: h.config, registry: h.registry, deps };
    const again = await runLocate(ctx, { value: CUSTOMER }, { toolCallId: 't1', log: { warn: () => {} } });
    expect(again.output.status).toBe('ok');
    expect(locateProbesUsed(h.runId)).toBe(out.probes);
    expect(h.audit.lines.at(-1)?.exit).toBe('reused');
    expect(SCOUT_AGENT).toBe('scout');
  });

  test('a value locate throws on becomes a not-located line and a gap, and the next value still runs', async () => {
    // Strict mode with no fixtures: every catalogue read is a miss.
    const h = setup({ env: { TRIAGE_MOCK_STRICT: 'true' } });
    const out = await runScout(h.env, h.input({ ids: { aspora_user_id: CUSTOMER, customer_id: OTHER }, hops: [], basic_state: [] }));
    expect(out.lines).toEqual([
      'uuid:***6666 -> not located (locate failed: FixtureMissError)',
      'uuid:***4444 -> not located (locate failed: FixtureMissError)',
    ]);
    expect(out.gaps).toHaveLength(2);
    expect(out.gaps[0]).toContain('scout: locate failed for uuid:***6666');
    expect(out.values.map((v) => v.status)).toEqual(['failed', 'failed']);
    expect(out.gaps.join(' ')).not.toContain(CUSTOMER);
  });

  test("the run's tool-call budget is not charged, so the model's calls are all left", async () => {
    const h = setup({ fixtures, env: { TRIAGE_MAX_TOOL_CALLS_PER_RUN: '1' } });
    const chain: IdChain = { ids: { aspora_user_id: CUSTOMER, customer_id: OTHER }, hops: [], basic_state: [] };
    const out = await runScout(h.env, h.input(chain));
    expect(out.values.map((v) => v.status)).toEqual(['ok', 'ok']);
    expect(getRunBudget(h.runId)?.state().calls).toBe(0);
    expect(getRunBudget(h.runId)?.consumeToolCall('sql_select')).toEqual({ ok: true });
  });

  test("past the place cap, the rest are counted and an entity's nothing line stays", async () => {
    const services = ['a-service', 'b-service', 'c-service', 'd-service', 'e-service', 'f-service'];
    const h = setup({
      fixtures: (registry) => [
        [logsKey(registry, 'rtl'), { groups: services.map((key, i) => ({ key, count: 100 - i })), num_hits: 585, tally_base: 585, window: WINDOW, truncated: false }],
        [logsKey(registry, 'ssfb'), { groups: [], num_hits: 0, tally_base: 0, window: WINDOW, truncated: false }],
      ],
    });
    const out = await runScout(h.env, h.input({ ids: { aspora_user_id: CUSTOMER }, hops: [], basic_state: [] }));
    const line = out.lines[0] as string;
    expect(line.startsWith('uuid:***6666 -> rtl logs a-service 100; rtl logs b-service 99; rtl logs c-service 98; rtl logs d-service 97; rtl logs e-service 96; ssfb: nothing (')).toBe(true);
    expect(line).not.toContain('f-service');
    expect(line).toMatch(/; \+\d+ more$/);
  });

  test('an email is masked in the line', async () => {
    const h = setup();
    const out = await runScout(h.env, h.input({ ids: {}, hops: [], basic_state: [], leads: [seed(EMAIL, 'email')] }));
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).not.toContain('asha');
    expect(out.lines[0]).not.toContain(EMAIL);
  });

  test('with no entity database or logs set up, as in the eval home, strict mode reads nothing and misses nothing', async () => {
    // The eval home leaves every entity DSN, Quickwit URL and qw context blank.
    const registry = makeToolContext({ config: makeTestConfig(BASE_ENV) }).registry;
    const keys = (['ssfb', 'rtl'] as const).flatMap((e) => [
      ...registry.services(e).flatMap((s) => registry.service(e, s).db ?? []),
      ...[registry.spec(e).quickwit.http?.url, registry.spec(e).quickwit.qw?.context].flatMap((k) => k ?? []),
    ]);
    const blank = Object.fromEntries(keys.map((k) => [k, '']));
    const h = setup({ env: { ...blank, TRIAGE_MOCK_STRICT: 'true' } });
    const out = await runScout(h.env, h.input({ ids: { aspora_user_id: CUSTOMER }, hops: [], basic_state: [] }));
    expect(out.gaps).toEqual([]);
    expect(out.probes).toBe(0);
    expect(out.lines[0]).toContain('not configured');
    expect(h.audit.lines.map((l) => l.exit)).toEqual(['ok']);
  });

  test('no usable id: nothing is read', async () => {
    const h = setup({ fixtures });
    const out = await runScout(h.env, h.input({ ids: { country: 'IN' }, hops: [], basic_state: [] }));
    expect(out).toEqual({ lines: [], gaps: [], values: [], probes: 0 });
    expect(h.audit.lines).toHaveLength(0);
  });

  test('an abort stops the scout', async () => {
    const h = setup({ fixtures });
    const ac = new AbortController();
    ac.abort();
    await expect(runScout(h.env, h.input({ ids: { aspora_user_id: CUSTOMER }, hops: [], basic_state: [] }, ac.signal))).rejects.toThrow();
  });
});
