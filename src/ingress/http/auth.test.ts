import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { buildApp } from '../../app.ts';
import { ConfigError } from '../../config/errors.ts';
import { httpModule as bearerModule } from '../../http/bearer-auth.http.ts';
import type { HttpContext, HttpModule } from '../../http/types.ts';
import { makeTestConfig } from '../../../test/support/fake-tool-context.ts';
import { AUTH_TOKEN_KEY, assertHttpConfig, bearerAuth, bearerToken, tokensMatch, UNAUTHORIZED_BODY } from './auth.ts';
import { createTriageRoutes, type TriageRouteDeps } from './routes.ts';

// A test token, not a real credential.
const TOKEN = 'tok_test_7f3a9c2e5b1d4068';
const RUN = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';

const ctx: HttpContext = { config: () => makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: TOKEN }), deps: {} };

/** Route deps that fail the test if any route handler reaches them. */
function untouchableDeps(): { source: () => TriageRouteDeps; built: () => number } {
  let built = 0;
  return {
    source: () => {
      built++;
      throw new Error('route deps must not be built for an unauthenticated request');
    },
    built: () => built,
  };
}

function appWith(source: () => TriageRouteDeps): Hono {
  const triage: HttpModule = { id: 'triage', order: 10, mount: (a) => void a.route('/', createTriageRoutes(source)) };
  return buildApp([triage, bearerModule], ctx);
}

const ROUTES: readonly (readonly [string, string])[] = [
  ['POST', '/triage'],
  ['GET', `/triage/${RUN}`],
  ['POST', `/triage/${RUN}/ask`],
  ['POST', `/triage/${RUN}/resume`],
  ['POST', `/triage/${RUN}/feedback`],
  ['POST', `/triage/${RUN}/post-to-slack`],
  ['GET', '/no/such/route'],
];

type DenyCase = { readonly name: string; readonly headers: Record<string, string>; readonly query?: string };

const DENY: readonly DenyCase[] = [
  { name: 'no Authorization header', headers: {} },
  { name: 'Basic scheme with the token', headers: { authorization: `Basic ${TOKEN}` } },
  { name: 'Basic scheme, base64 user:token', headers: { authorization: `Basic ${Buffer.from(`triage:${TOKEN}`).toString('base64')}` } },
  { name: 'Bearer with no token', headers: { authorization: 'Bearer' } },
  { name: 'Bearer with an empty token', headers: { authorization: 'Bearer ' } },
  { name: 'a wrong token', headers: { authorization: 'Bearer tok_test_wrong_wrong_wrong' } },
  { name: 'a token with a prefix', headers: { authorization: `Bearer x${TOKEN}` } },
  { name: 'a token with a suffix', headers: { authorization: `Bearer ${TOKEN}x` } },
  { name: 'the token with a character dropped', headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}` } },
  { name: 'two spaces before the token', headers: { authorization: `Bearer  ${TOKEN}` } },
  { name: 'the token twice', headers: { authorization: `Bearer ${TOKEN} ${TOKEN}` } },
  { name: 'the token alone, no scheme', headers: { authorization: TOKEN } },
  { name: 'the token in another header', headers: { 'x-auth-token': TOKEN } },
  { name: 'the token in the query string', headers: {}, query: `token=${TOKEN}` },
  { name: 'access_token in the query string', headers: {}, query: `access_token=${TOKEN}` },
  { name: 'an authorization query parameter', headers: {}, query: `authorization=${encodeURIComponent(`Bearer ${TOKEN}`)}` },
];

describe('deny matrix', () => {
  for (const d of DENY) {
    test(`${d.name} -> 401 on every route`, async () => {
      const deps = untouchableDeps();
      const app = appWith(deps.source);
      const bodies = new Set<string>();
      for (const [method, path] of ROUTES) {
        const url = d.query !== undefined ? `${path}?${d.query}` : path;
        const res = await app.request(url, {
          method,
          headers: { 'content-type': 'application/json', ...d.headers },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        const text = await res.text();
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(TOKEN.slice(0, 8));
        bodies.add(text);
      }
      expect([...bodies]).toEqual([JSON.stringify(UNAUTHORIZED_BODY)]);
      expect(deps.built()).toBe(0);
    });
  }

  test('the 401 body is identical across every deny case', async () => {
    const app = appWith(untouchableDeps().source);
    const bodies = new Set<string>();
    for (const d of DENY) {
      const res = await app.request(d.query !== undefined ? `/triage?${d.query}` : '/triage', { method: 'POST', headers: d.headers, body: '{}' });
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });
});

describe('accept', () => {
  test('the right token reaches the routes; an unknown route is 404 only after auth', async () => {
    const app = appWith(() => ({ store: { getRun: async () => null } }) as unknown as TriageRouteDeps);
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await app.request('/no/such/route', { headers: auth })).status).toBe(404);
    expect((await app.request('/no/such/route')).status).toBe(401);
    expect((await app.request(`/triage/${RUN}`, { headers: auth })).status).toBe(404);
  });

  test('the scheme is case-insensitive, the token is not', async () => {
    const app = appWith(() => ({ store: { getRun: async () => null } }) as unknown as TriageRouteDeps);
    expect((await app.request(`/triage/${RUN}`, { headers: { authorization: `bearer ${TOKEN}` } })).status).toBe(404);
    expect((await app.request(`/triage/${RUN}`, { headers: { authorization: `Bearer ${TOKEN.toUpperCase()}` } })).status).toBe(401);
  });
});

describe('bearer-auth module', () => {
  test('a blank token answers 503 on every route, never serves one', async () => {
    const blank: HttpContext = { config: () => makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: '' }), deps: {} };
    const triage: HttpModule = { id: 'triage', order: 10, mount: (a) => void a.route('/', createTriageRoutes(untouchableDeps().source)) };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const app = buildApp([triage, bearerModule], blank);
    for (const [method, path] of ROUTES) {
      const res = await app.request(path, { method, headers: { authorization: 'Bearer ' } });
      expect(res.status).toBe(503);
    }
    // The log line names the key, never a value.
    expect(errorSpy.mock.calls.flat().join(' ')).toContain(AUTH_TOKEN_KEY);
    errorSpy.mockRestore();
  });

  test('a config that cannot load answers 503 and is retried on the next request', async () => {
    let calls = 0;
    const flaky: HttpContext = {
      config: () => {
        calls++;
        if (calls === 1) throw ConfigError.of('TRIAGE_HOME', 'is not set');
        return makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: TOKEN });
      },
      deps: {},
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const app = buildApp([bearerModule], flaky);
    expect((await app.request('/x', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
    errorSpy.mockRestore();
    expect((await app.request('/x', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await app.request('/x')).status).toBe(401);
  });

  test('mounting reads no config', () => {
    let calls = 0;
    const counting: HttpContext = { config: () => (calls++, makeTestConfig()), deps: {} };
    buildApp([bearerModule], counting);
    expect(calls).toBe(0);
  });
});

// ------------------------------------------------------------------ config

describe('assertHttpConfig', () => {
  const http = (authToken: string | undefined) => ({ http: { port: 3000, allowSlackPost: false, ...(authToken !== undefined ? { authToken } : {}) } });

  for (const [name, value] of [
    ['missing', undefined],
    ['empty', ''],
    ['spaces', '   '],
    ['tabs and newlines', '\t\n \t'],
  ] as const) {
    test(`throws for a ${name} token, naming the key only`, () => {
      let caught: unknown;
      try {
        assertHttpConfig(http(value));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const err = caught as ConfigError;
      expect(err.keys).toEqual([AUTH_TOKEN_KEY]);
      expect(err.message).toContain(AUTH_TOKEN_KEY);
      if (value !== undefined && value !== '') expect(err.message).not.toContain(value);
    });
  }

  test('returns the token when set', () => {
    expect(assertHttpConfig(http(TOKEN))).toBe(TOKEN);
  });

  test('works on a loaded config; a blank .env value throws', () => {
    expect(() => assertHttpConfig(makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: '' }))).toThrow(AUTH_TOKEN_KEY);
    expect(assertHttpConfig(makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: TOKEN }))).toBe(TOKEN);
  });

  test('bearerAuth refuses a blank token', () => {
    expect(() => bearerAuth('')).toThrow(ConfigError);
    expect(() => bearerAuth('  ')).toThrow(AUTH_TOKEN_KEY);
  });
});

// ------------------------------------------------------------------ compare

describe('tokensMatch', () => {
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  test('uses crypto.timingSafeEqual', () => {
    spy = spyOn(crypto, 'timingSafeEqual');
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(`${TOKEN.slice(0, -1)}z`, TOKEN)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('a length mismatch still runs the constant-time compare and fails', () => {
    spy = spyOn(crypto, 'timingSafeEqual');
    expect(tokensMatch('short', TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(3);
    // Equal-length buffers every time (hash digests), so timingSafeEqual never throws.
    for (const [a, b] of spy.mock.calls as [Buffer, Buffer][]) expect(a.length).toBe(b.length);
  });

  test('the middleware compares through timingSafeEqual', async () => {
    spy = spyOn(crypto, 'timingSafeEqual');
    const app = new Hono();
    app.use('*', bearerAuth(TOKEN));
    app.get('/ok', (c) => c.text('ok'));
    expect((await app.request('/ok', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await app.request('/ok', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('bearerToken', () => {
  test('reads only the Bearer scheme with one space and one token', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`BEARER ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken('Bearer ')).toBeUndefined();
    expect(bearerToken(`Basic ${TOKEN}`)).toBeUndefined();
    expect(bearerToken(`Bearer ${TOKEN} extra`)).toBeUndefined();
    expect(bearerToken(TOKEN)).toBeUndefined();
  });
});
