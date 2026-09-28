// In-process grep over one jailed repo tree, for repo_grep (HLD 02 §2, D11).
// There is no grep binary, so there is nothing to inject options into. The
// walk and the glob are shared with repo_find and repo_tree.
//
// Caps: files scanned, matches, bytes read per file, bytes returned, and a
// wall-clock time budget checked between files. Dot-directories, dotfiles and
// binary files are skipped. Symlinked directories are not followed; a
// symlinked file is scanned only when its realpath is inside the repo and has
// no dot segment.
//
// The pattern runs line by line in a worker thread. A JavaScript regex cannot
// be interrupted from the thread that runs it, so a catastrophic-backtracking
// pattern such as (a+)+$ would otherwise hang the process. The worker also
// checks the deadline between lines, and when a file does not come back by
// the deadline the worker is terminated and the result is marked truncated.

import { readdir, readFile, stat } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { hasDotSegment, isWithin, type JailRefused, relFromRoot, resolveInRepo } from './jail.ts';

export const GREP_LIMITS = Object.freeze({
  maxPatternChars: 200,
  maxGlobChars: 200,
  defaultMatches: 50,
  maxMatches: 200,
  maxFiles: 5000,
  /** Directory entries looked at while walking, files or not. */
  maxWalkEntries: 50_000,
  /** Files larger than this are skipped, not read. */
  maxFileBytes: 512 * 1024,
  maxLineChars: 240,
  maxOutputBytes: 64 * 1024,
  timeBudgetMs: 3000,
  /** Lines before and after each match, like grep -C. */
  maxContextLines: 5,
  /** Matches counted in one file in count mode. */
  maxCountPerFile: 10_000,
});

/** When a glob's literal leading directory is missing; shared with repo_find. */
export const MISSING_BASE_NOTE = "the glob's leading directory is not in the repo; use repo_tree to see what is there";

export type GrepLimits = { readonly [K in keyof typeof GREP_LIMITS]: number };

export type GrepMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  /** Context lines, only when contextLines > 0. Lines already shown with the match before are left out. */
  readonly before?: readonly string[];
  readonly after?: readonly string[];
};

/** 'content' returns matching lines, 'files' the unique paths with a match (grep -l), 'count' matches per file (grep -c). */
export type GrepMode = 'content' | 'files' | 'count';

export type GrepResult = {
  /** Content mode. */
  readonly matches?: readonly GrepMatch[];
  /** Files mode. */
  readonly files?: readonly string[];
  /** Count mode: files with at least one match, and the sum of their counts. */
  readonly counts?: readonly { readonly path: string; readonly count: number }[];
  readonly total?: number;
  readonly files_scanned: number;
  readonly files_skipped: { readonly binary: number; readonly too_large: number };
  readonly truncated: boolean;
  readonly notes: readonly string[];
};

export type GrepOptions = {
  readonly reposDir: string | undefined;
  readonly repo: string;
  readonly pattern: string;
  readonly glob?: string;
  /** Matches in content mode, files in files and count mode. */
  readonly maxMatches?: number;
  readonly mode?: GrepMode;
  /** Content mode only; 0 to maxContextLines. */
  readonly contextLines?: number;
  readonly signal?: AbortSignal;
  /** Overrides for tests. */
  readonly limits?: Partial<GrepLimits>;
};

export type GrepOutcome = { readonly ok: true; readonly result: GrepResult } | JailRefused | GrepRefused;

export type GrepRefused = { readonly ok: false; readonly code: 'bad_pattern' | 'bad_glob'; readonly message: string };

// ------------------------------------------------------------------ pattern and glob

/** Checks the pattern's length and syntax. It is compiled again in the worker. */
export function checkPattern(pattern: unknown, maxChars: number = GREP_LIMITS.maxPatternChars): GrepRefused | null {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, code: 'bad_pattern', message: 'pattern must be a non-empty regular expression' };
  }
  if (pattern.length > maxChars) {
    return { ok: false, code: 'bad_pattern', message: `pattern is longer than ${maxChars} characters` };
  }
  if (pattern.includes('\0')) return { ok: false, code: 'bad_pattern', message: 'pattern must not contain a NUL character' };
  try {
    new RegExp(pattern);
  } catch {
    return { ok: false, code: 'bad_pattern', message: 'pattern is not a valid JavaScript regular expression' };
  }
  return null;
}

const GLOB_CHARS = /^[A-Za-z0-9_\-./*?{},]+$/;

export type CompiledGlob = {
  readonly test: (rel: string) => boolean;
  /** Leading literal directories, so the walk can start there. '' for the repo root. */
  readonly baseDir: string;
};

/**
 * Compiles a path glob: '*' and '?' stay inside one segment, '**' spans
 * segments and '{a,b}' picks one of a few words. A glob without '/' is
 * matched against the file name, one with '/' against the path from the repo
 * root.
 */
export function compileGlob(
  glob: string,
  maxChars: number = GREP_LIMITS.maxGlobChars,
  field = 'path_glob',
): CompiledGlob | GrepRefused {
  const bad = (message: string): GrepRefused => ({ ok: false, code: 'bad_glob', message });
  if (glob.length === 0 || glob.length > maxChars) return bad(`${field} must be 1 to ${maxChars} characters`);
  if (!GLOB_CHARS.test(glob)) return bad(`${field} may use letters, digits, _ - . / * ? { } and , only`);
  if (glob.startsWith('/')) return bad(`${field} must be relative to the repo root`);
  const segments = glob.split('/');
  if (segments.some((s) => s === '..')) return bad(`${field} must not contain '..'`);
  if (segments.some((s) => s.startsWith('.'))) return bad(`${field} must not name dot-directories or dotfiles`);

  let re = '';
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      if (inBrace) return bad(`${field} braces cannot nest`);
      inBrace = true;
      re += '(?:';
    } else if (c === '}') {
      if (!inBrace) return bad(`${field} has an unmatched }`);
      inBrace = false;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else {
      re += c.replace(/[.\-]/g, (m) => `\\${m}`);
    }
  }
  if (inBrace) return bad(`${field} has an unmatched {`);
  const compiled = new RegExp(`^${re}$`);
  const byName = !glob.includes('/');

  const literal: string[] = [];
  if (!byName) {
    for (const s of segments.slice(0, -1)) {
      if (/[*?{]/.test(s)) break;
      literal.push(s);
    }
  }
  return {
    test: (rel) => compiled.test(byName ? rel.slice(rel.lastIndexOf('/') + 1) : rel),
    baseDir: literal.join('/'),
  };
}

// ------------------------------------------------------------------ worker

// Plain JavaScript, run with eval so no worker file has to be bundled.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
let cached = { source: null, re: null };
parentPort.on('message', (m) => {
  if (cached.source !== m.pattern) cached = { source: m.pattern, re: new RegExp(m.pattern) };
  const re = cached.re;
  const lines = m.text.split('\\n');
  // A trailing newline does not make an extra line of context.
  const end = lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const plain = (i) => (lines[i].endsWith('\\r') ? lines[i].slice(0, -1) : lines[i]);
  const cut = (i) => {
    const line = plain(i);
    return line.length > m.maxLineChars ? line.slice(0, m.maxLineChars) + ' [cut]' : line;
  };
  const hits = [];
  let timedOut = false;
  for (let i = 0; i < lines.length; i++) {
    if (Date.now() > m.deadline) { timedOut = true; break; }
    if (re.test(plain(i))) {
      hits.push(i);
      if (hits.length >= m.maxMatches) break;
    }
  }
  if (m.countOnly) {
    parentPort.postMessage({ id: m.id, matches: [], count: hits.length, timedOut });
    return;
  }
  // Context ranges are merged: a line shown after one match is not shown again before the next.
  const c = m.context;
  const matches = hits.map((i, k) => {
    const out = { line: i + 1, text: cut(i) };
    if (c > 0) {
      // The last line the previous match's after-context showed.
      const shown = k > 0 ? hits[k - 1] + c : -1;
      const next = k + 1 < hits.length ? hits[k + 1] : end;
      const before = [];
      for (let j = Math.max(0, i - c, shown + 1); j < i; j++) before.push(cut(j));
      const after = [];
      for (let j = i + 1; j <= Math.min(i + c, next - 1, end - 1); j++) after.push(cut(j));
      out.before = before;
      out.after = after;
    }
    return out;
  });
  parentPort.postMessage({ id: m.id, matches, count: hits.length, timedOut });
});
`;

type WorkerMatch = { line: number; text: string; before?: string[]; after?: string[] };
type WorkerReply = { id: number; matches: WorkerMatch[]; count: number; timedOut: boolean };
type RunOptions = { readonly context: number; readonly countOnly: boolean };

type Matcher = {
  run(text: string, maxMatches: number, deadline: number, opts: RunOptions, signal?: AbortSignal): Promise<WorkerReply | 'timeout'>;
  close(): Promise<void>;
};

function createMatcher(pattern: string, maxLineChars: number, now: () => number): Matcher {
  let worker: Worker | undefined;
  let seq = 0;
  const get = (): Worker => {
    if (worker === undefined) {
      worker = new Worker(WORKER_SOURCE, { eval: true });
      worker.unref();
    }
    return worker;
  };
  return {
    run(text, maxMatches, deadline, opts, signal) {
      const w = get();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const done = (): void => {
          clearTimeout(timer);
          w.off('message', onMessage);
          w.off('error', onError);
          signal?.removeEventListener('abort', onAbort);
        };
        const onMessage = (reply: WorkerReply): void => {
          if (reply.id !== id) return;
          done();
          resolve(reply);
        };
        const onError = (err: Error): void => {
          done();
          reject(err);
        };
        const onAbort = (): void => {
          done();
          reject(signal?.reason ?? new Error('aborted'));
        };
        const timer = setTimeout(() => {
          done();
          resolve('timeout');
        }, Math.max(0, deadline - now()));
        w.on('message', onMessage);
        w.on('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        w.postMessage({ id, pattern, text, maxMatches, deadline, maxLineChars, context: opts.context, countOnly: opts.countOnly });
      });
    },
    async close() {
      const w = worker;
      worker = undefined;
      if (w !== undefined) await w.terminate();
    },
  };
}

// ------------------------------------------------------------------ walk

export type WalkState = { entries: number; stoppedBy: 'entries' | 'time' | null };

/**
 * The realpath of a symlinked file when it stays in the repo, is not the
 * root and has no dot segment; null otherwise. Symlinked directories are
 * never followed.
 */
export function linkedFileInRepo(root: string, path: string): string | null {
  try {
    const real = realpathSync(path);
    if (!isWithin(root, real) || real === root) return null;
    if (hasDotSegment(relFromRoot(root, real))) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Files under startRel, depth first in name order, with dot names skipped and caps on entries and time. */
export async function* walkFiles(
  root: string,
  startRel: string,
  state: WalkState,
  maxEntries: number,
  pastDeadline: () => boolean,
  signal?: AbortSignal,
): AsyncGenerator<{ rel: string; path: string }> {
  const stack: string[] = [startRel];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    if (pastDeadline()) {
      state.stoppedBy = 'time';
      return;
    }
    const dirRel = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(join(root, dirRel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      state.entries += 1;
      if (state.entries > maxEntries) {
        state.stoppedBy = 'entries';
        return;
      }
      // Dot-directories (.git) and dotfiles (.env) are never looked into.
      if (entry.name.startsWith('.')) continue;
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      const path = join(root, rel);
      if (entry.isDirectory()) {
        subdirs.push(rel);
      } else if (entry.isFile()) {
        yield { rel, path };
      } else if (entry.isSymbolicLink()) {
        // Files only, and only when the target stays in the repo.
        const real = linkedFileInRepo(root, path);
        if (real !== null) yield { rel, path: real };
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i] as string);
  }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// ------------------------------------------------------------------ grep

function byMode(mode: GrepMode, matches: GrepMatch[], files: string[], counts: { path: string; count: number }[], total: number) {
  return mode === 'content' ? { matches } : mode === 'files' ? { files } : { counts, total };
}

/** Greps one repo. Refusals come back as values; only an aborted signal throws. */
export async function grepRepo(opts: GrepOptions): Promise<GrepOutcome> {
  const limits: GrepLimits = { ...GREP_LIMITS, ...opts.limits };
  // Wall clock on purpose: the worker checks the same deadline with Date.now().
  const now = Date.now;
  const signal = opts.signal;

  const badPattern = checkPattern(opts.pattern, limits.maxPatternChars);
  if (badPattern !== null) return badPattern;
  let glob: CompiledGlob | undefined;
  if (opts.glob !== undefined) {
    const g = compileGlob(opts.glob, limits.maxGlobChars);
    if ('ok' in g) return g;
    glob = g;
  }
  const mode: GrepMode = opts.mode ?? 'content';
  const start = resolveInRepo(opts.reposDir, opts.repo, glob?.baseDir ?? '', { expect: 'dir' });
  if (!start.ok) {
    // A glob whose literal directory is missing simply matches nothing.
    if (start.code === 'not_found' || start.code === 'not_dir') {
      return {
        ok: true,
        result: {
          ...byMode(mode, [], [], [], 0),
          files_scanned: 0,
          files_skipped: { binary: 0, too_large: 0 },
          truncated: false,
          notes: [MISSING_BASE_NOTE],
        },
      };
    }
    return start;
  }

  const context = mode === 'content' ? Math.max(0, Math.min(opts.contextLines ?? 0, limits.maxContextLines)) : 0;
  const maxMatches = Math.max(1, Math.min(opts.maxMatches ?? limits.defaultMatches, limits.maxMatches));
  const deadline = now() + limits.timeBudgetMs;
  const pastDeadline = (): boolean => now() > deadline;
  const matches: GrepMatch[] = [];
  const files: string[] = [];
  const counts: { path: string; count: number }[] = [];
  let total = 0;
  let countCapped = 0;
  // What max_matches caps: matches in content mode, files in the other two.
  const listed: readonly unknown[] = mode === 'content' ? matches : mode === 'files' ? files : counts;
  const notes: string[] = [];
  const skipped = { binary: 0, too_large: 0 };
  let filesScanned = 0;
  let outBytes = 0;
  let stop: 'matches' | 'files' | 'bytes' | 'time' | null = null;
  const walk: WalkState = { entries: 0, stoppedBy: null };
  const matcher = createMatcher(opts.pattern, limits.maxLineChars, now);

  try {
    for await (const file of walkFiles(start.root, start.rel, walk, limits.maxWalkEntries, pastDeadline, signal)) {
      signal?.throwIfAborted();
      if (pastDeadline()) {
        stop = 'time';
        break;
      }
      if (glob !== undefined && !glob.test(file.rel)) continue;
      if (filesScanned >= limits.maxFiles) {
        stop = 'files';
        break;
      }
      let size: number;
      try {
        size = (await stat(file.path)).size;
      } catch {
        continue;
      }
      if (size > limits.maxFileBytes) {
        skipped.too_large += 1;
        continue;
      }
      let buf: Buffer;
      try {
        buf = await readFile(file.path, signal !== undefined ? { signal } : {});
      } catch {
        signal?.throwIfAborted();
        continue;
      }
      if (looksBinary(buf)) {
        skipped.binary += 1;
        continue;
      }
      filesScanned += 1;
      const perFile = mode === 'content' ? maxMatches - matches.length : mode === 'files' ? 1 : limits.maxCountPerFile;
      const reply = await matcher.run(buf.toString('utf8'), perFile, deadline, { context, countOnly: mode !== 'content' }, signal);
      if (reply === 'timeout') {
        stop = 'time';
        break;
      }
      if (mode === 'content') {
        for (const m of reply.matches) {
          const cost = [m.text, ...(m.before ?? []), ...(m.after ?? [])].reduce((n, t) => n + t.length + 4, file.rel.length + 16);
          if (outBytes + cost > limits.maxOutputBytes) {
            stop = 'bytes';
            break;
          }
          outBytes += cost;
          matches.push({ path: file.rel, ...m });
        }
      } else if (reply.count > 0) {
        const cost = file.rel.length + 16;
        if (outBytes + cost > limits.maxOutputBytes) {
          stop = 'bytes';
          break;
        }
        outBytes += cost;
        if (mode === 'files') files.push(file.rel);
        else {
          counts.push({ path: file.rel, count: reply.count });
          total += reply.count;
          if (reply.count >= limits.maxCountPerFile) countCapped += 1;
        }
      }
      if (stop !== null) break;
      if (reply.timedOut) {
        stop = 'time';
        break;
      }
      if (listed.length >= maxMatches) {
        stop = 'matches';
        break;
      }
    }
  } finally {
    await matcher.close();
  }

  if (stop === null && walk.stoppedBy !== null) stop = walk.stoppedBy === 'time' ? 'time' : 'files';
  switch (stop) {
    case 'time':
      notes.push(
        `stopped at the ${limits.timeBudgetMs} ms time budget after ${filesScanned} files; ` +
          'narrow path_glob or simplify the pattern (nested quantifiers such as (a+)+ are slow)',
      );
      break;
    case 'matches':
      notes.push(`stopped at ${maxMatches} ${mode === 'content' ? 'matches' : 'files'}; narrow the pattern or path_glob to see the rest`);
      break;
    case 'files':
      notes.push(`stopped after ${filesScanned} files; narrow path_glob`);
      break;
    case 'bytes':
      notes.push(`stopped at the ${limits.maxOutputBytes} byte output cap; narrow the pattern or path_glob`);
      break;
    default:
      break;
  }
  if (skipped.too_large > 0) notes.push(`${skipped.too_large} files over ${limits.maxFileBytes} bytes were skipped`);
  if (countCapped > 0) notes.push(`${countCapped} files hit the ${limits.maxCountPerFile} per-file count cap; their counts are a floor`);

  return {
    ok: true,
    result: {
      ...byMode(mode, matches, files, counts, total),
      files_scanned: filesScanned,
      files_skipped: skipped,
      truncated: stop !== null,
      notes,
    },
  };
}
