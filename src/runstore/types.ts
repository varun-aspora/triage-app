// The RunStore interface and its record types (D43, HLD 02 §7, P2 §3.1).
//
// A run is one triage case: run -> submissions -> evidence, reports, feedback,
// embeddings. Audit stays in the JSONL (D20), so there is no audit method.
//
// Every write takes a Persisted<T> from src/gate/redact.ts, which only
// redactPersisted can produce, and every provider re-runs the persisted-profile
// check before it writes (assertPersisted below). The raw thread type cannot
// reach the store: createRun takes Persisted<TriageRequest> only.
//
// The run id is always passed as its own argument and never read from inside
// a persisted value. The persisted profile masks runs of 6+ digits, which a
// ULID can contain, so an id inside a redacted value is not reliable.
//
// Reads return plain values. They hold persisted-profile text only, because
// that is all the store ever accepts.

import * as v from 'valibot';
import { checkEgress, isPersisted, type PatternName, type Persisted } from '../gate/redact.ts';
import { CategorySchema, type Classification, type PreflightWarning, type TierDecision } from '../types/classification.ts';
import {
  ENTITIES,
  InterfaceSchema,
  NonEmptyStringSchema,
  ReportStatusSchema,
  RunIdSchema,
  TakenAtSchema,
  TierSchema,
  type Entity,
  type RunId,
} from '../types/core.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';
import type { IdChain } from '../types/id-chain.ts';
import type { Report } from '../types/report.ts';
import type { TriageRequest } from '../types/request.ts';

export type { Persisted } from '../gate/redact.ts';

/** Bumped when the on-disk or table layout changes. */
export const RUNSTORE_SCHEMA_VERSION = 1;

// ------------------------------------------------------------------ phases

export const RUN_PHASES = [
  'created',
  'preflight',
  'identity',
  'classifying',
  'dispatched',
  'investigating',
  'completed',
  'failed',
] as const;
export const RunPhaseSchema = v.picklist(RUN_PHASES);
export type RunPhase = v.InferOutput<typeof RunPhaseSchema>;

export const TERMINAL_PHASES: readonly RunPhase[] = ['completed', 'failed'];

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** Optional detail recorded with a phase change. */
export type PhaseDetail = {
  /** Why the run failed, for example the error class name. Scanned before write. */
  readonly reason?: string;
  /** The detached worker's pid, so status can tell a stalled run. */
  readonly worker_pid?: number;
};

// ------------------------------------------------------------------ records

export const RunMetaSchema = v.object({
  schema_version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  run_id: RunIdSchema,
  created_at: TakenAtSchema,
  updated_at: TakenAtSchema,
  phase: RunPhaseSchema,
  phase_reason: v.optional(v.string()),
  worker_pid: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export type RunMeta = v.InferOutput<typeof RunMetaSchema>;

/** What ingress stores after the classifier and tier policy ran. */
export type ClassificationRecord = {
  readonly decision: TierDecision;
  readonly id_chain: IdChain;
  readonly preflight_warnings?: readonly PreflightWarning[];
};

export const EVIDENCE_KEYS = [...ENTITIES, 'code'] as const;
export const EvidenceKeySchema = v.picklist(EVIDENCE_KEYS);
export type EvidenceKey = Entity | 'code';
export type Findings = EntityFindings | CodeFindings;

export type EvidenceRecord = {
  readonly key: EvidenceKey;
  readonly version: number;
  readonly findings: Findings;
};

export const SUBMISSION_KINDS = ['initial', 'ask'] as const;
export const SubmissionInputSchema = v.object({
  kind: v.picklist(SUBMISSION_KINDS),
  // The follow-up question of a `triage ask`, persisted profile.
  question: v.optional(v.string()),
});
export type SubmissionInput = v.InferOutput<typeof SubmissionInputSchema>;

export const SubmissionMetaSchema = v.object({
  ...SubmissionInputSchema.entries,
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  created_at: TakenAtSchema,
});
export type SubmissionMeta = v.InferOutput<typeof SubmissionMetaSchema>;

export type Submission = SubmissionMeta & {
  readonly report: Report | null;
  readonly report_md: string | null;
};

export const FEEDBACK_VERDICTS = ['correct', 'partial', 'wrong', 'pending'] as const;
export const FeedbackVerdictSchema = v.picklist(FEEDBACK_VERDICTS);
export type FeedbackVerdict = v.InferOutput<typeof FeedbackVerdictSchema>;

export const FeedbackSchema = v.object({
  verdict: FeedbackVerdictSchema,
  actual_root_cause: v.optional(v.string()),
  faster_path: v.optional(v.string()),
  given_by: NonEmptyStringSchema,
  given_at: TakenAtSchema,
  interface: InterfaceSchema,
});
export type Feedback = v.InferOutput<typeof FeedbackSchema>;

// ------------------------------------------------------------------ embeddings

export const EMBEDDING_KINDS = ['case', 'request'] as const;
export const EmbeddingKindSchema = v.picklist(EMBEDDING_KINDS);
export type EmbeddingKind = v.InferOutput<typeof EmbeddingKindSchema>;

const VectorSchema = v.pipe(
  v.array(v.pipe(v.number(), v.finite())),
  v.minLength(1, 'embedding vector is empty'),
);

/** What a caller passes to putEmbedding. The run id is a separate argument. */
export const EmbeddingInputSchema = v.object({
  submission_id: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  kind: EmbeddingKindSchema,
  // provider/model, as in MODEL_EMBEDDING.
  model: NonEmptyStringSchema,
  text_sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  // The persisted-profile text that was embedded.
  source_text: v.string(),
  vector: VectorSchema,
});
export type EmbeddingInput = v.InferOutput<typeof EmbeddingInputSchema>;

export const EmbeddingRowSchema = v.object({ run_id: RunIdSchema, ...EmbeddingInputSchema.entries });
export type EmbeddingRow = v.InferOutput<typeof EmbeddingRowSchema>;

/** An embedding row without its text and vector, as getRun lists it. */
export type EmbeddingMeta = Pick<EmbeddingRow, 'submission_id' | 'kind' | 'model' | 'text_sha256'> & {
  readonly dims: number;
};

export type SimilarQuery = {
  readonly vector: readonly number[];
  /** Only rows embedded with this model are compared. */
  readonly model: string;
  /** Defaults to both kinds. */
  readonly kinds?: readonly EmbeddingKind[];
  /** The calling run, left out of the result. */
  readonly excludeRunId?: RunId;
  /** Defaults to 10. */
  readonly limit?: number;
};

/**
 * One embedding row that matched. Results are ordered by cosine similarity,
 * highest first; ties go by run_id, then kind, then submission_id.
 */
export type SimilarHit = {
  readonly run_id: RunId;
  readonly submission_id?: number;
  readonly kind: EmbeddingKind;
  readonly model: string;
  readonly similarity: number;
};

// ------------------------------------------------------------------ run record

export type RunRecord = {
  readonly run_id: RunId;
  readonly schema_version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly phase: RunPhase;
  readonly phase_reason?: string;
  readonly worker_pid?: number;
  readonly request: TriageRequest;
  readonly classification: ClassificationRecord | null;
  /** Latest version per key. */
  readonly evidence: Readonly<Partial<Record<EvidenceKey, EvidenceRecord>>>;
  /** Ordered by seq. */
  readonly submissions: readonly Submission[];
  /** The report of the latest submission that has one. */
  readonly report: Report | null;
  readonly report_md: string | null;
  /** Every feedback entry, oldest first. */
  readonly feedback: readonly Feedback[];
  /** The last entry written; latest wins. */
  readonly feedback_latest: Feedback | null;
  readonly embeddings: readonly EmbeddingMeta[];
};

export const RunSummarySchema = v.object({
  run_id: RunIdSchema,
  created_at: TakenAtSchema,
  updated_at: TakenAtSchema,
  phase: RunPhaseSchema,
  category: v.optional(CategorySchema),
  tier_final: v.optional(TierSchema),
  report_status: v.optional(ReportStatusSchema),
  submissions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  feedback_verdict: v.optional(FeedbackVerdictSchema),
});
export type RunSummary = v.InferOutput<typeof RunSummarySchema>;

export type RunQuery = {
  /** Only runs created at or after this time. */
  readonly since?: Date;
  readonly phase?: RunPhase;
  readonly category?: Classification['category'];
  /** Newest first; defaults to every run. */
  readonly limit?: number;
};

// ------------------------------------------------------------------ interface

export interface RunStore {
  readonly provider: 'folder' | 'postgres';

  /** Creates the run. A second call with the same run id is a no-op. */
  createRun(runId: RunId, request: Persisted<TriageRequest>): Promise<void>;
  /** Adds a submission and returns its seq, starting at 1. */
  addSubmission(runId: RunId, submission: Persisted<SubmissionInput>): Promise<number>;
  setPhase(runId: RunId, phase: RunPhase, detail?: PhaseDetail): Promise<void>;
  putClassification(runId: RunId, record: Persisted<ClassificationRecord>): Promise<void>;
  /** Stores a new version of the findings for the key and returns it (1, 2, ...). */
  putEvidence(runId: RunId, key: EvidenceKey, findings: Persisted<Findings>): Promise<number>;
  /** Stores the report of one submission. The run's report is the latest submission's. */
  putReport(runId: RunId, submissionId: number, report: Persisted<Report>, md: Persisted<string>): Promise<void>;
  /** Appends a feedback entry. Nothing is overwritten; the last entry wins. */
  putFeedback(runId: RunId, feedback: Persisted<Feedback>, md?: Persisted<string>): Promise<void>;
  /**
   * Claims an idempotency key for runId. Returns the run id that holds the
   * key: runId for a new claim, or the first claimant's run id while its
   * claim has not expired.
   */
  claimIdempotencyKey(key: string, runId: RunId, ttlMs: number): Promise<RunId>;
  /** Removes idempotency claims that have expired and returns how many. */
  clearExpiredIdempotencyKeys(): Promise<number>;
  getRun(runId: RunId): Promise<RunRecord | null>;
  listRuns(query?: RunQuery): Promise<RunSummary[]>;
  /** Stores an embedding, replacing the row with the same kind, model and submission. */
  putEmbedding(runId: RunId, row: Persisted<EmbeddingInput>): Promise<void>;
  findSimilar(query: SimilarQuery): Promise<SimilarHit[]>;
  /** Removes everything the store holds for the run. Returns false when it did not exist. */
  deleteRun(runId: RunId): Promise<boolean>;
  /** Runs created strictly before the cutoff, oldest first. */
  listExpired(before: Date): Promise<RunId[]>;
}

// ------------------------------------------------------------------ errors

export class RunStoreError extends Error {
  override name = 'RunStoreError';
}

export class RunNotFoundError extends RunStoreError {
  override name = 'RunNotFoundError';
  readonly runId: string;
  constructor(runId: string) {
    super(`run not found: ${runId}`);
    this.runId = runId;
  }
}

/**
 * The persisted-profile check found something unmasked. The message and the
 * fields carry pattern names and JSON paths only, never the matched text.
 */
export class RunStoreRedactionError extends RunStoreError {
  override name = 'RunStoreRedactionError';
  readonly patterns: readonly PatternName[];
  readonly paths: readonly string[];
  constructor(what: string, patterns: readonly PatternName[], paths: readonly string[]) {
    super(`refused to store ${what}: unmasked ${patterns.join(', ')}`);
    this.patterns = patterns;
    this.paths = paths;
  }
}

// ------------------------------------------------------------------ shared checks

/**
 * The write-side check every provider runs. It refuses a value that is not a
 * Persisted box (a cast through any) and re-runs the persisted-profile scan,
 * which catches a redacted value that was changed after redaction.
 */
export function assertPersisted<T>(value: Persisted<T>, what: string): T {
  if (!isPersisted(value)) throw new RunStoreError(`refused to store ${what}: not a persisted-profile value`);
  const inner = value.value;
  const check = checkEgress(inner);
  if (!check.ok) throw new RunStoreRedactionError(what, check.unmasked, check.paths);
  return inner;
}

/** A plain-text field the store writes that is not a Persisted value (phase reason). */
export function assertClean(text: string, what: string): void {
  const check = checkEgress(text);
  if (!check.ok) throw new RunStoreRedactionError(what, check.unmasked, []);
}

export function assertRunId(runId: string): RunId {
  if (!v.is(RunIdSchema, runId)) throw new RunStoreError('invalid run id');
  return runId;
}

export function assertEvidenceKey(key: string): EvidenceKey {
  if (!v.is(EvidenceKeySchema, key)) throw new RunStoreError('invalid evidence key');
  return key;
}

export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / Math.sqrt(na * nb);
}
