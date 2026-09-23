// Starts the Flue runtime in a CLI process (HLD 02 §5.1).
//
// bootRuntime() wraps start({ agents: [Triage], db }) with the persistence
// adapter from src/db.ts, so a later process can re-attach to a run's
// submissions. It starts the runtime once per process: every later call
// returns the same promise, and a failed start is forgotten so the next call
// can try again.
//
// CLI processes only. The HTTP server already runs inside a configured Flue
// runtime, where start() throws rather than split the process's registries,
// so nothing under src/http or src/ingress/http imports this module.
//
// src/db.ts is imported lazily: its default export loads the config and
// builds the adapter on import, which should happen only when a runtime is
// actually started.
import type { Agent } from '@flue/runtime';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { type Flue, start as flueStart, type StartOptions } from '@flue/runtime/node';
import { Triage } from '../agents/triage.agent.ts';

export type BootOptions = {
  /** Defaults to Flue's start() from @flue/runtime/node. */
  readonly start?: (options: StartOptions) => Promise<Flue>;
  /** Defaults to [Triage]. */
  readonly agents?: readonly Agent[];
  /** Defaults to the adapter src/db.ts exports for the loaded config. */
  readonly db?: () => PersistenceAdapter | Promise<PersistenceAdapter>;
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
  const db = options.db !== undefined ? await options.db() : (await import('../db.ts')).default;
  const start = options.start ?? flueStart;
  return start({ agents: options.agents ?? [Triage], db });
}

/** Forgets the started runtime without stopping it. Test files only. */
export function resetRuntimeForTests(): void {
  booted = undefined;
}
