// triage run (--slack-url <url> | --thread-file <json> | --text "...") [--ids k=v ...]
//            [--entities ...] [--tier ...] [--requested-by ...] [--interface ...] [--json]
//
// Runs a triage in this process and blocks until it settles: bootRuntime,
// prepareRequest, runSubmission, then the report from the run store. The
// human form prints report.md; --json prints {run_id, status, report?,
// reason?} in the same shape as `triage wait --json`. Exit 0 when the run
// completed, 1 when it failed. For coding agents whose shell tools time out,
// use `triage start` and `triage wait` instead (D28).
import type { Config } from '../../config/env.ts';
import { loadRegistry, type Registry } from '../../config/registry.ts';
import type { PreparedSubmission } from '../../ingress/prepare.ts';
import { runSubmission, submissionDeps, type SubmissionResult } from '../../ingress/submit.ts';
import type { WaitOutput } from '../lib/output-schemas.ts';
import { configureRequestArgs, parseRequestArgs, reportInputError } from '../lib/request-args.ts';
import type { CliCommand } from '../types.ts';
import { defaultPrepare, type PrepareFn } from './start.command.ts';
import { defaultOpenStore, type OpenStore } from './status.command.ts';
import { printWaitResult } from './wait.command.ts';

export type RunCommandOptions = {
  readonly openStore?: OpenStore<'getRun'>;
  readonly registry?: (config: Config) => Registry;
  /** Starts the Flue runtime. Defaults to bootRuntime(). */
  readonly boot?: () => Promise<unknown>;
  readonly prepare?: PrepareFn;
  /** Runs the prepared submission. Defaults to runSubmission with submissionDeps(). */
  readonly submit?: (prepared: PreparedSubmission, opts: { readonly isTty: boolean }) => Promise<SubmissionResult>;
  readonly defaultRequestedBy?: () => string | undefined;
};

// Imported on use: @flue/runtime/node loads node:sqlite, which prints an
// experimental warning, and `triage --help` loads every command module.
const lazyBoot = async (): Promise<unknown> => (await import('../../ingress/runtime.ts')).bootRuntime();

const defaultSubmit: NonNullable<RunCommandOptions['submit']> = (prepared, { isTty }) =>
  runSubmission(prepared, submissionDeps({ isTty }));

export function createRunCommand(options: RunCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun'> = options.openStore ?? defaultOpenStore;
  const registryOf = options.registry ?? ((config: Config) => loadRegistry(config));
  const boot = options.boot ?? lazyBoot;
  const prepare = options.prepare ?? defaultPrepare;
  const submit = options.submit ?? defaultSubmit;
  return {
    path: ['run'],
    summary: 'run a triage in this process and print the report when it settles',
    configure(cmd) {
      configureRequestArgs(cmd).option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const { io } = ctx;
      const json = opts.json;
      const config = ctx.config();
      const registry = registryOf(config);

      let prepared: PreparedSubmission;
      try {
        const input = parseRequestArgs(opts, {
          registry,
          ...(options.defaultRequestedBy !== undefined ? { defaultRequestedBy: options.defaultRequestedBy } : {}),
        });
        await boot();
        prepared = await prepare(input, config, registry);
      } catch (err) {
        const code = reportInputError(io, json, err);
        if (code === undefined) throw err;
        return code;
      }

      const result = await submit(prepared, { isTty: io.isTTY });
      const store = await openStore(config);
      const run = await store.getRun(result.run_id);

      let out: WaitOutput;
      if (result.status === 'completed') {
        out = { run_id: result.run_id, status: 'completed', ...(run?.report != null ? { report: { ...run.report } } : {}) };
      } else {
        out = { run_id: result.run_id, status: 'failed', reason: run?.phase_reason ?? result.error ?? 'unknown failure' };
      }
      return printWaitResult(io, json, out, result.status === 'completed' ? (run?.report_md ?? null) : null);
    },
  };
}

export const command: CliCommand = createRunCommand();
