// In-process grep over one jailed repo tree, for repo_grep (HLD 02 §2, D11).
// There is no grep binary, so there is nothing to inject options into.
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
});

export type GrepLimits = { readonly [K in keyof typeof GREP_LIMITS]: number };

export type GrepMatch = { readonly path: string; readonly line: number; readonly text: string };

export type GrepResult = {
  readonly matches: readonly GrepMatch[];
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
  readonly maxMatches?: number;
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
export function compileGlob(glob: string, maxChars: number = GREP_LIMITS.maxGlobChars): CompiledGlob | GrepRefused {
  const bad = (message: string): GrepRefused => ({ ok: false, code: 'bad_glob', message });
  if (glob.length === 0 || glob.length > maxChars) return bad(`path_glob must be 1 to ${maxChars} characters`);
  if (!GLOB_CHARS.test(glob)) return bad('path_glob may use letters, digits, _ - . / * ? { } and , only');
  if (glob.startsWith('/')) return bad('path_glob must be relative to the repo root');
  const segments = glob.split('/');
  if (segments.some((s) => s === '..')) return bad("path_glob must not contain '..'");
  if (segments.some((s) => s.startsWith('.'))) return bad('path_glob must not name dot-directories or dotfiles');

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
      if (inBrace) return bad('path_glob braces cannot nest');
      inBrace = true;
      re += '(?:';
    } else if (c === '}') {
      if (!inBrace) return bad('path_glob has an unmatched }');
      inBrace = false;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else {
      re += c.replace(/[.\-]/g, (m) => `\\${m}`);
    }
  }
  if (inBrace) return bad('path_glob has an unmatched {');
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
  const matches = [];
  let timedOut = false;
  for (let i = 0; i < lines.length; i++) {
    if (Date.now() > m.deadline) { timedOut = true; break; }
    let line = lines[i];
    if (line.endsWith('\\r')) line = line.slice(0, -1);
    if (re.test(line)) {
      matches.push({ line: i + 1, text: line.length > m.maxLineChars ? line.slice(0, m.maxLineChars) + ' [cut]' : line });
      if (matches.length >= m.maxMatches) break;
    }
  }
  parentPort.postMessage({ id: m.id, matches, timedOut });
});
`;

type WorkerReply = { id: number; matches: { line: number; text: string }[]; timedOut: boolean };

type Matcher = {
  run(text: string, maxMatches: number, deadline: number, signal?: AbortSignal): Promise<WorkerReply | 'timeout'>;
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
    run(text, maxMatches, deadline, signal) {
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
        w.postMessage({ id, pattern, text, maxMatches, deadline, maxLineChars });
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

type WalkState = { entries: number; stoppedBy: 'entries' | 'time' | null };

async function* walkFiles(
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
        try {
          const real = realpathSync(path);
          if (!isWithin(root, real) || real === root) continue;
          if (hasDotSegment(relFromRoot(root, real))) continue;
          if (!statSync(real).isFile()) continue;
          yield { rel, path: real };
        } catch {
          continue;
        }
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
  const start = resolveInRepo(opts.reposDir, opts.repo, glob?.baseDir ?? '', { expect: 'dir' });
  if (!start.ok) {
    // A glob whose literal directory is missing simply matches nothing.
    if (start.code === 'not_found' || start.code === 'not_dir') {
      return { ok: true, result: { matches: [], files_scanned: 0, files_skipped: { binary: 0, too_large: 0 }, truncated: false, notes: [] } };
    }
    return start;
  }

  const maxMatches = Math.max(1, Math.min(opts.maxMatches ?? limits.defaultMatches, limits.maxMatches));
  const deadline = now() + limits.timeBudgetMs;
  const pastDeadline = (): boolean => now() > deadline;
  const matches: GrepMatch[] = [];
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
      const reply = await matcher.run(buf.toString('utf8'), maxMatches - matches.length, deadline, signal);
      if (reply === 'timeout') {
        stop = 'time';
        break;
      }
      for (const m of reply.matches) {
        const cost = m.text.length + file.rel.length + 16;
        if (outBytes + cost > limits.maxOutputBytes) {
          stop = 'bytes';
          break;
        }
        outBytes += cost;
        matches.push({ path: file.rel, line: m.line, text: m.text });
      }
      if (stop !== null) break;
      if (reply.timedOut) {
        stop = 'time';
        break;
      }
      if (matches.length >= maxMatches) {
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
      notes.push(`stopped at ${maxMatches} matches; narrow the pattern or path_glob to see the rest`);
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

  return {
    ok: true,
    result: {
      matches,
      files_scanned: filesScanned,
      files_skipped: skipped,
      truncated: stop !== null,
      notes,
    },
  };
}
