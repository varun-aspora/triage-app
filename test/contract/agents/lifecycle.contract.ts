// Agent contract: the Triage run lifecycle (T06.10; HLD 02 §1.1, LLD 04
// §2.4, §3; D23, D42).
//
// - A create without valid initialData is refused before any model call.
// - A response that stops without a written report gets one
//   triage.finish_required signal, then settles failed with the evidence kept.
// - A low-confidence finding on a cheap run makes finish_report rebuild the
//   report on the strong model; a medium one does not.
// - Every audit line written here says transport 'mock'.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRunError } from '@flue/runtime';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FINISH_REQUIRED_SIGNAL } from '../../../src/agents/triage-plan.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
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
const home = contractHome(fake);
let b: Booted;

const AT = '2026-09-20T10:00:00.000Z';
const BRIEF = 'Entity: atspl\nQuestion: where is the parcel\nIds: none\nWindow: last week\nServices in play: package\nReturn: findings';

function findings(confidence: 'high' | 'medium' | 'low') {
  return {
    evidence: [{ source: 'db', at: AT, query_or_path: 'deliveries', summary: 'no dispatch row for the card' }],
    timeline: [],
    hypotheses: ['the dispatch job skipped the card'],
    confidence,
    gaps: [],
  };
}

const SIGNAL_OPEN = `<signal type="${FINISH_REQUIRED_SIGNAL}">`;
const signalsIn = (call: SeenCall | undefined): number =>
  (call?.userTexts ?? []).filter((t) => t.includes(SIGNAL_OPEN)).length;
const resultOf = (call: SeenCall | undefined, tool: string) => call?.toolResults.filter((r) => r.toolName === tool).at(-1);

/** Asserts the run was refused at admission for its creation data. */
function expectInitialDataRejected(result: Awaited<ReturnType<typeof runTriage>>): void {
  expect(result.ok).toBe(false);
  const error = (result as { error: { type?: unknown; details?: unknown } }).error;
  expect(error.type).toBe('invalid_request');
  expect(String(error.details)).toContain('initialData schema');
}

beforeAll(async () => {
  b = await bootTriage(fake, home);
});

afterAll(async () => {
  await b?.flue.stop();
  home.dispose();
});

describe('initialData', () => {
  test('a create without initialData is rejected before any model call', async () => {
    const s = scriptAgents(fake, { triage: [text('should not run')] });
    const result = await runTriage(b.Triage, nextRunId('life_no_init'), undefined);
    expectInitialDataRejected(result);
    expect(s.calls).toEqual([]);
  });

  test('a create whose initialData has no classification is rejected before any model call', async () => {
    const id = nextRunId('life_no_class');
    const { classification: _dropped, ...rest } = triageInit(id);
    const s = scriptAgents(fake, { triage: [text('should not run')] });
    const result = await runTriage(b.Triage, id, rest);
    expectInitialDataRejected(result);
    expect(String((result as { error: { details?: unknown } }).error.details)).toContain('classification');
    expect(s.calls).toEqual([]);
  });

  test('a create with a bad tier in the classification is rejected too', async () => {
    const id = nextRunId('life_bad_tier');
    const init = triageInit(id);
    const bad = { ...init, classification: { ...init.classification, tier_final: 'huge' } };
    const s = scriptAgents(fake, { triage: [text('should not run')] });
    const result = await runTriage(b.Triage, id, bad);
    expectInitialDataRejected(result);
    expect(s.calls).toEqual([]);
  });

  test('a valid initialData is accepted', async () => {
    const id = nextRunId('life_valid');
    const init = triageInit(id);
    await createRun(b.store, init);
    const s = scriptAgents(fake, { triage: [finish(reportDraft(init)), text('report written')] });
    const result = await runTriage(b.Triage, id, init);
    expect(result.ok).toBe(true);
    expect(s.callsFor('triage')).toHaveLength(2);
  });
});

describe('finish_report is required', () => {
  test('no finish_report: one triage.finish_required signal, then the submission settles failed with the evidence kept', async () => {
    const id = nextRunId('life_no_finish');
    const init = triageInit(id, { hints: ['atspl'] });
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }), text('I am done'), text('still done')],
      investigate_atspl: [toolCall('note_evidence', findings('medium')), text('recorded')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(false);
    const error = (result as { error: unknown }).error;
    expect(error).toBeInstanceOf(AgentRunError);
    expect((error as AgentRunError).outcome).toBe('failed');

    const calls = s.callsFor('triage');
    expect(calls).toHaveLength(3);
    // No signal before the first stop, exactly one after it, and no second one.
    expect(signalsIn(calls[1])).toBe(0);
    expect(signalsIn(calls[2])).toBe(1);
    expect(s.left()).toMatchObject({ triage: 0, investigate_atspl: 0 });
    expect(fake.failures()).toEqual([]);

    // The evidence folder is intact and no report was written.
    const evidenceFile = join(home.config.paths.runsDir, id, 'evidence', 'atspl.json');
    expect(existsSync(evidenceFile)).toBe(true);
    expect(JSON.parse(readFileSync(evidenceFile, 'utf8'))).toMatchObject({ confidence: 'medium' });
    const run = await b.store.getRun(id);
    expect(run?.evidence.atspl?.findings).toMatchObject({ confidence: 'medium' });
    expect(run?.report).toBeNull();
  });

  test('a finish_report that fails or is refused does not count: the signal still comes, once', async () => {
    const id = nextRunId('life_refused');
    const init = triageInit(id);
    await createRun(b.store, init);
    // Synthetic address: the egress check refuses email addresses in free text.
    const leaky = reportDraft(init, { confidence_reason: 'confirmed by ops.contract@example.test' });
    const s = scriptAgents(fake, {
      triage: [finish({ status: 'not a report' }), finish(leaky), text('I am done'), text('still done')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(false);
    expect((result as { error: unknown }).error).toBeInstanceOf(AgentRunError);
    const calls = s.callsFor('triage');
    expect(calls).toHaveLength(4);
    // Flue rejects the bad shape before the tool runs.
    const invalid = resultOf(calls[1], 'finish_report');
    expect(invalid?.isError).toBe(true);
    expect(invalid?.text).toContain('Validation failed for tool "finish_report"');
    // The tool runs on the second call and refuses to write the report.
    const refused = resultOf(calls[2], 'finish_report');
    expect(refused?.isError).toBe(false);
    expect(refused?.text).toContain('"status":"refused"');
    expect(refused?.text).not.toContain('ops.contract@example.test');
    expect(signalsIn(calls[2])).toBe(0);
    expect(signalsIn(calls[3])).toBe(1);
    expect((await b.store.getRun(id))?.report).toBeNull();
  });

  test('a stop, the signal, then finish_report: the submission completes', async () => {
    const id = nextRunId('life_recover');
    const init = triageInit(id);
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [text('I am done'), finish(reportDraft(init)), text('report written')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    const calls = s.callsFor('triage');
    expect(calls).toHaveLength(3);
    expect(signalsIn(calls[1])).toBe(1);
    expect(signalsIn(calls[2])).toBe(1);
    expect((await b.store.getRun(id))?.report).not.toBeNull();
  });
});

describe('escalation to strong synthesis', () => {
  const STRONG_REASON = 'rebuilt by the strong synthesis from the low-confidence evidence';

  test('a low-confidence note_evidence on a cheap run makes finish_report use the strong model', async () => {
    const id = nextRunId('life_escalate');
    const init = triageInit(id, { tier: 'cheap', hints: ['atspl'] });
    await createRun(b.store, init);
    const draft = reportDraft(init);
    const s = scriptAgents(fake, {
      triage: [toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }), finish(draft), text('report written')],
      investigate_atspl: [toolCall('note_evidence', findings('low')), text('recorded, low confidence')],
      synthesis: [toolCall('finish', { ...draft, confidence: 'low', confidence_reason: STRONG_REASON })],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    expect(s.left()).toMatchObject({ triage: 0, investigate_atspl: 0, synthesis: 0 });
    // The run itself stays on the cheap tier; only the synthesis call is strong.
    expect(s.callsFor('triage').map((c) => c.model)).toEqual(['cheap', 'cheap', 'cheap']);
    expect(s.callsFor('investigate_atspl').map((c) => c.model)).toEqual(['cheap', 'cheap']);
    const synthesis = s.callsFor('synthesis');
    expect(synthesis).toHaveLength(1);
    expect(synthesis[0]?.model).toBe('strong');
    // The synthesis happens inside finish_report, after the delegate recorded its finding.
    const order = s.calls.map((c) => c.agent);
    expect(order.indexOf('synthesis')).toBeGreaterThan(order.lastIndexOf('investigate_atspl'));

    const written = resultOf(s.callsFor('triage')[2], 'finish_report');
    expect(written?.text).toContain('"escalated":true');
    expect(written?.text).toContain('low_confidence');
    const run = await b.store.getRun(id);
    expect(run?.report).toMatchObject({
      escalated: true,
      escalation_reasons: ['low_confidence'],
      confidence_reason: STRONG_REASON,
    });
  });

  test('a medium-confidence finding on a cheap run keeps the draft and never calls the strong model', async () => {
    const id = nextRunId('life_no_escalate');
    const init = triageInit(id, { tier: 'cheap', hints: ['atspl'] });
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        finish(reportDraft(init)),
        text('report written'),
      ],
      investigate_atspl: [toolCall('note_evidence', findings('medium')), text('recorded')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    expect(s.callsFor('synthesis')).toEqual([]);
    expect(s.calls.some((c) => c.model === 'strong')).toBe(false);
    const run = await b.store.getRun(id);
    expect(run?.report).toMatchObject({ escalated: false, escalation_reasons: [] });
  });
});

test('every audit line written in this file has transport mock', () => {
  const lines = auditLines(home);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.transport !== 'mock')).toEqual([]);
  // The lines cover the tools that ran: evidence from the delegates and the report writes.
  const tools = new Set(lines.map((l) => l.tool));
  expect(tools.has('note_evidence')).toBe(true);
  expect(tools.has('finish_report')).toBe(true);
});
