// HTTP server boot (HLD 02 §5.2 and §7, D25, D43). Node only.
//
// prepareServer runs before the Flue-built server is imported. It refuses to
// start without TRIAGE_HTTP_AUTH_TOKEN, takes the listen port from
// TRIAGE_HTTP_PORT, builds the run store and starts the retention timer, so
// pruning runs in the same process as the routes. bin/triage-server.mjs calls
// it, sets PORT and then imports dist/server.mjs.
//
// Nothing here reads or writes the process environment; the shim does
// the PORT write, outside src/.

import type { Config } from '../config/env.ts';
import { assertHttpConfig } from '../ingress/http/auth.ts';
import { createRunStore, type RunStoreConfig } from '../runstore/index.ts';
import { startRetentionTimer, type RetentionConfig, type RetentionTimer, type RetentionTimerOptions } from '../runstore/retention.ts';
import type { RunStore } from '../runstore/types.ts';

export type ServerConfig = Pick<Config, 'http'> & RunStoreConfig & RetentionConfig;

export type ServerDeps = {
  /** Builds the run store. Defaults to createRunStore. */
  readonly createStore?: (config: ServerConfig) => Promise<RunStore>;
  /** Starts the retention timer. Defaults to startRetentionTimer. */
  readonly startTimer?: (store: RunStore, config: ServerConfig, options: RetentionTimerOptions) => RetentionTimer;
  /** Passed to the timer: fake timers, clock and log in tests. */
  readonly timer?: RetentionTimerOptions;
};

export type PreparedServer = {
  /** The port Flue's server should listen on (TRIAGE_HTTP_PORT). */
  readonly port: number;
  /** Stops the retention timer. Safe to call twice. */
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

  return {
    port,
    stop() {
      timer.stop();
    },
  };
}
