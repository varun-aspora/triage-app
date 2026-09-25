// triage ask <run_id> "follow-up question" [--requested-by <who>] [--json]
//
// Adds a follow-up submission on the same Flue conversation through a
// detached worker, which calls askRun, and prints {run_id, submission_id}.
// submission_id is the run store seq the follow-up gets. Follow it with
// `triage wait <run_id>`.
//
// Refused, with nothing started:
//   - an unknown run_id (exit 1, 'run not found');
//   - a run that is still going, since the store tracks one phase per run
//     (exit 1; a stalled run may be asked again);
//   - a run waiting on a question: that is answered with `triage input`,
//     not asked around (exit 1);
//   - a run blocked on a system that did not answer: that is sent on with
//     `triage resume`, which closes the block (exit 1);
//   - an empty question or a bad run_id (exit 2).
//
// After the worker starts, the phase is set to dispatched with the worker's
// pid, so a `triage wait` right after this does not return the previous
// report.
import type { RunStore } from '../../runstore/types.ts';
import { spawnWorker } from '../../ingress/detach.ts';
import { AskOutputSchema, emitJson } from '../lib/output-schemas.ts';
import { requestedByOf, reportInputError, UsageError } from '../lib/request-args.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand } from '../types.ts';
import { checkRunIdArg, defaultOpenStore, pidAlive, printNotFound, runStatusOf, type OpenStore, type PidChecker } from './status.command.ts';
import type { SpawnFn } from './start.command.ts';

export type AskCommandOptions = {
  readonly openStore?: OpenStore<'getRun' | 'setPhase'>;
  readonly spawn?: SpawnFn;
  readonly isAlive?: PidChecker;
  readonly defaultRequestedBy?: () => string | undefined;
};

export function createAskCommand(options: AskCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun' | 'setPhase'> = options.openStore ?? defaultOpenStore;
  const spawn = options.spawn ?? ((payload) => spawnWorker(payload));
  const isAlive = options.isAlive ?? pidAlive;
  return {
    path: ['ask'],
    summary: 'ask a follow-up question on an existing run',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to continue')
        .argument('<question>', 'the follow-up question')
        .option('--requested-by <who>', 'who asked (email or Slack user id); defaults to the OS user')
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;

      let question: string;
      let by: string;
      try {
        question = typeof args[1] === 'string' ? args[1].trim() : '';
        if (question === '') throw new UsageError('the question is empty');
        const who = requestedByOf(opts, options.defaultRequestedBy !== undefined ? { defaultRequestedBy: options.defaultRequestedBy } : {});
        if (who === undefined) throw new UsageError('--requested-by is required (the OS user name is not available)');
        by = who;
      } catch (err) {
        const code = reportInputError(io, json, err);
        if (code === undefined) throw err;
        return code;
      }

      const store = await openStore(ctx.config());
      const run = await store.getRun(runId);
      if (run === null) return printNotFound(io, json, runId);
      const status = runStatusOf(run, isAlive);
      if (status === 'running') {
        printError(io, json, 'ERROR', `run ${runId} is still going (phase ${run.phase}); wait for it before asking`);
        return EXIT.ERROR;
      }
      if (status === 'needs_input') {
        const qid = run.input_request?.question_id ?? '?';
        printError(io, json, 'ERROR', `run ${runId} is waiting for an answer to question ${qid}; answer it with: triage input ${runId} "<answer>" (or --skip)`);
        return EXIT.ERROR;
      }
      if (status === 'blocked') {
        const systems = run.block?.systems.join(', ') ?? 'a system';
        printError(io, json, 'ERROR', `run ${runId} is blocked (${systems} did not answer); resume it with: triage resume ${runId}`);
        return EXIT.ERROR;
      }
      const submissionId = run.submissions.length + 1;

      let pid: number;
      try {
        ({ pid } = await spawn({ kind: 'ask', run_id: runId, question, by }));
      } catch (err) {
        printError(io, json, 'ERROR', err instanceof Error ? err.message : 'could not start the worker');
        return EXIT.ERROR;
      }
      await markDispatched(store, runId, pid);

      if (json) emitJson(io, AskOutputSchema, { run_id: runId, submission_id: submissionId });
      else printHuman(io, [`asked on run ${runId} (submission ${submissionId})`, `follow it with: triage wait ${runId}`]);
      return EXIT.OK;
    },
  };
}

async function markDispatched(store: Pick<RunStore, 'setPhase'>, runId: string, pid: number): Promise<void> {
  // A follow-up resumes a stopped run.
  await store.setPhase(runId, 'dispatched', { worker_pid: pid, resume: true });
}

export const command: CliCommand = createAskCommand();
