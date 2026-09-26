import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import * as v from 'valibot';
import { releaseEscalation } from '../../src/agents/escalation.ts';
import type { ExecResult, ExecRunner } from '../../src/connectors/exec.ts';
import {
  createQuickwitConnector,
  START_ONLY_WINDOW_NOTE,
  type QuickwitConnector,
  type QuickwitSearchOutcome,
} from '../../src/connectors/quickwit/client.ts';
import type { FetchLike } from '../../src/connectors/quickwit/http-transport.ts';
import { envVarName } from '../../src/connectors/types.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../src/gate/audit-sink.ts';
import { createRunBudget, releaseRunBudget } from '../../src/gate/budget.ts';
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
};

function setup(opts: SetupOptions = {}): Setup {
  const h = opts.h ?? home();
  const entity = opts.entity ?? 'ssfb';
  seq += 1;
  const runId = `run_logs_${seq}_${Math.random().toString(36).slice(2, 8)}`;
  const budget = createRunBudget({
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
    budget,
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

  test('logsModeOf maps count and group_by', () => {
    expect(logsModeOf({})).toBe('search');
    expect(logsModeOf({ count: true })).toBe('count');
    expect(logsModeOf({ group_by: 'level' })).toBe('group_by');
  });
});

// ------------------------------------------------------------------ denies

describe('gate denies', () => {
  test('deny: service-only query', async () => {
    const s = setup({ fixture: HITS_FIXTURE });
    const out = await s.call({ service: 'harbor' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toContain('service alone is not selective enough');
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
    const g = await s.call({ service: 'harbor', message: 'failed', group_by: 'nope' });
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

  test('systemic with count or group_by passes, even with an id outside the chain', async () => {
    const s = setup({ fixture: { count: 7, num_hits: 7, window: REQUEST_WINDOW, truncated: false } });
    const count = await s.call({ service: 'harbor', terms: [STRANGER], count: true, scope: 'systemic' });
    expect(dataOf(count).count).toBe(7);
    const s2 = setup({ fixture: { groups: [{ key: 'error', count: 3 }], num_hits: 3, window: REQUEST_WINDOW, truncated: false } });
    const grouped = await s2.call({ service: 'harbor', message: 'failed', group_by: 'level', scope: 'systemic' });
    expect(dataOf(grouped).groups).toEqual([{ key: 'error', count: 3 }]);
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
    expect(out.notes).toEqual([expect.stringContaining('max_hits clamped to 500')]);

    // Real path: the clamped value is what reaches qw argv.
    const exec = qwRunner(JSON.stringify({ num_hits: 1, hits: [HIT_A] }));
    const h = home();
    const connector = createQuickwitConnector({ registry: h.registry, config: h.config, exec, fetchImpl: noFetch, backoffMs: 0 });
    const real = setup({ h, mockMode: false, connector });
    const data = dataOf(await real.call({ service: 'harbor', message: 'doc fetch failed', max_hits: 100_000 }));
    expect(data.notes).toEqual([expect.stringContaining('max_hits clamped to 500')]);
    const argv = exec.argv[0] ?? [];
    expect(argv[argv.indexOf('--max-hits') + 1]).toBe('500');
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
            data: { hits: [], num_hits: 0, window: requestWindow, truncated: false },
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
    expect(exec.argv).toHaveLength(1);
    expect(fetchImpl.calls).toBe(1);
    expect(a).toEqual(b);
    const data = dataOf(a);
    expect(Object.keys(data).sort()).toEqual(['hits', 'num_hits', 'truncated', 'window']);
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

  test('qw upper-bound note', async () => {
    const qw = setup({ fixture: HITS_FIXTURE, requestWindow: PAST_REQUEST_WINDOW });
    const out = dataOf(await qw.call({ service: 'harbor', message: 'doc fetch failed' }));
    expect(out.window).toEqual(PAST_REQUEST_WINDOW);
    expect(out.window_note).toBe(START_ONLY_WINDOW_NOTE);
    expect(String(out.window_note)).toContain('upper bound dropped');

    const explicit = dataOf(await qw.call({ service: 'harbor', message: 'x', from: '2d', to: '1d' }));
    expect(explicit.window_note).toBe(START_ONLY_WINDOW_NOTE);

    // http takes both bounds, so there is no note.
    const http = setup({ fixture: HITS_FIXTURE, requestWindow: PAST_REQUEST_WINDOW, h: home({ overrides: HTTP_ENV }) });
    expect(dataOf(await http.call({ service: 'harbor', message: 'doc fetch failed' })).window_note).toBeUndefined();
  });

  test('qw upper-bound note on the real path', async () => {
    const h = home();
    const exec = qwRunner(JSON.stringify({ num_hits: 1, hits: [HIT_A] }));
    const connector = createQuickwitConnector({ registry: h.registry, config: h.config, exec, fetchImpl: noFetch, backoffMs: 0 });
    const s = setup({ h, mockMode: false, connector, requestWindow: PAST_REQUEST_WINDOW });
    const out = dataOf(await s.call({ service: 'harbor', message: 'doc fetch failed' }));
    expect(out.window_note).toBe(START_ONLY_WINDOW_NOTE);
    expect(exec.argv[0]).toContain('--since');
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
    const g = dataOf(await grouped.call({ service: 'harbor', message: 'failed', group_by: 'message', normalize: true }));
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
