// triage wait <run_id> [--timeout <seconds>] [--json]
//
// Polls the run store until the run's phase is terminal, the worker is gone,
// or the timeout passes, then prints {run_id, status, report?, reason?}.
//
//   completed -> the stored report (persisted profile), exit 0
//   failed    -> the failure reason, exit 1
//   stalled   -> the phase is not terminal and the worker pid is dead, exit 1
//   timeout   -> the run is still going, exit 3
//
// A timeout only stops the waiting. This command reads the run store and
// nothing else, so it cannot abort or change the run.
import type { RunRecord } from '../../runstore/types.ts';
import { EXIT_WAIT_TIMEOUT, emitJson, WaitOutputSchema, type WaitOutput } from '../lib/output-schemas.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand, CliIo } from '../types.ts';
import {
  checkRunIdArg,
  defaultOpenStore,
  pidAlive,
  printNotFound,
  runStatusOf,
  STALLED_REASON,
  type OpenStore,
  type PidChecker,
} from './status.command.ts';

/** Default --timeout in seconds. */
export const DEFAULT_WAIT_SECONDS = 600;
/** How often the store is read. */
export const POLL_MS = 1000;

export type WaitCommandOptions = {
  readonly openStore?: OpenStore<'getRun'>;
  readonly isAlive?: PidChecker;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait result for a run in a final state, or undefined while it is still going. */
export function settledOutput(run: RunRecord, isAlive: PidChecker): WaitOutput | undefined {
  const status = runStatusOf(run, isAlive);
  if (status === 'completed') {
    return { run_id: run.run_id, status, ...(run.report !== null ? { report: { ...run.report } } : {}) };
  }
  if (status === 'failed') return { run_id: run.run_id, status, reason: run.phase_reason ?? 'unknown failure' };
  if (status === 'stalled') return { run_id: run.run_id, status, reason: STALLED_REASON, phase: run.phase };
  return undefined;
}

/**
 * Prints a settled or timed-out result and returns the exit code. Shared with
 * `triage run`. The human form prints the report Markdown when there is one.
 */
export function printWaitResult(
  io: Pick<CliIo, 'stdout' | 'stderr'>,
  json: boolean,
  out: WaitOutput,
  reportMd: string | null,
): number {
  const code = out.status === 'completed' ? EXIT.OK : out.status === 'timeout' ? EXIT_WAIT_TIMEOUT : EXIT.ERROR;
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
    case 'stalled':
      printError(io, false, 'ERROR', `run ${out.run_id} stalled in phase ${out.phase ?? 'unknown'}: ${out.reason ?? STALLED_REASON}`);
      break;
    case 'timeout':
      printHuman(io, `run ${out.run_id} is still going (phase ${out.phase ?? 'unknown'}); it keeps running. Wait again with: triage wait ${out.run_id}`);
      break;
  }
  return code;
}

export function createWaitCommand(options: WaitCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun'> = options.openStore ?? defaultOpenStore;
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const pollMs = options.pollMs ?? POLL_MS;
  return {
    path: ['wait'],
    summary: 'wait for a run to finish and print its report (a timeout never stops the run)',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to wait for')
        .option('--timeout <seconds>', `stop waiting after this many seconds (default ${DEFAULT_WAIT_SECONDS})`)
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
      const deadline = now() + seconds * 1000;
      for (;;) {
        const run = await store.getRun(runId);
        if (run === null) return printNotFound(io, json, runId);
        const settled = settledOutput(run, isAlive);
        if (settled !== undefined) return printWaitResult(io, json, settled, settled.status === 'completed' ? run.report_md : null);
        const left = deadline - now();
        if (left <= 0) return printWaitResult(io, json, { run_id: run.run_id, status: 'timeout', phase: run.phase }, null);
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
