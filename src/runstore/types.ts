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
// The one exception is putUsage (D59). The persisted profile would mask the
// digits in a model id, so usage rows are checked by UsageRowSchema instead,
// which allows only a model spec, an agent name, a fixed purpose and numbers.
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
import { UsageRowSchema, type SubmissionUsage, type UsageRow } from '../types/usage.ts';
import {
  InputRequestSchema,
  InputResolutionSchema,
  QuestionIdSchema,
  ResolvedInputRequestSchema,
  type InputRequest,
  type InputResolution,
  type ResolvedInputRequest,
} from '../types/input-request.ts';
import {
  BlockIdSchema,
  BlockRecordSchema,
  ResolvedBlockSchema,
  type BlockRecord,
  type BlockResolution,
  type ResolvedBlock,
} from '../types/block.ts';
import type { TriageRequest } from '../types/request.ts';
import { StalledSchema } from '../types/stalled.ts';

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
  // Paused on a question for the requester (P6 §4.3). Not terminal; nothing runs.
  'needs_input',
  // Parked on a system that did not answer (D55). Not terminal; nothing runs
  // until `triage resume` sends the run on as a new submission.
  'blocked',
  'completed',
  'failed',
  // Stopped by a person (triage stop, POST /triage/:run_id/stop). Terminal
  // until a follow-up resumes the run.
  'stopped',
] as const;
export const RunPhaseSchema = v.picklist(RUN_PHASES);
export type RunPhase = v.InferOutput<typeof RunPhaseSchema>;

export const TERMINAL_PHASES: readonly RunPhase[] = ['completed', 'failed', 'stopped'];

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/**
 * The phases in which a process should be working on the run: the ones
 * stalled detection checks (D71). listRuns returns the stalled check's
 * inputs for these rows only.
 */
export const WORKING_PHASES: readonly RunPhase[] = ['dispatched', 'investigating'];

/** Optional detail recorded with a phase change. */
export type PhaseDetail = {
  /** Why the run failed, for example the error class name. Scanned before write. */
  readonly reason?: string;
  /**
   * The detached worker's pid, so status can tell a stalled run. Left out,
   * the recorded pid is kept; null clears it (a dispatch from a process that
   * is not a worker, D71).
   */
  readonly worker_pid?: number | null;
  /**
   * A stopped run stays stopped: setPhase leaves it alone unless resume is
   * set. Only a new follow-up submission sets it.
   */
  readonly resume?: boolean;
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
  /** The open question, while the run waits for the requester. */
  input_request: v.optional(InputRequestSchema),
  /** Closed questions with their resolutions, oldest first. */
  input_history: v.optional(v.array(ResolvedInputRequestSchema)),
  /** The open block, while the run is parked on a system that did not answer (D55). */
  block: v.optional(BlockRecordSchema),
  /** Closed blocks with their resolutions, oldest first. */
  block_history: v.optional(v.array(ResolvedBlockSchema)),
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

// 'steer' (D72): a note sent while the run is still working. Flue joins it
// into the live response at the next turn boundary, so it settles with it.
export const SUBMISSION_KINDS = ['initial', 'ask', 'answer', 'resume', 'steer'] as const;
export const SubmissionInputSchema = v.object({
  kind: v.picklist(SUBMISSION_KINDS),
  // The follow-up question of a `triage ask`, persisted profile.
  question: v.optional(v.string()),
  // An 'answer' submission: the input request it resolves and, unless it
  // was skipped, the answer text (persisted profile).
  question_id: v.optional(QuestionIdSchema),
  answer: v.optional(v.string()),
  // A 'resume' submission (D55): the block it closes, when the run was
  // blocked, and the note from the person who resumed (persisted profile).
  // A 'steer' submission (D72) carries the note only.
  block_id: v.optional(BlockIdSchema),
  note: v.optional(v.string()),
});
export type SubmissionInput = v.InferOutput<typeof SubmissionInputSchema>;

/**
 * Flue's submission id from the dispatch receipt: 'sub_' and a ULID, or
 * 'sub_ik_' and hex for a keyed dispatch. Checked by shape, not by the
 * persisted profile, which would mask the digit runs a ULID can hold.
 */
export const FLUE_SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const FlueSubmissionIdSchema = v.pipe(v.string(), v.regex(FLUE_SUBMISSION_ID_PATTERN));

export const SubmissionMetaSchema = v.object({
  ...SubmissionInputSchema.entries,
  seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
  created_at: TakenAtSchema,
  /**
   * Flue's id for this submission (D71), set once the dispatch receipt
   * arrives. Absent before that and on runs from before D71. Stalled
   * detection reads the submission's lease with it.
   */
  flue_submission_id: v.optional(FlueSubmissionIdSchema),
});
export type SubmissionMeta = v.InferOutput<typeof SubmissionMetaSchema>;

export type Submission = SubmissionMeta & {
  readonly report: Report | null;
  readonly report_md: string | null;
};

export const FEEDBACK_VERDICTS = ['correct', 'partial', 'wrong', 'pending'] as const;
export const FeedbackVerdictSchema = v.picklist(FEEDBACK_VERDICTS);
export type FeedbackVerdict = v.InferOutput<typeof FeedbackVerdictSchema>;

/**
 * A finding: '<key>.v<version>.<e|h|c><n>' for the nth evidence item,
 * hypothesis or code claim of one findings version (src/report/finding-refs.ts),
 * or 'root_cause' for the report's root cause.
 */
export const FINDING_ID_PATTERN = /^(?:(?:ssfb|atspl|rtl)\.v[1-9][0-9]*\.[eh]|code\.v[1-9][0-9]*\.c)[1-9][0-9]*$|^root_cause$/;
export const FindingIdSchema = v.pipe(v.string(), v.regex(FINDING_ID_PATTERN));

export const FINDING_VERDICTS = ['correct', 'partial', 'wrong'] as const;
export const FindingVerdictSchema = v.picklist(FINDING_VERDICTS);

/** A verdict on one finding. text is a copy of the finding, so learning needs no lookup later. */
export const FindingFeedbackSchema = v.object({
  id: FindingIdSchema,
  verdict: FindingVerdictSchema,
  note: v.optional(v.string()),
  text: v.optional(v.string()),
});
export type FindingFeedback = v.InferOutput<typeof FindingFeedbackSchema>;

export const FeedbackSchema = v.object({
  verdict: FeedbackVerdictSchema,
  actual_root_cause: v.optional(v.string()),
  faster_path: v.optional(v.string()),
  /** Free notes with an accept or reject. */
  notes: v.optional(v.string()),
  given_by: NonEmptyStringSchema,
  given_at: TakenAtSchema,
  interface: InterfaceSchema,
  /** The run's phase when the verdict was given; a verdict can come before the report. */
  phase: v.optional(RunPhaseSchema),
  /** The run's latest submission at the time. */
  submission_seq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** The submission whose report the verdict judged, when there was one. */
  report_seq: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** Set by a stop (Cancel): a reject with no notes that also stopped the run. */
  cancelled: v.optional(v.literal(true)),
  findings: v.optional(v.array(FindingFeedbackSchema)),
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
  /** The open question while the phase is needs_input; null otherwise. */
  readonly input_request: InputRequest | null;
  /** Closed questions, oldest first. */
  readonly input_history: readonly ResolvedInputRequest[];
  /** The open block while the phase is blocked; null otherwise. */
  readonly block: BlockRecord | null;
  /** Closed blocks, oldest first. */
  readonly block_history: readonly ResolvedBlock[];
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
  /** Token usage per submission, ordered by seq (0 = intake). Empty for runs from before D59. */
  readonly usage: readonly SubmissionUsage[];
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
  /** Sum of the priced usage rows; absent when the run has none. */
  usd_total: v.optional(v.pipe(v.number(), v.minValue(0))),
  /** Input, output, cache-read and cache-write tokens over every usage row; absent when the run has none. */
  tokens_total: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  /** Set when usd_total leaves out at least one row that has no price. */
  usd_partial: v.optional(v.literal(true)),
  /**
   * The stalled check's inputs (D71), on a dispatched or investigating row
   * only. GET /triage reads them and leaves them out of its answer.
   * flue_submission_id is the Flue id of the latest submission that is not
   * a steer; steer_flue_submission_id that of the latest steer after it
   * that has one; worker_pid the run's recorded worker pid.
   */
  flue_submission_id: v.optional(FlueSubmissionIdSchema),
  steer_flue_submission_id: v.optional(FlueSubmissionIdSchema),
  worker_pid: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  /** Set by GET /triage while the run is stalled (D71). A store never sets it. */
  stalled: v.optional(StalledSchema),
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
  /**
   * Moves the run to the phase. Returns false, and writes nothing, when the
   * run is stopped and detail.resume is not set.
   */
  setPhase(runId: RunId, phase: RunPhase, detail?: PhaseDetail): Promise<boolean>;
  /**
   * Compare-and-set: moves the run to the phase only when its current phase
   * is one of fromPhases, in one atomic step. Returns whether it wrote. The
   * reason and worker pid are written as setPhase writes them. detail.resume
   * is not read: fromPhases alone decides, so a stopped run is overwritten
   * only when 'stopped' is listed. Throws RunNotFoundError for an unknown
   * run, and RunStoreError for an empty or unknown phase list.
   */
  setPhaseIf(runId: RunId, fromPhases: readonly RunPhase[], phase: RunPhase, detail?: PhaseDetail): Promise<boolean>;
  /**
   * Opens a question for the requester and moves the run to phase
   * needs_input, clearing the phase reason. Throws InputRequestOpenError
   * while another question is open, and RunStoppedError on a stopped run.
   */
  putInputRequest(runId: RunId, request: Persisted<InputRequest>): Promise<void>;
  /**
   * Closes the open question with that id: it joins the history with the
   * resolution. The phase is left as it is; the caller moves it. Throws
   * InputRequestNotOpenError when no open question has that id.
   */
  resolveInputRequest(runId: RunId, questionId: string, resolution: Persisted<InputResolution>): Promise<void>;
  /**
   * Parks the run on a system that did not answer (D55): phase blocked,
   * phase reason cleared, the record kept as the open block. Throws
   * BlockOpenError while another block is open, InputRequestOpenError while
   * a question is open, and RunStoppedError on a stopped run.
   */
  putBlock(runId: RunId, block: Persisted<BlockRecord>): Promise<void>;
  /**
   * Closes the open block with that id: it joins the history with the
   * resolution. The phase is left as it is; the caller moves it. Throws
   * BlockNotOpenError when no open block has that id.
   */
  resolveBlock(runId: RunId, blockId: string, resolution: Persisted<BlockResolution>): Promise<void>;
  /**
   * Stops a run that has not finished: phase stopped with the reason, an
   * open question closed with the resolution, and an open block closed as
   * cancelled by the same person at the same time. Returns the phase the run
   * was in, or null when it had already finished, in which case nothing is
   * written.
   */
  markStopped(runId: RunId, reason: string, resolution: Persisted<InputResolution>): Promise<RunPhase | null>;
  putClassification(runId: RunId, record: Persisted<ClassificationRecord>): Promise<void>;
  /** Stores a new version of the findings for the key and returns it (1, 2, ...). */
  putEvidence(runId: RunId, key: EvidenceKey, findings: Persisted<Findings>): Promise<number>;
  /**
   * Records Flue's submission id on one submission, from its dispatch
   * receipt (D71). A second call replaces the id. Does not change the run's
   * updated_at. Throws RunNotFoundError for an unknown run, and
   * RunStoreError for an unknown submission or an id that is not Flue's shape.
   */
  setSubmissionFlueId(runId: RunId, seq: number, flueSubmissionId: string): Promise<void>;
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
  /**
   * Replaces the usage rows of one submission (seq 0 = intake) with a
   * snapshot; it never adds to them, so a retried write cannot double count.
   * A non-final write is skipped when that seq already holds final rows. Rows
   * are checked with UsageRowSchema, not the persisted profile (D59). Does not
   * change the run's updated_at. Throws RunNotFoundError for an unknown run.
   */
  putUsage(runId: RunId, seq: number, rows: readonly UsageRow[], final: boolean): Promise<void>;
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

/** A write that a stopped run refuses, such as a new question. */
export class RunStoppedError extends RunStoreError {
  override name = 'RunStoppedError';
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} was stopped`);
    this.runId = runId;
  }
}

/** putInputRequest while a question is open. */
export class InputRequestOpenError extends RunStoreError {
  override name = 'InputRequestOpenError';
  readonly runId: string;
  readonly questionId: string;
  constructor(runId: string, questionId: string) {
    super(`run ${runId} is already waiting on question ${questionId}`);
    this.runId = runId;
    this.questionId = questionId;
  }
}

/** resolveInputRequest for a question that is not the open one. */
export class InputRequestNotOpenError extends RunStoreError {
  override name = 'InputRequestNotOpenError';
  readonly runId: string;
  readonly questionId: string;
  constructor(runId: string, questionId: string) {
    super(`run ${runId} has no open question ${questionId}`);
    this.runId = runId;
    this.questionId = questionId;
  }
}

/** putBlock while a block is open (D55). */
export class BlockOpenError extends RunStoreError {
  override name = 'BlockOpenError';
  readonly runId: string;
  readonly blockId: string;
  constructor(runId: string, blockId: string) {
    super(`run ${runId} is already blocked (${blockId})`);
    this.runId = runId;
    this.blockId = blockId;
  }
}

/** resolveBlock for a block that is not the open one. */
export class BlockNotOpenError extends RunStoreError {
  override name = 'BlockNotOpenError';
  readonly runId: string;
  readonly blockId: string;
  constructor(runId: string, blockId: string) {
    super(`run ${runId} has no open block ${blockId}`);
    this.runId = runId;
    this.blockId = blockId;
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

/** Validates a store record. The error names the failing paths, never the values. */
export function parseRecord<S extends v.GenericSchema>(schema: S, value: unknown, label: string): v.InferOutput<S> {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  const paths = [...new Set(result.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
  throw new RunStoreError(`invalid ${label}: ${paths.join(', ')}`);
}

export function positiveInt(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RunStoreError(`invalid ${label}`);
  return n;
}

/** The checks setPhase and setPhaseIf run before anything is written. */
export function checkPhaseChange(phase: RunPhase, detail: PhaseDetail): void {
  parseRecord(RunPhaseSchema, phase, 'phase');
  if (detail.reason !== undefined) assertClean(detail.reason, 'phase reason');
  if (detail.worker_pid !== undefined && detail.worker_pid !== null) positiveInt(detail.worker_pid, 'worker pid');
}

/** The largest value of a Postgres integer column, the type of every usage count. Both providers refuse more. */
export const MAX_USAGE_COUNT = 2_147_483_647;

const UsageRowsSchema = v.array(UsageRowSchema);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Byte order of model, agent and purpose: the order both providers store and return usage rows in. */
export function byUsageKey(a: UsageRow, b: UsageRow): number {
  return byText(a.model, b.model) || byText(a.agent, b.agent) || byText(a.purpose, b.purpose);
}

/**
 * Checks a putUsage call before anything is written (D59). Rows go through
 * UsageRowSchema, not the persisted profile, so a model id keeps its digits
 * and a masked one is refused. Errors name paths, never values. Returns the
 * rows sorted by model, agent and purpose.
 */
export function checkUsage(seq: number, rows: readonly UsageRow[], final: boolean): { seq: number; rows: UsageRow[] } {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RunStoreError('invalid usage seq');
  if (typeof final !== 'boolean') throw new RunStoreError('invalid usage final flag');
  const checked = parseRecord(UsageRowsSchema, rows, 'usage rows');
  checked.forEach((row, i) => {
    const counts = [row.calls, row.failed_calls, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens];
    if (counts.some((n) => n > MAX_USAGE_COUNT)) throw new RunStoreError(`invalid usage rows: ${i} has a count above ${MAX_USAGE_COUNT}`);
  });
  const keys = new Set(checked.map((r) => `${r.model} ${r.agent} ${r.purpose}`));
  if (keys.size !== checked.length) throw new RunStoreError('usage rows repeat a model, agent and purpose');
  return { seq, rows: checked.sort(byUsageKey) };
}

export function assertQuestionId(questionId: string): string {
  if (!v.is(QuestionIdSchema, questionId)) throw new RunStoreError('invalid question id');
  return questionId;
}

/** A setPhaseIf phase list: at least one phase, each a known one. Duplicates are dropped. */
export function assertPhaseList(phases: readonly RunPhase[]): RunPhase[] {
  if (!Array.isArray(phases) || phases.length === 0) throw new RunStoreError('invalid phase list');
  for (const phase of phases) {
    if (!v.is(RunPhaseSchema, phase)) throw new RunStoreError('invalid phase list');
  }
  return [...new Set(phases)];
}

export function assertFlueSubmissionId(id: string): string {
  if (!v.is(FlueSubmissionIdSchema, id)) throw new RunStoreError('invalid flue submission id');
  return id;
}

export function assertBlockId(blockId: string): string {
  if (!v.is(BlockIdSchema, blockId)) throw new RunStoreError('invalid block id');
  return blockId;
}

/**
 * How markStopped closes an open block: cancelled by the person who stopped
 * the run, at the same time. The fields come from the persisted resolution
 * the caller passed, so they carry persisted-profile text.
 */
export function cancelledBlockResolution(resolution: InputResolution): BlockResolution {
  return { status: 'cancelled', resolved_at: resolution.resolved_at, resolved_by: resolution.resolved_by };
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
