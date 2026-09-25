import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../config/errors.ts';
import { startRetentionTimer, type RetentionTimerHandle, type RetentionTimers } from '../runstore/retention.ts';
import type { RunStore } from '../runstore/types.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { prepareServer, type ServerConfig, type ServerDeps } from './boot.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

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
    // Mock mode keeps the default repo sync timer off.
    mock: { enabled: true },
    repos: { syncIntervalMs: 24 * 60 * 60 * 1000, syncInterfaces: ['http'] },
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

  test('starts the repo sync timer with the config and stop() stops it too', async () => {
    const seen: ServerConfig[] = [];
    let stopped = 0;
    const cfg = config({ port: 4321, authToken: 'test-token' });
    const prepared = await prepareServer(cfg, {
      createStore: async () => fakeStore(),
      timer: { timers: fakeTimers(), log: () => {} },
      startRepoSync: (c) => {
        seen.push(c);
        return { on: true, stop: () => void stopped++, idle: async () => {} };
      },
    });
    expect(seen).toEqual([cfg]);
    prepared.stop();
    expect(stopped).toBe(1);
  });

  test('the default repo sync timer stays off in mock mode', async () => {
    const timers = fakeTimers();
    const prepared = await prepareServer(config({ authToken: 'test-token' }), {
      createStore: async () => fakeStore(),
      timer: { timers, log: () => {} },
      repoSyncTimer: { timers, log: () => {} },
    });
    // Only the retention timer was set.
    expect(timers.set).toBe(1);
    prepared.stop();
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
