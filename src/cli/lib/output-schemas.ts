// The --json shapes of run, start, wait, status and ask. Each command checks
// its document against the schema here before printing it with printJson
// from src/cli/output.ts, so a shape cannot drift without a test failing.
import * as v from 'valibot';
import { PreflightWarningSchema } from '../../types/classification.ts';
import { ReportStatusSchema, RunIdSchema, TierSchema } from '../../types/core.ts';
import { RunPhaseSchema } from '../../runstore/types.ts';
import { EXIT, printJson } from '../output.ts';
import type { CliIo } from '../types.ts';

/**
 * Exit code of a `triage wait` that ran out of time. output.ts has no timeout
 * code and the plan fixes 3, which EXIT.CONFIG also uses; callers tell the two
 * apart by status 'timeout' in the JSON.
 */
export const EXIT_WAIT_TIMEOUT: number = EXIT.CONFIG;

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

export const WAIT_STATUSES = ['completed', 'failed', 'stalled', 'timeout'] as const;

/** `triage wait --json`, and `triage run --json` (completed or failed only). */
export const WaitOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  status: v.picklist(WAIT_STATUSES),
  /** The latest report, when the run completed with one. */
  report: v.optional(StoredReportSchema),
  /** Why the run failed or stalled. Error class names and fixed phrases only. */
  reason: v.optional(v.string()),
  /** The phase the run was in when a wait timed out. */
  phase: v.optional(RunPhaseSchema),
});
export type WaitOutput = v.InferOutput<typeof WaitOutputSchema>;

export const RUN_STATUSES = ['running', 'completed', 'failed', 'stalled'] as const;
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
});
export type StatusOutput = v.InferOutput<typeof StatusOutputSchema>;

/** `triage ask --json`. submission_id is the run store seq the follow-up gets. */
export const AskOutputSchema = v.strictObject({
  run_id: RunIdSchema,
  submission_id: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type AskOutput = v.InferOutput<typeof AskOutputSchema>;

/** Checks the document against its schema, then prints it with printJson. */
export function emitJson<S extends v.GenericSchema>(io: Pick<CliIo, 'stdout'>, schema: S, value: v.InferInput<S>): void {
  printJson(io, v.parse(schema, value));
}
