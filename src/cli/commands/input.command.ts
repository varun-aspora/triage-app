// triage input <run_id> [answer] [--question <id>] [--ids k=v ...] [--skip]
//              [--requested-by <who>] [--json]
//
// Answers the question a run is waiting on (phase needs_input, P6 §4.5) and
// resumes it through a detached worker, which calls answerRun. Prints
// {run_id, question_id, submission_id, skipped}. Follow it with
// `triage wait <run_id>`.
//
// --ids gives ids the person knows (customer_id=..., account_number=...).
// The worker runs the ingress identity step on them, so their hops are
// verified reads and the ids join the run's scope; free text never widens
// scope. --question names the question when it matters; it defaults to the
// open one. --skip resumes the run without an answer, and the report lists
// the question under gaps.
//
// Refused, with nothing started:
//   - an unknown run, a run that is not waiting, or one waiting on another
//     question (exit 1);
//   - neither an answer nor --skip, or both; a bad --question; bad --ids;
//     no --requested-by when the OS user name is unavailable (exit 2).
import * as v from 'valibot';
import { spawnWorker } from '../../ingress/detach.ts';
import { IngressInputError, parseIdsFlag } from '../../ingress/normalise.ts';
import type { KnownIds } from '../../types/core.ts';
import { QuestionIdSchema } from '../../types/input-request.ts';
import { startAnswer, type TerminalAnswer } from '../lib/input-request.ts';
import { emitJson, InputOutputSchema } from '../lib/output-schemas.ts';
import { requestedByOf, reportInputError, UsageError } from '../lib/request-args.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand } from '../types.ts';
import type { SpawnFn } from './start.command.ts';
import { checkRunIdArg, defaultOpenStore, printNotFound, type OpenStore } from './status.command.ts';

export type InputCommandOptions = {
  readonly openStore?: OpenStore<'getRun' | 'setPhase'>;
  readonly spawn?: SpawnFn;
  readonly defaultRequestedBy?: () => string | undefined;
};

export function createInputCommand(options: InputCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun' | 'setPhase'> = options.openStore ?? defaultOpenStore;
  const spawn = options.spawn ?? ((payload) => spawnWorker(payload));
  return {
    path: ['input'],
    summary: 'answer the question a run is waiting on, and resume it',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run that is waiting')
        .argument('[answer]', 'the answer; leave out with --skip')
        .option('--question <id>', 'the question to answer (q1, q2, ...); defaults to the open one')
        .option('--ids <pairs...>', 'ids the answer names, as key=value, e.g. customer_id=...')
        .option('--skip', 'resume the run without an answer')
        .option('--requested-by <who>', 'who answered (email or Slack user id); defaults to the OS user')
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;

      let answer: TerminalAnswer;
      let questionId: string | undefined;
      let ids: Partial<KnownIds> | undefined;
      let by: string;
      try {
        const text = typeof args[1] === 'string' ? args[1].trim() : '';
        const skip = opts.skip === true;
        if (skip && text !== '') throw new UsageError('give an answer or --skip, not both');
        if (!skip && text === '') throw new UsageError('the answer is empty (give one, or --skip)');
        answer = skip ? { kind: 'skip' } : { kind: 'answer', answer: text };
        if (opts.question !== undefined) {
          if (typeof opts.question !== 'string' || !v.is(QuestionIdSchema, opts.question)) throw new UsageError('--question must be a question id such as q1');
          questionId = opts.question;
        }
        const pairs = opts.ids;
        if (pairs !== undefined) {
          if (!Array.isArray(pairs) || !pairs.every((p) => typeof p === 'string')) throw new UsageError('--ids takes key=value pairs');
          try {
            ids = parseIdsFlag(pairs as string[]);
          } catch (err) {
            if (err instanceof IngressInputError) throw new UsageError(err.message);
            throw err;
          }
        }
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
      const open = run.input_request;
      if (open === null) {
        printError(io, json, 'ERROR', `run ${runId} is not waiting for an answer (phase ${run.phase})`);
        return EXIT.ERROR;
      }
      if (questionId !== undefined && questionId !== open.question_id) {
        printError(io, json, 'ERROR', `run ${runId} is waiting on question ${open.question_id}, not ${questionId}`);
        return EXIT.ERROR;
      }

      let started;
      try {
        started = await startAnswer(store, spawn, {
          runId,
          questionId: open.question_id,
          submissions: run.submissions.length,
          answer,
          ...(ids !== undefined ? { ids } : {}),
          by,
        });
      } catch (err) {
        printError(io, json, 'ERROR', err instanceof Error ? err.message : 'could not start the worker');
        return EXIT.ERROR;
      }

      const { pid: _pid, ...out } = started;
      if (json) emitJson(io, InputOutputSchema, out);
      else {
        printHuman(io, [
          `${out.skipped ? 'skipped' : 'answered'} question ${out.question_id} on run ${runId} (submission ${out.submission_id})`,
          `follow it with: triage wait ${runId}`,
        ]);
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createInputCommand();
