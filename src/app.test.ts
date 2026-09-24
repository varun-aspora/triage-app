import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import app, { AUTH_NOT_CONFIGURED, buildApp, HttpModuleError, orderModules } from './app.ts';
import { makeTestConfig } from '../test/support/fake-tool-context.ts';
import { BEARER_AUTH_ID, type HttpContext, type HttpModule } from './http/types.ts';
import { httpModules } from './http/http-modules.gen.ts';

const ctx: HttpContext = { config: () => makeTestConfig(), deps: {} };

// Test token for the fake bearer module; not a real credential.
const TOKEN = 'test-token';

function bearer(order = 0): HttpModule {
  return {
    id: BEARER_AUTH_ID,
    order,
    mount(a) {
      a.use('*', async (c, next) => {
        if (c.req.header('authorization') !== `Bearer ${TOKEN}`) return c.json({ error: 'unauthorized' }, 401);
        await next();
      });
    },
  };
}

function route(id: string, order: number, log: string[] = []): HttpModule {
  return {
    id,
    order,
    mount(a) {
      log.push(id);
      a.get(`/${id}`, (c) => c.text(id));
    },
  };
}

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

const PATHS = [
  ['GET', '/triage'],
  ['POST', '/triage'],
  ['GET', '/triage/run_1'],
  ['POST', '/repos/sync'],
  ['GET', '/repos'],
  ['GET', '/repos/sync/x'],
  ['GET', '/'],
  ['DELETE', '/anything/else'],
] as const;

describe('default app', () => {
  // The default app's context loads the shell's TRIAGE_HOME, so these build the
  // same generated module list against a test config instead of calling it.
  test('answers 503 on every route with no modules', async () => {
    const empty = buildApp([], ctx);
    for (const [method, path] of PATHS) {
      const res = await empty.request(path, { method });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: AUTH_NOT_CONFIGURED });
    }
  });

  test('with the generated modules, answers 401 without a token instead of 503', async () => {
    const tokenCtx: HttpContext = { config: () => makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: TOKEN }), deps: {} };
    const built = buildApp(httpModules as readonly HttpModule[], tokenCtx);
    for (const [method, path] of PATHS) {
      expect((await built.request(path, { method })).status).toBe(401);
    }
  });

  test('with the generated modules and a blank token, still answers 503', async () => {
    const blankCtx: HttpContext = { config: () => makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: '' }), deps: {} };
    const built = buildApp(httpModules as readonly HttpModule[], blankCtx);
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [method, path] of PATHS) {
      const res = await built.request(path, { method, headers: { authorization: 'Bearer ' } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: AUTH_NOT_CONFIGURED });
    }
    quiet.mockRestore();
  });

  test('is a fetch handler', () => {
    expect(typeof app.fetch).toBe('function');
  });
});

describe('buildApp', () => {
  test('without bearer-auth nothing is mounted and everything is 503', async () => {
    const log: string[] = [];
    const built = buildApp([route('triage', 10, log)], ctx);
    expect(log).toEqual([]);
    expect((await built.request('/triage')).status).toBe(503);
  });

  test('a bearer-auth module lifts the 503', async () => {
    const built = buildApp([route('triage', 10), bearer()], ctx);
    const ok = await built.request('/triage', auth);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('triage');
    expect((await built.request('/triage')).status).toBe(401);
    expect((await built.request('/missing', auth)).status).toBe(404);
  });

  test('mounts modules by ascending order, ties by id', () => {
    const log: string[] = [];
    const logged = (m: HttpModule): HttpModule => ({
      ...m,
      mount(a, c) {
        log.push(m.id);
        m.mount(a, c);
      },
    });
    buildApp([route('zeta', 5, log), route('alpha', 20, log), route('beta', 5, log), logged(bearer())].map((m) => m), ctx);
    expect(log).toEqual([BEARER_AUTH_ID, 'beta', 'zeta', 'alpha']);
  });

  test('modules receive the context', () => {
    let seen: HttpContext | undefined;
    buildApp([bearer(), { id: 'probe', order: 1, mount: (_a, c) => void (seen = c) }], ctx);
    expect(seen).toBe(ctx);
  });

  test('refuses bearer-auth that is not strictly first', () => {
    expect(() => orderModules([bearer(5), route('triage', 1)])).toThrow(HttpModuleError);
    expect(() => orderModules([bearer(0), route('aaa', 0)])).toThrow(/lowest order/);
  });

  test('refuses duplicate ids, bad ids and bad orders', () => {
    expect(() => orderModules([route('triage', 1), route('triage', 2)])).toThrow(/duplicate/);
    expect(() => orderModules([route('Triage', 1)])).toThrow(/kebab-case/);
    expect(() => orderModules([route('triage', Number.NaN)])).toThrow(/order/);
  });
});

describe('src/app.ts source', () => {
  test('does not import the agent router', () => {
    const source = readFileSync(fileURLToPath(new URL('./app.ts', import.meta.url)), 'utf8');
    expect(source).not.toContain('createAgentRouter');
    expect(source).not.toContain('@flue/runtime/routing');
  });
});
