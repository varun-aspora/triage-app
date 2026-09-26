// The run store migrator against a fake pg pool, plus static checks on the
// .sql files. No database is opened: the real runner from src/db/pg.ts is
// built over a fake pool, so BEGIN, COMMIT and ROLLBACK come from the same
// code production uses.

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, parseSync } from 'libpg-query';
import { createPgRunner, type PgClientLike, type PgPoolLike, type PoolFactory } from '../db/pg.ts';
import { createFakePg } from './fake-pg.ts';
import { DEFAULT_MIGRATIONS_DIR, listMigrations, migrateRunStore, RunStoreMigrationError } from './migrate.ts';
import { RunStoreError } from './types.ts';

const DSN = 'postgresql://triage_rw:not-a-real-password@db.invalid:5432/triage';
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const INIT_SQL = readFileSync(join(MIGRATIONS_DIR, '0001_init.sql'), 'utf8');
/** Every shipped migration, in order. */
const ALL_VERSIONS = ['0001_init'];

// ------------------------------------------------------------------ fake database

type Call = { on: string; text: string; params?: unknown[] };

type FakeDbOptions = {
  /** Throw a syntax error for any statement containing this text. */
  readonly failOn?: string;
  /** Versions that another process recorded after the up-front read. */
  readonly recordedLater?: readonly string[];
};

type FakeDb = {
  readonly calls: Call[];
  readonly committed: Set<string>;
  readonly factory: PoolFactory;
  /** Calls made on one checked-out client, in order. */
  clientCalls(n: number): string[];
  /** Every statement text that is not migrator bookkeeping. */
  migrationSql(): string[];
};

function fakeDb(options: FakeDbOptions = {}): FakeDb {
  const calls: Call[] = [];
  const committed = new Set<string>();
  let clients = 0;

  const fail = (text: string): void => {
    if (options.failOn !== undefined && text.includes(options.failOn)) {
      throw new Error(`syntax error at or near "${options.failOn}"`);
    }
  };

  const pool: PgPoolLike = {
    async query(text, params) {
      calls.push({ on: 'pool', text, params });
      fail(text);
      if (text.startsWith('SELECT version FROM triage.schema_migrations') && params === undefined) {
        return { rows: [...committed].map((version) => ({ version })) };
      }
      return { rows: [] };
    },
    async connect(): Promise<PgClientLike> {
      const on = `client${++clients}`;
      let staged: string[] = [];
      return {
        async query(text, params) {
          calls.push({ on, text, params });
          if (text === 'COMMIT') {
            for (const version of staged) committed.add(version);
            staged = [];
            return { rows: [] };
          }
          if (text === 'ROLLBACK') {
            staged = [];
            return { rows: [] };
          }
          fail(text);
          // The runner runs single statements on a checked-out client too (D57), so the version read lands here.
          if (text.startsWith('SELECT version FROM triage.schema_migrations') && params === undefined) {
            return { rows: [...committed].map((version) => ({ version })) };
          }
          if (text.startsWith('SELECT version FROM triage.schema_migrations WHERE version = $1')) {
            const version = String(params?.[0]);
            const seen = committed.has(version) || staged.includes(version) || options.recordedLater?.includes(version);
            return { rows: seen ? [{ version }] : [] };
          }
          if (text.startsWith('INSERT INTO triage.schema_migrations')) staged.push(String(params?.[0]));
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };

  const bookkeeping = /^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock|SELECT version FROM|INSERT INTO triage\.schema_migrations|CREATE SCHEMA IF NOT EXISTS triage$|CREATE TABLE IF NOT EXISTS triage\.schema_migrations \()/;

  return {
    calls,
    committed,
    factory: () => pool,
    clientCalls: (n) => calls.filter((c) => c.on === `client${n}`).map((c) => c.text),
    migrationSql: () => calls.map((c) => c.text).filter((text) => !bookkeeping.test(text)),
  };
}

function runnerFor(db: FakeDb) {
  return createPgRunner(DSN, { poolFactory: db.factory });
}

// ------------------------------------------------------------------ temp migration dirs

const temps: string[] = [];

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-migrate-'));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function caught(promise: Promise<unknown>): Promise<RunStoreMigrationError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RunStoreMigrationError);
    expect(err).toBeInstanceOf(RunStoreError);
    return err as RunStoreMigrationError;
  }
  throw new Error('expected the migrator to throw');
}

// ------------------------------------------------------------------ migrator

describe('migrateRunStore', () => {
  test('first run applies every file inside its own BEGIN/COMMIT and inserts each version', async () => {
    const db = fakeDb();
    const result = await migrateRunStore(runnerFor(db));

    expect(result).toEqual({ applied: ALL_VERSIONS, skipped: [] });
    expect(db.committed).toEqual(new Set(ALL_VERSIONS));

    // client1 is the bootstrap, client2 reads the recorded versions, client3 on apply the files.
    expect(db.clientCalls(1)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(7426150093)',
      'CREATE SCHEMA IF NOT EXISTS triage',
      expect.stringContaining('CREATE TABLE IF NOT EXISTS triage.schema_migrations'),
      'COMMIT',
    ]);
    expect(db.clientCalls(2)).toEqual([expect.stringMatching(/^SELECT version FROM triage\.schema_migrations/)]);
    expect(db.clientCalls(3)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(7426150093)',
      'SELECT version FROM triage.schema_migrations WHERE version = $1',
      INIT_SQL,
      'INSERT INTO triage.schema_migrations (version) VALUES ($1)',
      'COMMIT',
    ]);
    const inserts = db.calls.filter((c) => c.text.startsWith('INSERT INTO triage.schema_migrations'));
    expect(inserts.map((c) => c.params)).toEqual(ALL_VERSIONS.map((v) => [v]));
  });

  test('second run with the version recorded applies nothing', async () => {
    const db = fakeDb();
    const runner = runnerFor(db);
    await migrateRunStore(runner);
    const before = db.calls.length;

    const result = await migrateRunStore(runner);

    expect(result).toEqual({ applied: [], skipped: ALL_VERSIONS });
    const second = db.calls.slice(before).map((c) => c.text);
    expect(second).not.toContain(INIT_SQL);
    expect(second.some((t) => t.startsWith('INSERT'))).toBe(false);
    // Only the bootstrap transaction opens; no transaction for a skipped file.
    expect(second.filter((t) => t === 'BEGIN')).toHaveLength(1);
    expect(db.committed).toEqual(new Set(ALL_VERSIONS));
  });

  test('a file recorded by another process while waiting on the lock is skipped', async () => {
    const db = fakeDb({ recordedLater: ALL_VERSIONS });
    const result = await migrateRunStore(runnerFor(db));

    expect(result).toEqual({ applied: [], skipped: ALL_VERSIONS });
    expect(db.migrationSql()).toEqual([]);
    expect(db.committed.size).toBe(0);
  });

  test('error in a file rolls back, names the file and records nothing', async () => {
    const db = fakeDb({ failOn: 'CREATE TABLE triage.runs' });
    const err = await caught(migrateRunStore(runnerFor(db)));

    expect(err.file).toBe('0001_init.sql');
    expect(err.message).toContain('0001_init.sql');
    expect(err.message).toContain('syntax error');
    expect(err.message).not.toContain('not-a-real-password');
    expect(db.committed.size).toBe(0);
    const tail = db.clientCalls(3).slice(-2);
    expect(tail).toEqual([INIT_SQL, 'ROLLBACK']);
    expect(db.clientCalls(3)).not.toContain('COMMIT');
  });

  test('a failing later file keeps earlier files and stops there', async () => {
    const dir = tempDir({
      '0001_ok.sql': 'CREATE TABLE triage.a (id int);\n',
      '0002_bad.sql': 'CREATE TABLE triage.b (BROKEN);\n',
      '0003_never.sql': 'CREATE TABLE triage.c (id int);\n',
    });
    const db = fakeDb({ failOn: 'BROKEN' });
    const err = await caught(migrateRunStore(runnerFor(db), { dir }));

    expect(err.file).toBe('0002_bad.sql');
    expect(err.message).toContain('0002_bad.sql');
    expect(db.committed).toEqual(new Set(['0001_ok']));
    expect(db.migrationSql().some((t) => t.includes('triage.c'))).toBe(false);
  });

  test('files are applied in lexical order', async () => {
    // Written out of order on purpose.
    const dir = tempDir({
      '0010_tenth.sql': 'SELECT 10;\n',
      '0002_second.sql': 'SELECT 2;\n',
      '0001_first.sql': 'SELECT 1;\n',
    });
    const db = fakeDb();
    const result = await migrateRunStore(runnerFor(db), { dir });

    expect(result.applied).toEqual(['0001_first', '0002_second', '0010_tenth']);
    expect(db.migrationSql()).toEqual(['SELECT 1;\n', 'SELECT 2;\n', 'SELECT 10;\n']);
  });

  test('a new file on an already migrated store applies only that file', async () => {
    const dir = tempDir({ '0001_first.sql': 'SELECT 1;\n' });
    const db = fakeDb();
    const runner = runnerFor(db);
    await migrateRunStore(runner, { dir });
    writeFileSync(join(dir, '0002_second.sql'), 'SELECT 2;\n');

    const result = await migrateRunStore(runner, { dir });

    expect(result).toEqual({ applied: ['0002_second'], skipped: ['0001_first'] });
    expect(db.migrationSql()).toEqual(['SELECT 1;\n', 'SELECT 2;\n']);
  });

  test('a failing bootstrap applies no file', async () => {
    const db = fakeDb({ failOn: 'CREATE SCHEMA' });
    const err = await caught(migrateRunStore(runnerFor(db)));

    expect(err.message).toContain('bootstrap');
    expect(err.file).toBeUndefined();
    expect(db.clientCalls(1).at(-1)).toBe('ROLLBACK');
    expect(db.calls.map((c) => c.text)).not.toContain(INIT_SQL);
  });

  test.each([
    ['a file name without a number', { 'init.sql': 'SELECT 1;' }, 'init.sql'],
    ['upper case in a file name', { '0001_Init.sql': 'SELECT 1;' }, '0001_Init.sql'],
    ['two files with one number', { '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' }, '0001_b.sql'],
    ['an empty file', { '0001_empty.sql': '  \n' }, '0001_empty.sql'],
  ])('refuses %s before any query', async (_label, files, file) => {
    const db = fakeDb();
    const err = await caught(migrateRunStore(runnerFor(db), { dir: tempDir(files) }));

    expect(err.file).toBe(file);
    expect(err.message).toContain(file);
    expect(db.calls).toEqual([]);
  });

  test('refuses a directory with no .sql files', async () => {
    const db = fakeDb();
    const err = await caught(migrateRunStore(runnerFor(db), { dir: tempDir({ 'README.txt': 'x' }) }));

    expect(err.message).toContain('no .sql migrations');
    expect(db.calls).toEqual([]);
  });

  test('over fake-pg, 0001 is applied once and a second start applies nothing', async () => {
    const fake = createFakePg({ migrated: false });
    const runner = fake.runner();
    expect(await migrateRunStore(runner)).toEqual({ applied: ALL_VERSIONS, skipped: [] });
    expect(fake.calls.filter((c) => c.text === INIT_SQL)).toHaveLength(1);
    expect(await migrateRunStore(runner)).toEqual({ applied: [], skipped: ALL_VERSIONS });
    expect(fake.calls.filter((c) => c.text === INIT_SQL)).toHaveLength(1);
    expect(fake.isMigrated()).toBe(true);
  });

  test('refuses a missing directory', async () => {
    const db = fakeDb();
    const err = await caught(migrateRunStore(runnerFor(db), { dir: join(tmpdir(), 'triage-migrate-missing-dir') }));

    expect(err.message).toContain('cannot read the migrations directory');
    expect(db.calls).toEqual([]);
  });
});

describe('listMigrations', () => {
  test('the default directory is ./migrations and holds 0001_init', async () => {
    expect(DEFAULT_MIGRATIONS_DIR).toBe(MIGRATIONS_DIR);
    const files = await listMigrations();
    expect(files[0]).toEqual({ version: '0001_init', file: '0001_init.sql', path: join(MIGRATIONS_DIR, '0001_init.sql') });
  });

  test('ignores files that are not .sql', async () => {
    const dir = tempDir({ '0001_a.sql': 'SELECT 1;', 'notes.md': 'x' });
    expect((await listMigrations(dir)).map((m) => m.file)).toEqual(['0001_a.sql']);
  });
});

// ------------------------------------------------------------------ static checks

type SqlFile = { name: string; text: string; code: string };

const sqlFiles: SqlFile[] = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => {
    const text = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    return { name, text, code: text.replace(/--[^\n]*/g, '') };
  });

describe('migration files', () => {
  test('there is at least 0001_init.sql', () => {
    expect(sqlFiles.map((f) => f.name)).toContain('0001_init.sql');
  });

  test.each(sqlFiles.map((f) => [f.name, f] as const))('%s mentions no flue_ table and no vector index', (_n, f) => {
    expect(f.text).not.toMatch(/flue_/i);
    expect(f.text).not.toMatch(/using\s+hnsw/i);
    expect(f.text).not.toMatch(/ivfflat/i);
  });

  test.each(sqlFiles.map((f) => [f.name, f] as const))('%s qualifies every CREATE TABLE and ALTER TABLE with triage.', (_n, f) => {
    const names = [
      ...[...f.code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)/gi)].map((m) => m[1]),
      ...[...f.code.matchAll(/alter\s+table\s+([^\s(]+)/gi)].map((m) => m[1]),
    ];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toStartWith('triage.');
    const refs = [...f.code.matchAll(/references\s+([^\s(]+)/gi)].map((m) => m[1]);
    for (const ref of refs) expect(ref).toStartWith('triage.');
  });

  test.each(sqlFiles.map((f) => [f.name, f] as const))('%s creates no vector(n) column and no audit table', (_n, f) => {
    expect(f.code).not.toMatch(/\bvector\s*\(/i);
    expect(f.code).not.toMatch(/audit/i);
  });

  test('0001_init.sql creates the schema, the extension and the run store tables', () => {
    expect(INIT_SQL).toContain('CREATE SCHEMA IF NOT EXISTS triage;');
    expect(INIT_SQL).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    // The migrator records the version; the file does not insert it itself.
    expect(INIT_SQL).not.toMatch(/insert\s+into/i);
  });
});

describe('migration files parsed with the Postgres grammar', () => {
  type Json = Record<string, any>;
  let statements: { file: string; kind: string; node: Json }[] = [];

  beforeAll(async () => {
    await loadModule();
    statements = sqlFiles.flatMap((f) =>
      ((parseSync(f.text).stmts ?? []) as Json[]).map((s) => {
        const kind = Object.keys(s.stmt)[0] as string;
        return { file: f.name, kind, node: s.stmt[kind] as Json };
      }),
    );
  });

  test('every file parses', () => {
    expect(statements.length).toBeGreaterThan(0);
  });

  test('every table, index and reference is in schema triage', () => {
    for (const s of statements) {
      if (s.kind === 'CreateStmt' || s.kind === 'IndexStmt' || s.kind === 'AlterTableStmt') {
        expect(`${s.file}: ${s.node.relation?.schemaname}.${s.node.relation?.relname}`).toMatch(/: triage\./);
      }
      for (const table of JSON.stringify(s.node).matchAll(/"pktable":\{"schemaname":"([^"]*)"/g)) {
        expect(table[1]).toBe('triage');
      }
    }
  });

  test('only the triage schema and the vector extension are created outside tables; later files add columns or tables', () => {
    const allowed = new Set(['CreateSchemaStmt', 'CreateExtensionStmt', 'CreateStmt', 'IndexStmt', 'AlterTableStmt']);
    for (const s of statements) expect([...allowed]).toContain(s.kind);
    for (const s of statements.filter((x) => x.kind === 'AlterTableStmt')) {
      expect(s.file).not.toBe('0001_init.sql');
      for (const cmd of (s.node.cmds ?? []) as Json[]) expect(cmd.AlterTableCmd?.subtype).toBe('AT_AddColumn');
    }
    for (const s of statements.filter((x) => x.kind === 'CreateSchemaStmt')) expect(s.node.schemaname).toBe('triage');
    for (const s of statements.filter((x) => x.kind === 'CreateExtensionStmt')) expect(s.node.extname).toBe('vector');
  });

  test('no index uses a vector access method and no column is a vector', () => {
    for (const s of statements.filter((x) => x.kind === 'IndexStmt')) expect(s.node.accessMethod).toBe('btree');
    for (const s of statements.filter((x) => x.kind === 'CreateStmt')) {
      for (const elt of (s.node.tableElts ?? []) as Json[]) {
        const names = ((elt.ColumnDef?.typeName?.names ?? []) as Json[]).map((n) => n.String?.sval);
        expect(`${s.node.relation.relname}.${elt.ColumnDef?.colname}: ${names.join('.')}`).not.toMatch(/vector/);
      }
    }
  });

  test('the tables from the ticket exist', () => {
    const tables = statements.filter((s) => s.kind === 'CreateStmt').map((s) => s.node.relation.relname as string);
    expect(tables.sort()).toEqual(
      ['embedding_models', 'evidence', 'feedback', 'idempotency', 'reports', 'run_usage', 'runs', 'schema_migrations', 'submissions'].sort(),
    );
  });

  test('no file has a foreign key (D60)', () => {
    const withFk = statements.filter((s) => JSON.stringify(s.node).includes('"contype":"CONSTR_FOREIGN"'));
    expect(withFk.map((s) => s.file)).toEqual([]);
    for (const f of sqlFiles) {
      expect(`${f.name}: ${f.code}`).not.toMatch(/\breferences\b|foreign\s+key|on\s+delete\s+cascade/i);
    }
  });
});

describe('migrate.ts source', () => {
  const source = readFileSync(fileURLToPath(new URL('./migrate.ts', import.meta.url)), 'utf8');

  test('holds no DDL beyond the schema_migrations bootstrap', () => {
    const ddl = [...source.matchAll(/\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\s+[A-Z]+(?:\s+IF\s+NOT\s+EXISTS)?\s+[\w.]+/g)].map(
      (m) => m[0],
    );
    expect([...new Set(ddl)].sort()).toEqual([
      'CREATE SCHEMA IF NOT EXISTS triage',
      'CREATE TABLE IF NOT EXISTS triage.schema_migrations',
    ]);
  });

  test('never mentions flue_ tables', () => {
    expect(source).not.toMatch(/flue_/i);
  });

  test('its bootstrap table matches the definition in 0001_init.sql', () => {
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    const bootstrap = /`(CREATE TABLE IF NOT EXISTS triage\.schema_migrations \([^`]+\))`/.exec(source)?.[1];
    expect(bootstrap).toBeDefined();
    expect(squash(INIT_SQL)).toContain(`${squash(bootstrap as string)};`);
  });
});
