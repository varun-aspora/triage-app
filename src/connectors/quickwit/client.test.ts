import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeTestHome, SSFB_QW_ENV, type TestHome, type TestHomeOptions } from '../../../test/support/home.ts';
import { quickwitSlot, resetQuickwitSlotsForTests } from '../../gate/semaphore.ts';
import { keyHash, keyString, semanticKey, type LogsSearchFacts } from '../../mock/key.ts';
import { createFixtureStore } from '../../mock/store.ts';
import type { Entity, TimeWindow } from '../../types/core.ts';
import type { ExecOptions, ExecResult, ExecRunner } from '../exec.ts';
import { createFakeRunner } from '../exec-fake.ts';
import { mockPortFromFixtures, type MockPort } from '../mock.ts';
import { ConnectorError, type ConnectorContext } from '../types.ts';
import {
  createQuickwitConnector,
  START_ONLY_WINDOW_NOTE,
  type QuickwitConnectorDeps,
  type QuickwitSearchInput,
  type QuickwitSearchOutcome,
} from './client.ts';
import type { FetchLike } from './http-transport.ts';

// ------------------------------------------------------------------ setup

const NOW = new Date('2026-09-23T10:00:00.000Z');
const REQUEST_WINDOW: TimeWindow = { from: '2026-09-21T10:00:00.000Z', to: NOW.toISOString() };
const PAST_WINDOW: TimeWindow = { from: '2026-09-21T10:00:00.000Z', to: '2026-09-22T10:00:00.000Z' };
const RUN_ID = 'run-01TESTQUICKWIT';
const INPUT: QuickwitSearchInput = { service: 'harbor', message: 'doc fetch failed' };
const QUERY = 'service:harbor AND message:"doc fetch failed"';
const SSFB_FIELDS = 'service,level,message,error,raw_message,timestamp,x_req_id,x_txn_id,form_id,x-customer-id';
const FAKE_URL = 'http://quickwit.example.test:7080';

const homes: TestHome[] = [];
function home(options: TestHomeOptions = {}): TestHome {
  const h = makeTestHome(options);
  homes.push(h);
  return h;
}
const dirs: string[] = [];
afterAll(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => resetQuickwitSlotsForTests());

const QW_HOME = (): TestHome => home({ overrides: SSFB_QW_ENV });
const HTTP_HOME = (extra: Record<string, string> = {}): TestHome =>
  home({ overrides: { SSFB_QUICKWIT_TRANSPORT: 'http', SSFB_QUICKWIT_URL: FAKE_URL, SSFB_QUICKWIT_AUTH: 'none', ...extra } });

const REAL_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: true,
  lookup: () => Promise.reject(new Error('lookup must not run in real mode')),
});

function ctxWith(mock: MockPort = REAL_PORT, signal: AbortSignal = new AbortController().signal): ConnectorContext {
  return { signal, now: () => new Date(NOW), mock, runId: RUN_ID };
}

type Call = { bin: string; argv: readonly string[]; opts: ExecOptions; start: number; end: number };

/** A runner that answers from a handler, optionally after a delay, and records timings. */
function scriptedRunner(handler: (call: Call, n: number) => Partial<ExecResult>, delayMs = 0): ExecRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(bin, argv, opts) {
      const call: Call = { bin, argv: [...argv], opts, start: performance.now(), end: 0 };
      calls.push(call);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      call.end = performance.now();
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, aborted: false, ...handler(call, calls.length) };
    },
  };
}

function fetchSpy(respond: (url: string, init: RequestInit) => Response | Promise<Response>): FetchLike & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const noFetch = (): FetchLike & { calls: unknown[] } => fetchSpy(() => Promise.reject(new Error('fetch must not be called')));

function connector(h: TestHome, over: Partial<QuickwitConnectorDeps> = {}) {
  return createQuickwitConnector({ registry: h.registry, config: h.config, backoffMs: 0, ...over });
}

async function errorOf(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    return err as ConnectorError;
  }
  throw new Error('expected a ConnectorError');
}

function dataOf(out: QuickwitSearchOutcome): Record<string, unknown> {
  expect(out.fixture_miss).not.toBe(true);
  return out.data as unknown as Record<string, unknown>;
}

const HIT_A = { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T09:00:00Z', kubernetes: { pod: 'p1' } };
const HIT_B = { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T09:05:00Z', form_id: 'F-1' };

// ------------------------------------------------------------------ dispatch

describe('transport dispatch from the registry', () => {
  test('qw config runs QW_BIN with the entity context and never fetches', async () => {
    const h = QW_HOME();
    const fake = createFakeRunner([
      {
        bin: 'qw',
        argv: ['search', 'logs-v1', QUERY, '--since', '2d', '--max-hits', '500', '-o', 'json', '--fields', SSFB_FIELDS, '--context', 'ssfb-prod'],
        result: { stdout: JSON.stringify({ num_hits: 1, hits: [HIT_A] }) },
      },
    ]);
    const f = noFetch();
    const out = await connector(h, { exec: fake, fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    expect(fake.calls).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
    expect(out.transport).toBe('real');
    expect(String(out.target_env)).toBe('SSFB_QW_CONTEXT');
    expect(out.meta.quickwit_transport).toBe('qw');
    expect(out.meta.attempts).toBe(1);
    expect(fake.calls[0]?.argv).not.toContain(RUN_ID);
    expect(fake.calls[0]?.argv.join(' ')).not.toContain(RUN_ID);
  });

  test('http config POSTs to the URL and never runs a binary', async () => {
    const h = HTTP_HOME();
    const fake = createFakeRunner([]);
    const f = fetchSpy(() => new Response(JSON.stringify({ num_hits: 1, hits: [HIT_A] }), { status: 200 }));
    const out = await connector(h, { exec: fake, fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    expect(fake.calls).toHaveLength(0);
    expect(fake.unscripted).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${FAKE_URL}/api/v1/logs-v1/search`);
    expect(f.calls[0]?.init.body as string).not.toContain(RUN_ID);
    expect(String(out.target_env)).toBe('SSFB_QUICKWIT_URL');
    expect(out.meta.quickwit_transport).toBe('http');
  });

  test('a bearer http config sends the token from the registry', async () => {
    const h = home({
      overrides: {
        ATSPL_QUICKWIT_TRANSPORT: 'http',
        ATSPL_QUICKWIT_URL: 'https://proxy.example.test',
        ATSPL_QUICKWIT_AUTH: 'bearer',
        ATSPL_QUICKWIT_TOKEN: 'test-token-1',
      },
    });
    const f = fetchSpy(() => new Response(JSON.stringify({ num_hits: 0, hits: [] }), { status: 200 }));
    await connector(h, { fetchImpl: f }).search(ctxWith(), 'atspl', { service: 'package', terms: ['abc'] }, REQUEST_WINDOW);
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer test-token-1');
  });
});

// ---------------------------------------------------------- not configured

describe('not_configured', () => {
  const cases: [string, () => TestHome, Entity][] = [
    ['transport blank', () => home({ overrides: { SSFB_QUICKWIT_TRANSPORT: '' } }), 'ssfb'],
    ['index blank (RTL today)', () => QW_HOME(), 'rtl'],
    ['qw with a blank context', () => home({ overrides: { SSFB_QW_CONTEXT: '' } }), 'ssfb'],
    ['http with a blank URL', () => home({ overrides: { SSFB_QUICKWIT_TRANSPORT: 'http' } }), 'ssfb'],
    [
      'http bearer with a blank token',
      () => home({ overrides: { ATSPL_QUICKWIT_TRANSPORT: 'http', ATSPL_QUICKWIT_URL: 'https://proxy.example.test', ATSPL_QUICKWIT_AUTH: 'bearer' } }),
      'atspl',
    ],
    ['entity not enabled', () => home({ entities: ['ssfb'] }), 'atspl'],
  ];
  const inputFor = (e: Entity): QuickwitSearchInput =>
    e === 'ssfb' ? INPUT : e === 'atspl' ? { service: 'package', terms: ['abc'] } : { service: 'banking', terms: ['abc'] };

  for (const [label, make, entity] of cases) {
    test(`${label}: not_configured, nothing run or fetched, also in mock mode`, async () => {
      const h = make();
      const fake = createFakeRunner([]);
      const f = noFetch();
      let lookups = 0;
      const mockPort: MockPort = {
        enabled: true,
        strict: true,
        lookup: async () => {
          lookups += 1;
          return { hit: false, key_string: 'x', hash: '0000000000000000' };
        },
      };
      for (const port of [REAL_PORT, mockPort]) {
        const err = await errorOf(connector(h, { exec: fake, fetchImpl: f }).search(ctxWith(port), entity, inputFor(entity), REQUEST_WINDOW));
        expect(err.code).toBe('not_configured');
        expect(err.message).toContain(`not configured for ${entity}:logs`);
      }
      expect(fake.calls).toHaveLength(0);
      expect(fake.unscripted).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(lookups).toBe(0);
    });
  }
});

// ------------------------------------------------------------------ gate

describe('gate refusals', () => {
  test('a service-only query and a bad window are refused before any I/O', async () => {
    const h = QW_HOME();
    const fake = createFakeRunner([]);
    const c = connector(h, { exec: fake, fetchImpl: noFetch() });
    const e1 = await errorOf(c.search(ctxWith(), 'ssfb', { service: 'harbor' }, REQUEST_WINDOW));
    expect(e1.code).toBe('refused');
    const e2 = await errorOf(c.search(ctxWith(), 'ssfb', { ...INPUT, from: '2026-09-22', to: '2026-09-21' }, REQUEST_WINDOW));
    expect(e2.code).toBe('refused');
    const e3 = await errorOf(c.search(ctxWith(), 'ssfb', { service: 'harbor', terms: ['$(id)'] }, REQUEST_WINDOW));
    expect(e3.code).toBe('refused');
    expect(fake.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ retry

describe('retry once on timeout', () => {
  const timedOut = { exitCode: null, timedOut: true };
  const okOut = { stdout: JSON.stringify({ num_hits: 0, hits: [] }) };

  test('a timeout then an answer succeeds on the second attempt', async () => {
    const runner = scriptedRunner((_c, n) => (n === 1 ? timedOut : okOut));
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    expect(runner.calls).toHaveLength(2);
    expect(out.meta.attempts).toBe(2);
  });

  test('two timeouts give timeout after exactly two attempts', async () => {
    const runner = scriptedRunner(() => timedOut);
    const err = await errorOf(connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
    expect(err.code).toBe('timeout');
    expect(runner.calls).toHaveLength(2);
  });

  test('other errors are not retried', async () => {
    for (const result of [{ exitCode: 1, stderr: 'boom' }, { exitCode: 1, stderr: 'not logged in' }, { stdout: 'nope' }, { truncated: true }]) {
      const runner = scriptedRunner(() => result);
      await errorOf(connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
      expect(runner.calls).toHaveLength(1);
    }
  });

  test('http: a timeout is retried once, and a second timeout gives timeout', async () => {
    const h = HTTP_HOME({ TRIAGE_HTTP_TIMEOUT_MS: '20' });
    const hanging = fetchSpy(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
        }),
    );
    const err = await errorOf(connector(h, { fetchImpl: hanging }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
    expect(err.code).toBe('timeout');
    expect(hanging.calls).toHaveLength(2);

    const refusedOnce = fetchSpy(() => new Response('bad', { status: 400 }));
    await errorOf(connector(h, { fetchImpl: refusedOnce }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
    expect(refusedOnce.calls).toHaveLength(1);
  });

  test('the slot stays held through the backoff, so a waiting call runs after the retry', async () => {
    const order: string[] = [];
    let n = 0;
    const runner = scriptedRunner((c) => {
      n += 1;
      const who = c.argv.includes(QUERY) ? 'A' : 'B';
      order.push(`${who}${n}`);
      return who === 'A' && n === 1 ? timedOut : okOut;
    });
    const c = connector(QW_HOME(), { exec: runner, backoffMs: 20 });
    const a = c.search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    const b = c.search(ctxWith(), 'ssfb', { service: 'harbor', terms: ['other'] }, REQUEST_WINDOW);
    await Promise.all([a, b]);
    expect(order).toEqual(['A1', 'A2', 'B3']);
  });
});

// -------------------------------------------------------------- semaphore

describe('per-entity concurrency cap', () => {
  const answer = { stdout: JSON.stringify({ num_hits: 0, hits: [] }) };

  test('two concurrent searches on one entity with cap 1 never overlap', async () => {
    const runner = scriptedRunner(() => answer, 25);
    const c = connector(QW_HOME(), { exec: runner });
    await Promise.all([
      c.search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW),
      c.search(ctxWith(), 'ssfb', { service: 'harbor', terms: ['x'] }, REQUEST_WINDOW),
    ]);
    expect(runner.calls).toHaveLength(2);
    const [first, second] = [...runner.calls].sort((x, y) => x.start - y.start) as [Call, Call];
    expect(second.start).toBeGreaterThanOrEqual(first.end);
    expect(quickwitSlot('ssfb', 1).stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('searches on different entities do not wait for each other', async () => {
    const runner = scriptedRunner(() => answer, 25);
    const c = connector(QW_HOME(), { exec: runner });
    await Promise.all([
      c.search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW),
      c.search(ctxWith(), 'atspl', { service: 'package', terms: ['x'] }, REQUEST_WINDOW),
    ]);
    const [first, second] = [...runner.calls].sort((x, y) => x.start - y.start) as [Call, Call];
    expect(second.start).toBeLessThan(first.end);
  });

  test('the slot is released after a failure', async () => {
    const runner = scriptedRunner(() => ({ exitCode: 1 }));
    await errorOf(connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
    expect(quickwitSlot('ssfb', 1).stats()).toEqual({ active: 0, waiting: 0 });
  });
});

// --------------------------------------------------------- shared envelope

describe('one data shape for both transports', () => {
  async function both(
    input: QuickwitSearchInput,
    qwOut: unknown,
    httpOut: unknown,
    window: TimeWindow = REQUEST_WINDOW,
  ): Promise<[QuickwitSearchOutcome, QuickwitSearchOutcome]> {
    const runner = scriptedRunner(() => ({ stdout: JSON.stringify(qwOut) }));
    const f = fetchSpy(() => new Response(JSON.stringify(httpOut), { status: 200 }));
    const viaQw = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', input, window);
    const viaHttp = await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', input, window);
    return [viaQw, viaHttp];
  }

  function expectNeutral(out: QuickwitSearchOutcome): void {
    const text = JSON.stringify(out.data);
    expect(text).not.toMatch(/\bqw\b/i);
    expect(text).not.toMatch(/http/i);
    expect(Object.keys(dataOf(out))).not.toContain('transport');
  }

  test('search: same hits, projected to the allowlist, same counts', async () => {
    const body = { num_hits: 5, hits: [HIT_A, HIT_B] };
    const [a, b] = await both(INPUT, body, body);
    expect(dataOf(a)).toEqual(dataOf(b));
    expect(dataOf(a)).toEqual({
      hits: [
        { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T09:00:00Z' },
        { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T09:05:00Z', form_id: 'F-1' },
      ],
      num_hits: 5,
      window: REQUEST_WINDOW,
      truncated: true,
    });
    expect(a.fixture_miss !== true && a.truncated).toBe(true);
    expectNeutral(a);
    expectNeutral(b);
  });

  test('count: same shape', async () => {
    const [a, b] = await both({ ...INPUT, count: true }, { count: 17 }, { num_hits: 17, hits: [] });
    expect(dataOf(a)).toEqual(dataOf(b));
    expect(dataOf(a)).toEqual({ count: 17, num_hits: 17, window: REQUEST_WINDOW, truncated: false });
  });

  test('group_by: same groups', async () => {
    const qwOut = { num_hits: 3, hits: [{ error: 'e1' }, { error: 'e2' }, { error: 'e1' }] };
    const httpOut = { num_hits: 3, hits: [], aggregations: { groups: { buckets: [{ key: 'e1', doc_count: 2 }, { key: 'e2', doc_count: 1 }], sum_other_doc_count: 0 } } };
    const [a, b] = await both({ ...INPUT, group_by: 'error' }, qwOut, httpOut);
    expect(dataOf(a)).toEqual(dataOf(b));
    expect(dataOf(a).groups).toEqual([{ key: 'e1', count: 2 }, { key: 'e2', count: 1 }]);
  });

  test('a window that ends before now gets a note on qw that does not name the transport', async () => {
    const body = { num_hits: 0, hits: [] };
    const [a, b] = await both(INPUT, body, body, PAST_WINDOW);
    expect(dataOf(a).window).toEqual(PAST_WINDOW);
    expect(dataOf(a).window_note).toBe(START_ONLY_WINDOW_NOTE);
    expect(dataOf(b).window_note).toBeUndefined();
    expectNeutral(a);
  });

  test('builder notes such as a clamped max_hits are passed on', async () => {
    const body = { num_hits: 0, hits: [] };
    const [a, b] = await both({ ...INPUT, max_hits: 10_000 }, body, body);
    expect(dataOf(a).notes).toEqual(dataOf(b).notes);
    expect(String((dataOf(a).notes as string[])[0])).toContain('clamped');
  });
});

// ------------------------------------------------------------------ mock

describe('mock mode', () => {
  const FACTS: LogsSearchFacts = { entity: 'ssfb', service: 'harbor', terms: ['message:doc fetch failed'], mode: 'search' };
  const RECORDED = {
    hits: [{ service: 'harbor', message: 'doc fetch failed' }],
    num_hits: 1,
    window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' },
    truncated: false,
  };

  function fixturePort(strict = true): MockPort {
    const dir = mkdtempSync(join(tmpdir(), 'triage-qw-fixtures-'));
    dirs.push(dir);
    const key = semanticKey('logs_search', FACTS);
    const path = join(dir, 'shared', 'logs_search', 'ssfb', `${keyHash(key)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        kind: 'logs_search',
        entity: 'ssfb',
        key,
        key_string: keyString(key),
        result: RECORDED,
        meta: { source: 'hand', recorded_at: '2026-09-23T10:00:00.000Z' },
      }),
    );
    return mockPortFromFixtures({ settings: { mockMode: true, strict, record: false }, store: createFixtureStore({ fixturesDir: dir }) });
  }

  test('qw and http configs hit the same fixture; nothing is run or fetched', async () => {
    const port = fixturePort();
    for (const h of [QW_HOME(), HTTP_HOME()]) {
      const fake = createFakeRunner([]);
      const f = noFetch();
      const out = await connector(h, { exec: fake, fetchImpl: f }).search(ctxWith(port), 'ssfb', INPUT, REQUEST_WINDOW);
      expect(out.transport).toBe('mock');
      expect(fake.calls).toHaveLength(0);
      expect(fake.unscripted).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(out.meta.attempts).toBe(0);
      // The fixture's hits, this call's window.
      expect(dataOf(out)).toEqual({ ...RECORDED, window: REQUEST_WINDOW });
    }
  });

  test('the key facts are identical across transports and carry no transport detail', async () => {
    const seen: unknown[] = [];
    const spy: MockPort = {
      enabled: true,
      strict: false,
      lookup: async (_tool, keyInput) => {
        seen.push(keyInput);
        return { hit: false, key_string: 'k', hash: '0000000000000000' };
      },
    };
    const input: QuickwitSearchInput = { service: 'harbor', terms: ['b', 'a'], fields: { form_id: 'F-1' }, level: 'ERROR', group_by: 'error' };
    for (const h of [QW_HOME(), HTTP_HOME()]) {
      await connector(h, { exec: createFakeRunner([]), fetchImpl: noFetch() }).search(ctxWith(spy), 'ssfb', input, REQUEST_WINDOW);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(semanticKey('logs_search', seen[0] as LogsSearchFacts)).toEqual({
      entity: 'ssfb',
      service: 'harbor',
      terms: ['a', 'b', 'form_id:F-1', 'level:error'],
      mode: 'histogram',
      group_by: 'error',
    });
    const text = JSON.stringify(seen[0]);
    expect(text).not.toMatch(/qw|http|logs-v1|ssfb-prod/);
  });

  test('the log name of a service keys like its registry name', async () => {
    const seen: unknown[] = [];
    const spy: MockPort = {
      enabled: true,
      strict: false,
      lookup: async (_tool, keyInput) => {
        seen.push(keyInput);
        return { hit: false, key_string: 'k', hash: '0000000000000000' };
      },
    };
    const c = connector(QW_HOME(), { exec: createFakeRunner([]) });
    await c.search(ctxWith(spy), 'ssfb', { service: 'workflow', terms: ['x'] }, REQUEST_WINDOW);
    await c.search(ctxWith(spy), 'ssfb', { service: 'workflow-op', terms: ['x'] }, REQUEST_WINDOW);
    expect(seen[0]).toEqual(seen[1]);
    expect((seen[0] as LogsSearchFacts).service).toBe('workflow');
  });

  test('a strict miss throws strict_miss; a lenient miss returns fixture_miss with meta', async () => {
    const other: QuickwitSearchInput = { service: 'harbor', terms: ['nothing-here'] };
    const strict = await errorOf(connector(QW_HOME(), { exec: createFakeRunner([]) }).search(ctxWith(fixturePort(true)), 'ssfb', other, REQUEST_WINDOW));
    expect(strict.code).toBe('strict_miss');
    const lenient = await connector(QW_HOME(), { exec: createFakeRunner([]) }).search(ctxWith(fixturePort(false)), 'ssfb', other, REQUEST_WINDOW);
    expect(lenient.fixture_miss).toBe(true);
    expect(lenient.meta.quickwit_transport).toBe('qw');
  });
});
