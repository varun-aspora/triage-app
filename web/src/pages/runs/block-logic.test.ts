import { describe, expect, test } from 'bun:test';
import { MAX_RESUME_NOTE_CHARS } from '../../../../src/types/block.ts';
import type { BlockRecord, ResolvedBlock } from '../../api/types.ts';
import {
  blockHistory,
  buildResumeBody,
  canResume,
  failureCodeLabel,
  groupFailures,
  MAX_RESUME_NOTE,
  openBlock,
  refusalText,
  resolutionLabel,
  resumeFrom,
  shownBlock,
  submissionKindLabel,
} from './block-logic.ts';

const block: BlockRecord = {
  block_id: 'b1',
  systems: ['ssfb:harbor', 'global:codegraph'],
  failures: [
    { system: 'ssfb:harbor', tool: 'sql_select', code: 'unreachable', at: '2026-09-26T10:00:00.000Z' },
    { system: 'ssfb:harbor', tool: 'sql_select', code: 'timeout', at: '2026-09-26T10:01:00.000Z' },
  ],
  reason: 'Harbor holds the dispatch rows; nothing else has them.',
  blocked_at: '2026-09-26T10:02:00.000Z',
  submission_seq: 1,
};

const sub = (seq: number) => ({ seq, kind: 'initial' as const, created_at: '', has_report: false });

describe('resume body', () => {
  test('trims the name and leaves a blank note out', () => {
    expect(buildResumeBody({ name: ' Asha ', note: '  ' })).toEqual({ ok: true, body: { requested_by: 'Asha' } });
    expect(buildResumeBody({ name: 'Asha', note: ' harbor is back ' })).toEqual({ ok: true, body: { requested_by: 'Asha', note: 'harbor is back' } });
  });

  test('needs a name and keeps the note within the server limit', () => {
    expect(MAX_RESUME_NOTE).toBe(MAX_RESUME_NOTE_CHARS);
    expect(buildResumeBody({ name: ' ', note: '' })).toEqual({ ok: false, error: 'Enter your name.' });
    expect(buildResumeBody({ name: 'Asha', note: 'x'.repeat(MAX_RESUME_NOTE + 1) }).ok).toBe(false);
    expect(buildResumeBody({ name: 'Asha', note: 'x'.repeat(MAX_RESUME_NOTE) }).ok).toBe(true);
  });
});

describe('resumeFrom', () => {
  test('blocked always; failed and stopped only once a submission was sent', () => {
    expect(resumeFrom({ status: 'blocked', submissions: [] })).toBe('blocked');
    expect(resumeFrom({ status: 'failed', submissions: [] })).toBeNull();
    expect(resumeFrom({ status: 'failed', submissions: [sub(1)] })).toBe('failed');
    expect(resumeFrom({ status: 'stopped', submissions: [sub(1)] })).toBe('stopped');
    expect(canResume({ status: 'stopped', submissions: [] })).toBe(false);
    expect(canResume({ status: 'completed', submissions: [sub(1)] })).toBe(false);
    expect(canResume({ status: 'running', submissions: [sub(1)] })).toBe(false);
  });
});

describe('block reads', () => {
  test('the open block and the history tolerate a run without the fields', () => {
    expect(openBlock({})).toBeNull();
    expect(openBlock({ block: null })).toBeNull();
    expect(openBlock({ block })).toBe(block);
    expect(blockHistory({})).toEqual([]);
  });

  test('shownBlock falls back to the last closed block', () => {
    const closed: ResolvedBlock = { ...block, status: 'resumed', resolved_at: '2026-09-26T11:00:00.000Z', resolved_by: 'Asha' };
    expect(shownBlock({ block: null, block_history: [closed] })).toBe(closed);
    expect(shownBlock({ block, block_history: [closed] })).toBe(block);
    expect(shownBlock({ block: null, block_history: [] })).toBeNull();
  });

  test('failures are grouped per system in the block order; a system with none still appears', () => {
    expect(groupFailures(block).map((g) => [g.system, g.failures.map((f) => f.code)])).toEqual([
      ['ssfb:harbor', ['unreachable', 'timeout']],
      ['global:codegraph', []],
    ]);
  });
});

describe('labels', () => {
  test('failure codes, resolutions and submission kinds read as words', () => {
    expect(failureCodeLabel('unreachable')).toBe('unreachable');
    expect(failureCodeLabel('timeout')).toBe('timed out');
    expect(failureCodeLabel('error')).toBe('errored');
    expect(resolutionLabel({ status: 'resumed', resolved_by: 'Asha' })).toBe('resumed by Asha');
    expect(resolutionLabel({ status: 'cancelled', resolved_by: 'Asha' })).toBe('cancelled by Asha');
    expect((['initial', 'ask', 'answer', 'resume'] as const).map(submissionKindLabel)).toEqual(['first run', 'follow-up', 'answer', 'resume']);
  });

  test('a 409 reads as the error, the phase and the hint', () => {
    expect(refusalText({ error: 'run is not resumable', phase: 'completed', hint: 'ask a follow-up with triage ask' })).toBe(
      'run is not resumable (phase completed): ask a follow-up with triage ask',
    );
    expect(refusalText({ error: 'run is blocked', hint: 'resume it first' })).toBe('run is blocked: resume it first');
    expect(refusalText({ error: 'run is not running' })).toBe('run is not running');
  });
});
