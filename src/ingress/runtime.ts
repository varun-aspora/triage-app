// Starts the Flue runtime in a CLI or server process (HLD 02 §5.1, §5.2).
//
// bootRuntime() wraps start({ agents: [Triage], db }) with the persistence
// adapter from src/db.ts, so a later process can re-attach to a run's
// submissions. It starts the runtime once per process: every later call
// returns the same promise, and a failed start is forgotten so the next call
// can try again.
//
// Called at process start: by the CLI commands that run triage, and by
// src/server/main.ts before it listens. Route handlers run inside the runtime
// the server already started, where a second start() throws rather than
// split the process's registries, so nothing under src/http or
// src/ingress/http imports this module.
//
// Before start(), a configured anthropic/openai model that the installed
// pi-ai does not know triggers one catalog refresh (src/model-refresh.ts).
// A failed refresh is reported on stderr and does not block the start; the
// run then fails at model resolution with Flue's own message.
//
// It also installs the run event log (src/runlog/event-log.ts) before
// start(), so every Flue event of a run this process drives lands in the
// run's events.jsonl. A config that does not load leaves the log off.
//
// Next to it, it installs the usage meter (src/usage/meter.ts, D59), which
// counts every model turn of the runs this process drives. It needs no
// config; usageMeter: false leaves it off (tests).
//
// Then it installs Braintrust tracing (src/tracing/braintrust.ts, D82) when
// the config turns it on (TRIAGE_BRAINTRUST_ENABLED), before start(). The
// tripwire is installed when triageRuntime() first builds the runtime,
// normally after this, so Braintrust's interceptor is the outer one and a
// tripwire denial is recorded on the tool span. Each submission's root span
// id is written to the run store (setSubmissionTraceSpanId) for feedback
// scores; that write is best effort and never fails the run. submit.ts
// writes it as well, from the dispatch receipt, without a store lookup; the
// recorder here also covers a retried attempt and runs submit.ts did not
// dispatch. braintrust: false leaves tracing off (tests).
//
// Last, it installs the settle listener (src/ingress/settle-listener.ts,
// D70), which moves a run's phase when Flue settles its submission in a
// process where nobody awaits read(), as after a restart. It reads and
// writes the runtime's run store (triageRuntime().runStore), resolved on the
// first settle, and the event log's runs dir; settleListener: false leaves it
// off (tests).
//
// src/db.ts is imported lazily: its default export loads the config and
// builds the adapter on import, which should happen only when a runtime is
// actually started.
import type { Agent } from '@flue/runtime';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { type Flue, start as flueStart, type StartOptions } from '@flue/runtime/node';
import * as v from 'valibot';
import { triageRuntime } from '../agents/triage-plan.ts';
import { Triage } from '../agents/triage.agent.ts';
import { loadConfig, type Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import { describeEnsure, ensureConfiguredModels } from '../model-refresh.ts';
import { installRunEventLog, logRunEvent } from '../runlog/event-log.ts';
import type { RunStore } from '../runstore/types.ts';
import { installBraintrust, type TraceRoot } from '../tracing/braintrust.ts';
import { RunIdSchema } from '../types/core.ts';
import { installUsageMeter } from '../usage/meter.ts';
import { installSettleListener } from './settle-listener.ts';

export type BootOptions = {
  /** Defaults to Flue's start() from @flue/runtime/node. */
  readonly start?: (options: StartOptions) => Promise<Flue>;
  /** Defaults to [Triage]. */
  readonly agents?: readonly Agent[];
  /** Defaults to the adapter src/db.ts exports for the loaded config. */
  readonly db?: () => PersistenceAdapter | Promise<PersistenceAdapter>;
  /** Defaults to refreshing the model catalog when a configured model is not found. */
  readonly ensureModels?: () => Promise<void>;
  /** Where the run event log writes. Default: config.paths.runsDir; false leaves it off. */
  readonly eventLog?: false | { readonly runsDir: string };
  /** Installs the usage meter. Default true; false leaves it off. */
  readonly usageMeter?: boolean;
  /** Installs the settle listener. Default true; false leaves it off. */
  readonly settleListener?: boolean;
  /** Installs Braintrust tracing when the config turns it on (D82). Default true; false leaves it off. */
  readonly braintrust?: boolean;
  /** Defaults to installBraintrust from src/tracing/braintrust.ts. Tests pass a stand-in. */
  readonly installTracing?: typeof installBraintrust;
};

let booted: Promise<Flue> | undefined;

/** The process's Flue runtime, started on the first call. */
export function bootRuntime(options: BootOptions = {}): Promise<Flue> {
  if (booted !== undefined) return booted;
  const pending = startOnce(options);
  booted = pending;
  pending.catch(() => {
    if (booted === pending) booted = undefined;
  });
  return pending;
}

async function startOnce(options: BootOptions): Promise<Flue> {
  await (options.ensureModels ?? ensureModels)();
  const runsDir = options.eventLog === false ? undefined : (options.eventLog?.runsDir ?? configIfLoads()?.paths.runsDir);
  if (runsDir !== undefined) installRunEventLog({ runsDir });
  if (options.usageMeter !== false) installUsageMeter();
  if (options.braintrust !== false) {
    const config = configIfLoads();
    // Never rejects; tracing off in the config makes it a no-op.
    if (config !== undefined) {
      await (options.installTracing ?? installBraintrust)(config, { onRootSpan: traceRootRecorder(() => triageRuntime().runStore) });
    }
  }
  if (options.settleListener !== false) {
    installSettleListener({ store: () => triageRuntime().runStore, ...(runsDir !== undefined ? { runsDir } : {}) });
  }
  const db = options.db !== undefined ? await options.db() : (await import('../db.ts')).default;
  const start = options.start ?? flueStart;
  return start({ agents: options.agents ?? [Triage], db });
}

export type TraceRootRecorderOptions = {
  /** Waits before each retry when the submission is not in the store yet. Default 250 ms, 1 s, 4 s. */
  readonly retryMs?: readonly number[];
};

const TRACE_ROOT_RETRY_MS: readonly number[] = [250, 1000, 4000];

/**
 * Writes a captured root span id to its submission's row in the run store.
 * The submission is found by its Flue submission id. The root can be
 * captured before ingress has written that id (submit.ts writes it once the
 * dispatch receipt is back), so a miss is retried a few times. submit.ts
 * also writes the root itself once the receipt is back, so a store write
 * slower than these retries does not leave the column empty. Best effort:
 * the returned promise never rejects, and a failure or a submission that
 * never shows up leaves the column empty.
 */
export function traceRootRecorder(store: () => RunStore, options: TraceRootRecorderOptions = {}): (root: TraceRoot) => Promise<void> {
  const retries = options.retryMs ?? TRACE_ROOT_RETRY_MS;
  return async (root) => {
    try {
      if (!v.is(RunIdSchema, root.runId)) return;
      for (let attempt = 0; attempt <= retries.length; attempt++) {
        if (attempt > 0) await sleep(retries[attempt - 1] ?? 0);
        const run = await store().getRun(root.runId);
        if (run === null) return;
        const seq = run.submissions.find((s) => s.flue_submission_id === root.flueSubmissionId)?.seq;
        if (seq === undefined) continue;
        await store().setSubmissionTraceSpanId(root.runId, seq, root.spanId);
        return;
      }
    } catch (err) {
      // Feedback for this submission then goes without scores, unless submit.ts's own write lands.
      logRunEvent(root.runId, 'trace_span_write_failed', { flue_submission_id: root.flueSubmissionId, error: err instanceof Error ? err.name : typeof err });
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// A config that does not load is left to start() and doctor to report.
function configIfLoads(): Config | undefined {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) return undefined;
    throw err;
  }
}

async function ensureModels(): Promise<void> {
  const config = configIfLoads();
  if (config === undefined) return;
  try {
    for (const line of describeEnsure(await ensureConfiguredModels(config))) process.stderr.write(`${line}\n`);
  } catch (err) {
    process.stderr.write(`models: catalog refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** Forgets the started runtime without stopping it. Test files only. */
export function resetRuntimeForTests(): void {
  booted = undefined;
}
