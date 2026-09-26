// triage usage <run_id> [--by model|agent|submission] [--json]
//
// Prints the token and cost totals of one run (D59) from the run store: one
// cost line, then one line per model, agent or submission (--by, default
// model). Submission 0 is the intake (classifier, prior-cases embedding).
// --json prints {run_id, status, usage} with the whole view, every
// breakdown included; --by only picks the human breakdown.
//
// usage.recorded is false when nothing was counted, for example a run from
// before D59; the human form then says 'usage: not recorded', never $0. The
// counts are live while the run is running with its worker alive, and
// incomplete when a submission's final count never landed (a stalled or
// killed worker).
import { emitJson, USAGE_BREAKDOWNS, UsageOutputSchema, type UsageBreakdown, type UsageOutput } from '../lib/output-schemas.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand } from '../types.ts';
import {
  checkRunIdArg,
  defaultOpenStore,
  pidAlive,
  printNotFound,
  runStatusOf,
  usageBreakdownLines,
  usageTotalText,
  usageViewOf,
  type OpenStore,
  type PidChecker,
} from './status.command.ts';

export type UsageCommandOptions = {
  readonly openStore?: OpenStore<'getRun'>;
  readonly isAlive?: PidChecker;
  /** For 'updated Ns ago'. */
  readonly now?: () => number;
};

export function createUsageCommand(options: UsageCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun'> = options.openStore ?? defaultOpenStore;
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  return {
    path: ['usage'],
    summary: 'show the tokens and cost of a run, by model, agent or submission',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to show')
        .option('--by <breakdown>', `the breakdown to print: ${USAGE_BREAKDOWNS.join(', ')} (default model)`)
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;
      const by = breakdownOf(opts.by);
      if (by === undefined) {
        printError(io, json, 'USAGE', `--by must be one of ${USAGE_BREAKDOWNS.join(', ')}`);
        return EXIT.USAGE;
      }

      const store = await openStore(ctx.config());
      const run = await store.getRun(runId);
      if (run === null) return printNotFound(io, json, runId);

      const status = runStatusOf(run, isAlive);
      const out: UsageOutput = { run_id: run.run_id, status, usage: usageViewOf(run, status) };
      if (json) {
        emitJson(io, UsageOutputSchema, out);
        return EXIT.OK;
      }
      printHuman(io, [
        `run ${out.run_id}: ${out.status}`,
        ...(out.usage.recorded
          ? [`cost: ${usageTotalText(out.usage, now())}`, `by ${by}:`, ...usageBreakdownLines(out.usage, by)]
          : ['usage: not recorded']),
      ]);
      return EXIT.OK;
    },
  };
}

function breakdownOf(value: unknown): UsageBreakdown | undefined {
  if (value === undefined) return 'model';
  return USAGE_BREAKDOWNS.find((b) => b === value);
}

export const command: CliCommand = createUsageCommand();
