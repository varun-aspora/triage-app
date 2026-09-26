// The usage meter (D59): counts every model call a run makes, per Flue
// submission, model, agent and purpose, and prices each call when it is
// counted. It holds usage only and makes no safety decisions; the tripwire
// stays the safety gate.
//
// installUsageMeter() subscribes once per process with Flue's observe(), next
// to the run event log in bootRuntime. The run id is the agent instance id
// (event.instanceId, else ctx.id). What the subscriber reads, as the
// usage-attribution contract (test/contract/usage-attribution.contract.ts)
// found on Flue 2.0.8:
// - every event of a dispatched run carries the dispatch receipt's
//   submissionId, so rows are kept per (run, submission) and a second
//   submission on the same run never takes the first one's turns. A turn
//   without one goes to the run's unassigned bucket, which the settle code
//   takes with takeUnassigned() and logs.
// - task_start carries the delegate's name (agent) and a taskId that every
//   turn of the delegate carries too.
// - the strong synthesis (harness.prompt() inside finish_report) carries the
//   root's harness, session and agentName, so no envelope field names it.
//   What does: its prompt operation starts while the root's operation in
//   the same session and submission is still open. A turn of such a nested
//   operation is charged to 'synthesis'. finish_report is the only tool that
//   calls harness.prompt() today.
// So a turn's agent is the delegate its taskId started (or 'task' when the
// task_start was not seen), else 'synthesis' for a nested root prompt, else
// 'triage'. Its purpose is 'compaction' for compaction and
// compaction_prefix turns, otherwise 'agent'. compaction and operation
// events carry usage too, but their model calls already came as turns, so
// that usage is not added again.
//
// Calls outside Flue (the classifier, embeddings) come in through
// recordUsage(), into the run's intake bucket (seq 0) or a submission's.
//
// A failed call (isError) counts as a call and a failed call, and its tokens
// count. usd is priceUsage() at capture unless the caller presets it (a
// decision model's provider-reported cost); a row whose price is unknown for
// any of its calls has usd null. A row that could not be stored (a model or
// agent the row schema refuses) is dropped and counted, never thrown: the
// subscriber and recordUsage() never throw.
//
// The state sits under a symbol key on globalThis (like the run event log),
// so a second copy of this module shares it.

import { type FlueEventContext, type FlueObservation, observe } from '@flue/runtime';
import * as v from 'valibot';
import { RunIdSchema, type RunId } from '../types/core.ts';
import { USAGE_AGENT_PATTERN, USAGE_MODEL_PATTERN, type UsagePurpose, type UsageRow, UsagePurposeSchema } from '../types/usage.ts';
import { priceUsage } from './price.ts';

/** One counted call, as recordUsage() takes it. */
export type UsageEvent = {
  /** 'provider/model': the configured spec. */
  readonly model: string;
  readonly agent: string;
  readonly purpose: UsagePurpose;
  readonly isError: boolean;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The part of cacheWrite written with the 1-hour retention. */
  readonly cacheWrite1h?: number;
  /** A preset price, such as the cost a decision provider reports. null: unknown. Omitted: priceUsage(). */
  readonly usd?: number | null;
};

/** Where a recordUsage() call goes: the run's intake (seq 0) or one Flue submission. */
export type UsageBucket = 'intake' | { readonly submissionId: string };

export type MeterOptions = {
  /** Defaults to Flue's observe(). */
  readonly observe?: (subscriber: (o: FlueObservation, ctx: FlueEventContext) => void) => () => void;
};

type MutableRow = {
  calls: number;
  failed_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number | null;
};

type Bucket = { readonly rows: Map<string, MutableRow>; version: number };

type OpenOperation = { readonly submissionId: string | undefined; readonly session: string; readonly synthesis: boolean };

type RunState = {
  intake: Bucket | undefined;
  unassigned: Bucket | undefined;
  readonly submissions: Map<string, Bucket>;
  /** taskId -> the delegate it started, while the task runs. */
  readonly tasks: Map<string, { readonly agent: string; readonly submissionId: string | undefined }>;
  /** Root-session operations that have started and not ended, by operationId. */
  readonly operations: Map<string, OpenOperation>;
};

type State = {
  unsubscribe: (() => void) | null;
  readonly runs: Map<string, RunState>;
  /** Process-wide change counter; a bucket keeps the value of its last change. */
  clock: number;
  dropped: number;
};

const KEY = Symbol.for('triage.usage-meter');
type Global = typeof globalThis & { [KEY]?: State };

function state(): State {
  const g = globalThis as Global;
  g[KEY] ??= { unsubscribe: null, runs: new Map(), clock: 0, dropped: 0 };
  return g[KEY];
}

/** The agent for a turn of a task whose task_start was not seen, or whose name the row schema refuses. */
export const UNKNOWN_TASK_AGENT = 'task';

/** Subscribes the meter to Flue's events. Safe to call more than once: it subscribes once per process. */
export function installUsageMeter(options: MeterOptions = {}): void {
  const s = state();
  if (s.unsubscribe !== null) return;
  const subscribe = options.observe ?? observe;
  s.unsubscribe = subscribe((observation, ctx) => onObservation(observation, ctx));
}

/** True once installUsageMeter has run in this process. */
export function usageMeterInstalled(): boolean {
  return (globalThis as Global)[KEY]?.unsubscribe != null;
}

/** Stops the subscriber and forgets every count. Tests only. */
export function resetUsageMeterForTests(): void {
  const g = globalThis as Global;
  g[KEY]?.unsubscribe?.();
  delete g[KEY];
}

/** How many events or records could not be counted since the meter was installed. */
export function droppedUsageEvents(): number {
  return state().dropped;
}

/** The rows of one Flue submission, sorted by model, agent and purpose. Empty when none was counted. */
export function snapshotSubmission(runId: RunId, submissionId: string): UsageRow[] {
  return rowsOf(state().runs.get(runId)?.submissions.get(submissionId));
}

/** The run's intake rows (seq 0: the classifier and the prior-cases embedding). */
export function snapshotIntake(runId: RunId): UsageRow[] {
  return rowsOf(state().runs.get(runId)?.intake);
}

/** Every row of the run still in memory (intake, submissions, unassigned), summed by model, agent and purpose. */
export function runUsageInMemory(runId: RunId): UsageRow[] {
  const run = state().runs.get(runId);
  if (run === undefined) return [];
  const merged: Bucket = { rows: new Map(), version: 0 };
  for (const bucket of [run.intake, ...run.submissions.values(), run.unassigned]) {
    for (const [key, row] of bucket?.rows ?? []) addInto(merged, key, row);
  }
  return rowsOf(merged);
}

/**
 * Changes whenever the submission's rows change, and never repeats a value
 * for the same submission. 0 when nothing is counted for it. The live flush
 * skips a tick when this did not move.
 */
export function usageVersion(runId: RunId, submissionId: string): number {
  return state().runs.get(runId)?.submissions.get(submissionId)?.version ?? 0;
}

/** Forgets one submission's rows, after its final write. */
export function dropSubmission(runId: RunId, submissionId: string): void {
  const run = state().runs.get(runId);
  if (run === undefined) return;
  run.submissions.delete(submissionId);
  prune(runId, run);
}

/** Forgets the run's intake rows, after the seq 0 write. */
export function dropIntake(runId: RunId): void {
  const run = state().runs.get(runId);
  if (run === undefined) return;
  run.intake = undefined;
  prune(runId, run);
}

/** Returns and forgets the run's turns that carried no submissionId. */
export function takeUnassigned(runId: RunId): UsageRow[] {
  const run = state().runs.get(runId);
  if (run === undefined) return [];
  const rows = rowsOf(run.unassigned);
  run.unassigned = undefined;
  prune(runId, run);
  return rows;
}

/** Counts one call made outside Flue. Never throws; a record the row schema would refuse is dropped and counted. */
export function recordUsage(runId: RunId, bucket: UsageBucket, e: UsageEvent): void {
  const s = state();
  try {
    if (!v.is(RunIdSchema, runId)) throw new Error('run id');
    const submissionId = bucket === 'intake' ? undefined : bucket.submissionId;
    if (submissionId !== undefined && (typeof submissionId !== 'string' || submissionId === '')) throw new Error('submissionId');
    if (!v.is(UsagePurposeSchema, e.purpose)) throw new Error('purpose');
    const run = runState(s, runId);
    const target = submissionId === undefined ? (run.intake ??= newBucket()) : bucketIn(run.submissions, submissionId);
    count(s, target, e.model, e.agent, e.purpose, e.isError === true, tokensOf(e), e.usd === undefined ? undefined : presetUsd(e.usd));
  } catch {
    s.dropped++;
  }
}

// ------------------------------------------------------------------ internals

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number };

/** The event types the meter reads; every other event is ignored. */
const READ_TYPES: ReadonlySet<unknown> = new Set(['turn', 'task_start', 'task', 'operation_start', 'operation', 'submission_settled']);

function onObservation(observation: FlueObservation, ctx: FlueEventContext): void {
  const s = state();
  try {
    const event = observation as unknown as Record<string, unknown>;
    const type = event.type;
    if (!READ_TYPES.has(type)) return;
    const runId = typeof event.instanceId === 'string' ? event.instanceId : ctx?.id;
    if (!v.is(RunIdSchema, runId)) {
      if (type === 'turn') s.dropped++;
      return;
    }
    const submissionId = typeof event.submissionId === 'string' && event.submissionId !== '' ? event.submissionId : undefined;
    const taskId = typeof event.taskId === 'string' ? event.taskId : undefined;
    const operationId = typeof event.operationId === 'string' ? event.operationId : undefined;

    if (type === 'task_start') {
      if (taskId === undefined) return;
      const agent = typeof event.agent === 'string' && USAGE_AGENT_PATTERN.test(event.agent) ? event.agent : UNKNOWN_TASK_AGENT;
      runState(s, runId).tasks.set(taskId, { agent, submissionId });
      return;
    }
    if (type === 'task') {
      const run = s.runs.get(runId);
      if (run === undefined || taskId === undefined) return;
      run.tasks.delete(taskId);
      prune(runId, run);
      return;
    }
    if (type === 'operation_start') {
      // Operations inside a task belong to the delegate; its taskId names it.
      if (taskId !== undefined || operationId === undefined) return;
      const run = runState(s, runId);
      const session = String(event.session ?? '');
      let nested = false;
      for (const open of run.operations.values()) {
        if (open.submissionId === submissionId && open.session === session) nested = true;
      }
      run.operations.set(operationId, { submissionId, session, synthesis: nested && event.operationKind === 'prompt' });
      return;
    }
    if (type === 'operation') {
      const run = s.runs.get(runId);
      if (run === undefined || operationId === undefined) return;
      run.operations.delete(operationId);
      prune(runId, run);
      return;
    }
    if (type === 'submission_settled') {
      // Nothing of a settled submission is still open; this also clears what a lost end event left behind.
      const run = s.runs.get(runId);
      if (run === undefined) return;
      for (const [id, op] of run.operations) if (op.submissionId === submissionId) run.operations.delete(id);
      for (const [id, task] of run.tasks) if (task.submissionId === submissionId) run.tasks.delete(id);
      prune(runId, run);
      return;
    }
    onTurn(s, runId, submissionId, taskId, operationId, event);
  } catch {
    s.dropped++;
  }
}

function onTurn(
  s: State,
  runId: RunId,
  submissionId: string | undefined,
  taskId: string | undefined,
  operationId: string | undefined,
  event: Record<string, unknown>,
): void {
  const request = event.request as { providerId?: unknown; requestedModel?: unknown } | undefined;
  const response = event.response as { usage?: Record<string, unknown> } | undefined;
  if (typeof request?.providerId !== 'string' || typeof request.requestedModel !== 'string') throw new Error('model');
  const model = `${request.providerId}/${request.requestedModel}`;
  const run = runState(s, runId);
  let agent = 'triage';
  if (taskId !== undefined) agent = run.tasks.get(taskId)?.agent ?? UNKNOWN_TASK_AGENT;
  else if (operationId !== undefined && run.operations.get(operationId)?.synthesis === true) agent = 'synthesis';
  const purpose: UsagePurpose = event.purpose === 'compaction' || event.purpose === 'compaction_prefix' ? 'compaction' : 'agent';
  const usage = response?.usage;
  const tokens: Tokens = {
    input: tokenCount(usage?.input),
    output: tokenCount(usage?.output),
    cacheRead: tokenCount(usage?.cacheRead),
    cacheWrite: tokenCount(usage?.cacheWrite),
    ...(usage?.cacheWrite1h === undefined ? {} : { cacheWrite1h: tokenCount(usage.cacheWrite1h) }),
  };
  const target = submissionId === undefined ? (run.unassigned ??= newBucket()) : bucketIn(run.submissions, submissionId);
  count(s, target, model, agent, purpose, event.isError === true, tokens, undefined);
}

/** Adds one call to a bucket. Throws when the model or agent would fail the row schema; the callers count that as dropped. */
function count(
  s: State,
  bucket: Bucket,
  model: string,
  agent: string,
  purpose: UsagePurpose,
  isError: boolean,
  tokens: Tokens,
  usd: number | null | undefined,
): void {
  if (typeof model !== 'string' || !USAGE_MODEL_PATTERN.test(model)) throw new Error('model');
  if (typeof agent !== 'string' || !USAGE_AGENT_PATTERN.test(agent)) throw new Error('agent');
  addInto(bucket, keyOf(model, agent, purpose), {
    calls: 1,
    failed_calls: isError ? 1 : 0,
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_tokens: tokens.cacheRead,
    cache_write_tokens: tokens.cacheWrite,
    usd: usd === undefined ? price(model, tokens, purpose) : usd,
  });
  s.clock += 1;
  bucket.version = s.clock;
}

function price(model: string, tokens: Tokens, purpose: UsagePurpose): number | null {
  try {
    return presetUsd(priceUsage(model, tokens, purpose));
  } catch {
    return null;
  }
}

function presetUsd(usd: number | null | undefined): number | null {
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : null;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function tokensOf(e: UsageEvent): Tokens {
  return {
    input: tokenCount(e.input),
    output: tokenCount(e.output),
    cacheRead: tokenCount(e.cacheRead),
    cacheWrite: tokenCount(e.cacheWrite),
    ...(e.cacheWrite1h === undefined ? {} : { cacheWrite1h: tokenCount(e.cacheWrite1h) }),
  };
}

function addInto(bucket: Bucket, key: string, add: MutableRow): void {
  const row = bucket.rows.get(key);
  if (row === undefined) {
    bucket.rows.set(key, { ...add });
    return;
  }
  row.calls += add.calls;
  row.failed_calls += add.failed_calls;
  row.input_tokens += add.input_tokens;
  row.output_tokens += add.output_tokens;
  row.cache_read_tokens += add.cache_read_tokens;
  row.cache_write_tokens += add.cache_write_tokens;
  // One call with no known price leaves the row's total unknown.
  row.usd = row.usd === null || add.usd === null ? null : row.usd + add.usd;
}

// NUL cannot appear in a model, an agent or a purpose that passed their patterns.
function keyOf(model: string, agent: string, purpose: UsagePurpose): string {
  return `${model}\u0000${agent}\u0000${purpose}`;
}

function rowsOf(bucket: Bucket | undefined): UsageRow[] {
  if (bucket === undefined) return [];
  // Byte order, the order the run store keeps rows in.
  const keys = [...bucket.rows.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => {
    const [model, agent, purpose] = key.split('\u0000') as [string, string, UsagePurpose];
    const row = bucket.rows.get(key) as MutableRow;
    return Object.freeze({ model, agent, purpose, ...row });
  });
}

function newBucket(): Bucket {
  return { rows: new Map(), version: 0 };
}

function bucketIn(map: Map<string, Bucket>, id: string): Bucket {
  let bucket = map.get(id);
  if (bucket === undefined) map.set(id, (bucket = newBucket()));
  return bucket;
}

function runState(s: State, runId: RunId): RunState {
  let run = s.runs.get(runId);
  if (run === undefined) {
    run = { intake: undefined, unassigned: undefined, submissions: new Map(), tasks: new Map(), operations: new Map() };
    s.runs.set(runId, run);
  }
  return run;
}

/** Forgets a run that holds nothing any more, so a long-lived server does not keep every run. */
function prune(runId: RunId, run: RunState): void {
  if (run.intake !== undefined || run.unassigned !== undefined) return;
  if (run.submissions.size > 0 || run.tasks.size > 0 || run.operations.size > 0) return;
  state().runs.delete(runId);
}
