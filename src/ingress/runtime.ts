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
// src/db.ts is imported lazily: its default export loads the config and
// builds the adapter on import, which should happen only when a runtime is
// actually started.
import type { Agent } from '@flue/runtime';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { type Flue, start as flueStart, type StartOptions } from '@flue/runtime/node';
import { Triage } from '../agents/triage.agent.ts';
import { loadConfig, type Config } from '../config/env.ts';
import { ConfigError } from '../config/errors.ts';
import { describeEnsure, ensureConfiguredModels } from '../model-refresh.ts';
import { installRunEventLog } from '../runlog/event-log.ts';

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
  if (options.eventLog !== false) {
    const runsDir = options.eventLog?.runsDir ?? runsDirOf();
    if (runsDir !== undefined) installRunEventLog({ runsDir });
  }
  const db = options.db !== undefined ? await options.db() : (await import('../db.ts')).default;
  const start = options.start ?? flueStart;
  return start({ agents: options.agents ?? [Triage], db });
}

function runsDirOf(): string | undefined {
  try {
    return loadConfig().paths.runsDir;
  } catch (err) {
    if (err instanceof ConfigError) return undefined;
    throw err;
  }
}

// A config that does not load is left to start() and doctor to report.
async function ensureModels(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) return;
    throw err;
  }
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
