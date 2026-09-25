// HTTP server entry (HLD 02 §5.2). bin/triage-server.mjs runs it from source
// through Node's type stripping, as bin/triage.mjs runs the CLI, so there is
// no build step.
//
// runServer loads the config, runs prepareServer (token check, run store,
// retention and repo sync timers), starts the Flue runtime with the src/db.ts
// adapter through bootRuntime, the same way the CLI does, and then serves the
// src/app.ts Hono app on TRIAGE_HTTP_PORT with @hono/node-server. That is
// what the entry built by vite build does, done with the public start().
//
// app.ts, the agent module and db.ts load only after prepareServer passes:
// db.ts builds its adapter on import, and a refused boot should open nothing.
//
// Nothing here reads or writes the process environment. Signals and exit
// codes are the shim's.

import { loadConfig } from '../config/env.ts';
import { prepareServer, type PreparedServer, type ServerConfig } from './boot.ts';

/** The Flue runtime as the server uses it. */
export type ServerRuntime = { stop(): Promise<void> };

/** An HTTP listener serving the app. */
export type Listener = {
  /** The port it is listening on. */
  readonly port: number;
  /** Stops accepting connections and resolves once open requests finish. */
  close(): Promise<void>;
};

export type RunServerDeps = {
  readonly loadConfig?: () => ServerConfig;
  readonly prepareServer?: (config: ServerConfig) => Promise<PreparedServer>;
  /** Starts the Flue runtime. Defaults to bootRuntime() from src/ingress/runtime.ts. */
  readonly startRuntime?: () => Promise<ServerRuntime>;
  /** Serves the app on the port. Defaults to the src/app.ts app on @hono/node-server. */
  readonly listen?: (port: number) => Promise<Listener>;
};

export type RunningServer = {
  readonly port: number;
  /** Closes the listener, stops the runtime, then the timers. Safe to call twice. */
  stop(): Promise<void>;
};

/**
 * Boots the server. A refused config or a failed prepareServer starts
 * nothing. A runtime or listener that fails to start stops whatever already
 * started before the error is rethrown.
 */
export async function runServer(deps: RunServerDeps = {}): Promise<RunningServer> {
  const config = (deps.loadConfig ?? loadConfig)();
  const prepared = await (deps.prepareServer ?? prepareServer)(config);

  let runtime: ServerRuntime | undefined;
  let listener: Listener;
  try {
    runtime = await (deps.startRuntime ?? startRuntime)();
    listener = await (deps.listen ?? listenApp)(prepared.port);
  } catch (err) {
    await runtime?.stop().catch(() => {});
    prepared.stop();
    throw err;
  }
  const started = runtime;

  let stopping: Promise<void> | undefined;
  return {
    port: listener.port,
    stop() {
      stopping ??= (async () => {
        const errors: unknown[] = [];
        const closed = listener.close().catch((e: unknown) => void errors.push(e));
        await started.stop().catch((e: unknown) => void errors.push(e));
        await closed;
        prepared.stop();
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'server shutdown failed');
      })();
      return stopping;
    },
  };
}

async function startRuntime(): Promise<ServerRuntime> {
  const { bootRuntime } = await import('../ingress/runtime.ts');
  return bootRuntime();
}

async function listenApp(port: number): Promise<Listener> {
  const [{ serve }, { default: app }] = await Promise.all([import('@hono/node-server'), import('../app.ts')]);
  return new Promise((resolve, reject) => {
    // requestTimeout 0, as in Flue's built server: Node's default would cut a
    // request off after five minutes.
    const server = serve({ fetch: app.fetch, port, serverOptions: { requestTimeout: 0 } }, (info) => {
      server.off('error', reject);
      resolve({
        port: info.port,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
    server.once('error', reject);
  });
}

/**
 * One stderr line for a boot failure. ConfigError messages carry key names
 * only. Other messages can carry connection details, so they are never
 * printed: a run store migration failure shows its file and the Postgres or
 * Node error code, and any other error only its name.
 */
export function describeBootError(err: unknown): { line: string; exitCode: number } {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; file?: unknown; cause?: unknown };
  if (e.name === 'ConfigError' && typeof e.message === 'string') {
    return { line: `triage-server: ${e.message}`, exitCode: 3 };
  }
  if (e.name === 'RunStoreMigrationError') {
    const cause = (e.cause ?? {}) as { code?: unknown; message?: unknown };
    const parts = [e.file, cause.code].filter((p): p is string => typeof p === 'string' && p !== '');
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    // Read to pick the hint, never printed.
    const hint = /extension "vector" is not available/.test(String(cause.message))
      ? ': pgvector is not installed on this Postgres; the run store needs it (D43)'
      : '';
    return { line: `triage-server: run store migration failed${detail}${hint}`, exitCode: 1 };
  }
  const name = typeof e.name === 'string' && e.name !== '' ? e.name : 'unknown error';
  return { line: `triage-server: boot failed (${name})`, exitCode: 1 };
}
