// Repo checkouts against resources/repos.json (D37, D11): a read-only status
// check with branch drift, the current commit per repo for the report, and
// `triage repos sync`.
//
// Sync runs outside the model's reach. For each pin it:
// - clones a missing repo from the pin's remote, or from the URL built from
//   TRIAGE_GIT_PROTOCOL, TRIAGE_GIT_HOST and TRIAGE_GIT_ORG (D46), shallow
//   and single-branch, as triage-shivalik's git-clone.sh did;
// - skips a dirty working tree and never resets or checks it out;
// - points origin at that URL when origin names the same repo over the other
//   protocol, and warns (changing nothing) when origin names another repo;
// - fetches the pinned branch (the remote's default branch when the pin has
//   none) and checks it out at FETCH_HEAD, so nothing is merged;
// - adds .codegraph/ to .git/info/exclude and runs codegraphIndex (T11.3).
// SYNC_JOBS repos run at a time and one repo failing does not stop the rest.
// Every git call is the fixed 'git' binary with argv from git.ts, through the
// ExecRunner, with GIT_TERMINAL_PROMPT=0 so git never waits for a prompt. With
// TRIAGE_GIT_HTTPS_TOKEN set, the token reaches git as an http.extraheader
// set through GIT_CONFIG_* variables and scoped to https://TRIAGE_GIT_HOST/:
// never in argv, a URL or .git/config. git's stderr is mapped to fixed
// reasons and never returned, as the tunnel does for ssh: it can repeat URLs,
// hosts and whatever else git was handed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/env.ts';
import { loadRegistry } from '../config/registry.ts';
import { loadRepos, type RepoPin } from '../config/repos.ts';
import type { ExecResult } from '../connectors/exec.ts';
import {
  codegraphIndex,
  hasIndex,
  INDEX_DIR,
  REPOS_DIR_KEY,
  resolveRepoDir,
  type CodegraphDeps,
  type CodegraphResult,
} from './codegraph.ts';
import * as git from './git.ts';

export const LOCAL_TIMEOUT_MS = 30 * 1000;
export const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
/** Repos synced at the same time, as git-clone.sh's MAX_JOBS. */
export const SYNC_JOBS = 4;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type ReposDeps = Omit<CodegraphDeps, 'repos'> & {
  /** The repos manifest. Loaded from resources/repos.json when left out. */
  readonly repos?: readonly RepoPin[];
};

export type RepoSelection = {
  /** Limits the operation to this one pin. */
  readonly repo?: string;
};

/** --repo named something that is not in resources/repos.json. */
export class UnknownRepoError extends Error {
  override readonly name = 'UnknownRepoError';
  readonly validNames: readonly string[];
  constructor(validNames: readonly string[]) {
    super(`repo is not in resources/repos.json; valid names: ${validNames.join(', ')}`);
    this.validNames = validNames;
  }
}

export type ReposNotConfigured = { readonly status: 'not_configured'; readonly key: string; readonly message: string };

// ------------------------------------------------------------ helpers

function pinsOf(deps: ReposDeps): readonly RepoPin[] {
  return deps.repos ?? loadRepos(deps.config, loadRegistry(deps.config));
}

function select(pins: readonly RepoPin[], sel: RepoSelection): readonly RepoPin[] {
  if (sel.repo === undefined) return pins;
  const pin = pins.find((p) => p.repo === sel.repo);
  if (pin === undefined) throw new UnknownRepoError(pins.map((p) => p.repo));
  return [pin];
}

function reposDirNotConfigured(deps: ReposDeps): ReposNotConfigured | undefined {
  const dir = deps.config.paths.reposDir;
  if (dir !== undefined && dir.trim() !== '') return undefined;
  return Object.freeze({ status: 'not_configured', key: REPOS_DIR_KEY, message: `repos not configured: ${REPOS_DIR_KEY} is blank` });
}

function codegraphDeps(deps: ReposDeps, pins: readonly RepoPin[]): CodegraphDeps {
  return { ...deps, repos: pins };
}

// ------------------------------------------------------------ remotes and auth

type GitConfig = Pick<Config, 'git'>;

/** The clone URL for a repo in TRIAGE_GIT_ORG on TRIAGE_GIT_HOST over TRIAGE_GIT_PROTOCOL. */
export function defaultRemote(config: GitConfig, repo: string): string {
  const { protocol, host, org } = config.git;
  return protocol === 'https' ? `https://${host}/${org}/${repo}.git` : `git@${host}:${org}/${repo}.git`;
}

/** The pin's own remote, else the built one. */
export function remoteFor(pin: RepoPin, config: GitConfig): string {
  return pin.remote ?? defaultRemote(config, pin.repo);
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
}

/**
 * The variables every git call gets. GIT_TERMINAL_PROMPT=0 always; with a
 * token, an Authorization header for https://<host>/ through GIT_CONFIG_*,
 * the same header actions/checkout sets.
 */
export function gitEnv(config: GitConfig): Readonly<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const token = config.git.httpsToken;
  if (token !== undefined) {
    env['GIT_CONFIG_COUNT'] = '1';
    env['GIT_CONFIG_KEY_0'] = `http.https://${config.git.host}/.extraheader`;
    env['GIT_CONFIG_VALUE_0'] = `AUTHORIZATION: basic ${basicAuth(token)}`;
  }
  return Object.freeze(env);
}

/** Cuts the token, and the header built from it, out of git's output. */
function scrubToken(config: GitConfig, text: string): string {
  const token = config.git.httpsToken;
  if (token === undefined || text === '') return text;
  return text.split(basicAuth(token)).join('***').split(token).join('***');
}

async function runGit(deps: ReposDeps, argv: readonly string[], timeoutMs: number): Promise<ExecResult> {
  const r = await deps.runner.run(git.GIT_BIN, argv, {
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    env: gitEnv(deps.config),
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  return { ...r, stdout: scrubToken(deps.config, r.stdout), stderr: scrubToken(deps.config, r.stderr) };
}

const succeeded = (r: ExecResult): boolean =>
  r.exitCode === 0 && !r.timedOut && !r.aborted && r.spawnError === undefined;

// Fixed reasons for the common git failures. The stderr text itself is never returned.
const GIT_REASONS: readonly (readonly [RegExp, string])[] = [
  [/permission denied \(publickey|publickey\)/i, 'the ssh key was refused'],
  [/host key verification failed/i, 'the ssh host key is not known; connect to the host once with ssh'],
  [/couldn't find remote ref|remote branch \S+ not found/i, 'the branch is not on the remote'],
  [/repository not found|repository '[^']*' not found|does not appear to be a git repository/i, 'the repository was not found, or this identity cannot read it'],
  [/authentication failed|could not read username|could not read password|terminal prompts disabled|http basic: access denied|403/i, 'https authentication failed; check TRIAGE_GIT_HTTPS_TOKEN or the credential helper'],
  [/could not resolve host|could not resolve hostname|name or service not known|nodename nor servname/i, 'the git host name did not resolve'],
  [/connection timed out|operation timed out|connection refused|no route to host|network is unreachable|failed to connect/i, 'the git host is unreachable'],
  [/already exists and is not an empty directory/i, 'the target directory already exists'],
  [/could not read from remote repository/i, 'could not read from the remote'],
];

function failure(what: string, r: ExecResult): string {
  if (r.spawnError !== undefined) return `git ${what} could not start git (${r.spawnError})`;
  if (r.timedOut) return `git ${what} timed out`;
  if (r.aborted) return `git ${what} was aborted`;
  const why = `git ${what} exited with code ${r.exitCode === null ? 'none' : r.exitCode}`;
  const known = GIT_REASONS.find(([re]) => re.test(r.stderr));
  return known === undefined ? why : `${why}: ${known[1]}`;
}

class StepError extends Error {}

async function mustRun(deps: ReposDeps, what: string, argv: readonly string[], timeoutMs: number): Promise<string> {
  const r = await runGit(deps, argv, timeoutMs);
  if (!succeeded(r)) throw new StepError(failure(what, r));
  return r.stdout;
}

const short = (commit: string): string => commit.slice(0, 12);

// ------------------------------------------------------------ status

export type RepoStatus = {
  readonly repo: string;
  /** The pinned branch, or the locally recorded default branch when the pin has none. Null when unknown. */
  readonly expectedBranch: string | null;
  /** Null when detached, not checked out or unreadable. */
  readonly actualBranch: string | null;
  readonly commit: string | null;
  /** Null when not checked out or unreadable. */
  readonly dirty: boolean | null;
  /** True when actualBranch differs from expectedBranch. Null when either side is unknown. */
  readonly drift: boolean | null;
  readonly indexed: boolean;
  readonly present: boolean;
  /** Why some fields are null, when it is not simply 'not checked out'. */
  readonly problem?: string;
};

export type ReposStatusReport = { readonly status: 'ok'; readonly repos: readonly RepoStatus[] } | ReposNotConfigured;

/**
 * Reports each pin's checkout: branch, commit, dirty tree, drift from the
 * pinned (or default) branch and whether a codegraph index exists. Only
 * reads: no fetch, no network, no writes. Throws UnknownRepoError for an
 * unknown selection.
 */
export async function repoStatus(deps: ReposDeps, sel: RepoSelection = {}): Promise<ReposStatusReport> {
  const pins = pinsOf(deps);
  const chosen = select(pins, sel);
  const nc = reposDirNotConfigured(deps);
  if (nc !== undefined) return nc;
  const out: RepoStatus[] = [];
  for (const pin of chosen) out.push(await statusOne(pin, deps, pins));
  return Object.freeze({ status: 'ok', repos: Object.freeze(out) });
}

async function statusOne(pin: RepoPin, deps: ReposDeps, pins: readonly RepoPin[]): Promise<RepoStatus> {
  const base = {
    repo: pin.repo,
    expectedBranch: pin.branch ?? null,
    actualBranch: null,
    commit: null,
    dirty: null,
    drift: null,
    indexed: false,
    present: false,
  };
  const r = resolveRepoDir(pin.repo, deps, pins);
  if (r.status !== 'ok') return Object.freeze({ ...base, problem: r.message });
  if (!r.present) return Object.freeze(base);
  const dir = r.dir;
  const indexed = hasIndex(dir);

  const head = await runGit(deps, git.revParseHead(dir), LOCAL_TIMEOUT_MS);
  if (!succeeded(head)) {
    return Object.freeze({ ...base, present: true, indexed, problem: failure('rev-parse', head) });
  }
  const commit = git.parseCommit(head.stdout) ?? null;

  const branch = await runGit(deps, git.currentBranch(dir), LOCAL_TIMEOUT_MS);
  // symbolic-ref exits 1 on a detached HEAD; that is a state, not an error.
  const actualBranch = succeeded(branch) ? (git.parseBranch(branch.stdout) ?? null) : null;

  const status = await runGit(deps, git.statusPorcelain(dir), LOCAL_TIMEOUT_MS);
  const dirty = succeeded(status) ? git.isDirty(status.stdout) : null;

  let expectedBranch = pin.branch ?? null;
  if (expectedBranch === null) {
    const def = await runGit(deps, git.localDefaultBranch(dir), LOCAL_TIMEOUT_MS);
    expectedBranch = succeeded(def) ? (git.parseLocalDefaultBranch(def.stdout) ?? null) : null;
  }

  let drift: boolean | null = null;
  if (expectedBranch !== null) drift = actualBranch !== expectedBranch;

  const problems: string[] = [];
  if (!succeeded(status)) problems.push(failure('status', status));
  if (expectedBranch === null) problems.push('default branch is not recorded locally; run triage repos sync');

  return Object.freeze({
    repo: pin.repo,
    expectedBranch,
    actualBranch,
    commit,
    dirty,
    drift,
    indexed,
    present: true,
    ...(problems.length > 0 ? { problem: problems.join('; ') } : {}),
  });
}

// ------------------------------------------------------------ current commit

export type CommitResult =
  | { readonly status: 'ok'; readonly repo: string; readonly commit: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * The commit a repo's checkout is on, for the report's per-repo commit
 * record. The name must be in the manifest; refusals never echo it.
 */
export async function currentCommit(repo: string, deps: ReposDeps): Promise<CommitResult> {
  const r = resolveRepoDir(repo, deps, deps.repos);
  if (r.status !== 'ok') return Object.freeze({ status: 'unavailable', reason: r.message });
  if (!r.present) return Object.freeze({ status: 'unavailable', reason: `repo is not checked out under ${REPOS_DIR_KEY}` });
  const head = await runGit(deps, git.revParseHead(r.dir), LOCAL_TIMEOUT_MS);
  if (!succeeded(head)) return Object.freeze({ status: 'unavailable', reason: failure('rev-parse', head) });
  const commit = git.parseCommit(head.stdout);
  if (commit === undefined) return Object.freeze({ status: 'unavailable', reason: 'git rev-parse gave no commit id' });
  return Object.freeze({ status: 'ok', repo: r.repo, commit });
}

// ------------------------------------------------------------ sync

export type RepoSyncResult = {
  readonly repo: string;
  readonly status: 'ok' | 'skipped' | 'failed';
  /** What sync did to the checkout, when status is ok. */
  readonly action?: 'cloned' | 'updated';
  readonly branch?: string;
  readonly commit?: string;
  /** The codegraph command that ran, when one did. */
  readonly index?: 'init' | 'sync';
  /** Why the repo was skipped or failed: 'dirty', a codegraph lock, or a message. */
  readonly reason?: string;
  readonly warnings: readonly string[];
  /** One human line for this repo. */
  readonly line: string;
};

export type SyncReport =
  | {
      readonly status: 'done';
      readonly results: readonly RepoSyncResult[];
      readonly ok: readonly string[];
      readonly skipped: readonly string[];
      readonly failed: readonly string[];
    }
  | ReposNotConfigured;

/**
 * `triage repos sync`: brings every pin (or the one selected) to its pinned
 * branch and refreshes its codegraph index. Throws UnknownRepoError for an
 * unknown selection; every per-repo problem is a result, not a throw.
 */
export async function syncRepos(sel: RepoSelection, deps: ReposDeps): Promise<SyncReport> {
  const pins = pinsOf(deps);
  const chosen = select(pins, sel);
  const nc = reposDirNotConfigured(deps);
  if (nc !== undefined) return nc;

  const results = await inPool(chosen, SYNC_JOBS, async (pin) => {
    try {
      return await syncOne(pin, deps, pins);
    } catch (e) {
      return finish(pin.repo, { status: 'failed', reason: e instanceof Error ? scrubToken(deps.config, e.message) : 'unexpected error' });
    }
  });
  const names = (s: RepoSyncResult['status']) => Object.freeze(results.filter((r) => r.status === s).map((r) => r.repo));
  return Object.freeze({
    status: 'done',
    results: Object.freeze(results),
    ok: names('ok'),
    skipped: names('skipped'),
    failed: names('failed'),
  });
}

/** Runs fn over items, at most `jobs` at a time. Results keep the items' order. */
async function inPool<T, R>(items: readonly T[], jobs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  return out;
}

type Draft = Omit<RepoSyncResult, 'repo' | 'line' | 'warnings'> & { readonly warnings?: readonly string[] };

function finish(repo: string, d: Draft): RepoSyncResult {
  const warnings = Object.freeze([...(d.warnings ?? [])]);
  let line: string;
  if (d.status === 'ok') {
    const verb = d.action === 'cloned' ? 'cloned' : 'updated to';
    const where = d.branch === undefined ? '' : ` ${verb} ${d.branch}`;
    const at = d.commit === undefined ? '' : ` at ${short(d.commit)}`;
    const idx = d.index === undefined ? '' : `, codegraph ${d.index}`;
    line = `${repo}: ok,${where}${at}${idx}`;
  } else {
    line = `${repo}: ${d.status}: ${d.reason ?? 'unknown reason'}`;
  }
  if (warnings.length > 0) line += ` (warning: ${warnings.join('; ')})`;
  return Object.freeze({ repo, ...d, warnings, line });
}

async function syncOne(pin: RepoPin, deps: ReposDeps, pins: readonly RepoPin[]): Promise<RepoSyncResult> {
  // Validate the pin before any git call, so a bad branch or remote runs nothing.
  if (pin.branch !== undefined) git.branchArg(pin.branch);
  const remote = git.remoteArg(remoteFor(pin, deps.config));

  const r = resolveRepoDir(pin.repo, deps, pins);
  if (r.status !== 'ok') return finish(pin.repo, { status: 'failed', reason: r.message });

  try {
    if (!r.present) return await cloneAndIndex(pin, remote, deps, pins);
    return await updateAndIndex(pin, r.dir, remote, deps, pins);
  } catch (e) {
    if (e instanceof StepError) return finish(pin.repo, { status: 'failed', reason: e.message });
    throw e;
  }
}

async function updateAndIndex(
  pin: RepoPin,
  dir: string,
  remote: string,
  deps: ReposDeps,
  pins: readonly RepoPin[],
): Promise<RepoSyncResult> {
  const status = await mustRun(deps, 'status', git.statusPorcelain(dir), LOCAL_TIMEOUT_MS);
  if (git.isDirty(status)) {
    return finish(pin.repo, {
      status: 'skipped',
      reason: 'dirty',
      warnings: ['the working tree has local changes, so nothing was fetched or checked out; commit or stash them first'],
    });
  }

  const warnings: string[] = [];
  const origin = (await mustRun(deps, 'remote get-url', git.remoteGetUrl(dir), LOCAL_TIMEOUT_MS)).trim();
  if (origin !== remote) {
    const same = git.remoteIdentity(origin);
    if (same !== undefined && same === git.remoteIdentity(remote)) {
      await mustRun(deps, 'remote set-url', git.remoteSetUrl(dir, remote), LOCAL_TIMEOUT_MS);
      warnings.push(`origin now points at ${remote}`);
    } else {
      // The origin URL is not printed: it may carry credentials.
      warnings.push(`origin does not point at ${remote}; fetched from origin as it is`);
    }
  }

  let branch = pin.branch;
  if (branch === undefined) {
    const out = await mustRun(deps, 'ls-remote', git.remoteDefaultBranch(dir), FETCH_TIMEOUT_MS);
    branch = git.parseDefaultBranch(out);
    if (branch === undefined) throw new StepError('could not read the default branch of origin');
  }

  await mustRun(deps, 'fetch', git.fetchBranch(dir, branch), FETCH_TIMEOUT_MS);
  await mustRun(deps, 'checkout', git.checkoutFetched(dir, branch), LOCAL_TIMEOUT_MS);
  return indexAndFinish(pin, dir, branch, 'updated', deps, pins, warnings);
}

async function cloneAndIndex(pin: RepoPin, remote: string, deps: ReposDeps, pins: readonly RepoPin[]): Promise<RepoSyncResult> {
  const reposDir = deps.config.paths.reposDir as string;
  mkdirSync(reposDir, { recursive: true });

  let branch = pin.branch;
  if (branch === undefined) {
    const out = await mustRun(deps, 'ls-remote', git.remoteDefaultBranchOf(reposDir, remote), FETCH_TIMEOUT_MS);
    branch = git.parseDefaultBranch(out);
    if (branch === undefined) throw new StepError('could not read the default branch of the remote');
  }

  await mustRun(deps, 'clone', git.cloneBranch(reposDir, remote, branch, pin.repo), CLONE_TIMEOUT_MS);

  // Resolve again, so the new checkout goes through the same jail as any other.
  const r = resolveRepoDir(pin.repo, deps, pins);
  if (r.status !== 'ok') return finish(pin.repo, { status: 'failed', reason: r.message });
  if (!r.present) return finish(pin.repo, { status: 'failed', reason: 'git clone finished but the repo directory is missing' });
  return indexAndFinish(pin, r.dir, branch, 'cloned', deps, pins);
}

async function indexAndFinish(
  pin: RepoPin,
  dir: string,
  branch: string,
  action: 'cloned' | 'updated',
  deps: ReposDeps,
  pins: readonly RepoPin[],
  earlier: readonly string[] = [],
): Promise<RepoSyncResult> {
  const warnings: string[] = [...earlier];
  const head = await mustRun(deps, 'rev-parse', git.revParseHead(dir), LOCAL_TIMEOUT_MS);
  const commit = git.parseCommit(head);

  const excludeWarning = addIndexExclude(dir);
  if (excludeWarning !== undefined) warnings.push(excludeWarning);

  const idx: CodegraphResult = await codegraphIndex(pin.repo, codegraphDeps(deps, pins));
  const done = { action, branch, ...(commit !== undefined ? { commit } : {}) };
  switch (idx.status) {
    case 'ok':
      return finish(pin.repo, { status: 'ok', ...done, index: idx.command === 'init' ? 'init' : 'sync', warnings });
    case 'not_configured':
    case 'skipped':
      warnings.push(`codegraph index not refreshed: ${idx.status === 'skipped' ? idx.reason : idx.message}`);
      return finish(pin.repo, { status: 'ok', ...done, warnings });
    case 'busy':
      return finish(pin.repo, { status: 'skipped', ...done, reason: idx.reason, warnings });
    case 'error':
    case 'refused':
    case 'missing':
    case 'no_index':
      return finish(pin.repo, { status: 'failed', ...done, reason: idx.message, warnings });
  }
}

/**
 * Appends '.codegraph/' to <dir>/.git/info/exclude unless it is already
 * listed. Returns a warning when the checkout has no .git directory (a
 * worktree or submodule keeps it elsewhere) or the file cannot be written.
 */
export function addIndexExclude(dir: string): string | undefined {
  const gitDir = join(dir, '.git');
  let isDir = false;
  try {
    isDir = statSync(gitDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return `could not add ${INDEX_DIR}/ to .git/info/exclude: .git is not a directory`;
  try {
    const infoDir = join(gitDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const file = join(infoDir, 'exclude');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const listed = current.split('\n').some((l) => {
      const t = l.trim();
      return t === `${INDEX_DIR}/` || t === `/${INDEX_DIR}/` || t === INDEX_DIR || t === `/${INDEX_DIR}`;
    });
    if (listed) return undefined;
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    appendFileSync(file, `${sep}${INDEX_DIR}/\n`);
    return undefined;
  } catch {
    return `could not add ${INDEX_DIR}/ to .git/info/exclude`;
  }
}
