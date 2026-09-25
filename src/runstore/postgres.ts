// The postgres RunStore provider (D43, P2 §3.3 and §3.6, HLD 02 §7), used
// with TRIAGE_DB_PROVIDER=postgres. Node only.
//
// It runs over the shared PgRunner from src/db/pg.ts, so Flue persistence and
// the run store use one pool on TRIAGE_DB_URL. The tables are the ones in
// migrations/0001_init.sql; createRunStore (index.ts) applies them first.
//
// Every value reaches the database as a $n parameter. The only text built at
// run time is the per-model embedding table name, which comes from
// sanitiseModelTable and is checked again where it is used, and the vector
// dimension in that table's DDL, which is a checked integer.
//
// Embeddings live in one table per model, triage.emb_<slug>, created on first
// use and registered in triage.embedding_models with the dimension of the
// first vector. A model change is a new table, never a column migration.
// There is no vector index: findSimilar is an exact scan (D43).
//
// Timestamps come from the injected clock and are passed as parameters, never
// taken from now() in SQL, so a fake clock drives expiry in tests.

import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { PgRunner } from '../db/pg.ts';
import type { Persisted } from '../gate/redact.ts';
import type { RunId } from '../types/core.ts';
import type { Report } from '../types/report.ts';
import type { TriageRequest } from '../types/request.ts';
import {
  EMBEDDING_KINDS,
  EmbeddingInputSchema,
  EmbeddingKindSchema,
  FeedbackSchema,
  RUNSTORE_SCHEMA_VERSION,
  RunPhaseSchema,
  RunNotFoundError,
  RunStoreError,
  RunSummarySchema,
  SubmissionInputSchema,
  assertClean,
  assertEvidenceKey,
  assertPersisted,
  assertRunId,
  type ClassificationRecord,
  type EmbeddingInput,
  type EmbeddingKind,
  type EmbeddingMeta,
  type EvidenceKey,
  type EvidenceRecord,
  type Feedback,
  type Findings,
  type PhaseDetail,
  type RunPhase,
  type RunQuery,
  type RunRecord,
  type RunStore,
  type RunSummary,
  type SimilarHit,
  type SimilarQuery,
  type Submission,
  type SubmissionInput,
} from './types.ts';
import { assertQuestionId, InputRequestNotOpenError, InputRequestOpenError } from './types.ts';
import {
  InputRequestSchema,
  InputResolutionSchema,
  ResolvedInputRequestSchema,
  type InputRequest,
  type InputResolution,
} from '../types/input-request.ts';

/** The parts of the shared pg runner the provider uses. */
export type PgStoreRunner = Pick<PgRunner, 'query' | 'transaction'>;
type Query = PgRunner['query'];
type Row = Record<string, unknown>;

export type PostgresRunStoreOptions = {
  readonly runner: PgStoreRunner;
  /** Epoch milliseconds. Tests pass a fake clock. */
  readonly now?: () => number;
};

const DEFAULT_SIMILAR_LIMIT = 10;
const MAX_IDEMPOTENCY_KEY_LENGTH = 1024;
const CLAIM_ATTEMPTS = 20;

/** Postgres identifiers are at most 63 bytes. */
export const MODEL_TABLE_MAX_LENGTH = 63;
/** pgvector's limit for the vector type. */
export const MAX_EMBEDDING_DIMS = 16_000;

/** Stored in submission_seq when an embedding belongs to no submission. */
const NO_SUBMISSION = 0;

// ------------------------------------------------------------------ errors

/** The model name cannot become a table name. The message does not echo it. */
export class InvalidModelTableError extends RunStoreError {
  override name = 'InvalidModelTableError';
}

/** A vector whose length differs from the dims the model was registered with. */
export class EmbeddingDimsMismatchError extends RunStoreError {
  override name = 'EmbeddingDimsMismatchError';
  readonly model: string;
  readonly expected: number;
  readonly got: number;
  constructor(model: string, expected: number, got: number) {
    super(`embedding for ${model} has ${got} dims; the model is registered with ${expected}`);
    this.model = model;
    this.expected = expected;
    this.got = got;
  }
}

// ------------------------------------------------------------------ table names

declare const modelTableBrand: unique symbol;
/** A per-model table name that passed sanitiseModelTable. */
export type ModelTable = string & { readonly [modelTableBrand]: true };

const MODEL_TABLE = /^emb_[a-z0-9_]+$/;

/**
 * Maps provider/model to its embedding table name, emb_<slug>. Slashes and
 * hyphens become underscores; every other character outside [a-z0-9_]
 * (quotes, dots, spaces, semicolons, colons, capitals) is refused, as is a
 * name longer than MODEL_TABLE_MAX_LENGTH.
 */
export function sanitiseModelTable(model: string): ModelTable {
  if (typeof model !== 'string' || model.length === 0) {
    throw new InvalidModelTableError('embedding model name is empty');
  }
  const table = `emb_${model.replace(/[/-]/g, '_')}`;
  if (!MODEL_TABLE.test(table)) {
    throw new InvalidModelTableError('embedding model name may use only a-z, 0-9, _, - and /');
  }
  if (table.length > MODEL_TABLE_MAX_LENGTH) {
    throw new InvalidModelTableError(`embedding table name would be longer than ${MODEL_TABLE_MAX_LENGTH} characters`);
  }
  return table as ModelTable;
}

/** Re-checks a table name where it is put into SQL, whatever its type says. */
function tableIdent(table: ModelTable): ModelTable {
  if (!MODEL_TABLE.test(table) || table.length > MODEL_TABLE_MAX_LENGTH) {
    throw new InvalidModelTableError('invalid embedding table name');
  }
  return table;
}

function checkDims(dims: number): number {
  if (!Number.isSafeInteger(dims) || dims < 1 || dims > MAX_EMBEDDING_DIMS) {
    throw new RunStoreError(`embedding dims must be an integer from 1 to ${MAX_EMBEDDING_DIMS}`);
  }
  return dims;
}

// ------------------------------------------------------------------ SQL

/** Every fixed statement the provider issues. Values are always $n parameters. */
export const SQL = {
  createRun: `INSERT INTO triage.runs (run_id, schema_version, created_at, updated_at, phase, request)
VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4, $5::jsonb)
ON CONFLICT (run_id) DO NOTHING`,

  lockRun: 'SELECT run_id FROM triage.runs WHERE run_id = $1 FOR UPDATE',
  runExists: 'SELECT run_id FROM triage.runs WHERE run_id = $1',

  setPhase: `UPDATE triage.runs
SET phase = $2, phase_reason = $3::text, worker_pid = COALESCE($4::integer, worker_pid), updated_at = $5::timestamptz
WHERE run_id = $1
RETURNING run_id`,

  putClassification: `UPDATE triage.runs
SET classification = $2::jsonb, id_chain = $3::jsonb, category = $4::text, subcategory = $5::text,
  tier_proposed = $6::text, tier_final = $7::text, rule_fired = $8::text, matched_pattern_id = $9::text
WHERE run_id = $1
RETURNING run_id`,

  putInputRequest: `UPDATE triage.runs
SET input_request = $2::jsonb, phase = 'needs_input', phase_reason = NULL, updated_at = $3::timestamptz
WHERE run_id = $1 AND input_request IS NULL
RETURNING run_id`,
  resolveInputRequest: `UPDATE triage.runs
SET input_history = input_history || jsonb_build_array(input_request || $3::jsonb), input_request = NULL, updated_at = $4::timestamptz
WHERE run_id = $1 AND input_request->>'question_id' = $2::text
RETURNING run_id`,

  nextSubmissionSeq: 'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM triage.submissions WHERE run_id = $1',
  insertSubmission: `INSERT INTO triage.submissions (run_id, seq, kind, question, created_at, question_id, answer)
VALUES ($1, $2, $3, $4::text, $5::timestamptz, $6::text, $7::text)`,

  nextEvidenceVersion:
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM triage.evidence WHERE run_id = $1 AND key = $2',
  insertEvidence: `INSERT INTO triage.evidence (run_id, key, version, findings, created_at)
VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,

  upsertReport: `INSERT INTO triage.reports (run_id, seq, report, report_md, created_at)
SELECT run_id, seq, $3::jsonb, $4::text, $5::timestamptz FROM triage.submissions WHERE run_id = $1 AND seq = $2
ON CONFLICT (run_id, seq) DO UPDATE SET report = EXCLUDED.report, report_md = EXCLUDED.report_md, created_at = EXCLUDED.created_at
RETURNING seq`,
  latestReportSeq: 'SELECT MAX(seq) AS seq FROM triage.reports WHERE run_id = $1',
  setRunReport: 'UPDATE triage.runs SET report_status = $2::text, escalated = $3::boolean WHERE run_id = $1',

  insertFeedback: `INSERT INTO triage.feedback (run_id, verdict, given_by, given_at, body, body_md)
SELECT run_id, $2::text, $3::text, $4::timestamptz, $5::jsonb, $6::text FROM triage.runs WHERE run_id = $1
RETURNING id`,

  claimKey: `INSERT INTO triage.idempotency AS i (key_sha256, run_id, expires_at)
VALUES ($1, $2, $3::timestamptz)
ON CONFLICT (key_sha256) DO UPDATE SET run_id = EXCLUDED.run_id, expires_at = EXCLUDED.expires_at
WHERE i.expires_at <= $4::timestamptz
RETURNING run_id`,
  heldKey: 'SELECT run_id, expires_at FROM triage.idempotency WHERE key_sha256 = $1',
  clearExpiredKeys: 'DELETE FROM triage.idempotency WHERE expires_at <= $1::timestamptz RETURNING key_sha256',
  dropKeysForRun: 'DELETE FROM triage.idempotency WHERE run_id = $1',

  getRun: `SELECT run_id, schema_version, created_at, updated_at, phase, phase_reason, worker_pid, request, classification,
  input_request, input_history
FROM triage.runs WHERE run_id = $1`,
  latestEvidence: `SELECT DISTINCT ON (key) key, version, findings FROM triage.evidence
WHERE run_id = $1 ORDER BY key, version DESC`,
  submissions: `SELECT s.seq, s.kind, s.question, s.question_id, s.answer, s.created_at, r.report, r.report_md
FROM triage.submissions s LEFT JOIN triage.reports r ON r.run_id = s.run_id AND r.seq = s.seq
WHERE s.run_id = $1 ORDER BY s.seq`,
  feedback: 'SELECT body FROM triage.feedback WHERE run_id = $1 ORDER BY id',

  listRuns: `SELECT r.run_id, r.created_at, r.updated_at, r.phase, r.category, r.tier_final, r.report_status,
  (SELECT COUNT(*) FROM triage.submissions s WHERE s.run_id = r.run_id) AS submissions,
  (SELECT f.verdict FROM triage.feedback f WHERE f.run_id = r.run_id ORDER BY f.id DESC LIMIT 1) AS feedback_verdict
FROM triage.runs r
WHERE ($1::timestamptz IS NULL OR r.created_at >= $1::timestamptz)
  AND ($2::text IS NULL OR r.phase = $2::text)
  AND ($3::text IS NULL OR r.category = $3::text)
ORDER BY r.created_at DESC, r.run_id DESC
LIMIT $4::bigint`,
  listExpired: 'SELECT run_id FROM triage.runs WHERE created_at < $1::timestamptz ORDER BY created_at, run_id',

  deleteRun: 'DELETE FROM triage.runs WHERE run_id = $1 RETURNING run_id',

  // Serialises model registration across processes. Any fixed number works;
  // it differs from the migrator's lock.
  lockEmbeddingModels: 'SELECT pg_advisory_xact_lock(7426150094)',
  embeddingModels: 'SELECT model, table_name, dims FROM triage.embedding_models ORDER BY model',
  embeddingModel: 'SELECT model, table_name, dims FROM triage.embedding_models WHERE model = $1',
  embeddingTableOwner: 'SELECT model FROM triage.embedding_models WHERE table_name = $1',
  registerModel: `INSERT INTO triage.embedding_models (model, table_name, dims, created_at)
VALUES ($1, $2, $3, $4::timestamptz)`,
} as const;

/** DDL for one model's embedding table. dims is fixed by the first vector. */
export function embeddingTableDdl(table: ModelTable, dimensions: number): string {
  const t = tableIdent(table);
  const dims = checkDims(dimensions);
  return `CREATE TABLE IF NOT EXISTS triage.${t} (
  run_id text NOT NULL REFERENCES triage.runs (run_id) ON DELETE CASCADE,
  submission_seq integer NOT NULL DEFAULT 0,
  kind text NOT NULL,
  text_sha256 text NOT NULL,
  source_text text NOT NULL,
  embedding vector(${dims}) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, kind, submission_seq)
)`;
}

/** The statements that read and write one model's embedding table. */
export function embeddingSql(table: ModelTable) {
  const t = tableIdent(table);
  return {
    upsert: `INSERT INTO triage.${t} (run_id, submission_seq, kind, text_sha256, source_text, embedding, created_at)
SELECT run_id, $2::integer, $3::text, $4::text, $5::text, $6::vector, $7::timestamptz FROM triage.runs WHERE run_id = $1
ON CONFLICT (run_id, kind, submission_seq) DO UPDATE SET text_sha256 = EXCLUDED.text_sha256,
  source_text = EXCLUDED.source_text, embedding = EXCLUDED.embedding, created_at = EXCLUDED.created_at
RETURNING run_id`,
    listForRun: `SELECT submission_seq, kind, text_sha256 FROM triage.${t}
WHERE run_id = $1 ORDER BY kind, submission_seq`,
    similar: `SELECT run_id, submission_seq, kind, 1 - (embedding <=> $1::vector) AS similarity FROM triage.${t}
WHERE kind IN ($2::text, $3::text) AND ($4::text IS NULL OR run_id <> $4::text)
ORDER BY embedding <=> $1::vector, run_id, kind, submission_seq
LIMIT $5::bigint`,
  } as const;
}

// ------------------------------------------------------------------ value helpers

/** pgvector's text form. The numbers are validated finite before this runs. */
export function vectorLiteral(vector: readonly number[]): string {
  return JSON.stringify(vector);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function positiveInt(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RunStoreError(`invalid ${label}`);
  return n;
}

/** pg returns timestamptz as a Date; a text value is accepted too. */
function toIso(value: unknown, label: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) throw new RunStoreError(`corrupt ${label} in the run store`);
  return date.toISOString();
}

/** pg returns jsonb parsed; a text value is parsed here. */
function fromJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new RunStoreError(`corrupt ${label} in the run store`);
  }
}

/** integer columns come back as numbers, bigint and COUNT(*) as strings. */
function toInt(value: unknown, label: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new RunStoreError(`corrupt ${label} in the run store`);
  return n;
}

function optText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseRecord<S extends v.GenericSchema>(schema: S, value: unknown, label: string): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  const paths = [...new Set(result.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
  throw new RunStoreError(`invalid ${label}: ${paths.join(', ')}`);
}

type ModelInfo = { readonly model: string; readonly table: ModelTable; readonly dims: number };

function modelInfo(row: Row): ModelInfo {
  const table = String(row.table_name);
  if (!MODEL_TABLE.test(table)) throw new RunStoreError('corrupt embedding model registry in the run store');
  return { model: String(row.model), table: table as ModelTable, dims: toInt(row.dims, 'embedding dims') };
}

// ------------------------------------------------------------------ provider

class PostgresRunStore implements RunStore {
  readonly provider = 'postgres' as const;
  readonly #runner: PgStoreRunner;
  readonly #now: () => number;
  // Registry rows never change once written, so they are safe to cache.
  readonly #models = new Map<string, ModelInfo>();

  constructor(opts: PostgresRunStoreOptions) {
    this.#runner = opts.runner;
    this.#now = opts.now ?? Date.now;
  }

  #iso(ms = this.#now()): string {
    return new Date(ms).toISOString();
  }

  async #requireRun(query: Query, sql: string, runId: string): Promise<void> {
    if ((await query(sql, [runId])).length === 0) throw new RunNotFoundError(runId);
  }

  // ---------------------------------------------------------------- runs

  async createRun(runId: RunId, request: Persisted<TriageRequest>): Promise<void> {
    const id = assertRunId(runId);
    const value = assertPersisted(request, 'request');
    const now = this.#iso();
    // The first request wins; a repeat call changes nothing.
    await this.#runner.query(SQL.createRun, [id, RUNSTORE_SCHEMA_VERSION, now, 'created', JSON.stringify(value)]);
  }

  async setPhase(runId: RunId, phase: RunPhase, detail: PhaseDetail = {}): Promise<void> {
    const id = assertRunId(runId);
    parseRecord(RunPhaseSchema, phase, 'phase');
    if (detail.reason !== undefined) assertClean(detail.reason, 'phase reason');
    if (detail.worker_pid !== undefined) positiveInt(detail.worker_pid, 'worker pid');
    const rows = await this.#runner.query(SQL.setPhase, [
      id,
      phase,
      detail.reason ?? null,
      detail.worker_pid ?? null,
      this.#iso(),
    ]);
    if (rows.length === 0) throw new RunNotFoundError(id);
  }

  async putClassification(runId: RunId, record: Persisted<ClassificationRecord>): Promise<void> {
    const id = assertRunId(runId);
    const value = assertPersisted(record, 'classification');
    const { decision } = value;
    const rows = await this.#runner.query(SQL.putClassification, [
      id,
      JSON.stringify(value),
      JSON.stringify(value.id_chain),
      decision.proposed.category,
      decision.proposed.subcategory,
      decision.proposed.tier_proposed,
      decision.tier_final,
      decision.rule_fired,
      decision.proposed.matched_pattern_id ?? null,
    ]);
    if (rows.length === 0) throw new RunNotFoundError(id);
  }

  async putInputRequest(runId: RunId, request: Persisted<InputRequest>): Promise<void> {
    const id = assertRunId(runId);
    const value = parseRecord(InputRequestSchema, assertPersisted(request, 'input request'), 'input request');
    const rows = await this.#runner.query(SQL.putInputRequest, [id, JSON.stringify(value), this.#iso()]);
    if (rows.length > 0) return;
    // No row updated: the run is missing, or a question is already open.
    const [run] = await this.#runner.query(SQL.getRun, [id]);
    if (run === undefined) throw new RunNotFoundError(id);
    const open = run.input_request === null || run.input_request === undefined ? null : (fromJson(run.input_request, 'input request') as InputRequest);
    throw new InputRequestOpenError(id, open?.question_id ?? '?');
  }

  async resolveInputRequest(runId: RunId, questionId: string, resolution: Persisted<InputResolution>): Promise<void> {
    const id = assertRunId(runId);
    assertQuestionId(questionId);
    const value = parseRecord(InputResolutionSchema, assertPersisted(resolution, 'input resolution'), 'input resolution');
    const rows = await this.#runner.query(SQL.resolveInputRequest, [id, questionId, JSON.stringify(value), this.#iso()]);
    if (rows.length > 0) return;
    const exists = await this.#runner.query(SQL.runExists, [id]);
    if (exists.length === 0) throw new RunNotFoundError(id);
    throw new InputRequestNotOpenError(id, questionId);
  }

  // ---------------------------------------------------------------- submissions and reports

  async addSubmission(runId: RunId, submission: Persisted<SubmissionInput>): Promise<number> {
    const id = assertRunId(runId);
    const input = parseRecord(SubmissionInputSchema, assertPersisted(submission, 'submission'), 'submission');
    return this.#runner.transaction(async (tx) => {
      // The row lock serialises seq allocation for the run.
      await this.#requireRun(tx.query, SQL.lockRun, id);
      const [row] = await tx.query(SQL.nextSubmissionSeq, [id]);
      const seq = toInt(row?.seq, 'submission seq');
      await tx.query(SQL.insertSubmission, [
        id,
        seq,
        input.kind,
        input.question ?? null,
        this.#iso(),
        input.question_id ?? null,
        input.answer ?? null,
      ]);
      return seq;
    });
  }

  async putReport(runId: RunId, submissionId: number, report: Persisted<Report>, md: Persisted<string>): Promise<void> {
    const id = assertRunId(runId);
    const seq = positiveInt(submissionId, 'submission id');
    const reportValue = assertPersisted(report, 'report');
    const mdValue = assertPersisted(md, 'report markdown');
    if (typeof mdValue !== 'string') throw new RunStoreError('report markdown must be a string');
    await this.#runner.transaction(async (tx) => {
      await this.#requireRun(tx.query, SQL.lockRun, id);
      const written = await tx.query(SQL.upsertReport, [id, seq, JSON.stringify(reportValue), mdValue, this.#iso()]);
      if (written.length === 0) throw new RunStoreError(`submission ${seq} not found`);
      // The run's summary columns follow the newest submission that has a report.
      const [latest] = await tx.query(SQL.latestReportSeq, [id]);
      if (seq >= toInt(latest?.seq, 'report seq')) {
        await tx.query(SQL.setRunReport, [id, reportValue.status, reportValue.escalated]);
      }
    });
  }

  // ---------------------------------------------------------------- evidence

  async putEvidence(runId: RunId, key: EvidenceKey, findings: Persisted<Findings>): Promise<number> {
    const id = assertRunId(runId);
    const k = assertEvidenceKey(key);
    const value = assertPersisted(findings, `evidence ${k}`);
    return this.#runner.transaction(async (tx) => {
      await this.#requireRun(tx.query, SQL.lockRun, id);
      const [row] = await tx.query(SQL.nextEvidenceVersion, [id, k]);
      const version = toInt(row?.version, 'evidence version');
      await tx.query(SQL.insertEvidence, [id, k, version, JSON.stringify(value), this.#iso()]);
      return version;
    });
  }

  // ---------------------------------------------------------------- feedback

  async putFeedback(runId: RunId, feedback: Persisted<Feedback>, md?: Persisted<string>): Promise<void> {
    const id = assertRunId(runId);
    const entry = parseRecord(FeedbackSchema, assertPersisted(feedback, 'feedback'), 'feedback');
    const mdValue = md === undefined ? undefined : assertPersisted(md, 'feedback markdown');
    if (mdValue !== undefined && typeof mdValue !== 'string') throw new RunStoreError('feedback markdown must be a string');
    const rows = await this.#runner.query(SQL.insertFeedback, [
      id,
      entry.verdict,
      entry.given_by,
      entry.given_at,
      JSON.stringify(entry),
      mdValue ?? null,
    ]);
    if (rows.length === 0) throw new RunNotFoundError(id);
  }

  // ---------------------------------------------------------------- embeddings

  async #findModel(query: Query, model: string): Promise<ModelInfo | undefined> {
    const cached = this.#models.get(model);
    if (cached) return cached;
    const [row] = await query(SQL.embeddingModel, [model]);
    if (row === undefined) return undefined;
    const info = modelInfo(row);
    this.#models.set(model, info);
    return info;
  }

  /** The model's table, registering it with these dims on first use. */
  async #ensureModel(model: string, dims: number): Promise<ModelInfo> {
    const known = await this.#findModel(this.#runner.query, model);
    if (known) {
      if (known.dims !== dims) throw new EmbeddingDimsMismatchError(model, known.dims, dims);
      return known;
    }
    const table = sanitiseModelTable(model);
    checkDims(dims);
    const info = await this.#runner.transaction(async (tx) => {
      await tx.query(SQL.lockEmbeddingModels);
      // Another process may have registered it while this one waited.
      const [row] = await tx.query(SQL.embeddingModel, [model]);
      if (row !== undefined) return modelInfo(row);
      const [owner] = await tx.query(SQL.embeddingTableOwner, [table]);
      if (owner !== undefined) {
        throw new InvalidModelTableError('embedding model maps to a table another model already uses');
      }
      await tx.query(embeddingTableDdl(table, dims));
      await tx.query(SQL.registerModel, [model, table, dims, this.#iso()]);
      return { model, table, dims };
    });
    this.#models.set(model, info);
    if (info.dims !== dims) throw new EmbeddingDimsMismatchError(model, info.dims, dims);
    return info;
  }

  async putEmbedding(runId: RunId, row: Persisted<EmbeddingInput>): Promise<void> {
    const id = assertRunId(runId);
    const input = parseRecord(EmbeddingInputSchema, assertPersisted(row, 'embedding'), 'embedding');
    // Check the run first, so an unknown run registers no model.
    await this.#requireRun(this.#runner.query, SQL.runExists, id);
    const info = await this.#ensureModel(input.model, input.vector.length);
    const rows = await this.#runner.query(embeddingSql(info.table).upsert, [
      id,
      input.submission_id ?? NO_SUBMISSION,
      input.kind,
      input.text_sha256,
      input.source_text,
      vectorLiteral(input.vector),
      this.#iso(),
    ]);
    if (rows.length === 0) throw new RunNotFoundError(id);
  }

  async findSimilar(query: SimilarQuery): Promise<SimilarHit[]> {
    const vector = parseRecord(EmbeddingInputSchema.entries.vector, query.vector, 'query vector');
    const kinds = [...new Set(parseRecord(v.array(EmbeddingKindSchema), query.kinds ?? EMBEDDING_KINDS, 'kinds'))];
    const exclude = query.excludeRunId === undefined ? null : assertRunId(query.excludeRunId);
    const rawLimit = query.limit ?? DEFAULT_SIMILAR_LIMIT;
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : DEFAULT_SIMILAR_LIMIT;
    if (kinds.length === 0 || limit === 0) return [];
    const info = await this.#findModel(this.#runner.query, query.model);
    // No rows for the model, or a query from a different model build: nothing compares.
    if (info === undefined || info.dims !== vector.length) return [];
    const rows = await this.#runner.query(embeddingSql(info.table).similar, [
      vectorLiteral(vector),
      kinds[0] as EmbeddingKind,
      (kinds[1] ?? kinds[0]) as EmbeddingKind,
      exclude,
      limit,
    ]);
    const hits: SimilarHit[] = [];
    for (const r of rows) {
      const similarity = Number(r.similarity);
      // A zero vector has no cosine; pgvector gives NaN.
      if (!Number.isFinite(similarity)) continue;
      const seq = toInt(r.submission_seq, 'submission seq');
      hits.push({
        run_id: String(r.run_id),
        ...(seq !== NO_SUBMISSION ? { submission_id: seq } : {}),
        kind: parseRecord(EmbeddingKindSchema, r.kind, 'embedding kind'),
        model: info.model,
        similarity,
      });
    }
    return hits;
  }

  // ---------------------------------------------------------------- idempotency

  async claimIdempotencyKey(key: string, runId: RunId, ttlMs: number): Promise<RunId> {
    const id = assertRunId(runId);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RunStoreError('invalid idempotency ttl');
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new RunStoreError('invalid idempotency key');
    }
    // Only the hash is stored or sent; the key itself never leaves the process.
    const hash = sha256(key);
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const now = this.#now();
      const claimed = await this.#runner.query(SQL.claimKey, [hash, id, this.#iso(now + ttlMs), this.#iso(now)]);
      if (claimed.length > 0) return id;
      const [held] = await this.#runner.query(SQL.heldKey, [hash]);
      // The claim expired or was cleared between the two statements: try again.
      if (held === undefined) continue;
      if (Date.parse(toIso(held.expires_at, 'idempotency expiry')) > this.#now()) return String(held.run_id);
    }
    throw new RunStoreError('could not claim the idempotency key');
  }

  async clearExpiredIdempotencyKeys(): Promise<number> {
    return (await this.#runner.query(SQL.clearExpiredKeys, [this.#iso()])).length;
  }

  // ---------------------------------------------------------------- reads

  async getRun(runId: RunId): Promise<RunRecord | null> {
    const id = assertRunId(runId);
    const query = this.#runner.query;
    const [run] = await query(SQL.getRun, [id]);
    if (run === undefined) return null;

    const evidence: Partial<Record<EvidenceKey, EvidenceRecord>> = {};
    for (const row of await query(SQL.latestEvidence, [id])) {
      const key = assertEvidenceKey(String(row.key));
      evidence[key] = {
        key,
        version: toInt(row.version, 'evidence version'),
        findings: fromJson(row.findings, 'evidence') as Findings,
      };
    }

    const submissions: Submission[] = (await query(SQL.submissions, [id])).map((row) => {
      const question = optText(row.question);
      const questionId = optText(row.question_id);
      const answer = optText(row.answer);
      const report = row.report === null || row.report === undefined ? null : (fromJson(row.report, 'report') as Report);
      return {
        kind: parseRecord(SubmissionInputSchema.entries.kind, row.kind, 'submission kind'),
        ...(question !== undefined ? { question } : {}),
        ...(questionId !== undefined ? { question_id: questionId } : {}),
        ...(answer !== undefined ? { answer } : {}),
        seq: toInt(row.seq, 'submission seq'),
        created_at: toIso(row.created_at, 'submission time'),
        report,
        report_md: report === null ? null : (optText(row.report_md) ?? null),
      };
    });
    const latest = submissions.filter((s) => s.report !== null).at(-1);

    const feedback: Feedback[] = (await query(SQL.feedback, [id])).map((row) =>
      parseRecord(FeedbackSchema, fromJson(row.body, 'feedback'), 'feedback'),
    );

    const embeddings: EmbeddingMeta[] = [];
    for (const info of (await query(SQL.embeddingModels)).map(modelInfo)) {
      for (const row of await query(embeddingSql(info.table).listForRun, [id])) {
        const seq = toInt(row.submission_seq, 'submission seq');
        embeddings.push({
          ...(seq !== NO_SUBMISSION ? { submission_id: seq } : {}),
          kind: parseRecord(EmbeddingKindSchema, row.kind, 'embedding kind'),
          model: info.model,
          text_sha256: String(row.text_sha256),
          dims: info.dims,
        });
      }
    }

    const reason = optText(run.phase_reason);
    const pid = run.worker_pid === null || run.worker_pid === undefined ? undefined : toInt(run.worker_pid, 'worker pid');
    const classification = run.classification === null || run.classification === undefined
      ? null
      : (fromJson(run.classification, 'classification') as ClassificationRecord);
    const inputRequest = run.input_request === null || run.input_request === undefined
      ? null
      : parseRecord(InputRequestSchema, fromJson(run.input_request, 'input request'), 'input request');
    const inputHistory = run.input_history === null || run.input_history === undefined
      ? []
      : parseRecord(v.array(ResolvedInputRequestSchema), fromJson(run.input_history, 'input history'), 'input history');
    return {
      run_id: String(run.run_id),
      schema_version: toInt(run.schema_version, 'schema version'),
      created_at: toIso(run.created_at, 'created_at'),
      updated_at: toIso(run.updated_at, 'updated_at'),
      phase: parseRecord(RunPhaseSchema, run.phase, 'phase'),
      ...(reason !== undefined ? { phase_reason: reason } : {}),
      ...(pid !== undefined ? { worker_pid: pid } : {}),
      input_request: inputRequest,
      input_history: inputHistory,
      request: fromJson(run.request, 'request') as TriageRequest,
      classification,
      evidence,
      submissions,
      report: latest?.report ?? null,
      report_md: latest?.report_md ?? null,
      feedback,
      feedback_latest: feedback.at(-1) ?? null,
      embeddings,
    };
  }

  async listRuns(query: RunQuery = {}): Promise<RunSummary[]> {
    const since = query.since === undefined ? null : this.#cutoff(query.since);
    const phase = query.phase === undefined ? null : parseRecord(RunPhaseSchema, query.phase, 'phase');
    if (query.limit !== undefined && !Number.isFinite(query.limit)) throw new RunStoreError('invalid limit');
    const limit = query.limit === undefined ? null : Math.max(0, Math.floor(query.limit));
    const rows = await this.#runner.query(SQL.listRuns, [since, phase, query.category ?? null, limit]);
    return rows.map((row) => {
      const category = optText(row.category);
      const tier = optText(row.tier_final);
      const status = optText(row.report_status);
      const verdict = optText(row.feedback_verdict);
      const summary = {
        run_id: String(row.run_id),
        created_at: toIso(row.created_at, 'created_at'),
        updated_at: toIso(row.updated_at, 'updated_at'),
        phase: row.phase,
        ...(category !== undefined ? { category } : {}),
        ...(tier !== undefined ? { tier_final: tier } : {}),
        ...(status !== undefined ? { report_status: status } : {}),
        submissions: toInt(row.submissions, 'submission count'),
        ...(verdict !== undefined ? { feedback_verdict: verdict } : {}),
      };
      return parseRecord(RunSummarySchema, summary, 'run summary');
    });
  }

  #cutoff(at: Date): string {
    const ms = at.getTime();
    if (!Number.isFinite(ms)) throw new RunStoreError('invalid cutoff');
    return this.#iso(ms);
  }

  async listExpired(before: Date): Promise<RunId[]> {
    const rows = await this.#runner.query(SQL.listExpired, [this.#cutoff(before)]);
    return rows.map((row) => String(row.run_id));
  }

  // ---------------------------------------------------------------- erasure

  async deleteRun(runId: RunId): Promise<boolean> {
    const id = assertRunId(runId);
    // One transaction: the run row goes, the foreign keys cascade to
    // submissions, evidence, reports, feedback and every embedding table,
    // and the run's idempotency claims (no foreign key) go with it.
    return this.#runner.transaction(async (tx) => {
      const deleted = await tx.query(SQL.deleteRun, [id]);
      await tx.query(SQL.dropKeysForRun, [id]);
      return deleted.length > 0;
    });
  }
}

// ------------------------------------------------------------------ factory

export function createPostgresRunStore(opts: PostgresRunStoreOptions): RunStore {
  return new PostgresRunStore(opts);
}
