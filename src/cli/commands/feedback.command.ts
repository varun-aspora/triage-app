// triage feedback <run_id> --verdict correct|partial|wrong|pending
//   [--actual-root-cause <text>] [--faster-path <text>] [--given-by <name>]
//
// Records one feedback entry for a finished run through recordFeedback
// (src/report/feedback.ts), the only feedback recorder, with interface 'cli'.
// The entry is appended to the run store, feedback.md is re-rendered from all
// entries, and an eval draft is written to
// <TRIAGE_HOME>/evals/_unreviewed/<run_id>/ for `triage fixtures review`.
//
// The verdict is checked before config or the store is touched, so a bad one
// writes nothing. Free text is never echoed back.

import { userInfo } from 'node:os';
import { relative } from 'node:path';
import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import { FeedbackError, recordFeedback, type FeedbackDeps, type FeedbackErrorCode } from '../../report/feedback.ts';
import { createRunStore } from '../../runstore/index.ts';
import { FEEDBACK_VERDICTS, FeedbackVerdictSchema, type RunStore } from '../../runstore/types.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type FeedbackCommandOptions = {
  /** Builds the run store. The default is createRunStore(config). */
  readonly store?: (config: Config) => Promise<RunStore>;
  /** The OS user name used when --given-by is not given. */
  readonly osUser?: () => string | undefined;
  readonly now?: () => Date;
};

const EXIT_FOR: Record<FeedbackErrorCode, number> = {
  invalid_input: EXIT.USAGE,
  invalid_run_id: EXIT.USAGE,
  run_not_found: EXIT.ERROR,
  no_report: EXIT.ERROR,
};

export function createFeedbackCommand(options: FeedbackCommandOptions = {}): CliCommand {
  const makeStore = options.store ?? ((config: Config) => createRunStore(config));
  const osUser = options.osUser ?? defaultOsUser;

  return {
    path: ['feedback'],
    summary: 'record a verdict on a finished run and write an eval case draft',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to give feedback on')
        .requiredOption('--verdict <verdict>', `one of ${FEEDBACK_VERDICTS.join(', ')}`)
        .option('--actual-root-cause <text>', 'the real root cause, if the report got it wrong')
        .option('--faster-path <text>', 'a query or path that would have found it sooner')
        .option('--given-by <name>', 'who gave the verdict (default: the OS user name)');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;

      if (!v.is(FeedbackVerdictSchema, opts.verdict)) {
        printError(io, json, 'USAGE', `--verdict must be one of ${FEEDBACK_VERDICTS.join(', ')}`);
        return EXIT.USAGE;
      }
      const givenBy = optionalString(opts.givenBy) ?? optionalString(osUser());
      if (givenBy === undefined) {
        printError(io, json, 'USAGE', 'no name for given_by: pass --given-by <name>');
        return EXIT.USAGE;
      }
      const runId = String(args[0] ?? '');

      const config = ctx.config();
      const deps: FeedbackDeps = {
        store: await makeStore(config),
        home: config.home,
        ...(options.now !== undefined ? { now: options.now } : {}),
      };

      try {
        const result = await recordFeedback(
          runId,
          {
            verdict: opts.verdict,
            given_by: givenBy,
            interface: 'cli',
            ...(typeof opts.actualRootCause === 'string' ? { actual_root_cause: opts.actualRootCause } : {}),
            ...(typeof opts.fasterPath === 'string' ? { faster_path: opts.fasterPath } : {}),
          },
          deps,
        );
        if (json) {
          printJson(io, {
            run_id: result.run_id,
            verdict: result.record.verdict,
            feedback_count: result.count,
            draft_dir: result.draft_dir,
            draft_files: result.draft_files,
          });
        } else {
          printHuman(io, [
            `recorded verdict ${result.record.verdict} for run ${result.run_id} (${result.count} feedback entr${result.count === 1 ? 'y' : 'ies'})`,
            `eval draft: ${result.draft_dir}`,
            `review it with: triage fixtures review (draft under ${relative(config.home, result.draft_dir)})`,
          ]);
        }
        return EXIT.OK;
      } catch (err) {
        if (err instanceof FeedbackError) {
          const code = EXIT_FOR[err.code];
          printError(io, json, code === EXIT.USAGE ? 'USAGE' : 'ERROR', err.message);
          return code;
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

export const command: CliCommand = createFeedbackCommand();
