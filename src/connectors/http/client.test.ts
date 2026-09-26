import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import type { ApiCapability, AuthCapability, Registry, ServiceSpec } from '../../config/registry.ts';
import { decideHttp, type HttpAllowed, type HttpDecision } from '../../gate/http.ts';
import type { ApiRule } from '../../gate/rules.ts';
import type { HttpCallFacts } from '../../mock/key.ts';
import type { Entity } from '../../types/core.ts';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import type { MockLookup, MockPort } from '../mock.ts';
import { ConnectorError, MAX_HTTP_BODY_BYTES, type ConnectorContext, type ConnectorResult } from '../types.ts';
import { createHttpConnector, type FetchLike, type HttpCallData, type HttpSendRequest } from './client.ts';

const TOKEN = 'fake-bro-token-SEEDED-91c2';
const BRO_BASE = 'https://bro.example.invalid/bro';
const HARBOR_BASE = 'https://harbor.example.invalid/harbor';

let home: TestHome;
let blankHome: TestHome;

beforeAll(() => {
  home = makeTestHome({
    entities: ['ssfb'],
    overrides: {
      SSFB_BRO_API_URL: BRO_BASE,
      SSFB_BRO_ADMIN_TOKEN: TOKEN,
      SSFB_HARBOR_API_URL: HARBOR_BASE,
      SSFB_CBS_GATEWAY_URL: 'https://cbs.example.invalid',
    },
  });
  blankHome = makeTestHome({ entities: ['ssfb'], overrides: { SSFB_BRO_API_URL: BRO_BASE } });
});

afterAll(() => {
  home.cleanup();
  blankHome.cleanup();
});

// ------------------------------------------------------------ test doubles

type FetchCall = { readonly url: URL; readonly init: RequestInit };

function fakeFetch(answer: (url: URL, init: RequestInit) => Response | Promise<Response>): FetchLike & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return Object.assign(fn, { calls });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

const realPort: MockPort = {
  enabled: false,
  strict: true,
  lookup: async () => {
    throw new Error('lookup must not run in real mode');
  },
};

function context(options: { mock?: MockPort; signal?: AbortSignal } = {}): ConnectorContext {
  return {
    signal: options.signal ?? new AbortController().signal,
    now: () => new Date('2026-09-23T10:00:00.000Z'),
    mock: options.mock ?? realPort,
    runId: 'run-test-1',
  };
}

function connector(fetchImpl: FetchLike, options: { timeoutMs?: number; registry?: Registry | StubRegistry; which?: TestHome } = {}) {
  return createHttpConnector({
    registry: options.registry ?? (options.which ?? home).registry,
    config: { budgets: { httpTimeoutMs: options.timeoutMs ?? 5000 } },
    fetchImpl,
  });
}

function allowed(base: string, path: string, method = 'GET', service = 'bro', rules: readonly ApiRule[] = []): HttpAllowed {
  const d = decideHttp({ tool: 'http_call', service, method, path, base, rules });
  if (!d.ok) throw new Error(`test setup: expected allow, got ${d.code}`);
  return d;
}

function facts(entity: Entity, service: string, method: string, path: string): HttpCallFacts {
  return { entity, service, method, path };
}

function broRequest(overrides: Partial<HttpSendRequest> = {}): HttpSendRequest {
  const decision = allowed(BRO_BASE, '/bro/admin/api/v1/checks/abc');
  return {
    entity: 'ssfb',
    service: 'bro',
    method: 'GET',
    url: decision.url,
    decision,
    keyInput: facts('ssfb', 'bro', 'GET', decision.pathname),
    ...overrides,
  };
}

function harborRequest(overrides: Partial<HttpSendRequest> = {}): HttpSendRequest {
  const decision = allowed(HARBOR_BASE, '/harbor/admin/v1/forms/f-1', 'GET', 'harbor');
  return {
    entity: 'ssfb',
    service: 'harbor',
    method: 'GET',
    url: decision.url,
    decision,
    keyInput: facts('ssfb', 'harbor', 'GET', decision.pathname),
    ...overrides,
  };
}

// A small registry for cases the shipped files do not have: Basic auth, a
// base with a path prefix of /api, and a non-finacle service on transport cbs.
type StubService = { spec: ServiceSpec; api?: { envName: string; value?: string; transport?: 'http' | 'cbs' }; auth?: { scheme: 'Bearer' | 'Basic'; envName: string; value?: string } };
type StubRegistry = Pick<Registry, 'service' | 'serviceApi' | 'serviceAuth'>;

function hiddenValue<T extends object>(visible: T, value: string | undefined): T {
  const out = { ...visible };
  if (value !== undefined) Object.defineProperty(out, 'value', { value, enumerable: false });
  return Object.freeze(out);
}

function stubRegistry(services: Record<string, StubService>): StubRegistry {
  const get = (service: string): StubService => {
    const s = services[service];
    if (s === undefined) throw new Error('unknown service');
    return s;
  };
  return {
    service: (_e, service) => get(service).spec,
    serviceApi(_e, service) {
      const a = get(service).api;
      if (a === undefined) return undefined;
      const status = a.value === undefined ? { status: 'disabled', reason: 'blank' } : { status: 'ok' };
      return hiddenValue({ ...status, envName: a.envName, transport: a.transport ?? 'http' }, a.value) as ApiCapability;
    },
    serviceAuth(_e, service) {
      const a = get(service).auth;
      if (a === undefined) return undefined;
      const status = a.value === undefined ? { status: 'disabled', reason: 'blank' } : { status: 'ok' };
      return hiddenValue({ ...status, envName: a.envName, header: 'Authorization', scheme: a.scheme }, a.value) as AuthCapability;
    },
  };
}

const API_BASE = 'https://svc.example.invalid/api';

const stub = stubRegistry({
  svc: {
    spec: { api: 'SSFB_SVC_API_URL' },
    api: { envName: 'SSFB_SVC_API_URL', value: API_BASE },
    auth: { scheme: 'Basic', envName: 'SSFB_SVC_BASIC', value: 'svc-user:pa55' },
  },
  core: {
    spec: { api: 'SSFB_CORE_API_URL', transport: 'cbs' },
    api: { envName: 'SSFB_CORE_API_URL', value: API_BASE, transport: 'cbs' },
  },
  finacle: {
    spec: { api: 'SSFB_CBS_GATEWAY_URL', transport: 'cbs' },
    api: { envName: 'SSFB_CBS_GATEWAY_URL', value: API_BASE, transport: 'cbs' },
  },
  noapi: { spec: {} },
  blankapi: { spec: { api: 'SSFB_BLANK_API_URL' }, api: { envName: 'SSFB_BLANK_API_URL' } },
});

function svcRequest(service: string, path = '/api/users/u-1', overrides: Partial<HttpSendRequest> = {}): HttpSendRequest {
  const decision = allowed(API_BASE, path, 'GET', service === 'finacle' ? 'svc' : service);
  return {
    entity: 'ssfb',
    service,
    method: 'GET',
    url: decision.url,
    decision,
    keyInput: facts('ssfb', service, 'GET', decision.pathname),
    ...overrides,
  };
}

async function refusal(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConnectorError) return err;
    throw err;
  }
  throw new Error('expected a ConnectorError');
}

// ---------------------------------------------------------------- refusals

// The reason each refusal case must give, so a case cannot pass on an earlier check.
const NO_ALLOW = 'no allow decision';
const OFF_HOST = 'not on the registry host';
const OUTSIDE = 'outside the service base path';
const BAD_ID = 'customer id may use only';
const REASON: Record<string, string> = {
  'decision block': NO_ALLOW,
  'decision missing': NO_ALLOW,
  'decision null': NO_ALLOW,
  'decision with action other than allow': NO_ALLOW,
  'url origin differs from the registry base': OFF_HOST,
  'url on another port of the same host': OFF_HOST,
  'url on http instead of https': OFF_HOST,
  "url path outside the base prefix ('/api' base vs '/apix/..')": OUTSIDE,
  'url equal to the base host root when the base has a path': OUTSIDE,
  'url with credentials': OFF_HOST,
  'url path differs from the decided path': 'path differs from the one the rules decided',
  'url given as a string': 'must come from buildUrl',
  'service finacle': 'use cbs_call',
  'service finacle on the shipped registry': 'use cbs_call',
  "a non-finacle service with transport 'cbs'": 'only through cbs_call',
  'method other than the decided one': 'method differs',
  'method in lower case': 'method differs',
  'unknown service': 'not a known service',
  'disabled entity': 'not a known service',
  'fixture key for another service': 'fixture key does not match',
  'fixture key for another method': 'fixture key does not match',
  'body on GET': 'GET takes no body',
  'customer id with a space': BAD_ID,
  'customer id with a newline': BAD_ID,
  'customer id with a colon': BAD_ID,
  'customer id with a non-ASCII character': BAD_ID,
  'service with no API in the registry': 'lists no API',
  'service with a blank API URL': 'SSFB_BLANK_API_URL is blank',
};

describe('refused before fetch', () => {
  const block = decideHttp({ tool: 'http_call', service: 'bro', method: 'POST', path: '/bro/admin/x', base: BRO_BASE, rules: [] });

  const cases: readonly [string, () => { req: HttpSendRequest; registry?: StubRegistry }, 'refused' | 'not_configured'][] = [
    ['decision block', () => ({ req: broRequest({ method: 'POST', decision: block }) }), 'refused'],
    ['decision missing', () => ({ req: broRequest({ decision: undefined }) }), 'refused'],
    ['decision null', () => ({ req: broRequest({ decision: null as unknown as HttpDecision }) }), 'refused'],
    [
      'decision with action other than allow',
      () => ({ req: broRequest({ decision: { ...broRequest().decision, action: 'block' } as unknown as HttpDecision }) }),
      'refused',
    ],
    [
      'url origin differs from the registry base',
      () => {
        const other = allowed('https://other.example.invalid/bro', '/bro/admin/api/v1/checks/abc');
        return { req: broRequest({ url: other.url, decision: other }) };
      },
      'refused',
    ],
    [
      'url on another port of the same host',
      () => {
        const other = allowed('https://bro.example.invalid:8443/bro', '/bro/admin/api/v1/checks/abc');
        return { req: broRequest({ url: other.url, decision: other }) };
      },
      'refused',
    ],
    [
      'url on http instead of https',
      () => {
        const other = allowed('http://bro.example.invalid/bro', '/bro/admin/api/v1/checks/abc');
        return { req: broRequest({ url: other.url, decision: other }) };
      },
      'refused',
    ],
    [
      "url path outside the base prefix ('/api' base vs '/apix/..')",
      () => {
        const d = allowed('https://svc.example.invalid/', '/apix/users');
        return { req: svcRequest('svc', '/api/users/u-1', { url: d.url, decision: d }), registry: stub };
      },
      'refused',
    ],
    [
      'url equal to the base host root when the base has a path',
      () => {
        const d = allowed('https://svc.example.invalid/', '/other');
        return { req: svcRequest('svc', '/api/users/u-1', { url: d.url, decision: d }), registry: stub };
      },
      'refused',
    ],
    [
      'url with credentials',
      () => {
        const r = broRequest();
        const url = new URL(r.url.href);
        url.username = 'u';
        return { req: { ...r, url } };
      },
      'refused',
    ],
    [
      'url path differs from the decided path',
      () => {
        const r = broRequest();
        return { req: { ...r, url: new URL(`${BRO_BASE}/admin/api/v1/stp-engine/rules/r-1`) } };
      },
      'refused',
    ],
    ['url given as a string', () => ({ req: broRequest({ url: `${BRO_BASE}/admin/api/v1/checks/abc` as unknown as URL }) }), 'refused'],
    ['service finacle', () => ({ req: svcRequest('finacle'), registry: stub }), 'refused'],
    ['service finacle on the shipped registry', () => ({ req: broRequest({ service: 'finacle', keyInput: facts('ssfb', 'finacle', 'GET', '/x') }) }), 'refused'],
    ["a non-finacle service with transport 'cbs'", () => ({ req: svcRequest('core'), registry: stub }), 'refused'],
    ['method other than the decided one', () => ({ req: broRequest({ method: 'POST' }) }), 'refused'],
    ['method in lower case', () => ({ req: broRequest({ method: 'get' }) }), 'refused'],
    ['unknown service', () => ({ req: broRequest({ service: 'nope', keyInput: facts('ssfb', 'nope', 'GET', '/x') }) }), 'refused'],
    ['disabled entity', () => ({ req: broRequest({ entity: 'rtl', keyInput: facts('rtl', 'bro', 'GET', '/x') }) }), 'refused'],
    ['fixture key for another service', () => ({ req: broRequest({ keyInput: facts('ssfb', 'harbor', 'GET', '/x') }) }), 'refused'],
    ['fixture key for another method', () => ({ req: broRequest({ keyInput: facts('ssfb', 'bro', 'POST', '/x') }) }), 'refused'],
    ['body on GET', () => ({ req: broRequest({ body: { a: 1 } }) }), 'refused'],
    ['customer id with a space', () => ({ req: harborRequest({ customerId: 'cust 1' }) }), 'refused'],
    ['customer id with a newline', () => ({ req: harborRequest({ customerId: 'cust\n1' }) }), 'refused'],
    ['customer id with a colon', () => ({ req: harborRequest({ customerId: 'cust:1' }) }), 'refused'],
    ['customer id with a non-ASCII character', () => ({ req: harborRequest({ customerId: 'cüst-1' }) }), 'refused'],
    ['service with no API in the registry', () => ({ req: svcRequest('noapi'), registry: stub }), 'not_configured'],
    ['service with a blank API URL', () => ({ req: svcRequest('blankapi'), registry: stub }), 'not_configured'],
  ];

  for (const [name, make, code] of cases) {
    test(name, async () => {
      const fetch = fakeFetch(() => jsonResponse({ ok: true }));
      const { req, registry } = make();
      const err = await refusal(connector(fetch, { ...(registry ? { registry } : {}) }).send(context(), req));
      expect(err.code).toBe(code);
      expect(err.message).toContain(REASON[name] ?? 'missing reason');
      expect(fetch.calls.length).toBe(0);
    });
  }

  test('the same refusals hold in mock mode, and the fixture is not read', async () => {
    let lookups = 0;
    const port: MockPort = {
      enabled: true,
      strict: true,
      lookup: async () => {
        lookups += 1;
        return { hit: true, value: {}, hash: 'h' } as MockLookup;
      },
    };
    const fetch = fakeFetch(() => jsonResponse({}));
    const c = connector(fetch);
    for (const req of [broRequest({ decision: undefined }), broRequest({ method: 'POST' }), harborRequest({ customerId: 'a b' })]) {
      const err = await refusal(c.send(context({ mock: port }), req));
      expect(err.code).toBe('refused');
    }
    expect(lookups).toBe(0);
    expect(fetch.calls.length).toBe(0);
  });
});

// ----------------------------------------------------------------- headers

describe('headers', () => {
  test('caller headers are ignored; only registry auth and accept are sent', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ok: true }));
    const req = {
      ...broRequest(),
      headers: { Authorization: 'Bearer caller', Cookie: 'sid=1', Host: 'evil.example.invalid', 'x-customer-id': 'caller-id' },
    } as unknown as HttpSendRequest;
    await connector(fetch).send(context(), req);
    expect(fetch.calls.length).toBe(1);
    expect(fetch.calls[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: 'application/json' });
  });

  test('harbor sends the validated customer id in its registry header and no auth', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ok: true }));
    const req = { ...harborRequest({ customerId: 'cust-1' }), headers: { 'x-customer-id': 'other', Cookie: 'x' } } as unknown as HttpSendRequest;
    await connector(fetch).send(context(), req);
    expect(fetch.calls[0]?.init.headers).toEqual({ 'x-customer-id': 'cust-1', accept: 'application/json' });
  });

  test('a customer id on a service with no customer header is not sent', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ok: true }));
    await connector(fetch).send(context(), broRequest({ customerId: 'cust-1' }));
    expect(fetch.calls[0]?.init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: 'application/json' });
  });

  test('Basic auth sends base64 of the env value', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ok: true }));
    await connector(fetch, { registry: stub }).send(context(), svcRequest('svc'));
    const expected = Buffer.from('svc-user:pa55', 'utf8').toString('base64');
    expect(fetch.calls[0]?.init.headers).toEqual({ authorization: `Basic ${expected}`, accept: 'application/json' });
  });

  test('a blank token_env is not_configured naming the env var, before fetch', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ok: true }));
    const err = await refusal(connector(fetch, { which: blankHome }).send(context(), broRequest()));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain('SSFB_BRO_ADMIN_TOKEN');
    expect(fetch.calls.length).toBe(0);
  });

  test('a blank token does not stop mock mode', async () => {
    const port: MockPort = { enabled: true, strict: true, lookup: async () => ({ hit: true, value: { status: 200 }, hash: 'h' }) };
    const fetch = fakeFetch(() => jsonResponse({}));
    const out = await connector(fetch, { which: blankHome }).send(context({ mock: port }), broRequest());
    expect(out.transport).toBe('mock');
    expect(fetch.calls.length).toBe(0);
  });

  test('fetch gets redirect manual, the decided method and the bound URL', async () => {
    const fetch = fakeFetch(() => jsonResponse({ ok: true }));
    const req = broRequest();
    await connector(fetch).send(context(), req);
    const call = fetch.calls[0];
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.method).toBe('GET');
    expect(call?.url.href).toBe(`${BRO_BASE}/admin/api/v1/checks/abc`);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a POST allowed by a rule sends a JSON body with content-type', async () => {
    const rules: ApiRule[] = [{ service: 'bro', method: 'POST', api: '/bro/dashboard/api/v1/dry-run', action: 'allow', reason: 'dry run' }];
    const decision = allowed(BRO_BASE, '/bro/dashboard/api/v1/dry-run', 'POST', 'bro', rules);
    const fetch = fakeFetch(() => jsonResponse({ result: 'pass' }));
    const out = await connector(fetch).send(context(), {
      entity: 'ssfb',
      service: 'bro',
      method: 'POST',
      url: decision.url,
      decision,
      body: { form_id: 'f-1' },
      keyInput: facts('ssfb', 'bro', 'POST', decision.pathname),
    });
    const call = fetch.calls[0];
    expect(call?.init.body).toBe('{"form_id":"f-1"}');
    expect(call?.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect((out as ConnectorResult<HttpCallData>).data.rule_index).toBe(0);
  });
});

// --------------------------------------------------------------- redirects

describe('redirects', () => {
  for (const status of [301, 302, 303, 307, 308]) {
    test(`a ${status} is refused and the Location host is not fetched`, async () => {
      const fetch = fakeFetch(() => new Response(null, { status, headers: { location: 'https://evil.example.invalid/steal' } }));
      const err = await refusal(connector(fetch).send(context(), broRequest()));
      expect(err.code).toBe('refused');
      expect(err.message).not.toContain('evil');
      expect(fetch.calls.length).toBe(1);
      expect(fetch.calls[0]?.url.host).toBe('bro.example.invalid');
    });
  }

  test('an opaque redirect response is refused', async () => {
    const fetch = fakeFetch(() => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
      return r;
    });
    const err = await refusal(connector(fetch).send(context(), broRequest()));
    expect(err.code).toBe('refused');
  });
});

// ------------------------------------------------------ timeout and abort

function hangingFetch(): FetchLike & { calls: FetchCall[]; aborted: () => boolean } {
  let sawAbort = false;
  const f = fakeFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(signal.reason);
        });
      }),
  );
  return Object.assign(f, { aborted: () => sawAbort });
}

describe('timeout and abort', () => {
  test('the timeout aborts the fetch and gives timeout', async () => {
    const fetch = hangingFetch();
    const err = await refusal(connector(fetch, { timeoutMs: 20 }).send(context(), broRequest()));
    expect(err.code).toBe('timeout');
    expect(err.message).toContain('20 ms');
    expect(fetch.aborted()).toBe(true);
  });

  test('the timeout also covers a body that stalls', async () => {
    const fetch = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"a":'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const err = await refusal(connector(fetch, { timeoutMs: 20 }).send(context(), broRequest()));
    expect(err.code).toBe('timeout');
  });

  test('an aborted ctx.signal aborts the fetch and rejects with its reason', async () => {
    const fetch = hangingFetch();
    const ac = new AbortController();
    const reason = new Error('run cancelled');
    const p = connector(fetch).send(context({ signal: ac.signal }), broRequest());
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
    expect(fetch.aborted()).toBe(true);
  });

  test('a ctx.signal aborted before the call never fetches', async () => {
    const fetch = fakeFetch(() => jsonResponse({}));
    const ac = new AbortController();
    ac.abort(new Error('gone'));
    await expect(connector(fetch).send(context({ signal: ac.signal }), broRequest())).rejects.toThrow('gone');
    expect(fetch.calls.length).toBe(0);
  });

  test('a network error is unreachable and keeps its reason without the base URL, host, token or address', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError(`fetch failed for ${BRO_BASE} with ${TOKEN}`, {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.20.30.40:443'), { code: 'ECONNREFUSED' }),
      });
    });
    const err = await refusal(connector(fetch).send(context(), broRequest()));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('the request failed: fetch failed');
    expect(err.message).toContain('connect ECONNREFUSED <host>');
    expect(err.message).not.toContain('bro.example.invalid');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('10.20.30.40');
    expect(err.cause).toBeUndefined();
  });
});

// ------------------------------------------------------------------ bodies

function streamOf(total: number, chunk: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) {
        c.close();
        return;
      }
      const n = Math.min(chunk, total - sent);
      c.enqueue(new Uint8Array(n).fill(0x61));
      sent += n;
    },
  });
}

describe('bodies', () => {
  test('JSON is parsed when the content type says json', async () => {
    const fetch = fakeFetch(() => jsonResponse({ status: 'ACTIVE', n: 2 }));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.transport).toBe('real');
    expect(String(out.target_env)).toBe('SSFB_BRO_API_URL');
    expect(out.data).toEqual({ status: 200, body: { status: 'ACTIVE', n: 2 }, truncated: false, rule_index: 'default' });
    expect(out.truncated).toBeUndefined();
  });

  test('problem+json is parsed too', async () => {
    const fetch = fakeFetch(
      () => new Response('{"title":"not found"}', { status: 404, headers: { 'content-type': 'application/problem+json' } }),
    );
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.status).toBe(404);
    expect(out.data.body).toEqual({ title: 'not found' });
  });

  test('text stays text', async () => {
    const fetch = fakeFetch(() => new Response('plain answer', { headers: { 'content-type': 'text/plain' } }));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.body).toBe('plain answer');
  });

  test('JSON-looking text without a json content type is not parsed', async () => {
    const fetch = fakeFetch(() => new Response('{"a":1}', { headers: { 'content-type': 'text/html' } }));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.body).toBe('{"a":1}');
  });

  test('malformed JSON falls back to text', async () => {
    const fetch = fakeFetch(() => new Response('{"a":', { headers: { 'content-type': 'application/json' } }));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.body).toBe('{"a":');
  });

  test('an empty body is an empty string', async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 204 }));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data).toEqual({ status: 204, body: '', truncated: false, rule_index: 'default' });
  });

  test('a 5xx is returned with its status, not thrown', async () => {
    const fetch = fakeFetch(() => jsonResponse({ error: 'boom' }, 503));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.status).toBe(503);
  });

  test('a body over MAX_HTTP_BODY_BYTES is cut and truncated=true', async () => {
    const fetch = fakeFetch(
      () => new Response(streamOf(MAX_HTTP_BODY_BYTES + 100_000, 64 * 1024), { headers: { 'content-type': 'application/json' } }),
    );
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.truncated).toBe(true);
    expect(out.truncated).toBe(true);
    expect(typeof out.data.body).toBe('string');
    expect((out.data.body as string).length).toBe(MAX_HTTP_BODY_BYTES);
  });

  test('a single chunk over the cap is cut at the cap', async () => {
    const fetch = fakeFetch(() => new Response(streamOf(MAX_HTTP_BODY_BYTES + 1, MAX_HTTP_BODY_BYTES + 1)));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.truncated).toBe(true);
    expect((out.data.body as string).length).toBe(MAX_HTTP_BODY_BYTES);
  });

  test('a body of exactly MAX_HTTP_BODY_BYTES is not truncated', async () => {
    const fetch = fakeFetch(() => new Response(streamOf(MAX_HTTP_BODY_BYTES, 64 * 1024)));
    const out = (await connector(fetch).send(context(), broRequest())) as ConnectorResult<HttpCallData>;
    expect(out.data.truncated).toBe(false);
    expect(out.truncated).toBeUndefined();
  });
});

// -------------------------------------------------------------------- mock

describe('mock branch', () => {
  test('mock mode answers from the fixture with the http_call key and never calls fetch', async () => {
    const seen: unknown[] = [];
    const port: MockPort = {
      enabled: true,
      strict: true,
      lookup: async (tool, keyInput) => {
        seen.push({ tool, keyInput });
        return { hit: true, value: { status: 200, body: { ok: true }, truncated: false, rule_index: 'default' }, hash: 'abc' };
      },
    };
    const fetch = fakeFetch(() => jsonResponse({}));
    const req = broRequest();
    const out = (await connector(fetch).send(context({ mock: port }), req)) as ConnectorResult<HttpCallData>;
    expect(out.transport).toBe('mock');
    expect(out.data.body).toEqual({ ok: true });
    expect(String(out.target_env)).toBe('SSFB_BRO_API_URL');
    expect(seen).toEqual([{ tool: 'http_call', keyInput: req.keyInput }]);
    expect(fetch.calls.length).toBe(0);
  });

  test('a strict miss throws strict_miss and never calls fetch', async () => {
    const port: MockPort = { enabled: true, strict: true, lookup: async () => ({ hit: false, key_string: '{"k":1}', hash: 'h1' }) };
    const fetch = fakeFetch(() => jsonResponse({}));
    const err = await refusal(connector(fetch).send(context({ mock: port }), broRequest()));
    expect(err.code).toBe('strict_miss');
    expect(fetch.calls.length).toBe(0);
  });

  test('a non-strict miss returns fixture_miss and never calls fetch', async () => {
    const port: MockPort = { enabled: true, strict: false, lookup: async () => ({ hit: false, key_string: '{"k":1}', hash: 'h1' }) };
    const fetch = fakeFetch(() => jsonResponse({}));
    const out = await connector(fetch).send(context({ mock: port }), broRequest());
    expect(out.fixture_miss).toBe(true);
    expect(fetch.calls.length).toBe(0);
  });

  test('a real call is passed to the recorder with the same key', async () => {
    const recorded: unknown[] = [];
    const port: MockPort = {
      ...realPort,
      record: async (tool, keyInput, output) => {
        recorded.push({ tool, keyInput, output });
      },
    };
    const fetch = fakeFetch(() => jsonResponse({ a: 1 }));
    const req = broRequest();
    await connector(fetch).send(context({ mock: port }), req);
    expect(recorded).toEqual([
      { tool: 'http_call', keyInput: req.keyInput, output: { status: 200, body: { a: 1 }, truncated: false, rule_index: 'default' } },
    ]);
  });
});

// ------------------------------------------------------------ token leaks

describe('no token in errors or results', () => {
  test('the seeded token never shows in any error or result', async () => {
    const texts: string[] = [];
    const collect = (x: unknown): void => {
      texts.push(inspect(x, { depth: 10, showHidden: true }));
      if (x instanceof Error) texts.push(x.message, String(x.stack), inspect(x.cause, { showHidden: true }));
      else texts.push(JSON.stringify(x));
    };
    const runs: [FetchLike, HttpSendRequest, number?][] = [
      [fakeFetch(() => jsonResponse({ ok: true })), broRequest()],
      [fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.invalid' } })), broRequest()],
      [hangingFetch(), broRequest(), 10],
      [fakeFetch(() => { throw new Error(`boom ${TOKEN}`); }), broRequest()],
      [fakeFetch(() => jsonResponse({})), broRequest({ decision: undefined })],
      [fakeFetch(() => jsonResponse({})), broRequest({ method: 'POST' })],
      [fakeFetch(() => jsonResponse({})), harborRequest({ customerId: 'a b' })],
    ];
    for (const [f, req, timeoutMs] of runs) {
      try {
        collect(await connector(f, timeoutMs !== undefined ? { timeoutMs } : {}).send(context(), req));
      } catch (err) {
        collect(err);
      }
    }
    // The Basic case too: neither the raw value nor its base64 may leak.
    const basic = Buffer.from('svc-user:pa55', 'utf8').toString('base64');
    try {
      collect(await connector(fakeFetch(() => new Response(null, { status: 307 })), { registry: stub }).send(context(), svcRequest('svc')));
    } catch (err) {
      collect(err);
    }
    const all = texts.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('svc-user:pa55');
    expect(all).not.toContain(basic);
    expect(texts.length).toBeGreaterThan(8);
  });
});
