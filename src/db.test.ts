// src/db.ts picks the Flue adapter from config. Every home is a temp dir with
// a .env written from .env.example; no real .env is read and no database
// other than a temp sqlite file is opened.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { parse } from 'dotenv';
import { configFromRecord } from './config/env.ts';
import { ConfigError } from './config/errors.ts';
import type { PgPoolOptions, PoolFactory } from './db/pg.ts';
import { NO_RETRY } from './db/pg-retry.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = parse(readFileSync(join(REPO, '.env.example'), 'utf8'));
const FAKE_DSN = 'postgresql://triage_ro:not-a-real-password@db.invalid:5432/triage';

let home: string;
let db: typeof import('./db.ts');
const savedHome = process.env.TRIAGE_HOME;

function writeEnv(dir: string, values: Record<string, string>): void {
  const lines = Object.entries({ ...EXAMPLE, ...values }).map(([k, v]) => `${k}=${v}`);
  writeFileSync(join(dir, '.env'), `${lines.join('\n')}\n`);
}

function isAdapter(x: unknown): x is PersistenceAdapter {
  return typeof x === 'object' && x !== null && typeof (x as PersistenceAdapter).connect === 'function';
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'triage-db-'));
  writeEnv(home, { TRIAGE_DB_PROVIDER: 'sqlite', TRIAGE_DB_URL: './.data/default.sqlite' });
  // The default export calls loadConfig() at import, so the import needs a home.
  process.env.TRIAGE_HOME = home;
  try {
    db = await import('./db.ts');
  } finally {
    if (savedHome === undefined) delete process.env.TRIAGE_HOME;
    else process.env.TRIAGE_HOME = savedHome;
  }
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('createPersistence', () => {
  test('sqlite with a temp path returns a Flue adapter that opens the file', async () => {
    const config = configFromRecord({ ...EXAMPLE, TRIAGE_DB_PROVIDER: 'sqlite', TRIAGE_DB_URL: './.data/flue.sqlite' }, home);
    expect(config.db.url).toBe(join(home, '.data/flue.sqlite'));
    const adapter = db.createPersistence(config);
    expect(isAdapter(adapter)).toBe(true);
    await adapter.migrate?.();
    const stores = await adapter.connect();
    expect(stores.submissionStore).toBeDefined();
    expect(stores.conversationStreamStore).toBeDefined();
    expect(stores.attachmentStore).toBeDefined();
    expect(existsSync(config.db.url)).toBe(true);
    await adapter.close?.();
  });

  test('sqlite relative path resolves under TRIAGE_HOME when cwd differs', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'triage-db-cwd-'));
    const savedCwd = process.cwd();
    const rel = './.data/relative.sqlite';
    try {
      process.chdir(elsewhere);
      const adapter = db.createPersistence({ home, db: { provider: 'sqlite', url: rel, retry: NO_RETRY } });
      await adapter.migrate?.();
      await adapter.connect();
      await adapter.close?.();
      expect(existsSync(join(home, rel))).toBe(true);
      expect(existsSync(join(elsewhere, rel))).toBe(false);
    } finally {
      process.chdir(savedCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("sqlite(':memory:') is accepted and writes no file", async () => {
    const adapter = db.createPersistence({ home, db: { provider: 'sqlite', url: ':memory:', retry: NO_RETRY } });
    await adapter.migrate?.();
    const stores = await adapter.connect();
    expect(stores.submissionStore).toBeDefined();
    await adapter.close?.();
    expect(existsSync(join(home, ':memory:'))).toBe(false);
    expect(existsSync(join(process.cwd(), ':memory:'))).toBe(false);
  });

  test('sqlite with a DSN-shaped url fails naming TRIAGE_DB_URL only', () => {
    const err = catchError(() => db.createPersistence({ home, db: { provider: 'sqlite', url: FAKE_DSN, retry: NO_RETRY } }));
    expectKeyOnly(err, 'TRIAGE_DB_URL', [FAKE_DSN, 'not-a-real-password', 'db.invalid', 'triage_ro']);
  });

  test('unknown provider fails naming TRIAGE_DB_PROVIDER only', () => {
    const secretish = 'postgresql://admin:hunter2-SECRET@prod.invalid:5432/core';
    const config = { home, db: { provider: secretish as 'sqlite', url: FAKE_DSN, retry: NO_RETRY } };
    const err = catchError(() => db.createPersistence(config));
    expectKeyOnly(err, 'TRIAGE_DB_PROVIDER', [secretish, 'hunter2-SECRET', 'prod.invalid', FAKE_DSN, 'not-a-real-password']);
  });

  test('postgres without a postgresql:// DSN fails naming TRIAGE_DB_URL only', () => {
    const bad = 'mysql://root:hunter2-SECRET@db.invalid:3306/core';
    const factory = recordingFactory();
    for (const url of [bad, './.data/triage.sqlite', '']) {
      const err = catchError(() =>
        db.createPersistence({ home, db: { provider: 'postgres', url, retry: NO_RETRY } }, { poolFactory: factory.fn }),
      );
      expectKeyOnly(err, 'TRIAGE_DB_URL', url === '' ? [] : [url, 'hunter2-SECRET', 'db.invalid']);
      expect(err.message).not.toContain('TRIAGE_DB_PROVIDER');
    }
    expect(factory.options).toHaveLength(0);
  });

  test('postgres returns an @flue/postgres adapter on the injected pool, with no connection opened', async () => {
    const factory = recordingFactory();
    const config = configFromRecord({ ...EXAMPLE, TRIAGE_DB_PROVIDER: 'postgres', TRIAGE_DB_URL: FAKE_DSN }, home);
    const adapter = db.createPersistence(config, { poolFactory: factory.fn });
    expect(isAdapter(adapter)).toBe(true);
    expect(typeof adapter.migrate).toBe('function');
    expect(factory.options).toHaveLength(1);
    expect(factory.options[0]?.connectionString).toBe(FAKE_DSN);
    const stores = await adapter.connect();
    expect(stores.submissionStore).toBeDefined();
    expect(stores.conversationStreamStore).toBeDefined();
    expect(stores.attachmentStore).toBeDefined();
    expect(factory.connects()).toBe(0);
    expect(factory.queries()).toBe(0);
    await adapter.close?.();
    expect(factory.ended()).toBe(1);
  });

  test('postgres adapter and the shared runner use one pool', async () => {
    const { getSharedPgRunner } = await import('./db/pg.ts');
    const factory = recordingFactory();
    const config = { home, db: { provider: 'postgres' as const, url: FAKE_DSN, retry: NO_RETRY } };
    const adapter = db.createPersistence(config, { poolFactory: factory.fn });
    const runner = getSharedPgRunner(config, { poolFactory: factory.fn });
    expect(factory.options).toHaveLength(1);
    await runner.close();
    await adapter.close?.();
    expect(factory.ended()).toBe(1);
  });
});

describe('submission leases (D71)', () => {
  test('the adapter hands its submission store over on connect and takes it back on close', async () => {
    const { submissionStoreConnected } = await import('./db/submission-lease.ts');
    const adapter = db.createPersistence({ home, db: { provider: 'sqlite', url: ':memory:', retry: NO_RETRY } });
    expect(await db.submissionLease('sub_unknown')).toBeNull();
    await adapter.migrate?.();
    await adapter.connect();
    expect(submissionStoreConnected()).toBe(true);
    expect(await db.submissionLease('sub_unknown')).toBeNull();
    await adapter.close?.();
    expect(submissionStoreConnected()).toBe(false);
  });

  test('openSubmissionLeases on a sqlite file that does not exist creates nothing and reads null', async () => {
    const url = './.data/never-created.sqlite';
    const leases = await db.openSubmissionLeases({ home, db: { provider: 'sqlite', url, retry: NO_RETRY } });
    expect(await leases.lease('sub_unknown')).toBeNull();
    await leases.close();
    expect(existsSync(join(home, url))).toBe(false);
  });

  test('openSubmissionLeases reads an existing sqlite file that was never migrated as null', async () => {
    const url = './.data/empty.sqlite';
    mkdirSync(join(home, '.data'), { recursive: true });
    writeFileSync(join(home, url), '');
    const leases = await db.openSubmissionLeases({ home, db: { provider: 'sqlite', url, retry: NO_RETRY } });
    expect(await leases.lease('sub_unknown')).toBeNull();
    await leases.close();
  });

  test('openSubmissionLeases on postgres runs on the shared pool and leaves it open', async () => {
    const factory = recordingFactory();
    const config = { home, db: { provider: 'postgres' as const, url: FAKE_DSN, retry: NO_RETRY } };
    const leases = await db.openSubmissionLeases(config, { poolFactory: factory.fn });
    await leases.close();
    expect(factory.ended()).toBe(0);
    const { getSharedPgRunner } = await import('./db/pg.ts');
    await getSharedPgRunner(config, { poolFactory: factory.fn }).close();
  });
});

describe('default export', () => {
  test('is the sqlite adapter for TRIAGE_HOME and writes under the home', async () => {
    expect(isAdapter(db.default)).toBe(true);
    await db.default.connect();
    expect(existsSync(join(home, '.data/default.sqlite'))).toBe(true);
    await db.default.close?.();
  });

  test('without TRIAGE_HOME the import fails with a ConfigError naming the key only', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TRIAGE_HOME;
    const r = spawnSync('node', ['--input-type=module', '-e', "await import('./src/db.ts')"], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('ConfigError');
    expect(r.stderr).toContain('TRIAGE_HOME');
  });
});

describe('source rules', () => {
  const sources = ['src/db.ts', 'src/db/pg.ts'].map((path) => ({ path, text: readFileSync(join(REPO, path), 'utf8') }));

  test('db.ts and db/pg.ts never log, so TRIAGE_DB_URL cannot reach output', () => {
    for (const { text } of sources) {
      expect(text).not.toMatch(/console\.|process\.(stdout|stderr)|\bdebug\(/);
    }
  });

  test("db.ts and db/pg.ts contain no 'flue_' table names", () => {
    for (const { text } of sources) expect(text).not.toContain('flue_');
  });

  test('db.ts has a default export and does not branch on deploy mode or env label', () => {
    const text = sources[0]?.text ?? '';
    expect(text).toMatch(/^export default /m);
    for (const { text: src } of sources) {
      expect(src).not.toMatch(/TRIAGE_DEPLOY_MODE|TRIAGE_ENV_LABEL|deployModeForPreflight|envLabel|process\.env/);
    }
  });
});

function catchError(fn: () => unknown): ConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

function expectKeyOnly(err: ConfigError, key: string, absent: readonly string[]): void {
  expect(err.keys).toEqual([key]);
  expect(err.message).toContain(key);
  for (const part of absent) {
    expect(err.message).not.toContain(part);
    expect(String(err.stack)).not.toContain(part);
  }
}

// A pool factory whose pool never connects: every call is counted.
function recordingFactory() {
  const options: PgPoolOptions[] = [];
  let connects = 0;
  let queries = 0;
  let ended = 0;
  const fn: PoolFactory = (o) => {
    options.push(o);
    return {
      async query() {
        queries += 1;
        return { rows: [] };
      },
      async connect() {
        connects += 1;
        throw new Error('fake pool: connect not expected');
      },
      async end() {
        ended += 1;
      },
    };
  };
  return { fn, options, connects: () => connects, queries: () => queries, ended: () => ended };
}
