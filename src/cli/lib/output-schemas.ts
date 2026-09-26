// The --json shapes of run, start, wait, status, usage, ask, input and
// resume. Each command checks its document against the schema here before
// printing it with printJson from src/cli/output.ts, so a shape cannot drift
// without a test failing.
import * as v from 'valibot';
import { PreflightWarningSchema } from '../../types/classification.ts';
import { ReportStatusSchema, RunIdSchema, TierSchema } from '../../types/core.ts';
import { RunPhaseSchema } from '../../runstore/types.ts';
import { InputRequestSchema, QuestionIdSchema } from '../../types/input-request.ts';
import { BlockRecordSchema } from '../../types/block.ts';
import { StalledSchema } from '../../types/stalled.ts';
import { RunUsageViewSchema, USAGE_AGENT_PATTERN, UsageModelSchema, UsageTotalsSchema } from '../../types/usage.ts';
import { EXIT, printJson } from '../output.ts';
import type { CliIo } from '../types.ts';

/**
 * Exit code of a `triage wait` that ran out of time. output.ts has no timeout
 * code and the plan fixes 3, which EXIT.CONFIG also uses; callers tell the two
 * apart by status 'timeout' in the JSON.
 */
export const EXIT_WAIT_TIMEOUT: number = EXIT.CONFIG;

/** Exit code of a `triage wait` or `triage run` that stopped on a question for the requester (P6 §4.5). */
export const EXIT_NEEDS_INPUT = 4;

/** Exit code of a `triage wait` or `triage run` on a run a person stopped. */
export const EXIT_STOPPED = 5;

/** Exit code of a `triage wait` or `triage run` on a run parked on a system that did not answer (D55). */
export const EXIT_BLOCKED = 6;

/**
 * The stored report as the run store returns it (persisted profile). Loose on
 * purpose: the persisted profile can mask digits in the run id, so the stored
 * copy does not always parse back through ReportSchema (see src/report/write.ts).
 */
export const StoredReportSchema = v.looseObject({
  run_id: v.string(),
  status: ReportStatusSchema,
});

/** `triage start --json`: exactly this, one line. */
export const StartOutputSchema = v.strictObject({ run_id: RunIdSchema });
export type StartOutput = v.InferOutput<typeof StartOutputSchema>;

/** One totals bucket of a run's usage (D59), strict. */
export const UsageTotalsOutputSchema = v.strictObject(UsageTotalsSchema.entries);

/**
 * A run's usage as src/usage/summary.ts builds it, strict: numbers, model
 * specs and agent names only. Breakdown keys are checked the same way as the
 * rows they come from.
 */
export const UsageViewSchema = v.strictObject({
  ...RunUsageViewSchema.entries,
  total: UsageTotalsOutputSchema,
  by_model: v.record(UsageModelSchema, UsageTotalsOutputSchema),
  by_agent: v.record(v.pipe(v.string(), v.regex(USAGE_AGENT_PATTERN)), UsageTotalsOutputSchema),
  by_submission: v.record(v.pipe(v.string(), v.regex(/^(0|[1-9]\d{0,8})$/)), UsageTotalsOutputSchema),
});
export type UsageView = v.InferOutput<typeof UsageViewSchema>;

export const WAIT_STATUSES = ['completed', 'failed', 'stalled', 'timeout', 'needs_input', 'stopped', 'blocked'] as const;

/** `triage wait --json`, and `triage run --json` (completed or failed only). */
export const WaitOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  status: v.picklist(WAIT_STATUSES),
  /** The latest report, when the run completed with one. */
  report: v.optional(StoredReportSchema),
  /** Why the run failed, stalled or was stopped. Error class names and fixed phrases only. */
  reason: v.optional(v.string()),
  /** The phase the run was in when a wait timed out, or needs_input. */
  phase: v.optional(RunPhaseSchema),
  /** The open question, with status needs_input. */
  input_request: v.optional(InputRequestSchema),
  /** The open block, with status blocked. */
  block: v.optional(BlockRecordSchema),
  /** The whole run's usage, when any is recorded. Absent for a run from before D59. */
  usage: v.optional(UsageViewSchema),
});
export type WaitOutput = v.InferOutput<typeof WaitOutputSchema>;

export const RUN_STATUSES = ['running', 'completed', 'failed', 'stalled', 'needs_input', 'stopped', 'blocked'] as const;
export const RunStatusSchema = v.picklist(RUN_STATUSES);
export type RunStatus = v.InferOutput<typeof RunStatusSchema>;

/** `triage status --json`. */
export const StatusOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema,
  /** null until the classifier and tier policy have run. */
  tier_final: v.nullable(TierSchema),
  /** How many submissions (the first run plus each ask) the run has. */
  submissions: v.pipe(v.number(), v.integer(), v.minValue(0)),
  preflight_warnings: v.array(PreflightWarningSchema),
  /** The open question, with status needs_input. */
  input_request: v.optional(InputRequestSchema),
  /** The open block, with status blocked. */
  block: v.optional(BlockRecordSchema),
  /** Why the run failed or was stopped, with status failed or stopped. Same text as `triage wait`. */
  reason: v.optional(v.string()),
  /**
   * D71: set while the phase is dispatched or investigating and nobody works
   * on the run. status keeps its own rule: 'stalled' only for a dead worker pid.
   */
  stalled: v.optional(v.strictObject(StalledSchema.entries)),
  /** The run's usage, when any is recorded. Absent for a run from before D59. */
  usage: v.optional(UsageViewSchema),
});
export type StatusOutput = v.InferOutput<typeof StatusOutputSchema>;

export const USAGE_BREAKDOWNS = ['model', 'agent', 'submission'] as const;
export type UsageBreakdown = (typeof USAGE_BREAKDOWNS)[number];

/** `triage usage --json`. usage is always there; recorded false says nothing was counted. */
export const UsageOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  status: RunStatusSchema,
  usage: UsageViewSchema,
});
export type UsageOutput = v.InferOutput<typeof UsageOutputSchema>;

/** The run store seq a follow-up, answer or resume gets. */
const SubmissionIdSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/** `triage ask --json`. submission_id is the run store seq the follow-up gets. */
export const AskOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  submission_id: SubmissionIdSchema,
});
export type AskOutput = v.InferOutput<typeof AskOutputSchema>;

/** `triage input --json`. submission_id is the run store seq the answer gets. */
export const InputOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  question_id: QuestionIdSchema,
  submission_id: SubmissionIdSchema,
  skipped: v.boolean(),
});
export type InputOutput = v.InferOutput<typeof InputOutputSchema>;

/**
 * `triage resume --json`. submission_id is the run store seq the resume gets.
 * mode (D72): steer when the message went to a working run, resume otherwise
 * (a stalled run is stopped and resumed).
 */
export const ResumeOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  submission_id: SubmissionIdSchema,
  mode: v.picklist(['steer', 'resume']),
});
export type ResumeOutput = v.InferOutput<typeof ResumeOutputSchema>;

/** Checks the document against its schema, then prints it with printJson. */
export function emitJson<S extends v.GenericSchema>(io: Pick<CliIo, 'stdout'>, schema: S, value: v.InferInput<S>): void {
  printJson(io, v.parse(schema, value));
}
