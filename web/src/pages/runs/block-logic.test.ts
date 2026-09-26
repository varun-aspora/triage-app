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
  RESUME_LIMIT_MS,
  RESUME_START_LIMIT_MS,
  resumedText,
  resumeFrom,
  resumeLabels,
  resumePending,
  shownBlock,
  STALLED_STOP_REASON,
  startsResuming,
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

  test('a note to a running run needs the note; a stalled resume does not', () => {
    expect(buildResumeBody({ name: 'Asha', note: ' ' }, 'running')).toEqual({ ok: false, error: 'Write a note first.' });
    expect(buildResumeBody({ name: 'Asha', note: ' check harbor ' }, 'running')).toEqual({ ok: true, body: { requested_by: 'Asha', note: 'check harbor' } });
    expect(buildResumeBody({ name: 'Asha', note: '' }, 'stalled')).toEqual({ ok: true, body: { requested_by: 'Asha' } });
    expect(buildResumeBody({ name: ' ', note: 'x' }, 'running')).toEqual({ ok: false, error: 'Enter your name.' });
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

  test('a run still investigating takes a note, or a resume once it stalled (D72)', () => {
    const stalled = { reason: 'no_owner' as const, since: '2026-09-26T10:00:00.000Z' };
    expect(resumeFrom({ status: 'running', phase: 'investigating', submissions: [sub(1)] })).toBe('running');
    expect(resumeFrom({ status: 'running', phase: 'dispatched', submissions: [sub(1)] })).toBe('running');
    expect(resumeFrom({ status: 'running', phase: 'investigating', submissions: [sub(1)], stalled })).toBe('stalled');
  });

  test('no form before the first dispatch, while it waits on an answer, or without a submission', () => {
    for (const phase of ['created', 'preflight', 'identity', 'classifying', 'needs_input'] as const) {
      expect(resumeFrom({ status: 'running', phase, submissions: [sub(1)] })).toBeNull();
    }
    expect(resumeFrom({ status: 'running', phase: 'investigating', submissions: [] })).toBeNull();
    expect(resumeFrom({ status: 'completed', phase: 'completed', submissions: [sub(1)] })).toBeNull();
  });
});

describe('resume labels', () => {
  test('a running run gets a note form, a stalled one a Resume form', () => {
    expect(resumeLabels('running')).toMatchObject({
      title: 'Send a note to the running investigation',
      description: 'It reaches the agent at its next step; the run keeps going.',
      button: 'Send note',
      by: 'Sent by',
    });
    expect(resumeLabels('stalled')).toMatchObject({ title: 'Resume this run', button: 'Resume', by: 'Resumed by' });
    expect(resumeLabels('stalled').description).toStartWith('Resume stops the current attempt and continues with your note');
    for (const from of ['blocked', 'failed', 'stopped'] as const) {
      expect(resumeLabels(from)).toMatchObject({ title: 'Resume the run', button: 'Resume', by: 'Resumed by' });
    }
  });

  test('the confirmation follows the mode the server answered with', () => {
    expect(resumedText('steer')).toStartWith('Note sent.');
    expect(resumedText('resume')).toStartWith('Resumed.');
    // A server older than D72 sends no mode and only ever resumes.
    expect(resumedText(undefined)).toStartWith('Resumed.');
  });
});

describe('a stalled resume in flight (D72)', () => {
  const stalled = { reason: 'no_owner' as const, since: '2026-09-26T10:00:00.000Z' };
  const t0 = Date.parse('2026-09-26T10:30:00.000Z');
  const pending = { afterSeq: 1, startedAt: t0 };
  const resumeSub = { seq: 2, kind: 'resume' as const, created_at: '', has_report: false };
  const at = (ms: number) => t0 + ms;

  test('starts when a working run answers resume; a steer or any other resume polls as before', () => {
    expect(startsResuming('stalled', { mode: 'resume' })).toBe(true);
    // The server found the run stalled when the note arrived, and resumed it.
    expect(startsResuming('running', { mode: 'resume' })).toBe(true);
    expect(startsResuming('running', { mode: 'steer' })).toBe(false);
    for (const from of ['blocked', 'failed', 'stopped'] as const) expect(startsResuming(from, { mode: 'resume' })).toBe(false);
  });

  test('stays in flight through the old attempt, the stop and the new dispatch', () => {
    // The server has not stopped it yet.
    expect(resumePending({ status: 'running', phase: 'investigating', submissions: [sub(1)], stalled }, pending, at(1_000))).toBe(true);
    // Stopped for the resume: never the stopped view with its Resume form.
    const stoppedForIt = { status: 'stopped' as const, phase: 'stopped' as const, phase_reason: STALLED_STOP_REASON, submissions: [sub(1)] };
    expect(resumePending(stoppedForIt, pending, at(20_000))).toBe(true);
    // The resume submission is stored before the phase moves on.
    expect(resumePending({ ...stoppedForIt, submissions: [sub(1), resumeSub] }, pending, at(40_000))).toBe(true);
    // Running on the new submission but still read as stalled.
    expect(resumePending({ status: 'running', phase: 'dispatched', submissions: [sub(1), resumeSub], stalled }, pending, at(41_000))).toBe(true);
  });

  test('ends once the run runs again and is not stalled, waits on an answer, or ends', () => {
    const resumed = [sub(1), resumeSub];
    expect(resumePending({ status: 'running', phase: 'dispatched', submissions: resumed }, pending, at(45_000))).toBe(false);
    expect(resumePending({ status: 'running', phase: 'needs_input', submissions: [sub(1)] }, pending, at(5_000))).toBe(false);
    for (const status of ['completed', 'failed', 'blocked'] as const) {
      expect(resumePending({ status, phase: status, submissions: resumed }, pending, at(60_000))).toBe(false);
    }
    // Stopped again by someone else after the resume went out.
    expect(resumePending({ status: 'stopped', phase: 'stopped', phase_reason: 'stopped by Asha', submissions: resumed }, pending, at(60_000))).toBe(false);
  });

  test('a run that settled before the stop is resumed from there, unless it completed', () => {
    expect(resumePending({ status: 'failed', phase: 'failed', submissions: [sub(1)] }, pending, at(5_000))).toBe(true);
    expect(resumePending({ status: 'completed', phase: 'completed', submissions: [sub(1)] }, pending, at(5_000))).toBe(false);
  });

  test('gives up without a new submission after the start limit, and in all after the limit', () => {
    const stoppedForIt = { status: 'stopped' as const, phase: 'stopped' as const, phase_reason: STALLED_STOP_REASON, submissions: [sub(1)] };
    expect(resumePending(stoppedForIt, pending, at(RESUME_START_LIMIT_MS - 1))).toBe(true);
    expect(resumePending(stoppedForIt, pending, at(RESUME_START_LIMIT_MS))).toBe(false);
    const stalledAgain = { status: 'running' as const, phase: 'investigating' as const, submissions: [sub(1), resumeSub], stalled };
    expect(resumePending(stalledAgain, pending, at(RESUME_LIMIT_MS - 1))).toBe(true);
    expect(resumePending(stalledAgain, pending, at(RESUME_LIMIT_MS))).toBe(false);
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
    expect((['initial', 'ask', 'answer', 'resume', 'steer'] as const).map(submissionKindLabel)).toEqual([
      'first run',
      'follow-up',
      'answer',
      'resume',
      'note while running',
    ]);
  });

  test('a 409 reads as the error, the phase and the hint', () => {
    expect(refusalText({ error: 'run is not resumable', phase: 'completed', hint: 'ask a follow-up with triage ask' })).toBe(
      'run is not resumable (phase completed): ask a follow-up with triage ask',
    );
    expect(refusalText({ error: 'run is blocked', hint: 'resume it first' })).toBe('run is blocked: resume it first');
    expect(refusalText({ error: 'run is not running' })).toBe('run is not running');
  });
});
