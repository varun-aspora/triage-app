// triage preflight [--json]
//
// Runs what `run` and `start` do first (D32): in local mode the SSFB tunnel,
// the AWS and kube login checks and qw whoami, then host probes; in server
// mode the probes only. It prints the warnings and always exits 0, because
// pre-flight never blocks a run. Mock mode skips every step.
//
// --json prints {mode, skipped?, steps, warnings}. Warnings name keys as
// $KEY placeholders, never values.
//
// Real wiring: the ExecRunner, the node:net TCP connect as the probe and
// tunnelUp. Tests pass fakes.

import type { Config } from '../../config/env.ts';
import { RegistryError, loadRegistry } from '../../config/registry.ts';
import { createExecRunner, type ExecRunner } from '../../connectors/exec.ts';
import { netTcpConnect } from '../../ops/doctor/probes.ts';
import { runPreflight, type PreflightResult, type TunnelUpFn } from '../../ops/preflight.ts';
import type { TcpProbe } from '../../ops/tunnel.ts';
import type { PreflightWarning } from '../../types/classification.ts';
import { EXIT, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type PreflightCommandOptions = {
  /** Defaults to the real ExecRunner. */
  readonly runner?: ExecRunner;
  /** Defaults to a node:net connect. */
  readonly tcpProbe?: TcpProbe;
  /** Defaults to tunnelUp. */
  readonly tunnel?: TunnelUpFn;
};

const REGISTRY_WARNING: PreflightWarning = Object.freeze({
  step: 'preflight',
  message: 'the entity registry did not load, so pre-flight did not run',
  fix: 'run triage doctor',
});

async function preflight(config: Config, isTty: boolean, options: PreflightCommandOptions): Promise<PreflightResult> {
  let registry;
  try {
    registry = loadRegistry(config);
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    return Object.freeze({ mode: 'unknown', steps: Object.freeze([]), warnings: Object.freeze([REGISTRY_WARNING]) });
  }
  return runPreflight({
    config,
    registry,
    runner: options.runner ?? createExecRunner(),
    tcpProbe: options.tcpProbe ?? netTcpConnect,
    ...(options.tunnel !== undefined ? { tunnel: options.tunnel } : {}),
    isTty,
  });
}

function humanLines(result: PreflightResult): string[] {
  if (result.skipped === 'mock') return ['pre-flight skipped: mock mode is on'];
  const lines = [
    result.warnings.length === 0
      ? `pre-flight (${result.mode}): no warnings`
      : `pre-flight (${result.mode}): ${result.warnings.length} warning(s); the run would continue`,
  ];
  for (const w of result.warnings) {
    lines.push(`warn  ${w.step}${w.entity !== undefined ? ` [${w.entity}]` : ''}: ${w.message}`);
    if (w.fix !== undefined && w.fix !== '') lines.push(`      fix: ${w.fix}`);
  }
  return lines;
}

export function createPreflightCommand(options: PreflightCommandOptions = {}): CliCommand {
  return {
    path: ['preflight'],
    summary: 'run the local-mode checks run/start do first (tunnel, logins, probes); warns, never blocks',
    configure(cmd) {
      cmd.option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const result = await preflight(ctx.config(), ctx.io.isTTY, options);
      if (opts.json) {
        printJson(ctx.io, {
          mode: result.mode,
          ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
          steps: result.steps,
          warnings: result.warnings,
        });
      } else {
        printHuman(ctx.io, humanLines(result));
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createPreflightCommand();
