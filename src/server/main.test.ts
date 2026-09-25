import { describe, expect, test } from 'bun:test';
import { ConfigError } from '../config/errors.ts';
import { RunStoreMigrationError } from '../runstore/migrate.ts';
import type { ServerConfig } from './boot.ts';
import { describeBootError, runServer, type RunServerDeps } from './main.ts';

const CONFIG = { marker: 'config' } as unknown as ServerConfig;

type Step = 'prepare' | 'runtime' | 'listen' | 'close' | 'runtimeStop';

/** Deps that record each step. Each step named in `fail` throws. */
function recording(...fail: Step[]) {
  const steps: string[] = [];
  const deps: RunServerDeps = {
    loadConfig: () => {
      steps.push('loadConfig');
      return CONFIG;
    },
    prepareServer: async (c) => {
      expect(c).toBe(CONFIG);
      steps.push('prepareServer');
      if (fail.includes('prepare')) throw ConfigError.of('TRIAGE_HTTP_AUTH_TOKEN', 'is blank; the HTTP API needs a bearer token');
      return { port: 4321, stop: () => void steps.push('timers.stop') };
    },
    startRuntime: async () => {
      steps.push('startRuntime');
      if (fail.includes('runtime')) throw new Error('runtime failed');
      return {
        stop: async () => {
          steps.push('runtime.stop');
          if (fail.includes('runtimeStop')) throw new Error('runtime stop failed');
        },
      };
    },
    listen: async (port) => {
      steps.push(`listen:${port}`);
      if (fail.includes('listen')) throw new Error('listen failed');
      return {
        port,
        close: async () => {
          steps.push('listener.close');
          if (fail.includes('close')) throw new Error('close failed');
        },
      };
    },
  };
  return { steps, deps };
}

describe('runServer', () => {
  test('loads config, prepares, starts the runtime, then listens on TRIAGE_HTTP_PORT', async () => {
    const { steps, deps } = recording();
    const server = await runServer(deps);
    expect(steps).toEqual(['loadConfig', 'prepareServer', 'startRuntime', 'listen:4321']);
    expect(server.port).toBe(4321);
  });

  test('a refused boot starts no runtime and never listens', async () => {
    const { steps, deps } = recording('prepare');
    const err = await runServer(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(steps).toEqual(['loadConfig', 'prepareServer']);
  });

  test('a runtime that fails to start stops the timers and never listens', async () => {
    const { steps, deps } = recording('runtime');
    const err = await runServer(deps).catch((e: unknown) => e);
    expect((err as Error).message).toBe('runtime failed');
    expect(steps).toEqual(['loadConfig', 'prepareServer', 'startRuntime', 'timers.stop']);
  });

  test('a listener that fails to start stops the runtime and the timers', async () => {
    const { steps, deps } = recording('listen');
    const err = await runServer(deps).catch((e: unknown) => e);
    expect((err as Error).message).toBe('listen failed');
    expect(steps.slice(3)).toEqual(['listen:4321', 'runtime.stop', 'timers.stop']);
  });

  test('stop() closes the listener, stops the runtime, then the timers, once', async () => {
    const { steps, deps } = recording();
    const server = await runServer(deps);
    steps.length = 0;
    await Promise.all([server.stop(), server.stop()]);
    await server.stop();
    expect(steps).toEqual(['listener.close', 'runtime.stop', 'timers.stop']);
  });

  test('stop() still stops everything when one step fails, and rethrows', async () => {
    const { steps, deps } = recording('close');
    const server = await runServer(deps);
    steps.length = 0;
    const err = await server.stop().catch((e: unknown) => e);
    expect((err as Error).message).toBe('close failed');
    expect(steps).toEqual(['listener.close', 'runtime.stop', 'timers.stop']);
  });

  test('stop() reports both errors when the listener and the runtime fail', async () => {
    const { deps } = recording('close', 'runtimeStop');
    const server = await runServer(deps);
    const err = await server.stop().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(['close failed', 'runtime stop failed']);
  });
});

describe('describeBootError', () => {
  test('prints ConfigError keys and only the name of other errors', () => {
    const cfg = describeBootError(ConfigError.of('TRIAGE_HTTP_AUTH_TOKEN', 'is blank; the HTTP API needs a bearer token'));
    expect(cfg.exitCode).toBe(3);
    expect(cfg.line).toContain('TRIAGE_HTTP_AUTH_TOKEN');

    class PgError extends Error {
      override name = 'PgError';
    }
    const other = describeBootError(new PgError('connect failed for postgresql://user:secret@db.internal/x'));
    expect(other.exitCode).toBe(1);
    expect(other.line).toBe('triage-server: boot failed (PgError)');
    expect(describeBootError(undefined).line).toBe('triage-server: boot failed (unknown error)');
  });

  test('a run store migration failure shows the file and code, never the message', () => {
    const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

    const noVector = new RunStoreMigrationError('migration 0001_init.sql failed: extension "vector" is not available', '0001_init.sql', {
      cause: pgError('0A000', 'extension "vector" is not available'),
    });
    expect(describeBootError(noVector)).toEqual({
      line: 'triage-server: run store migration failed (0001_init.sql, 0A000): pgvector is not installed on this Postgres; the run store needs it (D43)',
      exitCode: 1,
    });

    const refused = new RunStoreMigrationError('run store bootstrap failed: connect ECONNREFUSED 10.1.2.3:5432', undefined, {
      cause: pgError('ECONNREFUSED', 'connect ECONNREFUSED 10.1.2.3:5432'),
    });
    expect(describeBootError(refused).line).toBe('triage-server: run store migration failed (ECONNREFUSED)');

    const noCause = new RunStoreMigrationError('no .sql migrations found in /somewhere');
    expect(describeBootError(noCause).line).toBe('triage-server: run store migration failed');
  });
});
