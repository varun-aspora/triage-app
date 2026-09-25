// Pure helpers for a run blocked on a system that did not answer (D55) and
// the Resume form, kept apart from the components so bun can test them
// without a DOM.

import type { ApiErrorBody, BlockRecord, ConnectorFailure, ResolvedBlock, ResumeBody, RunDetail, SubmissionView } from '../../api/types.ts';

/** The server's limit on the note (MAX_RESUME_NOTE_CHARS in src/types/block.ts; block-logic.test.ts pins it). */
export const MAX_RESUME_NOTE = 4000;

export type ResumeForm = { name: string; note: string };

export type ResumeBodyResult = { ok: true; body: ResumeBody } | { ok: false; error: string };

/** The POST /triage/:run_id/resume body. A blank note is left out. */
export function buildResumeBody(form: ResumeForm): ResumeBodyResult {
  const name = form.name.trim();
  if (name === '') return { ok: false, error: 'Enter your name.' };
  const note = form.note.trim();
  if (note.length > MAX_RESUME_NOTE) return { ok: false, error: `Keep the note under ${MAX_RESUME_NOTE} characters.` };
  return { ok: true, body: { requested_by: name, ...(note !== '' ? { note } : {}) } };
}

/** The state a resume continues from. */
export type ResumeFrom = 'blocked' | 'failed' | 'stopped';

/**
 * Resume continues the run's own conversation, so it needs one: a blocked
 * run, or one that failed or was stopped after at least one submission was
 * sent. Null when the run cannot be resumed. Mirrors resumeRefusal in
 * src/ingress/submit.ts; the server still has the last word (409).
 */
export function resumeFrom(run: Pick<RunDetail, 'status' | 'submissions'>): ResumeFrom | null {
  if (run.status === 'blocked') return 'blocked';
  if ((run.status === 'failed' || run.status === 'stopped') && run.submissions.length > 0) return run.status;
  return null;
}

export function canResume(run: Pick<RunDetail, 'status' | 'submissions'>): boolean {
  return resumeFrom(run) !== null;
}

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
  }
}

/** A 409 from ask or resume: the server's error, the run's phase and its hint. All fixed texts, no values. */
export function refusalText(body: Pick<ApiErrorBody, 'error' | 'phase' | 'hint'>): string {
  const phase = body.phase !== undefined ? ` (phase ${body.phase})` : '';
  const hint = body.hint !== undefined && body.hint !== '' ? `: ${body.hint}` : '';
  return `${body.error}${phase}${hint}`;
}
