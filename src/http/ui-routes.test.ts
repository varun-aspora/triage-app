import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.ts';
import { makeTestConfig } from '../../test/support/fake-tool-context.ts';
import { httpModules } from './http-modules.gen.ts';
import type { HttpContext, HttpModule } from './types.ts';
import { isPublicUiRequest } from './ui-public.ts';
import { createUiRoutes } from './ui-routes.ts';

// Test token; not a real credential.
const TOKEN = 'test-token';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-ui-test-'));
  made.push(dir);
  return dir;
}

/** A fake build: dist/ with index.html and one asset, plus a secret next to it that must never be served. */
function makeDist(): { root: string; dist: string } {
  const root = tempDir();
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'x.js'), 'console.log(1)');
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
  writeFileSync(join(root, '.env'), 'SECRET_IN_PARENT=1');
  writeFileSync(join(root, 'package.json'), '{"secret":"in parent"}');
  symlinkSync(join(root, 'package.json'), join(dist, 'link.json'));
  return { root, dist };
}

function config(env: Record<string, string> = {}) {
  return makeTestConfig({ TRIAGE_HTTP_AUTH_TOKEN: TOKEN, TRIAGE_UI_ENV: 'production', ...env });
}

function fullApp(env: Record<string, string> = {}) {
  const ctx: HttpContext = { config: () => config(env), deps: {} };
  return buildApp(httpModules as readonly HttpModule[], ctx);
}

function uiApp(distDir: string) {
  return createUiRoutes({ config: () => config(), entities: () => ['ssfb', 'rtl'], distDir });
}

describe('public and authed /ui routes in the full app', () => {
  test('/ui/config.json answers without a token and carries only the env', async () => {
    const res = await fullApp().request('/ui/config.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ env: 'production' });
  });

  test('/ui/config.json defaults to non-production', async () => {
    const res = await fullApp({ TRIAGE_UI_ENV: '' }).request('/ui/config.json');
    expect(await res.json()).toEqual({ env: 'non-production' });
  });

  test('/ui/config.json still answers while the token is blank, so the prompt can load', async () => {
    const res = await fullApp({ TRIAGE_HTTP_AUTH_TOKEN: '' }).request('/ui/config.json');
    expect(res.status).toBe(200);
  });

  test('/ui/session needs the token', async () => {
    expect((await fullApp().request('/ui/session')).status).toBe(401);
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await fullApp({ TRIAGE_HTTP_AUTH_TOKEN: '' }).request('/ui/session', auth)).status).toBe(503);
    quiet.mockRestore();
  });

  test('only GET and HEAD are public', async () => {
    expect((await fullApp().request('/ui/', { method: 'POST' })).status).toBe(401);
    expect((await fullApp().request('/ui/config.json', { method: 'DELETE' })).status).toBe(401);
  });

  test('API routes still need the token', async () => {
    for (const path of ['/triage', '/repos', '/doctor', '/', '/uix', '/ui-session']) {
      expect((await fullApp().request(path)).status).toBe(401);
    }
  });

  test('a dot-segment path that leaves /ui is not public', async () => {
    // URL parsing turns /ui/%2e%2e/.env into /.env before routing.
    expect((await fullApp().request('/ui/%2e%2e/.env')).status).toBe(401);
    expect((await fullApp().request('/ui/../triage')).status).toBe(401);
  });
});

describe('GET /ui/session', () => {
  test('returns mode, entities and the slack flag', async () => {
    const res = await uiApp(makeDist().dist).request('/ui/session');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, mock_mode: true, entities: ['ssfb', 'rtl'], allow_slack_post: false });
  });
});

describe('static shell', () => {
  const { dist } = makeDist();
  const app = uiApp(dist);

  test('/ui redirects to /ui/', async () => {
    const res = await app.request('/ui');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/ui/');
  });

  test('/ui/ and client routes serve index.html with the CSP', async () => {
    for (const path of ['/ui/', '/ui/runs/abc', '/ui/guides/new']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test('the full app serves the shell without a token', async () => {
    const full = buildApp(
      [
        ...(httpModules as readonly HttpModule[]).filter((m) => m.id !== 'ui'),
        { id: 'ui', order: 50, mount: (a) => void a.route('/', uiApp(dist)) },
      ],
      { config: () => config(), deps: {} },
    );
    const res = await full.request('/ui/runs/abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toBeNull();
    expect((await full.request('/ui/assets/x.js')).status).toBe(200);
  });

  test('hashed assets are cached for good', async () => {
    const res = await app.request('/ui/assets/x.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.text()).toBe('console.log(1)');
  });

  test('other files are revalidated', async () => {
    const res = await app.request('/ui/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  test('a missing file with an extension is a 404, not the shell', async () => {
    expect((await app.request('/ui/assets/missing.js')).status).toBe(404);
  });

  test('never serves a file outside the dist dir', async () => {
    const attempts = [
      '/ui/%2e%2e/.env',
      '/ui/..%2f..%2fpackage.json',
      '/ui/..%2F.env',
      '/ui/a%00b',
      '/ui/%5c..',
      '/ui/%5c..%5cpackage.json',
      '/ui/%2fetc%2fpasswd',
      '/ui/assets/%2e%2e%2f%2e%2e%2f.env',
      '/ui/%252e%252e/.env',
      '/ui/%E0%A4%A',
      '/ui/link.json',
    ];
    for (const path of attempts) {
      const res = await app.request(path);
      const text = await res.text();
      expect(text).not.toContain('SECRET_IN_PARENT');
      expect(text).not.toContain('in parent');
      expect([200, 400, 404]).toContain(res.status);
      if (res.status === 200) expect(text).toContain('<div id="root">');
    }
    expect((await app.request('/ui/..%2f..%2fpackage.json')).status).toBe(400);
    expect((await app.request('/ui/a%00b')).status).toBe(400);
    expect((await app.request('/ui/%5c..')).status).toBe(400);
    expect((await app.request('/ui/link.json')).status).toBe(404);
  });

  test('a missing build answers 503 with a hint', async () => {
    const res = await uiApp(join(tempDir(), 'nope')).request('/ui/');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('bun run build:web');
  });

  test('a build that appears later is picked up without a restart', async () => {
    const root = tempDir();
    const later = uiApp(join(root, 'dist'));
    expect((await later.request('/ui/')).status).toBe(503);
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), '<div id="root"></div>');
    expect((await later.request('/ui/')).status).toBe(200);
  });
});

describe('isPublicUiRequest', () => {
  const cases: Array<[string, string, boolean]> = [
    ['GET', '/ui', true],
    ['GET', '/ui/', true],
    ['HEAD', '/ui/', true],
    ['GET', '/ui/config.json', true],
    ['GET', '/ui/assets/index-abc.js', true],
    ['GET', '/ui/runs/01K62ZQ8M4', true],
    ['GET', '/ui/session', false],
    ['HEAD', '/ui/session', false],
    ['POST', '/ui/', false],
    ['POST', '/ui/config.json', false],
    ['PUT', '/ui/x', false],
    ['GET', '/uix', false],
    ['GET', '/ui-session', false],
    ['GET', '/', false],
    ['GET', '/triage', false],
    ['GET', '/services', false],
  ];
  for (const [method, path, want] of cases) {
    test(`${method} ${path} -> ${want}`, () => {
      expect(isPublicUiRequest(method, path)).toBe(want);
    });
  }
});
