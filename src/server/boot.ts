// HTTP server boot (HLD 02 §5.2 and §7, D25, D43). Node only.
//
// prepareServer runs before the Flue-built server is imported. It refuses to
// start without TRIAGE_HTTP_AUTH_TOKEN, takes the listen port from
// TRIAGE_HTTP_PORT, builds the run store and starts the retention timer and
// the repo sync timer (D47), so both run in the same process as the routes.
// bin/triage-server.mjs calls it, sets PORT and then imports dist/server.mjs.
//
// Nothing here reads or writes the process environment; the shim does
// the PORT write, outside src/.

import type { Config } from '../config/env.ts';
import { createExecRunner } from '../connectors/exec.ts';
import { assertHttpConfig } from '../ingress/http/auth.ts';
import { type RepoSyncTimer, type RepoSyncTimerOptions, startRepoSyncTimer } from '../ops/repos-autosync.ts';
import { createRunStore, type RunStoreConfig } from '../runstore/index.ts';
import { startRetentionTimer, type RetentionConfig, type RetentionTimer, type RetentionTimerOptions } from '../runstore/retention.ts';
import type { RunStore } from '../runstore/types.ts';

/** The whole config: the repo sync timer runs `triage repos sync` with it. */
export type ServerConfig = Config & RunStoreConfig & RetentionConfig;

export type ServerDeps = {
  /** Builds the run store. Defaults to createRunStore. */
  readonly createStore?: (config: ServerConfig) => Promise<RunStore>;
  /** Starts the retention timer. Defaults to startRetentionTimer. */
  readonly startTimer?: (store: RunStore, config: ServerConfig, options: RetentionTimerOptions) => RetentionTimer;
  /** Passed to the timer: fake timers, clock and log in tests. */
  readonly timer?: RetentionTimerOptions;
  /** Starts the repo sync timer. Defaults to startRepoSyncTimer with the real exec runner. */
  readonly startRepoSync?: (config: ServerConfig, options: RepoSyncTimerOptions) => RepoSyncTimer;
  /** Passed to the repo sync timer: fake timers and log in tests. */
  readonly repoSyncTimer?: RepoSyncTimerOptions;
};

export type PreparedServer = {
  /** The port Flue's server should listen on (TRIAGE_HTTP_PORT). */
  readonly port: number;
  /** Stops the retention and repo sync timers. Safe to call twice. */
  stop(): void;
};

/**
 * Checks the HTTP config, builds the run store and starts the retention
 * timer. A blank token throws a ConfigError naming TRIAGE_HTTP_AUTH_TOKEN
 * before the store is built or any timer starts. A store that fails to build
 * also stops the boot with no timer running.
 */
export async function prepareServer(config: ServerConfig, deps: ServerDeps = {}): Promise<PreparedServer> {
  assertHttpConfig(config);
  const port = config.http.port;

  const createStore = deps.createStore ?? createRunStore;
  const startTimer = deps.startTimer ?? startRetentionTimer;

  const store = await createStore(config);
  const timer = startTimer(store, config, deps.timer ?? {});
  const startRepoSync = deps.startRepoSync ?? ((c, o) => startRepoSyncTimer(c, () => ({ config: c, runner: createExecRunner() }), o));
  const repoSync = startRepoSync(config, deps.repoSyncTimer ?? {});

  return {
    port,
    stop() {
      timer.stop();
      repoSync.stop();
    },
  };
}
