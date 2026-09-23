// Pure argv builders for the git calls `triage repos sync` and the repo status
// check make (D37). Every builder returns the argv for the fixed 'git' binary,
// always starting with '-C <dir>', and validates what goes into it: the
// directory must be absolute, branch names must match BranchNameSchema, repo
// names RepoNameSchema and remotes RemoteUrlSchema. Nothing here runs git.
//
// There is no pull: sync fetches the pinned branch and checks it out at
// FETCH_HEAD, so nothing is ever merged.

import { isAbsolute } from 'node:path';
import * as v from 'valibot';
import { RepoNameSchema } from '../config/registry.ts';
import { BranchNameSchema, RemoteUrlSchema } from '../config/repos.ts';

export const GIT_BIN = 'git';

export class GitArgError extends Error {
  override readonly name = 'GitArgError';
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`git ${field} ${reason}`);
    this.field = field;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;

function dirArg(dir: string): string {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new GitArgError('directory', 'must be an absolute path');
  if (CONTROL.test(dir)) throw new GitArgError('directory', 'contains a control character');
  return dir;
}

/** Throws GitArgError unless the value is a plain branch name. The message never echoes the value. */
export function branchArg(branch: unknown): string {
  if (!v.is(BranchNameSchema, branch)) throw new GitArgError('branch', 'is not a plain branch name');
  return branch;
}

export function repoArg(repo: unknown): string {
  if (!v.is(RepoNameSchema, repo)) throw new GitArgError('repo', 'is not a plain repo name');
  return repo;
}

export function remoteArg(remote: unknown): string {
  if (!v.is(RemoteUrlSchema, remote)) throw new GitArgError('remote', 'is not an allowed clone URL');
  return remote;
}

const at = (dir: string, ...rest: string[]): readonly string[] => Object.freeze(['-C', dirArg(dir), ...rest]);

/** Prints the commit HEAD points at. */
export function revParseHead(dir: string): readonly string[] {
  return at(dir, 'rev-parse', '--verify', 'HEAD');
}

/** Prints the checked-out branch. Exits 1 with no output when HEAD is detached. */
export function currentBranch(dir: string): readonly string[] {
  return at(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD');
}

/** One line per changed or untracked path; empty output means a clean tree. */
export function statusPorcelain(dir: string): readonly string[] {
  return at(dir, 'status', '--porcelain', '--untracked-files=normal');
}

/** Fetches one branch from origin into FETCH_HEAD. Tags are left alone. */
export function fetchBranch(dir: string, branch: string): readonly string[] {
  return at(dir, 'fetch', '--no-tags', 'origin', branchArg(branch));
}

/** Points the branch at the fetched commit and checks it out. Only run on a clean tree. */
export function checkoutFetched(dir: string, branch: string): readonly string[] {
  return at(dir, 'checkout', '-B', branchArg(branch), 'FETCH_HEAD');
}

/**
 * Asks origin which branch its HEAD points at. Needs the network, so only
 * sync uses it. Parse the output with parseDefaultBranch.
 */
export function remoteDefaultBranch(dir: string): readonly string[] {
  return at(dir, 'ls-remote', '--symref', 'origin', 'HEAD');
}

/** The same lookup against a URL, for a repo that is not cloned yet. Run from the repos dir. */
export function remoteDefaultBranchOf(reposDir: string, remote: string): readonly string[] {
  return at(reposDir, 'ls-remote', '--symref', remoteArg(remote), 'HEAD');
}

/**
 * The default branch as last recorded locally (refs/remotes/origin/HEAD).
 * Offline, so the status check uses it. Prints 'origin/<branch>'; exits
 * non-zero when the ref is not set. Parse with parseLocalDefaultBranch.
 */
export function localDefaultBranch(dir: string): readonly string[] {
  return at(dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
}

/** Shallow single-branch clone of one branch into <reposDir>/<repo>. */
export function cloneBranch(reposDir: string, remote: string, branch: string, repo: string): readonly string[] {
  return at(
    reposDir,
    'clone',
    '--branch',
    branchArg(branch),
    '--single-branch',
    '--depth=1',
    '--no-tags',
    '--',
    remoteArg(remote),
    repoArg(repo),
  );
}

// ------------------------------------------------------------ output parsers

/** The branch from `ls-remote --symref ... HEAD` output, or undefined when it is missing or not a plain name. */
export function parseDefaultBranch(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line.trim());
    if (m !== null && v.is(BranchNameSchema, m[1])) return m[1];
  }
  return undefined;
}

/** The branch from `symbolic-ref --short refs/remotes/origin/HEAD` output. */
export function parseLocalDefaultBranch(stdout: string): string | undefined {
  const ref = stdout.trim();
  const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : undefined;
  return branch !== undefined && v.is(BranchNameSchema, branch) ? branch : undefined;
}

/** A plain branch name from `symbolic-ref --short HEAD`, else undefined. */
export function parseBranch(stdout: string): string | undefined {
  const branch = stdout.trim();
  return v.is(BranchNameSchema, branch) ? branch : undefined;
}

/** A full commit id (sha1 or sha256) from rev-parse, else undefined. */
export function parseCommit(stdout: string): string | undefined {
  const commit = stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ? commit : undefined;
}

/**
 * True when status --porcelain lists anything other than the codegraph
 * index directory, which sync adds to .git/info/exclude but an older
 * checkout may still show as untracked.
 */
export function isDirty(stdout: string): boolean {
  return stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .some((l) => l !== '?? .codegraph/');
}
