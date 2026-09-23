// Pre-flight: gets the network path ready before a real run, or says what is
// missing (D32, D15, D14, D44).
//
// This is the only module that reads the deploy mode, and it does so through
// deployModeForPreflight. A source guard keeps it that way.
//
// - Mock mode (TRIAGE_MOCK_MODE=true): returns skipped:'mock' at once and
//   makes no runner or probe call.
// - local: the process owns the network path. Brings the SSFB tunnel up,
//   runs the kube login for entities that need it, checks `qw whoami` for
//   entities on the qw log transport, then probes the configured hosts.
// - server: infra owns the path. Probes only, and warns for an entity on
//   the qw transport, since qw has no headless login (Q27 default).
// - Any other value: a warning, then probe-only.
//
// Nothing here blocks a run. Every failure, and anything thrown, becomes a
// warning the caller copies into the report's gaps. runPreflight never
// rejects.

import { deployModeForPreflight, type Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import type { ExecRunner } from '../connectors/exec.ts';
import type { PreflightWarning } from '../types/classification.ts';
import type { Entity } from '../types/core.ts';
import {
  Outcome,
  kubeLoginSteps,
  probeSteps,
  qwHeadlessSteps,
  qwLoginSteps,
  tunnelStep,
  type PreflightStep,
  type StepContext,
  type TunnelUpFn,
} from './preflight-steps.ts';
import { tunnelUp, type TcpProbe } from './tunnel.ts';

export type { PreflightStep, StepId, StepStatus, TunnelUpFn } from './preflight-steps.ts';

/** Named here so the source guard can tell this file is the one reader. */
export const DEPLOY_MODE_ENV = 'TRIAGE_DEPLOY_MODE';

/** 'unknown' is any value other than local or server; it runs probe-only. */
export type PreflightMode = 'local' | 'server' | 'unknown';

export type PreflightInput = {
  readonly config: Config;
  readonly registry: Registry;
  /** Entities to cover. Defaults to every enabled entity; entities not enabled are dropped. */
  readonly entities?: readonly Entity[];
  readonly runner: ExecRunner;
  readonly tcpProbe: TcpProbe;
  /** Starts the SSFB tunnel. Defaults to tunnelUp. */
  readonly tunnel?: TunnelUpFn;
  /** Whether stdin is a terminal. aws sso login runs only when true. */
  readonly isTty: boolean;
  readonly signal?: AbortSignal;
};

export type PreflightResult = {
  readonly mode: PreflightMode;
  readonly skipped?: 'mock';
  readonly steps: readonly PreflightStep[];
  readonly warnings: readonly PreflightWarning[];
};

/** Maps the raw deploy mode to local, server or unknown. */
export function parseDeployMode(raw: string): PreflightMode {
  const m = raw.trim().toLowerCase();
  return m === 'local' || m === 'server' ? m : 'unknown';
}

function readMode(config: Config): PreflightMode {
  try {
    return parseDeployMode(deployModeForPreflight(config));
  } catch {
    return 'unknown';
  }
}

function coveredEntities(input: PreflightInput): readonly Entity[] {
  const enabled = input.registry.enabledEntities();
  if (input.entities === undefined) return enabled;
  return enabled.filter((e) => input.entities?.includes(e) === true);
}

function freeze(mode: PreflightMode, out: Outcome): PreflightResult {
  return Object.freeze({ mode, steps: Object.freeze([...out.steps]), warnings: Object.freeze([...out.warnings]) });
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  let mode: PreflightMode = 'unknown';
  const out = new Outcome();
  try {
    mode = readMode(input.config);
    if (input.config.mock.enabled) {
      return Object.freeze({ mode, skipped: 'mock', steps: Object.freeze([]), warnings: Object.freeze([]) });
    }

    const ctx: StepContext = {
      config: input.config,
      registry: input.registry,
      entities: coveredEntities(input),
      runner: input.runner,
      tcpProbe: input.tcpProbe,
      tunnel: input.tunnel ?? tunnelUp,
      isTty: input.isTty,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };

    if (mode === 'local') {
      await tunnelStep(ctx, out);
      await kubeLoginSteps(ctx, out);
      await qwLoginSteps(ctx, out);
    } else if (mode === 'server') {
      await qwHeadlessSteps(ctx, out);
    } else {
      out.warn('deploy-mode', undefined, `${DEPLOY_MODE_ENV} is neither local nor server, so pre-flight only probes hosts`, `set ${DEPLOY_MODE_ENV}=local or ${DEPLOY_MODE_ENV}=server`);
    }
    await probeSteps(ctx, out);
  } catch {
    // The steps guard themselves; this catches a broken config or registry.
    out.warn('preflight', undefined, 'pre-flight could not finish; the run continues without it');
  }
  return freeze(mode, out);
}
