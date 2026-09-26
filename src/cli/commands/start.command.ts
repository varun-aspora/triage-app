// triage start (--slack-url <url> | --thread-file <json> | --text "...") [--ids k=v ...]
//              [--entities ...] [--tier ...] [--requested-by ...] [--interface ...] [--json]
//
// Starts a run and returns at once (D28). In order:
//   1. The input flags are checked (exit 2 on a usage error).
//   2. prepareRequest runs here, in this process, so input errors and a
//      failed Slack read fail fast. A failed Slack read exits 1 with the
//      --thread-file hint and starts nothing.
//   3. The run is created in the run store (persisted profile), so `triage
//      wait` and `triage status` find it straight away.
//   4. spawnWorker starts the detached __worker with the prepared request on
//      its stdin. The worker records its own pid and runs the submission.
//   5. With --json, stdout gets exactly one line: {"run_id": "..."}.
//
// If the worker cannot be started, the run is marked failed with the error
// class name and the command exits 1.
import type { Config } from '../../config/env.ts';
import { loadRegistry, type Registry } from '../../config/registry.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { spawnWorker } from '../../ingress/detach.ts';
import { prepareDeps, prepareRequest, type PrepareInput, type PreparedSubmission } from '../../ingress/prepare.ts';
import { failureReason } from '../../ingress/submit.ts';
import type { WorkerPayload } from '../../ingress/worker-payload.ts';
import { emitJson, StartOutputSchema } from '../lib/output-schemas.ts';
import { configureRequestArgs, parseRequestArgs, reportInputError } from '../lib/request-args.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand } from '../types.ts';
import { defaultOpenStore, type OpenStore } from './status.command.ts';

export type PrepareFn = (input: PrepareInput, config: Config, registry: Registry) => Promise<PreparedSubmission>;
export type SpawnFn = (payload: WorkerPayload) => Promise<{ pid: number }>;

export type StartCommandOptions = {
  readonly openStore?: OpenStore<'createRun' | 'setPhase'>;
  readonly registry?: (config: Config) => Registry;
  readonly prepare?: PrepareFn;
  readonly spawn?: SpawnFn;
  readonly defaultRequestedBy?: () => string | undefined;
};

/** The real prepare step: prepareRequest with the deps built from config and registry. */
export const defaultPrepare: PrepareFn = (input, config, registry) => prepareRequest(input, prepareDeps(config, registry));

export function createStartCommand(options: StartCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'createRun' | 'setPhase'> = options.openStore ?? defaultOpenStore;
  const registryOf = options.registry ?? ((config: Config) => loadRegistry(config));
  const prepare = options.prepare ?? defaultPrepare;
  const spawn = options.spawn ?? ((payload: WorkerPayload) => spawnWorker(payload));
  return {
    path: ['start'],
    summary: 'start a triage run in the background and print its run_id',
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
        prepared = await prepare(input, config, registry);
      } catch (err) {
        const code = reportInputError(io, json, err);
        if (code === undefined) throw err;
        return code;
      }

      const runId = prepared.run_id;
      const store = await openStore(config);
      await store.createRun(runId, redactPersisted(prepared.request, { names: [...prepared.redaction_names] }));

      try {
        await spawn({
          kind: 'submit',
          run_id: runId,
          request: prepared.request,
          redaction_names: [...prepared.redaction_names],
        });
      } catch (err) {
        await store.setPhase(runId, 'failed', { reason: failureReason(err) }).catch(() => undefined);
        printError(io, json, 'ERROR', err instanceof Error ? err.message : 'could not start the worker');
        return EXIT.ERROR;
      }

      if (json) emitJson(io, StartOutputSchema, { run_id: runId });
      else printHuman(io, [`started run ${runId}`, `follow it with: triage wait ${runId}`]);
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createStartCommand();
