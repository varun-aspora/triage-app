// The run action log and the repeat cache (D79).
//
// Action log: one compact line per tool call in the run, from the root and
// every delegate: time, agent, tool, the arguments and a one-line outcome
// (rows, hits, groups, status, refusal reason, evidence id). Both text parts
// pass the persisted redaction profile before they are stored, so the log
// holds what events.jsonl may hold and nothing more. logActions() wraps the
// tools each agent mounts, so no tool records itself. events.jsonl stays the
// durable copy; this in-memory copy exists because a delegate's brief is
// rendered synchronously at delegation time, while that file is written
// through a setImmediate queue.
//
// Repeat cache: runIoTool stores the ok envelope of a call that opted in
// (IoToolSpec.repeat) under its repeat key, and an exact repeat within
// REPEAT_TTL_MS gets that envelope back with a note naming who ran it and
// when.
//
// Both are held per run in this module, like connector-failures.ts, and
// settleRun releases them, so a resumed run starts empty and repeats there
// run for real.

import type { ToolDefinition } from '@flue/runtime/tool';
import { excerpt } from '../connectors/error-text.ts';
import { redactPersisted } from '../gate/redact.ts';
import { canonicalJson } from '../mock/key.ts';
import type { ToolContext } from '../tools/types.ts';
import type { Entity } from '../types/core.ts';
import type { ToolEnvelope } from '../types/tool-result.ts';
// Brings in the ToolDeps fields (run.redactionNames).
import type {} from '../tools/_lib/context.ts';

/** The agent name of the root's own calls. */
export const ROOT_AGENT = 'triage';
/** Lines a delegate's brief carries; run_log reads the rest. */
export const BRIEF_LINES = 60;
/** How long an ok result may be reused. */
export const REPEAT_TTL_MS = 10 * 60_000;

const ARGS_CHARS = 240;
const OUTCOME_CHARS = 200;
// Their arguments are findings, reports or questions, not queries.
const NO_ARGS: ReadonlySet<string> = new Set(['note_evidence', 'finish_report', 'ask_requester', 'stop_blocked']);
// Reading the log is not an action worth listing.
const NOT_LOGGED: ReadonlySet<string> = new Set(['run_log']);

export type Action = {
  readonly at: string;
  readonly agent: string;
  readonly tool: string;
  /** The calling agent's entity; null for the root and code_walker. */
  readonly entity: Entity | null;
  readonly args: string;
  readonly outcome: string;
};

type Repeat = { readonly envelope: ToolEnvelope; readonly by: string; readonly at: string };
type RunRecord = { readonly actions: Action[]; readonly repeats: Map<string, Repeat> };

const runs = new Map<string, RunRecord>();

function recordOf(runId: string): RunRecord {
  let rec = runs.get(runId);
  if (rec === undefined) runs.set(runId, (rec = { actions: [], repeats: new Map() }));
  return rec;
}

/** The run's actions so far, oldest first. A copy. */
export function actionsFor(runId: string): readonly Action[] {
  return [...(runs.get(runId)?.actions ?? [])];
}

/** Drops the run's log and repeat cache when the run settles. */
export function releaseActions(runId: string): boolean {
  return runs.delete(runId);
}

/** HH:MM:SSZ of an ISO time. */
export function clockOf(iso: string): string {
  return `${iso.slice(11, 19)}Z`;
}

export function actionLine(a: Action): string {
  return `${clockOf(a.at)} ${a.agent} ${a.tool}${a.args !== '' ? ` ${a.args}` : ''} -> ${a.outcome}`;
}

/** What one agent may see: its own entity's calls and the entity-free ones (root, code_walker); all for null. */
export function visibleTo(entity: Entity | null): (a: Action) => boolean {
  return entity === null ? () => true : (a) => a.entity === entity || a.entity === null;
}

/** The "Already done in this run" section of a delegate's instructions: the last BRIEF_LINES lines. */
export function actionBrief(runId: string, entity: Entity | null): string[] {
  const seen = actionsFor(runId).filter(visibleTo(entity));
  const shown = seen.slice(-BRIEF_LINES);
  const left = seen.length - shown.length;
  return [
    '## Already done in this run',
    '',
    'Tool calls made so far in this run, oldest first (UTC; personal values masked). Do not repeat one unless the ' +
      'next step needs a different window, page or filter: an exact repeat returns the earlier result. ' +
      '`run_log` reads the full list.',
    '',
    ...(left > 0 ? [`- ${left} earlier calls left out; read them with run_log from offset 0 (limit up to 100, then next_offset).`] : []),
    ...(shown.length > 0 ? shown.map((a) => `- ${actionLine(a)}`) : ['- none yet']),
  ];
}

/** Wraps each tool so every call adds one line to the run's log. The agent name comes from ctx.agent. */
export function logActions(tools: readonly ToolDefinition[], ctx: ToolContext): ToolDefinition[] {
  const agent = ctx.agent ?? ROOT_AGENT;
  return tools.map((tool) => {
    if (NOT_LOGGED.has(tool.name)) return tool;
    const run = tool.run.bind(tool) as (context: never) => Promise<unknown>;
    return {
      ...tool,
      async run(context: never) {
        const { data } = context as { data?: unknown };
        const add = (outcome: string): void => {
          const names = ctx.deps.run.redactionNames;
          const safe = (text: string): string => redactPersisted(text, { names }).value;
          recordOf(ctx.runId).actions.push({
            at: ctx.deps.now().toISOString(),
            agent,
            tool: tool.name,
            entity: ctx.entity,
            args: NO_ARGS.has(tool.name) ? '' : excerpt(safe(argsText(data)), ARGS_CHARS),
            outcome: excerpt(safe(outcome), OUTCOME_CHARS),
          });
        };
        try {
          const result = await run(context);
          add(outcomeOf(result));
          return result;
        } catch (err) {
          // The name only: an error message could quote the data.
          add(`error (${err instanceof Error ? err.name : typeof err})`);
          throw err;
        }
      },
    } as ToolDefinition;
  });
}

function argsText(data: unknown): string {
  try {
    return canonicalJson(data ?? {});
  } catch {
    return '{}';
  }
}

// Fields of an ok result that say what came back, in the order shown.
const COUNTS: readonly [string, string][] = [
  ['row_count', 'rows'],
  ['num_hits', 'hits'],
  ['groups', 'groups'],
  ['distinct', 'distinct'],
  ['matches', 'matches'],
  ['status', 'status'],
  ['evidence_id', 'evidence'],
  ['truncated', 'truncated'],
  ['staged_file', 'file'],
];

/** One line for a tool result: the status and counts, or the refusal text. */
export function outcomeOf(result: unknown): string {
  const out = (result as { output?: { status?: unknown; data?: unknown; message?: unknown } } | null)?.output;
  if (out === undefined || typeof out.status !== 'string') return 'returned';
  const message = typeof out.message === 'string' ? out.message : '';
  if (out.status !== 'ok') return `${out.status}: ${message}`;
  const data = out.data;
  const parts: string[] = [];
  if (Array.isArray(data)) parts.push(`items=${data.length}`);
  else if (data !== null && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const [key, label] of COUNTS) {
      const value = d[key];
      if (Array.isArray(value)) parts.push(`${label}=${value.length}`);
      else if (typeof value === 'number' || typeof value === 'string') parts.push(`${label}=${value}`);
      else if (value === true) parts.push(label);
    }
    if (parts.length === 0) parts.push(`{${Object.keys(d).slice(0, 6).join(',')}}`);
  }
  return ['ok', ...parts, ...(message !== '' ? [`(${message})`] : [])].join(' ');
}

// ------------------------------------------------------------ repeat cache

/** In the message of every reused result, so a run log shows which results were reused. */
export const REUSED_MARK = 'result reused, nothing new was queried';

/** The earlier ok result for this key, with the note the model sees, or undefined. */
export function findRepeat(runId: string, key: string, now: Date): ToolEnvelope | undefined {
  const hit = runs.get(runId)?.repeats.get(key);
  if (hit === undefined || now.getTime() - Date.parse(hit.at) > REPEAT_TTL_MS) return undefined;
  const note =
    `Already run by ${hit.by} at ${clockOf(hit.at)}; ${REUSED_MARK}. ` +
    'If it was empty, find out why before trying again; for new data change the key, window, page or filter.';
  const earlier = hit.envelope.output.message;
  return { output: { ...hit.envelope.output, message: earlier ? `${note} ${earlier}` : note } };
}

/** Keeps an ok envelope for exact repeats. Anything else is not kept, so it runs again. */
export function rememberRepeat(runId: string, key: string, envelope: ToolEnvelope, by: string, at: string): void {
  if (envelope.output.status !== 'ok') return;
  recordOf(runId).repeats.set(key, { envelope, by, at });
}
