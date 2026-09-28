// Helpers for the SIM eval case's pass criteria (docs/11 §5, D94), read from
// a run's report, audit lines and run log. The criteria themselves are
// asserted in test/contract/sim/sim-binding.contract.ts.
//
// The helpers are pure; readKnowledgeTexts is the one read of the disk.
// Results name tools, fields and counts, never an id or a row value.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUDGET_EXEMPT_TOOLS, CODE_TOOLS } from '../gate/budget.ts';
import { JOURNEY_FIELDS } from '../gate/scope.ts';
import { canonicalJson } from '../mock/key.ts';
import { REUSED_MARK } from '../runlog/actions.ts';
import type { RunEventLine } from '../runlog/event-log.ts';
import type { AuditLine } from '../types/audit.ts';
import type { Report } from '../types/report.ts';

/** The text of every .md and .json file under the knowledge directory. */
export function readKnowledgeTexts(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md') || name.endsWith('.json'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8'));
}

// ------------------------------------------------------------------ run log

export type ToolCallEvent = {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  /** The result event; absent while the call had not finished. */
  readonly result?: { readonly isError: boolean; readonly value: unknown };
};

type Data = Record<string, unknown>;
const dataOf = (e: RunEventLine): Data => (typeof e.data === 'object' && e.data !== null ? (e.data as Data) : {});

/** Tool calls from the run log's tool_start and tool lines, in start order. */
export function toolCallsOf(events: readonly RunEventLine[]): ToolCallEvent[] {
  const calls = new Map<string, ToolCallEvent>();
  for (const e of events) {
    const d = dataOf(e);
    if (typeof d.toolCallId !== 'string') continue;
    if (e.type === 'tool_start') calls.set(d.toolCallId, { id: d.toolCallId, name: String(d.toolName), args: d.args });
    const call = calls.get(d.toolCallId);
    if (e.type === 'tool' && call !== undefined) calls.set(call.id, { ...call, result: { isError: d.isError === true, value: d.result } });
  }
  return [...calls.values()];
}

// Every string in a value, JSON text included, so a result is searched
// whether Flue logged the envelope or its text.
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        stringsIn(JSON.parse(t), out);
      } catch {
        // Not JSON; the text itself is already in.
      }
    }
  } else if (Array.isArray(value)) {
    for (const x of value) stringsIn(x, out);
  } else if (value !== null && typeof value === 'object') {
    for (const x of Object.values(value)) stringsIn(x, out);
  }
  return out;
}

// The tool envelope's output inside a logged result: Flue logs it as
// details.output and as JSON text in content.
function outputOf(value: unknown): Data | undefined {
  if (typeof value === 'string') {
    try {
      return outputOf(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object') return undefined;
  const o = value as Data;
  if (typeof o.status === 'string') return o;
  for (const inner of [o.output, (o.details as Data | undefined)?.output]) {
    const found = outputOf(inner);
    if (found !== undefined) return found;
  }
  if (Array.isArray(o.content)) {
    for (const part of o.content) {
      const found = outputOf((part as Data | null)?.text);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// Tools whose calls wrap up or delegate instead of reading data.
const NOT_DATA_TOOLS: ReadonlySet<string> = new Set([...BUDGET_EXEMPT_TOOLS, 'ask_requester', 'stop_blocked', 'run_log', 'task']);

/** Calls that repeat an earlier ok call's tool and arguments exactly and ran again instead of reusing its result. */
export function ranAgainRepeats(events: readonly RunEventLine[]): ToolCallEvent[] {
  const seen = new Set<string>();
  const out: ToolCallEvent[] = [];
  for (const c of toolCallsOf(events)) {
    const output = c.result === undefined || c.result.isError ? undefined : outputOf(c.result.value);
    if (NOT_DATA_TOOLS.has(c.name) || output?.status !== 'ok') continue;
    const key = `${c.name} ${canonicalJson(c.args ?? null)}`;
    const reused = typeof output.message === 'string' && output.message.includes(REUSED_MARK);
    if (seen.has(key) && !reused) out.push(c);
    seen.add(key);
  }
  return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

function logValues(args: unknown): [field: string, value: string][] {
  const a = (args ?? {}) as Data;
  const groups = Array.isArray(a.any_of) ? (a.any_of as Data[]) : [];
  const pairs: [string, unknown][] = [
    ['message', a.message],
    ['error', a.error],
    ...groups.flatMap((g) => (Array.isArray(g?.message) ? g.message.map((m): [string, unknown] => ['any_of.message', m]) : [])),
  ];
  return pairs.filter((p): p is [string, string] => typeof p[1] === 'string' && p[1].trim() !== '');
}

/**
 * logs_search message, error and any_of message values not found in a result
 * the run had before the call (a hit, a code read, a skill) or in a knowledge
 * file. Matching ignores case and runs of whitespace.
 */
export function untracedLogValues(events: readonly RunEventLine[], knowledge: readonly string[]): { tool_call: string; field: string }[] {
  const known = norm(knowledge.join('\n'));
  let seen = '';
  const out: { tool_call: string; field: string }[] = [];
  for (const e of events) {
    const d = dataOf(e);
    if (e.type === 'tool') seen += `\n${norm(stringsIn(d.result).join('\n'))}`;
    if (e.type !== 'tool_start' || d.toolName !== 'logs_search' || typeof d.toolCallId !== 'string') continue;
    for (const [field, value] of logValues(d.args)) {
      const n = norm(value);
      if (!known.includes(n) && !seen.includes(n)) out.push({ tool_call: d.toolCallId, field });
    }
  }
  return out;
}

// ------------------------------------------------------------------ audit

/** Audit lines that answered not configured. */
export function countNotConfigured(audit: readonly AuditLine[]): number {
  return audit.filter((l) => l.exit === 'not_configured').length;
}

/** Allowed calls that reached a data source: no code tools, no wrap-up tools, no reused results. */
export function productionCalls(audit: readonly AuditLine[]): number {
  return audit.filter((l) => l.decision === 'allow' && l.exit !== 'reused' && !CODE_TOOLS.includes(l.tool) && !NOT_DATA_TOOLS.has(l.tool))
    .length;
}

// ------------------------------------------------------------------ report

/** The report's findings as text: root cause, state, timeline, reason, CX reply and actions. Gaps are not findings. */
export function reportText(report: Report): string {
  return [
    report.root_cause?.statement ?? '',
    report.confidence_reason,
    ...report.current_state.map((s) => `${s.item}: ${s.value}`),
    ...report.timeline.map((t) => t.what),
    report.cx_answer.reply_text,
    ...report.actions.cx,
    ...report.actions.eng,
    ...report.actions.ops_bank,
  ].join('\n');
}

// A WHERE equality or a fields filter on a device or verification id.
const JOURNEY_KEYED = new RegExp(`\\b(?:${JOURNEY_FIELDS.join('|')})\\b["']?\\s*(?:=|:|\\bin\\b)`, 'i');

/** The rows of the report citing this service whose source call was keyed by a device or verification id. */
export function journeyKeyedCitations(report: Report, events: readonly RunEventLine[], ref: { entity: string; service: string }): number {
  const calls = new Map(toolCallsOf(events).map((c) => [c.id, c]));
  const sources = [...report.current_state.map((s) => s.source), ...report.timeline.map((t) => t.source)];
  return sources.filter((s) => {
    if (s.entity !== ref.entity || s.service !== ref.service || s.raw_ref === undefined) return false;
    const id = /^\/data\/(.+)\.json$/.exec(s.raw_ref)?.[1] ?? s.raw_ref;
    const args = calls.get(id)?.args;
    return JOURNEY_KEYED.test(s.raw_ref) || (args !== undefined && JOURNEY_KEYED.test(JSON.stringify(args)));
  }).length;
}
