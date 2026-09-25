// triage logs <run_id> [--follow] [--after <n>] [--type <t> ...] [--json]
//
// Prints a run's event log (<TRIAGE_RUNS_DIR>/<run_id>/events.jsonl, see
// src/runlog/event-log.ts): the ingress pipeline's steps and every Flue event
// of the run, redacted like everything else stored for it. One line per
// event: index, time, source, type and a short summary. --json prints each
// stored line as it is, with its index, one JSON document per line.
//
// --follow keeps reading while the run is going and stops once the run has
// finished (or waits on a question) and no new line has come in.
// --after skips the first n lines, so a later call can pick up where the
// last one ended. --type keeps only the named event types.

import type { Config } from '../../config/env.ts';
import { readRunEvents, type NumberedRunEvent } from '../../runlog/read.ts';
import { summariseEvent } from '../../runlog/summary.ts';
import { createRunStore } from '../../runstore/index.ts';
import { isTerminalPhase, type RunStore } from '../../runstore/types.ts';
import { EXIT, printError } from '../output.ts';
import type { CliCommand, CliIo } from '../types.ts';
import { checkRunIdArg, printNotFound } from './status.command.ts';

/** How often --follow reads the file. */
export const FOLLOW_POLL_MS = 1000;

export type LogsCommandOptions = {
  readonly openStore?: (config: Config) => Promise<Pick<RunStore, 'getRun'>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export function createLogsCommand(options: LogsCommandOptions = {}): CliCommand {
  const openStore = options.openStore ?? ((config: Config) => createRunStore(config));
  const sleep = options.sleep ?? realSleep;
  const pollMs = options.pollMs ?? FOLLOW_POLL_MS;
  return {
    path: ['logs'],
    summary: "print a run's step-by-step event log",
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run')
        .option('--follow', 'keep printing new lines until the run finishes')
        .option('--after <n>', 'skip the first n lines')
        .option('--type <type>', 'only this event type, for example tool or turn (repeatable)', collect)
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json === true;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;
      let after = 0;
      if (opts.after !== undefined) {
        if (typeof opts.after !== 'string' || !/^[0-9]{1,9}$/.test(opts.after)) {
          printError(io, json, 'USAGE', '--after must be a whole number');
          return EXIT.USAGE;
        }
        after = Number(opts.after);
      }
      const types = new Set(Array.isArray(opts.type) ? (opts.type as string[]) : []);

      const config = ctx.config();
      const store = await openStore(config);
      if ((await store.getRun(runId)) === null) return printNotFound(io, json, runId);

      for (;;) {
        const page = await readRunEvents(config.paths.runsDir, runId, { after });
        for (const e of page.events) if (types.size === 0 || types.has(e.type)) printLine(io, e, json);
        after = page.next;
        if (page.more) continue;
        if (opts.follow !== true) return EXIT.OK;
        const run = await store.getRun(runId);
        const settled = run === null || isTerminalPhase(run.phase) || run.phase === 'needs_input';
        if (settled) {
          // One more read picks up lines queued just before the settle.
          const last = await readRunEvents(config.paths.runsDir, runId, { after });
          for (const e of last.events) if (types.size === 0 || types.has(e.type)) printLine(io, e, json);
          return EXIT.OK;
        }
        await sleep(pollMs);
      }
    },
  };
}

function printLine(io: Pick<CliIo, 'stdout'>, e: NumberedRunEvent, json: boolean): void {
  if (json) {
    io.stdout.write(`${JSON.stringify(e)}\n`);
    return;
  }
  const time = e.ts.length >= 23 ? e.ts.slice(11, 23) : e.ts;
  io.stdout.write(`${String(e.index).padStart(5)} ${time} ${e.source.padEnd(8)} ${e.type.padEnd(20)} ${summariseEvent(e)}\n`);
}

export const command: CliCommand = createLogsCommand();
