// createRunStore and getRunStore. The postgres path runs the real shared
// runner and the real migrator over the fake pool; no database is opened.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestHome } from '../../test/support/home.ts';
import { ConfigError } from '../config/errors.ts';
import type { PoolFactory } from '../db/pg.ts';
import { redactPersisted } from '../gate/redact.ts';
import { RUN_A, sampleRequest } from './contract.ts';
import { createFakePg, FAKE_PG_DSN } from './fake-pg.ts';
import { createRunStore, getRunStore, resetRunStoreForTests, type RunStoreConfig } from './index.ts';
import { SQL, createPostgresRunStore, type PgStoreRunner } from './postgres.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function config(provider: string, url: string): RunStoreConfig {
  const root = mkdtempSync(join(tmpdir(), 'runstore-index-'));
  dirs.push(root);
  return {
    db: { provider: provider as RunStoreConfig['db']['provider'], url },
    paths: { runsDir: join(root, 'runs'), dataDir: join(root, 'data') } as RunStoreConfig['paths'],
  };
}

describe('createRunStore', () => {
  test('createRunStore(sqlite) never constructs a pg runner (spy count 0)', async () => {
    let pools = 0;
    let runners = 0;
    let migrations = 0;
    const poolFactory: PoolFactory = () => {
      pools++;
      throw new Error('no pool for sqlite');
    };
    const store = await createRunStore(config('sqlite', './.data/triage.sqlite'), {
      poolFactory,
      pgRunner: () => {
        runners++;
        throw new Error('no runner for sqlite');
      },
      migrate: async () => {
        migrations++;
      },
    });
    expect(store.provider).toBe('folder');
    expect([pools, runners, migrations]).toEqual([0, 0, 0]);
    await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
    expect((await store.getRun(RUN_A))?.run_id).toBe(RUN_A);
    expect([pools, runners, migrations]).toEqual([0, 0, 0]);
  });

  test('createRunStore(postgres) migrates on the shared runner before the first store call', async () => {
    const fake = createFakePg({ migrated: false });
    const store = await createRunStore(config('postgres', FAKE_PG_DSN), { poolFactory: fake.poolFactory });
    expect(store.provider).toBe('postgres');
    expect(fake.poolsCreated()).toBe(1);
    expect(fake.isMigrated()).toBe(true);
    const migrationEnd = fake.calls.length;
    expect(fake.calls.some((c) => c.text.includes('CREATE TABLE triage.runs ('))).toBe(true);
    // Nothing the store itself issues ran before the migration.
    const storeTexts = new Set<string>(Object.values(SQL));
    expect(fake.calls.filter((c) => storeTexts.has(c.text))).toEqual([]);

    await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
    expect(fake.calls.slice(migrationEnd).map((c) => c.text)).toEqual([SQL.createRun]);
    expect((await store.getRun(RUN_A))?.run_id).toBe(RUN_A);

    // A second store on the same DSN and factory shares the runner and skips applied files.
    const again = await createRunStore(config('postgres', FAKE_PG_DSN), { poolFactory: fake.poolFactory });
    expect(fake.poolsCreated()).toBe(1);
    expect((await again.getRun(RUN_A))?.run_id).toBe(RUN_A);
  });

  test('without the migration the fake refuses run store statements', async () => {
    const fake = createFakePg({ migrated: false });
    const store = createPostgresRunStore({ runner: fake.runner() });
    await expect(store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)))).rejects.toThrow(
      'relation "triage.runs" does not exist',
    );
  });

  test('migrate runs before the store is returned, and a failed migration returns no store', async () => {
    const order: string[] = [];
    const fake = createFakePg();
    const runner = fake.runner();
    const spyRunner: PgStoreRunner = {
      query: async (text, params) => {
        order.push('query');
        return runner.query(text, params);
      },
      transaction: (fn) => runner.transaction(fn),
    };
    const store = await createRunStore(config('postgres', FAKE_PG_DSN), {
      pgRunner: () => spyRunner,
      migrate: async (r, options) => {
        expect(r).toBe(spyRunner);
        expect(options).toEqual({ dir: '/opt/triage/migrations' });
        order.push('migrate');
      },
      migrationsDir: '/opt/triage/migrations',
    });
    await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
    expect(order).toEqual(['migrate', 'query']);

    const failing = createRunStore(config('postgres', FAKE_PG_DSN), {
      pgRunner: () => spyRunner,
      migrate: async () => {
        throw new Error('migration 0001_init.sql failed');
      },
    });
    await expect(failing).rejects.toThrow('migration 0001_init.sql failed');
  });

  test('postgres with a non-postgres DSN fails with a key-only error before any pool is built', async () => {
    const fake = createFakePg();
    const secret = 'mysql://user:hunter2@db.invalid/triage';
    const err = await createRunStore(config('postgres', secret), { poolFactory: fake.poolFactory }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).toContain('TRIAGE_DB_URL');
    expect(String((err as Error).message)).not.toContain('hunter2');
    expect(fake.poolsCreated()).toBe(0);
  });

  test('an unknown provider is refused naming the key only', async () => {
    const err = await createRunStore(config('mongodb', 'mongodb://x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).keys).toEqual(['TRIAGE_DB_PROVIDER']);
    expect(String((err as Error).message)).not.toContain('mongodb://x');
  });
});

describe('getRunStore', () => {
  test('builds the store once from the config in TRIAGE_HOME', async () => {
    const home = makeTestHome();
    const saved = process.env.TRIAGE_HOME;
    process.env.TRIAGE_HOME = home.home;
    resetRunStoreForTests();
    try {
      const first = await getRunStore();
      const second = await getRunStore();
      expect(first).toBe(second);
      expect(first.provider).toBe(home.config.db.provider === 'postgres' ? 'postgres' : 'folder');
    } finally {
      if (saved === undefined) delete process.env.TRIAGE_HOME;
      else process.env.TRIAGE_HOME = saved;
      // The cached store points at the temp home deleted below.
      resetRunStoreForTests();
      home.cleanup();
    }
  });
});
