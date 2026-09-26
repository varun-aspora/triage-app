// triage stop <run_id> [--given-by <name>] [--no-verdict] [--json]
//
// Stops a run that has not finished, through stopRun (src/ingress/stop.ts):
// the run store marks it stopped, a Cancel verdict (reject, no notes) is
// recorded unless --no-verdict is given, and once the agent was started Flue
// is asked for a durable abort of its instance. The process running the run
// sees the stop within a few seconds and stops its own steps. A follow-up
// (`triage ask`) resumes a stopped run.
//
// Prints {run_id, stopped_from, aborted, feedback_count, gaps} with --json.
// Exit 1 for an unknown run or one that has already finished, 2 for a usage
// error.
//
// The abort needs the Flue runtime, so this command starts one, but only
// when the run has reached the agent.

import { userInfo } from 'node:os';
import type { Config } from '../../config/env.ts';
import { IngressInputError } from '../../ingress/normalise.ts';
import { RunNotRunningError, stopRun, type StopDeps } from '../../ingress/stop.ts';
import { installRunEventLog } from '../../runlog/event-log.ts';
import { createRunStore } from '../../runstore/index.ts';
import { RunNotFoundError, type RunStore } from '../../runstore/types.ts';
import type { RunId } from '../../types/core.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';
import { checkRunIdArg, printNotFound } from './status.command.ts';

export type StopCommandOptions = {
  /** Builds the run store. The default is createRunStore(config). */
  readonly store?: (config: Config) => Promise<RunStore>;
  /** The durable Flue abort. The default starts the runtime and aborts the instance. */
  readonly abort?: (runId: RunId) => Promise<void>;
  /** The OS user name used when --given-by is not given. */
  readonly osUser?: () => string | undefined;
  readonly now?: () => Date;
};

// Imported on use: the runtime loads node:sqlite and every agent module.
const defaultAbort = async (runId: RunId): Promise<void> => {
  const [{ bootRuntime }, { init }, { Triage }] = await Promise.all([
    import('../../ingress/runtime.ts'),
    import('@flue/runtime'),
    import('../../agents/triage.agent.ts'),
  ]);
  await bootRuntime();
  await init(Triage, { id: runId }).abort();
};

export function createStopCommand(options: StopCommandOptions = {}): CliCommand {
  const makeStore = options.store ?? ((config: Config) => createRunStore(config));
  const osUser = options.osUser ?? defaultOsUser;
  const abort = options.abort ?? defaultAbort;

  return {
    path: ['stop'],
    summary: 'stop a run that is still going and record it as rejected',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to stop')
        .option('--given-by <name>', 'who stopped it (default: the OS user name)')
        .option('--no-verdict', 'stop without recording the Cancel verdict')
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json === true;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;
      const by = optionalString(opts.givenBy) ?? optionalString(osUser());
      if (by === undefined) {
        printError(io, json, 'USAGE', 'no name for given_by: pass --given-by <name>');
        return EXIT.USAGE;
      }

      const config = ctx.config();
      installRunEventLog({ runsDir: config.paths.runsDir });
      const deps: StopDeps = {
        store: await makeStore(config),
        home: config.home,
        tracing: config.tracing,
        abort,
        ...(options.now !== undefined ? { now: options.now } : {}),
      };
      try {
        const result = await stopRun(runId, { by, interface: 'cli', verdict: opts.verdict !== false }, deps);
        if (json) {
          printJson(io, {
            run_id: result.run_id,
            stopped_from: result.stopped_from,
            aborted: result.aborted,
            feedback_count: result.feedback?.count ?? null,
            gaps: [...result.gaps],
          });
        } else {
          printHuman(io, [
            `stopped run ${result.run_id} (it was in phase ${result.stopped_from})`,
            ...(result.feedback !== null ? ['recorded it as rejected (cancelled)'] : []),
            ...result.gaps.map((g) => `note: ${g}`),
            `resume it with a follow-up: triage ask ${result.run_id} "<question>"`,
          ]);
        }
        return EXIT.OK;
      } catch (err) {
        if (err instanceof RunNotFoundError) return printNotFound(io, json, runId);
        if (err instanceof RunNotRunningError) {
          printError(io, json, 'ERROR', `run ${runId} is not running (phase ${err.phase}); nothing to stop`);
          return EXIT.ERROR;
        }
        if (err instanceof IngressInputError) {
          printError(io, json, 'USAGE', `${err.key === 'by' ? '--given-by' : err.key} ${err.reason}`);
          return EXIT.USAGE;
        }
        throw err;
      }
    },
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s === '' ? undefined : s;
}

function defaultOsUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export const command: CliCommand = createStopCommand();
