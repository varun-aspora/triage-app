// triage resume <run_id> [message] [--requested-by <who>] [--json]
//
// Sends a blocked run on once the system it waited for answers again (D55),
// through a detached worker that calls resumeRun, and prints
// {run_id, submission_id}. submission_id is the run store seq the resume
// gets. Follow it with `triage wait <run_id>`. A run that failed after it was
// dispatched, or was stopped, is resumed the same way.
//
// The message is for the model and the record: what was fixed, and
// anything new the run should take into account.
//
// Refused, with nothing started (exit 1, the same rules and hints as
// resumeRun):
//   - an unknown run;
//   - a run that is still going, in any phase before it settled;
//   - a run waiting on a question: that is answered with `triage input`;
//   - a completed run: that takes a follow-up with `triage ask`;
//   - a run that failed before it started an investigation: it has no
//     conversation to continue, so a new run is needed.
// A bad run_id, a blank or over-long message, or no --requested-by when the OS
// user name is unavailable exit 2.
//
// The worker decides from the stored phase whether the run can go on, so
// this command leaves the phase alone (unlike `triage ask`, which marks the
// run dispatched at once). Instead it waits until the worker has taken the
// run over: the block closed, the resume submission added or the phase moved
// on. So a `triage wait` right after this does not see the block, the
// failure or the stop the run is being resumed from. If the worker exits
// before that, or gives up before it sent the run on, this exits 1 and says
// so. If the worker is still starting after the takeover timeout, this
// returns anyway: the run is on its way.
//
// Before the worker starts, this repeats the tunnel part of pre-flight (D56):
// in local mode the SSFB tunnel may have died while the run was parked, so
// `triage resume` brings it back, and refuses here, with the reason and the
// fix, when it does not come up (exit 1, nothing started). The worker makes
// the same check; this one is for the person's eyes, since the worker's
// output is not shown.
import type { Config } from '../../config/env.ts';
import { loadRegistry, RegistryError, type Registry } from '../../config/registry.ts';
import { createExecRunner } from '../../connectors/exec.ts';
import { spawnWorker } from '../../ingress/detach.ts';
import { resumeReadinessRefusal, resumeRefusal } from '../../ingress/submit.ts';
import { netTcpConnect } from '../../ops/doctor/probes.ts';
import { runTunnelPreflight, type PreflightResult } from '../../ops/preflight.ts';
import type { RunRecord } from '../../runstore/types.ts';
import { MAX_RESUME_NOTE_CHARS } from '../../types/block.ts';
import { emitJson, ResumeOutputSchema } from '../lib/output-schemas.ts';
import { requestedByOf, reportInputError, UsageError } from '../lib/request-args.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand } from '../types.ts';
import type { SpawnFn } from './start.command.ts';
import { checkRunIdArg, defaultOpenStore, pidAlive, printNotFound, type OpenStore, type PidChecker } from './status.command.ts';

/** How often the store is read while the worker takes the run over. */
export const TAKEOVER_POLL_MS = 250;
/** How long to wait for the worker before returning anyway. */
export const TAKEOVER_TIMEOUT_MS = 30_000;

export type ResumeCommandOptions = {
  readonly openStore?: OpenStore<'getRun'>;
  readonly spawn?: SpawnFn;
  readonly isAlive?: PidChecker;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly takeoverMs?: number;
  readonly defaultRequestedBy?: () => string | undefined;
  /** The resume pre-flight (the SSFB tunnel, D56). Defaults to runTunnelPreflight with the real runner and probe. */
  readonly readiness?: (config: Config, isTty: boolean) => Promise<Pick<PreflightResult, 'warnings'>>;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The resume pre-flight with the real runner and probe. A registry that does not load is the worker's to report; nothing is checked here. */
async function defaultReadiness(config: Config, isTty: boolean): Promise<Pick<PreflightResult, 'warnings'>> {
  let registry: Registry;
  try {
    registry = loadRegistry(config);
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    return { warnings: [] };
  }
  return runTunnelPreflight({ config, registry, runner: createExecRunner(), tcpProbe: netTcpConnect, isTty });
}

type TakeoverView = Pick<RunRecord, 'phase' | 'submissions' | 'block'>;

/** True once resumeRun in the worker has written: the block closed, the resume submission added or the phase moved. */
export function takenOver(before: TakeoverView, now: TakeoverView): boolean {
  return now.submissions.length > before.submissions.length || now.phase !== before.phase || (before.block !== null && now.block === null);
}

type Takeover =
  | { readonly kind: 'taken'; readonly run: RunRecord }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'worker_exited'; readonly run: RunRecord };

export function createResumeCommand(options: ResumeCommandOptions = {}): CliCommand {
  const openStore: OpenStore<'getRun'> = options.openStore ?? defaultOpenStore;
  const spawn = options.spawn ?? ((payload) => spawnWorker(payload));
  const isAlive = options.isAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const pollMs = options.pollMs ?? TAKEOVER_POLL_MS;
  const takeoverMs = options.takeoverMs ?? TAKEOVER_TIMEOUT_MS;
  const readiness = options.readiness ?? defaultReadiness;
  return {
    path: ['resume'],
    summary: 'send a run on after the system it was blocked on answers again (also a run that failed or was stopped)',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run to send on')
        .argument('[message]', 'what was fixed, and anything new the run should take into account')
        .option('--requested-by <who>', 'who resumed it (email or Slack user id); defaults to the OS user')
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = args[0];
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;

      let note: string | undefined;
      let by: string;
      try {
        note = noteOf(args[1]);
        const who = requestedByOf(opts, options.defaultRequestedBy !== undefined ? { defaultRequestedBy: options.defaultRequestedBy } : {});
        if (who === undefined) throw new UsageError('--requested-by is required (the OS user name is not available)');
        by = who;
      } catch (err) {
        const code = reportInputError(io, json, err);
        if (code === undefined) throw err;
        return code;
      }

      const config = ctx.config();
      const store = await openStore(config);
      const before = await store.getRun(runId);
      if (before === null) return printNotFound(io, json, runId);
      const refusal = resumeRefusal(before);
      if (refusal !== null) {
        printError(io, json, 'ERROR', refusal.message);
        return EXIT.ERROR;
      }
      // The network path first (D56): brings the SSFB tunnel back in local
      // mode, and refuses with the fix when it does not come up.
      const notReady = resumeReadinessRefusal(before, await readiness(config, io.isTTY));
      if (notReady !== null) {
        printError(io, json, 'ERROR', notReady.message);
        return EXIT.ERROR;
      }
      const submissionId = before.submissions.length + 1;

      let pid: number;
      try {
        ({ pid } = await spawn({ kind: 'resume', run_id: runId, by, ...(note !== undefined ? { note } : {}) }));
      } catch (err) {
        printError(io, json, 'ERROR', err instanceof Error ? err.message : 'could not start the worker');
        return EXIT.ERROR;
      }

      const deadline = now() + takeoverMs;
      let outcome: Takeover;
      for (;;) {
        const run = await store.getRun(runId);
        if (run === null) {
          outcome = { kind: 'gone' };
          break;
        }
        if (takenOver(before, run)) {
          outcome = { kind: 'taken', run };
          break;
        }
        if (!isAlive(pid)) {
          outcome = { kind: 'worker_exited', run };
          break;
        }
        if (now() >= deadline) {
          outcome = { kind: 'timeout' };
          break;
        }
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
      }

      if (outcome.kind === 'gone') return printNotFound(io, json, runId);
      if (outcome.kind === 'worker_exited') {
        printError(io, json, 'ERROR', `the worker exited before it resumed run ${runId} (${describePhase(outcome.run)}); see: triage logs ${runId}`);
        return EXIT.ERROR;
      }
      // The worker gave up before it sent the run on: a failed runtime start, for example.
      if (outcome.kind === 'taken' && outcome.run.phase === 'failed' && outcome.run.submissions.length === before.submissions.length) {
        printError(io, json, 'ERROR', `the worker could not resume run ${runId} (${describePhase(outcome.run)}); see: triage logs ${runId}`);
        return EXIT.ERROR;
      }

      if (json) emitJson(io, ResumeOutputSchema, { run_id: runId, submission_id: submissionId });
      else printHuman(io, [`resumed run ${runId} (submission ${submissionId})`, `follow it with: triage wait ${runId}`]);
      return EXIT.OK;
    },
  };
}

function describePhase(run: Pick<RunRecord, 'phase' | 'phase_reason'>): string {
  return `phase ${run.phase}${run.phase_reason !== undefined ? `: ${run.phase_reason}` : ''}`;
}

/** The message argument, trimmed. Undefined when not given; blank or over-long is a usage error. */
function noteOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new UsageError('the message must be text');
  const note = value.trim();
  if (note === '') throw new UsageError('the message is empty');
  if (note.length > MAX_RESUME_NOTE_CHARS) throw new UsageError(`the message must be at most ${MAX_RESUME_NOTE_CHARS} characters`);
  return note;
}

export const command: CliCommand = createResumeCommand();
