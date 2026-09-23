import { describe, expect, test } from 'bun:test';
import { ConnectorError, MAX_HTTP_BODY_BYTES } from '../types.ts';
import { GROUPS_AGG, httpSearch, searchBody, searchUrl, type FetchLike, type HttpEnvNames, type HttpSearchRequest } from './http-transport.ts';

const NAMES: HttpEnvNames = { url: 'ATSPL_QUICKWIT_URL', auth: 'ATSPL_QUICKWIT_AUTH', token: 'ATSPL_QUICKWIT_TOKEN' };
const BASE = 'https://quickwit.example.test/proxy/';
const TOKEN = 'tok-9f8e7d6c5b4a';
const WINDOW = { from: '2026-09-21T10:00:00.500Z', to: '2026-09-23T10:00:00.200Z' };

function req(over: Partial<HttpSearchRequest> = {}): HttpSearchRequest {
  return {
    url: BASE,
    auth: 'none',
    index: 'envoy-logs',
    query: 'service:package AND x\\-req\\-id:abc',
    mode: 'search',
    maxHits: 50,
    window: WINDOW,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...over,
  };
}

type Seen = { url: string; init: RequestInit };

function fakeFetch(respond: (seen: Seen) => Response | Promise<Response>): FetchLike & { seen: Seen[] } {
  const seen: Seen[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const s = { url, init };
    seen.push(s);
    return respond(s);
  }) as FetchLike & { seen: Seen[] };
  fn.seen = seen;
  return fn;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function headersOf(s: Seen | undefined): Record<string, string> {
  return (s?.init.headers ?? {}) as Record<string, string>;
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

function expectNoSecrets(err: Error): void {
  expect(err.message).not.toContain(TOKEN);
  expect(err.message).not.toContain('quickwit.example.test');
}

describe('request', () => {
  test('search POSTs query, max_hits and the window in epoch seconds to /api/v1/<index>/search', async () => {
    const f = fakeFetch(() => json({ num_hits: 0, hits: [] }));
    await httpSearch(f, req(), NAMES);
    expect(f.seen).toHaveLength(1);
    const s = f.seen[0] as Seen;
    expect(s.url).toBe('https://quickwit.example.test/proxy/api/v1/envoy-logs/search');
    expect(s.init.method).toBe('POST');
    expect(s.init.redirect).toBe('manual');
    expect(JSON.parse(s.init.body as string)).toEqual({
      query: 'service:package AND x\\-req\\-id:abc',
      max_hits: 50,
      start_timestamp: Math.floor(Date.parse(WINDOW.from) / 1000),
      end_timestamp: Math.ceil(Date.parse(WINDOW.to) / 1000),
    });
  });

  test('count sends max_hits 0 and no aggregation', () => {
    const body = searchBody({ ...req(), mode: 'count' });
    expect(body.max_hits).toBe(0);
    expect(body.aggs).toBeUndefined();
  });

  test('group_by sends max_hits 0 and a terms aggregation on the field', () => {
    const body = searchBody({ ...req(), mode: 'histogram', groupBy: 'service' });
    expect(body.max_hits).toBe(0);
    expect(body.aggs).toEqual({ [GROUPS_AGG]: { terms: { field: 'service', size: 50 } } });
  });

  test('the index is encoded into the path and the base keeps its path prefix', () => {
    expect(searchUrl('http://qw.example.test:7080', 'logs v1', NAMES)).toBe('http://qw.example.test:7080/api/v1/logs%20v1/search');
  });
});

describe('auth', () => {
  test('auth none sends no Authorization header', async () => {
    const f = fakeFetch(() => json({ num_hits: 0, hits: [] }));
    await httpSearch(f, req({ auth: 'none', token: TOKEN }), NAMES);
    const headers = headersOf(f.seen[0]);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  test('auth bearer sends Authorization: Bearer <token>', async () => {
    const f = fakeFetch(() => json({ num_hits: 0, hits: [] }));
    await httpSearch(f, req({ auth: 'bearer', token: TOKEN }), NAMES);
    expect(headersOf(f.seen[0]).authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('bearer with a blank or missing token is not_configured and nothing is fetched', async () => {
    for (const token of [undefined, '', '   ']) {
      const f = fakeFetch(() => json({ num_hits: 0, hits: [] }));
      const over: Partial<HttpSearchRequest> = token === undefined ? { auth: 'bearer' } : { auth: 'bearer', token };
      const err = await errorOf(httpSearch(f, req(over), NAMES));
      expect(err.code).toBe('not_configured');
      expect(err.message).toContain('ATSPL_QUICKWIT_TOKEN');
      expect(f.seen).toHaveLength(0);
    }
  });

  test('401 and 403 are unreachable naming the auth keys, never the token', async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch(() => new Response('denied', { status }));
      const err = await errorOf(httpSearch(f, req({ auth: 'bearer', token: TOKEN }), NAMES));
      expect(err.code).toBe('unreachable');
      expect(err.message).toContain('ATSPL_QUICKWIT_TOKEN');
      expectNoSecrets(err);
    }
  });
});

describe('url checks', () => {
  test('a URL that is not http(s), carries credentials or a query string is not_configured', async () => {
    for (const url of ['not a url', 'ftp://qw.example.test', 'https://user:pw@qw.example.test', 'https://qw.example.test/?x=1']) {
      const f = fakeFetch(() => json({ num_hits: 0, hits: [] }));
      const err = await errorOf(httpSearch(f, req({ url }), NAMES));
      expect(err.code).toBe('not_configured');
      expect(err.message).toContain('ATSPL_QUICKWIT_URL');
      expect(err.message).not.toContain('pw@');
      expect(f.seen).toHaveLength(0);
    }
  });
});

describe('redirects', () => {
  test('a 3xx answer is refused, not followed', async () => {
    for (const status of [301, 302, 307, 308]) {
      const f = fakeFetch(() => new Response(null, { status, headers: { location: 'https://elsewhere.example.test/' } }));
      const err = await errorOf(httpSearch(f, req(), NAMES));
      expect(err.code).toBe('refused');
      expect(err.message).toContain('redirect');
      expect(err.message).not.toContain('elsewhere');
      expect(f.seen).toHaveLength(1);
    }
  });

  test('an opaque redirect (what redirect: manual gives in a browser) is refused', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, body: null } as unknown as Response;
    const err = await errorOf(httpSearch(fakeFetch(() => opaque), req(), NAMES));
    expect(err.code).toBe('refused');
  });
});

describe('timeout and abort', () => {
  // Never answers; rejects only when its signal aborts, like a real fetch.
  const hanging = fakeFetch(
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
  );

  test('no answer within TRIAGE_HTTP_TIMEOUT_MS is timeout', async () => {
    const err = await errorOf(httpSearch(hanging, req({ timeoutMs: 20 }), NAMES));
    expect(err.code).toBe('timeout');
  });

  test('a body that stalls past the timeout is timeout too', async () => {
    const f = fakeFetch(({ init }) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"num_hits":'));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    const err = await errorOf(httpSearch(f, req({ timeoutMs: 20 }), NAMES));
    expect(err.code).toBe('timeout');
  });

  test('the caller aborting rethrows its reason instead of a connector error', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('run cancelled')), 5);
    await expect(httpSearch(hanging, req({ signal: ac.signal, timeoutMs: 5000 }), NAMES)).rejects.toThrow('run cancelled');
  });

  test('a network error is unreachable naming the URL key only', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND quickwit.example.test');
    });
    const err = await errorOf(httpSearch(f, req(), NAMES));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('ATSPL_QUICKWIT_URL');
    expectNoSecrets(err);
  });
});

describe('response', () => {
  test('search gives hits and num_hits', async () => {
    const hits = [{ service: 'package', message: 'x' }];
    const out = await httpSearch(fakeFetch(() => json({ num_hits: 3, hits, elapsed_time_micros: 10 })), req(), NAMES);
    expect(out).toEqual({ kind: 'hits', hits, num_hits: 3 });
  });

  test('count gives num_hits', async () => {
    const out = await httpSearch(fakeFetch(() => json({ num_hits: 12, hits: [] })), req({ mode: 'count' }), NAMES);
    expect(out).toEqual({ kind: 'count', num_hits: 12 });
  });

  test('group_by reads the terms buckets and flags other docs as truncated', async () => {
    const body = { num_hits: 9, hits: [], aggregations: { [GROUPS_AGG]: { buckets: [{ key: 'a', doc_count: 2 }, { key: 'b', doc_count: 5 }], sum_other_doc_count: 2 } } };
    const out = await httpSearch(fakeFetch(() => json(body)), req({ mode: 'histogram', groupBy: 'service' }), NAMES);
    expect(out).toEqual({ kind: 'groups', groups: [{ key: 'b', count: 5 }, { key: 'a', count: 2 }], num_hits: 9, truncated: true });
  });

  test('400 is refused, 404 and 5xx are unreachable', async () => {
    expect((await errorOf(httpSearch(fakeFetch(() => new Response('bad', { status: 400 })), req(), NAMES))).code).toBe('refused');
    expect((await errorOf(httpSearch(fakeFetch(() => new Response('', { status: 404 })), req(), NAMES))).code).toBe('unreachable');
    const e5 = await errorOf(httpSearch(fakeFetch(() => new Response('oops', { status: 503 })), req(), NAMES));
    expect(e5.code).toBe('unreachable');
    expect(e5.message).toContain('503');
  });

  test('a body that is not the expected JSON is unreachable', async () => {
    for (const text of ['<html>', '{"hits":[]}', '{"num_hits":1,"hits":[1]}']) {
      const err = await errorOf(httpSearch(fakeFetch(() => new Response(text, { status: 200 })), req(), NAMES));
      expect(err.code).toBe('unreachable');
    }
  });

  test('a body past MAX_HTTP_BODY_BYTES is cap_exceeded', async () => {
    const big = 'x'.repeat(MAX_HTTP_BODY_BYTES + 1);
    const err = await errorOf(httpSearch(fakeFetch(() => new Response(big, { status: 200 })), req(), NAMES));
    expect(err.code).toBe('cap_exceeded');
  });
});
