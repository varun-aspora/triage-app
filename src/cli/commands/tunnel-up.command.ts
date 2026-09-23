// triage tunnel up [--json]
//
// Starts the SSFB DB SSH forward (T11.2) unless the local port already
// listens. Exits 1 when it could not start. This file also holds the shared
// builder that tunnel-status and tunnel-down use.
//
// --json prints {state, port, owned, listening, started, stopped, message,
// error, keys}. Messages name keys and the local port only.
//
// Real wiring: the ExecRunner for ssh and a node:net connect as the TCP
// probe. Tests pass fakes.

import { createExecRunner, type ExecRunner } from '../../connectors/exec.ts';
import { netTcpConnect } from '../../ops/doctor/probes.ts';
import { tunnelDown, tunnelStatus, tunnelUp, type TcpProbe, type TunnelDeps, type TunnelResult } from '../../ops/tunnel.ts';
import { EXIT, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type TunnelOp = 'up' | 'status' | 'down';

export type TunnelCommandOptions = {
  /** Defaults to the real ExecRunner. */
  readonly runner?: ExecRunner;
  /** Defaults to a node:net connect. */
  readonly tcpProbe?: TcpProbe;
  /** Replaces the T11.2 function for this op. */
  readonly op?: (deps: TunnelDeps) => Promise<TunnelResult>;
  /** Creates the control socket directory. Defaults to mkdir -p with mode 0700. */
  readonly ensureDir?: (dir: string) => void;
};

const OPS: Readonly<Record<TunnelOp, (deps: TunnelDeps) => Promise<TunnelResult>>> = Object.freeze({
  up: tunnelUp,
  status: tunnelStatus,
  down: tunnelDown,
});

const SUMMARIES: Readonly<Record<TunnelOp, string>> = Object.freeze({
  up: 'start the SSFB DB SSH forward unless the local port already listens',
  status: 'show whether the SSFB DB SSH forward is up and whether triage started it',
  down: 'stop the SSFB DB SSH forward, only when triage started it',
});

/** The stable --json shape for every tunnel command. */
export function tunnelJson(r: TunnelResult): Record<string, unknown> {
  return {
    state: r.state,
    port: r.localPort ?? null,
    owned: r.owned,
    listening: r.listening,
    started: r.started,
    stopped: r.stopped,
    message: r.message,
    error: r.error ?? null,
    keys: r.keys,
  };
}

function humanLines(r: TunnelResult): string[] {
  const lines = [r.message];
  if (r.error !== undefined) lines.push(`error: ${r.error}`);
  if (r.keys.length > 0) lines.push(`keys: ${r.keys.join(', ')}`);
  return lines;
}

/** Status never fails the command; up and down exit 1 when they report an error. */
export function tunnelExitCode(op: TunnelOp, r: TunnelResult): number {
  return op !== 'status' && r.error !== undefined ? EXIT.ERROR : EXIT.OK;
}

export function createTunnelCommand(op: TunnelOp, options: TunnelCommandOptions = {}): CliCommand {
  const fn = options.op ?? OPS[op];
  return {
    path: ['tunnel', op],
    summary: SUMMARIES[op],
    configure(cmd) {
      cmd.option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const result = await fn({
        config: ctx.config(),
        runner: options.runner ?? createExecRunner(),
        tcpProbe: options.tcpProbe ?? netTcpConnect,
        ...(options.ensureDir !== undefined ? { ensureDir: options.ensureDir } : {}),
      });
      if (opts.json) printJson(ctx.io, tunnelJson(result));
      else printHuman(ctx.io, humanLines(result));
      return tunnelExitCode(op, result);
    },
  };
}

export const command: CliCommand = createTunnelCommand('up');
