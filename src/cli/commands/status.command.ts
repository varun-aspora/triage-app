// triage status <run_id> [--json]
//
// Prints {run_id, status, phase, tier_final, submissions, preflight_warnings,
// input_request?, block?} from the run store. status is the phase folded into
// running, completed, failed or stopped, plus 'needs_input' (parked on a
// question for the requester; the worker is gone by design, P6 §4.5),
// 'blocked' (parked on a system that did not answer, D55; `triage resume`
// sends it on) and 'stalled': the phase is not terminal and the worker pid
// recorded on the run is no longer alive, so nothing will finish the run.
// Crash recovery is not built in v1; the caller reruns.
//
// runStatusOf and pidAlive are shared with wait and ask.
import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import { createRunStore } from '../../runstore/index.ts';
import { isTerminalPhase, type RunRecord, type RunStore } from '../../runstore/types.ts';
import { RunIdSchema } from '../../types/core.ts';
import { answerHint, blockLines, copyBlock, questionLines, resumeHint } from '../lib/input-request.ts';
import { emitJson, StatusOutputSchema, type RunStatus, type StatusOutput } from '../lib/output-schemas.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand, CliIo } from '../types.ts';

/** True when a process with this pid exists. */
export type PidChecker = (pid: number) => boolean;

/** Builds the run store. Commands ask for the methods they use, so tests can pass a small fake. */
export type OpenStore<K extends keyof RunStore = keyof RunStore> = (config: Config) => Promise<Pick<RunStore, K>>;

/** Signal 0 checks that the process exists without touching it. EPERM means it exists. */
export const pidAlive: PidChecker = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'EPERM';
  }
};

/** The run's status. A run with no recorded pid is still running as far as anyone can tell. */
export function runStatusOf(run: Pick<RunRecord, 'phase' | 'worker_pid'>, isAlive: PidChecker): RunStatus {
  if (run.phase === 'completed') return 'completed';
  if (run.phase === 'failed') return 'failed';
  if (run.phase === 'stopped') return 'stopped';
  if (run.phase === 'needs_input') return 'needs_input';
  if (run.phase === 'blocked') return 'blocked';
  if (run.worker_pid !== undefined && !isAlive(run.worker_pid)) return 'stalled';
  return 'running';
}

export const STALLED_REASON = 'the worker process is gone; rerun the request';

export function statusOutput(run: RunRecord, isAlive: PidChecker): StatusOutput {
  return {
    run_id: run.run_id,
    status: runStatusOf(run, isAlive),
    phase: run.phase,
    tier_final: run.classification?.decision.tier_final ?? null,
    submissions: run.submissions.length,
    preflight_warnings: (run.classification?.preflight_warnings ?? []).map((w) => ({ ...w })),
    ...(run.input_request !== null ? { input_request: { ...run.input_request, options: [...run.input_request.options] } } : {}),
    ...(run.block !== null ? { block: copyBlock(run.block) } : {}),
  };
}

/** Checks the run id argument. Prints the usage error and returns false when it is bad. */
export function checkRunIdArg(io: Pick<CliIo, 'stdout' | 'stderr'>, json: boolean, value: unknown): value is string {
  if (typeof value === 'string' && v.is(RunIdSchema, value)) return true;
  printError(io, json, 'USAGE', 'run_id must be 1 to 64 letters, digits, _ or -');
  return false;
}

export function printNotFound(io: Pick<CliIo, 'stdout' | 'stderr'>, json: boolean, runId: string): number {
  printError(io, json, 'ERROR', `run not found: ${runId}`);
  return EXIT.ERROR;
}

export const defaultOpenStore: OpenStore = (config) => createRunStore(config);

export type StatusCommandOptions = {
  readonly openStore?: OpenStore<'getRun'>;
  readonly isAlive?: PidChecker;
};

export function createStatusCommand(options: StatusCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun'> = options.openStore ?? defaultOpenStore;
  const isAlive = options.isAlive ?? pidAlive;
  return {
    path: ['status'],
    summary: 'show where a run is: phase, tier, submissions and pre-flight warnings',
    configure(cmd) {
      cmd.argument('<run_id>', 'the run to show').option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;

      const store = await openStore(ctx.config());
      const run = await store.getRun(runId);
      if (run === null) return printNotFound(io, json, runId);

      const out = statusOutput(run, isAlive);
      if (json) {
        emitJson(io, StatusOutputSchema, out);
      } else {
        printHuman(io, [
          `run ${out.run_id}: ${out.status} (phase ${out.phase}${isTerminalPhase(out.phase) ? '' : ', not finished'})`,
          `tier: ${out.tier_final ?? 'not decided yet'}`,
          `submissions: ${out.submissions}`,
          ...(out.status === 'stalled' ? [`note: ${STALLED_REASON}`] : []),
          ...(out.status === 'needs_input' && out.input_request !== undefined
            ? ['', ...questionLines(out.run_id, out.input_request), '', ...answerHint(out.run_id)]
            : []),
          ...(out.status === 'blocked' && out.block !== undefined ? ['', ...blockLines(out.run_id, out.block), '', ...resumeHint(out.run_id)] : []),
          ...(out.preflight_warnings.length === 0
            ? []
            : ['pre-flight warnings:', ...out.preflight_warnings.map((w) => `  - ${w.entity !== undefined ? `${w.entity} ` : ''}${w.step}: ${w.message}`)]),
        ]);
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createStatusCommand();
