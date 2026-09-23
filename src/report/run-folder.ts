// Run folder layout and the small file helpers every run writer shares.
//
// This is the one place that says where a run's files live:
//   <TRIAGE_RUNS_DIR>/<run_id>/input.json, classification.json,
//   evidence/<entity|code>.json, report.json, report.md, feedback.jsonl,
//   feedback.md, audit.jsonl (the audit mirror), meta.json, embeddings.json
// and where eval drafts go: <TRIAGE_HOME>/evals/_unreviewed/<run_id>/.
//
// No business logic lives here. The module reads no env var: runsDir and home
// are passed in by the caller from config. A run_id is checked to be a ULID
// before any path is built, so it can never point outside the runs dir.

import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ENTITIES, type Entity, type RunId } from '../types/core.ts';

export class RunFolderError extends Error {
  override readonly name = 'RunFolderError';
}

// ------------------------------------------------------------------ run ids

// Crockford base32, 26 chars, uppercase only. The first char is 0-7 because
// the 48-bit timestamp tops out there. Lowercase is refused so one run cannot
// have two folder names (macOS and Windows file systems ignore case).
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isRunId(runId: unknown): runId is RunId {
  return typeof runId === 'string' && ULID_PATTERN.test(runId);
}

/** Throws unless runId is a canonical ULID. The value is not echoed back. */
export function assertRunId(runId: unknown): asserts runId is RunId {
  if (typeof runId !== 'string') throw new RunFolderError('run_id must be a string');
  if (!ULID_PATTERN.test(runId)) {
    throw new RunFolderError(`run_id must be a 26-char uppercase ULID (got ${runId.length} chars)`);
  }
}

// ------------------------------------------------------------------- paths

export type EvidenceKey = Entity | 'code';
const EVIDENCE_KEYS: ReadonlySet<string> = new Set<string>([...ENTITIES, 'code']);

export type RunPaths = {
  readonly runId: RunId;
  readonly dir: string;
  readonly input: string;
  readonly classification: string;
  readonly evidenceDir: string;
  readonly evidence: (key: EvidenceKey) => string;
  readonly report: string;
  readonly reportMd: string;
  readonly feedbackJsonl: string;
  readonly feedbackMd: string;
  readonly audit: string;
  readonly meta: string;
  readonly embeddings: string;
};

function requireAbsolute(what: string, path: string): string {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new RunFolderError(`${what} must be an absolute path`);
  }
  return resolve(path);
}

// Joins the run id under root and checks the result is a direct child.
function childDir(root: string, runId: RunId): string {
  const dir = join(root, runId);
  if (dirname(dir) !== root || basename(dir) !== runId) {
    throw new RunFolderError('run_id does not resolve to a direct child of its root');
  }
  return dir;
}

/** Every file of one run, under <runsDir>/<runId>/. runsDir comes from config.paths.runsDir. */
export function runPaths(runsDir: string, runId: string): RunPaths {
  assertRunId(runId);
  const dir = childDir(requireAbsolute('runsDir', runsDir), runId);
  const evidenceDir = join(dir, 'evidence');
  return Object.freeze({
    runId,
    dir,
    input: join(dir, 'input.json'),
    classification: join(dir, 'classification.json'),
    evidenceDir,
    evidence: (key: EvidenceKey): string => {
      if (typeof key !== 'string' || !EVIDENCE_KEYS.has(key)) {
        throw new RunFolderError(`evidence key must be one of ${[...EVIDENCE_KEYS].join(', ')}`);
      }
      return join(evidenceDir, `${key}.json`);
    },
    report: join(dir, 'report.json'),
    reportMd: join(dir, 'report.md'),
    feedbackJsonl: join(dir, 'feedback.jsonl'),
    feedbackMd: join(dir, 'feedback.md'),
    audit: join(dir, 'audit.jsonl'),
    meta: join(dir, 'meta.json'),
    embeddings: join(dir, 'embeddings.json'),
  });
}

/** Where eval drafts for a run go: <home>/evals/_unreviewed/<runId>/. home is config.home. */
export function evalDraftDir(home: string, runId: string): string {
  assertRunId(runId);
  const root = join(requireAbsolute('home', home), 'evals', '_unreviewed');
  return childDir(root, runId);
}

// ------------------------------------------------------------- file writes

// The file operations writeFileAtomic needs. The default is node:fs/promises;
// tests pass a wrapper to simulate failures.
export type AtomicHandle = {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export type AtomicFs = {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: string, mode: number): Promise<AtomicHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
};

const nodeFs: AtomicFs = {
  mkdir: (path, options) => fsp.mkdir(path, options),
  open: (path, flags, mode) => fsp.open(path, flags, mode),
  rename: (from, to) => fsp.rename(from, to),
  rm: (path, options) => fsp.rm(path, options),
};

// Run files hold redacted case data; keep them to the owner.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Writes text to path so a reader sees either the old file or the new one,
 * never a partial write: temp file in the same dir, fsync, then rename.
 * On any failure the temp file is removed and the old target is untouched.
 */
export async function writeFileAtomic(path: string, text: string, fs: AtomicFs = nodeFs): Promise<void> {
  const target = requireAbsolute('path', path);
  if (typeof text !== 'string') throw new RunFolderError('text must be a string');
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    const handle = await fs.open(tmp, 'wx', FILE_MODE);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  if (fs === nodeFs) await syncDir(dir);
}

// Makes the rename itself durable. Some platforms cannot fsync a directory;
// the file content is already synced, so a failure here is ignored.
async function syncDir(dir: string): Promise<void> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    // ignored, see above
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Appends obj as one JSON line with a trailing newline. Creates the parent dir. */
export async function appendJsonl(path: string, obj: unknown): Promise<void> {
  const target = requireAbsolute('path', path);
  const line = JSON.stringify(obj);
  if (typeof line !== 'string') throw new RunFolderError('value is not JSON-serialisable');
  // JSON.stringify escapes newlines inside strings, so this cannot happen;
  // the check keeps the one-line-per-call rule explicit.
  if (line.includes('\n')) throw new RunFolderError('JSON line contains a newline');
  await fsp.mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
  // One write with O_APPEND, so lines from concurrent writers do not interleave.
  await fsp.appendFile(target, `${line}\n`, { encoding: 'utf8', mode: FILE_MODE });
}
