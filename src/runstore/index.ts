// Builds the run store for this deployment (D38, D43). Node only.
//
// The provider follows TRIAGE_DB_PROVIDER: sqlite uses the folder provider
// under TRIAGE_RUNS_DIR, postgres uses schema triage on TRIAGE_DB_URL over the
// shared pg runner, after its migrations have run. Nothing here reads env
// keys directly or puts TRIAGE_DB_URL in an error.
//
// Tools and ingress get the store by closure from whoever built it; the model
// never sees it.

import { loadConfig, type Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import { getSharedPgRunner, type PoolFactory } from '../db/pg.ts';
import { createFolderRunStore } from './folder.ts';
import { migrateRunStore } from './migrate.ts';
import { createPostgresRunStore, type PgStoreRunner } from './postgres.ts';
import type { RunStore } from './types.ts';

export type RunStoreConfig = Pick<Config, 'db' | 'paths'>;

export type RunStoreDeps = {
  /** Epoch milliseconds. Tests pass a fake clock. */
  readonly now?: () => number;
  /** Passed to the shared pg runner. Tests pass the fake pool from fake-pg.ts. */
  readonly poolFactory?: PoolFactory;
  /** Builds the pg runner. Defaults to getSharedPgRunner, so Flue and the store share a pool. */
  readonly pgRunner?: (config: RunStoreConfig) => PgStoreRunner;
  /** Applies the run store migrations. Defaults to migrateRunStore. */
  readonly migrate?: (runner: PgStoreRunner, options: { dir?: string }) => Promise<unknown>;
  /** The .sql directory, for a bundled build where the default path does not exist. */
  readonly migrationsDir?: string;
};

/**
 * Returns the store for config.db.provider. For postgres the migrations have
 * finished before the promise resolves, so the first store call finds its
 * tables. For sqlite no pg runner is built.
 */
export async function createRunStore(config: RunStoreConfig, deps: RunStoreDeps = {}): Promise<RunStore> {
  // Widened so a hand-built config with a bad provider fails with a key-only error.
  const provider: string = config.db.provider;
  const clock = deps.now !== undefined ? { now: deps.now } : {};
  switch (provider) {
    case 'sqlite':
      return createFolderRunStore({ runsDir: config.paths.runsDir, dataDir: config.paths.dataDir, ...clock });
    case 'postgres': {
      const runner =
        deps.pgRunner?.(config) ??
        getSharedPgRunner(config, deps.poolFactory !== undefined ? { poolFactory: deps.poolFactory } : {});
      const migrate = deps.migrate ?? migrateRunStore;
      await migrate(runner, deps.migrationsDir !== undefined ? { dir: deps.migrationsDir } : {});
      return createPostgresRunStore({ runner, ...clock });
    }
    default:
      throw ConfigError.of('TRIAGE_DB_PROVIDER', 'names no run store provider; use sqlite or postgres');
  }
}

let shared: Promise<RunStore> | undefined;

/**
 * The process-wide store, built once from loadConfig(). A failed build is
 * not kept, so the next call tries again.
 */
export function getRunStore(): Promise<RunStore> {
  if (shared === undefined) {
    const pending = Promise.resolve().then(() => createRunStore(loadConfig()));
    shared = pending;
    pending.catch(() => {
      if (shared === pending) shared = undefined;
    });
  }
  return shared;
}

/**
 * Drops the cached process-wide store. Tests only: bun runs every test file
 * in one process, so a store built against a temp home must not outlive it.
 */
export function resetRunStoreForTests(): void {
  shared = undefined;
}
