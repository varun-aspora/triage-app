// CLI entry used by bin/triage.mjs. Builds the program from the generated
// command list with the real process io and a lazy config loader, then runs it.

import { findModules, INDEX_SPECS, REPO_ROOT } from '../../scripts/gen-indexes.ts';
import { loadConfig, type Config } from '../config/env.ts';
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

export async function main(argv: readonly string[], ctx: CliContext = processContext()): Promise<number> {
  let program;
  try {
    program = buildProgram(commands as readonly CliCommand[], ctx, { sources: commandSources });
  } catch (err) {
    printError(ctx.io, argv.includes('--json'), 'ERROR', describeError(err).message);
    return EXIT.ERROR;
  }
  return runCli(program, argv);
}
