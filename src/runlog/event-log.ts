// The per-run event log: <TRIAGE_RUNS_DIR>/<run_id>/events.jsonl, next to
// audit.jsonl. One JSON line per step, for debugging a run after the fact.
//
// Two sources write to it:
//   - 'flue': every runtime event Flue emits for the run (observe(), see
//     reference_events.md): submission lifecycle and recovery, operations,
//     model turns with usage and finish reasons, completed messages
//     (assistant text, thinking, tool calls, tool results), tool start and
//     end with args and results, delegated tasks, compaction and logs,
//     including the live-only fields (args, effectiveResult, errorInfo with
//     its stack). The run id is the agent instance id.
//   - 'pipeline': the ingress steps Flue does not see (phases, pre-flight,
//     identity, classification, dispatch, settle, stop, feedback), through
//     logRunEvent().
//
// Left out, because the same content is in another line (trimObservation in
// serialize.ts): streaming deltas, the conversation that every turn_request
// repeats (the system prompt and tool list are written once per session and
// again when they change), agent_end's message list and turn_messages'
// copies of messages.
//
// Every line goes through toPlain and then redactPersisted, with the run's
// ingress names when they are known (setRunRedactionNames), so the file
// holds persisted-profile text only, like every other stored copy of a run.
//
// The observe() subscriber only queues the event; the queue is drained on
// setImmediate, in order, so emission stays cheap and lines keep the order
// they were queued in. A write that fails is dropped and counted; it never
// reaches the agent.
//
// flushRunEventLogSync() writes whatever is queued right away, for a process
// about to exit (the server's SIGINT/SIGTERM handler), where the next
// setImmediate may never come.
//
// The same subscriber keeps the process's active runs: a run is active from
// Flue's submission_running (sent on every attempt, so the set is re-learned
// after a restart) until its submission_settled. The last pipeline phase and
// the attempt count ride along. activeRuns() reads it without touching the
// run store, so the server can name the runs a shutdown kills
// (src/server/shutdown.ts).
//
// installRunEventLog() installs one subscriber per process under a symbol
// key (like the tripwire), so a second call only updates the runs dir.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type FlueEventContext, type FlueObservation, observe } from '@flue/runtime';
import * as v from 'valibot';
import { redactPersisted } from '../gate/redact.ts';
import { RunIdSchema } from '../types/core.ts';
import { type SessionMemory, toPlain, trimObservation } from './serialize.ts';

export const EVENTS_FILE = 'events.jsonl';

export const RUN_EVENT_SOURCES = ['flue', 'pipeline'] as const;
export type RunEventSource = (typeof RUN_EVENT_SOURCES)[number];

/** One line of events.jsonl. */
export type RunEventLine = {
  readonly ts: string;
  readonly source: RunEventSource;
  readonly type: string;
  readonly data: unknown;
};

/** A run with a submission this process is driving. */
export type ActiveRun = {
  readonly runId: string;
  /** attemptCount of its latest submission_running. */
  readonly attempt: number;
  /** The last phase logged for it, when one was. */
  readonly phase?: string;
};

type Pending = { readonly runId: string; readonly line: RunEventLine; readonly names: readonly string[] };

type State = {
  runsDir: string | null;
  unsubscribe: (() => void) | null;
  queue: Pending[];
  draining: boolean;
  dropped: number;
  names: Map<string, readonly string[]>;
  sessions: Map<string, SessionMemory>;
  /** run id -> submission id -> attempt count, for the running submissions. */
  running: Map<string, Map<string, number>>;
  phases: Map<string, string>;
  now: () => Date;
};

const KEY = Symbol.for('triage.runlog');
type Global = typeof globalThis & { [KEY]?: State };

function state(): State {
  const g = globalThis as Global;
  g[KEY] ??= {
    runsDir: null,
    unsubscribe: null,
    queue: [],
    draining: false,
    dropped: 0,
    names: new Map(),
    sessions: new Map(),
    running: new Map(),
    phases: new Map(),
    now: () => new Date(),
  };
  return g[KEY];
}

export type RunEventLogOptions = {
  /** config.paths.runsDir, absolute. */
  readonly runsDir: string;
  /** Defaults to Flue's observe(). */
  readonly observe?: (subscriber: (o: FlueObservation, ctx: FlueEventContext) => void) => () => void;
  readonly now?: () => Date;
};

/** Starts writing the process's runs' events under runsDir. Safe to call more than once. */
export function installRunEventLog(options: RunEventLogOptions): void {
  const s = state();
  s.runsDir = options.runsDir;
  if (options.now !== undefined) s.now = options.now;
  if (s.unsubscribe !== null) return;
  const subscribe = options.observe ?? observe;
  s.unsubscribe = subscribe((observation, ctx) => onObservation(observation, ctx));
}

/** Stops the subscriber and forgets the state. Tests only. */
export function uninstallRunEventLog(): void {
  const g = globalThis as Global;
  g[KEY]?.unsubscribe?.();
  delete g[KEY];
}

/** True once installRunEventLog has run in this process. */
export function runEventLogInstalled(): boolean {
  return (globalThis as Global)[KEY]?.runsDir != null;
}

/** The ingress names to mask in the run's lines (Slack profiles, bot template fields). */
export function setRunRedactionNames(runId: string, names: readonly string[]): void {
  if (names.length === 0) return;
  state().names.set(runId, [...names]);
}

/** Writes one pipeline line for the run. A no-op until the log is installed. */
export function logRunEvent(runId: string, type: string, data: unknown = {}): void {
  const s = state();
  if (s.runsDir === null || !v.is(RunIdSchema, runId)) return;
  trackPipeline(s, runId, type, data);
  enqueue(s, runId, { ts: s.now().toISOString(), source: 'pipeline', type, data });
}

/** Resolves once every queued line has been written (tests, and before a process exits on purpose). */
export async function flushRunEventLog(): Promise<void> {
  const s = state();
  while (s.queue.length > 0 || s.draining) await new Promise((resolve) => setImmediate(resolve));
}

/** Writes every queued line now, in order. For a process about to exit; never throws. */
export function flushRunEventLogSync(): void {
  const s = state();
  if (s.queue.length === 0) return;
  // A drain already scheduled on setImmediate then finds the queue empty.
  s.draining = true;
  drain(s);
}

/** The runs with a submission running in this process, oldest first. Empty until the log is installed. */
export function activeRuns(): readonly ActiveRun[] {
  const s = state();
  const out: ActiveRun[] = [];
  for (const [runId, submissions] of s.running) {
    const attempt = Math.max(0, ...submissions.values());
    const phase = s.phases.get(runId);
    out.push(phase === undefined ? { runId, attempt } : { runId, attempt, phase });
  }
  return out;
}

/** How many lines could not be written since the log was installed. */
export function droppedRunEvents(): number {
  return state().dropped;
}

// ------------------------------------------------------------------ internals

function onObservation(observation: FlueObservation, ctx: FlueEventContext): void {
  const s = state();
  if (s.runsDir === null) return;
  const event = observation as unknown as Record<string, unknown>;
  const runId = typeof event.instanceId === 'string' ? event.instanceId : ctx.id;
  if (!v.is(RunIdSchema, runId)) return;
  trackSubmission(s, runId, event);
  const sessionKey = `${runId}\u0000${String(event.session ?? '')}\u0000${String(event.harness ?? '')}`;
  let memory = s.sessions.get(sessionKey);
  if (memory === undefined) {
    memory = {};
    s.sessions.set(sessionKey, memory);
  }
  const trimmed = trimObservation(event, memory);
  // A settled submission ends the sessions' prompt memory, so a long-lived server does not keep every run's prompt.
  if (event.type === 'submission_settled') {
    for (const key of s.sessions.keys()) if (key.startsWith(`${runId}\u0000`)) s.sessions.delete(key);
  }
  if (trimmed === null) return;
  const { type, timestamp, v: _version, ...data } = trimmed;
  enqueue(s, runId, {
    ts: typeof timestamp === 'string' ? timestamp : s.now().toISOString(),
    source: 'flue',
    type: String(type),
    data,
  });
}

function trackSubmission(s: State, runId: string, event: Record<string, unknown>): void {
  const submissionId = typeof event.submissionId === 'string' ? event.submissionId : '';
  if (event.type === 'submission_running') {
    let submissions = s.running.get(runId);
    if (submissions === undefined) {
      submissions = new Map();
      s.running.set(runId, submissions);
    }
    submissions.set(submissionId, typeof event.attemptCount === 'number' ? event.attemptCount : 0);
  } else if (event.type === 'submission_settled') {
    const submissions = s.running.get(runId);
    submissions?.delete(submissionId);
    if (submissions !== undefined && submissions.size > 0) return;
    s.running.delete(runId);
    s.phases.delete(runId);
  }
}

function trackPipeline(s: State, runId: string, type: string, data: unknown): void {
  if (type === 'phase') {
    const phase = (data as { phase?: unknown } | null)?.phase;
    if (typeof phase === 'string') s.phases.set(runId, phase);
  } else if ((type === 'settled' || type === 'failed') && !s.running.has(runId)) {
    // A run that ends without a submission (refused, failed before dispatch) would otherwise keep its phase.
    s.phases.delete(runId);
  }
}

function enqueue(s: State, runId: string, line: RunEventLine): void {
  s.queue.push({ runId, line, names: s.names.get(runId) ?? [] });
  if (s.draining) return;
  s.draining = true;
  setImmediate(() => drain(s));
}

function drain(s: State): void {
  try {
    // Lines queued while draining are written in the same pass.
    for (let item = s.queue.shift(); item !== undefined; item = s.queue.shift()) write(s, item);
  } finally {
    s.draining = false;
  }
}

function write(s: State, item: Pending): void {
  const runsDir = s.runsDir;
  if (runsDir === null) return;
  try {
    const safe = redactPersisted(toPlain(item.line), { names: item.names }).value;
    const dir = join(runsDir, item.runId);
    // mkdir -p on every write is cheap and survives a folder removed mid-run.
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(safe)}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    s.dropped++;
  }
}
