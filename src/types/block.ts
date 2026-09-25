// A run blocked on a system that did not answer (D55). The orchestrator
// calls stop_blocked when the investigation cannot go on because a backing
// (a database, an admin API, Quickwit, CBS, codegraph) is unreachable. The
// run parks in phase blocked with no report; the Flue conversation keeps
// everything found so far; `triage resume` sends it on as a new submission
// once the system is back.
//
// Every text field is persisted-profile text. Like ask_requester, the tool
// refuses a reason that carries an unmasked identifier rather than masking it.
import * as v from 'valibot';
import { NonEmptyStringSchema, TakenAtSchema } from './core.ts';

/** b1, b2, ... in the order the run blocked. */
export const BlockIdSchema = v.pipe(v.string(), v.regex(/^b[1-9][0-9]{0,3}$/));
export type BlockId = v.InferOutput<typeof BlockIdSchema>;

/**
 * Connector outcomes that count as "the system did not answer". A gate
 * refusal, a blank config (not_configured) and a fixture miss never do: they
 * are gaps to record, not outages to wait out.
 */
export const BLOCKING_FAILURE_CODES = ['unreachable', 'timeout', 'error'] as const;
export const BlockingFailureCodeSchema = v.picklist(BLOCKING_FAILURE_CODES);
export type BlockingFailureCode = v.InferOutput<typeof BlockingFailureCodeSchema>;

export const MAX_BLOCK_REASON_CHARS = 300;
export const MAX_BLOCK_SYSTEMS = 6;
/** The message a person sends with a resume: what was fixed, and anything new the run should take into account. */
export const MAX_RESUME_NOTE_CHARS = 4000;

/** `<entity>:<service>` as the tool result named it, for example ssfb:harbor or global:codegraph. */
export const SystemRefSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80));
export type SystemRef = v.InferOutput<typeof SystemRefSchema>;

export const BlockReasonSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_BLOCK_REASON_CHARS));
export const ResumeNoteSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_RESUME_NOTE_CHARS));

/** One connector failure the tool pipeline saw in a run: the evidence a stop_blocked call is checked against. */
export const ConnectorFailureSchema = v.object({
  system: SystemRefSchema,
  tool: NonEmptyStringSchema,
  code: BlockingFailureCodeSchema,
  at: TakenAtSchema,
});
export type ConnectorFailure = v.InferOutput<typeof ConnectorFailureSchema>;

export const BlockRecordSchema = v.object({
  block_id: BlockIdSchema,
  /** The systems that did not answer, as the failed tool results named them. */
  systems: v.pipe(v.array(SystemRefSchema), v.minLength(1), v.maxLength(MAX_BLOCK_SYSTEMS)),
  /** The failures the pipeline recorded for those systems, oldest first. */
  failures: v.array(ConnectorFailureSchema),
  /** One or two lines from the model on what it could not check and why the run cannot go on. */
  reason: BlockReasonSchema,
  blocked_at: TakenAtSchema,
  /** The submission that blocked. */
  submission_seq: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type BlockRecord = v.InferOutput<typeof BlockRecordSchema>;

// cancelled: the run was stopped while blocked.
export const BLOCK_RESOLUTIONS = ['resumed', 'cancelled'] as const;
export const BlockResolutionStatusSchema = v.picklist(BLOCK_RESOLUTIONS);
export type BlockResolutionStatus = v.InferOutput<typeof BlockResolutionStatusSchema>;

/** How an open block was closed. A resume's note also lives on the submission it started. */
export const BlockResolutionSchema = v.object({
  status: BlockResolutionStatusSchema,
  resolved_at: TakenAtSchema,
  /** Who resumed or stopped: an email, a Slack user id or the OS user. */
  resolved_by: NonEmptyStringSchema,
  /** The person's message with the resume: what was fixed, and anything new the run should take into account. */
  note: v.optional(ResumeNoteSchema),
});
export type BlockResolution = v.InferOutput<typeof BlockResolutionSchema>;

export const ResolvedBlockSchema = v.object({ ...BlockRecordSchema.entries, ...BlockResolutionSchema.entries });
export type ResolvedBlock = v.InferOutput<typeof ResolvedBlockSchema>;

/** The signal type resumeRun dispatches on the same conversation. */
export const BLOCK_RESUME_SIGNAL = 'triage.resume';
