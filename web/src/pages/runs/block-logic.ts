// Pure helpers for a run blocked on a system that did not answer (D55) and
// the Resume form, kept apart from the components so bun can test them
// without a DOM. The same form sends a note to a running run, or resumes a
// stalled one (D72).

import type {
  ApiErrorBody,
  BlockRecord,
  ConnectorFailure,
  ResolvedBlock,
  ResumeBody,
  ResumeResponse,
  RunDetail,
  SubmissionView,
} from '../../api/types.ts';

/** The server's limit on the note (MAX_RESUME_NOTE_CHARS in src/types/block.ts; block-logic.test.ts pins it). */
export const MAX_RESUME_NOTE = 4000;

export type ResumeForm = { name: string; note: string };

export type ResumeBodyResult = { ok: true; body: ResumeBody } | { ok: false; error: string };

/**
 * The POST /triage/:run_id/resume body. A blank note is left out, except for
 * a note to a running run, which is nothing without one.
 */
export function buildResumeBody(form: ResumeForm, from?: ResumeFrom): ResumeBodyResult {
  const name = form.name.trim();
  if (name === '') return { ok: false, error: 'Enter your name.' };
  const note = form.note.trim();
  if (note === '' && from === 'running') return { ok: false, error: 'Write a note first.' };
  if (note.length > MAX_RESUME_NOTE) return { ok: false, error: `Keep the note under ${MAX_RESUME_NOTE} characters.` };
  return { ok: true, body: { requested_by: name, ...(note !== '' ? { note } : {}) } };
}

/**
 * The state a resume continues from. running: the note joins the live
 * investigation (a steer, D72). stalled: the server stops the current attempt
 * first, then resumes (D71, D72).
 */
export type ResumeFrom = 'blocked' | 'failed' | 'stopped' | 'running' | 'stalled';

/** The phases with a live Flue submission a note can join; the only ones that can stall (STALLABLE_PHASES in src/ingress/stalled.ts). */
export const STEERABLE_PHASES: readonly RunDetail['phase'][] = ['dispatched', 'investigating'];

type ResumableRun = Pick<RunDetail, 'status' | 'submissions'> & Partial<Pick<RunDetail, 'phase' | 'stalled'>>;

/**
 * Resume continues the run's own conversation, so it needs one: a blocked
 * run, one that failed or was stopped after at least one submission was
 * sent, or one still investigating (stalled or not). Null when the run
 * cannot be resumed: a run still before its first dispatch, one waiting on
 * an answer (needs_input) and a completed one keep their own actions.
 * Mirrors resumeRefusal in src/ingress/submit.ts; the server still has the
 * last word (409).
 */
export function resumeFrom(run: ResumableRun): ResumeFrom | null {
  if (run.status === 'blocked') return 'blocked';
  if (run.submissions.length === 0) return null;
  if (run.status === 'failed' || run.status === 'stopped') return run.status;
  if (run.status === 'running' && run.phase !== undefined && STEERABLE_PHASES.includes(run.phase)) {
    return run.stalled !== undefined ? 'stalled' : 'running';
  }
  return null;
}

export function canResume(run: ResumableRun): boolean {
  return resumeFrom(run) !== null;
}

export type ResumeLabels = {
  /** The panel title. */
  title: string;
  /** The line under the title. */
  description: string;
  button: string;
  /** The label of the name field. */
  by: string;
  /** The hint under the message field. */
  noteHint: string;
  notePlaceholder: string;
};

const RESUME_NOTE_HINT = 'What was fixed, and anything new the run should take into account. The model reads it and it stays with the run.';
const RESUME_PLACEHOLDER = 'e.g. the database is back after the failover';

/** The Resume form's words for each state it continues from. */
export function resumeLabels(from: ResumeFrom): ResumeLabels {
  const resume = { title: 'Resume the run', button: 'Resume', by: 'Resumed by', noteHint: RESUME_NOTE_HINT, notePlaceholder: RESUME_PLACEHOLDER };
  switch (from) {
    case 'blocked':
      return {
        ...resume,
        description:
          'Once the system answers again, resume the run. It carries on from what it already found and ends with a report, or blocks again if a system still does not answer.',
      };
    case 'failed':
      return { ...resume, description: 'The run had started investigating, so once the cause is fixed it can carry on from what it found.' };
    case 'stopped':
      return { ...resume, description: 'Resume carries on from what the run found. A follow-up asks it something new instead.' };
    case 'stalled':
      return {
        ...resume,
        title: 'Resume this run',
        description: 'Resume stops the current attempt and continues with your note, from what the run found so far.',
        noteHint: 'Anything the run should take into account when it carries on. The model reads it and it stays with the run.',
      };
    case 'running':
      return {
        title: 'Send a note to the running investigation',
        description: 'It reaches the agent at its next step; the run keeps going.',
        button: 'Send note',
        by: 'Sent by',
        noteHint: 'Something the investigation should know or check. The model reads it and it stays with the run.',
        notePlaceholder: 'e.g. the customer says the transfer left their account at 10:40',
      };
  }
}

/**
 * The confirmation after the server took the note. mode is absent from a
 * server older than D72, which only ever resumes.
 */
export function resumedText(mode: ResumeResponse['mode']): string {
  return mode === 'steer'
    ? 'Note sent. The agent reads it at its next step; this page checks every few seconds.'
    : 'Resumed. The run carries on from what it found; this page checks every few seconds.';
}

// ------------------------------------------------------------------ stalled resume (D72)

/** The phase reason of a run a resume stopped because it had stalled (STALLED_STOP_REASON in src/ingress/submit.ts). */
export const STALLED_STOP_REASON = 'stalled';

/** How long the page waits for a stalled run's resume to send its submission. The server waits up to 30 s for the abort. */
export const RESUME_START_LIMIT_MS = 2 * 60_000;

/** How long the page shows a stalled run's resume in all. */
export const RESUME_LIMIT_MS = 15 * 60_000;

/** A stalled run's resume the page waits on: the last submission before it, and when it was sent. */
export type PendingResume = { afterSeq: number; startedAt: number };

/**
 * The server took the resume of a stalled run (D72). It answers at once, with
 * submission_id null, and stops, aborts and resumes the run in the background.
 * A note sent to a working run can land there too, when the server found it
 * stalled first; a steer is the only other answer.
 */
export function startsResuming(from: ResumeFrom, res: Pick<ResumeResponse, 'mode'>): boolean {
  return (from === 'stalled' || from === 'running') && res.mode === 'resume';
}

type ResumingRun = Pick<RunDetail, 'status' | 'phase' | 'submissions'> & Partial<Pick<RunDetail, 'phase_reason' | 'stalled'>>;

/**
 * Whether the page still shows a stalled run's resume as in flight. It is,
 * while the run is stopped for it (reason stalled), and while the run is still
 * running on the old attempt or stalled again. It ends once the run runs
 * again and is not stalled, waits on an answer, or ends, and at the limits:
 * RESUME_START_LIMIT_MS without a new submission, RESUME_LIMIT_MS in all. A
 * run that settled before the stop is resumed from where it settled, so a
 * failed, blocked or stopped one without a new submission is still in flight;
 * a completed one is not (the server refuses it).
 */
export function resumePending(run: ResumingRun, pending: PendingResume, now: number): boolean {
  const elapsed = now - pending.startedAt;
  if (elapsed >= RESUME_LIMIT_MS) return false;
  const resumed = run.submissions.some((s) => s.seq > pending.afterSeq);
  if (!resumed && elapsed >= RESUME_START_LIMIT_MS) return false;
  if (run.status === 'stopped' && run.phase_reason === STALLED_STOP_REASON) return true;
  if (run.status === 'running') {
    if (run.phase === 'needs_input') return false;
    return !resumed || run.stalled !== undefined;
  }
  return !resumed && run.status !== 'completed';
}

/** The Notice while a stalled run's resume is in flight. */
export const RESUMING_TEXT =
  'The current attempt is being stopped, then the run carries on from what it found with your note. This can take up to a minute; this page checks every few seconds.';

/** The open block, or null. Tolerates a server that does not send the field. */
export function openBlock(run: Partial<Pick<RunDetail, 'block'>>): BlockRecord | null {
  return run.block ?? null;
}

/** The closed blocks, oldest first. Tolerates a server that does not send the field. */
export function blockHistory(run: Partial<Pick<RunDetail, 'block_history'>>): readonly ResolvedBlock[] {
  return run.block_history ?? [];
}

/**
 * The block to show for a blocked run: the open one, or the last closed one
 * when the run is still in phase blocked after its block was closed (a crash
 * between closing it and sending the run on). Resume works on both.
 */
export function shownBlock(run: Partial<Pick<RunDetail, 'block' | 'block_history'>>): BlockRecord | null {
  return run.block ?? run.block_history?.at(-1) ?? null;
}

export type SystemFailures = { system: string; failures: ConnectorFailure[] };

/** The block's systems in their order, each with the failures recorded for it, oldest first. A system with none still appears. */
export function groupFailures(block: Pick<BlockRecord, 'systems' | 'failures'>): SystemFailures[] {
  return block.systems.map((system) => ({ system, failures: block.failures.filter((f) => f.system === system) }));
}

/** How a connector failure code reads. */
export function failureCodeLabel(code: ConnectorFailure['code']): string {
  switch (code) {
    case 'unreachable':
      return 'unreachable';
    case 'timeout':
      return 'timed out';
    case 'error':
      return 'errored';
  }
}

/** 'resumed by Asha', or 'cancelled by Asha' when the run was stopped while blocked. */
export function resolutionLabel(block: Pick<ResolvedBlock, 'status' | 'resolved_by'>): string {
  return `${block.status} by ${block.resolved_by}`;
}

/** How a submission's kind reads in the Request tab. */
export function submissionKindLabel(kind: SubmissionView['kind']): string {
  switch (kind) {
    case 'initial':
      return 'first run';
    case 'ask':
      return 'follow-up';
    case 'answer':
      return 'answer';
    case 'resume':
      return 'resume';
    case 'steer':
      return 'note while running';
  }
}

/** A 409 from ask or resume: the server's error, the run's phase and its hint. All fixed texts, no values. */
export function refusalText(body: Pick<ApiErrorBody, 'error' | 'phase' | 'hint'>): string {
  const phase = body.phase !== undefined ? ` (phase ${body.phase})` : '';
  const hint = body.hint !== undefined && body.hint !== '' ? `: ${body.hint}` : '';
  return `${body.error}${phase}${hint}`;
}
