// Script commands (D112): sql_select, logs_search, http_call and locate as
// commands in the virtual sandbox. A script passes the tool's input as JSON
// (one argument, or stdin) and the triage-app process runs the call through
// the tool definition the calling agent has mounted, so scope and derived
// leads (D97), budget, the worker's per-task cap, audit, the action log,
// staging, the stuck count and the redaction setting all apply as for a
// model call. just-bash's network stays off: these commands are the only way
// out of the sandbox, and they reach nothing a tool could not.
//
// Which agent ran the command. Flue creates one sandbox per harness (per run)
// and the root and every task session (investigators, worker, code_walker)
// share it; its bash tool passes nothing about the session to exec. So:
// - the root binds the tools it mounts on each render (bindRootTools);
// - installScriptScope() installs a Flue instrument() whose interceptor runs
//   each `task` tool call inside a fresh AsyncLocalStorage scope. Flue renders
//   the delegate inside that call, before the child session starts, so
//   mountAll() binds the delegate's tools into that scope (bindTaskTools), and
//   the child's bash calls, which run inside the same call, find them there;
// - a command outside any task scope uses the root's tools.
// A task session resumed after a restart is rendered outside a task call.
// Its bash calls get an empty scope from the interceptor (the call carries a
// task id), so the commands refuse there instead of running as the root.
//
// Output is the full result: the staged /data file when the call staged one,
// else the result data. A note on an ok result (the stuck note, a reused
// result) goes to stderr. What reaches the model is still capped by Flue's
// bash output cap, so scripts should write big results to /data.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  type FlueExecutionContext,
  type FlueExecutionOperation,
  type FlueInstrumentation,
  type FlueLogger,
  instrument,
} from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import { type Command, decodeBytesToUtf8, defineCommand, type ExecResult, type IFileSystem, type ResolvedCommandContext, textOutput } from 'just-bash';
import * as v from 'valibot';
import { BUDGET_EXHAUSTED_MESSAGE } from '../gate/budget.ts';
import { SCRIPT_CALL } from '../runlog/actions.ts';
import type { StagingHarness } from '../tools/_lib/pipeline.ts';

/** The tools a script can call as commands. Their names, so this file loads none of the tool modules. */
export const SCRIPT_COMMANDS: readonly string[] = Object.freeze(['sql_select', 'logs_search', 'http_call', 'locate']);

/** The instrument() key. Symbol.for so a second copy of this module finds the same key. */
export const SCRIPT_SCOPE_KEY: symbol = Symbol.for('triage-app.script-scope');

// Exit codes a script can tell apart.
const EXIT_REFUSED = 1;
const EXIT_BUDGET = 2;

type Scope = { tools: readonly ToolDefinition[] | undefined };

const scopes = new AsyncLocalStorage<Scope>();
const rootTools = new Map<string, readonly ToolDefinition[]>();

/** The root's mounted tools for the run's commands. Called on every render, so the latest set wins. */
export function bindRootTools(runId: string, tools: readonly ToolDefinition[]): void {
  rootTools.set(runId, tools);
}

/** Drops the run's root binding when the run settles. */
export function releaseRootTools(runId: string): boolean {
  return rootTools.delete(runId);
}

/** A delegate's mounted tools, for the task call being rendered. Does nothing outside a task scope. */
export function bindTaskTools(tools: readonly ToolDefinition[]): void {
  const scope = scopes.getStore();
  if (scope !== undefined) scope.tools = tools;
}

/** Runs fn in a new task scope: what the interceptor does around each `task` call. Exported for tests. */
export function runInTaskScope<T>(fn: () => T): T {
  return scopes.run({ tools: undefined }, fn);
}

/** The instrumentation that opens the task scopes. installScriptScope() installs it. */
export function createScriptScope(): FlueInstrumentation {
  return {
    key: SCRIPT_SCOPE_KEY,
    observe: () => {},
    interceptor: <T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>): Promise<T> => {
      if (operation.type !== 'tool') return next();
      if (operation.toolName === 'task') return runInTaskScope(next);
      // A task session's bash call outside any task scope: a child resumed after a restart.
      if (operation.toolName === 'bash' && ctx.taskId !== undefined && scopes.getStore() === undefined) return runInTaskScope(next);
      return next();
    },
    dispose: () => {},
  };
}

let installed = false;

/** Installs the task scopes once per process. */
export function installScriptScope(install: (i: FlueInstrumentation) => unknown = instrument): void {
  if (installed) return;
  install(createScriptScope());
  installed = true;
}

/** The tools of the agent whose bash ran the command; undefined when nothing bound them (a resumed task). */
function callerTools(runId: string): readonly ToolDefinition[] | undefined {
  const scope = scopes.getStore();
  return scope !== undefined ? scope.tools : rootTools.get(runId);
}

// ------------------------------------------------------------ the commands

/** The four commands for one run's sandbox. */
export function scriptCommands(runId: string): Command[] {
  return SCRIPT_COMMANDS.map((name) => defineCommand(name, (args, ctx) => runCommand(runId, name, args, ctx)));
}

const fail = (stderr: string, exitCode = EXIT_REFUSED): ExecResult => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`, exitCode });
const ok = (stdout: string, stderr = ''): ExecResult => ({ ...textOutput(stdout), stderr, exitCode: 0 });

function usage(name: string): string {
  return (
    `usage: ${name} '<json>'   or   echo '<json>' | ${name}\n` +
    `The JSON is the ${name} tool's input. The full result is printed as JSON (exit 0; a note, if any, on stderr). ` +
    `A refusal or error goes to stderr (exit 1; 2 when the run's budget is spent).\n`
  );
}

async function runCommand(runId: string, name: string, args: string[], ctx: ResolvedCommandContext): Promise<ExecResult> {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) return ok(usage(name));
  const tools = callerTools(runId);
  // The agent may still have the tool itself, so say to call it that way.
  if (tools === undefined) return fail(`${name}: script commands are not set up in this session (a task resumed after a restart); call ${name} as a tool`);
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) {
    const here = tools.filter((t) => SCRIPT_COMMANDS.includes(t.name)).map((t) => t.name);
    return fail(`${name}: not available to the agent that ran this script${here.length > 0 ? `; it has ${here.join(', ')}` : ''}`);
  }

  const text = args.length === 1 ? args[0] : args.length === 0 ? decodeBytesToUtf8(ctx.stdin) : undefined;
  if (text === undefined || text.trim() === '') return fail(`${name}: give the input as one JSON argument or on stdin\n${usage(name)}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(`${name}: the input is not valid JSON\n${usage(name)}`);
  }
  // Flue parses a model call's input with the tool's schema before run(); do the same.
  const parsed = v.safeParse(tool.input as v.GenericSchema, json);
  if (!parsed.success) {
    const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(input)'))];
    return fail(`${name}: the input does not fit the tool at ${paths.join(', ')}: ${parsed.issues[0]?.message ?? 'invalid'}\n${usage(name)}`);
  }

  const warnings: string[] = [];
  const log: FlueLogger = { info: () => {}, warn: (m) => void warnings.push(m), error: (m) => void warnings.push(m) };
  // Staging writes through the same filesystem the script sees.
  const harness: StagingHarness = { sandbox: { writeFile: (path, content) => ctx.fs.writeFile(path, content) } };
  let result: unknown;
  try {
    const run = tool.run.bind(tool) as (context: unknown) => Promise<unknown>;
    result = await run({
      data: parsed.output,
      toolCallId: `script_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      log,
      harness,
      [SCRIPT_CALL]: true,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
  } catch (err) {
    // What the model would read for a tool error: the error's own text.
    return fail(`${name}: ${err instanceof Error ? `${err.name}: ${err.message}` : 'failed'}`);
  }
  const warned = warnings.map((w) => `${name}: ${w}\n`).join('');
  const out = (result as { output?: { status?: string; data?: unknown; message?: string } } | undefined)?.output;
  if (out?.status !== 'ok') {
    const message = out?.message ?? 'no result';
    return fail(`${warned}${name}: ${message}`, message === BUDGET_EXHAUSTED_MESSAGE ? EXIT_BUDGET : EXIT_REFUSED);
  }
  // An ok result can carry a note (the stuck note, a reused result). stdout holds only the data, so the note goes to stderr.
  const note = out.message !== undefined && out.message !== '' ? `${name}: ${out.message}\n` : '';
  return ok(`${await fullResult(out.data, ctx.fs)}\n`, `${warned}${note}`);
}

/** The staged file when the call staged one (the full result), else the data as JSON. */
async function fullResult(data: unknown, fs: IFileSystem): Promise<string> {
  const staged = (data as { staged_file?: unknown } | null)?.staged_file;
  if (typeof staged === 'string') {
    try {
      return await fs.readFile(staged);
    } catch {
      // Removed by the script in between: the result data is all there is.
    }
  }
  return JSON.stringify(data ?? null);
}
