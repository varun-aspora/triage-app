// The submission pipeline: from a prepared request to a settled Triage run
// (LLD 04 §1, §2.4, §3; HLD 02 §1.5; D9, D22, D24, D36, D43).
//
// runSubmission(prepared, deps) runs, in order:
//   1. store.createRun with the persisted-profile copy of the request (the
//      ingress names included in the scan). The raw thread never reaches the
//      store.
//   2. Pre-flight and, when due, the repo sync (D47), side by side; both are
//      skipped in mock mode. The run waits for them. Warnings are kept,
//      never fatal.
//   3. The ingress identity step: the ids are read from the thread by the
//      decision model, or by the template labels (D69), and resolved. Its
//      'identity' event says which path ran, the masked decision error,
//      the per-field probabilities and the candidate counts, never a value.
//      An unreachable database comes back as
//      unreachable hops; any other non-loud failure becomes an empty chain and
//      a gap. Strict fixture misses, aborts and malformed core results throw.
//   4. The classifier on the model-facing thread, then the known-pattern
//      match, then the tier policy. A classifier failure ends as category
//      unknown and tier strong, and the run is still dispatched.
//   5. store.putClassification with the decision, the id chain and the
//      warnings, and prior cases when TRIAGE_PRIOR_CASES=true.
//   6. A new submission, then init(Triage, { id: run_id, uid: null })
//      .dispatch({ message, initialData }). Flue 2.0.8 puts the uid send
//      condition on init(), not on the handle's dispatch(), so uid: null goes
//      there: an existing instance with this id rejects instead of being
//      continued.
//   7. handle.read(receipt), then phase completed, or failed with the error
//      class name. Evidence already stored is left as it is.
//   8. embedRun after the settle. Its gaps are returned and never change the
//      run's status.
//
// Usage (D59). The usage meter (src/usage/meter.ts) counts the model calls;
// this module writes them to the store:
// - intake (seq 0): the id decision call (agent identity), the classifier
//   call (agent classifier) and the prior-cases embedding are recorded into
//   the run's intake bucket, and a finally around the
//   pre-dispatch steps writes them as seq 0, final, on success, failure and
//   stop alike, then forgets them. answerRun, askRun and resumeRun do not
//   classify, so they have no intake rows.
// - each submission: once the receipt gives the Flue submissionId, a timer
//   writes the rows so far, not final, every TRIAGE_USAGE_FLUSH_MS when they
//   changed (0 turns it off; ticks never overlap; the timer is unref'd). At
//   the settle the timer is stopped and any write in flight awaited, then the
//   rows are written final for every status, before embedAfterSettle. The
//   embedding after the settle is counted on the same submission and the
//   rows are written final again. A caller abort writes what is there, not
//   final, and keeps the rows in memory, because the run goes on.
// - turns that carried no submissionId are logged as usage_unassigned
//   (counts only) and dropped.
// - in mock mode the hash embedder's calls are recorded under the model
//   HASH_USAGE_MODEL, a faux/* spec, so the run's usage shows as fake.
// A failed usage write logs usage_write_failed or usage_flush_failed with
// the error's class name and never changes the run's status.
//
// Every step records a phase: preflight, identity, classifying, dispatched,
// investigating, then completed or failed (or needs_input or blocked, when a
// tool parked the run). investigating is written only while the run is still
// dispatched, so a tool that parked the run before it keeps its phase. The
// settle writes completed or failed with the compare-and-set the settle
// listener uses (D70), from dispatched or investigating only, so of the two
// only the first writes, and only the one that wrote embeds.
//
// Screenshots (D36): Flue's dispatch message takes image parts
// ({ kind: 'user', body, attachments: [{ type: 'image', data, mimeType }] }),
// so images are sent inline when the tier_final model accepts images. The
// sandbox fallback (/data/attachments/<n>.<ext>) is not needed and not built.
// When the tier model is text-only the images are dropped, the decision gets
// images_dropped, and a warning tells the report that screenshots were not
// analysed.
//
// Gaps with no other home (identity gaps, dropped screenshots, prior-case
// retrieval) go into preflight_warnings with their own step name, because
// that is the list the report copies into its gaps.
//
// askRun(run_id, question, by, deps) adds a follow-up submission on the same
// Flue instance, without initialData, and settles it the same way.
//
// A response can also end on ask_requester (P6 §4.3): the tool stores the
// question and moves the run to needs_input, and read() returns as for a
// completed response. dispatchAndSettle checks the store after the read and
// reports status needs_input with the question instead of completed; the
// phase is left as the tool set it and nothing is embedded yet.
//
// answerRun(run_id, input, deps) is the way back: it closes the open
// question with who answered (or skipped) and when, and dispatches the
// answer as a triage.input_answer signal on the same instance. Ids the
// person gave go through the ingress identity step first, and the resulting
// chain rides in the signal's attributes, where the root merges it into the
// run's scope (D26). Free text never widens scope.
//
// A response can also end on stop_blocked (D55): the tool stores the block
// and moves the run to blocked, and read() returns as for a completed
// response. dispatchAndSettle reports status blocked with the block; the
// phase is left as the tool set it, no report exists and nothing is embedded.
//
// resumeRun(run_id, input, deps) sends a parked run on: it closes the open
// block as resumed (who, when, the note) and dispatches a triage.resume
// signal on the same instance, as a submission of kind resume. It also takes
// a run that failed after it was dispatched, and a stopped run, because
// their conversations exist. A run that failed before dispatch has none, so
// resumeRun refuses it and points at a new run (RunNotResumableError).
// Before it writes anything, resumeRun repeats the tunnel part of pre-flight
// when the deps carry it (D56): in local mode the SSFB tunnel may have died
// while the run was parked, and a tunnel that does not come up refuses the
// resume (ResumeNotReadyError, a RunNotResumableError) with the run left as
// it was.
//
// resumeRun also takes a run that is still working, dispatched or
// investigating (D72). It reads the run's stalled signal (D71) first:
//   - not stalled: the person's message is a steer. It is stored as a
//     submission of kind steer and dispatched to the same instance as a user
//     message, like a follow-up. Flue joins it into the live response at the
//     next turn boundary: after the tool calls of the turn in flight have
//     run, and before the next model call, so no tool call is cut short or
//     skipped. It settles with that response. The steer writes no phase and
//     no worker pid before the read. After it, Flue's lease for the steer
//     says whether it joined (joinedInto), or, when there is no lease to
//     read, the usage meter does: a steer that ran its own response has its
//     own turns. A joined steer leaves the phase, the usage and the embedding
//     to the host's settle and only reports the outcome. A steer that missed
//     the live response (the host settled first) runs as its own response,
//     an ordinary follow-up: the settle listener shows the run investigating
//     once Flue starts it (D70), and its settle writes the phase with the
//     same compare-and-set the listener uses, so it overwrites no question,
//     no block and nothing a later follow-up owns. A steer needs a message.
//   - stalled: the run is stopped with reason 'stalled' and no verdict (a
//     person did not reject it), only if it is still in the phase it was
//     judged stalled in; a run that moved on is judged once more from its
//     new phase. Flue is asked to abort the instance, and the resume waits,
//     up to STALLED_ABORT_WAIT_MS, for the aborted submission to settle,
//     then one stop poll more, with the run stopped all along. A late settle
//     of the old submission is then refused by the store or ignored by the
//     settle listener (D70), and a reader in another process has seen the
//     stop. Then it resumes as for a stopped run, on the same instance and
//     conversation.
// The mode ('steer' or 'resume') is told to deps.onResumeMode before
// anything is dispatched and returned on the result.
//
// A run can be stopped from another process (src/ingress/stop.ts). While a
// run works, the pipeline reads the store every STOP_POLL_MS; once the phase
// is stopped it aborts its own steps and, after dispatch, the Flue instance.
// The store refuses phase writes on a stopped run (setPhase returns false),
// which catches a stop that lands between two polls. A stop before dispatch
// makes runSubmission throw RunStoppedError; after dispatch the result has
// status stopped. A follow-up (askRun) or a resume (resumeRun) moves a
// stopped run on.
//
// The CLI and the HTTP routes both submit through these functions.
// submissionDeps() builds the production deps from the Triage runtime.
import { readFile } from 'node:fs/promises';
import {
  type Agent,
  type AgentHandleDispatchRequest,
  AgentRunError,
  type AgentInstanceHandle,
  type AgentReadOptions,
  type DeliveredAttachment,
  type DeliveredMessage,
  type InitOptions,
  init,
} from '@flue/runtime';
import * as v from 'valibot';
import { triageRuntime, type TriageRuntime } from '../agents/triage-plan.ts';
import { Triage } from '../agents/triage.agent.ts';
import {
  type ClassifierUsage,
  classify as classifyThread,
  type ClassifyInput,
  unknownClassification,
} from '../classify/classify.ts';
import { loadPatterns, matchPattern, type Pattern } from '../classify/patterns.ts';
import { applyTierPolicy, toTierDecision, type TierPolicyContext, type TierPolicyResult } from '../classify/policy.ts';
import type { Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import { knownIdFieldsFor } from '../config/known-ids.ts';
import type { Registry } from '../config/registry.ts';
import { infraRepoNames, loadRepos } from '../config/repos.ts';
import { createExecRunner, type ExecRunner } from '../connectors/exec.ts';
import { errorText, safeErrorText, scrubSecrets, stripAddresses } from '../connectors/error-text.ts';
import { mockPortFromFixtures } from '../connectors/mock.ts';
import { ConnectorError } from '../connectors/types.ts';
import { pidAlive } from '../cli/commands/status.command.ts';
import { submissionLease, type SubmissionLease, type SubmissionLeaseReader } from '../db/submission-lease.ts';
import { decisionProviderFor } from '../decisions/registry.ts';
import { createEmbedder, type EmbedUsage, type Embedder, type FetchLike, HASH_MODEL } from '../embed/index.ts';
import { createJsonlAuditSink } from '../gate/audit-sink.ts';
import { checkEgress, redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { createMockLayer } from '../mock/index.ts';
import { acceptsImages, modelForTier } from '../models.ts';
import { netTcpConnect } from '../ops/doctor/probes.ts';
import { runPreflight, runTunnelPreflight, type PreflightInput, type PreflightResult } from '../ops/preflight.ts';
import { syncBeforeRun } from '../ops/repos-autosync.ts';
import type { TcpProbe } from '../ops/tunnel.ts';
import { logRunEvent, setRunRedactionNames } from '../runlog/event-log.ts';
import { embedRun as defaultEmbedRun } from '../runstore/embed-run.ts';
import { priorCasesFor, type PriorCasesResult } from '../runstore/prior-cases.ts';
import {
  type PhaseDetail,
  RunNotFoundError,
  WORKING_PHASES,
  type RunPhase,
  type RunRecord,
  RunStoppedError,
  type RunStore,
  type SubmissionInput,
} from '../runstore/types.ts';
import { BLOCK_RESUME_SIGNAL, type BlockRecord, MAX_RESUME_NOTE_CHARS } from '../types/block.ts';
import {
  type Classification,
  type PreflightWarning,
  type PriorCase,
  type TriageInit,
  TriageInitSchema,
} from '../types/classification.ts';
import { type Entity, type Interface, type KnownIds, RunIdSchema, type RunId, type Tier } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
import { INPUT_ANSWER_CHAIN_ATTR, INPUT_ANSWER_SIGNAL, type InputRequest, QuestionIdSchema } from '../types/input-request.ts';
import type { Attachment, TriageRequest } from '../types/request.ts';
import type { Stalled } from '../types/stalled.ts';
import type { UsageRow } from '../types/usage.ts';
import {
  dropIntake,
  dropSubmission,
  recordUsage,
  snapshotIntake,
  snapshotSubmission,
  takeUnassigned,
  type UsageBucket,
  usageVersion,
} from '../usage/meter.ts';
import { type IdentityUsage, type IngressIdentity, NO_IDS_GAP, resolveIngressIdentity } from './identity.ts';
import { IngressInputError } from './normalise.ts';
import type { PreparedSubmission } from './prepare.ts';
import { renderAnswer, renderAsk, renderResume, renderSteer, renderThread, type RenderImages, type ResumeFrom } from './render-thread.ts';
import { currentLease, DEFAULT_STALLED_AFTER_MS, loadStalled, STALLABLE_PHASES, stalledSubjectOf } from './stalled.ts';

// ------------------------------------------------------------------ types

export type SubmissionConfig = {
  readonly mock: Pick<Config['mock'], 'enabled'>;
  /** usageFlushMs left out: DEFAULT_USAGE_FLUSH_MS. */
  readonly runs: Pick<Config['runs'], 'priorCases'> & Partial<Pick<Config['runs'], 'usageFlushMs'>>;
  readonly budgets: Pick<Config['budgets'], 'runTimeoutMs' | 'runMaxAttempts'>;
};

/** The parts of Flue's instance handle the pipeline uses. */
export type AgentHandle = Pick<AgentInstanceHandle, 'dispatch' | 'read' | 'abort'>;

/** Flue's init(), injectable so tests use a fake. */
export type Dispatcher = { init(agent: Agent, options: InitOptions): AgentHandle };

export type EmbedRunFn = typeof defaultEmbedRun;

/** Calls tick every ms until the returned function is called. The live usage flush takes it; tests inject one. */
export type UsageFlushTimer = (tick: () => void, ms: number) => () => void;

/** What dispatch, read and the settle need. askRun takes only these. */
export type SettleDeps = {
  readonly config: SubmissionConfig;
  readonly store: RunStore;
  readonly dispatcher: Dispatcher;
  /** The Triage root agent. */
  readonly agent: Agent;
  /** null when MODEL_EMBEDDING is blank. */
  readonly embedder: Embedder | null;
  /** Defaults to embedRun from src/runstore/embed-run.ts. */
  readonly embedRun?: EmbedRunFn;
  /** Stops the local wait only. The run itself keeps going (use abort for that). */
  readonly signal?: AbortSignal;
  /** Passed to read(): every conversation chunk as it is recorded. */
  readonly onEvent?: AgentReadOptions['onEvent'];
  /** How long read() may wait. Default: run timeout x attempts, plus a minute. */
  readonly readTimeoutMs?: number;
  /** How often the store is read for a stop. Default STOP_POLL_MS; 0 turns the check off. */
  readonly stopPollMs?: number;
  /** Clock for the answer's resolution time. Defaults to the system clock. */
  readonly now?: () => Date;
  /**
   * The part of pre-flight a resume repeats (D56): the SSFB tunnel in local
   * mode. A tunnel warning refuses the resume (ResumeNotReadyError) before
   * anything is written. Left out: no check. Not called in mock mode.
   */
  readonly resumePreflight?: (input: { readonly signal: AbortSignal }) => Promise<Pick<PreflightResult, 'steps' | 'warnings'>>;
  /** Drives the live usage flush (D59). Defaults to an unref'd setInterval. */
  readonly usageFlushTimer?: UsageFlushTimer;
  /**
   * The run's stalled signal (D71), which a resume of a working run reads
   * (D72). Left out: loadStalled with the key's default wait and this
   * process's Flue leases, without the event log.
   */
  readonly stalled?: (run: RunRecord) => Promise<Stalled | null>;
  /** Told whether a resume steers the run or resumes it, once that is decided and before anything is dispatched. */
  readonly onResumeMode?: (mode: ResumeMode) => void;
  /** Reads a Flue submission's lease, to tell whether a steer joined. Defaults to this process's (submissionLease). */
  readonly lease?: SubmissionLeaseReader;
  /** How long a resume of a stalled run waits for the aborted submission to settle. Default STALLED_ABORT_WAIT_MS. */
  readonly stalledAbortWaitMs?: number;
  /**
   * The CLI worker's pid. Written with the dispatched phase of a submission
   * that is not a steer (D72), so the worker that resumes a stalled run
   * records its pid only after the stalled check, and a steer never takes
   * the pid of the process that works on the run. Left out, that phase
   * write clears the recorded pid (D71), which belonged to an earlier
   * submission.
   */
  readonly workerPid?: number;
};

export type SubmissionDeps = SettleDeps & {
  /** Pre-flight for every enabled entity. Not called in mock mode. */
  readonly preflight: (input: { readonly signal: AbortSignal }) => Promise<Pick<PreflightResult, 'warnings'>>;
  /**
   * Syncs the repos when due for this interface (D47), then fetches the deploy
   * manifests repos of every enabled entity. Not called in mock mode. Left out: no sync.
   */
  readonly repoSync?: (input: { readonly interface: Interface; readonly signal: AbortSignal }) => Promise<readonly PreflightWarning[]>;
  readonly identity: (
    request: Pick<TriageRequest, 'request_id' | 'interface' | 'messages' | 'hints'>,
    opts: {
      readonly redactionNames: readonly string[];
      readonly signal: AbortSignal;
      /** Hears the id decision call, for the run's intake usage (D59). */
      readonly onUsage?: (u: IdentityUsage) => void;
    },
  ) => Promise<IngressIdentity>;
  /** onUsage hears the model call, for the run's intake usage (D59). */
  readonly classify: (input: ClassifyInput, signal: AbortSignal, onUsage?: (u: ClassifierUsage) => void) => Promise<Classification>;
  /** Defaults to applyTierPolicy. */
  readonly policy?: (raw: unknown, ctx: TierPolicyContext) => TierPolicyResult;
  /** Whether the model behind a tier accepts image input (D36). Must not throw. */
  readonly tierAcceptsImages: (tier: Tier) => boolean;
  /** knowledge/patterns/patterns.json. Missing or failing means no pattern match. */
  readonly patterns?: () => Promise<readonly Pattern[]>;
  /** The service names of the likely entities, for the pattern match. */
  readonly servicesFor?: (entities: readonly Entity[]) => readonly string[];
  /** Called only when TRIAGE_PRIOR_CASES=true. onUsage goes to the embed call, for the intake usage (D59). */
  readonly priorCases: (runId: RunId, signal: AbortSignal, onUsage?: (u: EmbedUsage) => void) => Promise<PriorCasesResult>;
  /** Reads an attachment's bytes from its bytes_ref. */
  readonly readAttachment: (bytesRef: string, signal: AbortSignal) => Promise<Uint8Array>;
};

export type SubmissionStatus = 'completed' | 'failed' | 'needs_input' | 'blocked' | 'stopped';

/** What a resume did (D72): steered a working run with the message, or resumed a run that had settled, parked, stopped or stalled. */
export type ResumeMode = 'steer' | 'resume';

export type SubmissionResult = {
  readonly run_id: RunId;
  readonly status: SubmissionStatus;
  /** The run store's submission number (1, 2, ...). */
  readonly submission_seq: number;
  /** Flue's submission id from the dispatch receipt. */
  readonly submission_id: string;
  /** The final assistant text, when completed. */
  readonly reply_text?: string;
  /** The error class name, when failed. */
  readonly error?: string;
  /** The question the run paused on, when needs_input. */
  readonly input_request?: InputRequest;
  /** The block the run parked on, when blocked. */
  readonly block?: BlockRecord;
  /** Things that did not happen after the settle, such as embeddings. */
  readonly gaps: readonly string[];
  /** resumeRun only: whether it steered the run or resumed it (D72). */
  readonly mode?: ResumeMode;
  /** A steer only: true when Flue joined it into the live response, false when it ran as its own response. */
  readonly joined?: boolean;
};

/** read() waited longer than the read timeout. The run was asked to abort. */
export class SubmissionReadTimeoutError extends Error {
  override readonly name = 'SubmissionReadTimeoutError';
  constructor(ms: number) {
    super(`gave up waiting for the run after ${ms} ms`);
  }
}

/** The prepared submission does not hold together. A programming error. */
export class SubmissionInputError extends Error {
  override readonly name = 'SubmissionInputError';
}

/** answerRun on a run that is not waiting for an answer, or not on that question. */
export class RunNotWaitingError extends Error {
  override readonly name = 'RunNotWaitingError';
  readonly runId: string;
  readonly questionId?: string;
  constructor(runId: string, questionId?: string) {
    super(questionId === undefined ? `run ${runId} is not waiting for an answer` : `run ${runId} is not waiting on question ${questionId}`);
    this.runId = runId;
    if (questionId !== undefined) this.questionId = questionId;
  }
}

/** resumeRun on a run that is not blocked, failed after dispatch or stopped. The hint says what to do instead. */
export class RunNotResumableError extends Error {
  override readonly name = 'RunNotResumableError';
  readonly runId: string;
  readonly phase: RunPhase;
  readonly hint: string;
  constructor(runId: string, phase: RunPhase, hint: string) {
    super(`run ${runId} cannot be resumed (phase ${phase}): ${hint}`);
    this.runId = runId;
    this.phase = phase;
    this.hint = hint;
  }
}

/**
 * A resume refused because the network path is not back (D56): the SSFB
 * tunnel did not come up. The run is left as it was; the hint carries the
 * tunnel warning and its fix. Handled wherever RunNotResumableError is.
 */
export class ResumeNotReadyError extends RunNotResumableError {
  readonly warnings: readonly PreflightWarning[];
  constructor(runId: string, phase: RunPhase, warnings: readonly PreflightWarning[]) {
    super(runId, phase, resumeNotReadyHint(warnings));
    this.warnings = warnings;
  }
}

function resumeNotReadyHint(warnings: readonly PreflightWarning[]): string {
  const w = warnings[0];
  if (w === undefined) return 'the network path is not ready';
  return w.fix === undefined ? w.message : `${w.message}; ${w.fix}`;
}

/** Why a resume cannot go on yet, from the resume pre-flight, or null. Only a tunnel warning refuses. */
export function resumeReadinessRefusal(
  run: Pick<RunRecord, 'run_id' | 'phase'>,
  ready: Pick<PreflightResult, 'warnings'>,
): ResumeNotReadyError | null {
  const tunnel = ready.warnings.filter((w) => w.step === 'tunnel');
  return tunnel.length === 0 ? null : new ResumeNotReadyError(run.run_id, run.phase, tunnel);
}

/** The hints RunNotResumableError carries. The CLI and the HTTP routes reuse them. */
export const RESUME_HINTS = {
  starting: 'the run has not started its investigation yet; follow it with triage wait',
  running: 'the run is still working and is not stalled; add a message to steer it, or follow it with triage wait',
  needs_input: 'answer it with triage input',
  completed: 'ask a follow-up with triage ask',
  never_started: 'the run never started an investigation; start a new run',
  in_progress: 'another resume of this run is still starting; wait a moment and look at the run again',
} as const;

/** What resumeRefusal needs to refuse a steer with nothing to say: the message, and the run's stalled signal. */
export type SteerCheck = {
  readonly note?: string;
  readonly stalled: Stalled | null;
};

/**
 * Why a stored run cannot be resumed, or null when it can: blocked, failed
 * or stopped after it was dispatched, or still working after its dispatch
 * (D72: steered, or stopped and resumed when stalled). Without a submission
 * there is no conversation to continue. Given the steer check, a working run
 * that is not stalled is refused when the message is blank; without it that
 * is left to resumeRun. A run another resume is taking over (stalledStopInFlight)
 * is refused with RESUME_HINTS.in_progress, in any process.
 */
export function resumeRefusal(run: ResumeRefusalRun, steer?: SteerCheck, now: number = Date.now()): RunNotResumableError | null {
  switch (run.phase) {
    case 'blocked':
      return null;
    case 'failed':
    case 'stopped':
      if (run.submissions.length === 0) return new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.never_started);
      return stalledStopInFlight(run, now) ? new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.in_progress) : null;
    case 'dispatched':
    case 'investigating':
      if (run.submissions.length === 0) return new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.starting);
      if (steer !== undefined && steer.stalled === null && (steer.note ?? '').trim() === '') {
        return new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.running);
      }
      return null;
    case 'needs_input':
      return new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.needs_input);
    case 'completed':
      return new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.completed);
    default:
      return new RunNotResumableError(run.run_id, run.phase, RESUME_HINTS.starting);
  }
}

/** What resumeRefusal reads from a run. updated_at and phase_reason tell a stalled stop in flight. */
export type ResumeRefusalRun = Pick<RunRecord, 'run_id' | 'phase' | 'submissions'> & Partial<Pick<RunRecord, 'phase_reason' | 'updated_at'>>;

/** The phase reason of a run a resume stopped because it had stalled (D72). */
export const STALLED_STOP_REASON = 'stalled';

/** How long a resume of a stalled run waits for the aborted submission to settle: two of Flue's recovery scans. */
export const STALLED_ABORT_WAIT_MS = 30_000;

/**
 * How long a run stopped as stalled counts as another resume's stop in
 * flight: twice the abort wait, which covers the wait, the stop poll after
 * it and the dispatch.
 */
export const STALLED_STOP_HOLD_MS = 2 * STALLED_ABORT_WAIT_MS;

/**
 * True while a run stopped as stalled belongs to the resume that stopped it
 * (D72): stopped with reason 'stalled', no submission added since the stop
 * (the stop is the run's latest updated_at, and adding a submission does not
 * move it), and the stop less than STALLED_STOP_HOLD_MS old. That resume
 * sends it on without asking again, so any other resume, in this process or
 * another, is refused. A stop left over (the resume added its submission and
 * then failed, or its process died) is resumable once the hold has passed;
 * a resume that fails after its stop writes failed, which is resumable at once.
 */
export function stalledStopInFlight(run: ResumeRefusalRun, now: number): boolean {
  if (run.phase !== 'stopped' || run.phase_reason !== STALLED_STOP_REASON || run.updated_at === undefined) return false;
  const stoppedAt = Date.parse(run.updated_at);
  if (!Number.isFinite(stoppedAt)) return false;
  if (run.submissions.some((sub) => Date.parse(sub.created_at) > stoppedAt)) return false;
  // A stop stamped a little ahead of this clock (another host) is recent too.
  return now - stoppedAt < STALLED_STOP_HOLD_MS;
}

/** Extra wait on top of the run's own deadline before read() gives up. */
export const READ_GRACE_MS = 60_000;

/** How often a working run reads the store for a stop from another process. */
export const STOP_POLL_MS = 2000;

/** The live usage interval when the config leaves it out; the TRIAGE_USAGE_FLUSH_MS default. */
export const DEFAULT_USAGE_FLUSH_MS = 10_000;

/** The model recorded for the mock hash embedder's calls: faux/*, so the usage view marks the run fake. */
export const HASH_USAGE_MODEL = 'faux/hash-embed';

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
const NO_IMAGES_REASON = 'the model for this tier does not accept images';

// ------------------------------------------------------------------ submit

export async function runSubmission(prepared: PreparedSubmission, deps: SubmissionDeps): Promise<SubmissionResult> {
  const runId = prepared.run_id;
  const request = prepared.request;
  if (!v.is(RunIdSchema, runId)) throw new SubmissionInputError('run_id is not a run id');
  if (request.request_id !== runId) throw new SubmissionInputError('run_id must equal request.request_id');
  const names = [...prepared.redaction_names];
  const store = deps.store;

  const persistedRequest = redactPersisted(request, { names });
  await store.createRun(runId, persistedRequest);
  setRunRedactionNames(runId, names);
  logRunEvent(runId, 'run_created', {
    interface: request.interface,
    messages: request.messages.length,
    attachments: request.attachments.length,
    hints: request.hints,
  });

  const watch = watchStop(store, runId, deps.stopPollMs);
  const signal = AbortSignal.any([deps.signal ?? new AbortController().signal, watch.signal]);
  let initialData: TriageInit;
  let images: DeliveredAttachment[];
  let render: RenderImages;
  try {
    const warnings: PreflightWarning[] = [];

    await advance(store, runId, 'preflight');
    if (!deps.config.mock.enabled) {
      // Every enabled entity, not only the ones the request names: the names
      // are where the agent starts, and it may brief any enabled entity.
      const started = Date.now();
      const [pf, repos] = await Promise.all([
        deps.preflight({ signal }),
        deps.repoSync?.({ interface: request.interface, signal }) ?? [],
      ]);
      warnings.push(...pf.warnings, ...repos);
      logRunEvent(runId, 'preflight', { durationMs: Date.now() - started, warnings: pf.warnings, repo_sync: repos });
    } else {
      logRunEvent(runId, 'preflight', { skipped: 'mock mode' });
    }

    await advance(store, runId, 'identity');
    const identityStarted = Date.now();
    const identity = await identityStep(request, names, deps, signal, identityUsageRecorder(runId));
    warnings.push(...identity.gaps.map((message) => warning('identity', message)));
    logRunEvent(runId, 'identity', {
      durationMs: Date.now() - identityStarted,
      id_chain: identity.id_chain,
      gaps: identity.gaps,
      ...(identity.extraction ?? {}),
    });

    const loaded = await loadImages(request.attachments, deps, signal);
    if (loaded.failed > 0) {
      warnings.push(warning('attachments', `${loaded.failed} screenshot(s) could not be read and were left out`));
    }

    await advance(store, runId, 'classifying');
    const classifyStarted = Date.now();
    const classification = await classifyStep(runId, request, identity, loaded.images, names, deps, signal);
    logRunEvent(runId, 'classifier', { durationMs: Date.now() - classifyStarted, classification });
    const patterns = await loadKnownPatterns(deps, warnings);
    const matched = withPatternMatch(classification, request, patterns, deps);
    const policy = deps.policy ?? applyTierPolicy;
    const result = policy(matched, {
      imageCapable: deps.tierAcceptsImages,
      hasImages: loaded.images.length > 0,
      patterns,
      ...(request.hints.tier !== undefined ? { override: { tier: request.hints.tier, by: request.requested_by } } : {}),
    });
    let decision = toTierDecision(result);

    const sendImages = loaded.images.length > 0 && safeAccepts(deps, decision.tier_final);
    images = sendImages ? loaded.images : [];
    render = { attached: images.length, dropped: sendImages ? 0 : loaded.images.length, dropReason: NO_IMAGES_REASON };
    if (!sendImages && loaded.images.length > 0) {
      decision = { ...decision, images_dropped: true };
      warnings.push(warning('attachments', `${loaded.images.length} screenshot(s) were not analysed: ${NO_IMAGES_REASON}`));
    }

    let priorCases: PriorCase[] | undefined;
    if (deps.config.runs.priorCases) {
      const pc = await deps.priorCases(runId, signal, embedUsageRecorder(runId, 'intake', 0, deps.embedder));
      priorCases = pc.cases.map((c) => ({ ...c }));
      warnings.push(...pc.gaps.map((message) => warning('prior_cases', message)));
    }

    await store.putClassification(
      runId,
      redactPersisted({ decision, id_chain: identity.id_chain, preflight_warnings: warnings }, { names }),
    );
    logRunEvent(runId, 'classification', { decision, warnings, prior_cases: priorCases?.length ?? null });

    initialData = v.parse(TriageInitSchema, {
      // The persisted copy, with the run id put back: the persisted profile
      // masks runs of digits, which a ULID can hold.
      request: { ...persistedRequest.value, request_id: runId },
      classification: decision,
      id_chain: identity.id_chain,
      preflight_warnings: warnings,
      redaction_names: names,
      ...(priorCases !== undefined ? { prior_cases: priorCases } : {}),
    });
  } catch (err) {
    watch.dispose();
    // A stop aborts the step that was running; whatever it threw, the run was stopped.
    if (watch.signal.aborted || err instanceof RunStoppedError) throw new RunStoppedError(runId);
    await recordFailed(store, runId, err);
    throw err;
  } finally {
    // seq 0 is kept on success, failure and stop alike.
    await writeUsage(store, runId, 0, snapshotIntake(runId), true);
    dropIntake(runId);
  }
  watch.dispose();

  const message: DeliveredMessage = {
    kind: 'user',
    body: renderThread(request, render),
    ...(images.length > 0 ? { attachments: images } : {}),
  };
  return dispatchAndSettle(
    runId,
    { kind: 'initial' },
    { message, initialData },
    { id: runId, uid: null },
    deps,
  );
}

// ------------------------------------------------------------------ ask

/** A follow-up question on an existing run: a new submission on the same Flue instance. */
export async function askRun(runId: string, question: string, by: string, deps: SettleDeps): Promise<SubmissionResult> {
  if (!v.is(RunIdSchema, runId)) throw new IngressInputError('run_id', 'is not a run id');
  if (typeof question !== 'string' || question.trim() === '') throw new IngressInputError('question', 'is empty');
  if (typeof by !== 'string' || by.trim() === '') throw new IngressInputError('by', 'is required');
  const run = await deps.store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  const message: DeliveredMessage = { kind: 'user', body: renderAsk(question.trim(), by.trim()) };
  // No initialData and no uid: the instance exists and is continued.
  return dispatchAndSettle(runId, { kind: 'ask', question: question.trim() }, { message }, { id: runId }, deps);
}

// ------------------------------------------------------------------ answer

export type AnswerInput = {
  /** Defaults to the open question. */
  readonly question_id?: string;
  /** Left out with skip. */
  readonly answer?: string;
  readonly skip?: boolean;
  /** Ids the person gave; resolved by the ingress identity step before they join the run's scope. */
  readonly ids?: Partial<KnownIds>;
  /** Who answered: an email, a Slack user id or the OS user. */
  readonly by: string;
};

/** answerRun needs the settle deps, plus the identity step when ids are given. */
export type AnswerDeps = SettleDeps & { readonly identity?: SubmissionDeps['identity'] };

/** The answer to the question a run is waiting on: closes it and resumes the run as a new submission. */
export async function answerRun(runId: string, input: AnswerInput, deps: AnswerDeps): Promise<SubmissionResult> {
  if (!v.is(RunIdSchema, runId)) throw new IngressInputError('run_id', 'is not a run id');
  const by = typeof input.by === 'string' ? input.by.trim() : '';
  if (by === '') throw new IngressInputError('by', 'is required');
  const skip = input.skip === true;
  const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
  if (skip && answer !== '') throw new IngressInputError('answer', 'must be empty with skip');
  if (!skip && answer === '') throw new IngressInputError('answer', 'is empty');
  if (input.question_id !== undefined && !v.is(QuestionIdSchema, input.question_id)) throw new IngressInputError('question_id', 'is not a question id');

  const run = await deps.store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  const open = run.input_request;
  if (open === null) throw new RunNotWaitingError(runId);
  const questionId = input.question_id ?? open.question_id;
  if (questionId !== open.question_id) throw new RunNotWaitingError(runId, questionId);

  const signal = deps.signal ?? new AbortController().signal;
  const ids = input.ids ?? {};
  let chain: IdChain | undefined;
  const gaps: string[] = [];
  if (Object.keys(ids).length > 0) {
    if (deps.identity === undefined) throw new SubmissionInputError('ids need the identity step in the deps');
    const identity = await identityStep(
      { request_id: runId, interface: run.request.interface, messages: [], hints: { ids } },
      [],
      deps as Pick<SubmissionDeps, 'identity'>,
      signal,
    );
    chain = identity.id_chain;
    gaps.push(...identity.gaps.filter((g) => g !== NO_IDS_GAP));
  }

  const now = deps.now ?? (() => new Date());
  await deps.store.resolveInputRequest(
    runId,
    questionId,
    redactPersisted({ status: skip ? 'skipped' : 'answered', resolved_at: now().toISOString(), resolved_by: by }),
  );

  const message: DeliveredMessage = {
    kind: 'signal',
    type: INPUT_ANSWER_SIGNAL,
    body: renderAnswer(open, { skip, answer, by, ids: chain?.ids ?? {}, gaps }),
    attributes: {
      question_id: questionId,
      ...(chain !== undefined ? { [INPUT_ANSWER_CHAIN_ATTR]: JSON.stringify(chain) } : {}),
    },
  };
  return dispatchAndSettle(
    runId,
    { kind: 'answer', question_id: questionId, ...(skip ? {} : { answer }) },
    { message },
    { id: runId },
    deps,
  );
}

// ------------------------------------------------------------------ resume

export type ResumeInput = {
  /** Who resumed the run: an email, a Slack user id or the OS user. */
  readonly by: string;
  /** What was fixed, for the model and the record. Blank means none. */
  readonly note?: string;
};

/**
 * Sends a blocked run on (D55), or one that failed after dispatch, or a
 * stopped one: closes the open block as resumed and dispatches a
 * triage.resume signal on the same instance as a submission of kind resume.
 * A run that is still working is steered with the message, or, when it has
 * stalled, stopped and then resumed (D72).
 */
export async function resumeRun(runId: string, input: ResumeInput, deps: SettleDeps): Promise<SubmissionResult> {
  if (!v.is(RunIdSchema, runId)) throw new IngressInputError('run_id', 'is not a run id');
  const by = typeof input.by === 'string' ? input.by.trim() : '';
  if (by === '') throw new IngressInputError('by', 'is required');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > MAX_RESUME_NOTE_CHARS) throw new IngressInputError('note', `must be at most ${MAX_RESUME_NOTE_CHARS} characters`);

  const run = await deps.store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  return resumeStored(run, by, note, deps, true);
}

/** resumeRun from the stored run. replan: a run that settled on the way is looked at once more, from its new phase. */
async function resumeStored(run: RunRecord, by: string, note: string, deps: SettleDeps, replan: boolean): Promise<SubmissionResult> {
  const runId = run.run_id;
  const working = STALLABLE_PHASES.includes(run.phase);
  const stalled = working ? await stalledSignal(run, deps) : null;
  const refusal = resumeRefusal(run, { note, stalled });
  if (refusal !== null) throw refusal;
  if (working && stalled === null) return steerRun(run, by, note, deps, replan);

  // The network path first (D56): in local mode this brings the SSFB tunnel
  // back, and a tunnel that does not come up refuses the resume here, before
  // the block is closed or a stalled run is stopped, so the run stays as it was.
  if (deps.resumePreflight !== undefined && !deps.config.mock.enabled) {
    const ready = await deps.resumePreflight({ signal: deps.signal ?? new AbortController().signal });
    const notReady = resumeReadinessRefusal(run, ready);
    logRunEvent(runId, 'resume_preflight', {
      steps: ready.steps,
      warnings: ready.warnings,
      ...(notReady !== null ? { refused: notReady.hint } : {}),
    });
    if (notReady !== null) throw notReady;
  }

  deps.onResumeMode?.('resume');
  let from = run;
  if (stalled !== null) {
    const stopped = await stopStalled(run, stalled, by, deps);
    if (stopped === null) {
      // It moved on before the stop (it settled, parked on a question or a
      // block, or its owner came back): the same request is judged once more
      // from the new phase, so it is steered, resumed or refused as a request
      // made now would be.
      const latest = await deps.store.getRun(runId);
      if (latest === null) throw new RunNotFoundError(runId);
      if (!replan) throw resumeRefusal(latest) ?? new RunNotResumableError(runId, latest.phase, RESUME_HINTS.running);
      return resumeStored(latest, by, note, deps, false);
    }
    from = stopped;
  }

  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  // A run that failed after stop_blocked stored its block still has it open; it is closed too.
  const open = from.block;
  if (open !== null) {
    await deps.store.resolveBlock(
      runId,
      open.block_id,
      redactPersisted({ status: 'resumed' as const, resolved_at: at, resolved_by: by, ...(note !== '' ? { note } : {}) }),
    );
  }
  logRunEvent(runId, 'resume', {
    kind: 'resume',
    from: from.phase,
    ...(stalled !== null ? { stalled } : {}),
    ...(open !== null ? { block_id: open.block_id } : {}),
    by,
    ...(note !== '' ? { note } : {}),
  });

  const message: DeliveredMessage = {
    kind: 'signal',
    type: BLOCK_RESUME_SIGNAL,
    body: renderResume(resumeFrom(from, stalled), { by, at, note }),
  };
  const result = await dispatchAndSettle(
    runId,
    { kind: 'resume', ...(open !== null ? { block_id: open.block_id } : {}), ...(note !== '' ? { note } : {}) },
    { message },
    { id: runId },
    deps,
  );
  return Object.freeze({ ...result, mode: 'resume' as const });
}

// What the signal tells the model the run was doing. A blocked run whose
// block was closed but not sent on (a crash between the two writes) is
// described by its last block.
function resumeFrom(run: RunRecord, stalled: Stalled | null): ResumeFrom {
  const block = run.block ?? (run.phase === 'blocked' ? run.block_history.at(-1) : undefined);
  if (block !== undefined) return { kind: 'blocked', block };
  if (run.phase === 'stopped') {
    if (stalled !== null) return { kind: 'stopped', stalled: { reason: stalled.reason } };
    return run.phase_reason === STALLED_STOP_REASON ? { kind: 'stopped', stalled: {} } : { kind: 'stopped' };
  }
  return { kind: 'failed', ...(run.phase_reason !== undefined ? { reason: run.phase_reason } : {}) };
}

/** The run's stalled signal from deps.stalled, or loadStalled over this process's leases. Never throws. */
async function stalledSignal(run: RunRecord, deps: SettleDeps): Promise<Stalled | null> {
  try {
    if (deps.stalled !== undefined) return await deps.stalled(run);
    return await loadStalled(run, { stalledAfterMs: DEFAULT_STALLED_AFTER_MS, ...(deps.lease !== undefined ? { lease: deps.lease } : {}) });
  } catch {
    return null;
  }
}

/**
 * The steer (D72): the message goes to the working run as a submission of
 * kind steer, which Flue joins into the live response. A run that settled
 * while the stalled signal was read has no live response: it is resumed or
 * refused from its new phase instead.
 */
async function steerRun(run: RunRecord, by: string, note: string, deps: SettleDeps, replan: boolean): Promise<SubmissionResult> {
  const runId = run.run_id;
  const latest = await deps.store.getRun(runId);
  if (latest === null) throw new RunNotFoundError(runId);
  if (!STALLABLE_PHASES.includes(latest.phase)) {
    if (!replan) throw resumeRefusal(latest) ?? new RunNotResumableError(runId, latest.phase, RESUME_HINTS.running);
    return resumeStored(latest, by, note, deps, false);
  }
  deps.onResumeMode?.('steer');
  const now = deps.now ?? (() => new Date());
  logRunEvent(runId, 'resume', { kind: 'steer', from: latest.phase, by, note });
  // A user message, like a follow-up (askRun): the model reads it as the
  // person speaking, not as a framework event. renderSteer adds no
  // instructions of its own, and the fixed rules still bind.
  const message: DeliveredMessage = { kind: 'user', body: renderSteer({ by, at: now().toISOString(), note }) };
  const result = await dispatchAndSettle(runId, { kind: 'steer', note }, { message }, { id: runId }, deps);
  return Object.freeze({ ...result, mode: 'steer' as const });
}

/**
 * Stops a stalled run for its resume (D72): phase stopped with reason
 * 'stalled' and no verdict, then a durable Flue abort of the instance, then
 * a wait for the aborted submission to settle and one stop poll more. The
 * run stays stopped all along, so a late write of the old submission's
 * settle is refused and a reader in another process sees the stop.
 *
 * The stop is a compare-and-set on the phase the run was judged stalled in:
 * a run that moved on meanwhile (a question or a block a tool opened, a
 * settle, a follow-up that moved it to another working phase) is not
 * stopped. Returns the stopped run, or null when nothing was written. A run
 * in a working phase has no open question or block, so there is nothing for
 * markStopped to close.
 */
async function stopStalled(run: RunRecord, stalled: Stalled, by: string, deps: SettleDeps): Promise<RunRecord | null> {
  const runId = run.run_id;
  const from = run.phase;
  if (!(await deps.store.setPhaseIf(runId, [from], 'stopped', { reason: STALLED_STOP_REASON }))) return null;

  const handle = deps.dispatcher.init(deps.agent, { id: runId });
  let aborted = true;
  let abortError: string | undefined;
  try {
    await handle.abort();
  } catch (err) {
    // The resume still goes on: its dispatch queues behind the old submission until Flue settles it.
    aborted = false;
    abortError = className(err);
  }
  // The submission that was live, from the run as stored now (the record the
  // resume started from may predate the host's receipt): a steer's own
  // response when one ran, else the head's (D71).
  const stopped = await deps.store.getRun(runId);
  const live = await currentLease(stalledSubjectOf(stopped ?? run), deps.lease ?? submissionLease);
  const settle = aborted ? await abortSettled(handle, live?.flueSubmissionId, deps) : 'skipped';
  await delay(deps.stopPollMs ?? STOP_POLL_MS);
  logRunEvent(runId, 'stop', {
    by,
    reason: STALLED_STOP_REASON,
    stalled,
    stopped_from: from,
    aborted,
    abort_settled: settle,
    verdict: false,
    ...(abortError !== undefined ? { error: abortError } : {}),
  });
  const latest = await deps.store.getRun(runId);
  if (latest === null) throw new RunNotFoundError(runId);
  return latest;
}

/** Waits for the aborted submission to settle. A read that rejects with AgentRunError is the settle. */
async function abortSettled(handle: AgentHandle, flueId: string | undefined, deps: SettleDeps): Promise<'settled' | 'timeout' | 'unknown'> {
  if (flueId === undefined) return 'unknown';
  const timeout = AbortSignal.timeout(deps.stalledAbortWaitMs ?? STALLED_ABORT_WAIT_MS);
  try {
    await handle.read(flueId, { signal: deps.signal !== undefined ? AbortSignal.any([deps.signal, timeout]) : timeout });
    return 'settled';
  } catch (err) {
    if (err instanceof AgentRunError) return 'settled';
    return timeout.aborted ? 'timeout' : 'unknown';
  }
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// ------------------------------------------------------------------ settle

async function dispatchAndSettle(
  runId: RunId,
  submission: SubmissionInput,
  request: AgentHandleDispatchRequest,
  initOptions: InitOptions,
  deps: SettleDeps,
): Promise<SubmissionResult> {
  const store = deps.store;
  const callerSignal = deps.signal ?? new AbortController().signal;
  // A steer (D72) joins the response that is running, which owns the phase: it writes none before the read.
  const steer = submission.kind === 'steer';

  let seq: number;
  let handle: AgentHandle;
  let receipt: Awaited<ReturnType<AgentHandle['dispatch']>>;
  let investigating: boolean;
  try {
    seq = await store.addSubmission(runId, redactPersisted(submission));
    // Only a follow-up or a resume may move a stopped run on. A dispatch
    // with no worker pid clears the recorded one (D71): an earlier CLI
    // worker's pid does not belong to this submission.
    if (!steer) {
      await advance(store, runId, 'dispatched', {
        ...(submission.kind === 'ask' || submission.kind === 'resume' ? { resume: true } : {}),
        worker_pid: deps.workerPid ?? null,
      });
    }
    handle = deps.dispatcher.init(deps.agent, initOptions);
    receipt = await handle.dispatch(request);
    logRunEvent(runId, 'dispatch', { submission_seq: seq, kind: submission.kind, submission_id: receipt.submissionId });
    // D71: stalled detection reads this submission's Flue lease by the id, so it is recorded as soon as it is
    // known. It changes no phase. A display hint, so a failed write is logged and the run goes on.
    await Promise.resolve()
      .then(() => store.setSubmissionFlueId(runId, seq, receipt.submissionId))
      .catch((err: unknown) => logRunEvent(runId, 'flue_id_write_failed', { submission_seq: seq, error: className(err) }));
    investigating = steer || (await markInvestigating(store, runId));
  } catch (err) {
    if (err instanceof RunStoppedError) throw err;
    // A steer that could not be sent leaves the working run as it is.
    if (steer) logRunEvent(runId, 'steer_failed', { error: err });
    else await recordFailed(store, runId, err);
    throw err;
  }

  const submissionId = receipt.submissionId;
  const flush = startUsageFlush(runId, seq, submissionId, deps);
  try {
    const watch = watchStop(store, runId, deps.stopPollMs, () => handle.abort());
    // Stopped between the dispatch and the phase write.
    if (!investigating) watch.trip();
    const timeoutMs = deps.readTimeoutMs ?? defaultReadTimeoutMs(deps.config);
    const timeout = AbortSignal.timeout(timeoutMs);
    const readSignal = AbortSignal.any([callerSignal, timeout, watch.signal]);

    let status: SubmissionStatus;
    let replyText: string | undefined;
    let error: string | undefined;
    let inputRequest: InputRequest | undefined;
    let block: BlockRecord | undefined;
    let readError: unknown;
    try {
      // Stopped before the read began: the abort is on its way, there is nothing to wait for.
      if (watch.signal.aborted) throw watch.signal.reason;
      const reply = await handle.read(receipt, {
        signal: readSignal,
        ...(deps.onEvent !== undefined ? { onEvent: deps.onEvent } : {}),
      });
      status = 'completed';
      replyText = reply.text;
    } catch (err) {
      // The caller stopped waiting. The run goes on and stays readable.
      if (callerSignal.aborted) {
        watch.dispose();
        // Best effort: what is counted so far, not final. The rows stay in
        // memory for report.cost, since the run goes on in this process.
        await flush.stop();
        await writeUsage(store, runId, seq, snapshotSubmission(runId, submissionId), false);
        throw err;
      }
      readError = err;
      if (watch.signal.aborted) {
        status = 'stopped';
      } else {
        let cause = err;
        if (timeout.aborted) {
          cause = new SubmissionReadTimeoutError(timeoutMs);
          // Not for a steer: the abort would end the host's response it may have joined, whose own read and
          // Flue's run timeout end it; a steer that ran its own response has that run timeout too.
          if (!steer) await handle.abort().catch(() => undefined);
        }
        status = 'failed';
        error = failureReason(cause);
      }
    }
    watch.dispose();

    // Whether a steer joined the live response (D72). A joined steer settled
    // with its host, whose own settle writes the phase, the usage and the
    // embedding; this one only reports. A steer that ran as its own response
    // settles like any follow-up.
    const joined = steer ? await steerJoined(runId, submissionId, deps) : undefined;

    let wrote: SettleWrite = 'none';
    let parkedOn: RunRecord | null = null;
    if (status === 'completed' || joined === true) parkedOn = await store.getRun(runId);
    if (status === 'completed') {
      // The response may have ended on ask_requester or stop_blocked: then the
      // run is parked on the question or the block the tool stored, not done.
      const run = parkedOn;
      if (run !== null && run.phase === 'needs_input' && run.input_request !== null) {
        status = 'needs_input';
        inputRequest = run.input_request;
      } else if (run !== null && run.phase === 'blocked' && run.block !== null) {
        status = 'blocked';
        block = run.block;
        if (joined !== true) logRunEvent(runId, 'blocked', { submission_seq: seq, block_id: block.block_id, systems: block.systems });
      }
    }
    if (joined === true) {
      // The host's write already refused or will refuse on a stopped run: the stop wins here too.
      if ((status === 'completed' || status === 'failed') && parkedOn?.phase === 'stopped') {
        status = 'stopped';
        error = undefined;
      }
    } else if (status === 'completed' || status === 'failed') {
      // A refused write means a stop landed first (an abort from another
      // process settles the read as failed): the stop wins.
      wrote = await writeSettled(runId, seq, steer, status, status === 'failed' ? { reason: error ?? 'Error' } : {}, deps);
      if (wrote === 'stopped') {
        status = 'stopped';
        error = undefined;
      }
    }

    // The counts are in the store as soon as the status is. The flush is
    // stopped first, so no live write lands after this one. A joined steer
    // has no turns of its own (they carry the host's submission id), so
    // nothing is written for it.
    await flush.stop();
    await writeUsage(store, runId, seq, snapshotSubmission(runId, submissionId), true);

    // A parked run (needs_input, blocked) is embedded when it settles for real,
    // like any other. A stopped one is not embedded, and a joined steer leaves
    // it to the host, a steer that left the phase alone to the one that owns it.
    const embeds = wrote === 'wrote';
    const gaps = embeds ? await embedAfterSettle(deps, runId, seq, submissionId) : [];
    // Again with the embedding rows; final replaces final.
    if (embeds) await writeUsage(store, runId, seq, snapshotSubmission(runId, submissionId), true);
    dropSubmission(runId, submissionId);
    if (joined !== true) logUnassignedUsage(runId);
    logRunEvent(runId, 'settled', {
      submission_seq: seq,
      submission_id: receipt.submissionId,
      status,
      ...(joined !== undefined ? { joined } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(readError !== undefined ? { read_error: readError } : {}),
      ...(replyText !== undefined ? { reply_text: replyText } : {}),
      gaps,
    });
    return Object.freeze({
      run_id: runId,
      status,
      submission_seq: seq,
      submission_id: receipt.submissionId,
      ...(replyText !== undefined ? { reply_text: replyText } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(inputRequest !== undefined ? { input_request: inputRequest } : {}),
      ...(block !== undefined ? { block } : {}),
      gaps: Object.freeze(gaps),
      ...(joined !== undefined ? { joined } : {}),
    });
  } finally {
    // Every path, a throw included, stops the live flush.
    await flush.stop();
  }
}

/** What the settle's phase write did: wrote it, refused by a stop, left alone (a steer, below), or none was due. */
type SettleWrite = 'wrote' | 'stopped' | 'left' | 'none';

/**
 * The phases a steer that ran as its own response (D72) may settle from:
 * investigating once the settle listener saw it start (D70), or the
 * completed or failed the host left when the listener has not yet.
 */
const STEER_OWN_FROM: readonly RunPhase[] = ['investigating', 'completed', 'failed'];

/**
 * The settle's phase write, with the compare-and-set the settle listener
 * uses (D70), so the two never both write, and so both never embed: the one
 * that wrote embeds. It overwrites no question or block and nothing a later
 * submission (not a steer) owns. A submission that is not a steer writes
 * from the working phases, and leaves the phase to a later steer that runs
 * as its own response: the listener may already show that one investigating.
 * A steer that ran as its own response writes from STEER_OWN_FROM. 'stopped'
 * when the run is stopped, else 'left' when nothing was written.
 */
async function writeSettled(
  runId: RunId,
  seq: number,
  steer: boolean,
  phase: 'completed' | 'failed',
  detail: PhaseDetail,
  deps: SettleDeps,
): Promise<SettleWrite> {
  const store = deps.store;
  const run = await store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  if (run.phase === 'stopped') return 'stopped';
  if (run.submissions.some((sub) => sub.kind !== 'steer' && sub.seq > seq)) return 'left';
  if (!steer && (await steerRunsOwnResponse(run, seq, deps))) return 'left';
  if (await setPhaseIfLogged(store, runId, steer ? STEER_OWN_FROM : WORKING_PHASES, phase, detail)) return 'wrote';
  return (await store.getRun(runId))?.phase === 'stopped' ? 'stopped' : 'left';
}

/**
 * Whether a steer after this submission runs, or ran, as its own response
 * (D72): its lease left the queue and joined nothing. A steer with no Flue
 * id or no lease to read counts as not started.
 */
async function steerRunsOwnResponse(run: RunRecord, seq: number, deps: SettleDeps): Promise<boolean> {
  const read = deps.lease ?? submissionLease;
  for (const sub of run.submissions) {
    if (sub.kind !== 'steer' || sub.seq <= seq || sub.flue_submission_id === undefined) continue;
    let lease: SubmissionLease | null;
    try {
      lease = await read(sub.flue_submission_id);
    } catch {
      lease = null;
    }
    if (lease !== null && lease.joinedInto === undefined && lease.status !== 'queued') return true;
  }
  return false;
}

/**
 * Whether the steer joined the live response: Flue's lease for it keeps
 * joinedInto once settled. With no lease to read (no runtime connected in
 * this process), the usage meter decides: a steer that ran its own response
 * in this process has turns of its own.
 */
async function steerJoined(runId: RunId, submissionId: string, deps: SettleDeps): Promise<boolean> {
  let lease: SubmissionLease | null;
  try {
    lease = await (deps.lease ?? submissionLease)(submissionId);
  } catch {
    lease = null;
  }
  if (lease !== null) return lease.joinedInto !== undefined;
  return usageVersion(runId, submissionId) === 0;
}

/** What embedAfterSettle reads from the deps. */
export type EmbedAfterSettleDeps = Pick<SettleDeps, 'store' | 'embedder' | 'embedRun'>;

/** embedRun after a settle, its calls counted on the submission. Returns the gaps; never throws. The settle listener (D70) calls it too. */
export async function embedAfterSettle(deps: EmbedAfterSettleDeps, runId: RunId, seq: number, submissionId: string): Promise<string[]> {
  const embed = deps.embedRun ?? defaultEmbedRun;
  try {
    const r = await embed(deps.store, deps.embedder, runId, {
      onUsage: embedUsageRecorder(runId, { submissionId }, seq, deps.embedder),
    });
    return [...r.gaps];
  } catch (err) {
    // embedRun does not throw by contract; this keeps a broken one from failing the run.
    return [`embeddings skipped (${className(err)})`];
  }
}

// ------------------------------------------------------------------ usage

type UsageFlush = {
  /** Stops the timer and waits for a write in flight. Safe to call more than once. */
  stop(): Promise<void>;
};

const defaultFlushTimer: UsageFlushTimer = (tick, ms) => {
  const timer = setInterval(tick, ms);
  // A pending flush never keeps the process alive.
  timer.unref?.();
  return () => clearInterval(timer);
};

/**
 * Writes the submission's rows so far, not final, on each tick when the
 * meter's version for it moved. A tick that finds a write still running is
 * skipped. A failed write is logged and tried again on the next tick.
 */
function startUsageFlush(runId: RunId, seq: number, submissionId: string, deps: SettleDeps): UsageFlush {
  const ms = deps.config.runs.usageFlushMs ?? DEFAULT_USAGE_FLUSH_MS;
  if (!(ms > 0)) return { stop: async () => undefined };
  // 0 is what the meter returns before anything is counted.
  let written = 0;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped || inFlight !== undefined) return;
    const version = usageVersion(runId, submissionId);
    if (version === written) return;
    const rows = snapshotSubmission(runId, submissionId);
    inFlight = Promise.resolve()
      .then(() => deps.store.putUsage(runId, seq, rows, false))
      .then(
        () => {
          written = version;
        },
        (err: unknown) => logRunEvent(runId, 'usage_flush_failed', { submission_seq: seq, error: className(err) }),
      )
      .finally(() => {
        inFlight = undefined;
      });
  };
  const cancel = (deps.usageFlushTimer ?? defaultFlushTimer)(tick, ms);
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        cancel();
      }
      await inFlight;
    },
  };
}

/** putUsage that never throws: a failure is logged with the class name only. No rows, no write. */
async function writeUsage(store: RunStore, runId: RunId, seq: number, rows: readonly UsageRow[], final: boolean): Promise<void> {
  if (rows.length === 0) return;
  try {
    await store.putUsage(runId, seq, rows, final);
  } catch (err) {
    logRunEvent(runId, 'usage_write_failed', { submission_seq: seq, final, error: className(err) });
  }
}

/** Records each embed call into the bucket. The mock hash embedder is recorded as HASH_USAGE_MODEL. */
function embedUsageRecorder(runId: RunId, bucket: UsageBucket, seq: number, embedder: Embedder | null): (u: EmbedUsage) => void {
  const fake = embedder?.model === HASH_MODEL;
  return (u) => {
    recordUsage(runId, bucket, {
      model: fake ? HASH_USAGE_MODEL : u.model,
      agent: 'embedder',
      purpose: 'embed',
      isError: u.failed,
      input: u.inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    if (u.usageMissing === true) logRunEvent(runId, 'usage_missing', { submission_seq: seq, agent: 'embedder', calls: 1 });
  };
}

/** Records the classifier call into the intake bucket. A decision model's cost is the one the provider reported (D59). */
function classifierUsageRecorder(runId: RunId): (u: ClassifierUsage) => void {
  return (u) =>
    recordUsage(runId, 'intake', {
      model: u.model,
      agent: 'classifier',
      purpose: 'classify',
      isError: u.failed,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      ...(u.cacheWrite1h !== undefined ? { cacheWrite1h: u.cacheWrite1h } : {}),
      // Preset so the meter does not price a decision spec itself; null is unpriced.
      ...(u.path === 'decision' ? { usd: u.reportedUsd ?? null } : {}),
    });
}

/** Records the id decision call into the intake bucket, as agent identity. Its cost is the one the provider reported (D59). */
function identityUsageRecorder(runId: RunId): (u: IdentityUsage) => void {
  return (u) =>
    recordUsage(runId, 'intake', {
      model: u.model,
      agent: 'identity',
      purpose: 'identify',
      isError: u.failed,
      input: u.input,
      output: u.output,
      cacheRead: 0,
      cacheWrite: 0,
      // Preset so the meter does not price a decision spec itself; null is unpriced.
      usd: u.reportedUsd ?? null,
    });
}

/** Logs, counts only, the run's turns that carried no submissionId, and forgets them. */
function logUnassignedUsage(runId: RunId): void {
  const rows = takeUnassigned(runId);
  if (rows.length === 0) return;
  let calls = 0;
  let tokens = 0;
  for (const r of rows) {
    calls += r.calls;
    tokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
  }
  logRunEvent(runId, 'usage_unassigned', { rows: rows.length, calls, tokens });
}

// ------------------------------------------------------------------ stop

type StopWatch = {
  /** Aborted with RunStoppedError once the run is seen stopped. */
  readonly signal: AbortSignal;
  /** Acts as if the stop had just been seen. */
  trip(): void;
  dispose(): void;
};

/**
 * Reads the store every intervalMs until disposed. When the phase is
 * stopped it aborts the signal and calls onStop once (after dispatch, the
 * Flue abort). A failed read is skipped; the next tick tries again.
 */
function watchStop(store: RunStore, runId: RunId, intervalMs = STOP_POLL_MS, onStop?: () => Promise<void>): StopWatch {
  const controller = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let reading = false;
  const dispose = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const trip = (): void => {
    if (controller.signal.aborted) return;
    dispose();
    logRunEvent(runId, 'stop_seen', { aborting_agent: onStop !== undefined });
    controller.abort(new RunStoppedError(runId));
    if (onStop !== undefined) void onStop().catch(() => undefined);
  };
  if (intervalMs > 0) {
    timer = setInterval(() => {
      if (reading) return;
      reading = true;
      store
        .getRun(runId)
        .then(
          (run) => {
            if (run?.phase === 'stopped') trip();
          },
          () => undefined,
        )
        .finally(() => {
          reading = false;
        });
    }, intervalMs);
    // A pending check never keeps the process alive.
    timer.unref?.();
  }
  return { signal: controller.signal, trip, dispose };
}

/** setPhase that throws RunStoppedError when the store refuses the write because the run was stopped. */
async function advance(store: RunStore, runId: RunId, phase: RunPhase, detail: PhaseDetail = {}): Promise<void> {
  if ((await setPhaseLogged(store, runId, phase, detail)) === false) throw new RunStoppedError(runId);
}

/** store.setPhase plus a 'phase' line in the run's event log. */
async function setPhaseLogged(store: RunStore, runId: RunId, phase: RunPhase, detail: PhaseDetail = {}): Promise<boolean> {
  const written = await store.setPhase(runId, phase, detail);
  logRunEvent(runId, 'phase', { phase, ...detail, ...(written === false ? { refused: 'the run was stopped' } : {}) });
  return written !== false;
}

/** store.setPhaseIf, with a 'phase' line only when it wrote (as the settle listener logs). */
async function setPhaseIfLogged(
  store: RunStore,
  runId: RunId,
  fromPhases: readonly RunPhase[],
  phase: RunPhase,
  detail: PhaseDetail = {},
): Promise<boolean> {
  const written = await store.setPhaseIf(runId, fromPhases, phase, detail);
  if (written) logRunEvent(runId, 'phase', { phase, ...detail });
  return written;
}

/**
 * Moves the run to investigating once Flue accepted the dispatch, only from
 * dispatched: a fast tool may already have parked it on a question or a
 * block, which stays. False only when the run was stopped meanwhile.
 */
async function markInvestigating(store: RunStore, runId: RunId): Promise<boolean> {
  if (await setPhaseIfLogged(store, runId, ['dispatched'], 'investigating')) return true;
  return (await store.getRun(runId))?.phase !== 'stopped';
}

export function defaultReadTimeoutMs(config: SubmissionConfig): number {
  const attempts = Math.max(1, config.budgets.runMaxAttempts);
  return config.budgets.runTimeoutMs * attempts + READ_GRACE_MS;
}

// ------------------------------------------------------------------ steps

// Errors the identity step passes on: a strict fixture miss, an abort, and a
// malformed core result. Anything else means the step could not run.
const LOUD_IDENTITY_ERRORS: ReadonlySet<string> = new Set(['FixtureMissError', 'IngressIdentityError']);

async function identityStep(
  request: Pick<TriageRequest, 'request_id' | 'interface' | 'messages' | 'hints'>,
  names: readonly string[],
  deps: Pick<SubmissionDeps, 'identity'>,
  signal: AbortSignal,
  onUsage?: (u: IdentityUsage) => void,
): Promise<IngressIdentity> {
  try {
    return await deps.identity(request, { redactionNames: names, signal, ...(onUsage !== undefined ? { onUsage } : {}) });
  } catch (err) {
    if (signal.aborted || LOUD_IDENTITY_ERRORS.has(className(err))) throw err;
    const id_chain: IdChain = { ids: {}, hops: [], basic_state: [] };
    return { id_chain, basic_state: [], gaps: [`identity step did not run (${className(err)}); the classifier saw the thread only`] };
  }
}

async function classifyStep(
  runId: RunId,
  request: TriageRequest,
  identity: IngressIdentity,
  images: readonly DeliveredAttachment[],
  names: readonly string[],
  deps: SubmissionDeps,
  signal: AbortSignal,
): Promise<Classification> {
  const input: ClassifyInput = {
    thread: redactModelFacing(request.messages),
    idChain: identity.id_chain,
    basicState: identity.basic_state,
    images: images.map((i) => ({ mimeType: i.mimeType, data: i.data })),
    redactionNames: names,
  };
  try {
    return await deps.classify(input, signal, classifierUsageRecorder(runId));
  } catch (err) {
    if (signal.aborted) throw err;
    return unknownClassification(`classifier failed: ${className(err)}`);
  }
}

async function loadKnownPatterns(deps: SubmissionDeps, warnings: PreflightWarning[]): Promise<readonly Pattern[]> {
  if (deps.patterns === undefined) return [];
  try {
    return await deps.patterns();
  } catch {
    warnings.push(warning('patterns', 'known patterns did not load, so no pattern was matched'));
    return [];
  }
}

// patterns.ts is the only source of matched_pattern_id (the classifier's is dropped).
function withPatternMatch(
  classification: Classification,
  request: TriageRequest,
  patterns: readonly Pattern[],
  deps: SubmissionDeps,
): Classification {
  if (patterns.length === 0 || classification.classifier_error !== undefined) return classification;
  const services = deps.servicesFor?.(classification.entities_likely) ?? [];
  const text = request.messages.map((m) => m.text).join('\n');
  const match = matchPattern(text, services, classification.category, patterns);
  return match === null ? classification : { ...classification, matched_pattern_id: match.matched_pattern_id };
}

type LoadedImages = { readonly images: DeliveredAttachment[]; readonly failed: number };

async function loadImages(attachments: readonly Attachment[], deps: SubmissionDeps, signal: AbortSignal): Promise<LoadedImages> {
  const images: DeliveredAttachment[] = [];
  let failed = 0;
  for (const a of attachments) {
    if (!IMAGE_MIME.test(a.mime)) continue;
    try {
      const bytes = await deps.readAttachment(a.bytes_ref, signal);
      images.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: a.mime, filename: a.name });
    } catch (err) {
      if (signal.aborted) throw err;
      failed += 1;
    }
  }
  return { images, failed };
}

function safeAccepts(deps: SubmissionDeps, tier: Tier): boolean {
  try {
    return deps.tierAcceptsImages(tier) === true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ helpers

function warning(step: string, message: string): PreflightWarning {
  return { step, message };
}

/** The error's class name, for phase reasons and gaps. Never the message. */
export function className(err: unknown): string {
  if (!(err instanceof Error)) return 'Error';
  const ctor = err.constructor?.name;
  if (typeof ctor === 'string' && ctor !== '' && ctor !== 'Error') return ctor;
  return err.name !== '' ? err.name : 'Error';
}

/** Most characters of error text a stored phase reason keeps, like the audit reason (D63). */
const MAX_REASON_TEXT_CHARS = 300;

/**
 * The phase reason for a failed run: the class name, then the error's text
 * and its causes, for example "AgentRunError: <the settlement error Flue
 * attached>". The text is scrubbed like a tool error (D63), capped, and
 * masked with the persisted profile. When the masked text would still fail the
 * store's scan, only the class name is kept, so the failed phase is written.
 */
export function failureReason(err: unknown): string {
  const name = className(err);
  const outcome = (err as { outcome?: unknown } | null)?.outcome;
  const head = outcome === 'aborted' ? `${name} (aborted)` : name;
  // The persisted profile goes last: it only accepts its own masks, so a later scrub would undo them.
  const scrubbed = safeErrorText(stripAddresses(scrubSecrets(errorText(err))), [], MAX_REASON_TEXT_CHARS);
  const text = redactPersisted(scrubbed).value;
  if (text === '' || text === name || !checkEgress(text).ok) return head;
  return `${head}: ${text}`;
}

async function recordFailed(store: RunStore, runId: RunId, err: unknown): Promise<void> {
  // The whole error, stack included, goes to the event log; the store keeps the masked, capped reason.
  logRunEvent(runId, 'failed', { error: err });
  try {
    await store.setPhase(runId, 'failed', { reason: failureReason(err) });
  } catch {
    // The original error matters more; the run may not exist yet.
  }
}

/**
 * A resume that failed after it stopped a stalled run and before its
 * dispatch (D72) leaves the run failed with the D67 reason, not stopped as
 * stalled: a compare-and-set from stopped, so a run that moved on is left
 * alone. Logs the error, and a 'phase' line when it wrote. A refusal
 * (RunNotResumableError) or a stop wrote nothing to undo and is skipped, so
 * another resume's stop in flight is never overwritten. Never throws.
 */
export async function recordStalledResumeFailed(store: Pick<RunStore, 'setPhaseIf'>, runId: RunId, err: unknown): Promise<boolean> {
  if (err instanceof RunNotResumableError || err instanceof RunStoppedError || err instanceof RunNotFoundError) return false;
  logRunEvent(runId, 'failed', { error: err, from: 'stopped' });
  const detail = { reason: failureReason(err) };
  try {
    const written = await store.setPhaseIf(runId, ['stopped'], 'failed', detail);
    if (written) logRunEvent(runId, 'phase', { phase: 'failed', ...detail });
    return written;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ production deps

export type SubmissionDepsOptions = {
  /** Defaults to triageRuntime(), so the pipeline and the agent share one store and config. */
  readonly runtime?: TriageRuntime;
  /** Whether stdin is a terminal; pre-flight runs aws sso login only then. Default false. */
  readonly isTty?: boolean;
  readonly runner?: ExecRunner;
  readonly tcpProbe?: TcpProbe;
  /** For the embedder (ollama or openai). Never called in mock mode. */
  readonly fetch?: FetchLike;
  /** Defaults to Flue's init(). */
  readonly dispatcher?: Dispatcher;
  readonly signal?: AbortSignal;
  readonly onEvent?: AgentReadOptions['onEvent'];
};

/** The real deps: Flue init, the runtime's store and connectors, runPreflight, identity, classifier and embedder. */
export function submissionDeps(options: SubmissionDepsOptions = {}): SubmissionDeps {
  const rt = options.runtime ?? triageRuntime();
  const { config, registry } = rt;
  const store = rt.runStore;
  const embedder = embedderFor(config, options.fetch);
  const mock = createMockLayer(config, { home: config.home, ...(rt.caseId !== undefined ? { caseId: rt.caseId } : {}) });
  const audit = rt.audit ?? createJsonlAuditSink({ auditLogPath: config.paths.auditLog, runsDir: config.paths.runsDir });
  const now = rt.now ?? (() => new Date());
  const sql = rt.connectors.sql ?? {
    runSelect: () => Promise.reject(new ConnectorError('not_configured', 'no sql connector for this run')),
  };
  const preflightInput = (signal: AbortSignal): PreflightInput => ({
    config,
    registry,
    runner: options.runner ?? createExecRunner(),
    tcpProbe: options.tcpProbe ?? netTcpConnect,
    isTty: options.isTty ?? false,
    signal,
  });
  return {
    config,
    store,
    agent: Triage,
    dispatcher: options.dispatcher ?? { init },
    embedder,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
    preflight: ({ signal }) => runPreflight(preflightInput(signal)),
    resumePreflight: ({ signal }) => runTunnelPreflight(preflightInput(signal)),
    repoSync: ({ interface: iface, signal }) =>
      syncBeforeRun(iface, { config, runner: options.runner ?? createExecRunner(), signal }, infraReposToSync(config, registry)),
    identity: (request, { redactionNames, signal, onUsage }) =>
      resolveIngressIdentity(request, {
        // Read per run, so a change to the file needs no restart. A bad file throws and the step records it as a gap.
        knownIdFields: knownIdFieldsFor(config),
        decision: {
          model: config.models.decision,
          provider: (spec) => decisionProviderFor(spec, config),
          ...(onUsage !== undefined ? { onUsage } : {}),
        },
        sql,
        mock: mockPortFromFixtures(mock),
        audit,
        now,
        signal,
        entities: registry,
        sqlTimeouts: { statementTimeoutMs: config.sql.statementTimeoutMs, lockTimeoutMs: config.sql.lockTimeoutMs },
        redactionNames,
      }),
    classify: (input, signal, onUsage) => classifyThread(input, { config, signal, ...(onUsage !== undefined ? { onUsage } : {}) }),
    // The resume of a working run reads it (D72); the same inputs as the run view's (D71).
    stalled: (run) =>
      loadStalled(run, { stalledAfterMs: config.budgets.stalledAfterMs, runsDir: config.paths.runsDir, isAlive: pidAlive }),
    tierAcceptsImages: (tier) => {
      try {
        return acceptsImages(modelForTier(tier, config));
      } catch {
        return false;
      }
    },
    patterns: () => loadPatterns(config.paths.knowledgeDir),
    servicesFor: (entities) => entities.filter((e) => registry.isEnabled(e)).flatMap((e) => [...registry.services(e)]),
    priorCases: (runId, signal, onUsage) =>
      priorCasesFor(config, store, embedder, runId, { signal, ...(onUsage !== undefined ? { onUsage } : {}) }),
    readAttachment: (bytesRef, signal) => readFile(bytesRef, { signal }),
  };
}

// The deploy manifests repos of every enabled entity. A repos.json that does
// not load means none; the code tools report that problem.
function infraReposToSync(config: Config, registry: Registry): readonly string[] {
  try {
    return infraRepoNames(registry, loadRepos(config, registry), registry.enabledEntities());
  } catch {
    return [];
  }
}

// A refused MODEL_EMBEDDING must not stop runs: embeddings are derived data.
// The settle listener (D70) builds its embedder with it too.
export function embedderFor(config: Config, fetchImpl: FetchLike | undefined): Embedder | null {
  try {
    return createEmbedder(config, { fetch: fetchImpl ?? ((url, reqInit) => fetch(url, reqInit)) });
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}
