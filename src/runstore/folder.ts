// The folder RunStore provider (D43), used with TRIAGE_DB_PROVIDER=sqlite.
//
// Layout under TRIAGE_RUNS_DIR/<run_id>/ (HLD 02 §7, 03 data objects):
//   meta.json                      {schema_version, run_id, created_at, updated_at, phase, ...}
//                                  plus the open question and block and their histories
//   input.json                     the persisted-profile TriageRequest
//   classification.json            {decision, id_chain, preflight_warnings?}
//   evidence/<entity|code>.json    latest findings, as written
//   evidence/<key>.v<n>.json       every version, so older ones are kept
//   submissions/<seq>/submission.json, report.json, report.md
//   report.json, report.md         the latest submission's report
//   feedback.jsonl                 one entry per line, append-only
//   feedback.md                    the caller's rendering, or a short default
//   embeddings.json                EmbeddingRow[]
// Idempotency claims live in TRIAGE_DATA_DIR/idempotency/<sha256(key)>.json
// and hold {run_id, expires_at}, never the key itself.
//
// Every file is written through atomic.ts, so a reader never sees a partial
// file. Read-modify-write steps are serialised per run inside the process.
// Evidence versions and submission numbers are allocated with exclusive
// creates, so a second process on the same run cannot take the same number.
// A deleted run is renamed out of the way before it is removed, so a reader
// never sees half a run.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import type { Persisted } from '../gate/redact.ts';
import type { RunId } from '../types/core.ts';
import type { Report } from '../types/report.ts';
import type { TriageRequest } from '../types/request.ts';
import { createExclusive, hasCode, isTempFile, writeFileAtomic } from './atomic.ts';
import {
  EMBEDDING_KINDS,
  EVIDENCE_KEYS,
  EmbeddingInputSchema,
  EmbeddingRowSchema,
  FeedbackSchema,
  RUNSTORE_SCHEMA_VERSION,
  RunMetaSchema,
  RunPhaseSchema,
  RunStoreError,
  RunNotFoundError,
  RunStoppedError,
  SubmissionInputSchema,
  SubmissionMetaSchema,
  assertClean,
  assertEvidenceKey,
  assertPersisted,
  assertRunId,
  cosine,
  isTerminalPhase,
  type ClassificationRecord,
  type EmbeddingInput,
  type EmbeddingMeta,
  type EmbeddingRow,
  type EvidenceKey,
  type EvidenceRecord,
  type Feedback,
  type Findings,
  type PhaseDetail,
  type RunMeta,
  type RunPhase,
  type RunQuery,
  type RunRecord,
  type RunStore,
  type RunSummary,
  type SimilarHit,
  type SimilarQuery,
  type Submission,
  type SubmissionInput,
  type SubmissionMeta,
} from './types.ts';
import {
  assertBlockId,
  assertQuestionId,
  BlockNotOpenError,
  BlockOpenError,
  cancelledBlockResolution,
  InputRequestNotOpenError,
  InputRequestOpenError,
} from './types.ts';
import {
  InputRequestSchema,
  InputResolutionSchema,
  type InputRequest,
  type InputResolution,
} from '../types/input-request.ts';
import { BlockRecordSchema, BlockResolutionSchema, type BlockRecord, type BlockResolution } from '../types/block.ts';

export type FolderRunStoreOptions = {
  /** TRIAGE_RUNS_DIR, absolute. */
  readonly runsDir: string;
  /** TRIAGE_DATA_DIR, absolute. Idempotency claims go under idempotency/. */
  readonly dataDir: string;
  /** Epoch milliseconds. Tests pass a fake clock. */
  readonly now?: () => number;
};

const DEFAULT_SIMILAR_LIMIT = 10;
const MAX_IDEMPOTENCY_KEY_LENGTH = 1024;
// A replace lock older than this is treated as left behind by a crashed process.
const STALE_LOCK_MS = 30_000;
const CLAIM_ATTEMPTS = 200;

// ------------------------------------------------------------------ small helpers

const locks = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier call with the same key has finished. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR')) return undefined;
    throw err;
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RunStoreError(`corrupt ${label} in the run store`);
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((name) => !isTempFile(name));
  } catch (err) {
    if (hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR')) return [];
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (hasCode(err, 'ENOENT') || hasCode(err, 'ENOTDIR')) return false;
    throw err;
  }
}

/** Validates a store record. The error names the failing paths, never the values. */
function parseRecord<S extends v.GenericSchema>(schema: S, value: unknown, label: string): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  const paths = [...new Set(result.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
  throw new RunStoreError(`invalid ${label}: ${paths.join(', ')}`);
}

function positiveInt(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RunStoreError(`invalid ${label}`);
  return n;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const IdempotencyClaimSchema = v.object({
  run_id: v.string(),
  expires_at: v.number(),
});
type IdempotencyClaim = v.InferOutput<typeof IdempotencyClaimSchema>;

const VERSION_FILE = /^(.+)\.v(\d+)\.json$/;

// ------------------------------------------------------------------ provider

class FolderRunStore implements RunStore {
  readonly provider = 'folder' as const;
  readonly #runsDir: string;
  readonly #idemDir: string;
  readonly #now: () => number;

  constructor(opts: FolderRunStoreOptions) {
    this.#runsDir = opts.runsDir;
    this.#idemDir = join(opts.dataDir, 'idempotency');
    this.#now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------- paths

  #dir(runId: string): string {
    return join(this.#runsDir, assertRunId(runId));
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #lock(runId: string, part = ''): string {
    return `${this.#dir(runId)}#${part}`;
  }

  async #meta(runId: string): Promise<RunMeta | undefined> {
    const raw = await readJson(join(this.#dir(runId), 'meta.json'), 'meta.json');
    if (raw === undefined) return undefined;
    return parseRecord(RunMetaSchema, raw, 'meta.json');
  }

  async #requireRun(runId: string): Promise<RunMeta> {
    const meta = await this.#meta(runId);
    if (!meta) throw new RunNotFoundError(runId);
    return meta;
  }

  // ---------------------------------------------------------------- runs

  async createRun(runId: RunId, request: Persisted<TriageRequest>): Promise<void> {
    const dir = this.#dir(runId);
    const value = assertPersisted(request, 'request');
    await serial(this.#lock(runId), async () => {
      if (await exists(join(dir, 'meta.json'))) return;
      await mkdir(dir, { recursive: true });
      // The first input wins, like the meta file; a repeat call changes nothing.
      await createExclusive(join(dir, 'input.json'), json(value));
      const now = this.#iso();
      const meta: RunMeta = {
        schema_version: RUNSTORE_SCHEMA_VERSION,
        run_id: runId,
        created_at: now,
        updated_at: now,
        phase: 'created',
      };
      await createExclusive(join(dir, 'meta.json'), json(meta));
    });
  }

  async setPhase(runId: RunId, phase: RunPhase, detail: PhaseDetail = {}): Promise<boolean> {
    parseRecord(RunPhaseSchema, phase, 'phase');
    if (detail.reason !== undefined) assertClean(detail.reason, 'phase reason');
    if (detail.worker_pid !== undefined) positiveInt(detail.worker_pid, 'worker pid');
    return serial(this.#lock(runId), async () => {
      const meta = await this.#requireRun(runId);
      // The lock is per process; a second process can still race this read.
      if (meta.phase === 'stopped' && detail.resume !== true) return false;
      const next: RunMeta = {
        schema_version: meta.schema_version,
        run_id: meta.run_id,
        created_at: meta.created_at,
        updated_at: this.#iso(),
        phase,
        ...(detail.reason !== undefined ? { phase_reason: detail.reason } : {}),
        ...((detail.worker_pid ?? meta.worker_pid) !== undefined ? { worker_pid: detail.worker_pid ?? meta.worker_pid } : {}),
        ...inputFields(meta),
        ...blockFields(meta),
      };
      await writeFileAtomic(join(this.#dir(runId), 'meta.json'), json(next));
      return true;
    });
  }

  async putInputRequest(runId: RunId, request: Persisted<InputRequest>): Promise<void> {
    const value = parseRecord(InputRequestSchema, assertPersisted(request, 'input request'), 'input request');
    await serial(this.#lock(runId), async () => {
      const meta = await this.#requireRun(runId);
      if (meta.phase === 'stopped') throw new RunStoppedError(runId);
      if (meta.input_request !== undefined) throw new InputRequestOpenError(runId, meta.input_request.question_id);
      const next: RunMeta = {
        schema_version: meta.schema_version,
        run_id: meta.run_id,
        created_at: meta.created_at,
        updated_at: this.#iso(),
        phase: 'needs_input',
        ...(meta.worker_pid !== undefined ? { worker_pid: meta.worker_pid } : {}),
        input_request: value,
        ...(meta.input_history !== undefined ? { input_history: meta.input_history } : {}),
        ...blockFields(meta),
      };
      await writeFileAtomic(join(this.#dir(runId), 'meta.json'), json(next));
    });
  }

  async resolveInputRequest(runId: RunId, questionId: string, resolution: Persisted<InputResolution>): Promise<void> {
    assertQuestionId(questionId);
    const value = parseRecord(InputResolutionSchema, assertPersisted(resolution, 'input resolution'), 'input resolution');
    await serial(this.#lock(runId), async () => {
      const meta = await this.#requireRun(runId);
      const open = meta.input_request;
      if (open === undefined || open.question_id !== questionId) throw new InputRequestNotOpenError(runId, questionId);
      const next: RunMeta = {
        schema_version: meta.schema_version,
        run_id: meta.run_id,
        created_at: meta.created_at,
        updated_at: this.#iso(),
        phase: meta.phase,
        ...(meta.phase_reason !== undefined ? { phase_reason: meta.phase_reason } : {}),
        ...(meta.worker_pid !== undefined ? { worker_pid: meta.worker_pid } : {}),
        input_history: [...(meta.input_history ?? []), { ...open, ...value }],
        ...blockFields(meta),
      };
      await writeFileAtomic(join(this.#dir(runId), 'meta.json'), json(next));
    });
  }

  async putBlock(runId: RunId, block: Persisted<BlockRecord>): Promise<void> {
    const value = parseRecord(BlockRecordSchema, assertPersisted(block, 'block'), 'block');
    await serial(this.#lock(runId), async () => {
      const meta = await this.#requireRun(runId);
      if (meta.phase === 'stopped') throw new RunStoppedError(runId);
      if (meta.block !== undefined) throw new BlockOpenError(runId, meta.block.block_id);
      if (meta.input_request !== undefined) throw new InputRequestOpenError(runId, meta.input_request.question_id);
      const next: RunMeta = {
        schema_version: meta.schema_version,
        run_id: meta.run_id,
        created_at: meta.created_at,
        updated_at: this.#iso(),
        phase: 'blocked',
        ...(meta.worker_pid !== undefined ? { worker_pid: meta.worker_pid } : {}),
        ...inputFields(meta),
        block: value,
        ...(meta.block_history !== undefined ? { block_history: meta.block_history } : {}),
      };
      await writeFileAtomic(join(this.#dir(runId), 'meta.json'), json(next));
    });
  }

  async resolveBlock(runId: RunId, blockId: string, resolution: Persisted<BlockResolution>): Promise<void> {
    assertBlockId(blockId);
    const value = parseRecord(BlockResolutionSchema, assertPersisted(resolution, 'block resolution'), 'block resolution');
    await serial(this.#lock(runId), async () => {
      const meta = await this.#requireRun(runId);
      const open = meta.block;
      if (open === undefined || open.block_id !== blockId) throw new BlockNotOpenError(runId, blockId);
      const next: RunMeta = {
        schema_version: meta.schema_version,
        run_id: meta.run_id,
        created_at: meta.created_at,
        updated_at: this.#iso(),
        phase: meta.phase,
        ...(meta.phase_reason !== undefined ? { phase_reason: meta.phase_reason } : {}),
        ...(meta.worker_pid !== undefined ? { worker_pid: meta.worker_pid } : {}),
        ...inputFields(meta),
        block_history: [...(meta.block_history ?? []), { ...open, ...value }],
      };
      await writeFileAtomic(join(this.#dir(runId), 'meta.json'), json(next));
    });
  }

  async markStopped(runId: RunId, reason: string, resolution: Persisted<InputResolution>): Promise<RunPhase | null> {
    assertClean(reason, 'phase reason');
    const value = parseRecord(InputResolutionSchema, assertPersisted(resolution, 'input resolution'), 'input resolution');
    return serial(this.#lock(runId), async () => {
      const meta = await this.#requireRun(runId);
      if (isTerminalPhase(meta.phase)) return null;
      const open = meta.input_request;
      const history = open !== undefined ? [...(meta.input_history ?? []), { ...open, ...value }] : meta.input_history;
      // An open block is closed as cancelled by the same person at the same time.
      const block = meta.block;
      const blocks =
        block !== undefined ? [...(meta.block_history ?? []), { ...block, ...cancelledBlockResolution(value) }] : meta.block_history;
      const next: RunMeta = {
        schema_version: meta.schema_version,
        run_id: meta.run_id,
        created_at: meta.created_at,
        updated_at: this.#iso(),
        phase: 'stopped',
        phase_reason: reason,
        ...(meta.worker_pid !== undefined ? { worker_pid: meta.worker_pid } : {}),
        ...(history !== undefined ? { input_history: history } : {}),
        ...(blocks !== undefined ? { block_history: blocks } : {}),
      };
      await writeFileAtomic(join(this.#dir(runId), 'meta.json'), json(next));
      return meta.phase;
    });
  }

  async putClassification(runId: RunId, record: Persisted<ClassificationRecord>): Promise<void> {
    const value = assertPersisted(record, 'classification');
    await serial(this.#lock(runId), async () => {
      await this.#requireRun(runId);
      await writeFileAtomic(join(this.#dir(runId), 'classification.json'), json(value));
    });
  }

  // ---------------------------------------------------------------- submissions and reports

  async addSubmission(runId: RunId, submission: Persisted<SubmissionInput>): Promise<number> {
    const input = parseRecord(SubmissionInputSchema, assertPersisted(submission, 'submission'), 'submission');
    return serial(this.#lock(runId), async () => {
      await this.#requireRun(runId);
      const base = join(this.#dir(runId), 'submissions');
      await mkdir(base, { recursive: true });
      let seq = (await this.#seqs(runId)).reduce((a, b) => Math.max(a, b), 0) + 1;
      for (;;) {
        try {
          await mkdir(join(base, String(seq)));
          break;
        } catch (err) {
          if (!hasCode(err, 'EEXIST')) throw err;
          seq++;
        }
      }
      const meta: SubmissionMeta = { ...input, seq, created_at: this.#iso() };
      await writeFileAtomic(join(base, String(seq), 'submission.json'), json(meta));
      return seq;
    });
  }

  async #seqs(runId: string): Promise<number[]> {
    const names = await listDir(join(this.#dir(runId), 'submissions'));
    return names
      .filter((n) => /^[1-9][0-9]*$/.test(n))
      .map(Number)
      .sort((a, b) => a - b);
  }

  async putReport(runId: RunId, submissionId: number, report: Persisted<Report>, md: Persisted<string>): Promise<void> {
    const seq = positiveInt(submissionId, 'submission id');
    const reportValue = assertPersisted(report, 'report');
    const mdValue = assertPersisted(md, 'report markdown');
    if (typeof mdValue !== 'string') throw new RunStoreError('report markdown must be a string');
    await serial(this.#lock(runId), async () => {
      await this.#requireRun(runId);
      const dir = this.#dir(runId);
      const subDir = join(dir, 'submissions', String(seq));
      if (!(await exists(join(subDir, 'submission.json')))) throw new RunStoreError(`submission ${seq} not found`);
      await writeFileAtomic(join(subDir, 'report.md'), mdValue);
      await writeFileAtomic(join(subDir, 'report.json'), json(reportValue));
      // The root copy follows the newest submission that has a report.
      let latest = 0;
      for (const s of await this.#seqs(runId)) {
        if (await exists(join(dir, 'submissions', String(s), 'report.json'))) latest = Math.max(latest, s);
      }
      if (seq >= latest) {
        await writeFileAtomic(join(dir, 'report.md'), mdValue);
        await writeFileAtomic(join(dir, 'report.json'), json(reportValue));
      }
    });
  }

  // ---------------------------------------------------------------- evidence

  async putEvidence(runId: RunId, key: EvidenceKey, findings: Persisted<Findings>): Promise<number> {
    const k = assertEvidenceKey(key);
    const value = assertPersisted(findings, `evidence ${k}`);
    return serial(this.#lock(runId, `evidence:${k}`), async () => {
      await this.#requireRun(runId);
      const dir = join(this.#dir(runId), 'evidence');
      await mkdir(dir, { recursive: true });
      const body = json(value);
      let version = (await this.#versions(dir, k)) + 1;
      while (!(await createExclusive(join(dir, `${k}.v${version}.json`), body))) version++;
      await writeFileAtomic(join(dir, `${k}.json`), body);
      // Another process may have written a newer version meanwhile; the
      // latest file must follow the highest version.
      const newest = await this.#versions(dir, k);
      if (newest > version) {
        const text = await readText(join(dir, `${k}.v${newest}.json`));
        if (text !== undefined) await writeFileAtomic(join(dir, `${k}.json`), text);
      }
      return version;
    });
  }

  async #versions(dir: string, key: string): Promise<number> {
    let max = 0;
    for (const name of await listDir(dir)) {
      const m = VERSION_FILE.exec(name);
      if (m && m[1] === key) max = Math.max(max, Number(m[2]));
    }
    return max;
  }

  async #evidence(runId: string): Promise<Partial<Record<EvidenceKey, EvidenceRecord>>> {
    const dir = join(this.#dir(runId), 'evidence');
    const out: Partial<Record<EvidenceKey, EvidenceRecord>> = {};
    for (const key of EVIDENCE_KEYS) {
      const raw = await readJson(join(dir, `${key}.json`), `evidence ${key}`);
      if (raw === undefined) continue;
      const version = Math.max(1, await this.#versions(dir, key));
      out[key] = { key, version, findings: raw as Findings };
    }
    return out;
  }

  // ---------------------------------------------------------------- feedback

  async putFeedback(runId: RunId, feedback: Persisted<Feedback>, md?: Persisted<string>): Promise<void> {
    const entry = parseRecord(FeedbackSchema, assertPersisted(feedback, 'feedback'), 'feedback');
    const mdValue = md === undefined ? undefined : assertPersisted(md, 'feedback markdown');
    if (mdValue !== undefined && typeof mdValue !== 'string') throw new RunStoreError('feedback markdown must be a string');
    await serial(this.#lock(runId), async () => {
      await this.#requireRun(runId);
      const dir = this.#dir(runId);
      const before = (await readText(join(dir, 'feedback.jsonl'))) ?? '';
      const lines = `${before}${JSON.stringify(entry)}\n`;
      await writeFileAtomic(join(dir, 'feedback.jsonl'), lines);
      const all = parseFeedbackLines(lines);
      await writeFileAtomic(join(dir, 'feedback.md'), mdValue ?? renderFeedback(all));
    });
  }

  async #feedback(runId: string): Promise<Feedback[]> {
    const text = await readText(join(this.#dir(runId), 'feedback.jsonl'));
    return text === undefined ? [] : parseFeedbackLines(text);
  }

  // ---------------------------------------------------------------- embeddings

  async putEmbedding(runId: RunId, row: Persisted<EmbeddingInput>): Promise<void> {
    const input = parseRecord(EmbeddingInputSchema, assertPersisted(row, 'embedding'), 'embedding');
    await serial(this.#lock(runId), async () => {
      await this.#requireRun(runId);
      const rows = await this.#embeddings(runId);
      const next: EmbeddingRow = { run_id: runId, ...input };
      const kept = rows.filter(
        (r) => !(r.kind === next.kind && r.model === next.model && r.submission_id === next.submission_id),
      );
      await writeFileAtomic(join(this.#dir(runId), 'embeddings.json'), json([...kept, next]));
    });
  }

  async #embeddings(runId: string): Promise<EmbeddingRow[]> {
    const raw = await readJson(join(this.#dir(runId), 'embeddings.json'), 'embeddings.json');
    if (raw === undefined) return [];
    return parseRecord(v.array(EmbeddingRowSchema), raw, 'embeddings.json');
  }

  async findSimilar(query: SimilarQuery): Promise<SimilarHit[]> {
    const vector = parseRecord(EmbeddingInputSchema.entries.vector, query.vector, 'query vector');
    const kinds = new Set(query.kinds ?? EMBEDDING_KINDS);
    const exclude = query.excludeRunId === undefined ? undefined : assertRunId(query.excludeRunId);
    const limit = Math.max(0, Math.floor(query.limit ?? DEFAULT_SIMILAR_LIMIT));
    const hits: SimilarHit[] = [];
    for (const runId of await this.#runIds()) {
      if (runId === exclude) continue;
      for (const row of await this.#embeddings(runId)) {
        if (row.model !== query.model || !kinds.has(row.kind)) continue;
        // Rows of another dimension belong to a different model build; skip them.
        const similarity = cosine(vector, row.vector);
        if (similarity === null) continue;
        hits.push({
          run_id: runId,
          ...(row.submission_id !== undefined ? { submission_id: row.submission_id } : {}),
          kind: row.kind,
          model: row.model,
          similarity,
        });
      }
    }
    hits.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.run_id.localeCompare(b.run_id) ||
        a.kind.localeCompare(b.kind) ||
        (a.submission_id ?? 0) - (b.submission_id ?? 0),
    );
    return hits.slice(0, limit);
  }

  // ---------------------------------------------------------------- idempotency

  #claimPath(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new RunStoreError('invalid idempotency key');
    }
    return join(this.#idemDir, `${sha256(key)}.json`);
  }

  async #readClaim(path: string): Promise<IdempotencyClaim | undefined> {
    const raw = await readJson(path, 'idempotency claim');
    return raw === undefined ? undefined : parseRecord(IdempotencyClaimSchema, raw, 'idempotency claim');
  }

  /**
   * Runs fn while holding the replace lock for one claim file. Returns
   * undefined when another caller holds the lock.
   */
  async #withReplaceLock<T>(path: string, fn: () => Promise<T>): Promise<{ value: T } | undefined> {
    const lock = `${path}.lock`;
    if (!(await createExclusive(lock, String(process.pid)))) {
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > STALE_LOCK_MS) await unlink(lock).catch(() => {});
      } catch {
        // Gone already.
      }
      return undefined;
    }
    try {
      return { value: await fn() };
    } finally {
      await unlink(lock).catch(() => {});
    }
  }

  async claimIdempotencyKey(key: string, runId: RunId, ttlMs: number): Promise<RunId> {
    const id = assertRunId(runId);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RunStoreError('invalid idempotency ttl');
    const path = this.#claimPath(key);
    await mkdir(this.#idemDir, { recursive: true });
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const claim = (): string => json({ run_id: id, expires_at: this.#now() + ttlMs });
      if (await createExclusive(path, claim())) return id;
      const held = await this.#readClaim(path);
      if (held === undefined) continue;
      if (held.expires_at > this.#now()) return held.run_id;
      // Expired: replace it under the lock, so two callers cannot both win.
      const replaced = await this.#withReplaceLock(path, async () => {
        const again = await this.#readClaim(path);
        if (again !== undefined && again.expires_at > this.#now()) return again.run_id;
        await writeFileAtomic(path, claim());
        return id;
      });
      if (replaced) return replaced.value;
      await sleep(2);
    }
    throw new RunStoreError('could not claim the idempotency key');
  }

  async clearExpiredIdempotencyKeys(): Promise<number> {
    let cleared = 0;
    for (const name of await listDir(this.#idemDir)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const path = join(this.#idemDir, name);
      const done = await this.#withReplaceLock(path, async () => {
        const held = await this.#readClaim(path);
        if (held === undefined || held.expires_at > this.#now()) return false;
        await unlink(path).catch(() => {});
        return true;
      });
      if (done?.value) cleared++;
    }
    return cleared;
  }

  async #dropClaimsFor(runId: string): Promise<void> {
    for (const name of await listDir(this.#idemDir)) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const path = join(this.#idemDir, name);
      await this.#withReplaceLock(path, async () => {
        const held = await this.#readClaim(path);
        if (held?.run_id === runId) await unlink(path).catch(() => {});
      });
    }
  }

  // ---------------------------------------------------------------- reads

  async #runIds(): Promise<RunId[]> {
    const names = await listDir(this.#runsDir);
    const ids: RunId[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
      if (await exists(join(this.#runsDir, name, 'meta.json'))) ids.push(name);
    }
    return ids.sort();
  }

  async getRun(runId: RunId): Promise<RunRecord | null> {
    const meta = await this.#meta(runId);
    if (!meta) return null;
    const dir = this.#dir(runId);
    const request = (await readJson(join(dir, 'input.json'), 'input.json')) as TriageRequest | undefined;
    if (request === undefined) throw new RunStoreError('run has no input.json');
    const classification = (await readJson(join(dir, 'classification.json'), 'classification.json')) as
      | ClassificationRecord
      | undefined;
    const feedback = await this.#feedback(runId);
    const embeddings: EmbeddingMeta[] = (await this.#embeddings(runId)).map((r) => ({
      ...(r.submission_id !== undefined ? { submission_id: r.submission_id } : {}),
      kind: r.kind,
      model: r.model,
      text_sha256: r.text_sha256,
      dims: r.vector.length,
    }));
    return {
      run_id: meta.run_id,
      schema_version: meta.schema_version,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      phase: meta.phase,
      ...(meta.phase_reason !== undefined ? { phase_reason: meta.phase_reason } : {}),
      ...(meta.worker_pid !== undefined ? { worker_pid: meta.worker_pid } : {}),
      input_request: meta.input_request ?? null,
      input_history: meta.input_history ?? [],
      block: meta.block ?? null,
      block_history: meta.block_history ?? [],
      request,
      classification: classification ?? null,
      evidence: await this.#evidence(runId),
      submissions: await this.#submissions(runId),
      report: ((await readJson(join(dir, 'report.json'), 'report.json')) as Report | undefined) ?? null,
      report_md: (await readText(join(dir, 'report.md'))) ?? null,
      feedback,
      feedback_latest: feedback.at(-1) ?? null,
      embeddings,
    };
  }

  async #submissions(runId: string): Promise<Submission[]> {
    const out: Submission[] = [];
    for (const seq of await this.#seqs(runId)) {
      const subDir = join(this.#dir(runId), 'submissions', String(seq));
      const raw = await readJson(join(subDir, 'submission.json'), 'submission.json');
      // A number reserved by a writer that has not finished yet.
      if (raw === undefined) continue;
      const meta = parseRecord(SubmissionMetaSchema, raw, 'submission.json');
      out.push({
        ...meta,
        report: ((await readJson(join(subDir, 'report.json'), 'report.json')) as Report | undefined) ?? null,
        report_md: (await readText(join(subDir, 'report.md'))) ?? null,
      });
    }
    return out;
  }

  async listRuns(query: RunQuery = {}): Promise<RunSummary[]> {
    const since = query.since?.getTime();
    const out: RunSummary[] = [];
    for (const runId of await this.#runIds()) {
      const meta = await this.#meta(runId);
      if (!meta) continue;
      if (since !== undefined && Date.parse(meta.created_at) < since) continue;
      if (query.phase !== undefined && meta.phase !== query.phase) continue;
      const dir = this.#dir(runId);
      const cls = (await readJson(join(dir, 'classification.json'), 'classification.json')) as
        | ClassificationRecord
        | undefined;
      const category = cls?.decision.proposed.category;
      if (query.category !== undefined && category !== query.category) continue;
      const report = (await readJson(join(dir, 'report.json'), 'report.json')) as Report | undefined;
      const verdict = (await this.#feedback(runId)).at(-1)?.verdict;
      out.push({
        run_id: runId,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        phase: meta.phase,
        ...(category !== undefined ? { category } : {}),
        ...(cls?.decision.tier_final !== undefined ? { tier_final: cls.decision.tier_final } : {}),
        ...(report?.status !== undefined ? { report_status: report.status } : {}),
        submissions: (await this.#submissions(runId)).length,
        ...(verdict !== undefined ? { feedback_verdict: verdict } : {}),
      });
    }
    out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.run_id.localeCompare(a.run_id));
    return query.limit === undefined ? out : out.slice(0, Math.max(0, Math.floor(query.limit)));
  }

  async listExpired(before: Date): Promise<RunId[]> {
    const cutoff = before.getTime();
    if (!Number.isFinite(cutoff)) throw new RunStoreError('invalid cutoff');
    const found: { id: RunId; at: number }[] = [];
    for (const runId of await this.#runIds()) {
      const meta = await this.#meta(runId);
      if (!meta) continue;
      const at = Date.parse(meta.created_at);
      if (at < cutoff) found.push({ id: runId, at });
    }
    return found.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((f) => f.id);
  }

  // ---------------------------------------------------------------- erasure

  async deleteRun(runId: RunId): Promise<boolean> {
    const dir = this.#dir(runId);
    return serial(this.#lock(runId), async () => {
      const existed = await exists(join(dir, 'meta.json'));
      // Move the folder out of the way first, so no reader sees half a run.
      // The dotted name never matches a run id, so listings skip it.
      const trash = join(this.#runsDir, `.deleted-${runId}-${randomBytes(4).toString('hex')}`);
      try {
        await rename(dir, trash);
        await rm(trash, { recursive: true, force: true });
      } catch (err) {
        if (!hasCode(err, 'ENOENT')) throw err;
      }
      await this.#dropClaimsFor(runId);
      return existed;
    });
  }
}

// ------------------------------------------------------------------ feedback helpers

function parseFeedbackLines(text: string): Feedback[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new RunStoreError('corrupt feedback.jsonl in the run store');
      }
      return parseRecord(FeedbackSchema, raw, 'feedback.jsonl');
    });
}

/** The default feedback.md: the latest verdict first, then the history. */
function renderFeedback(entries: readonly Feedback[]): string {
  const latest = entries.at(-1);
  if (!latest) return '';
  const lines = ['# Feedback', '', `Latest verdict: ${latest.verdict} (${latest.given_at}, ${latest.given_by})`];
  if (latest.actual_root_cause) lines.push('', `Actual root cause: ${latest.actual_root_cause}`);
  if (latest.faster_path) lines.push('', `Faster path: ${latest.faster_path}`);
  lines.push('', '## History', '');
  for (const e of entries) lines.push(`- ${e.given_at} ${e.verdict} by ${e.given_by} (${e.interface})`);
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------ factories

export function createFolderRunStore(opts: FolderRunStoreOptions): RunStore {
  return new FolderRunStore(opts);
}

/** The folder store at TRIAGE_RUNS_DIR, with idempotency claims under TRIAGE_DATA_DIR. */
export function folderRunStoreFromConfig(config: Config, opts: { now?: () => number } = {}): RunStore {
  return new FolderRunStore({ runsDir: config.paths.runsDir, dataDir: config.paths.dataDir, ...opts });
}

/** The input request fields of a meta record, carried over by every rewrite that is not about them. */
function inputFields(meta: RunMeta): Pick<RunMeta, 'input_request' | 'input_history'> {
  return {
    ...(meta.input_request !== undefined ? { input_request: meta.input_request } : {}),
    ...(meta.input_history !== undefined ? { input_history: meta.input_history } : {}),
  };
}

/** The block fields (D55), carried over the same way. */
function blockFields(meta: RunMeta): Pick<RunMeta, 'block' | 'block_history'> {
  return {
    ...(meta.block !== undefined ? { block: meta.block } : {}),
    ...(meta.block_history !== undefined ? { block_history: meta.block_history } : {}),
  };
}
