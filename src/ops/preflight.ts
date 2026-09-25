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
//
// runResumePreflight repeats the tunnel step only, for a resume (D56): the
// SSFB tunnel may have died while the run was parked. The caller decides
// what a tunnel warning means there (resumeRun refuses the resume).

import { deployModeForPreflight, type Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import type { ExecRunner } from '../connectors/exec.ts';
import type { PreflightWarning } from '../types/classification.ts';
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

function freeze(mode: PreflightMode, out: Outcome): PreflightResult {
  return Object.freeze({ mode, steps: Object.freeze([...out.steps]), warnings: Object.freeze([...out.warnings]) });
}

function skipped(mode: PreflightMode): PreflightResult {
  return Object.freeze({ mode, skipped: 'mock', steps: Object.freeze([]), warnings: Object.freeze([]) });
}

function stepContext(input: PreflightInput): StepContext {
  return {
    config: input.config,
    registry: input.registry,
    entities: input.registry.enabledEntities(),
    runner: input.runner,
    tcpProbe: input.tcpProbe,
    tunnel: input.tunnel ?? tunnelUp,
    isTty: input.isTty,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  let mode: PreflightMode = 'unknown';
  const out = new Outcome();
  try {
    mode = readMode(input.config);
    if (input.config.mock.enabled) return skipped(mode);

    const ctx = stepContext(input);

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

/**
 * The part of pre-flight a resume repeats (D56): the SSFB tunnel, which may
 * have died while the run was parked, so a resume in local mode brings it
 * back before the run goes on. Nothing else is repeated: the logins and
 * probes were made when the run started, and a system that is still down
 * blocks the run again on its own. Mock mode skips; server and unknown modes
 * have no tunnel step and return no steps. Never rejects, like runPreflight.
 */
export async function runResumePreflight(input: PreflightInput): Promise<PreflightResult> {
  let mode: PreflightMode = 'unknown';
  const out = new Outcome();
  try {
    mode = readMode(input.config);
    if (input.config.mock.enabled) return skipped(mode);
    if (mode === 'local') await tunnelStep(stepContext(input), out);
  } catch {
    out.warn('preflight', undefined, 'the resume check could not finish; the run continues without it');
  }
  return freeze(mode, out);
}
