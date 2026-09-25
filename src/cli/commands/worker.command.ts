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
// recorded here as failed with the error class name. One exception: a resume
// that finds the run already sent on (another resume got there first, or the
// run moved on since `triage resume` checked it) leaves the run as that other
// process has it.
//
// The command path is ['worker'] because command paths must be plain
// kebab-case words; configure() renames it to __worker and hides it from help.
import type { Command } from 'commander';
import type { Config } from '../../config/env.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { WORKER_COMMAND } from '../../ingress/detach.ts';
import {
  answerRun,
  askRun,
  className,
  resumeRefusal,
  resumeRun,
  RunNotResumableError,
  runSubmission,
  submissionDeps,
  type SubmissionDeps,
  type SubmissionResult,
} from '../../ingress/submit.ts';
import { decodePayload, WorkerPayloadError, type WorkerPayload } from '../../ingress/worker-payload.ts';
import { RunStoppedError, type RunStore } from '../../runstore/types.ts';
import { EXIT, printError } from '../output.ts';
import type { CliCommand } from '../types.ts';
import { defaultOpenStore, type OpenStore } from './status.command.ts';

export type WorkerCommandOptions = {
  readonly openStore?: OpenStore<'getRun' | 'createRun' | 'setPhase'>;
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
  const openStore: OpenStore<'getRun' | 'createRun' | 'setPhase'> = options.openStore ?? defaultOpenStore;
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
      const recorded = await recordPid(store, payload, pidOf());
      if (recorded !== true) {
        printError(io, json, 'ERROR', recorded);
        return EXIT.ERROR;
      }

      let result: SubmissionResult;
      try {
        await boot();
        const deps = depsOf(config);
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
        // resume: it is theirs now, and not failed.
        if (err instanceof RunNotResumableError) {
          printError(io, json, 'ERROR', err.message);
          return EXIT.ERROR;
        }
        // A resume is the one write allowed past a stop, so a resume that
        // could not start leaves the stopped run failed, where the next
        // `triage wait` shows it.
        await store
          .setPhase(runId, 'failed', { reason: className(err), ...(payload.kind === 'resume' ? { resume: true } : {}) })
          .catch(() => undefined);
        printError(io, json, 'ERROR', `run ${runId} failed: ${className(err)}`);
        return EXIT.ERROR;
      }
      // A run parked on a question or on a system that did not answer, or
      // stopped, is not a failure.
      return result.status === 'failed' ? EXIT.ERROR : EXIT.OK;
    },
  };
}

/**
 * Records the worker pid on the run. A submit payload creates the run when
 * `triage start` did not (a no-op otherwise) and is refused when the run has
 * already moved past 'created'. The other payloads need an existing run.
 * Returns true, or the reason it refused.
 */
async function recordPid(
  store: Pick<RunStore, 'getRun' | 'createRun' | 'setPhase'>,
  payload: WorkerPayload,
  pid: number,
): Promise<true | string> {
  const runId = payload.run_id;
  if (payload.kind === 'submit') {
    await store.createRun(runId, redactPersisted(payload.request, { names: [...(payload.redaction_names ?? [])] }));
    const run = await store.getRun(runId);
    if (run === null) return `run not found: ${runId}`;
    if (run.phase !== 'created') return `run ${runId} has already started (phase ${run.phase})`;
    await store.setPhase(runId, 'created', { worker_pid: pid });
    return true;
  }
  const run = await store.getRun(runId);
  if (run === null) return `run not found: ${runId}`;
  if (payload.kind === 'resume') {
    // resumeRun decides from the stored phase whether the run can go on
    // (blocked, or failed or stopped after it was dispatched), so the phase
    // and its reason are kept here and dispatchAndSettle moves them on. A
    // run that is not resumable any more (another resume got there first)
    // is refused before its pid is overwritten.
    const refusal = resumeRefusal(run);
    if (refusal !== null) return refusal.message;
    await store.setPhase(runId, run.phase, {
      worker_pid: pid,
      resume: true,
      ...(run.phase_reason !== undefined ? { reason: run.phase_reason } : {}),
    });
    return true;
  }
  // `triage ask` and `triage input` write the same phase and pid once the
  // spawn returns, so the order of the two writes does not matter. A
  // follow-up resumes a stopped run.
  await store.setPhase(runId, 'dispatched', { worker_pid: pid, ...(payload.kind === 'ask' ? { resume: true } : {}) });
  return true;
}

export const command: CliCommand = createWorkerCommand();
