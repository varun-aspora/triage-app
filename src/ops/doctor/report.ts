// The full doctor run shared by `triage doctor` and GET /doctor.
//
// doctorReport loads the registry (the env check reports one that does not
// load), builds the context from the real deps unless replaced, runs the
// checks and closes the SQL pools the real probes may have opened.
//
// Real wiring: the ExecRunner, the node:net TCP connect and an embedder built
// from MODEL_EMBEDDING. The probes themselves are built by the probe checks
// from config: fixture-backed in mock mode, the T04 SQL connector and a
// Quickwit liveness GET in real mode. Tests pass fakes through `deps`.

import type { Config } from '../../config/env.ts';
import { RegistryError, loadRegistry, type Registry } from '../../config/registry.ts';
import { createExecRunner } from '../../connectors/exec.ts';
import { createEmbedder, type Embedder } from '../../embed/index.ts';
import { configChecks } from './checks-config.ts';
import { probeChecks, probesFor } from './checks-probes.ts';
import { mountedToolsCheck } from './checks-tools.ts';
import { netTcpConnect } from './probes.ts';
import { runDoctor, type RunDoctorOptions } from './run.ts';
import type { CheckInput, DoctorContext, DoctorReport } from './types.ts';

export const DOCTOR_CHECKS: readonly CheckInput[] = Object.freeze([configChecks, probeChecks, mountedToolsCheck]);

export type DoctorDeps = Partial<Omit<DoctorContext, 'config'>>;

export type DoctorReportOptions = RunDoctorOptions & {
  /** Checks to run. Defaults to DOCTOR_CHECKS. */
  readonly checks?: readonly CheckInput[];
  /** Replaces fields of the default context (runner, probes, ops, embedder, ...). */
  readonly deps?: (config: Config) => DoctorDeps;
};

export async function doctorReport(config: Config, options: DoctorReportOptions = {}): Promise<DoctorReport> {
  const { checks = DOCTOR_CHECKS, deps = defaultDoctorDeps, ...run } = options;
  const registry = tryRegistry(config);
  const ctx: DoctorContext = {
    config,
    ...(registry !== undefined ? { registry } : {}),
    ...deps(config),
  };
  try {
    return await runDoctor(checks, ctx, run);
  } finally {
    // Ends the SQL pools the real probes may have opened. probesFor returns
    // the set the checks used; its pools open only on first use.
    if (registry !== undefined) await closeQuietly(ctx, registry);
  }
}

// A spec error is reported by the embedding row itself, so a throw here only
// means the probe is skipped.
function defaultEmbedder(config: Config): Embedder | null | undefined {
  try {
    return createEmbedder(config, { fetch: (url, init) => fetch(url, init) });
  } catch {
    return undefined;
  }
}

export function defaultDoctorDeps(config: Config): DoctorDeps {
  const embedder = defaultEmbedder(config);
  return {
    runner: createExecRunner(),
    tcpConnect: netTcpConnect,
    ...(embedder !== undefined ? { embedder } : {}),
  };
}

// The env check reports a registry that does not load; the other checks skip.
function tryRegistry(config: Config): Registry | undefined {
  try {
    return loadRegistry(config);
  } catch (err) {
    if (err instanceof RegistryError) return undefined;
    throw err;
  }
}

async function closeQuietly(ctx: DoctorContext, registry: Registry): Promise<void> {
  try {
    await probesFor(ctx, registry).close?.();
  } catch {
    // A pool that fails to close does not change the report.
  }
}
