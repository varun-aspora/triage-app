// Builds the commander program from the generated command list and runs it.
//
// - Multi-part paths get intermediate groups ('tunnel up' creates 'tunnel').
//   A group run on its own prints its help.
// - Duplicate paths, and a path that is both a command and a group, fail at
//   build time and name both source files.
// - One global --json flag. There is no --env flag: a command that adds one
//   fails at build time.
// - ConfigError and RegistryError map to exit 3 with key names and fixed
//   reasons only. With --json every error prints {"error":{"code","message"}}
//   on stdout.

import { Command, CommanderError } from 'commander';
import { ConfigError } from '../config/errors.ts';
import { EXIT, printError, type ErrorCode } from './output.ts';
import type { CliCommand, CliContext } from './types.ts';

export class CliBuildError extends Error {
  override readonly name = 'CliBuildError';
}

export type BuildOptions = {
  /** Source file of each command, same order as the list. Used only in build errors. */
  readonly sources?: readonly string[] | (() => readonly string[]);
  /** Program name shown in help. Defaults to 'triage'. */
  readonly name?: string;
};

type RunState = { exitCode: number; json: boolean; ctx: CliContext };

const states = new WeakMap<Command, RunState>();

const SEGMENT = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_FLAGS = new Set(['--env']);

export function buildProgram(
  commands: readonly CliCommand[],
  ctx: CliContext,
  options: BuildOptions = {},
): Command {
  const sourceOf = sourceNamer(options.sources);
  const ordered = checkPaths(commands, sourceOf);

  const state: RunState = { exitCode: EXIT.OK, json: false, ctx };
  const program = new Command(options.name ?? 'triage');
  program
    .description('Banking triage agent CLI. Loads config from TRIAGE_HOME.')
    .option('--json', 'print machine-readable JSON')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => ctx.io.stdout.write(s),
      writeErr: (s) => ctx.io.stderr.write(s),
      // Under --json the error is printed as JSON by runCli instead.
      outputError: (s, write) => {
        if (!state.json) write(s);
      },
    });

  const groups = new Map<string, Command>([['', program]]);
  const groupFor = (segments: readonly string[]): Command => {
    let parent = program;
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join(' ');
      let group = groups.get(key);
      if (group === undefined) {
        group = makeGroup(parent, segments[i] as string, key);
        groups.set(key, group);
      }
      parent = group;
    }
    return parent;
  };

  for (const { command, index } of ordered) {
    const parent = groupFor(command.path.slice(0, -1));
    const cmd = parent.command(command.path[command.path.length - 1] as string).description(command.summary);
    command.configure(cmd);
    const bad = cmd.options.find((o) => o.long !== undefined && FORBIDDEN_FLAGS.has(o.long));
    if (bad !== undefined) {
      throw new CliBuildError(`command '${command.path.join(' ')}' (${sourceOf(index)}) adds ${bad.long}; there is no ${bad.long} flag`);
    }
    cmd.action(async (...params: unknown[]) => {
      const self = params[params.length - 1] as Command;
      const opts = self.optsWithGlobals<Record<string, unknown>>();
      const json = state.json || opts.json === true;
      state.json = json;
      try {
        const code = await command.run(ctx, { args: [...self.processedArgs], opts: { ...opts, json } });
        state.exitCode = Number.isInteger(code) ? code : EXIT.ERROR;
      } catch (err) {
        if (err instanceof CommanderError) throw err;
        state.exitCode = reportError(ctx, json, err);
      }
    });
  }

  states.set(program, state);
  return program;
}

/** Parses argv (without node and script) and runs the matched command. Returns the exit code. */
export async function runCli(program: Command, argv: readonly string[]): Promise<number> {
  const state = states.get(program);
  if (state === undefined) throw new CliBuildError('runCli needs a program from buildProgram');
  state.exitCode = EXIT.OK;
  state.json = hasJsonFlag(argv);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return state.exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return EXIT.OK;
      if (state.json) printError(state.ctx.io, true, 'USAGE', err.message.replace(/^error:\s*/, ''));
      return EXIT.USAGE;
    }
    return reportError(state.ctx, state.json, err);
  }
}

/** Prints an error thrown by a command and returns its exit code. */
function reportError(ctx: CliContext, json: boolean, err: unknown): number {
  const { code, message } = describeError(err);
  printError(ctx.io, json, code, message);
  return EXIT[code];
}

export function describeError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof ConfigError) return { code: 'CONFIG', message: problemText('config', err) };
  if (isRegistryError(err)) return { code: 'CONFIG', message: problemText('registry', err) };
  if (err instanceof Error) return { code: 'ERROR', message: `${err.name}: ${err.message}` };
  return { code: 'ERROR', message: 'unexpected error' };
}

type KeyedError = Error & {
  readonly keys?: readonly string[];
  readonly problems?: readonly { readonly key: string; readonly reason: string }[];
};

// src/config/registry.ts (T01.5) owns RegistryError. It is matched by name so
// this file does not depend on it; its problems or keys are used when present.
function isRegistryError(err: unknown): err is KeyedError {
  return err instanceof Error && err.name === 'RegistryError';
}

// Key names and the fixed reasons only. Never a value.
function problemText(label: string, err: KeyedError): string {
  if (Array.isArray(err.problems) && err.problems.length > 0) {
    return `invalid ${label}: ${err.problems.map((p) => `${p.key} ${p.reason}`).join('; ')}`;
  }
  if (Array.isArray(err.keys) && err.keys.length > 0) return `invalid ${label}: ${err.keys.join(', ')}`;
  return err.message;
}

function hasJsonFlag(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

function makeGroup(parent: Command, name: string, key: string): Command {
  return parent
    .command(name)
    .description(`${key} commands`)
    .allowExcessArguments(true)
    .action((_opts: unknown, self: Command) => {
      const extra = self.args[0];
      if (extra !== undefined) {
        self.error(`unknown command '${key} ${extra}'`, { code: 'commander.unknownCommand', exitCode: EXIT.USAGE });
      }
      self.outputHelp();
    });
}

function sourceNamer(sources: BuildOptions['sources']): (index: number) => string {
  let list: readonly string[] | undefined;
  return (index) => {
    if (list === undefined) list = typeof sources === 'function' ? sources() : (sources ?? []);
    return list[index] ?? `command #${index}`;
  };
}

// Validates every path and returns the commands sorted by path.
function checkPaths(
  commands: readonly CliCommand[],
  sourceOf: (index: number) => string,
): { command: CliCommand; index: number }[] {
  const seen = new Map<string, number>();
  commands.forEach((command, index) => {
    const path = command.path;
    if (path.length === 0 || !path.every((s) => SEGMENT.test(s))) {
      throw new CliBuildError(`${sourceOf(index)}: invalid command path [${path.join(', ')}]; use lowercase kebab-case words`);
    }
    const key = path.join(' ');
    const other = seen.get(key);
    if (other !== undefined) {
      throw new CliBuildError(`duplicate command path '${key}': ${sourceOf(other)} and ${sourceOf(index)}`);
    }
    seen.set(key, index);
  });
  for (const [key, index] of seen) {
    for (const [otherKey, otherIndex] of seen) {
      if (otherKey.startsWith(`${key} `)) {
        throw new CliBuildError(
          `command path '${key}' (${sourceOf(index)}) is also a group for '${otherKey}' (${sourceOf(otherIndex)})`,
        );
      }
    }
  }
  return commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => {
      const x = a.command.path.join(' ');
      const y = b.command.path.join(' ');
      return x < y ? -1 : x > y ? 1 : 0;
    });
}
