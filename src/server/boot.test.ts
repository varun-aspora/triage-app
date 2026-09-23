import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../config/errors.ts';
import { startRetentionTimer, type RetentionTimerHandle, type RetentionTimers } from '../runstore/retention.ts';
import type { RunStore } from '../runstore/types.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { prepareServer, type ServerConfig, type ServerDeps } from './boot.ts';
import { describeBootError, runServer } from '../../bin/triage-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

type FakeTimers = RetentionTimers & { set: number; cleared: RetentionTimerHandle[]; handles: RetentionTimerHandle[] };

function fakeTimers(): FakeTimers {
  const t: FakeTimers = {
    set: 0,
    cleared: [],
    handles: [],
    setInterval() {
      t.set++;
      const handle = { id: t.set };
      t.handles.push(handle);
      return handle;
    },
    clearInterval(handle) {
      t.cleared.push(handle);
    },
  };
  return t;
}

function fakeStore(): RunStore & { listed: number; cleared: number } {
  const s = {
    provider: 'sqlite',
    listed: 0,
    cleared: 0,
    async listExpired() {
      s.listed++;
      return [];
    },
    async deleteRun() {
      return false;
    },
    async clearExpiredIdempotencyKeys() {
      s.cleared++;
      return 0;
    },
  };
  return s as unknown as RunStore & { listed: number; cleared: number };
}

function config(http: { port?: number; authToken?: string }, retentionDays?: number): ServerConfig {
  return {
    http: { port: http.port ?? 3000, allowSlackPost: false, ...(http.authToken !== undefined ? { authToken: http.authToken } : {}) },
    runs: retentionDays !== undefined ? { retentionDays } : {},
    db: { provider: 'sqlite' },
    paths: {},
  } as unknown as ServerConfig;
}

describe('prepareServer', () => {
  for (const [label, token] of [
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ] as const) {
    test(`refuses a ${label} TRIAGE_HTTP_AUTH_TOKEN and starts no timer`, async () => {
      const timers = fakeTimers();
      let storesBuilt = 0;
      const deps: ServerDeps = {
        createStore: async () => {
          storesBuilt++;
          return fakeStore();
        },
        timer: { timers, log: () => {} },
      };
      const err = await prepareServer(config({ port: 4321, ...(token !== undefined ? { authToken: token } : {}) }), deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).keys).toEqual(['TRIAGE_HTTP_AUTH_TOKEN']);
      expect((err as ConfigError).message).toContain('TRIAGE_HTTP_AUTH_TOKEN');
      expect(storesBuilt).toBe(0);
      expect(timers.set).toBe(0);
    });
  }

  test('returns TRIAGE_HTTP_PORT, starts the retention timer once and stop() clears it', async () => {
    const timers = fakeTimers();
    const store = fakeStore();
    let started = 0;
    let timer: ReturnType<typeof startRetentionTimer> | undefined;
    const prepared = await prepareServer(config({ port: 4321, authToken: 'test-token' }, 30), {
      createStore: async () => store,
      startTimer: (s, c, o) => {
        started++;
        timer = startRetentionTimer(s, c, o);
        return timer;
      },
      timer: { timers, now: () => Date.UTC(2026, 8, 24), log: () => {} },
    });
    await timer?.idle();

    expect(prepared.port).toBe(4321);
    expect(started).toBe(1);
    expect(timers.set).toBe(1);
    expect(store.listed).toBe(1);
    expect(store.cleared).toBe(1);
    expect(timers.cleared).toEqual([]);

    prepared.stop();
    expect(timers.cleared).toEqual([timers.handles[0]]);
    prepared.stop();
    expect(timers.cleared.length).toBe(1);
  });

  test('a store that fails to build stops the boot with no timer', async () => {
    const timers = fakeTimers();
    class StoreBuildError extends Error {
      override name = 'StoreBuildError';
    }
    const err = await prepareServer(config({ authToken: 'test-token' }), {
      createStore: async () => {
        throw new StoreBuildError('no store');
      },
      timer: { timers, log: () => {} },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreBuildError);
    expect(timers.set).toBe(0);
  });

  describe('with a test home', () => {
    let home: TestHome | undefined;
    afterEach(() => {
      home?.cleanup();
      home = undefined;
    });

    test('builds the folder store from config and prunes once at start', async () => {
      home = makeTestHome({
        overrides: { TRIAGE_HTTP_AUTH_TOKEN: 'test-token', TRIAGE_HTTP_PORT: '4555', TRIAGE_RUNS_RETENTION_DAYS: '30' },
      });
      const timers = fakeTimers();
      const lines: string[] = [];
      let timer: ReturnType<typeof startRetentionTimer> | undefined;
      const prepared = await prepareServer(home.config, {
        startTimer: (s, c, o) => (timer = startRetentionTimer(s, c, o)),
        timer: { timers, log: (l) => lines.push(l) },
      });
      await timer?.idle();
      expect(prepared.port).toBe(4555);
      expect(timers.set).toBe(1);
      expect(lines.filter((l) => l.includes('failed'))).toEqual([]);
      prepared.stop();
      expect(timers.cleared.length).toBe(1);
    });

    test('refuses the default test home, whose token is blank', async () => {
      home = makeTestHome();
      const timers = fakeTimers();
      const err = await prepareServer(home.config, { timer: { timers, log: () => {} } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).keys).toEqual(['TRIAGE_HTTP_AUTH_TOKEN']);
      expect(timers.set).toBe(0);
    });
  });

  test('src/server/boot.ts reads no env and uses no Bun APIs', () => {
    const src = readFileSync(join(HERE, 'boot.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\bBun\./);
    expect(src).not.toMatch(/from ['"]bun:/);
  });
});

describe('bin/triage-server.mjs', () => {
  test('sets PORT before importing the server', async () => {
    const env: Record<string, string | undefined> = {};
    const steps: string[] = [];
    let portAtImport: string | undefined;
    const cfg = { marker: 'config' };
    let stops = 0;
    const prepared = await runServer({
      env,
      loadConfig: () => {
        steps.push('loadConfig');
        return cfg;
      },
      prepareServer: async (c: unknown) => {
        expect(c).toBe(cfg);
        steps.push('prepareServer');
        return { port: 4321, stop: () => stops++ };
      },
      importServer: async () => {
        steps.push('importServer');
        portAtImport = env.PORT;
      },
    });
    expect(steps).toEqual(['loadConfig', 'prepareServer', 'importServer']);
    expect(portAtImport).toBe('4321');
    expect(prepared.port).toBe(4321);
    expect(stops).toBe(0);
  });

  test('a refused boot sets no PORT and never imports the server', async () => {
    const env: Record<string, string | undefined> = {};
    let imported = false;
    const err = await runServer({
      env,
      loadConfig: () => ({}),
      prepareServer: async () => {
        throw ConfigError.of('TRIAGE_HTTP_AUTH_TOKEN', 'is blank; the HTTP API needs a bearer token');
      },
      importServer: async () => {
        imported = true;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(imported).toBe(false);
    expect(env.PORT).toBeUndefined();
  });

  test('a failed server import stops the timer and rethrows', async () => {
    let stops = 0;
    const boom = new Error('import failed');
    const err = await runServer({
      env: {},
      loadConfig: () => ({}),
      prepareServer: async () => ({ port: 3000, stop: () => stops++ }),
      importServer: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(stops).toBe(1);
  });

  test('describeBootError prints ConfigError keys and only the name of other errors', () => {
    const cfg = describeBootError(ConfigError.of('TRIAGE_HTTP_AUTH_TOKEN', 'is blank; the HTTP API needs a bearer token'));
    expect(cfg.exitCode).toBe(3);
    expect(cfg.line).toContain('TRIAGE_HTTP_AUTH_TOKEN');

    class PgError extends Error {
      override name = 'PgError';
    }
    const other = describeBootError(new PgError('connect failed for postgresql://user:secret@db.internal/x'));
    expect(other.exitCode).toBe(1);
    expect(other.line).toBe('triage-server: boot failed (PgError)');

    const missing = Object.assign(new Error(`Cannot find module '${join(REPO, 'dist/server.mjs')}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(describeBootError(missing).line).toContain('bun run build');
    expect(describeBootError(undefined).line).toBe('triage-server: boot failed (unknown error)');
  });
});
