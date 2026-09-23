// Applies the run store's SQL migrations (D43, P2 §3.3). Node only.
//
// The migrations are the plain .sql files in ./migrations, named
// NNNN_<name>.sql and applied in lexical order. Each file not yet recorded in
// triage.schema_migrations runs in its own transaction together with the
// insert of its version, so a failing file rolls back and leaves no record.
// Re-running applies nothing new.
//
// The only DDL here is the bootstrap of schema triage and the
// schema_migrations table, which the migrator needs before any file runs.
// Every other object is defined in the .sql files. Flue's own tables are
// never touched; Flue migrates those itself.
//
// Two processes starting at once (the server and a CLI worker) serialise on a
// transaction-scoped advisory lock, and each re-checks the version under the
// lock before applying a file.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgRunner } from '../db/pg.ts';
import { RunStoreError } from './types.ts';

/** The parts of the shared pg runner the migrator uses. */
export type MigrationRunner = Pick<PgRunner, 'query' | 'transaction'>;

export type MigrateOptions = {
  /**
   * Directory that holds the .sql files. Defaults to ./migrations next to
   * this module. A bundled build, where that path does not exist, passes it.
   */
  readonly dir?: string;
};

export type MigrateResult = {
  /** Versions applied by this call, in order. */
  readonly applied: readonly string[];
  /** Versions that were already recorded. */
  readonly skipped: readonly string[];
};

export type MigrationFile = {
  /** The file name without .sql, as recorded in schema_migrations. */
  readonly version: string;
  readonly file: string;
  readonly path: string;
};

export class RunStoreMigrationError extends RunStoreError {
  override name = 'RunStoreMigrationError';
  /** The migration file that failed, when one did. */
  readonly file?: string;
  constructor(message: string, file?: string, options?: { cause?: unknown }) {
    super(message, options);
    if (file !== undefined) this.file = file;
  }
}

export const DEFAULT_MIGRATIONS_DIR: string = fileURLToPath(new URL('./migrations/', import.meta.url));

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

// Any fixed number works; it only has to be the same in every process.
const LOCK = 'SELECT pg_advisory_xact_lock(7426150093)';

// Kept identical to the definition in 0001_init.sql.
const BOOTSTRAP = [
  'CREATE SCHEMA IF NOT EXISTS triage',
  `CREATE TABLE IF NOT EXISTS triage.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`,
] as const;

const SELECT_VERSIONS = 'SELECT version FROM triage.schema_migrations';
const SELECT_ONE = 'SELECT version FROM triage.schema_migrations WHERE version = $1';
const RECORD = 'INSERT INTO triage.schema_migrations (version) VALUES ($1)';

/** Lists the migration files in lexical order and checks their names. */
export async function listMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    throw new RunStoreMigrationError(`cannot read the migrations directory ${dir}`, undefined, { cause: err });
  }
  const files = names.filter((name) => name.endsWith('.sql')).sort(lexical);
  if (files.length === 0) throw new RunStoreMigrationError(`no .sql migrations found in ${dir}`);

  const prefixes = new Map<string, string>();
  return files.map((file) => {
    const match = FILE_NAME.exec(file);
    if (match === null) {
      throw new RunStoreMigrationError(`migration file name must look like 0001_name.sql: ${file}`, file);
    }
    const prefix = match[1] as string;
    const other = prefixes.get(prefix);
    if (other !== undefined) {
      throw new RunStoreMigrationError(`migrations ${other} and ${file} share the number ${prefix}`, file);
    }
    prefixes.set(prefix, file);
    return { version: file.slice(0, -'.sql'.length), file, path: join(dir, file) };
  });
}

/**
 * Brings schema triage up to date. Safe to call on every start: files already
 * recorded are skipped without opening a transaction.
 */
export async function migrateRunStore(runner: MigrationRunner, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = await listMigrations(options.dir);
  // Read every file first, so a missing or unreadable one fails before any
  // statement reaches the database.
  const sources = await Promise.all(migrations.map((m) => readSql(m)));

  try {
    await runner.transaction(async (tx) => {
      await tx.query(LOCK);
      for (const statement of BOOTSTRAP) await tx.query(statement);
    });
  } catch (err) {
    throw new RunStoreMigrationError(`run store bootstrap failed: ${messageOf(err)}`, undefined, { cause: err });
  }

  const recorded = new Set((await runner.query(SELECT_VERSIONS)).map((row) => String(row.version)));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [i, migration] of migrations.entries()) {
    if (recorded.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    const sql = sources[i] as string;
    let ran: boolean;
    try {
      ran = await runner.transaction(async (tx) => {
        await tx.query(LOCK);
        // Another process may have applied it while this one waited.
        if ((await tx.query(SELECT_ONE, [migration.version])).length > 0) return false;
        await tx.query(sql);
        await tx.query(RECORD, [migration.version]);
        return true;
      });
    } catch (err) {
      throw new RunStoreMigrationError(`migration ${migration.file} failed: ${messageOf(err)}`, migration.file, {
        cause: err,
      });
    }
    (ran ? applied : skipped).push(migration.version);
  }

  return { applied, skipped };
}

async function readSql(migration: MigrationFile): Promise<string> {
  let text: string;
  try {
    text = await readFile(migration.path, 'utf8');
  } catch (err) {
    throw new RunStoreMigrationError(`cannot read migration ${migration.file}`, migration.file, { cause: err });
  }
  if (text.trim() === '') throw new RunStoreMigrationError(`migration ${migration.file} is empty`, migration.file);
  return text;
}

function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
