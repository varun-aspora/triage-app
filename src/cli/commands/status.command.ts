// triage status <run_id> [--json]
//
// Prints {run_id, status, phase, tier_final, submissions, preflight_warnings,
// input_request?, block?, usage?} from the run store. status is the phase
// folded into running, completed, failed or stopped, plus 'needs_input'
// (parked on a question for the requester; the worker is gone by design, P6 §4.5),
// 'blocked' (parked on a system that did not answer, D55; `triage resume`
// sends it on) and 'stalled': the phase is not terminal and the worker pid
// recorded on the run is no longer alive, so nothing will finish the run.
// Crash recovery is not built in v1; the caller reruns.
//
// usage (D59) is the run's token and cost totals from src/usage/summary.ts,
// present in --json only when something was counted. The human form prints
// one cost line and one line per model, or 'usage: not recorded'. The counts
// are live (flushed while a submission runs) only while the worker is alive;
// a stalled run's open counts show as incomplete.
//
// runStatusOf and pidAlive are shared with wait and ask; the usage helpers
// with wait and usage.
import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import { createRunStore } from '../../runstore/index.ts';
import { isTerminalPhase, type RunRecord, type RunStore } from '../../runstore/types.ts';
import { RunIdSchema } from '../../types/core.ts';
import type { RunUsageView, UsageTotals } from '../../types/usage.ts';
import { summariseUsage } from '../../usage/summary.ts';
import { answerHint, blockLines, copyBlock, questionLines, resumeHint } from '../lib/input-request.ts';
import {
  emitJson,
  StatusOutputSchema,
  type RunStatus,
  type StatusOutput,
  type UsageBreakdown,
} from '../lib/output-schemas.ts';
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

/**
 * The run's usage view. status is runStatusOf(run): the counts are live only
 * while it is 'running', which already means the worker is alive.
 */
export function usageViewOf(run: Pick<RunRecord, 'usage'>, status: RunStatus): RunUsageView {
  return summariseUsage(run.usage, { running: status === 'running' });
}

/** { usage } when anything was counted, else nothing, so older runs keep their JSON shape. */
export function usageField(view: RunUsageView): { usage?: RunUsageView } {
  return view.recorded ? { usage: view } : {};
}

/** '$0.42', '<$0.01', '$0.00'. Same rule as the web console. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** '950', '12.4k', '1.2M'. Same rule as the web console. */
export function formatTokens(n: number): string {
  const trim = (x: number): string => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''));
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/** '37 calls (1 failed) · 120k in / 90k cache read / 4k cache write / 8k out'. */
function countsText(t: UsageTotals): string {
  const calls = `${t.calls} ${t.calls === 1 ? 'call' : 'calls'}${t.failed_calls > 0 ? ` (${t.failed_calls} failed)` : ''}`;
  const tokens = [
    `${formatTokens(t.input_tokens)} in`,
    `${formatTokens(t.cache_read_tokens)} cache read`,
    `${formatTokens(t.cache_write_tokens)} cache write`,
    `${formatTokens(t.output_tokens)} out`,
  ].join(' / ');
  return `${calls} · ${tokens}`;
}

/** The cost of one breakdown bucket. It has no pricing flag, so it is read off unpriced_models. */
function bucketCost(t: UsageTotals): string {
  if (t.unpriced_models.length === 0) return formatUsd(t.usd);
  return t.usd > 0 ? `${formatUsd(t.usd)} (partial)` : 'no price';
}

function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The cost, then its marks: '$0.42 (partial) (live, updated 4s ago)'. */
function costText(view: RunUsageView, now: number): string {
  const marks: string[] = [];
  if (view.pricing === 'partial') marks.push('partial');
  if (view.fake) marks.push('estimates, fake model');
  if (view.live) {
    marks.push(view.updated_at !== null ? `live, updated ${agoText(now - Date.parse(view.updated_at))} ago` : 'live');
  }
  if (view.incomplete) marks.push('incomplete: the worker ended before the final count');
  const cost = view.pricing === 'none' ? 'unknown (no pricing)' : formatUsd(view.total.usd);
  return [cost, ...marks.map((m) => `(${m})`)].join(' ');
}

/**
 * The one-line total without a label: '$0.42 (partial) · 37 calls (1 failed) ·
 * 120k in / 90k cache read / 4k cache write / 8k out'. Callers check recorded first.
 */
export function usageTotalText(view: RunUsageView, now: number): string {
  return `${costText(view, now)} · ${countsText(view.total)}`;
}

/** The short form for the live line of `triage wait`: '$0.12 · 14 calls'. */
export function usageShortText(view: RunUsageView): string {
  const cost = view.pricing === 'none' ? 'unknown' : `${formatUsd(view.total.usd)}${view.pricing === 'partial' ? ' (partial)' : ''}`;
  return `${cost} · ${view.total.calls} ${view.total.calls === 1 ? 'call' : 'calls'}`;
}

/** One '  - <key>: ...' line per bucket of the breakdown. seq 0 is the intake. */
export function usageBreakdownLines(view: RunUsageView, by: UsageBreakdown): string[] {
  const buckets = by === 'model' ? view.by_model : by === 'agent' ? view.by_agent : view.by_submission;
  return Object.entries(buckets).map(([key, t]) => {
    const label = by === 'submission' ? (key === '0' ? 'intake' : `submission ${key}`) : key;
    return `  - ${label}: ${bucketCost(t)} · ${countsText(t)}`;
  });
}

/** 'cost: ...' plus one line per model, or 'usage: not recorded'. */
export function usageLines(view: RunUsageView, now: number): string[] {
  if (!view.recorded) return ['usage: not recorded'];
  return [`cost: ${usageTotalText(view, now)}`, ...usageBreakdownLines(view, 'model')];
}

export function statusOutput(run: RunRecord, isAlive: PidChecker): StatusOutput {
  const status = runStatusOf(run, isAlive);
  return {
    run_id: run.run_id,
    status,
    phase: run.phase,
    tier_final: run.classification?.decision.tier_final ?? null,
    submissions: run.submissions.length,
    preflight_warnings: (run.classification?.preflight_warnings ?? []).map((w) => ({ ...w })),
    ...(run.input_request !== null ? { input_request: { ...run.input_request, options: [...run.input_request.options] } } : {}),
    ...(run.block !== null ? { block: copyBlock(run.block) } : {}),
    ...usageField(usageViewOf(run, status)),
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
  /** For 'updated Ns ago'. */
  readonly now?: () => number;
};

export function createStatusCommand(options: StatusCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun'> = options.openStore ?? defaultOpenStore;
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  return {
    path: ['status'],
    summary: 'show where a run is: phase, tier, submissions, cost and pre-flight warnings',
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
          ...usageLines(out.usage ?? usageViewOf(run, out.status), now()),
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
