// The CLI extension point. An area adds src/cli/commands/<name>.command.ts
// exporting `command: CliCommand`; bun run gen lists it and buildProgram
// mounts it at its path. Nothing else needs editing.

import type { Command } from 'commander';
import type { Readable } from 'node:stream';
import type { Config } from '../config/env.ts';

/**
 * Dependencies handed to every command. Empty here; areas add fields with
 * `declare module '<path>/src/cli/types.ts' { interface CliDeps { ... } }`.
 */
export interface CliDeps {}

export type CliWritable = { write(chunk: string): unknown };

export type CliIo = {
  readonly stdout: CliWritable;
  readonly stderr: CliWritable;
  readonly stdin: Readable;
  /** True only when stdin is a terminal. Commands prompt only when this is true. */
  readonly isTTY: boolean;
};

export type CliContext = {
  /** Loads config from TRIAGE_HOME on first call, so --help works without it. Throws ConfigError. */
  config(): Config;
  readonly io: CliIo;
  readonly deps: CliDeps;
};

export type CliOptions = Readonly<Record<string, unknown>> & {
  /** The global --json flag, or a command's own --json. */
  readonly json: boolean;
};

export type CliInvocation = {
  /** Positional arguments after commander's parsing, in declaration order. */
  readonly args: readonly unknown[];
  /** Command options merged with the global ones. */
  readonly opts: CliOptions;
};

export interface CliCommand {
  /** Words after `triage`, e.g. ['tunnel', 'up']. Lowercase kebab-case segments. */
  readonly path: readonly string[];
  /** One line shown in help. */
  readonly summary: string;
  /** Adds arguments and options. Must not add --env. */
  configure(cmd: Command): void;
  /** Returns an exit code from EXIT. */
  run(ctx: CliContext, input: CliInvocation): Promise<number>;
}
