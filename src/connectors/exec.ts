// The one exec runner in the repo. Every connector, code tool and ops module
// that runs a host binary goes through ExecRunner, so tests can swap in the
// fake from exec-fake.ts and no code path ever builds a command string.
//
// Rules this file enforces:
// - execFile with an argv array and shell: false. Never a shell.
// - Every run has a timeout, an output cap and an optional abort signal.
//   The child is killed with SIGKILL when any of them trips.
// - A non-zero exit, a timeout, an abort, a truncated output or a binary
//   that cannot be spawned all come back as an ExecResult. Only a
//   programming error (bad argv type, bad options) rejects.
//
// Nothing here reads config. Values that come from config and end up in an
// argv go through assertSafeArg first (D30: remote hops take fixed argv and
// read data from stdin).

import childProcess from 'node:child_process';

export type ExecOptions = {
  /** Hard limit for the run. The child is killed when it passes. */
  readonly timeoutMs: number;
  /** Written to the child's stdin, which is then closed. Without it stdin is closed at once. */
  readonly stdin?: string | Uint8Array;
  /** Aborting kills the child. An already aborted signal means nothing is spawned. */
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  /** Cap per stream in bytes. Passing it kills the child and sets truncated. */
  readonly maxOutputBytes?: number;
};

export type ExecResult = {
  /** Null when the child was killed or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly aborted: boolean;
  /** Errno code such as ENOENT when the binary could not be spawned. */
  readonly spawnError?: string;
};

export interface ExecRunner {
  run(bin: string, argv: readonly string[], opts: ExecOptions): Promise<ExecResult>;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAXBUFFER_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Throws a TypeError unless bin is a non-empty string and argv is an array of
 * strings, none holding a NUL. Messages name the argv index, never the value.
 */
export function checkCommand(bin: unknown, argv: unknown): asserts argv is readonly string[] {
  if (typeof bin !== 'string' || bin.length === 0) throw new TypeError('exec: bin must be a non-empty string');
  if (bin.includes('\0')) throw new TypeError('exec: bin contains a NUL byte');
  if (!Array.isArray(argv)) throw new TypeError('exec: argv must be an array of strings');
  argv.forEach((arg: unknown, i) => {
    if (typeof arg !== 'string') throw new TypeError(`exec: argv[${i}] is not a string`);
    if (arg.includes('\0')) throw new TypeError(`exec: argv[${i}] contains a NUL byte`);
  });
}

function checkOptions(opts: ExecOptions): number {
  if (typeof opts !== 'object' || opts === null) throw new TypeError('exec: options are required');
  const t = opts.timeoutMs;
  if (!Number.isInteger(t) || t <= 0 || t > MAX_TIMEOUT_MS) throw new TypeError('exec: timeoutMs must be a positive integer');
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(cap) || cap <= 0) throw new TypeError('exec: maxOutputBytes must be a positive integer');
  return cap;
}

function emptyResult(extra: Partial<ExecResult>): ExecResult {
  return { exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, aborted: false, ...extra };
}

function toBuffer(x: unknown): Buffer {
  if (Buffer.isBuffer(x)) return x;
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  return Buffer.alloc(0);
}

type ExecError = Error & { code?: unknown; syscall?: unknown };

function spawnErrorCode(err: ExecError | null): string | undefined {
  if (err === null || typeof err.code !== 'string' || err.code === MAXBUFFER_CODE) return undefined;
  return err.code;
}

/** The child's own exit code, or null when a signal ended it. */
function exitCodeOf(child: childProcess.ChildProcess, err: ExecError | null): number | null {
  if (child.signalCode !== null) return null;
  if (typeof child.exitCode === 'number' && child.exitCode >= 0) return child.exitCode;
  if (err === null) return 0;
  return typeof err.code === 'number' ? err.code : null;
}

function run(bin: string, argv: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  checkCommand(bin, argv);
  const cap = checkOptions(opts);
  const { signal } = opts;
  if (signal?.aborted) return Promise.resolve(emptyResult({ aborted: true }));

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: childProcess.ChildProcess;

    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    try {
      // Looked up on the module at call time, so the test no-io guard's
      // patched execFile is the one that runs.
      child = childProcess.execFile(
        bin,
        [...argv],
        {
          shell: false,
          cwd: opts.cwd,
          encoding: 'buffer',
          maxBuffer: cap,
          killSignal: 'SIGKILL',
          windowsHide: true,
        },
        (error, stdoutRaw, stderrRaw) => {
          cleanup();
          const err = error as ExecError | null;
          const stdout = toBuffer(stdoutRaw);
          const stderr = toBuffer(stderrRaw);
          const truncated = err?.code === MAXBUFFER_CODE || stdout.length > cap || stderr.length > cap;
          const spawnError = spawnErrorCode(err);
          resolve({
            exitCode: spawnError !== undefined ? null : exitCodeOf(child, err),
            stdout: stdout.subarray(0, cap).toString('utf8'),
            stderr: stderr.subarray(0, cap).toString('utf8'),
            timedOut,
            truncated,
            aborted,
            ...(spawnError !== undefined ? { spawnError } : {}),
          });
        },
      );
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    const stdin = child.stdin;
    if (stdin !== null) {
      // A child that exits without reading stdin gives EPIPE. That is not our error.
      stdin.on('error', () => {});
      if (opts.stdin !== undefined) stdin.end(opts.stdin);
      else stdin.end();
    }
  });
}

/** The real runner. Built on node:child_process execFile with shell: false. */
export function createExecRunner(): ExecRunner {
  return {
    run(bin, argv, opts) {
      try {
        return run(bin, argv, opts);
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
}

// ------------------------------------------------------------ assertSafeArg

export class UnsafeArgError extends Error {
  override readonly name = 'UnsafeArgError';
  readonly keyName: string;
  readonly reason: string;
  constructor(keyName: string, reason: string) {
    super(`${keyName} ${reason}, so it cannot be passed to a command`);
    this.keyName = keyName;
    this.reason = reason;
  }
}

// Characters a shell on either end of an ssh hop would read as syntax. ssh
// joins its remote argv with spaces and hands it to the remote shell, so
// whitespace, quotes and globs are refused along with the usual operators.
const SHELL_META = /[;|&$`<>()'"\\*?[\]{}!#~]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const WHITESPACE = /\s/;
const PLACEHOLDER = /<[^<>]*>/;

/**
 * Throws UnsafeArgError unless value is safe to put into a fixed argv, local
 * or across an ssh hop. keyName is the env key the value came from; the
 * error names it and never the value. Refuses: non-strings, the empty
 * string, control characters (NUL, CR, LF and the rest), whitespace, shell
 * metacharacters, '<placeholder>' text and a leading '-'.
 */
export function assertSafeArg(value: unknown, keyName: string): asserts value is string {
  if (typeof value !== 'string') throw new UnsafeArgError(keyName, 'is not a string');
  if (value.length === 0) throw new UnsafeArgError(keyName, 'is empty');
  if (CONTROL.test(value)) throw new UnsafeArgError(keyName, 'contains a control character');
  if (PLACEHOLDER.test(value)) throw new UnsafeArgError(keyName, 'looks like an unfilled placeholder');
  if (WHITESPACE.test(value)) throw new UnsafeArgError(keyName, 'contains whitespace');
  if (SHELL_META.test(value)) throw new UnsafeArgError(keyName, 'contains a shell metacharacter');
  if (value.startsWith('-')) throw new UnsafeArgError(keyName, 'starts with a dash and would be read as a flag');
}

/** assertSafeArg that hands the value back, for building argv inline. */
export function safeArg(value: unknown, keyName: string): string {
  assertSafeArg(value, keyName);
  return value;
}
