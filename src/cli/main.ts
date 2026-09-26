// CLI entry used by bin/triage.mjs. Builds the program from the generated
// command list with the real process io and a lazy config loader, then runs it
// and ends the shared pg pools, so the process exits once the output is out.
//
// Before the pools end it waits, for a few seconds at most, for the Braintrust
// spans and feedback scores still queued (D82). That covers `triage run`,
// `feedback`, `stop` and the detached worker, which runs as `triage __worker`
// through this same entry. With tracing off it returns at once, and the
// braintrust package is never loaded (src/tracing/braintrust.ts loads it only
// when tracing starts).
//
// The wait bounds only the await: when it times out, the SDK's requests and
// retry timers are still live and would keep the process up long after the
// output is out. tracesStillSending() then says so, and bin/triage.mjs
// exits the process itself once stdout and stderr are drained.

import { findModules, INDEX_SPECS, REPO_ROOT } from '../../scripts/gen-indexes.ts';
import { loadConfig, type Config } from '../config/env.ts';
import { closeSharedPgRunners } from '../db/pg.ts';
import { flushBraintrust, type FlushOutcome } from '../tracing/braintrust.ts';
import { commands } from './command-modules.gen.ts';
import { buildProgram, describeError, runCli } from './index.ts';
import { EXIT, printError } from './output.ts';
import type { CliCommand, CliContext, CliDeps } from './types.ts';

/** Source files of the generated command list, in list order. Read only when a build error needs them. */
function commandSources(): readonly string[] {
  const spec = INDEX_SPECS.find((s) => s.out === 'src/cli/command-modules.gen.ts');
  return spec === undefined ? [] : findModules(REPO_ROOT, spec);
}

export function processContext(): CliContext {
  let config: Config | undefined;
  return {
    config: () => (config ??= loadConfig()),
    io: {
      stdout: process.stdout,
      stderr: process.stderr,
      stdin: process.stdin,
      isTTY: process.stdin.isTTY === true,
    },
    // No CliDeps fields exist yet. Areas that add one also fill it here.
    deps: {} as CliDeps,
  };
}

export type MainDeps = {
  /** Defaults to flushBraintrust(). */
  readonly flushTraces?: () => Promise<FlushOutcome | void>;
  /** Defaults to closeSharedPgRunners(). */
  readonly closePools?: () => Promise<void>;
};

let stillSending = false;

/** True when main()'s last trace flush timed out, so Braintrust requests may still hold the process open. */
export function tracesStillSending(): boolean {
  return stillSending;
}

export async function main(argv: readonly string[], ctx: CliContext = processContext(), deps: MainDeps = {}): Promise<number> {
  let program;
  try {
    program = buildProgram(commands as readonly CliCommand[], ctx, { sources: commandSources });
  } catch (err) {
    printError(ctx.io, argv.includes('--json'), 'ERROR', describeError(err).message);
    return EXIT.ERROR;
  }
  try {
    return await runCli(program, argv);
  } finally {
    try {
      stillSending = (await (deps.flushTraces ?? flushBraintrust)()) === 'timeout';
    } catch {
      // flushBraintrust never throws; a stand-in might. The pools still end.
      stillSending = false;
    }
    await (deps.closePools ?? closeSharedPgRunners)();
  }
}
