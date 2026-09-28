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
  countDistinct,
  createQuickwitConnector,
  orderHits,
  tallyGroups,
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
const QUERY = "service:harbor AND 'doc fetch failed'";
// No service, so a 0-hit answer adds no count of the service alone.
const INPUT_ALL: QuickwitSearchInput = { message: 'doc fetch failed' };
const QUERY_ALL = "'doc fetch failed'";
const SSFB_FIELDS = 'service,level,message,error,raw_message,timestamp,x_req_id,x_txn_id,form_id,x-customer-id';
const FAKE_URL = 'http://quickwit.example.test:7080';
const QW_WINDOW = ['--from', '2026-09-21T10:00:00Z', '--to', '2026-09-23T10:00:00Z'];
const COUNT_ARGV = ['count', 'logs-v1', QUERY, ...QW_WINDOW, '-o', 'json', '--context', 'ssfb-prod'];
const searchArgv = (offset: number, maxHits: number, fields: string | null = SSFB_FIELDS): string[] => [
  'search',
  'logs-v1',
  QUERY,
  '--sort-by',
  'timestamp',
  '--max-hits',
  String(maxHits),
  '--offset',
  String(offset),
  ...QW_WINDOW,
  '-o',
  'json',
  ...(fields === null ? [] : ['--fields', fields]),
  '--context',
  'ssfb-prod',
];

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
      { bin: 'qw', argv: COUNT_ARGV, result: { stdout: '{"num_hits":1}' } },
      { bin: 'qw', argv: searchArgv(0, 250), result: { stdout: JSON.stringify({ num_hits: 1, hits: [HIT_A] }) } },
    ]);
    const f = noFetch();
    const out = await connector(h, { exec: fake, fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    // A count first (qw's JSON may not carry num_hits), then the page.
    expect(fake.calls).toHaveLength(2);
    expect(fake.unscripted).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    expect(out.transport).toBe('real');
    expect(String(out.target_env)).toBe('SSFB_QW_CONTEXT');
    expect(out.meta.quickwit_transport).toBe('qw');
    expect(out.meta.attempts).toBe(2);
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
    // The page carries num_hits, so one request.
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
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT_ALL, REQUEST_WINDOW);
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
      const who = c.argv.includes(QUERY_ALL) ? 'A' : 'B';
      order.push(`${who}${n}`);
      return who === 'A' && n === 1 ? timedOut : okOut;
    });
    const c = connector(QW_HOME(), { exec: runner, backoffMs: 20 });
    const a = c.search(ctxWith(), 'ssfb', INPUT_ALL, REQUEST_WINDOW);
    const b = c.search(ctxWith(), 'ssfb', { terms: ['other'] }, REQUEST_WINDOW);
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
      c.search(ctxWith(), 'ssfb', INPUT_ALL, REQUEST_WINDOW),
      c.search(ctxWith(), 'ssfb', { terms: ['x'] }, REQUEST_WINDOW),
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
      // Newest first.
      hits: [
        { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T09:05:00Z', form_id: 'F-1' },
        { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T09:00:00Z' },
      ],
      offset: 0,
      next_offset: 2,
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

  test('group_by: same groups, counted here on both transports', async () => {
    const body = { num_hits: 3, hits: [{ error: 'e1' }, { error: 'e2' }, { error: 'e1' }] };
    const [a, b] = await both({ ...INPUT, group_by: ['error'] }, body, body);
    expect(dataOf(a)).toEqual(dataOf(b));
    expect(dataOf(a)).toEqual({ groups: [{ key: 'e1', count: 2 }, { key: 'e2', count: 1 }], tally_base: 3, num_hits: 3, window: REQUEST_WINDOW, truncated: false });
  });

  test('a window that ends before now is sent whole on both transports, with no note', async () => {
    const runner = scriptedRunner(() => ({ stdout: '{"num_hits":0,"hits":[]}' }));
    const f = fetchSpy(() => new Response('{"num_hits":0,"hits":[]}', { status: 200 }));
    const a = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, PAST_WINDOW);
    const b = await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT, PAST_WINDOW);
    const argv = runner.calls[0]?.argv ?? [];
    expect([argv[argv.indexOf('--from') + 1], argv[argv.indexOf('--to') + 1]]).toEqual(['2026-09-21T10:00:00Z', '2026-09-22T10:00:00Z']);
    const body = JSON.parse(f.calls[0]?.init.body as string) as Record<string, number>;
    expect([body.start_timestamp, body.end_timestamp]).toEqual([Date.parse(PAST_WINDOW.from) / 1000, Date.parse(PAST_WINDOW.to) / 1000]);
    for (const out of [a, b]) {
      expect(dataOf(out).window).toEqual(PAST_WINDOW);
      expect(dataOf(out).window_note).toBeUndefined();
    }
  });

  test('builder notes such as a clamped max_hits are passed on', async () => {
    const body = { num_hits: 0, hits: [] };
    const [a, b] = await both({ ...INPUT, max_hits: 10_000 }, body, body);
    expect(dataOf(a).notes).toEqual(dataOf(b).notes);
    expect(String((dataOf(a).notes as string[])[0])).toContain('clamped');
  });

});

// ------------------------------------------------------------ paging (D76)

/** A qw runner that answers counts with `total` and pages with `pageOf(offset, size)`. */
function qwPaged(total: number, pageOf: (offset: number, size: number) => unknown[] = () => []) {
  return scriptedRunner((call) => {
    if (call.argv[0] === 'count') return { stdout: JSON.stringify({ num_hits: total }) };
    const at = (flag: string) => Number(call.argv[call.argv.indexOf(flag) + 1]);
    return { stdout: JSON.stringify({ num_hits: total, hits: pageOf(at('--offset'), at('--max-hits')) }) };
  });
}

const stamped = (i: number) => ({ service: 'harbor', level: 'error', message: `m${i}`, timestamp: new Date(Date.parse('2026-09-22T00:00:00Z') + i * 1000).toISOString() });
// Newest first, like qw --sort-by timestamp: hit 0 of the order is the newest of `total`.
const newestFirst = (total: number) => (offset: number, size: number) =>
  Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_v, k) => stamped(total - 1 - offset - k));

describe('paging, order and the 5,000-hit early return', () => {
  test('qw: one page at the offset, next_offset set, and no automatic next page', async () => {
    const runner = qwPaged(600, newestFirst(600));
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, offset: 250 }, REQUEST_WINDOW);
    expect(runner.calls.map((c) => c.argv)).toEqual([COUNT_ARGV, searchArgv(250, 250)]);
    const data = dataOf(out);
    expect(data).toMatchObject({ offset: 250, next_offset: 500, num_hits: 600, truncated: true });
    expect((data.hits as unknown[]).length).toBe(250);
  });

  test('next_offset is absent on the last page', async () => {
    const runner = qwPaged(600, newestFirst(600));
    const data = dataOf(await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, offset: 500 }, REQUEST_WINDOW));
    expect((data.hits as unknown[]).length).toBe(100);
    expect(data.next_offset).toBeUndefined();
    expect(data.offset).toBe(500);
  });

  test('qw oldest: the page is read from the far end of the newest-first order and returned oldest first', async () => {
    const runner = qwPaged(600, newestFirst(600));
    const c = connector(QW_HOME(), { exec: runner });
    const first = dataOf(await c.search(ctxWith(), 'ssfb', { ...INPUT, order: 'oldest' }, REQUEST_WINDOW));
    expect(runner.calls[1]?.argv).toEqual(searchArgv(350, 250));
    expect((first.hits as { message: string }[]).slice(0, 2).map((h) => h.message)).toEqual(['m0', 'm1']);
    expect((first.hits as { message: string }[]).at(-1)?.message).toBe('m249');
    expect(first.next_offset).toBe(250);

    const last = dataOf(await c.search(ctxWith(), 'ssfb', { ...INPUT, order: 'oldest', offset: 500 }, REQUEST_WINDOW));
    expect(runner.calls[3]?.argv).toEqual(searchArgv(0, 100));
    expect((last.hits as { message: string }[]).map((h) => h.message)).toEqual(Array.from({ length: 100 }, (_v, k) => `m${500 + k}`));
    expect(last.next_offset).toBeUndefined();
  });

  test('qw: an offset at or past num_hits runs the count only', async () => {
    const runner = qwPaged(40);
    const data = dataOf(await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, offset: 250 }, REQUEST_WINDOW));
    expect(runner.calls).toHaveLength(1);
    expect(data).toMatchObject({ hits: [], offset: 250, num_hits: 40 });
  });

  test('http: offset and order go in the body, one request per page', async () => {
    const f = fetchSpy(() => new Response(JSON.stringify({ num_hits: 900, hits: [HIT_A] }), { status: 200 }));
    const data = dataOf(await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', { ...INPUT, offset: 250, order: 'oldest' }, REQUEST_WINDOW));
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0]?.init.body as string)).toEqual({
      query: QUERY,
      max_hits: 250,
      start_timestamp: Date.parse(REQUEST_WINDOW.from) / 1000,
      end_timestamp: Date.parse(REQUEST_WINDOW.to) / 1000,
      start_offset: 250,
      sort_by: '-timestamp',
    });
    expect(data).toMatchObject({ offset: 250, next_offset: 251, num_hits: 900 });
  });

  const REASON =
    '12,431 hits for this query in 2026-09-21T10:00:00.000Z..2026-09-23T10:00:00.000Z (UTC), over the 5,000 hits a search pages through. ' +
    'No hits were read. Narrow the window, add an id or field filter, or use count or group_by first.';

  test('over 5,000 hits a search returns early with the count, the window and what to do, and no hits', async () => {
    const runner = qwPaged(12_431, newestFirst(12_431));
    const viaQw = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    // qw: the count alone; no page is read.
    expect(runner.calls.map((c) => c.argv[0])).toEqual(['count']);
    const f = fetchSpy(() => new Response(JSON.stringify({ num_hits: 12_431, hits: [HIT_A, HIT_B] }), { status: 200 }));
    const viaHttp = await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    expect(f.calls).toHaveLength(1);
    for (const out of [viaQw, viaHttp]) {
      expect(dataOf(out)).toEqual({ hits: [], offset: 0, num_hits: 12_431, window: REQUEST_WINDOW, reason: REASON, truncated: true });
    }
  });

  test('exactly 5,000 hits is not over the limit', async () => {
    const runner = qwPaged(5000, newestFirst(5000));
    const data = dataOf(await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
    expect(data.reason).toBeUndefined();
    expect((data.hits as unknown[]).length).toBe(250);
  });

  test('raw returns whole documents without the _source copy; qw sends no --fields', async () => {
    const doc = { ...HIT_A, _source: { ...HIT_A } };
    const runner = scriptedRunner((call) => ({ stdout: call.argv[0] === 'count' ? '{"num_hits":1}' : JSON.stringify({ num_hits: 1, hits: [doc] }) }));
    const viaQw = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, raw: true }, REQUEST_WINDOW);
    expect(runner.calls[1]?.argv).toEqual(searchArgv(0, 250, null));
    const f = fetchSpy(() => new Response(JSON.stringify({ num_hits: 1, hits: [doc] }), { status: 200 }));
    const viaHttp = await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', { ...INPUT, raw: true }, REQUEST_WINDOW);
    for (const out of [viaQw, viaHttp]) expect((dataOf(out).hits as unknown[])[0]).toEqual(HIT_A);
  });

  test('columns are projected on top of the allowlist', async () => {
    const hit = { ...HIT_A, status: 502, 'User-Agent': 'okhttp' };
    const runner = scriptedRunner((call) => ({ stdout: call.argv[0] === 'count' ? '{"num_hits":1}' : JSON.stringify({ num_hits: 1, hits: [hit] }) }));
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, columns: ['status', 'User-Agent'] }, REQUEST_WINDOW);
    expect(runner.calls[1]?.argv).toEqual(searchArgv(0, 250, `${SSFB_FIELDS},status,User-Agent`));
    expect((dataOf(out).hits as Record<string, unknown>[])[0]).toMatchObject({ status: 502, 'User-Agent': 'okhttp' });
  });

  test('a connection failure is unreachable with the reason, never 0 hits', async () => {
    const f = fetchSpy(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    });
    const err = await errorOf(connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('read ECONNRESET');
  });
});

// ------------------------------------------------------------ tally (D76)

describe('group_by and count_distinct', () => {
  const tallyHit = (i: number) => ({ level: i % 3 === 0 ? 'warn' : 'error', error: i % 2 === 0 ? 'timeout' : 'refused', form_id: `F-${i % 7}` });
  const INPUT_T: QuickwitSearchInput = { ...INPUT, group_by: ['level', 'error'], count_distinct: 'form_id' };

  test('qw: count, then serial pages of 250 projected to the tally fields, tallied over every hit', async () => {
    const runner = qwPaged(600, (offset, size) => Array.from({ length: Math.min(size, 600 - offset) }, (_v, k) => tallyHit(offset + k)));
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT_T, REQUEST_WINDOW);
    expect(runner.calls.map((c) => c.argv)).toEqual([
      COUNT_ARGV,
      searchArgv(0, 250, 'level,error,form_id'),
      searchArgv(250, 250, 'level,error,form_id'),
      searchArgv(500, 250, 'level,error,form_id'),
    ]);
    const all = Array.from({ length: 600 }, (_v, i) => tallyHit(i));
    expect(dataOf(out)).toEqual({
      groups: tallyGroups(all, ['level', 'error']),
      distinct: { field: 'form_id', count: 7 },
      tally_base: 600,
      num_hits: 600,
      window: REQUEST_WINDOW,
      truncated: false,
    });
    expect((dataOf(out).groups as { key: string }[])[0]?.key).toBe('error | refused');
  });

  test('http: the same count and pages, sorted newest first', async () => {
    const f = fetchSpy((_u, init) => {
      const body = JSON.parse(init.body as string) as { max_hits: number; start_offset?: number };
      const offset = body.start_offset ?? 0;
      const hits = Array.from({ length: Math.min(body.max_hits, 300 - offset) }, (_v, k) => tallyHit(offset + k));
      return new Response(JSON.stringify({ num_hits: 300, hits }), { status: 200 });
    });
    const out = await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT_T, REQUEST_WINDOW);
    const bodies = f.calls.map((c) => JSON.parse(c.init.body as string) as Record<string, unknown>);
    expect(bodies.map((b) => [b.max_hits, b.start_offset, b.sort_by])).toEqual([
      [0, undefined, undefined],
      [250, 0, 'timestamp'],
      [250, 250, 'timestamp'],
    ]);
    expect(dataOf(out)).toMatchObject({ tally_base: 300, num_hits: 300, distinct: { field: 'form_id', count: 7 } });
  });

  test('over 5,000 hits the tally returns early after the count, with the reason', async () => {
    const runner = qwPaged(6000);
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', INPUT_T, REQUEST_WINDOW);
    expect(runner.calls).toHaveLength(1);
    expect(dataOf(out)).toEqual({
      groups: [],
      tally_base: 0,
      num_hits: 6000,
      window: REQUEST_WINDOW,
      reason:
        '6,000 hits for this query in 2026-09-21T10:00:00.000Z..2026-09-23T10:00:00.000Z (UTC), over the 5,000 hits group_by and ' +
        'count_distinct tally. No hits were read. Narrow the window, add an id or field filter, count gives the total with no limit.',
      truncated: true,
    });
  });

  test('http: a page over the response cap is halved and the tally goes on at the smaller size', async () => {
    const f = fetchSpy((_u, init) => {
      const body = JSON.parse(init.body as string) as { max_hits: number; start_offset?: number };
      if (body.max_hits === 0) return new Response(JSON.stringify({ num_hits: 300, hits: [] }), { status: 200 });
      // Pages over 100 hits pass the cap: the body is cut at the cap.
      if (body.max_hits > 100) return new Response('x'.repeat(4 * 1024 * 1024 + 10), { status: 200 });
      const offset = body.start_offset ?? 0;
      const hits = Array.from({ length: Math.min(body.max_hits, 300 - offset) }, (_v, k) => tallyHit(offset + k));
      return new Response(JSON.stringify({ num_hits: 300, hits }), { status: 200 });
    });
    const out = await connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT_T, REQUEST_WINDOW);
    const pages = f.calls.map((c) => JSON.parse(c.init.body as string) as { max_hits: number; start_offset?: number }).slice(1);
    expect(pages.map((b) => [b.max_hits, b.start_offset])).toEqual([
      [250, 0],
      [125, 0],
      [62, 0],
      [62, 62],
      [62, 124],
      [62, 186],
      [62, 248],
    ]);
    const all = Array.from({ length: 300 }, (_v, i) => tallyHit(i));
    expect(dataOf(out)).toMatchObject({ groups: tallyGroups(all, ['level', 'error']), tally_base: 300, num_hits: 300 });
  });

  test('http: a page still over the cap at the smallest size fails with advice the model can act on', async () => {
    const f = fetchSpy((_u, init) => {
      const body = JSON.parse(init.body as string) as { max_hits: number };
      if (body.max_hits === 0) return new Response(JSON.stringify({ num_hits: 300, hits: [] }), { status: 200 });
      return new Response('x'.repeat(4 * 1024 * 1024 + 10), { status: 200 });
    });
    const err = await errorOf(connector(HTTP_HOME(), { fetchImpl: f }).search(ctxWith(), 'ssfb', INPUT_T, REQUEST_WINDOW));
    expect(err.code).toBe('cap_exceeded');
    expect(err.message).toBe(
      'a page of 50 hits (hits 1 to 50 of 300) passed the 4194304 byte response cap while tallying group_by or count_distinct, ' +
        'even at 50 hits a page. Narrow the window or add a filter so fewer hits are tallied, or use count, which reads no documents.',
    );
    expect(f.calls.map((c) => (JSON.parse(c.init.body as string) as { max_hits: number }).max_hits)).toEqual([0, 250, 125, 62, 50]);
  });

  test('after a 0-hit result with a service, one count of the service alone; service_absent only when it is 0 too', async () => {
    const runner = scriptedRunner((call) => ({ stdout: JSON.stringify({ num_hits: call.argv[2] === 'service:harbor' ? 12 : 0 }) }));
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, count: true }, REQUEST_WINDOW);
    expect(runner.calls.map((c) => c.argv[2])).toEqual([QUERY, 'service:harbor']);
    expect(dataOf(out).service_absent).toBeUndefined();
    const empty = scriptedRunner(() => ({ stdout: '{"num_hits":0}' }));
    const none = await connector(QW_HOME(), { exec: empty }).search(ctxWith(), 'ssfb', INPUT, REQUEST_WINDOW);
    expect(empty.calls.map((c) => [c.argv[0], c.argv[2]])).toEqual([
      ['count', QUERY],
      ['count', 'service:harbor'],
    ]);
    expect(dataOf(none)).toMatchObject({ hits: [], num_hits: 0, service_absent: true });
  });

  test('count_distinct alone returns no groups', async () => {
    const runner = qwPaged(3, () => [{ form_id: 'a' }, { form_id: 'b' }, { form_id: 'a' }]);
    const out = await connector(QW_HOME(), { exec: runner }).search(ctxWith(), 'ssfb', { ...INPUT, count_distinct: 'form_id' }, REQUEST_WINDOW);
    expect(dataOf(out)).toEqual({ distinct: { field: 'form_id', count: 2 }, tally_base: 3, num_hits: 3, window: REQUEST_WINDOW, truncated: false });
  });

  test('each page takes the slot on its own, so a waiting call runs between pages; pages never overlap', async () => {
    const order: string[] = [];
    const exec = scriptedRunner((call) => {
      const who = call.argv.includes(QUERY) ? 'A' : 'B';
      order.push(`${who}:${call.argv[0]}`);
      if (call.argv[0] === 'count') return { stdout: JSON.stringify({ num_hits: who === 'A' ? 500 : 0 }) };
      return { stdout: JSON.stringify({ hits: Array.from({ length: 250 }, () => ({ level: 'error' })) }) };
    }, 10);
    const k = connector(QW_HOME(), { exec });
    const a = k.search(ctxWith(), 'ssfb', { ...INPUT, group_by: ['level'] }, REQUEST_WINDOW);
    await new Promise((r) => setTimeout(r, 5));
    const b = k.search(ctxWith(), 'ssfb', { terms: ['other'] }, REQUEST_WINDOW);
    await Promise.all([a, b]);
    expect(order).toEqual(['A:count', 'B:count', 'A:search', 'A:search']);
    const sorted = [...exec.calls].sort((x, y) => x.start - y.start);
    for (let i = 1; i < sorted.length; i++) expect((sorted[i] as Call).start).toBeGreaterThanOrEqual((sorted[i - 1] as Call).end);
    expect(quickwitSlot('ssfb', 1).stats()).toEqual({ active: 0, waiting: 0 });
  });

  test('an abort between pages stops the tally before the next page', async () => {
    const ac = new AbortController();
    const exec = scriptedRunner((call) => {
      if (call.argv[0] === 'count') return { stdout: '{"num_hits":750}' };
      ac.abort(new Error('run stopped'));
      return { stdout: JSON.stringify({ hits: Array.from({ length: 250 }, () => ({ level: 'error' })) }) };
    });
    await expect(connector(QW_HOME(), { exec }).search(ctxWith(REAL_PORT, ac.signal), 'ssfb', { ...INPUT, group_by: ['level'] }, REQUEST_WINDOW)).rejects.toThrow(
      'run stopped',
    );
    expect(exec.calls).toHaveLength(2);
  });
});

describe('tally helpers', () => {
  test('tallyGroups keys by the joined values, counts a missing value as (none), and sorts ties by key', () => {
    expect(tallyGroups([{ s: 500 }, { s: 200 }, { s: 500 }, { s: null }, { s: 404 }], ['s'])).toEqual([
      { key: '500', count: 2 },
      { key: '(none)', count: 1 },
      { key: '200', count: 1 },
      { key: '404', count: 1 },
    ]);
    expect(tallyGroups([{ a: 'x', b: 'y' }, { a: 'x' }, { a: 'x', b: 'y' }], ['a', 'b'])).toEqual([
      { key: 'x | y', count: 2 },
      { key: 'x | (none)', count: 1 },
    ]);
  });

  test('countDistinct skips hits without the field', () => {
    expect(countDistinct([{ f: 'a' }, { f: 'b' }, {}, { f: 'a' }, { f: null }], 'f')).toBe(2);
  });

  test('orderHits sorts by timestamp both ways and keeps the given order when a hit has none', () => {
    const hits = [{ timestamp: '2026-09-22T09:05:00Z' }, { timestamp: '2026-09-22T09:00:00Z' }, { timestamp: '2026-09-22T09:10:00Z' }];
    expect(orderHits(hits, 'oldest').map((h) => h.timestamp)).toEqual(['2026-09-22T09:00:00Z', '2026-09-22T09:05:00Z', '2026-09-22T09:10:00Z']);
    expect(orderHits(hits, 'newest').map((h) => h.timestamp)).toEqual(['2026-09-22T09:10:00Z', '2026-09-22T09:05:00Z', '2026-09-22T09:00:00Z']);
    const partial = [{ timestamp: '2026-09-22T09:05:00Z' }, { message: 'x' }];
    expect(orderHits(partial, 'oldest')).toEqual(partial);
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
    const input: QuickwitSearchInput = { service: 'harbor', terms: ['b', 'a'], fields: { form_id: 'F-1' }, level: 'ERROR', group_by: ['error'] };
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

  test('no service leaves service out of the key; the D76 inputs join the key only when set', async () => {
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
    await c.search(ctxWith(spy), 'ssfb', { terms: ['x'] }, REQUEST_WINDOW);
    await c.search(
      ctxWith(spy),
      'ssfb',
      {
        terms: ['x'],
        exclude: ['noise'],
        any_of: [{ level: ['error', 'warn'] }],
        contains: 'abc',
        order: 'oldest',
        offset: 250,
        columns: ['status'],
        raw: true,
      },
      REQUEST_WINDOW,
    );
    await c.search(ctxWith(spy), 'ssfb', { terms: ['x'], group_by: ['service', 'level'], count_distinct: 'form_id' }, REQUEST_WINDOW);
    expect(semanticKey('logs_search', seen[0] as LogsSearchFacts)).toEqual({ entity: 'ssfb', terms: ['x'], mode: 'search' });
    expect(semanticKey('logs_search', seen[1] as LogsSearchFacts).terms).toEqual([
      'any_of:[{"level":["error","warn"]}]',
      'columns:status',
      'contains:abc',
      'exclude:noise',
      'offset:250',
      'order:oldest',
      'raw:true',
      'x',
    ]);
    expect(semanticKey('logs_search', seen[2] as LogsSearchFacts)).toMatchObject({
      terms: ['count_distinct:form_id', 'x'],
      mode: 'histogram',
      group_by: 'service,level',
    });
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
