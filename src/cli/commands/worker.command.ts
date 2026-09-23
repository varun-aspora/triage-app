// triage __worker <run_id>   (hidden; started by `triage start` and `triage ask`)
//
// Reads the payload from stdin (never argv or disk), records this process's
// pid on the run so `triage status` can tell a stalled run, starts the Flue
// runtime and runs the work:
//   submit -> runSubmission(prepared, deps)
//   ask    -> askRun(run_id, question, by, deps)
//
// The parent ignores this process's stdout and stderr, so the outcome lives
// in the run store: runSubmission and askRun record completed or failed, and
// any error they do not record (a failed runtime start, for example) is
// recorded here as failed with the error class name.
//
// The command path is ['worker'] because command paths must be plain
// kebab-case words; configure() renames it to __worker and hides it from help.
import type { Command } from 'commander';
import type { Config } from '../../config/env.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { WORKER_COMMAND } from '../../ingress/detach.ts';
import {
  askRun,
  className,
  runSubmission,
  submissionDeps,
  type SubmissionDeps,
  type SubmissionResult,
} from '../../ingress/submit.ts';
import { decodePayload, WorkerPayloadError, type WorkerPayload } from '../../ingress/worker-payload.ts';
import type { RunStore } from '../../runstore/types.ts';
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
        result =
          payload.kind === 'submit'
            ? await submit({ run_id: runId, request: payload.request, redaction_names: payload.redaction_names ?? [] }, deps)
            : await ask(runId, payload.question, payload.by, deps);
      } catch (err) {
        await store.setPhase(runId, 'failed', { reason: className(err) }).catch(() => undefined);
        printError(io, json, 'ERROR', `run ${runId} failed: ${className(err)}`);
        return EXIT.ERROR;
      }
      return result.status === 'completed' ? EXIT.OK : EXIT.ERROR;
    },
  };
}

/**
 * Records the worker pid on the run, keeping its phase. A submit payload
 * creates the run when `triage start` did not (a no-op otherwise) and is
 * refused when the run has already moved past 'created'. An ask payload needs
 * an existing run. Returns true, or the reason it refused.
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
  // `triage ask` writes the same phase and pid once the spawn returns, so the
  // order of the two writes does not matter.
  await store.setPhase(runId, 'dispatched', { worker_pid: pid });
  return true;
}

export const command: CliCommand = createWorkerCommand();
