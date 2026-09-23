// src/db.ts picks the Flue adapter from config. Every home is a temp dir with
// a .env written from .env.example; no real .env is read and no database
// other than a temp sqlite file is opened.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { parse } from 'dotenv';
import { configFromRecord } from './config/env.ts';

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

  test('postgres throws the named not-built error with the key name and no DSN', () => {
    const config = configFromRecord({ ...EXAMPLE, TRIAGE_DB_PROVIDER: 'postgres', TRIAGE_DB_URL: FAKE_DSN }, home);
    let caught: unknown;
    try {
      db.createPersistence(config);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(db.PersistenceNotBuiltError);
    const err = caught as Error;
    expect(err.name).toBe('PersistenceNotBuiltError');
    expect(err.message).toContain('postgres adapter not built (T09)');
    expect(err.message).toContain('TRIAGE_DB_PROVIDER');
    for (const part of [FAKE_DSN, 'not-a-real-password', 'db.invalid', 'triage_ro']) {
      expect(err.message).not.toContain(part);
      expect(String(err.stack)).not.toContain(part);
    }
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
  test('db.ts never logs, so TRIAGE_DB_URL cannot reach output', () => {
    const source = readFileSync(join(REPO, 'src/db.ts'), 'utf8');
    expect(source).not.toMatch(/console\.|process\.(stdout|stderr)|\bdebug\(/);
  });
});
