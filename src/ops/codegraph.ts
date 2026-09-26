// CodeGraph index operations: version, init/sync, status, and the
// sync-once-per-run guard the code tools call before their first query per
// repo (D11, D37).
//
// Rules this file keeps:
// - Every codegraph call is CODEGRAPH_BIN with a fixed argv through the
//   ExecRunner. A blank CODEGRAPH_BIN answers 'not configured' with the key
//   name, and nothing runs.
// - A repo is named, never given as a path. The name must be in the repos
//   manifest (resources/repos.json) and its directory, after symlinks are
//   resolved, must sit under TRIAGE_REPOS_DIR.
// - Writers (init and sync) take <repo>/.codegraph/.triage-sync.lock with
//   O_EXCL, so `triage repos sync` and an in-run sync never write one index
//   at the same time. A lock older than 10 minutes is stale and taken over.
//   A caller that cannot get the lock gets 'busy' back and nothing runs.
// - A failed run comes back as an 'error' result with a trimmed stderr tail.
//   Only programming errors from the runner itself are thrown.

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import * as v from 'valibot';
import { rawKeyState, type Config } from '../config/env.ts';
import { loadRegistry, RepoNameSchema } from '../config/registry.ts';
import { loadRepos } from '../config/repos.ts';
import { succeeded, type ExecResult, type ExecRunner } from '../connectors/exec.ts';

export const CODEGRAPH_BIN_KEY = 'CODEGRAPH_BIN';
export const REPOS_DIR_KEY = 'TRIAGE_REPOS_DIR';

export const INDEX_DIR = '.codegraph';
export const INDEX_FILE = 'codegraph.db';
export const LOCK_FILE = '.triage-sync.lock';

/** A lock whose file is older than this is treated as left behind and taken over. */
export const LOCK_STALE_MS = 10 * 60 * 1000;

// A writer is killed before its lock can go stale, so a live writer is never
// taken over.
export const INDEX_TIMEOUT_MS = 9 * 60 * 1000;
export const STATUS_TIMEOUT_MS = 60 * 1000;
export const VERSION_TIMEOUT_MS = 15 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const OUTPUT_TAIL_CHARS = 2000;
const STDERR_TAIL_CHARS = 1000;

export type CodegraphCommand = 'version' | 'init' | 'sync' | 'status';

export type CodegraphResult =
  | {
      readonly status: 'ok';
      readonly command: CodegraphCommand;
      readonly repo?: string;
      /** Trimmed tail of stdout. */
      readonly output: string;
      readonly truncated: boolean;
    }
  | { readonly status: 'not_configured'; readonly key: string; readonly message: string }
  | { readonly status: 'refused'; readonly message: string }
  | { readonly status: 'missing'; readonly repo: string; readonly message: string }
  | { readonly status: 'no_index'; readonly repo: string; readonly message: string }
  | { readonly status: 'busy'; readonly repo: string; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: string }
  | {
      readonly status: 'error';
      readonly command: CodegraphCommand;
      readonly repo?: string;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly aborted: boolean;
      readonly message: string;
      /** Trimmed tail of stderr. */
      readonly stderrTail: string;
    };

export type CodegraphDeps = {
  readonly config: Config;
  readonly runner: ExecRunner;
  /** The repos manifest. Loaded from resources/repos.json when left out. */
  readonly repos?: readonly { readonly repo: string }[];
  readonly signal?: AbortSignal;
  /** Clock for lock staleness. Defaults to Date.now. */
  readonly now?: () => number;
};

// ------------------------------------------------------------ small helpers

function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(t.length - max).trimStart();
}

/** The binary to run, or the 'not configured' answer when CODEGRAPH_BIN is blank. */
function codegraphBin(config: Config): { bin: string } | CodegraphResult {
  const bin = config.code.codegraphBin.trim();
  if (rawKeyState(config, CODEGRAPH_BIN_KEY) === 'empty' || bin === '') {
    return notConfigured(CODEGRAPH_BIN_KEY);
  }
  return { bin };
}

function notConfigured(key: string): Extract<CodegraphResult, { status: 'not_configured' }> {
  return Object.freeze({ status: 'not_configured', key, message: `codegraph not configured: ${key} is blank` });
}

function refused(message: string): Extract<CodegraphResult, { status: 'refused' }> {
  return Object.freeze({ status: 'refused', message });
}

function manifestOf(deps: Pick<CodegraphDeps, 'config' | 'repos'>): readonly { readonly repo: string }[] {
  return deps.repos ?? loadRepos(deps.config, loadRegistry(deps.config));
}

function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ------------------------------------------------------------ repo paths

export type RepoDir =
  | { readonly status: 'ok'; readonly repo: string; readonly dir: string; readonly present: boolean }
  | Extract<CodegraphResult, { status: 'not_configured' | 'refused' }>;

/**
 * Resolves a repo name to its directory under TRIAGE_REPOS_DIR. Refuses a
 * name that is not in the manifest, is not a plain repo name, or resolves
 * (through '..' or a symlink) outside TRIAGE_REPOS_DIR. Refusal messages
 * never echo the name, since it may come from the model.
 */
export function resolveRepoDir(
  repo: unknown,
  deps: Pick<CodegraphDeps, 'config' | 'repos'>,
  manifest?: readonly { readonly repo: string }[],
): RepoDir {
  const reposDir = deps.config.paths.reposDir;
  if (reposDir === undefined || reposDir.trim() === '') {
    return notConfigured(REPOS_DIR_KEY);
  }
  const pins = manifest ?? manifestOf(deps);
  if (typeof repo !== 'string' || !pins.some((p) => p.repo === repo)) {
    return refused('repo is not in resources/repos.json');
  }
  if (!v.is(RepoNameSchema, repo)) {
    return refused('repo is not a plain repo name');
  }
  const root = resolve(reposDir);
  const dir = resolve(root, repo);
  if (!isUnder(root, dir)) return refused(`repo resolves outside ${REPOS_DIR_KEY}`);
  if (!existsSync(dir)) return Object.freeze({ status: 'ok', repo, dir, present: false });

  let realRoot: string;
  let realDir: string;
  try {
    realRoot = realpathSync(root);
    realDir = realpathSync(dir);
  } catch {
    return refused('repo path could not be resolved');
  }
  if (!isUnder(realRoot, realDir)) return refused(`repo resolves outside ${REPOS_DIR_KEY}`);
  let isDir = false;
  try {
    isDir = statSync(realDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return refused('repo path is not a directory');
  return Object.freeze({ status: 'ok', repo, dir: realDir, present: true });
}

/** True when <repoDir>/.codegraph/codegraph.db exists as a file. */
export function hasIndex(repoDir: string): boolean {
  try {
    return statSync(join(repoDir, INDEX_DIR, INDEX_FILE)).isFile();
  } catch {
    return false;
  }
}

export function lockPath(repoDir: string): string {
  return join(repoDir, INDEX_DIR, LOCK_FILE);
}

// ------------------------------------------------------------ the lock

export type SyncLock = { readonly path: string; release(): void };

export type LockAttempt =
  | { readonly ok: true; readonly lock: SyncLock }
  | { readonly ok: false; readonly reason: string };

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

function createLockFile(path: string, token: string, now: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, `${JSON.stringify({ token, pid: process.pid, startedAt: new Date(now).toISOString() })}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function lockToken(path: string): string | undefined {
  try {
    const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof doc === 'object' && doc !== null && 'token' in doc && typeof doc.token === 'string') return doc.token;
  } catch {
    // Unreadable or half-written.
  }
  return undefined;
}

/**
 * Takes the writer lock for one repo index without waiting. A lock file
 * older than LOCK_STALE_MS is removed and taken over; the file is stat'ed
 * again right before removal so a lock another process just took is not
 * removed by mistake. release() removes the file only while it still holds
 * this lock's token.
 */
export function tryAcquireSyncLock(repoDir: string, now: () => number = Date.now): LockAttempt {
  const path = lockPath(repoDir);
  mkdirSync(join(repoDir, INDEX_DIR), { recursive: true });
  const token = randomUUID();

  if (!createLockFile(path, token, now())) {
    let seen: ReturnType<typeof statSync>;
    try {
      seen = statSync(path);
    } catch {
      // Released between our open and our stat. Try once more.
      return createLockFile(path, token, now()) ? held(path, token) : busy();
    }
    if (now() - seen.mtimeMs <= LOCK_STALE_MS) return busy();
    try {
      const again = statSync(path);
      if (again.ino !== seen.ino || again.mtimeMs !== seen.mtimeMs) return busy();
      unlinkSync(path);
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
    }
    if (!createLockFile(path, token, now())) return busy();
  }
  return held(path, token);
}

function busy(): LockAttempt {
  return Object.freeze({ ok: false, reason: 'another codegraph writer holds the sync lock' });
}

function held(path: string, token: string): LockAttempt {
  let released = false;
  return Object.freeze({
    ok: true,
    lock: Object.freeze({
      path,
      release() {
        if (released) return;
        released = true;
        if (lockToken(path) !== token) return;
        try {
          unlinkSync(path);
        } catch (e) {
          if (errCode(e) !== 'ENOENT') throw e;
        }
      },
    }),
  });
}

// ------------------------------------------------------------ running codegraph

function fromExec(command: CodegraphCommand, repo: string | undefined, r: ExecResult): CodegraphResult {
  const base = repo === undefined ? {} : { repo };
  if (succeeded(r)) {
    return Object.freeze({ status: 'ok', command, ...base, output: tail(r.stdout, OUTPUT_TAIL_CHARS), truncated: r.truncated });
  }
  let message: string;
  if (r.spawnError !== undefined) message = `codegraph ${command} could not start (${r.spawnError}); check ${CODEGRAPH_BIN_KEY}`;
  else if (r.timedOut) message = `codegraph ${command} timed out`;
  else if (r.aborted) message = `codegraph ${command} was aborted`;
  else message = `codegraph ${command} exited with code ${r.exitCode === null ? 'none' : r.exitCode}`;
  return Object.freeze({
    status: 'error',
    command,
    ...base,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    aborted: r.aborted,
    message,
    stderrTail: tail(r.stderr, STDERR_TAIL_CHARS),
  });
}

async function runCodegraph(
  deps: CodegraphDeps,
  bin: string,
  command: CodegraphCommand,
  argv: readonly string[],
  timeoutMs: number,
  repo?: string,
): Promise<CodegraphResult> {
  const result = await deps.runner.run(bin, argv, {
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  return fromExec(command, repo, result);
}

/** `codegraph --version`. */
export async function codegraphVersion(deps: Pick<CodegraphDeps, 'config' | 'runner' | 'signal'>): Promise<CodegraphResult> {
  const b = codegraphBin(deps.config);
  if (!('bin' in b)) return b;
  return runCodegraph(deps, b.bin, 'version', ['--version'], VERSION_TIMEOUT_MS);
}

/** `codegraph status <dir>` for an indexed repo. A repo without an index answers 'no_index' and runs nothing. */
export async function codegraphStatus(repo: string, deps: CodegraphDeps): Promise<CodegraphResult> {
  const b = codegraphBin(deps.config);
  if (!('bin' in b)) return b;
  const r = resolveRepoDir(repo, deps);
  if (r.status !== 'ok') return r;
  if (!r.present) return missing(r.repo);
  if (!hasIndex(r.dir)) return noIndex(r.repo);
  return runCodegraph(deps, b.bin, 'status', ['status', r.dir], STATUS_TIMEOUT_MS, r.repo);
}

/**
 * Builds or refreshes one repo's index under the writer lock: `codegraph
 * init <dir>` when there is no index yet, otherwise `codegraph sync <dir>`.
 * Used by `triage repos sync`. A held lock answers 'busy' and runs nothing.
 */
export async function codegraphIndex(repo: string, deps: CodegraphDeps): Promise<CodegraphResult> {
  const b = codegraphBin(deps.config);
  if (!('bin' in b)) return b;
  const r = resolveRepoDir(repo, deps);
  if (r.status !== 'ok') return r;
  if (!r.present) return missing(r.repo);
  return withLock(r.repo, r.dir, deps, () => {
    const command = hasIndex(r.dir) ? 'sync' : 'init';
    return runCodegraph(deps, b.bin, command, [command, r.dir], INDEX_TIMEOUT_MS, r.repo);
  });
}

async function withLock(
  repo: string,
  dir: string,
  deps: CodegraphDeps,
  fn: () => Promise<CodegraphResult>,
): Promise<CodegraphResult> {
  const attempt = tryAcquireSyncLock(dir, deps.now);
  if (!attempt.ok) return Object.freeze({ status: 'busy', repo, reason: attempt.reason });
  try {
    return await fn();
  } finally {
    attempt.lock.release();
  }
}

function missing(repo: string): CodegraphResult {
  return Object.freeze({ status: 'missing', repo, message: `repo is not checked out under ${REPOS_DIR_KEY}` });
}

function noIndex(repo: string): CodegraphResult {
  return Object.freeze({ status: 'no_index', repo, message: 'repo has no codegraph index; run triage repos sync' });
}

// ------------------------------------------------------------ sync once per run

export type SyncOnce = {
  /**
   * Runs `codegraph sync <dir>` for the repo at most once for this instance.
   * Does nothing in mock mode or when CODEGRAPH_SYNC_BEFORE_QUERY=false.
   * Never runs init: a repo without an index answers 'no_index'. A held
   * lock answers 'busy' without running anything, and a later call may try
   * again.
   */
  ensureSynced(repo: string): Promise<CodegraphResult>;
};

/** The signal, when given, covers every sync this instance runs. */
export type SyncOnceDeps = CodegraphDeps;

/** One instance per run. The code tools call ensureSynced before their first query per repo. */
export function createSyncOnce(deps: SyncOnceDeps): SyncOnce {
  const done = new Map<string, Promise<CodegraphResult>>();
  let manifest: readonly { readonly repo: string }[] | undefined;

  const syncOnce = async (repo: string): Promise<CodegraphResult> => {
    const b = codegraphBin(deps.config);
    if (!('bin' in b)) return b;
    // The manifest is read once per instance, and only when a repos dir is set.
    if (deps.config.paths.reposDir !== undefined) manifest ??= manifestOf(deps);
    const r = resolveRepoDir(repo, deps, manifest ?? []);
    if (r.status !== 'ok') return r;
    if (!r.present) return missing(r.repo);
    if (!hasIndex(r.dir)) return noIndex(r.repo);
    return withLock(r.repo, r.dir, deps, () =>
      runCodegraph(deps, b.bin, 'sync', ['sync', r.dir], INDEX_TIMEOUT_MS, r.repo),
    );
  };

  return Object.freeze({
    ensureSynced(repo: string): Promise<CodegraphResult> {
      if (deps.config.mock.enabled) {
        return Promise.resolve(Object.freeze({ status: 'skipped', reason: 'mock mode: codegraph sync does not run' }));
      }
      if (!deps.config.code.syncBeforeQuery) {
        return Promise.resolve(Object.freeze({ status: 'skipped', reason: 'CODEGRAPH_SYNC_BEFORE_QUERY is false' }));
      }
      const key = typeof repo === 'string' ? repo : '';
      const existing = done.get(key);
      if (existing !== undefined) return existing;
      const pending = syncOnce(repo).then(
        (result) => {
          // Nothing ran while the lock was held, so a later call may try again.
          if (result.status === 'busy') done.delete(key);
          return result;
        },
        (err: unknown) => {
          done.delete(key);
          throw err;
        },
      );
      done.set(key, pending);
      return pending;
    },
  });
}
