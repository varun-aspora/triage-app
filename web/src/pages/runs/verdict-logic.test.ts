import { describe, expect, test } from 'bun:test';
import type { FindingRef, RunEvent } from '../../api/types.ts';
import {
  appendEvents,
  buildVerdictBody,
  canCancel,
  groupFindings,
  isErrorEvent,
  matchesStepFilter,
  summariseStep,
  toggleMark,
  verdictLabel,
} from './verdict-logic.ts';

const findings: FindingRef[] = [
  { id: 'ssfb.v2.e1', kind: 'evidence', key: 'ssfb', version: 2, text: 'dispatch rejected', detail: 'db · select 1' },
  { id: 'ssfb.v2.h1', kind: 'hypothesis', key: 'ssfb', version: 2, text: 'address rejected' },
  { id: 'code.v1.c1', kind: 'code_claim', key: 'code', version: 1, text: 'no retry' },
  { id: 'root_cause', kind: 'root_cause', key: null, version: null, text: 'the vendor rejected it' },
];

const form = { notes: '', rootCause: '', fasterPath: '', name: 'Asha', marks: {} };

describe('verdict body', () => {
  test('accept is correct and reject is wrong; blank text is left out', () => {
    expect(buildVerdictBody('accept', form, findings)).toEqual({ ok: true, body: { verdict: 'correct', given_by: 'Asha' } });
    expect(buildVerdictBody('reject', { ...form, notes: '  wrong customer ', fasterPath: 'check logs' }, findings)).toEqual({
      ok: true,
      body: { verdict: 'wrong', given_by: 'Asha', notes: 'wrong customer', faster_path: 'check logs' },
    });
  });

  test('marks become finding verdicts; marks on findings the run no longer lists are dropped', () => {
    const r = buildVerdictBody('reject', { ...form, marks: { 'ssfb.v2.e1': 'wrong', 'root_cause': 'wrong', 'ssfb.v1.e1': 'correct' } }, findings);
    expect(r.ok && r.body.findings).toEqual([
      { id: 'ssfb.v2.e1', verdict: 'wrong' },
      { id: 'root_cause', verdict: 'wrong' },
    ]);
  });

  test('a name is needed and text has a limit', () => {
    expect(buildVerdictBody('accept', { ...form, name: ' ' }, findings)).toEqual({ ok: false, error: 'Enter your name.' });
    const long = buildVerdictBody('accept', { ...form, notes: 'x'.repeat(4001) }, findings);
    expect(long.ok).toBe(false);
  });

  test('ticking the same mark again clears it', () => {
    const a = toggleMark({}, 'x', 'correct');
    expect(a).toEqual({ x: 'correct' });
    expect(toggleMark(a, 'x', 'wrong')).toEqual({ x: 'wrong' });
    expect(toggleMark(a, 'x', 'correct')).toEqual({});
  });

  test('cancel only while running; labels read as the buttons do', () => {
    expect(canCancel({ status: 'running' })).toBe(true);
    expect(canCancel({ status: 'blocked' })).toBe(true);
    for (const status of ['completed', 'failed', 'stopped'] as const) expect(canCancel({ status })).toBe(false);
    expect(verdictLabel({ verdict: 'correct' })).toBe('accepted');
    expect(verdictLabel({ verdict: 'wrong' })).toBe('rejected');
    expect(verdictLabel({ verdict: 'wrong', cancelled: true })).toBe('cancelled');
    expect(verdictLabel({ verdict: 'partial' })).toBe('partial');
  });

  test('findings are grouped with the root cause first', () => {
    expect(groupFindings(findings).map((g) => [g.label, g.items.map((f) => f.id)])).toEqual([
      ['Report', ['root_cause']],
      ['SSFB findings', ['ssfb.v2.e1', 'ssfb.v2.h1']],
      ['Code', ['code.v1.c1']],
    ]);
  });
});

describe('steps', () => {
  const ev = (index: number, type: string, data: unknown, source: RunEvent['source'] = 'flue'): RunEvent => ({ index, ts: '2026-09-25T10:00:00.000Z', source, type, data });

  test('filters and errors', () => {
    const tool = ev(0, 'tool', { toolName: 'sql_select', isError: true, durationMs: 3 });
    const phase = ev(1, 'phase', { phase: 'identity' }, 'pipeline');
    const turn = ev(2, 'turn', { request: { requestedModel: 'm' }, response: { finishReason: 'stop', usage: { input: 1, output: 2 } }, durationMs: 10 });
    expect(matchesStepFilter(tool, 'tools')).toBe(true);
    expect(matchesStepFilter(tool, 'errors')).toBe(true);
    expect(matchesStepFilter(phase, 'pipeline')).toBe(true);
    expect(matchesStepFilter(phase, 'model')).toBe(false);
    expect(matchesStepFilter(turn, 'model')).toBe(true);
    expect(isErrorEvent(ev(3, 'submission_settled', { outcome: 'aborted' }))).toBe(true);
    expect(isErrorEvent(ev(4, 'submission_settled', { outcome: 'completed' }))).toBe(false);
  });

  test('summaries pick the fields a person scans for', () => {
    expect(summariseStep(ev(0, 'phase', { phase: 'identity' }))).toBe('identity');
    expect(summariseStep(ev(0, 'tool', { toolName: 'sql_select', isError: false, durationMs: 12.4, effectiveResult: { rows: 1 } }))).toBe('sql_select ok · 12 ms · {"rows":1}');
    expect(summariseStep(ev(0, 'message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'toolCall', name: 'note_evidence' }] } }))).toBe(
      'assistant: looking [call note_evidence]',
    );
    expect(summariseStep(ev(0, 'turn', { request: { requestedModel: 'm' }, response: { finishReason: 'stop', usage: { input: 1, output: 2 } }, durationMs: 10 }))).toBe(
      'm · stop · 1 in / 2 out · 10 ms',
    );
  });

  test('appending ignores lines already held', () => {
    const have = [ev(0, 'a', {}), ev(1, 'b', {})];
    expect(appendEvents(have, [ev(1, 'b', {}), ev(2, 'c', {})]).map((e) => e.index)).toEqual([0, 1, 2]);
  });
});

describe('lifecycle summaries', () => {
  const ev = (type: string, data: unknown): RunEvent => ({ index: 0, ts: '2026-09-25T10:00:00.000Z', source: 'flue', type, data });
  test('say where the event ran instead of printing the whole event', () => {
    expect(summariseStep(ev('agent_start', { session: 'default' }))).toBe('root');
    expect(summariseStep(ev('turn_start', { session: 'task:default:task_1' }))).toBe('delegate');
    expect(summariseStep(ev('submission_running', { attemptCount: 1, maxAttempts: 10 }))).toBe('attempt 1 of 10');
    expect(summariseStep(ev('classification', { decision: { proposed: { category: 'card' }, tier_final: 'mid', rule_fired: 'rule_3' } }))).toBe('card · tier mid (rule_3)');
    expect(summariseStep(ev('turn_request', { session: 'default', request: { requestedModel: 'm', input: { message_count: 4, systemPrompt: 'x' } } }))).toBe(
      'm · 4 messages · new system prompt · root',
    );
  });

  test('a block and a resume name the block, the systems and who sent the run on', () => {
    expect(summariseStep(ev('blocked', { submission_seq: 1, block_id: 'b1', systems: ['ssfb:harbor', 'global:codegraph'] }))).toBe('b1 · ssfb:harbor, global:codegraph');
    expect(summariseStep(ev('resume', { kind: 'resume', from: 'blocked', block_id: 'b1', by: 'Asha', note: 'harbor is back' }))).toBe(
      'by Asha from blocked (b1) · harbor is back',
    );
    expect(summariseStep(ev('resume', { kind: 'resume', from: 'stopped', by: 'Asha' }))).toBe('by Asha from stopped');
  });
});
