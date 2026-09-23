// Flue persistence entry (D38). Flue discovers the default export on the Node
// target; vite build bundles it and flue run loads it. Node only. start()
// does not discover this file, so the CLI and tests call createPersistence
// and pass the adapter as start({ agents, db }).
//
// TRIAGE_DB_PROVIDER picks the adapter and TRIAGE_DB_URL is its target: a file
// path for sqlite (relative paths resolve under TRIAGE_HOME), a postgresql://
// DSN for postgres. The postgres runner is the shared one from src/db/pg.ts,
// so the run store uses the same pool (D43). Flue runs its own migrations
// through the adapter; this module creates no tables. Nothing here logs or
// puts TRIAGE_DB_URL in an error.

import { postgres } from '@flue/postgres';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { sqlite } from '@flue/runtime/node';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig, type Config } from './config/env.ts';
import { ConfigError } from './config/errors.ts';
import { assertPostgresDsn, getSharedPgRunner, type PoolFactory } from './db/pg.ts';

export type PersistenceDeps = { readonly poolFactory?: PoolFactory };

export type PersistenceConfig = Pick<Config, 'db' | 'home'>;

export function createPersistence(config: PersistenceConfig, deps: PersistenceDeps = {}): PersistenceAdapter {
  // Widened to string so a hand-built config with a bad provider still fails
  // with a key-only error instead of falling through.
  const provider: string = config.db.provider;
  switch (provider) {
    case 'sqlite':
      return sqlite(sqlitePath(config));
    case 'postgres':
      assertPostgresDsn(config.db.url);
      return postgres(getSharedPgRunner(config, deps));
    default:
      throw ConfigError.of('TRIAGE_DB_PROVIDER', 'names no persistence adapter; use sqlite or postgres');
  }
}

function sqlitePath(config: PersistenceConfig): string {
  const file = config.db.url.trim();
  if (file === ':memory:') return file;
  if (file === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    throw ConfigError.of('TRIAGE_DB_URL', 'must be a file path when TRIAGE_DB_PROVIDER=sqlite');
  }
  return isAbsolute(file) ? file : resolve(config.home, file);
}

export default createPersistence(loadConfig());
