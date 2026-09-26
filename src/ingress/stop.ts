// Stopping a run: `triage stop`, POST /triage/:run_id/stop and the console's
// Cancel button all come here.
//
// stopRun(run_id, input, deps), in order:
//   1. Checks the run id and who is stopping it, before anything is written.
//   2. store.markStopped: phase stopped with reason 'cancelled', and an open
//      question or an open block (D55) closed as cancelled. A run that has
//      already finished is left alone and RunNotRunningError is thrown; the
//      check and the write are one step in the store, so a run that settles
//      at the same moment keeps its result.
//   3. Records the Cancel verdict through recordFeedback: verdict wrong, no
//      notes, cancelled: true, with the phase the run was in. Learning can
//      tell it apart from a considered reject. input.verdict false skips it.
//   4. When the run has a submission (the agent was started), asks Flue for
//      a durable abort of the instance. The process running the run sees the
//      stop in the store and aborts too (src/ingress/submit.ts); the Flue
//      abort also covers a worker that died, whose submission a later
//      runtime would otherwise pick up again. A failed abort is a gap, not an
//      error: the run is already stopped in the store.
//
// A stopped run can be resumed (triage resume) or asked a follow-up, which
// moves it on.

import * as v from 'valibot';
import { recordFeedback, type FeedbackDeps, type FeedbackResult } from '../report/feedback.ts';
import { redactPersisted } from '../gate/redact.ts';
import { logRunEvent } from '../runlog/event-log.ts';
import { RunNotFoundError, type RunPhase, type RunStore } from '../runstore/types.ts';
import { RunIdSchema, type RunId } from '../types/core.ts';
import { IngressInputError } from './normalise.ts';
import { className } from './submit.ts';

/** The phase reason a stopped run carries. */
export const STOP_REASON = 'cancelled';

const MAX_BY = 200;

export type StopInput = {
  /** Who stopped it: a name, an email or the OS user. */
  readonly by: string;
  readonly interface: 'cli' | 'http';
  /** Record the Cancel verdict (reject, no notes). Default true. */
  readonly verdict?: boolean;
};

export type StopDeps = {
  readonly store: RunStore;
  /** TRIAGE_HOME, for recordFeedback. */
  readonly home: string;
  /** A durable Flue abort of the run's instance. Left out: no abort is asked for. */
  readonly abort?: (runId: RunId) => Promise<void>;
  readonly now?: () => Date;
  /** Config.tracing, so the Cancel verdict also goes to Braintrust (D82). Left out: it does not. */
  readonly tracing?: FeedbackDeps['tracing'];
  /** Passed on to recordFeedback. Tests pass a stand-in. */
  readonly exportFeedback?: FeedbackDeps['exportFeedback'];
};

export type StopResult = {
  readonly run_id: RunId;
  /** The phase the run was in when it was stopped. */
  readonly stopped_from: RunPhase;
  /** Whether the Flue instance was asked to abort. */
  readonly aborted: boolean;
  /** The Cancel verdict, unless input.verdict was false. */
  readonly feedback: FeedbackResult | null;
  /** What did not happen, for example a failed abort. */
  readonly gaps: readonly string[];
};

/** The run has already finished (completed, failed or stopped). */
export class RunNotRunningError extends Error {
  override readonly name = 'RunNotRunningError';
  readonly runId: string;
  readonly phase: RunPhase;
  constructor(runId: string, phase: RunPhase) {
    super(`run ${runId} is not running (phase ${phase})`);
    this.runId = runId;
    this.phase = phase;
  }
}

export async function stopRun(runId: string, input: StopInput, deps: StopDeps): Promise<StopResult> {
  if (!v.is(RunIdSchema, runId)) throw new IngressInputError('run_id', 'is not a run id');
  const by = typeof input.by === 'string' ? input.by.trim() : '';
  if (by === '') throw new IngressInputError('by', 'is required');
  if (by.length > MAX_BY) throw new IngressInputError('by', `must be at most ${MAX_BY} characters`);

  const run = await deps.store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  const now = deps.now ?? (() => new Date());
  const from = await deps.store.markStopped(
    runId,
    STOP_REASON,
    redactPersisted({ status: 'cancelled' as const, resolved_at: now().toISOString(), resolved_by: by }),
  );
  if (from === null) {
    const latest = await deps.store.getRun(runId);
    throw new RunNotRunningError(runId, latest?.phase ?? run.phase);
  }

  const gaps: string[] = [];
  let feedback: FeedbackResult | null = null;
  if (input.verdict !== false) {
    const feedbackDeps: FeedbackDeps = {
      store: deps.store,
      home: deps.home,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.tracing !== undefined ? { tracing: deps.tracing } : {}),
      ...(deps.exportFeedback !== undefined ? { exportFeedback: deps.exportFeedback } : {}),
    };
    try {
      feedback = await recordFeedback(runId, { verdict: 'wrong', given_by: by, interface: input.interface, cancelled: true }, feedbackDeps, {
        phase: from,
      });
    } catch (err) {
      gaps.push(`the Cancel verdict was not recorded (${className(err)})`);
    }
  }

  let aborted = false;
  if (run.submissions.length > 0 && deps.abort !== undefined) {
    try {
      await deps.abort(runId);
      aborted = true;
    } catch (err) {
      gaps.push(`the agent was not asked to abort (${className(err)}); the process running it stops on its next check`);
    }
  }
  logRunEvent(runId, 'stop', { by, interface: input.interface, stopped_from: from, aborted, verdict: feedback !== null, gaps });
  return { run_id: runId, stopped_from: from, aborted, feedback, gaps };
}
