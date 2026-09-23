// Output helpers and exit codes for CLI commands. Commands write only through
// ctx.io with these helpers, never console.log, so tests can capture output
// and --json output stays machine-stable.

import type { CliIo } from './types.ts';

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFIG: 3,
});

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Error codes used in the --json error shape {"error":{"code","message"}}. */
export type ErrorCode = keyof typeof EXIT;

/** Writes one JSON document and a newline to stdout. */
export function printJson(io: Pick<CliIo, 'stdout'>, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Writes text to stdout, one line per entry, each ending in a newline. */
export function printHuman(io: Pick<CliIo, 'stdout'>, text: string | readonly string[]): void {
  const lines = typeof text === 'string' ? [text] : text;
  for (const line of lines) io.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
}

/**
 * Prints an error. With json it goes to stdout as {"error":{"code","message"}};
 * otherwise it goes to stderr as "triage: <message>".
 */
export function printError(io: Pick<CliIo, 'stdout' | 'stderr'>, json: boolean, code: ErrorCode, message: string): void {
  if (json) printJson(io, { error: { code, message } });
  else io.stderr.write(`triage: ${message}\n`);
}
