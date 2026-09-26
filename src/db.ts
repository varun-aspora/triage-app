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
//
// Stalled detection (D71) reads Flue submission leases. createPersistence
// wraps the adapter so its connect() hands the submission store to
// src/db/submission-lease.ts, which answers submissionLease() in the process
// that runs the runtime. A process without a runtime (`triage status`) opens
// a reader with openSubmissionLeases().

import { postgres } from '@flue/postgres';
import type { PersistenceAdapter, PersistenceStores } from '@flue/runtime/adapter';
import { sqlite } from '@flue/runtime/node';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig, type Config } from './config/env.ts';
import { ConfigError } from './config/errors.ts';
import { assertPostgresDsn, getSharedPgRunner, type PoolFactory } from './db/pg.ts';
import {
  captureSubmissionStore,
  readSubmissionLease,
  releaseSubmissionStore,
  submissionLease,
  submissionStoreConnected,
  type SubmissionLeaseReader,
} from './db/submission-lease.ts';

export { submissionLease, type SubmissionLease, type SubmissionLeaseReader } from './db/submission-lease.ts';

export type PersistenceDeps = { readonly poolFactory?: PoolFactory };

export type PersistenceConfig = Pick<Config, 'db' | 'home'>;

export function createPersistence(config: PersistenceConfig, deps: PersistenceDeps = {}): PersistenceAdapter {
  return capturingStores(adapterFor(config, deps));
}

function adapterFor(config: PersistenceConfig, deps: PersistenceDeps): PersistenceAdapter {
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

/** The same adapter, with connect() handing its submission store to submission-lease.ts. */
function capturingStores(inner: PersistenceAdapter): PersistenceAdapter {
  let stores: PersistenceStores | undefined;
  return {
    ...(inner.migrate !== undefined ? { migrate: () => inner.migrate?.() } : {}),
    async connect() {
      stores = await inner.connect();
      captureSubmissionStore(stores.submissionStore);
      return stores;
    },
    async close() {
      if (stores !== undefined) releaseSubmissionStore(stores.submissionStore);
      stores = undefined;
      await inner.close?.();
    },
  };
}

/** A lease reader and its cleanup, from openSubmissionLeases. */
export type SubmissionLeases = { readonly lease: SubmissionLeaseReader; close(): Promise<void> };

/**
 * Lease reads for a process that may not run a Flue runtime, such as `triage
 * status`. It reuses the stores of a runtime this process connected;
 * otherwise it connects an adapter of its own and never migrates it. A
 * sqlite file that does not exist yet is not created: every lease is null.
 * The postgres adapter runs on the shared pool, so close() leaves the pool
 * for the CLI to end (D68); the sqlite handle is closed.
 */
export async function openSubmissionLeases(config: PersistenceConfig, deps: PersistenceDeps = {}): Promise<SubmissionLeases> {
  const none: SubmissionLeases = { lease: async () => null, close: async () => {} };
  if (submissionStoreConnected()) return { lease: submissionLease, close: async () => {} };
  if (config.db.provider === 'sqlite') {
    const path = sqlitePath(config);
    if (path !== ':memory:' && !existsSync(path)) return none;
  }
  const adapter = adapterFor(config, deps);
  let stores: PersistenceStores;
  try {
    stores = await adapter.connect();
  } catch {
    if (config.db.provider === 'sqlite') await closeQuietly(adapter);
    return none;
  }
  return {
    lease: (id) => readSubmissionLease(stores.submissionStore, id),
    close: async () => {
      if (config.db.provider === 'sqlite') await closeQuietly(adapter);
    },
  };
}

async function closeQuietly(adapter: PersistenceAdapter): Promise<void> {
  try {
    await adapter.close?.();
  } catch {
    // A handle that will not close is left to the process exit.
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
