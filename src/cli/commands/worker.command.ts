// triage __worker <run_id>   (hidden; started by `triage start`, `triage ask`,
// `triage input` and `triage resume`)
//
// Reads the payload from stdin (never argv or disk), records this process's
// pid on the run so `triage status` can tell a stalled run, starts the Flue
// runtime and runs the work:
//   submit -> runSubmission(prepared, deps)
//   ask    -> askRun(run_id, question, by, deps)
//   answer -> answerRun(run_id, {question_id, answer | skip, ids, by}, deps)
//   resume -> resumeRun(run_id, {by, note}, deps)
//
// The parent ignores this process's stdout and stderr, so the outcome lives
// in the run store: runSubmission and askRun record completed or failed, and
// any error they do not record (a failed runtime start, for example) is
// recorded here as failed with failureReason (class name and masked text,
// D67). One exception: a resume
// that finds the run already sent on (another resume got there first, or the
// run moved on since `triage resume` checked it) leaves the run as that other
// process has it.
//
// A resume of a working run (D72) is a steer, or, when the run stalled, a
// stop and a resume; resumeRun tells which after its stalled check. So for a
// working run the pid is not written up front: a pid write before the check
// would make a stalled run look owned, and a steer's pid would replace the
// pid of the process that works on the run. The pid goes with the resume's
// dispatched phase instead (deps.workerPid), and a steer writes none. A
// failure is recorded only over a phase this worker owns, with the store's
// compare-and-set: the phase it resumed from, or the stop it wrote for a
// stalled run. A steer that throws leaves the working run as it is.
//
// Every payload passes deps.workerPid, so each submission's dispatched phase
// records this pid. A dispatch without one (the HTTP server) clears it, so the
// pid on a run is always that of the process that dispatched its latest
// submission (D71).
//
// The command path is ['worker'] because command paths must be plain
// kebab-case words; configure() renames it to __worker and hides it from help.
import type { Command } from 'commander';
import type { Config } from '../../config/env.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { WORKER_COMMAND } from '../../ingress/detach.ts';
import { STALLABLE_PHASES } from '../../ingress/stalled.ts';
import {
  answerRun,
  askRun,
  failureReason,
  type ResumeMode,
  resumeRefusal,
  resumeRun,
  RunNotResumableError,
  runSubmission,
  STALLED_STOP_REASON,
  submissionDeps,
  type SubmissionDeps,
  type SubmissionResult,
} from '../../ingress/submit.ts';
import { decodePayload, WorkerPayloadError, type WorkerPayload } from '../../ingress/worker-payload.ts';
import { RunStoppedError, type RunPhase, type RunStore } from '../../runstore/types.ts';
import { EXIT, printError } from '../output.ts';
import type { CliCommand } from '../types.ts';
import { defaultOpenStore, type OpenStore } from './status.command.ts';

type WorkerStoreMethods = 'getRun' | 'createRun' | 'setPhase' | 'setPhaseIf';

export type WorkerCommandOptions = {
  readonly openStore?: OpenStore<WorkerStoreMethods>;
  /** Starts the Flue runtime. Defaults to bootRuntime(). */
  readonly boot?: () => Promise<unknown>;
  /** Builds the submission deps once the runtime is up. Defaults to submissionDeps(). */
  readonly deps?: (config: Config) => SubmissionDeps;
  readonly runSubmission?: typeof runSubmission;
  readonly askRun?: typeof askRun;
  readonly answerRun?: typeof answerRun;
  readonly resumeRun?: typeof resumeRun;
  /** This process's pid. Defaults to process.pid. */
  readonly pid?: () => number;
};

// Imported on use: @flue/runtime/node loads node:sqlite, which prints an
// experimental warning, and `triage --help` loads every command module.
const lazyBoot = async (): Promise<unknown> => (await import('../../ingress/runtime.ts')).bootRuntime();

// Commander 15 sets a command's hidden flag only when the command is created,
// and buildProgram creates it; this sets the same field afterwards.
function hide(cmd: Command): void {
  (cmd as unknown as { _hidden: boolean })._hidden = true;
}

export function createWorkerCommand(options: WorkerCommandOptions = {}): CliCommand {
  const openStore: OpenStore<WorkerStoreMethods> = options.openStore ?? defaultOpenStore;
  const boot = options.boot ?? lazyBoot;
  const depsOf = options.deps ?? (() => submissionDeps({ isTty: false }));
  const submit = options.runSubmission ?? runSubmission;
  const ask = options.askRun ?? askRun;
  const answer = options.answerRun ?? answerRun;
  const resume = options.resumeRun ?? resumeRun;
  const pidOf = options.pid ?? (() => process.pid);
  return {
    path: ['worker'],
    summary: 'internal: runs a submission handed over on stdin',
    configure(cmd) {
      cmd.name(WORKER_COMMAND).argument('<run_id>', 'the run this worker serves');
      hide(cmd);
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;

      let payload: WorkerPayload;
      try {
        payload = await decodePayload(io.stdin);
      } catch (err) {
        if (!(err instanceof WorkerPayloadError)) throw err;
        printError(io, json, 'USAGE', err.message);
        return EXIT.USAGE;
      }
      if (args[0] !== payload.run_id) {
        printError(io, json, 'USAGE', 'worker: the run_id argument does not match the payload');
        return EXIT.USAGE;
      }

      const config = ctx.config();
      const store = await openStore(config);
      const runId = payload.run_id;
      const pid = pidOf();
      const recorded = await recordPid(store, payload, pid);
      if (typeof recorded === 'string') {
        printError(io, json, 'ERROR', recorded);
        return EXIT.ERROR;
      }

      let mode: ResumeMode | undefined;
      let result: SubmissionResult;
      try {
        await boot();
        const built = depsOf(config);
        // Every dispatch this worker makes records its pid (D71: a dispatch without one clears the pid).
        const deps: SubmissionDeps = {
          ...built,
          workerPid: pid,
          ...(payload.kind === 'resume'
            ? {
                onResumeMode: (m: ResumeMode) => {
                  mode = m;
                  built.onResumeMode?.(m);
                },
              }
            : {}),
        };
        if (payload.kind === 'submit') {
          result = await submit({ run_id: runId, request: payload.request, redaction_names: payload.redaction_names ?? [] }, deps);
        } else if (payload.kind === 'ask') {
          result = await ask(runId, payload.question, payload.by, deps);
        } else if (payload.kind === 'answer') {
          result = await answer(
            runId,
            {
              question_id: payload.question_id,
              ...(payload.answer !== undefined ? { answer: payload.answer } : {}),
              ...(payload.skip === true ? { skip: true } : {}),
              ...(payload.ids !== undefined ? { ids: payload.ids } : {}),
              by: payload.by,
            },
            deps,
          );
        } else {
          result = await resume(runId, { by: payload.by, ...(payload.note !== undefined ? { note: payload.note } : {}) }, deps);
        }
      } catch (err) {
        // A stop is what a person asked for, not a failure.
        if (err instanceof RunStoppedError) return EXIT.OK;
        // The run was sent on by someone else between the check and the
        // resume: it is theirs now, and not failed. The same when the network
        // path is not back (ResumeNotReadyError, D56): the run stays parked.
        if (err instanceof RunNotResumableError) {
          printError(io, json, 'ERROR', err.message);
          return EXIT.ERROR;
        }
        if (payload.kind === 'resume') {
          // A resume that could not start leaves the run failed, where the
          // next `triage wait` shows it, but only over a phase this worker
          // owns: the one it resumed from, or its own stop of a stalled run.
          // A steer, or a working run the worker never took, stays as it is.
          const owned = resumeOwned(recorded.from, mode);
          if (owned.length > 0) await store.setPhaseIf(runId, owned, 'failed', { reason: failureReason(err) }).catch(() => undefined);
        } else {
          await store.setPhase(runId, 'failed', { reason: failureReason(err) }).catch(() => undefined);
        }
        printError(io, json, 'ERROR', `run ${runId} failed: ${failureReason(err)}`);
        return EXIT.ERROR;
      }
      // A run parked on a question or on a system that did not answer, or
      // stopped, is not a failure.
      return result.status === 'failed' ? EXIT.ERROR : EXIT.OK;
    },
  };
}

/** What recordPid found: the phase the run was in when the worker took it. */
type Recorded = { readonly from: RunPhase };

/**
 * Records the worker pid on the run. A submit payload creates the run when
 * `triage start` did not (a no-op otherwise) and is refused when the run has
 * already moved past 'created'. The other payloads need an existing run. A
 * resume of a working run writes nothing here (see the header). Returns the
 * phase the run was in, or the reason it refused.
 */
async function recordPid(store: Pick<RunStore, WorkerStoreMethods>, payload: WorkerPayload, pid: number): Promise<Recorded | string> {
  const runId = payload.run_id;
  if (payload.kind === 'submit') {
    await store.createRun(runId, redactPersisted(payload.request, { names: [...(payload.redaction_names ?? [])] }));
    const run = await store.getRun(runId);
    if (run === null) return `run not found: ${runId}`;
    if (run.phase !== 'created') return `run ${runId} has already started (phase ${run.phase})`;
    await store.setPhase(runId, 'created', { worker_pid: pid });
    return { from: 'created' };
  }
  const run = await store.getRun(runId);
  if (run === null) return `run not found: ${runId}`;
  if (payload.kind === 'resume') {
    // resumeRun decides from the stored phase whether the run can go on
    // (blocked, failed or stopped after it was dispatched, or working), so
    // the phase and its reason are kept here and dispatchAndSettle moves them
    // on. A run that is not resumable any more (another resume got there
    // first) is refused before its pid is overwritten.
    const refusal = resumeRefusal(run);
    if (refusal !== null) return refusal.message;
    // A working run: resumeRun's stalled check comes first (D72).
    if (STALLABLE_PHASES.includes(run.phase)) return { from: run.phase };
    // A run stopped as stalled keeps its updated_at, which dates the stop
    // (stalledStopInFlight): a pid write here would make this resume look
    // like another one's stop in flight. The pid goes with the dispatch.
    if (run.phase === 'stopped' && run.phase_reason === STALLED_STOP_REASON) return { from: run.phase };
    // The pid only, on the phase as it was read: a run that moved meanwhile
    // keeps its phase, and resumeRun judges it from there.
    await store.setPhaseIf(runId, [run.phase], run.phase, {
      worker_pid: pid,
      ...(run.phase_reason !== undefined ? { reason: run.phase_reason } : {}),
    });
    return { from: run.phase };
  }
  // `triage ask` and `triage input` write the same phase and pid once the
  // spawn returns, so the order of the two writes does not matter. A
  // follow-up resumes a stopped run.
  await store.setPhase(runId, 'dispatched', { worker_pid: pid, ...(payload.kind === 'ask' ? { resume: true } : {}) });
  return { from: run.phase };
}

/**
 * The phases a failed resume may overwrite with failed: the one it resumed a
 * parked, failed or stopped run from, or, for a working run, the stop it
 * wrote itself when the run had stalled. A steer owns no phase.
 */
function resumeOwned(from: RunPhase, mode: ResumeMode | undefined): readonly RunPhase[] {
  if (!STALLABLE_PHASES.includes(from)) return [from];
  return mode === 'resume' ? ['stopped'] : [];
}

export const command: CliCommand = createWorkerCommand();
