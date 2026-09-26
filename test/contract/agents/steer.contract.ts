// Agent contract: resume on a run that is still working (D72). Every run
// here goes through the ingress pipeline (runSubmission and resumeRun from
// src/ingress/submit.ts) on the real Flue runtime with the fake model, the
// usage meter and the settle listener (D70) installed, so Flue's join
// semantics are what is tested, not a fake of them.
//
// - A steer while the response is live: Flue joins it at the next turn
//   boundary, the model reads the steer (a user message) on its next turn,
//   and there is one response. The steer settles with the host, with the same
//   outcome. The host's settle writes the phase and the usage: every turn
//   after the join carries the host's submission id, so the usage is on seq
//   1 and the steer has none. finish_report runs after the steer was stored,
//   so the report is on the steer's seq, the latest submission. The run is
//   embedded once.
// - A steer that misses the live response (the host settled first) runs as
//   its own response on the same conversation and settles like a follow-up:
//   its own phase write, usage on its seq, report on its seq, an embedding.
// - A stalled run: the resume stops it as 'stalled' with no verdict, Flue
//   aborts the live response, the host's read ends stopped, the aborted
//   settle lands while the run is stopped (the settle listener leaves it
//   alone), and the resume signal then runs as a new response to a report,
//   on the same Flue instance (the run id) and the same conversation and
//   session as the host.
// - The turn boundary (the owner's rule, pi-agent-core getSteeringMessages):
//   a steer sent while a tool call runs is added only after that turn's tool
//   calls have finished, and before the next model request. The tool call
//   is not cut short or skipped, and its result is in the conversation
//   before the steer.
//
// The response is held on a model call by a gate, so the steer or the stop
// lands while it is live. For the turn boundary the gate holds the
// delegate's model call, so the root's task tool call is the one in flight.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FauxResponseFactory } from '@earendil-works/pi-ai';
import { type FlueObservation, observe } from '@flue/runtime';
import { flushSettleListener, installSettleListener, SETTLE_LISTENER_VIA, uninstallSettleListenerForTests } from '../../../src/ingress/settle-listener.ts';
import type { SubmissionDeps, SubmissionResult } from '../../../src/ingress/submit.ts';
import { createFakeModel, type FakeStep, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../../../src/runlog/event-log.ts';
import { readRunEvents } from '../../../src/runlog/read.ts';
import type { RunRecord } from '../../../src/runstore/types.ts';
import type { Classification } from '../../../src/types/classification.ts';
import type { IdChain } from '../../../src/types/id-chain.ts';
import type { Stalled } from '../../../src/types/stalled.ts';
import { installUsageMeter, resetUsageMeterForTests } from '../../../src/usage/meter.ts';
import { bootTriage, type Booted, contractHome, nextRunId, reportDraft, scriptAgents, triageInit } from './harness.ts';

type SubmitModule = typeof import('../../../src/ingress/submit.ts');

const fake = createFakeModel();
const home = contractHome(fake);
let b: Booted;
let submit: SubmitModule;
let deps: SubmissionDeps;
/** The run ids embedRun was called for, in order. */
const embedded: string[] = [];

const AT = '2026-09-20T10:00:00.000Z';
const BY = 'oncall-ops';
const NOTE = 'the payout left the bank at 10:02; look at the bank reply first.';
const BRIEF = 'Entity: atspl\nQuestion: where is the parcel\nIds: none\nWindow: last week\nServices in play: package\nReturn: findings';
const STALLED: Stalled = { reason: 'no_owner', since: AT };
const CHAIN: IdChain = { ids: { customer_id: 'cust-contract-1' }, hops: [], basic_state: [] };
// No tier rule fires on it, so the proposed mid tier stands and a medium finding does not escalate.
const CLASSIFICATION: Classification = {
  category: 'transfer_out',
  subcategory: 'transfer not received',
  entities_likely: ['ssfb'],
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'mid',
  confidence: 0.9,
  images_seen: false,
};

function findings() {
  return {
    evidence: [{ source: 'db', at: AT, query_or_path: 'deliveries', summary: 'no dispatch row for the card' }],
    timeline: [],
    hypotheses: ['the dispatch job skipped the card'],
    confidence: 'medium' as const,
    gaps: [],
  };
}

beforeAll(async () => {
  installRunEventLog({ runsDir: home.config.paths.runsDir });
  b = await bootTriage(fake, home);
  resetUsageMeterForTests();
  installUsageMeter();
  // One spy for both writers of a settle, so a double embed shows. A short grace, as in production, so
  // the reader of a response writes its settle first and the listener finds nothing to do.
  const embedRun: NonNullable<SubmissionDeps['embedRun']> = async (_store, _embedder, runId) => {
    embedded.push(runId);
    return { written: [], unchanged: [], empty: [], gaps: [] };
  };
  installSettleListener({ store: () => b.store, runsDir: home.config.paths.runsDir, graceMs: 200, embedRun });
  submit = await import('../../../src/ingress/submit.ts');
  deps = {
    ...submit.submissionDeps({ runtime: b.plan.triageRuntime() }),
    identity: async () => ({ id_chain: CHAIN, basic_state: [], gaps: [] }),
    classify: async () => CLASSIFICATION,
    patterns: async () => [],
    embedRun,
    // Quick stop polls, so a stop is seen soon; the stalled resume waits one of them too.
    stopPollMs: 25,
    now: () => new Date(AT),
  };
});

afterAll(async () => {
  await flushSettleListener();
  uninstallSettleListenerForTests();
  resetUsageMeterForTests();
  await b?.flue.stop();
  await flushRunEventLog();
  uninstallRunEventLog();
  home.dispose();
});

// ------------------------------------------------------------------ helpers

type Gate = {
  /** The step that waits for open() (or for the call's abort), then answers with the message. */
  step(message: Exclude<FakeStep, FauxResponseFactory>): FauxResponseFactory;
  /** Resolves once the gated model call has started: the response is live. */
  readonly reached: Promise<void>;
  open(): void;
};

function gate(): Gate {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return {
    reached,
    open,
    step: (message) => async (_context, options) => {
      entered();
      const signal = options?.signal;
      await Promise.race([opened, new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))]);
      return message;
    },
  };
}

async function until(what: string, check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function stored(runId: string): Promise<RunRecord> {
  const run = await b.store.getRun(runId);
  if (run === null) throw new Error(`run ${runId} is not stored`);
  return run;
}

async function pipeline(runId: string): Promise<{ type: string; data: Record<string, unknown> }[]> {
  await flushSettleListener();
  await flushRunEventLog();
  const page = await readRunEvents(home.config.paths.runsDir, runId, { limit: 5000 });
  return page.events.filter((e) => e.source === 'pipeline').map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

function start(runId: string): Promise<SubmissionResult> {
  return submit.runSubmission({ run_id: runId, request: triageInit(runId).request, redaction_names: [] }, deps);
}

/** What a recorded Flue event carries that these tests read. */
type Seen = {
  readonly type: string;
  readonly instanceId?: string;
  readonly conversationId?: string;
  readonly session?: string;
  readonly taskId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly request?: { readonly input: { readonly systemPrompt?: string; readonly messages: readonly { role: string; content: unknown; toolName?: string; isError?: boolean }[] } };
};

/** Records every Flue event of one instance, in order. */
function record(runId: string): { readonly events: Seen[]; stop(): void } {
  const events: Seen[] = [];
  const stop = observe((o: FlueObservation) => {
    const e = o as unknown as Seen;
    if (e.instanceId === runId) events.push(e);
  });
  return { events, stop };
}

/** The root agent's model requests (not a delegate's), by the prompt the root renders. */
function rootRequests(events: readonly Seen[]): Seen[] {
  return events.filter((e) => {
    const system = e.type === 'turn_request' ? (e.request?.input.systemPrompt ?? '') : '';
    return system.includes('## Brief skeleton for this run') && !system.includes('## This delegate');
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
}

const calls = (run: RunRecord, seq: number): number | undefined =>
  run.usage.find((u) => u.seq === seq)?.rows.reduce((n, r) => n + r.calls, 0);

// ------------------------------------------------------------------ tests

describe('a steer while the response is live (D72)', () => {
  test('joins the live response: one response, settled with the host, usage on the host, the report on the steer', async () => {
    const id = nextRunId('steer_join');
    const g = gate();
    const s = scriptAgents(fake, {
      triage: [g.step(toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF })), finish(reportDraft(triageInit(id))), text('report written')],
      investigate_atspl: [toolCall('note_evidence', findings()), text('recorded')],
    });

    const host = start(id);
    await g.reached;
    await until('the host investigating', async () => (await b.store.getRun(id))?.phase === 'investigating');
    const modes: string[] = [];
    const steer = submit.resumeRun(id, { by: BY, note: NOTE }, { ...deps, stalled: async () => null, onResumeMode: (m) => modes.push(m) });
    await until('the steer dispatched', async () => (await stored(id)).submissions[1]?.flue_submission_id !== undefined);
    g.open();
    const [h, st] = await Promise.all([host, steer]);

    expect(fake.failures()).toEqual([]);
    expect(modes).toEqual(['steer']);
    expect(h).toMatchObject({ status: 'completed', submission_seq: 1 });
    expect(st).toMatchObject({ status: 'completed', submission_seq: 2, mode: 'steer', joined: true });
    // Joined deliveries read the coalesced reply of the host.
    expect(st.reply_text).toBe(h.reply_text);

    // One response: the three scripted root turns, no more. The second one read the steer.
    expect(s.left()).toMatchObject({ triage: 0, investigate_atspl: 0 });
    const root = s.callsFor('triage');
    expect(root).toHaveLength(3);
    expect(root[0]?.userTexts.join('\n')).not.toContain(NOTE);
    // A plain user message, as a follow-up is: no signal wrapper.
    const steered = root[1]?.userTexts.find((t) => t.includes(NOTE));
    expect(steered).toBe(`Note from ${BY}, added at ${AT} while this run is working:\n${NOTE}`);

    const run = await stored(id);
    expect(run.phase).toBe('completed');
    expect(run.submissions.map((sub) => [sub.seq, sub.kind, sub.note])).toEqual([
      [1, 'initial', undefined],
      [2, 'steer', NOTE],
    ]);
    // Usage: every turn is the host's (3 root turns and 2 delegate turns), final; the steer has no row.
    expect(run.usage.find((u) => u.seq === 1)?.final).toBe(true);
    expect(calls(run, 1)).toBe(5);
    expect(run.usage.find((u) => u.seq === 2)).toBeUndefined();
    // The report: finish_report wrote it after the steer was stored, on the latest submission.
    expect(run.submissions[0]?.report).toBeNull();
    expect(run.submissions[1]?.report).not.toBeNull();
    expect(run.report).not.toBeNull();
    expect(embedded.filter((r) => r === id)).toHaveLength(1);

    const lines = await pipeline(id);
    const settled = lines.filter((l) => l.type === 'settled' && l.data.via === undefined).map((l) => [l.data.submission_seq, l.data.status, l.data.joined]);
    expect(settled).toContainEqual([1, 'completed', undefined]);
    expect(settled).toContainEqual([2, 'completed', true]);
    // Only the host's settle wrote a phase outside the listener: the steer wrote none.
    const phases = lines.filter((l) => l.type === 'phase' && l.data.via === undefined).map((l) => l.data.phase);
    expect(phases).toEqual(['preflight', 'identity', 'classifying', 'dispatched', 'investigating', 'completed']);
  });

  test('a steer that misses the live response runs as its own response and settles like a follow-up', async () => {
    const id = nextRunId('steer_own');
    const s = scriptAgents(fake, {
      triage: [finish(reportDraft(triageInit(id))), text('report written'), finish(reportDraft(triageInit(id))), text('report updated')],
    });
    expect(await start(id)).toMatchObject({ status: 'completed', submission_seq: 1 });
    await flushSettleListener();
    // The host's response settled in Flue, but its reader has not written the phase yet.
    await b.store.setPhase(id, 'investigating');

    const st = await submit.resumeRun(id, { by: BY, note: NOTE }, { ...deps, stalled: async () => null });

    expect(fake.failures()).toEqual([]);
    expect(st).toMatchObject({ status: 'completed', submission_seq: 2, mode: 'steer', joined: false });
    expect(s.left()).toMatchObject({ triage: 0 });
    expect(s.callsFor('triage')[2]?.userTexts.at(-1)).toBe(`Note from ${BY}, added at ${AT} while this run is working:\n${NOTE}`);
    const run = await stored(id);
    expect(run.phase).toBe('completed');
    expect(run.usage.find((u) => u.seq === 2)?.final).toBe(true);
    expect(calls(run, 2)).toBe(2);
    expect(run.submissions[1]?.report).not.toBeNull();
    expect(embedded.filter((r) => r === id)).toHaveLength(2);
  });
});

describe('the steer turn boundary (D72, pi-agent-core getSteeringMessages)', () => {
  test('a steer sent while a tool call runs lands after its result and before the next model request; no tool call is skipped', async () => {
    const id = nextRunId('steer_boundary');
    // The delegate's first model call is held: the root's task tool call is in flight until it opens.
    const g = gate();
    /** The messages of the root's second model request, in order. */
    let second: { role: string; text: string; toolName?: string; isError?: boolean }[] = [];
    const s = scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        (context) => {
          second = context.messages.map((m) => ({
            role: m.role,
            text: m.role === 'toolResult' || m.role === 'user' ? textOf(m.content) : '',
            ...(m.role === 'toolResult' ? { toolName: m.toolName, isError: m.isError } : {}),
          }));
          return finish(reportDraft(triageInit(id)));
        },
        text('report written'),
      ],
      investigate_atspl: [g.step(toolCall('note_evidence', findings())), text('recorded')],
    });

    const seen = record(id);
    const host = start(id);
    await g.reached;
    const steer = submit.resumeRun(id, { by: BY, note: NOTE }, { ...deps, stalled: async () => null });
    await until('the steer dispatched', async () => (await stored(id)).submissions[1]?.flue_submission_id !== undefined);
    // The steer is in Flue's queue while the task tool call still runs.
    const atSteer = seen.events.length;
    expect(seen.events.some((e) => e.type === 'tool_start' && e.toolName === 'task')).toBe(true);
    expect(seen.events.some((e) => e.type === 'tool' && e.toolName === 'task')).toBe(false);
    g.open();
    const [h, st] = await Promise.all([host, steer]);
    seen.stop();

    expect(fake.failures()).toEqual([]);
    expect(h).toMatchObject({ status: 'completed', submission_seq: 1 });
    expect(st).toMatchObject({ status: 'completed', submission_seq: 2, mode: 'steer', joined: true });
    expect(s.left()).toMatchObject({ triage: 0, investigate_atspl: 0 });

    // The tool call ran to its end and its result is recorded: the delegate's evidence is stored.
    const events = seen.events;
    const taskEnd = events.findIndex((e) => e.type === 'tool' && e.toolName === 'task');
    expect(taskEnd).toBeGreaterThan(atSteer);
    expect(events[taskEnd]?.isError).toBe(false);
    expect((await stored(id)).evidence.atspl).toBeDefined();
    // No tool call was skipped or cut short: every start has one end, none an error (the delegate's
    // note_evidence ends inside the root's task, so the order is not the start order).
    const starts = events.filter((e) => e.type === 'tool_start').map((e) => `${e.toolName}:${e.toolCallId}`);
    const ends = events.filter((e) => e.type === 'tool').map((e) => `${e.toolName}:${e.toolCallId}:${e.isError}`);
    expect(starts.map((t) => t.split(':')[0]).sort()).toEqual(['finish_report', 'note_evidence', 'task']);
    expect([...ends].sort()).toEqual(starts.map((t) => `${t}:false`).sort());

    // The first root request that carries the steer is the one right after the task's result.
    const requests = rootRequests(events);
    expect(requests).toHaveLength(3);
    const carries = (e: Seen): boolean => (e.request?.input.messages ?? []).some((m) => m.role === 'user' && textOf(m.content).includes(NOTE));
    expect(requests.map(carries)).toEqual([false, true, true]);
    expect(events.indexOf(requests[1] as Seen)).toBeGreaterThan(taskEnd);

    // What the model was sent on that turn: the tool call, its result, then the steer, and nothing after it.
    const roles = second.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'toolResult', 'user']);
    expect(second[2]).toMatchObject({ toolName: 'task', isError: false });
    expect(second[2]?.text).not.toBe('');
    expect(second[3]?.text).toBe(`Note from ${BY}, added at ${AT} while this run is working:\n${NOTE}`);
    expect(s.callsFor('triage')[0]?.userTexts.join('\n')).not.toContain(NOTE);
  });
});

describe('resume on a stalled run (D72)', () => {
  test('stops it as stalled with no verdict, aborts the live response, then resumes it to a report', async () => {
    const id = nextRunId('steer_stalled');
    const g = gate();
    const s = scriptAgents(fake, {
      triage: [g.step(text('still looking')), finish(reportDraft(triageInit(id))), text('report written')],
    });

    const seen = record(id);
    const inits: unknown[] = [];
    const dispatcher: SubmissionDeps['dispatcher'] = {
      init: (agent, options) => {
        inits.push(options);
        return deps.dispatcher.init(agent, options);
      },
    };
    const host = start(id);
    await g.reached;
    await until('the host investigating', async () => (await b.store.getRun(id))?.phase === 'investigating');
    await until("the host's Flue id", async () => (await stored(id)).submissions[0]?.flue_submission_id !== undefined);
    const modes: string[] = [];
    const resumed = submit.resumeRun(id, { by: BY, note: NOTE }, { ...deps, dispatcher, stalled: async () => STALLED, onResumeMode: (m) => modes.push(m) });
    await until('the run stopped as stalled', async () => {
      const run = await stored(id);
      return run.phase === 'stopped' || run.submissions.length > 1;
    });
    g.open();
    const [h, r] = await Promise.all([host, resumed]);
    seen.stop();

    expect(fake.failures()).toEqual([]);
    expect(modes).toEqual(['resume']);
    // The same Flue instance (the run id) for the abort and the resume, and the
    // same conversation and session as the host: the resume continues it.
    expect(inits).toEqual([{ id }, { id }]);
    const requests = rootRequests(seen.events);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((e) => e.instanceId))).toEqual(new Set([id]));
    const conversation = requests[0]?.conversationId;
    const session = requests[0]?.session;
    expect(conversation).toBeDefined();
    expect(session).toBeDefined();
    expect(requests.map((e) => [e.conversationId, e.session])).toEqual(requests.map(() => [conversation, session]));
    // The resumed response sees the host's thread, not a new conversation.
    const resumedTexts = s.callsFor('triage')[1]?.userTexts ?? [];
    expect(resumedTexts[0]).toContain('transfer not received');
    expect(resumedTexts.at(-1)).toContain('<signal type="triage.resume">');
    // The host's read ended on the abort: stopped, not failed.
    expect(h).toMatchObject({ status: 'stopped', submission_seq: 1 });
    expect(r).toMatchObject({ status: 'completed', submission_seq: 2, mode: 'resume' });
    expect(s.left()).toMatchObject({ triage: 0 });
    const resumeSignal = s.callsFor('triage')[1]?.userTexts.find((t) => t.includes('<signal type="triage.resume">'));
    expect(resumeSignal).toContain('This run stalled before it finished (no process was working on it), so it was stopped.');
    expect(resumeSignal).toContain(NOTE);

    const run = await stored(id);
    expect(run.phase).toBe('completed');
    expect(run.feedback).toEqual([]);
    expect(run.submissions.map((sub) => sub.kind)).toEqual(['initial', 'resume']);
    expect(run.submissions[1]?.report).not.toBeNull();

    const lines = await pipeline(id);
    const stop = lines.find((l) => l.type === 'stop');
    expect(stop?.data).toMatchObject({ by: BY, reason: 'stalled', stopped_from: 'investigating', aborted: true, abort_settled: 'settled', verdict: false });
    // No phase went to failed, from the host's read or from the settle listener.
    const phases = lines.filter((l) => l.type === 'phase').map((l) => [l.data.phase, l.data.via ?? null, l.data.refused ?? null]);
    expect(phases.filter(([phase, , refused]) => phase === 'failed' && refused === null)).toEqual([]);
    expect(phases.filter(([, via]) => via === SETTLE_LISTENER_VIA).map(([phase]) => phase)).not.toContain('failed');
    expect(lines.filter((l) => l.type === 'settled' && l.data.via === undefined).map((l) => [l.data.submission_seq, l.data.status])).toEqual([
      [1, 'stopped'],
      [2, 'completed'],
    ]);
  });
});
