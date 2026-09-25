// Agent contract: a run that pauses on a question for the person who
// started it, and resumes with the answer (P6 §4.3, D52).
//
// - ask_requester opens the question and the response ends there: no
//   triage.finish_required signal, the submission completes, and the run is
//   parked in needs_input with no report.
// - finish_report while the question is open is refused.
// - The answer arrives as a triage.input_answer signal (what answerRun
//   dispatches); the model reads it and finish_report completes the run.
// - A question that carries an unmasked identifier is refused, and the run
//   goes on to a report.
// - Past TRIAGE_MAX_ASKS_PER_RUN the tool refuses and names the limit.
// - Every audit line written here says transport 'mock', and the
//   ask_requester line never carries the question text.

import type { DeliveredMessageInput } from '@flue/runtime';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FINISH_REQUIRED_SIGNAL } from '../../../src/agents/triage-plan.ts';
import { redactPersisted } from '../../../src/gate/redact.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { ASK_REQUESTER } from '../../../src/tools/ask-requester.tool.ts';
import { INPUT_ANSWER_CHAIN_ATTR, INPUT_ANSWER_SIGNAL, type InputRequest } from '../../../src/types/input-request.ts';
import {
  auditLines,
  bootTriage,
  type Booted,
  contractHome,
  createRun,
  nextRunId,
  reportDraft,
  runTriage,
  type SeenCall,
  scriptAgents,
  triageInit,
} from './harness.ts';

const fake = createFakeModel();
// One question per run, so the limit case needs only one closed question.
const home = contractHome(fake, { overrides: { TRIAGE_MAX_ASKS_PER_RUN: '1' } });
let b: Booted;

const AT = '2026-09-20T10:00:00.000Z';
const ASK = {
  question: 'Which transfer is this about: the one on 2 Sep for 5,000 or the one on 3 Sep for 12,000?',
  why: 'Two transfers match the thread and their outcomes differ.',
  options: ['2 Sep for 5,000', '3 Sep for 12,000'],
};

const SIGNAL_OPEN = `<signal type="${FINISH_REQUIRED_SIGNAL}">`;
const signalsIn = (call: SeenCall | undefined): number =>
  (call?.userTexts ?? []).filter((t) => t.includes(SIGNAL_OPEN)).length;
const resultOf = (call: SeenCall | undefined, tool: string) => call?.toolResults.filter((r) => r.toolName === tool).at(-1);

function closedQuestion(questionId: string): InputRequest {
  return { question_id: questionId, kind: 'provide', question: 'Which one?', why: 'x', options: [], free_text: true, asked_at: AT };
}

beforeAll(async () => {
  b = await bootTriage(fake, home);
});

afterAll(async () => {
  await b?.flue.stop();
  home.dispose();
});

describe('a question for the requester', () => {
  test('ask_requester parks the run; the answer resumes it and finish_report completes it', async () => {
    const id = nextRunId('input_park');
    const init = triageInit(id);
    await createRun(b.store, init);
    // The scripted model asks, then tries finish_report anyway, then stops.
    const s = scriptAgents(fake, { triage: [toolCall(ASK_REQUESTER, ASK), finish(reportDraft(init)), text('waiting')] });

    const first = await runTriage(b.Triage, id, init);

    expect(first.ok).toBe(true);
    expect(fake.failures()).toEqual([]);
    const calls = s.callsFor('triage');
    expect(calls).toHaveLength(3);
    const opened = resultOf(calls[1], ASK_REQUESTER);
    expect(opened?.isError).toBe(false);
    expect(opened?.text).toContain('"question_id":"q1"');
    expect(opened?.text).toContain('"status":"waiting"');
    const refusedFinish = resultOf(calls[2], 'finish_report');
    expect(refusedFinish?.isError).toBe(false);
    expect(refusedFinish?.text).toContain('"status":"refused"');
    expect(refusedFinish?.text).toContain('q1');
    // The stop after the ask gets no finish_required signal.
    expect(signalsIn(calls[2])).toBe(0);
    expect(s.left()).toMatchObject({ triage: 0 });

    const parked = await b.store.getRun(id);
    expect(parked?.phase).toBe('needs_input');
    expect(parked?.input_request).toMatchObject({ question_id: 'q1', kind: 'provide', options: ASK.options, free_text: true });
    expect(parked?.report).toBeNull();

    // What the CLI does with the answer: close the question, move the phase
    // on, then dispatch the answer as a signal whose attributes carry the ids
    // ingress verified. The phase is the pipeline's, so the agent leaves it.
    await b.store.resolveInputRequest(id, 'q1', redactPersisted({ status: 'answered', resolved_at: AT, resolved_by: 'ops@example.test' }));
    await b.store.setPhase(id, 'dispatched', { worker_pid: 4242 });
    const chain = { ids: { customer_id: 'cust-contract-1', form_id: 'form-contract-9' }, hops: [], basic_state: [] };
    const answer: DeliveredMessageInput = {
      kind: 'signal',
      type: INPUT_ANSWER_SIGNAL,
      body: 'Answer from ops@example.test to your question q1: the one on 3 Sep for 12,000.',
      attributes: { question_id: 'q1', [INPUT_ANSWER_CHAIN_ATTR]: JSON.stringify(chain) },
    };
    const s2 = scriptAgents(fake, { triage: [finish(reportDraft(init)), text('report written')] });

    const second = await runTriage(b.Triage, id, undefined, answer);

    expect(second.ok).toBe(true);
    expect(fake.failures()).toEqual([]);
    const calls2 = s2.callsFor('triage');
    expect(calls2).toHaveLength(2);
    expect(calls2[0]?.userTexts.at(-1)).toContain('the one on 3 Sep for 12,000');
    const done = await b.store.getRun(id);
    expect(done?.phase).toBe('dispatched');
    expect(done?.report).not.toBeNull();
    expect(done?.input_request).toBeNull();
    expect(done?.input_history.map((r) => [r.question_id, r.status])).toEqual([['q1', 'answered']]);
  });

  test('a question with an unmasked identifier is refused, and the run goes on to a report', async () => {
    const id = nextRunId('input_unmasked');
    const init = triageInit(id);
    await createRun(b.store, init);
    // Synthetic account number: ten digits, which the egress check masks.
    const leaky = { question: 'Is the account 5555001234 the one the transfer left?', why: 'x' };
    const s = scriptAgents(fake, { triage: [toolCall(ASK_REQUESTER, leaky), finish(reportDraft(init)), text('done')] });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    const refused = resultOf(s.callsFor('triage')[1], ASK_REQUESTER);
    expect(refused?.isError).toBe(false);
    expect(refused?.text).toContain('"status":"refused"');
    expect(refused?.text).toContain('unmasked');
    expect(refused?.text).not.toContain('5555001234');
    const run = await b.store.getRun(id);
    expect(run?.input_request).toBeNull();
    expect(run?.report).not.toBeNull();
  });

  test('past TRIAGE_MAX_ASKS_PER_RUN the tool refuses and names the limit', async () => {
    const id = nextRunId('input_limit');
    const init = triageInit(id);
    await createRun(b.store, init);
    await b.store.putInputRequest(id, redactPersisted(closedQuestion('q1')));
    await b.store.resolveInputRequest(id, 'q1', redactPersisted({ status: 'skipped', resolved_at: AT, resolved_by: 'ops@example.test' }));
    await b.store.setPhase(id, 'investigating');
    const s = scriptAgents(fake, { triage: [toolCall(ASK_REQUESTER, { question: 'Which one?', why: 'x' }), finish(reportDraft(init)), text('done')] });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    const refused = resultOf(s.callsFor('triage')[1], ASK_REQUESTER);
    expect(refused?.text).toContain('"status":"refused"');
    expect(refused?.text).toContain('used its 1 question');
    const run = await b.store.getRun(id);
    expect(run?.input_request).toBeNull();
    expect(run?.input_history).toHaveLength(1);
    expect(run?.report).not.toBeNull();
  });
});

test('every audit line written in this file has transport mock, and no ask_requester line carries the question', () => {
  const lines = auditLines(home);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.transport !== 'mock')).toEqual([]);
  const asks = lines.filter((l) => l.tool === ASK_REQUESTER);
  expect(asks.some((l) => l.decision === 'allow')).toBe(true);
  expect(asks.some((l) => l.decision === 'deny')).toBe(true);
  for (const l of asks) expect(JSON.stringify(l)).not.toContain('Which transfer');
});
