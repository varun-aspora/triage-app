// Contract: what Flue's event envelopes say about who made a model call
// (D59, plan W0.1), and the usage meter built on it (src/usage/meter.ts).
//
// Runs Triage on the fake model in strict mock mode (the agent harness in
// ./agents/harness.ts), records every raw observe() envelope, and checks the
// fields the meter relies on:
// (a) a delegate's turns carry the taskId of their task_start, and
//     task_start names the delegate (agent);
// (b) the strong synthesis turn carries the root's harness, session and
//     agentName, so none of them tells it apart; its prompt operation starts
//     while the root operation of the same submission is still open, and
//     that is what the meter uses;
// (c) every turn carries the run's instanceId;
// (d) every turn carries submissionId, equal to the dispatch receipt's;
// (e) useAgentFinish (settleRun) has run before handle.read resolves, and
//     submission_settled is seen before it resolves;
// (f) the synthesis operation's usage (what harness.prompt() returns as
//     response.usage) equals the sum of its turns.
// It stays as a regression test for Flue upgrades: if one of these changes,
// the meter's attribution has to change with it.

import { type FlueObservation, init, observe } from '@flue/runtime';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { redactPersisted } from '../../src/gate/redact.ts';
import { createFakeModel, finish, text, toolCall } from '../../src/mock/fake-model.ts';
import type { UsageRow } from '../../src/types/usage.ts';
import {
  installUsageMeter,
  resetUsageMeterForTests,
  runUsageInMemory,
  snapshotSubmission,
  takeUnassigned,
} from '../../src/usage/meter.ts';
import {
  bootTriage,
  type Booted,
  contractHome,
  createRun,
  nextRunId,
  reportDraft,
  scriptAgents,
  triageInit,
} from './agents/harness.ts';

const fake = createFakeModel();
const home = contractHome(fake);
let b: Booted;

const AT = '2026-09-20T10:00:00.000Z';
const BRIEF = 'Entity: atspl\nQuestion: where is the parcel\nIds: none\nWindow: last week\nServices in play: package\nReturn: findings';
const LOW = {
  evidence: [{ source: 'db', at: AT, query_or_path: 'deliveries', summary: 'no dispatch row for the card' }],
  timeline: [],
  hypotheses: ['the dispatch job skipped the card'],
  confidence: 'low',
  gaps: [],
};

type Envelope = Record<string, unknown>;
type Turn = Extract<FlueObservation, { type: 'turn' }> & Envelope;
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

beforeAll(async () => {
  b = await bootTriage(fake, home);
  resetUsageMeterForTests();
  installUsageMeter();
});

afterAll(async () => {
  resetUsageMeterForTests();
  await b?.flue.stop();
  home.dispose();
});

/** Every envelope Flue emits for one run, in order, with the receipt and what settleRun had cleared when read resolved. */
async function recordRun(runId: string, initialData: unknown, message = 'Triage this report.') {
  const events: Envelope[] = [];
  let reportWrittenAtLastTurn: boolean | undefined;
  const off = observe((o) => {
    const e = o as unknown as Envelope;
    if (e.instanceId !== runId) return;
    events.push(e);
    if (e.type === 'turn') reportWrittenAtLastTurn = b.plan.reportWrittenFor(runId);
  });
  try {
    const agent = init(b.Triage, { id: runId });
    const receipt = await agent.dispatch({ message, initialData });
    let error: unknown;
    try {
      await agent.read(receipt);
    } catch (err) {
      error = err;
    }
    // Copied now, so later events cannot change what 'before read resolved' means.
    const beforeRead = [...events];
    return { events: beforeRead, receipt, error, reportWrittenAtLastTurn, reportWrittenAfterRead: b.plan.reportWrittenFor(runId) };
  } finally {
    off();
  }
}

const turnsOf = (events: readonly Envelope[]): Turn[] => events.filter((e) => e.type === 'turn') as Turn[];

function sum(usages: readonly (Usage | undefined)[]): Usage {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const u of usages) {
    out.input += u?.input ?? 0;
    out.output += u?.output ?? 0;
    out.cacheRead += u?.cacheRead ?? 0;
    out.cacheWrite += u?.cacheWrite ?? 0;
  }
  return out;
}

const tokensOf = (row: UsageRow | undefined): Usage => ({
  input: row?.input_tokens ?? -1,
  output: row?.output_tokens ?? -1,
  cacheRead: row?.cache_read_tokens ?? -1,
  cacheWrite: row?.cache_write_tokens ?? -1,
});

describe('a cheap run with a delegate and escalation to the strong synthesis', () => {
  let rec: Awaited<ReturnType<typeof recordRun>>;
  let runId: string;

  beforeAll(async () => {
    runId = nextRunId('usage_escalate');
    const initial = triageInit(runId, { tier: 'cheap', hints: ['atspl'] });
    await createRun(b.store, initial);
    const draft = reportDraft(initial);
    scriptAgents(fake, {
      triage: [toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }), finish(draft), text('report written')],
      investigate_atspl: [toolCall('note_evidence', LOW), text('recorded, low confidence')],
      synthesis: [toolCall('finish', { ...draft, confidence: 'low', confidence_reason: 'rebuilt on the strong model' })],
    });
    rec = await recordRun(runId, initial);
    expect(rec.error).toBeUndefined();
  });

  test('(a) delegate turns carry the taskId of a task_start that names the delegate', () => {
    const starts = rec.events.filter((e) => e.type === 'task_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.agent).toBe('investigate_atspl');
    const taskId = starts[0]?.taskId;
    expect(typeof taskId).toBe('string');
    const delegate = turnsOf(rec.events).filter((t) => t.taskId !== undefined);
    expect(delegate).toHaveLength(2);
    expect(delegate.every((t) => t.taskId === taskId)).toBe(true);
    expect(delegate.every((t) => t.session === `task:default:${String(taskId)}` && t.parentSession === 'default')).toBe(true);
  });

  test('(b) the synthesis turn looks like a root turn except for its nested operation', () => {
    const turns = turnsOf(rec.events);
    const strong = turns.filter((t) => t.request.requestedModel === 'strong');
    expect(strong).toHaveLength(1);
    const synthesis = strong[0] as Turn;
    const rootTurns = turns.filter((t) => t.taskId === undefined && t !== synthesis);
    expect(rootTurns.length).toBeGreaterThan(0);
    for (const root of rootTurns) {
      expect([synthesis.harness, synthesis.session, synthesis.agentName]).toEqual([root.harness, root.session, root.agentName]);
    }
    expect([synthesis.harness, synthesis.session, synthesis.agentName, synthesis.taskId]).toEqual(['default', 'default', 'triage', undefined]);

    // Its operation is a prompt that starts while the root operation is open.
    const opStart = rec.events.findIndex((e) => e.type === 'operation_start' && e.operationId === synthesis.operationId);
    expect(rec.events[opStart]?.operationKind).toBe('prompt');
    const rootOp = rootTurns[0]?.operationId;
    expect(rootOp).not.toBe(synthesis.operationId);
    const rootStart = rec.events.findIndex((e) => e.type === 'operation_start' && e.operationId === rootOp);
    const rootEnd = rec.events.findIndex((e) => e.type === 'operation' && e.operationId === rootOp);
    expect(rootStart).toBeGreaterThanOrEqual(0);
    expect(opStart).toBeGreaterThan(rootStart);
    expect(rootEnd).toBeGreaterThan(opStart);
  });

  test('(c) every turn carries the run id as instanceId', () => {
    const turns = turnsOf(rec.events);
    expect(turns).toHaveLength(6);
    expect(turns.every((t) => t.instanceId === runId)).toBe(true);
  });

  test('(d) every turn carries the dispatch receipt submissionId', () => {
    expect(rec.receipt.submissionId).toMatch(/^sub_/);
    expect(turnsOf(rec.events).every((t) => t.submissionId === rec.receipt.submissionId)).toBe(true);
    expect(rec.events.filter((e) => e.type === 'task_start').every((e) => e.submissionId === rec.receipt.submissionId)).toBe(true);
  });

  test('(e) settleRun ran from useAgentFinish before read resolved', () => {
    // finish_report marked the report written; settleRun clears the mark.
    expect(rec.reportWrittenAtLastTurn).toBe(true);
    expect(rec.reportWrittenAfterRead).toBe(false);
    const settled = rec.events.filter((e) => e.type === 'submission_settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.submissionId).toBe(rec.receipt.submissionId);
    // No turn after the settle.
    const lastTurn = rec.events.map((e) => e.type).lastIndexOf('turn');
    expect(rec.events.indexOf(settled[0] as Envelope)).toBeGreaterThan(lastTurn);
  });

  test('(f) the synthesis operation usage equals the sum of its turns', () => {
    const synthesis = turnsOf(rec.events).find((t) => t.request.requestedModel === 'strong') as Turn;
    const op = rec.events.find((e) => e.type === 'operation' && e.operationId === synthesis.operationId);
    const opUsage = op?.usage as Usage | undefined;
    const turns = turnsOf(rec.events).filter((t) => t.operationId === synthesis.operationId);
    expect(opUsage).toBeDefined();
    expect(sum(turns.map((t) => t.response.usage))).toEqual(sum([opUsage]));
  });

  test('the meter charges the root, the delegate and the synthesis apart, with every token', () => {
    const rows = snapshotSubmission(runId, rec.receipt.submissionId);
    expect(rows.map((r) => [r.model, r.agent, r.purpose, r.calls, r.failed_calls])).toEqual([
      ['faux/cheap', 'investigate_atspl', 'agent', 2, 0],
      ['faux/cheap', 'triage', 'agent', 3, 0],
      ['faux/strong', 'synthesis', 'agent', 1, 0],
    ]);
    expect(rows.every((r) => r.usd === 0)).toBe(true);
    const turns = turnsOf(rec.events);
    const synthesisTurn = turns.find((t) => t.request.requestedModel === 'strong') as Turn;
    const byAgent = (agent: string) => rows.find((r) => r.agent === agent);
    expect(tokensOf(byAgent('synthesis'))).toEqual(sum([synthesisTurn.response.usage]));
    expect(tokensOf(byAgent('investigate_atspl'))).toEqual(sum(turns.filter((t) => t.taskId !== undefined).map((t) => t.response.usage)));
    expect(tokensOf(byAgent('triage'))).toEqual(
      sum(turns.filter((t) => t.taskId === undefined && t !== synthesisTurn).map((t) => t.response.usage)),
    );
    expect(runUsageInMemory(runId)).toEqual(rows);
    expect(takeUnassigned(runId)).toEqual([]);
  });
});

describe('the finish_required signal and a second submission', () => {
  test('a continuation after the signal is charged to triage, not synthesis', async () => {
    const runId = nextRunId('usage_signal');
    const initial = triageInit(runId);
    await createRun(b.store, initial);
    scriptAgents(fake, { triage: [text('I am done'), finish(reportDraft(initial)), text('report written')] });
    const rec = await recordRun(runId, initial);
    expect(rec.error).toBeUndefined();
    expect(turnsOf(rec.events)).toHaveLength(3);
    expect(snapshotSubmission(runId, rec.receipt.submissionId).map((r) => [r.agent, r.calls])).toEqual([['triage', 3]]);
  });

  test('a follow-up on the same run has its own submissionId and its own rows', async () => {
    const runId = nextRunId('usage_follow_up');
    const initial = triageInit(runId);
    await createRun(b.store, initial);
    const draft = reportDraft(initial);
    scriptAgents(fake, { triage: [finish(draft), text('report written')] });
    const first = await recordRun(runId, initial);
    expect(first.error).toBeUndefined();

    await b.store.addSubmission(runId, redactPersisted({ kind: 'ask' as const, question: 'and the second card?' }));
    scriptAgents(fake, { triage: [finish(draft), text('follow-up written')] });
    const second = await recordRun(runId, initial, 'And the second card?');
    expect(second.error).toBeUndefined();

    expect(second.receipt.submissionId).not.toBe(first.receipt.submissionId);
    expect(turnsOf(second.events).every((t) => t.submissionId === second.receipt.submissionId)).toBe(true);
    expect(snapshotSubmission(runId, first.receipt.submissionId).map((r) => [r.agent, r.calls])).toEqual([['triage', 2]]);
    expect(snapshotSubmission(runId, second.receipt.submissionId).map((r) => [r.agent, r.calls])).toEqual([['triage', 2]]);
    expect(runUsageInMemory(runId).map((r) => [r.agent, r.calls])).toEqual([['triage', 4]]);
  });
});
