// The settle listener (D70): a run's phase follows Flue's settlement even
// when the settle happens in a process that is not waiting on read().
//
// The normal path is dispatchAndSettle in src/ingress/submit.ts: the process
// that dispatched a submission awaits handle.read() and writes the terminal
// phase. When that process dies mid-run (a node --watch restart, a crash),
// Flue's lease-expiry recovery runs the submission again in a later process
// and settles it there, where nobody reads it. Without this listener the run
// stayed in investigating for good.
//
// installSettleListener() subscribes once per process with Flue's observe(),
// next to the run event log and the usage meter in bootRuntime. The run id is
// the agent instance id (event.instanceId, else ctx.id), as for those two. On
// submission_settled it waits SETTLE_GRACE_MS, so that in the process that
// awaits read() the normal path writes first and the listener finds nothing
// to do, then reads the run and writes with the store's compare-and-set
// (setPhaseIf), so a phase that moved meanwhile is never overwritten:
//   - outcome failed or aborted: phase dispatched or investigating becomes
//     failed, with the D67 reason failureReason() builds for the same
//     AgentRunError read() would have thrown;
//   - outcome completed: phase investigating becomes completed. needs_input
//     and blocked are set by tools before the settle, so they are never
//     overwritten;
//   - any other phase (stopped, completed, failed, needs_input, blocked, and
//     the intake phases) is left alone, and an unknown run is ignored.
// It writes a pipeline 'phase' line the way setPhaseLogged does, and a
// 'settled' line, both with via: 'settle_listener'. After a write it embeds
// the run as the normal path does (embedAfterSettle, with the embedder
// submissionDeps builds from the runtime's config), and the settled line
// carries the gaps.
//
// A settle for a submission the run has moved past is left alone: when a
// later submission that is not a steer exists, the phase belongs to that
// one. The settled submission's seq comes from the stored submission's Flue
// id (D71), else from the run's 'dispatch' lines in events.jsonl; with
// neither, a submission created after the settle time counts as later. A
// steer (D72) joins the live response and settles with it, so it does not
// count as moving on.
//
// A steer that missed the live response runs as its own (D72): Flue queues
// it and, once the host settled, emits submission_running for it. A joined
// steer never gets one, since only a claimed head runs; its lease's
// joinedInto is checked as well. On
// submission_running for a stored steer that did not join, the listener
// moves completed or failed to investigating (the reason cleared, as a
// follow-up does), so the run shows it working, and its settle is then
// handled like any other. It waits the same grace first, so the dispatch
// receipt has been recorded and the host's settle is handled before it.
//
// The normal path writes with the compare-and-set too, so of the two only
// the first writes, and only the one that wrote embeds. Events of
// one run are handled one after the other, so a host and a joined steer
// settling together write once.
//
// Usage (D59). When the settled submission's seq is known and its stored
// rows are not final yet, the listener writes them final: the meter's rows
// for the submission, plus the rows stored so far when this process did not
// see the submission's first attempt (the earlier attempts ran in a process
// that is gone, and only its live flush reached the store). In that case the
// meter's rows are dropped afterwards; when this process ran the first
// attempt they are left for the normal path, which drops them itself. The
// embedding's calls are counted on the submission before that write.
//
// A failure never reaches Flue or the runtime: it is counted
// (droppedSettles) and logged as settle_listener_failed with the error's
// class name.
//
// The state sits under a symbol key on globalThis (like the run event log and
// the usage meter), so a second copy of this module shares it.

import { AgentRunError, type FlueEventContext, type FlueObservation, observe } from '@flue/runtime';
import * as v from 'valibot';
import { triageRuntime } from '../agents/triage-plan.ts';
import { submissionLease, type SubmissionLeaseReader } from '../db/submission-lease.ts';
import type { Embedder } from '../embed/index.ts';
import { redactPersisted } from '../gate/redact.ts';
import { logRunEvent } from '../runlog/event-log.ts';
import { MAX_EVENTS_LIMIT, readRunEvents } from '../runlog/read.ts';
import type { PhaseDetail, RunPhase, RunRecord, RunStore } from '../runstore/types.ts';
import { RunIdSchema, type RunId } from '../types/core.ts';
import type { UsageRow } from '../types/usage.ts';
import { dropSubmission, snapshotSubmission } from '../usage/meter.ts';
import { className, embedAfterSettle, embedderFor, failureReason, type EmbedRunFn } from './submit.ts';

/** How long the listener waits after a settle before it reads the run, so the normal path writes first. */
export const SETTLE_GRACE_MS = 1000;

/** What the 'phase', 'settled' and usage lines the listener writes carry, to tell them from the normal path's. */
export const SETTLE_LISTENER_VIA = 'settle_listener';

export type SettleListenerOptions = {
  /** The run store. Called on a settle, not at install, so installing needs no config. */
  readonly store: () => RunStore | Promise<RunStore>;
  /** config.paths.runsDir, where the run's 'dispatch' lines give a submission's seq when the store has no Flue id for it. */
  readonly runsDir?: string;
  /** Default SETTLE_GRACE_MS. */
  readonly graceMs?: number;
  /** Defaults to Flue's observe(). */
  readonly observe?: (subscriber: (o: FlueObservation, ctx: FlueEventContext) => void) => () => void;
  /**
   * The embedder for the embedding after a settle it writes. Called once, on
   * the first such settle. Defaults to the one submissionDeps builds, from
   * triageRuntime()'s config; null embeds nothing but the gap.
   */
  readonly embedder?: () => Embedder | null;
  /** Defaults to embedRun from src/runstore/embed-run.ts. */
  readonly embedRun?: EmbedRunFn;
  /** Reads a steer's lease, to tell a joined one. Defaults to this process's (submissionLease). */
  readonly lease?: SubmissionLeaseReader;
};

/** One submission_settled, as the listener reads it. */
export type SettleEvent = {
  readonly runId: RunId;
  readonly submissionId: string;
  readonly outcome: 'completed' | 'failed' | 'aborted';
  /** The settlement error Flue attached, when there was one. */
  readonly error?: unknown;
  /** The event's timestamp (ISO), when it carried one. */
  readonly at?: string;
};

/** One submission_running, as the listener reads it. */
export type RunningEvent = {
  readonly runId: RunId;
  readonly submissionId: string;
  readonly attemptCount: number;
};

/** What handling one settle did. written is false when the phase moved before the compare-and-set. */
export type SettleAction =
  | { readonly kind: 'unknown_run' }
  | { readonly kind: 'left'; readonly phase: RunPhase; readonly why: 'phase' | 'moved_on' }
  | { readonly kind: 'wrote'; readonly phase: 'completed' | 'failed'; readonly written: boolean };

/** What handling a submission_running did: only a steer running as its own response is acted on. */
export type RunningAction =
  | { readonly kind: 'unknown_run' }
  | { readonly kind: 'not_steer' }
  | { readonly kind: 'joined' }
  | { readonly kind: 'left'; readonly phase: RunPhase; readonly why: 'phase' | 'moved_on' }
  | { readonly kind: 'wrote'; readonly phase: 'investigating'; readonly written: boolean };

type State = {
  unsubscribe: (() => void) | null;
  store: SettleListenerOptions['store'] | null;
  runsDir: string | undefined;
  graceMs: number;
  embedder: SettleListenerOptions['embedder'];
  embedRun: EmbedRunFn | undefined;
  lease: SubmissionLeaseReader | undefined;
  /** The embedder once built; undefined before the first settle that embeds. */
  builtEmbedder: { readonly value: Embedder | null } | undefined;
  /** submissionId -> the lowest attemptCount of a submission_running seen in this process. */
  readonly firstAttempt: Map<string, number>;
  /** run id -> the tail of its settle chain, so one run's settles are handled in order. */
  readonly chains: Map<string, Promise<void>>;
  readonly pending: Set<Promise<void>>;
  dropped: number;
};

const KEY = Symbol.for('triage.settle-listener');
type Global = typeof globalThis & { [KEY]?: State };

function state(): State {
  const g = globalThis as Global;
  g[KEY] ??= {
    unsubscribe: null,
    store: null,
    runsDir: undefined,
    graceMs: SETTLE_GRACE_MS,
    embedder: undefined,
    embedRun: undefined,
    lease: undefined,
    builtEmbedder: undefined,
    firstAttempt: new Map(),
    chains: new Map(),
    pending: new Set(),
    dropped: 0,
  };
  return g[KEY];
}

/** Subscribes the listener to Flue's events. Safe to call more than once: a second call only updates the options. */
export function installSettleListener(options: SettleListenerOptions): void {
  const s = state();
  s.store = options.store;
  s.runsDir = options.runsDir;
  s.graceMs = options.graceMs ?? SETTLE_GRACE_MS;
  s.embedder = options.embedder;
  s.embedRun = options.embedRun;
  s.lease = options.lease;
  s.builtEmbedder = undefined;
  if (s.unsubscribe !== null) return;
  const subscribe = options.observe ?? observe;
  s.unsubscribe = subscribe((observation, ctx) => onObservation(observation, ctx));
}

/** True once installSettleListener has run in this process. */
export function settleListenerInstalled(): boolean {
  return (globalThis as Global)[KEY]?.unsubscribe != null;
}

/** Stops the subscriber and forgets the state. Tests only. */
export function uninstallSettleListenerForTests(): void {
  const g = globalThis as Global;
  g[KEY]?.unsubscribe?.();
  delete g[KEY];
}

/** Resolves once every settle seen so far has been handled (tests). */
export async function flushSettleListener(): Promise<void> {
  const s = state();
  while (s.pending.size > 0) await Promise.allSettled([...s.pending]);
}

/** How many events or settles could not be handled since the listener was installed. */
export function droppedSettles(): number {
  return state().dropped;
}

// ------------------------------------------------------------------ internals

function onObservation(observation: FlueObservation, ctx: FlueEventContext): void {
  const s = state();
  try {
    const event = observation as unknown as Record<string, unknown>;
    if (event.type !== 'submission_running' && event.type !== 'submission_settled') return;
    const runId = typeof event.instanceId === 'string' ? event.instanceId : ctx?.id;
    const submissionId = event.submissionId;
    if (!v.is(RunIdSchema, runId) || typeof submissionId !== 'string' || submissionId === '') return;
    if (event.type === 'submission_running') {
      const attempt = typeof event.attemptCount === 'number' ? event.attemptCount : Number.POSITIVE_INFINITY;
      const seen = s.firstAttempt.get(submissionId);
      if (seen === undefined || attempt < seen) s.firstAttempt.set(submissionId, attempt);
      enqueue(s, runId, submissionId, async (store) => {
        await handleRunning(store, { runId, submissionId, attemptCount: attempt }, runningOptions(s));
      });
      return;
    }
    const outcome = event.outcome;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'aborted') return;
    const settle: SettleEvent = {
      runId,
      submissionId,
      outcome,
      ...(event.error !== undefined ? { error: event.error } : {}),
      ...(typeof event.timestamp === 'string' ? { at: event.timestamp } : {}),
    };
    schedule(s, settle);
  } catch {
    s.dropped++;
  }
}

function schedule(s: State, settle: SettleEvent): void {
  enqueue(s, settle.runId, settle.submissionId, async (store) => {
    const firstAttempt = s.firstAttempt.get(settle.submissionId);
    s.firstAttempt.delete(settle.submissionId);
    await handleSettle(store, settle, {
      ...(s.runsDir !== undefined ? { runsDir: s.runsDir } : {}),
      sawFirstAttempt: firstAttempt !== undefined && firstAttempt <= 1,
      embed: { embedder: embedderOf(s), ...(s.embedRun !== undefined ? { embedRun: s.embedRun } : {}) },
    });
  });
}

/** Runs work on the run's chain after the grace, so one run's events are handled in order. Never throws. */
function enqueue(s: State, runId: RunId, submissionId: string, work: (store: RunStore) => Promise<void>): void {
  const previous = s.chains.get(runId) ?? Promise.resolve();
  const task: Promise<void> = previous
    .then(() => delay(s.graceMs))
    .then(async () => {
      const store = s.store;
      if (store === null) return;
      await work(await store());
    })
    .catch((err: unknown) => {
      s.dropped++;
      logRunEvent(runId, 'settle_listener_failed', { submission_id: submissionId, error: className(err) });
    })
    .finally(() => {
      s.pending.delete(task);
      if (s.chains.get(runId) === task) s.chains.delete(runId);
    });
  s.chains.set(runId, task);
  s.pending.add(task);
}

function runningOptions(s: State): HandleRunningOptions {
  return { ...(s.runsDir !== undefined ? { runsDir: s.runsDir } : {}), lease: s.lease ?? submissionLease };
}

/** The embedder, built on first use: the option's, else the one submissionDeps builds from the runtime's config. */
function embedderOf(s: State): () => Embedder | null {
  return () => {
    if (s.builtEmbedder === undefined) {
      const value = s.embedder !== undefined ? s.embedder() : embedderFor(triageRuntime().config, undefined);
      s.builtEmbedder = { value };
    }
    return s.builtEmbedder.value;
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    // A pending settle never keeps the process alive.
    timer.unref?.();
  });
}

export type HandleSettleOptions = {
  /** Where the run's events.jsonl lives, for a submission stored without its Flue id. */
  readonly runsDir?: string;
  /** Whether this process saw the submission's first attempt, so the meter holds all of its turns. */
  readonly sawFirstAttempt: boolean;
  /** The embedding after a settle it writes. Left out: no embedding. */
  readonly embed?: { readonly embedder: () => Embedder | null; readonly embedRun?: EmbedRunFn };
};

/** Handles one settle: the phase write, then the final usage. Throws on a store error; the subscriber catches it. */
export async function handleSettle(store: RunStore, settle: SettleEvent, options: HandleSettleOptions): Promise<SettleAction> {
  const { runId, submissionId } = settle;
  const run = await store.getRun(runId);
  if (run === null) return { kind: 'unknown_run' };
  const seq =
    run.submissions.find((sub) => sub.flue_submission_id === submissionId)?.seq ??
    (options.runsDir !== undefined ? await seqFromLog(options.runsDir, runId, submissionId) : undefined);

  let action: SettleAction;
  const target = targetPhase(settle.outcome, run.phase);
  if (target === null) action = { kind: 'left', phase: run.phase, why: 'phase' };
  else if (movedOn(run, seq, settle.at)) action = { kind: 'left', phase: run.phase, why: 'moved_on' };
  else {
    const detail: PhaseDetail = target === 'failed' ? { reason: reasonOf(settle) } : {};
    const written = await store.setPhaseIf(runId, FROM_PHASES[target], target, detail);
    if (written) {
      logRunEvent(runId, 'phase', { phase: target, ...detail, via: SETTLE_LISTENER_VIA });
      // As the normal path: embedded once the status is in the store, counted on the submission.
      const gaps = options.embed !== undefined ? await embedAfter(store, run, settle, seq, options.embed) : [];
      logRunEvent(runId, 'settled', {
        ...(seq !== undefined ? { submission_seq: seq } : {}),
        submission_id: submissionId,
        status: target,
        ...(detail.reason !== undefined ? { error: detail.reason } : {}),
        gaps,
        via: SETTLE_LISTENER_VIA,
      });
    }
    action = { kind: 'wrote', phase: target, written };
  }

  await finalUsage(store, run, settle, seq, options.sawFirstAttempt);
  return action;
}

/** The phases each settle target may overwrite. needs_input, blocked and stopped are never listed. */
const FROM_PHASES: Readonly<Record<'completed' | 'failed', readonly RunPhase[]>> = {
  completed: ['investigating'],
  failed: ['dispatched', 'investigating'],
};

/** embedAfterSettle for the settled submission. The seq is only for its usage_missing line: the latest submission's when unknown. */
async function embedAfter(
  store: RunStore,
  run: RunRecord,
  settle: SettleEvent,
  seq: number | undefined,
  embed: NonNullable<HandleSettleOptions['embed']>,
): Promise<string[]> {
  let embedder: Embedder | null;
  try {
    embedder = embed.embedder();
  } catch (err) {
    return [`embeddings skipped (${className(err)})`];
  }
  const at = seq ?? run.submissions.at(-1)?.seq ?? 0;
  return embedAfterSettle({ store, embedder, ...(embed.embedRun !== undefined ? { embedRun: embed.embedRun } : {}) }, settle.runId, at, settle.submissionId);
}

export type HandleRunningOptions = {
  /** Where the run's events.jsonl lives, for a steer stored without its Flue id. */
  readonly runsDir?: string;
  /** Reads the steer's lease, to tell a joined one. */
  readonly lease: SubmissionLeaseReader;
};

/** The phases a steer running as its own response may move to investigating. */
const STEER_RUNNING_FROM: readonly RunPhase[] = ['completed', 'failed'];

/**
 * Handles one submission_running: a stored steer that did not join a live
 * response runs as its own, so a settled run goes back to investigating.
 * Anything else is left alone. Throws on a store error; the subscriber
 * catches it.
 */
export async function handleRunning(store: RunStore, event: RunningEvent, options: HandleRunningOptions): Promise<RunningAction> {
  const { runId, submissionId } = event;
  const run = await store.getRun(runId);
  if (run === null) return { kind: 'unknown_run' };
  const seq =
    run.submissions.find((sub) => sub.flue_submission_id === submissionId)?.seq ??
    (options.runsDir !== undefined ? await seqFromLog(options.runsDir, runId, submissionId) : undefined);
  const sub = seq === undefined ? undefined : run.submissions.find((x) => x.seq === seq);
  if (sub === undefined || sub.kind !== 'steer') return { kind: 'not_steer' };
  // Flue emits submission_running for a claimed head only; a lease that says it joined is never acted on.
  let joinedInto: string | undefined;
  try {
    joinedInto = (await options.lease(submissionId))?.joinedInto;
  } catch {
    joinedInto = undefined;
  }
  if (joinedInto !== undefined) return { kind: 'joined' };
  if (!STEER_RUNNING_FROM.includes(run.phase)) return { kind: 'left', phase: run.phase, why: 'phase' };
  if (movedOn(run, sub.seq, undefined)) return { kind: 'left', phase: run.phase, why: 'moved_on' };
  const written = await store.setPhaseIf(runId, STEER_RUNNING_FROM, 'investigating', {});
  if (written) {
    logRunEvent(runId, 'phase', { phase: 'investigating', submission_seq: sub.seq, steer: 'own_response', via: SETTLE_LISTENER_VIA });
  }
  return { kind: 'wrote', phase: 'investigating', written };
}

/** The D67 reason, built from the same AgentRunError read() throws for this settlement. */
function reasonOf(settle: SettleEvent): string {
  const outcome = settle.outcome === 'aborted' ? 'aborted' : 'failed';
  const cause = settle.error !== undefined ? { cause: settle.error } : {};
  return failureReason(new AgentRunError({ outcome, submissionId: settle.submissionId, ...cause }));
}

/** The phase the settle moves the run to, or null when the run's phase is not one the settle may change. */
function targetPhase(outcome: SettleEvent['outcome'], phase: RunPhase): 'completed' | 'failed' | null {
  if (outcome === 'completed') return phase === 'investigating' ? 'completed' : null;
  return phase === 'dispatched' || phase === 'investigating' ? 'failed' : null;
}

/**
 * Whether the run has a later submission than the settled one, other than a
 * steer: by seq when it is known, else by created_at after the settle time.
 */
function movedOn(run: RunRecord, seq: number | undefined, at: string | undefined): boolean {
  const settledAt = at !== undefined ? Date.parse(at) : Number.NaN;
  return run.submissions.some((sub) => {
    if (sub.kind === 'steer') return false;
    if (seq !== undefined) return sub.seq > seq;
    return Number.isFinite(settledAt) && Date.parse(sub.created_at) > settledAt;
  });
}

/**
 * The seq of the run's submission with this Flue id, from the 'dispatch'
 * line submit.ts writes after each dispatch, for a submission stored without
 * its Flue id. The line went through the persisted profile, so the masked
 * form of the id is matched too.
 */
async function seqFromLog(runsDir: string, runId: RunId, submissionId: string): Promise<number | undefined> {
  const masked = redactPersisted(submissionId).value;
  let after = 0;
  let found: number | undefined;
  for (;;) {
    const page = await readRunEvents(runsDir, runId, { after, limit: MAX_EVENTS_LIMIT });
    for (const line of page.events) {
      if (line.source !== 'pipeline' || line.type !== 'dispatch') continue;
      const data = line.data as { submission_id?: unknown; submission_seq?: unknown } | null;
      if (data?.submission_id !== submissionId && data?.submission_id !== masked) continue;
      if (typeof data.submission_seq === 'number' && Number.isInteger(data.submission_seq) && data.submission_seq > 0) {
        found = data.submission_seq;
      }
    }
    if (!page.more || page.next === after) return found;
    after = page.next;
  }
}

/** Writes the settled submission's usage final when it is not yet. Never throws. */
async function finalUsage(store: RunStore, run: RunRecord, settle: SettleEvent, seq: number | undefined, sawFirstAttempt: boolean): Promise<void> {
  const { runId, submissionId } = settle;
  const local = snapshotSubmission(runId, submissionId);
  if (seq === undefined) {
    if (local.length > 0) logRunEvent(runId, 'usage_unmapped', { submission_id: submissionId, rows: local.length, via: SETTLE_LISTENER_VIA });
    return;
  }
  const stored = run.usage.find((u) => u.seq === seq);
  if (stored?.final === true) return;
  const rows = sawFirstAttempt ? local : sumRows([...(stored?.rows ?? []), ...local]);
  if (rows.length === 0) return;
  try {
    await store.putUsage(runId, seq, rows, true);
  } catch (err) {
    logRunEvent(runId, 'usage_write_failed', { submission_seq: seq, final: true, error: className(err), via: SETTLE_LISTENER_VIA });
    return;
  }
  // With no first attempt here, no read of this submission is waiting in this process.
  if (!sawFirstAttempt) dropSubmission(runId, submissionId);
}

/** Rows summed by model, agent and purpose, in the byte order the run store keeps. */
function sumRows(rows: readonly UsageRow[]): UsageRow[] {
  const byKey = new Map<string, UsageRow>();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.agent}\u0000${row.purpose}`;
    const had = byKey.get(key);
    byKey.set(
      key,
      had === undefined
        ? { ...row }
        : {
            ...had,
            calls: had.calls + row.calls,
            failed_calls: had.failed_calls + row.failed_calls,
            input_tokens: had.input_tokens + row.input_tokens,
            output_tokens: had.output_tokens + row.output_tokens,
            cache_read_tokens: had.cache_read_tokens + row.cache_read_tokens,
            cache_write_tokens: had.cache_write_tokens + row.cache_write_tokens,
            // One row with no known price leaves the total unknown.
            usd: had.usd === null || row.usd === null ? null : had.usd + row.usd,
          },
    );
  }
  const keys = [...byKey.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => byKey.get(key) as UsageRow);
}
