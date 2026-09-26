// A run's open question at the terminal, and the answer on its way back
// (P6 §4.4, §4.5). Shared by `triage wait`, `triage run` and `triage input`.
// The block a run is parked on (D55), the question's sibling, is rendered
// here too, for `triage status`, `triage wait` and `triage run`.
//
// The question and block records are presentation-neutral; this file is the
// CLI's rendering of them. Answering from the terminal spawns the same
// detached worker `triage ask` uses, with an answer payload, and records its
// pid so a `triage wait` right after does not call the run stalled.
import type { WorkerPayload } from '../../ingress/worker-payload.ts';
import type { RunStore } from '../../runstore/types.ts';
import type { BlockRecord } from '../../types/block.ts';
import type { KnownIds } from '../../types/core.ts';
import type { InputRequest } from '../../types/input-request.ts';
import type { LineReader } from './prompt.ts';

/** Typed at the prompt to skip the question. */
export const SKIP_WORD = 's';

/** The question as the terminal shows it. */
export function questionLines(runId: string, request: InputRequest): string[] {
  const lines = [`run ${runId} needs an answer before it can go on (question ${request.question_id}):`, '', `  ${request.question}`];
  if (request.why.trim() !== '') lines.push(`  (${request.why})`);
  if (request.options.length > 0) {
    lines.push('', '  options:');
    request.options.forEach((option, i) => lines.push(`    ${i + 1}. ${option}`));
    if (request.free_text) lines.push('  or an answer of your own');
  }
  return lines;
}

/** How to answer from another shell. */
export function answerHint(runId: string): string[] {
  return [`answer with: triage input ${runId} "<answer>"`, `skip with:   triage input ${runId} --skip`];
}

export type TerminalAnswer = { readonly kind: 'answer'; readonly answer: string } | { readonly kind: 'skip' };

/**
 * Shows the question and reads the answer. A number picks an option, 's'
 * skips, anything else is the answer; a blank line asks again. Resolves
 * null on EOF, so the caller can print how to answer later.
 */
export async function askAtTerminal(
  write: (text: string) => void,
  runId: string,
  request: InputRequest,
  read: LineReader,
): Promise<TerminalAnswer | null> {
  for (const line of questionLines(runId, request)) write(`${line}\n`);
  for (;;) {
    const raw = await read(`\nyour answer (${SKIP_WORD} to skip): `);
    if (raw === null) return null;
    const text = raw.trim();
    if (text === '') continue;
    if (text.toLowerCase() === SKIP_WORD) return { kind: 'skip' };
    const n = /^[1-9][0-9]*$/.test(text) ? Number(text) : 0;
    if (n >= 1 && n <= request.options.length) return { kind: 'answer', answer: request.options[n - 1] as string };
    if (request.options.length > 0 && !request.free_text) {
      write(`pick one of the options by number, or ${SKIP_WORD} to skip\n`);
      continue;
    }
    return { kind: 'answer', answer: text };
  }
}

export type AnswerStartInput = {
  readonly runId: string;
  readonly questionId: string;
  /** Submissions the run has now; the answer becomes the next one. */
  readonly submissions: number;
  readonly answer: TerminalAnswer;
  readonly ids?: Partial<KnownIds>;
  readonly by: string;
};

export type AnswerStart = {
  readonly run_id: string;
  readonly question_id: string;
  readonly submission_id: number;
  readonly skipped: boolean;
  readonly pid: number;
};

/** Starts the detached worker with the answer payload and records its pid on the run. */
export async function startAnswer(
  store: Pick<RunStore, 'setPhase'>,
  spawn: (payload: WorkerPayload) => Promise<{ pid: number }>,
  input: AnswerStartInput,
): Promise<AnswerStart> {
  const skipped = input.answer.kind === 'skip';
  const ids = input.ids !== undefined && Object.keys(input.ids).length > 0 ? { ids: input.ids } : {};
  const payload: WorkerPayload = {
    kind: 'answer',
    run_id: input.runId,
    question_id: input.questionId,
    by: input.by,
    ...(skipped ? { skip: true as const } : { answer: input.answer.answer }),
    ...ids,
  };
  const { pid } = await spawn(payload);
  // The worker writes the same phase and pid; the order of the two writes does not matter.
  await store.setPhase(input.runId, 'dispatched', { worker_pid: pid });
  return {
    run_id: input.runId,
    question_id: input.questionId,
    submission_id: input.submissions + 1,
    skipped,
    pid,
  };
}

// ------------------------------------------------------------------ blocks (D55)

/** The block as the terminal shows it: the systems, the reason, each recorded failure and since when. */
export function blockLines(runId: string, block: BlockRecord): string[] {
  const lines = [`run ${runId} is blocked (${block.block_id}): ${listed(block.systems)} did not answer`, '', `  ${block.reason}`];
  if (block.failures.length > 0) {
    lines.push('', '  recorded failures:');
    for (const f of block.failures) lines.push(`    ${f.at}  ${f.system}  ${f.tool}: ${f.code}`);
  }
  lines.push('', `  blocked since ${block.blocked_at}`);
  return lines;
}

/** How to send the run on once the system answers again. */
export function resumeHint(runId: string): string[] {
  return [`resume with: triage resume ${runId} ["<what was fixed, and anything new to consider>"]`];
}

/** A copy of the block for output, so a printer never hands out the store's record. */
export function copyBlock(block: BlockRecord): BlockRecord {
  return { ...block, systems: [...block.systems], failures: block.failures.map((f) => ({ ...f })) };
}

// "a", "a and b", "a, b and c".
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
