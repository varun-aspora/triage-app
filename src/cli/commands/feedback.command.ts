// triage feedback <run_id> --verdict accept|reject|correct|partial|wrong|pending
//   [--notes <text>] [--finding <id>=<verdict> ...]
//   [--actual-root-cause <text>] [--faster-path <text>] [--given-by <name>]
//
// Records one feedback entry through recordFeedback (src/report/feedback.ts),
// the only feedback recorder, with interface 'cli'. The run does not have to
// be finished. accept is correct and reject is wrong. --finding takes an id
// from `triage status` or the console's Findings panel, for example
// ssfb.v2.e3=wrong, and can be repeated. The entry is appended to the run
// store; when the run has a report, feedback.md is re-rendered from all
// entries and an eval draft is written to
// <TRIAGE_HOME>/evals/_unreviewed/<run_id>/ for `triage fixtures review`.
//
// The verdict is checked before config or the store is touched, so a bad one
// writes nothing. Free text is never echoed back.

import { userInfo } from 'node:os';
import { relative } from 'node:path';
import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import { FeedbackError, recordFeedback, type FeedbackDeps, type FeedbackErrorCode } from '../../report/feedback.ts';
import { installRunEventLog } from '../../runlog/event-log.ts';
import { createRunStore } from '../../runstore/index.ts';
import {
  FEEDBACK_VERDICTS,
  FINDING_VERDICTS,
  FeedbackVerdictSchema,
  FindingVerdictSchema,
  type FeedbackVerdict,
  type RunStore,
} from '../../runstore/types.ts';
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
};

/** The console's words for the two common verdicts. */
export const VERDICT_ALIASES: Readonly<Record<string, FeedbackVerdict>> = { accept: 'correct', reject: 'wrong' };

const VERDICT_CHOICES = [...Object.keys(VERDICT_ALIASES), ...FEEDBACK_VERDICTS].join(', ');

/** --verdict: an alias or a stored verdict, exactly as written, or undefined when it is neither. */
export function parseVerdict(value: unknown): FeedbackVerdict | undefined {
  if (typeof value !== 'string') return undefined;
  if (Object.hasOwn(VERDICT_ALIASES, value)) return VERDICT_ALIASES[value];
  return v.is(FeedbackVerdictSchema, value) ? value : undefined;
}

type FindingFlag = { id: string; verdict: (typeof FINDING_VERDICTS)[number] };

/** --finding id=verdict (accept and reject work here too), or a reason it is not one. */
export function parseFindingFlag(value: string): FindingFlag | string {
  const at = value.lastIndexOf('=');
  if (at <= 0) return `--finding must be <id>=<verdict>, for example ssfb.v1.e2=wrong`;
  const id = value.slice(0, at).trim();
  const raw = value.slice(at + 1).trim();
  const verdict = Object.hasOwn(VERDICT_ALIASES, raw) ? VERDICT_ALIASES[raw] : raw;
  if (!v.is(FindingVerdictSchema, verdict)) return `--finding verdict must be one of accept, reject, ${FINDING_VERDICTS.join(', ')}`;
  return { id, verdict };
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export function createFeedbackCommand(options: FeedbackCommandOptions = {}): CliCommand {
  const makeStore = options.store ?? ((config: Config) => createRunStore(config));
  const osUser = options.osUser ?? defaultOsUser;

  return {
    path: ['feedback'],
    summary: 'accept or reject a run, finished or not, and write an eval case draft',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to give feedback on')
        .requiredOption('--verdict <verdict>', `one of ${VERDICT_CHOICES}`)
        .option('--notes <text>', 'notes on the verdict')
        .option('--finding <id=verdict>', 'a verdict on one finding, for example ssfb.v1.e2=wrong (repeatable)', collect)
        .option('--actual-root-cause <text>', 'the real root cause, if the report got it wrong')
        .option('--faster-path <text>', 'a query or path that would have found it sooner')
        .option('--given-by <name>', 'who gave the verdict (default: the OS user name)');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;

      const verdict = parseVerdict(opts.verdict);
      if (verdict === undefined) {
        printError(io, json, 'USAGE', `--verdict must be one of ${VERDICT_CHOICES}`);
        return EXIT.USAGE;
      }
      const findings: FindingFlag[] = [];
      for (const raw of Array.isArray(opts.finding) ? (opts.finding as string[]) : []) {
        const f = parseFindingFlag(raw);
        if (typeof f === 'string') {
          printError(io, json, 'USAGE', f);
          return EXIT.USAGE;
        }
        findings.push(f);
      }
      const givenBy = optionalString(opts.givenBy) ?? optionalString(osUser());
      if (givenBy === undefined) {
        printError(io, json, 'USAGE', 'no name for given_by: pass --given-by <name>');
        return EXIT.USAGE;
      }
      const runId = String(args[0] ?? '');

      const config = ctx.config();
      installRunEventLog({ runsDir: config.paths.runsDir });
      const deps: FeedbackDeps = {
        store: await makeStore(config),
        home: config.home,
        tracing: config.tracing,
        ...(options.now !== undefined ? { now: options.now } : {}),
      };

      try {
        const result = await recordFeedback(
          runId,
          {
            verdict,
            given_by: givenBy,
            interface: 'cli',
            ...(typeof opts.notes === 'string' ? { notes: opts.notes } : {}),
            ...(findings.length > 0 ? { findings } : {}),
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
          const lines = [
            `recorded verdict ${result.record.verdict} for run ${result.run_id} (${result.count} feedback entr${result.count === 1 ? 'y' : 'ies'})`,
          ];
          if (result.draft_dir !== null) {
            lines.push(
              `eval draft: ${result.draft_dir}`,
              `review it with: triage fixtures review (draft under ${relative(config.home, result.draft_dir)})`,
            );
          } else {
            lines.push('no eval draft: the run has no report yet');
          }
          printHuman(io, lines);
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
