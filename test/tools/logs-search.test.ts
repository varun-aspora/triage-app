import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import * as v from 'valibot';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import type { ExecResult, ExecRunner } from '../../src/connectors/exec.ts';
import {
  createQuickwitConnector,
  type QuickwitConnector,
  type QuickwitSearchOutcome,
} from '../../src/connectors/quickwit/client.ts';
import type { FetchLike } from '../../src/connectors/quickwit/http-transport.ts';
import { envVarName } from '../../src/connectors/types.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
import { releaseObservedIds } from '../../src/gate/scope.ts';
import { quickwitSlot, resetQuickwitSlotsForTests } from '../../src/gate/semaphore.ts';
import { createMockLayer } from '../../src/mock/index.ts';
import { keyString } from '../../src/mock/key.ts';
import type { FixtureStore } from '../../src/mock/store.ts';
import type { RunStore } from '../../src/runstore/types.ts';
import { createToolDeps } from '../../src/tools/_lib/context.ts';
import { conformanceProblems, FORBIDDEN_INPUT_KEYS } from '../../src/tools/index.ts';
import { foldGroups, LogsSearchInputSchema, logsModeOf, toolModule } from '../../src/tools/logs-search.tool.ts';
import type { Entity, TimeWindow } from '../../src/types/core.ts';
import type { IdChain } from '../../src/types/id-chain.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestHome, SSFB_QW_ENV, type TestHome, type TestHomeOptions } from '../support/home.ts';
import { makeToolContext } from '../support/fake-tool-context.ts';

// ------------------------------------------------------------------ setup

const NOW = new Date('2026-09-23T10:00:00.000Z');
const REQUEST_WINDOW: TimeWindow = { from: '2026-09-21T10:00:00.000Z', to: NOW.toISOString() };
const PAST_REQUEST_WINDOW: TimeWindow = { from: '2026-09-21T10:00:00.000Z', to: '2026-09-22T10:00:00.000Z' };
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const STRANGER = 'deadbeef-9999-4888-8777-666655554444';
const CHAIN: IdChain = { ids: { customer_id: CUSTOMER }, hops: [], basic_state: [] };
const FAKE_URL = 'http://quickwit.example.test:7080';

const HIT_A = { service: 'harbor', level: 'error', message: 'doc fetch failed for form 12345678', timestamp: '2026-09-22T09:00:00Z' };
const HIT_B = { service: 'harbor', level: 'error', message: 'doc fetch failed for form 87654321', timestamp: '2026-09-22T09:05:00Z' };
const HIT_C = { service: 'harbor', level: 'error', message: 'timeout calling workflow', timestamp: '2026-09-22T09:10:00Z' };

const homes: TestHome[] = [];
function home(options: TestHomeOptions = {}): TestHome {
  const h = makeTestHome({ ...options, overrides: { ...SSFB_QW_ENV, ...options.overrides } });
  homes.push(h);
  return h;
}
const HTTP_ENV = { SSFB_QUICKWIT_TRANSPORT: 'http', SSFB_QUICKWIT_URL: FAKE_URL, SSFB_QUICKWIT_AUTH: 'none' };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  jest.useRealTimers();
});
beforeEach(() => resetQuickwitSlotsForTests());
afterAll(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

let seq = 0;

type StoreCall = { kind: string; entity: string; key_string: string };

type Setup = {
  h: TestHome;
  audit: MemoryAuditSink;
  storeCalls: StoreCall[];
  call(input: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<ToolEnvelope>;
};

type SetupOptions = {
  h?: TestHome;
  entity?: Entity;
  /** false runs the real path through the given connector (a fake). */
  mockMode?: boolean;
  connector?: QuickwitConnector;
  /** The fixture result for every lookup; null is a miss. */
  fixture?: unknown;
  requestWindow?: TimeWindow | null;
  /** Build the run budget from the home's config (per-tool caps included). */
  budgetFromConfig?: boolean;
};

function setup(opts: SetupOptions = {}): Setup {
  const h = opts.h ?? home();
  const entity = opts.entity ?? 'ssfb';
  seq += 1;
  const runId = `run_logs_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const budget =
    opts.budgetFromConfig === true
      ? undefined
      : createRunBudget({
          runId,
          maxToolCalls: 50,
          maxTasks: 5,
          maxRowsPerCall: 200,
          maxBytesPerCall: 1_000_000,
          maxBytesPerRun: 10_000_000,
        });
  cleanups.push(() => {
    releaseRunBudget(runId);
    releaseEscalation(runId);
    releaseObservedIds(runId);
  });
  const audit = createMemoryAuditSink();
  const storeCalls: StoreCall[] = [];
  const store: FixtureStore = {
    fixturesDir: '/triage-test/fixtures',
    async get(kind, fixtureEntity, key) {
      storeCalls.push({ kind, entity: fixtureEntity, key_string: keyString(key) });
      if (opts.fixture === undefined || opts.fixture === null) return null;
      return {
        scope: 'shared',
        path: '/triage-test/fixtures/x.json',
        hash: '0123456789abcdef',
        fixture: { kind, result: opts.fixture } as never,
      };
    },
    async list() {
      return [];
    },
  };
  const mockMode = opts.mockMode ?? true;
  const mockConfig = { mock: { ...h.config.mock, enabled: mockMode, strict: false, record: false }, paths: h.config.paths };
  const requestWindow = opts.requestWindow === undefined ? REQUEST_WINDOW : opts.requestWindow;
  const deps = createToolDeps({
    runId,
    config: h.config,
    registry: h.registry,
    interface: 'cli',
    idChain: CHAIN,
    connectors: opts.connector !== undefined ? { quickwit: opts.connector } : {},
    runStore: {} as RunStore,
    ...(budget !== undefined ? { budget } : {}),
    audit,
    fixtures: createMockLayer(mockConfig, { store }),
    now: () => new Date(NOW),
    ...(requestWindow !== null ? { requestWindow } : {}),
  });
  const ctx = makeToolContext({ config: h.config, registry: h.registry, entity, runId, deps });
  const tool = toolModule.create(ctx, 'investigator');
  const log = { info() {}, warn() {}, error() {} };
  return {
    h,
    audit,
    storeCalls,
    async call(input, callOpts = {}) {
      const data = v.parse(LogsSearchInputSchema, input);
      const out = await tool.run({ data, toolCallId: `toolu_logs_${seq}`, log, ...(callOpts.signal ? { signal: callOpts.signal } : {}) } as never);
      return v.parse(ToolEnvelopeSchema, out);
    },
  };
}

function dataOf(env: ToolEnvelope): Record<string, unknown> {
  expect(env.output.status).toBe('ok');
  return env.output.data as Record<string, unknown>;
}

function lastAudit(s: Setup) {
  const line = s.audit.lines.at(-1);
  if (line === undefined) throw new Error('no audit line');
  return line;
}

const HITS_FIXTURE = { hits: [HIT_A, HIT_B], num_hits: 2, window: PAST_REQUEST_WINDOW, truncated: false };

/** An exec runner that answers every qw call with one stdout and records the argv. */
function qwRunner(stdout: string): ExecRunner & { argv: string[][] } {
  const argv: string[][] = [];
  return {
    argv,
    async run(_bin, args) {
      argv.push([...args]);
      const result: ExecResult = { exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false, aborted: false };
      return result;
    },
  };
}

function fetchReturning(body: unknown): FetchLike & { calls: number } {
  const fn = (async () => {
    fn.calls += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as FetchLike & { calls: number };
  fn.calls = 0;
  return fn;
}

const noExec: ExecRunner = {
  run: () => Promise.reject(new Error('exec must not run')),
};
const noFetch: FetchLike = () => Promise.reject(new Error('fetch must not run'));

// ------------------------------------------------------------------ schema

describe('input schema', () => {
  test('schema has no transport, entity, index or run_id field', () => {
    const entries = Object.keys(LogsSearchInputSchema.entries);
    for (const key of ['transport', 'entity', 'index', 'run_id', 'runId', 'context', 'url']) expect(entries).not.toContain(key);
    for (const key of FORBIDDEN_INPUT_KEYS) expect(entries).not.toContain(key);
    const ctx = makeToolContext({ entity: 'ssfb' });
    const tool = toolModule.create(ctx, 'investigator');
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
    expect(tool.name).toBe('logs_search');
    expect(tool.harness).toBe(true);
  });

  test('deny: unknown input key such as transport is refused by the schema', () => {
    const parsed = v.safeParse(LogsSearchInputSchema, { service: 'harbor', message: 'x', transport: 'http' });
    expect(parsed.success).toBe(false);
    expect(v.safeParse(LogsSearchInputSchema, { service: 'harbor', message: 'x', entity: 'atspl' }).success).toBe(false);
  });

  test('create() and enabled() never read run deps, and the tool is always mounted', () => {
    const ctx = makeToolContext({ entity: 'rtl' });
    expect(toolModule.enabled(ctx, 'investigator')).toEqual({ on: true });
    expect(() => toolModule.create(ctx, 'investigator')).not.toThrow();
    expect(toolModule.mounts).toEqual(['investigator']);
    expect(toolModule.entities).toBe('all');
  });

  test('service is optional and the D76 inputs parse', () => {
    const parsed = v.safeParse(LogsSearchInputSchema, {
      terms: ['x'],
      exclude: ['noise'],
      any_of: [{ level: ['error', 'warn'], message: ['a'], terms: ['b'], service: ['harbor'] }],
      contains: 'abc',
      denoise: 'only',
      order: 'oldest',
      offset: 250,
      columns: ['status'],
      raw: true,
      group_by: ['service', 'level', 'message', 'error'],
      count_distinct: 'form_id',
    });
    expect(parsed.success).toBe(true);
    for (const bad of [
      { terms: ['x'], group_by: 'service' },
      { terms: ['x'], group_by: ['a', 'b', 'c', 'd', 'e'] },
      { terms: ['x'], offset: -1 },
      { terms: ['x'], order: 'random' },
      { terms: ['x'], denoise: 'all' },
      { terms: ['x'], any_of: [{ query: 'a OR b' }] },
      { terms: ['x'], query: 'service:harbor' },
    ]) {
      expect(v.safeParse(LogsSearchInputSchema, bad).success).toBe(false);
    }
  });

  test('the description states the defaults and limits, from config', () => {
    const tool = toolModule.create(makeToolContext({ entity: 'ssfb' }), 'investigator');
    for (const text of [
      '250 hits',
      'newest first',
      "request window (30 days before the thread's first message up to when the request came in)",
      'both ends',
      '5,000',
      '50 logs_search calls',
      'single quotes',
      'denoise',
    ]) {
      expect(tool.description).toContain(text);
    }
    const env = { TRIAGE_DEFAULT_LOOKBACK_DAYS: '7', TRIAGE_MAX_LOG_CALLS_PER_RUN: '12', SSFB_QUICKWIT_MAX_HITS: '100' };
    const tuned = toolModule.create(makeToolContext({ entity: 'ssfb', env }), 'investigator');
    for (const text of ['one page of 100 hits', '(7 days before', 'At most 12 logs_search calls']) expect(tuned.description).toContain(text);
    const rtl = toolModule.create(makeToolContext({ entity: 'rtl' }), 'investigator');
    expect(rtl.description).toContain('a UUID goes in terms, never in fields');
    expect(rtl.description).not.toContain('denoise');
  });

  test('logsModeOf maps count and group_by', () => {
    expect(logsModeOf({})).toBe('search');
    expect(logsModeOf({ count: true })).toBe('count');
    expect(logsModeOf({ group_by: ['level'] })).toBe('group_by');
    expect(logsModeOf({ count_distinct: 'form_id' })).toBe('group_by');
  });
});

// ------------------------------------------------------------------ denies

describe('gate denies', () => {
  test('deny: service-only query', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('the query needs a selective part');
    expect(s.storeCalls).toHaveLength(0);
    expect(lastAudit(s).decision).toBe('deny');
  });

  test('deny: service with only a level is still refused', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor', level: 'error' });
    expect(out.output.status).toBe('refused');
    expect(s.storeCalls).toHaveLength(0);
  });

  test('deny: unknown field', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor', fields: { bogus_field: 'x' } });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('unknown field');
    expect(s.storeCalls).toHaveLength(0);
  });

  test('deny: unknown group_by field and unknown service', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const g = await s.call({ service: 'harbor', message: 'failed', group_by: ['nope'] });
    expect(g.output.status).toBe('refused');
    const u = await s.call({ service: 'no-such-service', message: 'failed' });
    expect(u.output.status).toBe('refused');
    expect(u.output.message).toContain('unknown service');
    expect(s.storeCalls).toHaveLength(0);
  });

  test('deny: out-of-scope id term', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor', terms: [STRANGER] });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('not in the run');
    expect(out.output.message).not.toContain(STRANGER);
    expect(s.storeCalls).toHaveLength(0);
    const line = lastAudit(s);
    expect(line.decision).toBe('deny');
    expect(JSON.stringify(line)).not.toContain(STRANGER);
  });

  test('deny: out-of-scope id in fields, message or error', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    for (const input of [
      { service: 'harbor', fields: { form_id: STRANGER } },
      { service: 'harbor', message: `failed for ${STRANGER}` },
      { service: 'harbor', error: `bad ${STRANGER}` },
    ]) {
      const out = await s.call(input);
      expect(out.output.status).toBe('refused');
    }
    expect(s.storeCalls).toHaveLength(0);
  });

  test('a correlation id is allowed once an earlier result in the run showed it (D77)', async () => {
    const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const s = setup({ fixture: { hits: [{ ...HIT_A, x_req_id: REQ_ID }], num_hits: 1, window: REQUEST_WINDOW, truncated: false } });
    const before = await s.call({ fields: { x_req_id: REQ_ID } });
    expect(before.output.status).toBe('refused');
    expect(before.output.message).toContain('only once an earlier logs_search result in this run has shown it');
    dataOf(await s.call({ service: 'harbor', terms: [CUSTOMER] }));
    dataOf(await s.call({ fields: { x_req_id: REQ_ID } }));
    dataOf(await s.call({ terms: [REQ_ID] }));
    // The same value in another field or inside a message keeps the chain rule.
    expect((await s.call({ fields: { form_id: REQ_ID } })).output.status).toBe('refused');
    expect((await s.call({ message: `failed for ${REQ_ID}` })).output.status).toBe('refused');
    // Another run has not seen it.
    expect((await setup({ fixture: HITS_FIXTURE }).call({ fields: { x_req_id: REQ_ID } })).output.status).toBe('refused');
  });

  test('on ATSPL an x-txn-id UUID seen in a hit is searched as a term (D76, D77)', async () => {
    const TXN_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
    const s = setup({
      entity: 'atspl',
      fixture: { hits: [{ ...HIT_A, service: 'package', 'x-txn-id': TXN_ID }], num_hits: 1, window: REQUEST_WINDOW, truncated: false },
    });
    const before = await s.call({ terms: [TXN_ID] });
    expect(before.output.status).toBe('refused');
    expect(before.output.message).toContain('only once an earlier logs_search result in this run has shown it');
    dataOf(await s.call({ terms: [CUSTOMER] }));
    const walk = dataOf(await s.call({ terms: [TXN_ID], order: 'oldest' }));
    expect(walk.query).toBe(`'${TXN_ID}'`);
    // The field form is refused by the builder, which points at terms.
    const field = await s.call({ fields: { 'x-txn-id': TXN_ID } });
    expect(field.output.status).toBe('refused');
    expect(field.output.message).toContain('on atspl search a UUID as a term');
  });

  test('deny: out-of-scope id in any_of, exclude or contains', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    for (const input of [
      { terms: ['x'], any_of: [{ terms: [CUSTOMER, STRANGER] }] },
      { terms: [CUSTOMER], any_of: [{ message: [`failed for ${STRANGER}`] }] },
      { terms: [CUSTOMER], exclude: [STRANGER] },
      { contains: STRANGER },
    ]) {
      const out = await s.call(input);
      expect(out.output.status).toBe('refused');
      expect(out.output.message).toContain('not in the run');
    }
    expect(s.storeCalls).toHaveLength(0);
  });

  test('deny: denoise outside ssfb, with the reason', async () => {
    const s = setup({ entity: 'atspl', fixture: HITS_FIXTURE });
    const out = await s.call({ denoise: 'only' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('denoise is for ssfb only');
  });

  test('no service and a term from the ID chain runs; the key has no service', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ terms: [CUSTOMER] });
    expect(out.output.status).toBe('ok');
    expect(s.storeCalls).toHaveLength(1);
    expect(s.storeCalls[0]?.key_string).not.toContain('"service"');
    expect(lastAudit(s).summary_redacted).toContain('ssfb:all services');
  });

  test('an id term from the ID chain is allowed', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor', terms: [CUSTOMER] });
    expect(out.output.status).toBe('ok');
    expect(s.storeCalls).toHaveLength(1);
  });

  test('deny: systemic without count/group_by', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor', message: 'doc fetch failed', scope: 'systemic' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('systemic');
    expect(s.storeCalls).toHaveLength(0);
  });

  test('systemic with count or group_by passes, and an id outside the chain is still refused (D76)', async () => {
    const s = setup({ fixture: { count: 7, num_hits: 7, window: REQUEST_WINDOW, truncated: false } });
    const count = await s.call({ service: 'harbor', message: 'failed', count: true, scope: 'systemic' });
    expect(dataOf(count).count).toBe(7);
    const s2 = setup({ fixture: { groups: [{ key: 'error', count: 3 }], num_hits: 3, window: REQUEST_WINDOW, truncated: false } });
    const grouped = await s2.call({ service: 'harbor', message: 'failed', group_by: ['level'], scope: 'systemic' });
    expect(dataOf(grouped).groups).toEqual([{ key: 'error', count: 3 }]);
    const foreign = await s2.call({ terms: [STRANGER], group_by: ['form_id', 'x_req_id', 'message', 'error'], scope: 'systemic' });
    expect(foreign.output.status).toBe('refused');
    expect(foreign.output.message).toContain('scope "systemic" does not lift the id check');
  });

  test('deny: a to after now and from after to', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const future = await s.call({ service: 'harbor', message: 'x', to: '2026-10-01' });
    expect(future.output.status).toBe('refused');
    const reversed = await s.call({ service: 'harbor', message: 'x', from: '2026-09-22T10:00:00Z', to: '2026-09-22T09:00:00Z' });
    expect(reversed.output.status).toBe('refused');
    expect(s.storeCalls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ clamp and window

describe('max_hits and window', () => {
  test('max_hits clamp', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed', max_hits: 100_000 }));
    expect(out.notes).toEqual([expect.stringContaining('max_hits clamped to 250')]);

    // Real path: the clamped value is what reaches qw argv.
    const exec = qwRunner(JSON.stringify({ num_hits: 1, hits: [HIT_A] }));
    const h = home();
    const connector = createQuickwitConnector({ registry: h.registry, config: h.config, exec, fetchImpl: noFetch, backoffMs: 0 });
    const real = setup({ h, mockMode: false, connector });
    const data = dataOf(await real.call({ service: 'harbor', message: 'doc fetch failed', max_hits: 100_000 }));
    expect(data.notes).toEqual([expect.stringContaining('max_hits clamped to 250')]);
    // A count first, then the page.
    expect(exec.argv[0]?.[0]).toBe('count');
    const argv = exec.argv[1] ?? [];
    expect(argv[argv.indexOf('--max-hits') + 1]).toBe('250');
  });

  test('a fixture with more hits than max_hits is cut to max_hits and marked truncated', async () => {
    const s = setup({ fixture: { hits: [HIT_A, HIT_B, HIT_C], num_hits: 3, window: REQUEST_WINDOW, truncated: false } });
    const out = dataOf(await s.call({ service: 'harbor', message: 'failed', max_hits: 2 }));
    expect(out.hits).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.num_hits).toBe(3);
  });

  test('default window applied', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    // The fixture's recorded window is replaced by this call's window.
    expect(out.window).toEqual(REQUEST_WINDOW);
    expect(out.window_note).toBeUndefined();
  });

  test('without a request window on the run, the lookback days up to now are used', async () => {
    const s = setup({ fixture: HITS_FIXTURE, requestWindow: null });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    const days = s.h.config.budgets.defaultLookbackDays;
    expect(out.window).toEqual({ from: new Date(NOW.getTime() - days * 86_400_000).toISOString(), to: NOW.toISOString() });
  });

  test('an explicit from/to is applied and returned', async () => {
    const s = setup({ fixture: HITS_FIXTURE, h: home({ overrides: HTTP_ENV }) });
    const out = dataOf(await s.call({ service: 'harbor', message: 'x', from: '2026-09-22T00:00:00Z', to: '2026-09-22T06:00:00Z' }));
    expect(out.window).toEqual({ from: '2026-09-22T00:00:00.000Z', to: '2026-09-22T06:00:00.000Z' });
    expect(out.window_note).toBeUndefined();
  });
});

// ------------------------------------------------------------------ concurrency

describe('per-entity concurrency cap', () => {
  test('same-entity calls serialise through the connector slot, with no second acquire in the tool', async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    let acquires = 0;
    const slots = new Set<Entity>();
    const wrapSlot = (entity: Entity) => {
      const slot = quickwitSlot(entity, 1);
      if (!slots.has(entity)) {
        slots.add(entity);
        const acquire = slot.acquire.bind(slot);
        (slot as { acquire: typeof slot.acquire }).acquire = (signal) => {
          acquires += 1;
          return acquire(signal);
        };
      }
      return slot;
    };
    let n = 0;
    // A fake connector that holds the real per-entity slot, like the real one.
    const connector: QuickwitConnector = {
      async search(cctx, entity, _input, requestWindow) {
        n += 1;
        const id = `${entity}#${n}`;
        events.push(`enter ${id}`);
        return wrapSlot(entity).run(async () => {
          events.push(`start ${id}`);
          await new Promise((r) => setTimeout(r, 1000));
          events.push(`end ${id}`);
          const out: QuickwitSearchOutcome = {
            data: { hits: [], offset: 0, num_hits: 0, window: requestWindow, truncated: false },
            transport: 'real',
            target_env: envVarName(`${entity.toUpperCase()}_QW_CONTEXT`),
            taken_at: cctx.now().toISOString(),
            duration_ms: 0,
            meta: { quickwit_transport: 'qw', started_at: cctx.now().toISOString(), attempts: 1 },
          };
          return out;
        }, cctx.signal);
      },
    };
    const h = home();
    const ssfb1 = setup({ h, mockMode: false, connector });
    const ssfb2 = setup({ h, mockMode: false, connector });
    const atspl = setup({ h, entity: 'atspl', mockMode: false, connector });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 200; i++) await Promise.resolve();
    };

    const p1 = ssfb1.call({ service: 'harbor', message: 'doc fetch failed' });
    await flush();
    const p2 = ssfb2.call({ service: 'harbor', message: 'doc fetch failed' });
    const p3 = atspl.call({ service: 'package', message: 'doc fetch failed' });
    await flush();

    // Both ssfb calls reached the connector: the tool did not hold them back.
    expect(events).toContain('enter ssfb#1');
    expect(events).toContain('enter ssfb#2');
    expect(events).toContain('start ssfb#1');
    expect(events).not.toContain('start ssfb#2');
    // A call on another entity is not blocked by ssfb's slot.
    expect(events).toContain('start atspl#3');
    expect(quickwitSlot('ssfb', 1).stats()).toEqual({ active: 1, waiting: 1 });

    jest.advanceTimersByTime(1000);
    await flush();
    expect(events).toContain('end ssfb#1');
    expect(events).toContain('end atspl#3');
    expect(events).toContain('start ssfb#2');
    expect(events.indexOf('start ssfb#2')).toBeGreaterThan(events.indexOf('end ssfb#1'));

    jest.advanceTimersByTime(1000);
    await flush();
    const outs = await Promise.all([p1, p2, p3]);
    for (const out of outs) expect(out.output.status).toBe('ok');
    // One acquire per connector call; the tool took none of its own.
    expect(acquires).toBe(3);
    expect(quickwitSlot('ssfb', 1).stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('real mode without a Quickwit connector answers not configured', async () => {
    const s = setup({ mockMode: false });
    const out = await s.call({ service: 'harbor', message: 'doc fetch failed' });
    expect(out.output.status).toBe('not_configured');
    expect(out.output.message).toBe('not configured for ssfb:logs');
  });

  test('mock mode never calls the connector', async () => {
    let called = 0;
    const connector: QuickwitConnector = {
      search: () => {
        called += 1;
        return Promise.reject(new Error('must not run'));
      },
    };
    const s = setup({ fixture: HITS_FIXTURE, connector });
    expect((await s.call({ service: 'harbor', message: 'doc fetch failed' })).output.status).toBe('ok');
    expect(called).toBe(0);
  });
});

// ------------------------------------------------------------------ transports

describe('qw and http transports', () => {
  test('same envelope and fixture key for qw and http (mock mode)', async () => {
    const qw = setup({ fixture: HITS_FIXTURE });
    const http = setup({ fixture: HITS_FIXTURE, h: home({ overrides: HTTP_ENV }) });
    const input = { service: 'harbor', message: 'doc fetch failed', terms: [CUSTOMER], level: 'error' };
    const a = await qw.call(input);
    const b = await http.call(input);
    expect(qw.storeCalls).toHaveLength(1);
    expect(http.storeCalls).toEqual(qw.storeCalls);
    expect(qw.storeCalls[0]?.key_string).not.toMatch(/qw|http|transport|logs-v1/);
    expect(a).toEqual(b);
    expect(lastAudit(qw).transport).toBe('mock');
  });

  test('same envelope shape for qw and http (real path through fake transports)', async () => {
    const body = { num_hits: 2, hits: [HIT_A, { ...HIT_B, kubernetes: { pod: 'p1' } }] };
    const qwHome = home();
    const httpHome = home({ overrides: HTTP_ENV });
    const exec = qwRunner(JSON.stringify(body));
    const fetchImpl = fetchReturning(body);
    const qwConnector = createQuickwitConnector({ registry: qwHome.registry, config: qwHome.config, exec, fetchImpl: noFetch, backoffMs: 0 });
    const httpConnector = createQuickwitConnector({ registry: httpHome.registry, config: httpHome.config, exec: noExec, fetchImpl, backoffMs: 0 });
    const qw = setup({ h: qwHome, mockMode: false, connector: qwConnector });
    const http = setup({ h: httpHome, mockMode: false, connector: httpConnector });
    const input = { service: 'harbor', message: 'doc fetch failed' };
    const a = await qw.call(input);
    const b = await http.call(input);
    // qw counts first; the http page carries num_hits.
    expect(exec.argv).toHaveLength(2);
    expect(fetchImpl.calls).toBe(1);
    expect(a).toEqual(b);
    const data = dataOf(a);
    expect(Object.keys(data).sort()).toEqual(['hits', 'num_hits', 'offset', 'query', 'truncated', 'window']);
    expect(data.query).toBe("service:harbor AND 'doc fetch failed'");
    // The transport never reaches the model.
    expect(JSON.stringify(a)).not.toMatch(/quickwit_transport|"qw"|"http"/);
    expect(lastAudit(qw).transport).toBe('real');
    expect(lastAudit(qw).summary_redacted).toContain('via qw');
    expect(lastAudit(http).summary_redacted).toContain('via http');
  });

  test('a query Quickwit rejects reaches the model with its reason on both transports', async () => {
    const reason = 'failed to parse query: `service:harbor AND (`. unexpected end of input';
    const qwHome = home();
    const httpHome = home({ overrides: HTTP_ENV });
    const exec: ExecRunner = {
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: `Error: HTTP 400 Bad Request from ${FAKE_URL}: ${reason}`,
        timedOut: false,
        truncated: false,
        aborted: false,
      }),
    };
    const fetchImpl = (async () => new Response(JSON.stringify({ message: reason }), { status: 400 })) as unknown as FetchLike;
    const qw = setup({ h: qwHome, mockMode: false, connector: createQuickwitConnector({ registry: qwHome.registry, config: qwHome.config, exec, fetchImpl: noFetch, backoffMs: 0 }) });
    const http = setup({ h: httpHome, mockMode: false, connector: createQuickwitConnector({ registry: httpHome.registry, config: httpHome.config, exec: noExec, fetchImpl, backoffMs: 0 }) });
    for (const s of [qw, http]) {
      const env = await s.call({ service: 'harbor', message: 'doc fetch failed' });
      expect(env.output.status).toBe('refused');
      const message = env.output.status === 'refused' ? env.output.message : '';
      expect(message).toContain(reason);
      expect(message).toContain('retry');
      expect(message).not.toContain('quickwit.example.test');
      expect(lastAudit(s).reason).toContain('failed to parse query');
    }
  });

  test('a window that ends before now is sent whole, with no upper-bound note', async () => {
    const qw = setup({ fixture: HITS_FIXTURE, requestWindow: PAST_REQUEST_WINDOW });
    const out = dataOf(await qw.call({ service: 'harbor', message: 'doc fetch failed' }));
    expect(out.window).toEqual(PAST_REQUEST_WINDOW);
    expect(out.window_note).toBeUndefined();

    const h = home();
    const exec = qwRunner(JSON.stringify({ num_hits: 1, hits: [HIT_A] }));
    const connector = createQuickwitConnector({ registry: h.registry, config: h.config, exec, fetchImpl: noFetch, backoffMs: 0 });
    const s = setup({ h, mockMode: false, connector, requestWindow: PAST_REQUEST_WINDOW });
    const real = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    expect(real.window_note).toBeUndefined();
    for (const argv of exec.argv) {
      expect(argv).not.toContain('--since');
      expect([argv[argv.indexOf('--from') + 1], argv[argv.indexOf('--to') + 1]]).toEqual(['2026-09-21T10:00:00Z', '2026-09-22T10:00:00Z']);
    }
  });

  test('a connection reset reaches the model as unreachable with the reason, not as 0 hits', async () => {
    const h = home({ overrides: HTTP_ENV });
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    }) as unknown as FetchLike;
    const s = setup({ h, mockMode: false, connector: createQuickwitConnector({ registry: h.registry, config: h.config, exec: noExec, fetchImpl, backoffMs: 0 }) });
    const env = await s.call({ service: 'harbor', message: 'doc fetch failed' });
    expect(env.output.status).toBe('unreachable');
    const message = env.output.status === 'unreachable' ? env.output.message : '';
    expect(message).toContain('read ECONNRESET');
    expect(message).not.toContain('0 hits');
  });
});

// ------------------------------------------------------------------ paging

describe('per-run call cap', () => {
  test('the 51st logs_search call in a run is refused with the cap; other tools are not held back', async () => {
    const s = setup({ fixture: HITS_FIXTURE, budgetFromConfig: true });
    expect(s.h.config.budgets.maxLogCallsPerRun).toBe(50);
    for (let i = 0; i < 50; i++) dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    const out = await s.call({ service: 'harbor', message: 'doc fetch failed' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toBe(
      'logs_search refused: this run has used all 50 of its logs_search calls (TRIAGE_MAX_LOG_CALLS_PER_RUN=50). ' +
        'Other tools still work; finish with the evidence you have.',
    );
    expect(lastAudit(s)).toMatchObject({ decision: 'deny', reason: 'budget: tool_cap' });
    expect(s.storeCalls).toHaveLength(50);
  });
});

describe('paging and the 5,000-hit early return', () => {
  test('a page carries offset and next_offset; the last page has no next_offset', async () => {
    const more = setup({ fixture: { hits: [HIT_A, HIT_B], num_hits: 300, window: REQUEST_WINDOW, truncated: true } });
    expect(dataOf(await more.call({ service: 'harbor', message: 'failed', offset: 250 }))).toMatchObject({ offset: 250, next_offset: 252, num_hits: 300 });
    const last = setup({ fixture: { hits: [HIT_A, HIT_B], num_hits: 252, window: REQUEST_WINDOW, truncated: true } });
    const out = dataOf(await last.call({ service: 'harbor', message: 'failed', offset: 250 }));
    expect(out.offset).toBe(250);
    expect(out.next_offset).toBeUndefined();
  });

  test('the result carries the query that was built', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed', exclude: ['kong noise'] }));
    expect(out.query).toBe("service:harbor AND 'doc fetch failed' AND NOT 'kong noise'");
  });

  test('over 5,000 hits: an ordinary ok result with no hits and the reason, for a search and a tally', async () => {
    const s = setup({ fixture: { hits: [HIT_A], num_hits: 12_431, window: REQUEST_WINDOW, truncated: true } });
    const env = await s.call({ service: 'harbor', message: 'failed' });
    const out = dataOf(env);
    expect(out.hits).toEqual([]);
    expect(out.truncated).toBe(true);
    expect(out.reason).toBe(
      '12,431 hits for this query in 2026-09-21T10:00:00.000Z..2026-09-23T10:00:00.000Z (UTC), over the 5,000 hits a search pages through. ' +
        'No hits were read. Narrow the window, add an id or field filter, or use count or group_by first.',
    );
    const g = setup({ fixture: { groups: [{ key: 'error', count: 6000 }], num_hits: 6000, window: REQUEST_WINDOW, truncated: false } });
    const grouped = dataOf(await g.call({ service: 'harbor', message: 'failed', group_by: ['level'] }));
    expect(grouped).toMatchObject({ groups: [], tally_base: 0, num_hits: 6000, truncated: true });
    expect(String(grouped.reason)).toContain('6,000 hits');
    // A count has no limit.
    const c = setup({ fixture: { count: 9000, num_hits: 9000, window: REQUEST_WINDOW, truncated: false } });
    expect(dataOf(await c.call({ service: 'harbor', message: 'failed', count: true })).reason).toBeUndefined();
  });

  test('a tally states its base, and count_distinct comes back as distinct', async () => {
    const s = setup({
      fixture: { groups: [{ key: 'error | timeout', count: 3 }], distinct: { field: 'form_id', count: 2 }, tally_base: 3, num_hits: 3, window: REQUEST_WINDOW, truncated: false },
    });
    const out = dataOf(await s.call({ service: 'harbor', message: 'failed', group_by: ['level', 'error'], count_distinct: 'form_id' }));
    expect(out).toMatchObject({ groups: [{ key: 'error | timeout', count: 3 }], distinct: { field: 'form_id', count: 2 }, tally_base: 3 });
    expect(lastAudit(s).summary_redacted).toContain('1 groups, 2 distinct form_id over 3 hits');
  });
});

// ------------------------------------------------------------------ not configured

describe('not configured', () => {
  test('not configured on blank config (blank index)', async () => {
    // RTL_QUICKWIT_INDEX is blank in .env.example.
    const s = setup({ entity: 'rtl', fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'workflow', message: 'doc fetch failed' });
    expect(out.output.status).toBe('not_configured');
    expect(out.output.message).toBe('not configured for rtl:logs');
    expect(s.storeCalls).toHaveLength(0);
    const line = lastAudit(s);
    expect(line.decision).toBe('deny');
    expect(line.target).toBe('RTL_QUICKWIT_INDEX');
  });

  test('not configured on a blank transport', async () => {
    const s = setup({ fixture: HITS_FIXTURE, h: home({ overrides: { SSFB_QUICKWIT_TRANSPORT: '' } }) });
    const out = await s.call({ service: 'harbor', message: 'doc fetch failed' });
    expect(out.output.status).toBe('not_configured');
    expect(out.output.message).toBe('not configured for ssfb:logs');
  });

  test('not configured on http with a blank URL, even for a query the gate would refuse', async () => {
    const s = setup({ fixture: HITS_FIXTURE, h: home({ overrides: { SSFB_QUICKWIT_TRANSPORT: 'http' } }) });
    const out = await s.call({ service: 'harbor' });
    expect(out.output.status).toBe('not_configured');
    expect(out.output.message).toBe('not configured for ssfb:logs');
  });
});

// ------------------------------------------------------------------ normalize

describe('normalize', () => {
  test('folds group keys that differ only by numbers', () => {
    expect(
      foldGroups([
        { key: 'doc fetch failed for form 12345678', count: 2 },
        { key: 'doc fetch failed for form 87654321', count: 1 },
        { key: 'timeout', count: 5 },
      ]),
    ).toEqual([
      { key: 'timeout', count: 5 },
      { key: 'doc fetch failed for form <num>', count: 3 },
    ]);
  });

  test('group_by with normalize folds groups; a hits search gets message_groups', async () => {
    const grouped = setup({
      fixture: {
        groups: [
          { key: 'doc fetch failed for form 12345678', count: 2 },
          { key: 'doc fetch failed for form 87654321', count: 1 },
        ],
        num_hits: 3,
        window: REQUEST_WINDOW,
        truncated: false,
      },
    });
    const g = dataOf(await grouped.call({ service: 'harbor', message: 'failed', group_by: ['message'], normalize: true }));
    expect(g.groups).toEqual([{ key: 'doc fetch failed for form <num>', count: 3 }]);

    const hits = setup({ fixture: { hits: [HIT_A, HIT_B, HIT_C], num_hits: 3, window: REQUEST_WINDOW, truncated: false } });
    const out = dataOf(await hits.call({ service: 'harbor', message: 'failed', normalize: true }));
    expect(out.hits).toHaveLength(3);
    expect(out.message_groups).toEqual([
      { key: 'doc fetch failed for form <num>', count: 2 },
      { key: 'timeout calling workflow', count: 1 },
    ]);
  });
});

// ------------------------------------------------------------------ zero hits

describe('zero hits', () => {
  test('a 0-hit result says what to try next, in order', async () => {
    const s = setup({ fixture: { hits: [], num_hits: 0, window: REQUEST_WINDOW, truncated: false } });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed', level: 'error' }));
    expect(out.notes).toEqual([
      '0 hits. Try next, in this order: drop the service filter; run group_by: ["service"] for the same terms; move from earlier; drop level.',
    ]);
  });

  test('steps that do not apply are left out, and counts and groups get the note too', async () => {
    const count = setup({ fixture: { count: 0, num_hits: 0, window: REQUEST_WINDOW, truncated: false } });
    expect(dataOf(await count.call({ message: 'doc fetch failed', count: true })).notes).toEqual([
      '0 hits. Try next, in this order: run group_by: ["service"] for the same terms; move from earlier.',
    ]);
    const grouped = setup({ fixture: { groups: [], num_hits: 0, window: REQUEST_WINDOW, truncated: false } });
    expect(dataOf(await grouped.call({ message: 'doc fetch failed', group_by: ['service'] })).notes).toEqual([
      '0 hits. Try next, in this order: move from earlier.',
    ]);
  });

  test('a service with no lines at all in the window gets its own note', async () => {
    const s = setup({ fixture: { hits: [], num_hits: 0, window: REQUEST_WINDOW, truncated: false, service_absent: true } });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    expect(out.notes).toContain(
      `service harbor has no lines at all in this index in ${REQUEST_WINDOW.from}..${REQUEST_WINDOW.to}: the name may be wrong ` +
        'or it logs elsewhere; run group_by: ["service"] without the service filter to see the names that do log',
    );
    expect(out.service_absent).toBeUndefined();
  });

  test('the real path counts the service alone after a 0-hit result, and only then', async () => {
    const h = home({ overrides: HTTP_ENV });
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ num_hits: 0, hits: [] }), { status: 200 });
    }) as FetchLike;
    const connector = createQuickwitConnector({ registry: h.registry, config: h.config, exec: noExec, fetchImpl });
    const s = setup({ h, mockMode: false, connector });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    expect(bodies.map((b) => (JSON.parse(b) as { query: string }).query)).toEqual(["service:harbor AND 'doc fetch failed'", 'service:harbor']);
    expect((out.notes as string[]).some((n) => n.startsWith('service harbor has no lines at all'))).toBe(true);
    bodies.length = 0;
    await s.call({ message: 'doc fetch failed' });
    expect(bodies).toHaveLength(1);
  });

  test('a result with hits has no zero-hit note', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    expect(dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' })).notes).toBeUndefined();
  });
});

// ------------------------------------------------------------------ misc

describe('envelope and staging', () => {
  test('a fixture miss (non-strict) is refused with a gap message', async () => {
    const s = setup({ fixture: null });
    const out = await s.call({ service: 'harbor', message: 'doc fetch failed' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('No logs_search fixture');
  });

  test('the full result is staged to /data when a harness is present', async () => {
    const writes: { path: string; text: string }[] = [];
    const h = home();
    const runId = `run_logs_stage_${Math.random().toString(36).slice(2, 8)}`;
    const budget = createRunBudget({ runId, maxToolCalls: 5, maxTasks: 1, maxRowsPerCall: 10, maxBytesPerCall: 100_000, maxBytesPerRun: 1_000_000 });
    cleanups.push(() => {
      releaseRunBudget(runId);
      releaseEscalation(runId);
    });
    const store: FixtureStore = {
      fixturesDir: '/triage-test/fixtures',
      async get(kind) {
        return { scope: 'shared', path: '/x.json', hash: '0123456789abcdef', fixture: { kind, result: HITS_FIXTURE } as never };
      },
      async list() {
        return [];
      },
    };
    const deps = createToolDeps({
      runId,
      config: h.config,
      registry: h.registry,
      interface: 'cli',
      idChain: CHAIN,
      connectors: {},
      runStore: {} as RunStore,
      budget,
      audit: createMemoryAuditSink(),
      fixtures: createMockLayer(h.config, { store }),
      now: () => new Date(NOW),
      requestWindow: REQUEST_WINDOW,
    });
    const tool = toolModule.create(makeToolContext({ config: h.config, registry: h.registry, entity: 'ssfb', runId, deps }), 'investigator');
    const harness = { sandbox: { writeFile: async (path: string, text: string) => void writes.push({ path, text }) } };
    const data = v.parse(LogsSearchInputSchema, { service: 'harbor', message: 'doc fetch failed' });
    const out = v.parse(
      ToolEnvelopeSchema,
      await tool.run({ data, toolCallId: 'toolu_stage_1', log: { info() {}, warn() {}, error() {} }, harness } as never),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/data/toolu_stage_1.json');
    expect(dataOf(out).staged_file).toBe('/data/toolu_stage_1.json');
  });

  test('an aborted signal throws before any check', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const ac = new AbortController();
    ac.abort();
    await expect(s.call({ service: 'harbor', message: 'x' }, { signal: ac.signal })).rejects.toBeDefined();
    expect(s.audit.lines).toHaveLength(0);
  });
});
