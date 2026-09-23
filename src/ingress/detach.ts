// Starts the CLI's hidden __worker command as a detached process so
// `triage start` and `triage ask` can return while the run goes on.
//
// The payload goes to the child's stdin and nowhere else: argv holds only the
// command name and the run id, and nothing is written to disk, so the raw
// thread is never stored (D43). The child's stdout and stderr are ignored,
// stdin is closed after the write, and the child is unref'd so the parent can
// exit. The child inherits the parent's environment, which carries
// TRIAGE_HOME, so it loads the same config.
//
// This is the one child_process import allowed outside src/connectors/exec.ts.
// The spawn function can be injected so tests never start a process.
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';
import { encodePayload, type WorkerPayload } from './worker-payload.ts';

/** The hidden CLI command the worker runs (T07.5). */
export const WORKER_COMMAND = '__worker';

/** bin/triage.mjs, resolved from this file so the cwd does not matter. */
export const WORKER_BIN: string = fileURLToPath(new URL('../../bin/triage.mjs', import.meta.url));

/** The options spawnWorker always passes. */
export type WorkerSpawnOptions = {
  readonly detached: true;
  readonly stdio: readonly ['pipe', 'ignore', 'ignore'];
  readonly windowsHide: true;
};

/** The parts of a ChildProcess spawnWorker uses. */
export type WorkerChild = {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  once(event: 'spawn', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref(): void;
};

export type SpawnFn = (command: string, args: readonly string[], options: WorkerSpawnOptions) => WorkerChild;

export type SpawnWorkerDeps = {
  /** Defaults to node:child_process spawn. */
  readonly spawn?: SpawnFn;
  /** The node binary. Defaults to process.execPath. */
  readonly nodePath?: string;
  /** Defaults to WORKER_BIN. */
  readonly binPath?: string;
};

/** The worker could not be started or did not take its payload. */
export class WorkerSpawnError extends Error {
  override readonly name = 'WorkerSpawnError';
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`could not start the worker: ${reason}`, options);
  }
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], { detached: options.detached, stdio: [...options.stdio], windowsHide: options.windowsHide });

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'unknown error';
}

/**
 * Starts `node bin/triage.mjs __worker <run_id>` detached and hands it the
 * payload on stdin. Resolves with the child's pid once the process has started
 * and the payload is fully written. The payload is validated first, so a bad
 * one never starts a process.
 */
export async function spawnWorker(payload: WorkerPayload, deps: SpawnWorkerDeps = {}): Promise<{ pid: number }> {
  const text = encodePayload(payload);
  const spawn = deps.spawn ?? defaultSpawn;
  const args = [deps.binPath ?? WORKER_BIN, WORKER_COMMAND, payload.run_id] as const;
  const options: WorkerSpawnOptions = { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true };

  const child = spawn(deps.nodePath ?? process.execPath, args, options);
  try {
    const stdin = child.stdin;
    if (!stdin) throw new WorkerSpawnError('the child has no stdin pipe');

    const started = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      // on, not once: a late error after the start must not go unhandled.
      child.on('error', (err) => reject(new WorkerSpawnError(errorCode(err), { cause: err })));
    });
    const written = new Promise<void>((resolve, reject) => {
      stdin.on('error', (err) => reject(new WorkerSpawnError(`stdin ${errorCode(err)}`, { cause: err })));
      stdin.once('finish', () => resolve());
      stdin.end(text, 'utf8');
    });
    // Attach both handlers before awaiting, so neither rejection goes unhandled.
    await Promise.all([started, written]);

    if (typeof child.pid !== 'number') throw new WorkerSpawnError('the child has no pid');
    return { pid: child.pid };
  } finally {
    child.unref();
  }
}
