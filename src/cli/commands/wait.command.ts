// triage wait <run_id> [--timeout <seconds>] [--requested-by <who>] [--json]
//
// Polls the run store until the run's phase is terminal, the worker is gone,
// the run is waiting on a question or blocked on a system, or the timeout
// passes, then prints {run_id, status, report?, reason?, input_request?,
// block?, usage?}.
//
//   completed   -> the stored report (persisted profile), exit 0
//   failed      -> the failure reason, exit 1
//   stalled     -> the phase is not terminal and the worker pid is dead, exit 1
//   timeout     -> the run is still going, exit 3
//   needs_input -> the question the run is waiting on, exit 4 (P6 §4.5)
//   stopped     -> a person stopped the run, exit 5
//   blocked     -> the block the run is parked on, exit 6; `triage resume` sends it on (D55)
//
// With a terminal and no --json, a question is asked right here: the answer
// (or a skip) goes to a detached worker the way `triage input` does, and the
// wait goes on with a fresh timeout. Otherwise the question is printed with
// how to answer it, and the run stays parked.
//
// usage (D59) is the whole run's token and cost totals, present once
// anything was counted. report_md covers only the latest submission, so the
// human form adds a 'run total:' line after it. While the run goes on, the
// human form also writes 'cost so far: ...' to stderr each time the live
// total changes; --json prints nothing until the one final document.
//
// A timeout only stops the waiting. Apart from starting the worker that
// carries an answer, this command reads the run store and nothing else, so
// it cannot abort or change the run.
import { spawnWorker } from '../../ingress/detach.ts';
import type { RunRecord } from '../../runstore/types.ts';
import { answerHint, askAtTerminal, blockLines, copyBlock, questionLines, resumeHint, startAnswer } from '../lib/input-request.ts';
import { EXIT_BLOCKED, EXIT_NEEDS_INPUT, EXIT_STOPPED, EXIT_WAIT_TIMEOUT, emitJson, WaitOutputSchema, type WaitOutput } from '../lib/output-schemas.ts';
import { type LineReader, linePrompt } from '../lib/prompt.ts';
import { requestedByOf } from '../lib/request-args.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand, CliIo } from '../types.ts';
import type { SpawnFn } from './start.command.ts';
import {
  checkRunIdArg,
  defaultOpenStore,
  pidAlive,
  printNotFound,
  runStatusOf,
  STALLED_REASON,
  usageField,
  usageShortText,
  usageTotalText,
  usageViewOf,
  type OpenStore,
  type PidChecker,
} from './status.command.ts';

/** Default --timeout in seconds. */
export const DEFAULT_WAIT_SECONDS = 600;
/** How often the store is read. */
export const POLL_MS = 1000;

export type WaitCommandOptions = {
  readonly openStore?: OpenStore<'getRun' | 'setPhase'>;
  readonly isAlive?: PidChecker;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  /** Starts the worker that carries an answer given at the terminal. */
  readonly spawn?: SpawnFn;
  /** Reads the answer at the terminal. */
  readonly prompt?: (io: CliIo, write: (text: string) => void) => LineReader;
  readonly defaultRequestedBy?: () => string | undefined;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait result for a run in a final state, or undefined while it is still going. */
export function settledOutput(run: RunRecord, isAlive: PidChecker): WaitOutput | undefined {
  const status = runStatusOf(run, isAlive);
  const usage = usageField(usageViewOf(run, status));
  if (status === 'completed') {
    return { run_id: run.run_id, status, ...(run.report !== null ? { report: { ...run.report } } : {}), ...usage };
  }
  if (status === 'failed') return { run_id: run.run_id, status, reason: run.phase_reason ?? 'unknown failure', ...usage };
  if (status === 'stopped') return { run_id: run.run_id, status, reason: run.phase_reason ?? 'stopped', ...usage };
  if (status === 'stalled') return { run_id: run.run_id, status, reason: STALLED_REASON, phase: run.phase, ...usage };
  if (status === 'needs_input') {
    return {
      run_id: run.run_id,
      status,
      phase: run.phase,
      ...(run.input_request !== null ? { input_request: { ...run.input_request, options: [...run.input_request.options] } } : {}),
      ...usage,
    };
  }
  if (status === 'blocked') {
    return { run_id: run.run_id, status, phase: run.phase, ...(run.block !== null ? { block: copyBlock(run.block) } : {}), ...usage };
  }
  return undefined;
}

/**
 * Adds the run's usage to a result built elsewhere (`triage run`), so its
 * JSON and its 'run total:' line match `triage wait`.
 */
export function withUsage(out: WaitOutput, run: RunRecord | null, isAlive: PidChecker = pidAlive): WaitOutput {
  if (run === null) return out;
  return { ...out, ...usageField(usageViewOf(run, runStatusOf(run, isAlive))) };
}

/**
 * Prints a settled or timed-out result and returns the exit code. Shared with
 * `triage run`. The human form prints the report Markdown when there is one,
 * then the run total when out carries usage.
 */
export function printWaitResult(
  io: Pick<CliIo, 'stdout' | 'stderr'>,
  json: boolean,
  out: WaitOutput,
  reportMd: string | null,
  now: number = Date.now(),
): number {
  const code =
    out.status === 'completed'
      ? EXIT.OK
      : out.status === 'timeout'
        ? EXIT_WAIT_TIMEOUT
        : out.status === 'needs_input'
          ? EXIT_NEEDS_INPUT
          : out.status === 'stopped'
            ? EXIT_STOPPED
            : out.status === 'blocked'
              ? EXIT_BLOCKED
              : EXIT.ERROR;
  if (json) {
    emitJson(io, WaitOutputSchema, out);
    return code;
  }
  switch (out.status) {
    case 'completed':
      printHuman(io, reportMd ?? `run ${out.run_id} completed without a report`);
      break;
    case 'failed':
      printError(io, false, 'ERROR', `run ${out.run_id} failed: ${out.reason ?? 'unknown failure'}`);
      break;
    case 'stopped':
      printHuman(io, `run ${out.run_id} was stopped. Ask a follow-up to resume it: triage ask ${out.run_id} "<question>"`);
      break;
    case 'stalled':
      printError(io, false, 'ERROR', `run ${out.run_id} stalled in phase ${out.phase ?? 'unknown'}: ${out.reason ?? STALLED_REASON}`);
      break;
    case 'timeout':
      printHuman(io, `run ${out.run_id} is still going (phase ${out.phase ?? 'unknown'}); it keeps running. Wait again with: triage wait ${out.run_id}`);
      break;
    case 'needs_input':
      printHuman(
        io,
        out.input_request !== undefined
          ? [...questionLines(out.run_id, out.input_request), '', ...answerHint(out.run_id)]
          : [`run ${out.run_id} is waiting for an answer`, ...answerHint(out.run_id)],
      );
      break;
    case 'blocked':
      printHuman(
        io,
        out.block !== undefined
          ? [...blockLines(out.run_id, out.block), '', ...resumeHint(out.run_id)]
          : [`run ${out.run_id} is blocked on a system that did not answer`, ...resumeHint(out.run_id)],
      );
      break;
  }
  if (out.usage !== undefined) printHuman(io, `run total: ${usageTotalText(out.usage, now)}`);
  return code;
}

export function createWaitCommand(options: WaitCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun' | 'setPhase'> = options.openStore ?? defaultOpenStore;
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const pollMs = options.pollMs ?? POLL_MS;
  const spawn = options.spawn ?? ((payload) => spawnWorker(payload));
  const prompt = options.prompt ?? linePrompt;
  return {
    path: ['wait'],
    summary: 'wait for a run to finish and print its report; answers a question at the terminal (a timeout never stops the run)',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to wait for')
        .option('--timeout <seconds>', `stop waiting after this many seconds (default ${DEFAULT_WAIT_SECONDS})`)
        .option('--requested-by <who>', 'who answers a question at the terminal (email or Slack user id); defaults to the OS user')
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;
      const seconds = timeoutOf(opts.timeout);
      if (seconds === undefined) {
        printError(io, json, 'USAGE', '--timeout must be a positive number of seconds');
        return EXIT.USAGE;
      }

      const store = await openStore(ctx.config());
      const write = (text: string): void => void io.stdout.write(text);
      let deadline = now() + seconds * 1000;
      let lastCost: string | undefined;
      for (;;) {
        const run = await store.getRun(runId);
        if (run === null) return printNotFound(io, json, runId);
        const settled = settledOutput(run, isAlive);
        if (settled?.status === 'needs_input' && settled.input_request !== undefined && io.isTTY && !json) {
          const by = requestedByOf(opts, options.defaultRequestedBy !== undefined ? { defaultRequestedBy: options.defaultRequestedBy } : {});
          const answer = by === undefined ? null : await askAtTerminal(write, runId, settled.input_request, prompt(io, write));
          if (answer !== null && by !== undefined) {
            const started = await startAnswer(store, spawn, {
              runId,
              questionId: settled.input_request.question_id,
              submissions: run.submissions.length,
              answer,
              by,
            });
            printHuman(io, `${started.skipped ? 'skipped' : 'answered'} question ${started.question_id}; waiting for the run to go on`);
            deadline = now() + seconds * 1000;
            continue;
          }
        }
        if (settled !== undefined) {
          return printWaitResult(io, json, settled, settled.status === 'completed' ? run.report_md : null, now());
        }
        // Not settled, so the run is running with its worker alive.
        const view = usageViewOf(run, 'running');
        if (!json && view.recorded) {
          const cost = usageShortText(view);
          if (cost !== lastCost) io.stderr.write(`cost so far: ${cost}\n`);
          lastCost = cost;
        }
        const left = deadline - now();
        if (left <= 0) {
          return printWaitResult(io, json, { run_id: run.run_id, status: 'timeout', phase: run.phase, ...usageField(view) }, null, now());
        }
        await sleep(Math.min(pollMs, left));
      }
    },
  };
}

function timeoutOf(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_WAIT_SECONDS;
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const command: CliCommand = createWaitCommand();
