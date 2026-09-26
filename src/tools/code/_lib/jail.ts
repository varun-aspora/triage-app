// The path jail for repo_read and repo_grep (HLD 02 §2, D2, D11).
//
// A path from the model is checked as text first (no NUL, not absolute, no
// '..', no segment starting with '.'), then resolved with realpath, and the
// result must still sit under the realpath of <TRIAGE_REPOS_DIR>/<repo> with
// no dot segment. The repo directory itself must not be a symlink. Checking after realpath is what stops a symlink inside the
// repo from pointing at a file outside it, or at .git/ or a dotfile inside it.
//
// Refusal messages are fixed texts and never echo the path or the repo name.

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as v from 'valibot';
import { RepoNameSchema } from '../../../config/registry.ts';

/** Largest file repo_read will open and repo_grep will scan by default. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PATH_CHARS = 1024;

export type JailRefusal =
  | 'not_configured'
  | 'bad_repo'
  | 'repo_missing'
  | 'bad_path'
  | 'nul'
  | 'absolute'
  | 'escape'
  | 'dotfile'
  | 'not_found'
  | 'outside'
  | 'not_file'
  | 'not_dir'
  | 'too_large';

export type JailResult =
  | {
      readonly ok: true;
      /** Realpath of the repo root. */
      readonly root: string;
      /** Realpath of the target. */
      readonly path: string;
      /** Target relative to the repo root, with '/' separators; '' for the root. */
      readonly rel: string;
      readonly kind: 'file' | 'dir';
      readonly size: number;
    }
  | JailRefused;

export type JailRefused = { readonly ok: false; readonly code: JailRefusal; readonly message: string };

export type JailOptions = {
  /** What the target must be. Defaults to 'file'. */
  readonly expect?: 'file' | 'dir' | 'any';
  /** Files larger than this are refused. Defaults to MAX_FILE_BYTES. */
  readonly maxBytes?: number;
};

const MESSAGES: Readonly<Record<JailRefusal, string>> = Object.freeze({
  not_configured: 'repos are not configured: TRIAGE_REPOS_DIR is blank',
  bad_repo: 'repo is not a plain repo name',
  repo_missing: 'repo is not checked out under TRIAGE_REPOS_DIR',
  bad_path: 'path must be a relative path inside the repo, with / separators',
  nul: 'path must not contain a NUL character',
  absolute: 'path must be relative to the repo root, not absolute',
  escape: "path must not contain '..'",
  dotfile: 'paths starting with a dot (.git, .env and other dotfiles) are not readable',
  not_found: 'no such file in the repo',
  outside: 'path resolves outside the repo',
  not_file: 'path is a directory; use repo_grep with path_glob to list matches under it',
  not_dir: 'path is not a directory',
  too_large: 'file is larger than the read cap; use repo_grep to find the lines you need',
});

function refuse(code: JailRefusal): JailRefused {
  return Object.freeze({ ok: false, code, message: MESSAGES[code] });
}

/** True when `path` is `root` or sits under it. */
export function isWithin(root: string, path: string): boolean {
  if (path === root) return true;
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** True when some segment of a '/'-separated relative path starts with '.'. */
export function hasDotSegment(rel: string): boolean {
  return rel.split('/').some((s) => s.startsWith('.'));
}

/**
 * Checks a model-given relative path as text. Returns the normalised
 * segments, or the refusal. An empty path means the repo root.
 */
export function checkRelPath(relPath: unknown): { ok: true; segments: string[] } | { ok: false; code: JailRefusal } {
  if (typeof relPath !== 'string' || relPath.length > MAX_PATH_CHARS) return { ok: false, code: 'bad_path' };
  if (relPath.includes('\0')) return { ok: false, code: 'nul' };
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[A-Za-z]:/.test(relPath) || isAbsolute(relPath)) {
    return { ok: false, code: 'absolute' };
  }
  if (relPath.includes('\\')) return { ok: false, code: 'bad_path' };
  if (/[\u0000-\u001f\u007f]/.test(relPath)) return { ok: false, code: 'bad_path' };
  const segments = relPath.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '..')) return { ok: false, code: 'escape' };
  if (segments.some((s) => s.startsWith('.'))) return { ok: false, code: 'dotfile' };
  return { ok: true, segments };
}

/**
 * Realpath of <reposDir>/<repo>. It must be exactly <realpath(reposDir)>/<repo>:
 * the repo directory itself must not be a symlink, so a repo cannot point at
 * another entity's checkout (or anywhere else) under a name the caller may use.
 */
export function resolveRepoRoot(
  reposDir: string | undefined,
  repo: unknown,
): { readonly ok: true; readonly root: string } | JailRefused {
  if (reposDir === undefined || reposDir.trim() === '') return refuse('not_configured');
  if (typeof repo !== 'string' || !v.is(RepoNameSchema, repo) || repo.startsWith('.')) {
    return refuse('bad_repo');
  }
  let realBase: string;
  let root: string;
  try {
    realBase = realpathSync(resolve(reposDir));
    root = realpathSync(join(realBase, repo));
  } catch {
    return refuse('repo_missing');
  }
  if (root !== join(realBase, repo)) return refuse('outside');
  try {
    if (!statSync(root).isDirectory()) return refuse('repo_missing');
  } catch {
    return refuse('repo_missing');
  }
  return { ok: true, root };
}

/**
 * Resolves `relPath` inside <reposDir>/<repo>. Symlinks are resolved first;
 * the result must sit under the repo's realpath with no dot segment, and a
 * file must be no larger than the size cap.
 */
export function resolveInRepo(reposDir: string | undefined, repo: unknown, relPath: unknown, opts: JailOptions = {}): JailResult {
  const expect = opts.expect ?? 'file';
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;

  const text = checkRelPath(relPath);
  if (!text.ok) return refuse(text.code);
  const repoRoot = resolveRepoRoot(reposDir, repo);
  if (!repoRoot.ok) return repoRoot;
  const { root } = repoRoot;

  let real: string;
  try {
    real = realpathSync(join(root, ...text.segments));
  } catch {
    return refuse('not_found');
  }
  if (!isWithin(root, real)) return refuse('outside');
  const rel = relative(root, real).split(sep).join('/');
  // A symlink to .git/config or .env inside the repo lands here.
  if (hasDotSegment(rel)) return refuse('dotfile');

  let kind: 'file' | 'dir';
  let size: number;
  try {
    const st = statSync(real);
    if (st.isFile()) kind = 'file';
    else if (st.isDirectory()) kind = 'dir';
    else return refuse('not_found');
    size = st.size;
  } catch {
    return refuse('not_found');
  }
  if (expect === 'file' && kind !== 'file') return refuse('not_file');
  if (expect === 'dir' && kind !== 'dir') return refuse('not_dir');
  if (kind === 'file' && size > maxBytes) return refuse('too_large');
  return Object.freeze({ ok: true, root, path: real, rel, kind, size });
}
