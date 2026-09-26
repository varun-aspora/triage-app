// The text of the first message the Triage orchestrator receives, of a
// `triage ask` follow-up, of the answer to a question the run asked, and of
// the signal that sends a blocked, failed or stopped run on again
// (LLD 04 §2.4, D24, P6 §4.3, D55).
//
// All of them are built from the in-memory request and then passed through
// the model-facing redaction profile as a whole: PAN, card numbers,
// passports, secrets and email local parts are masked, while account
// numbers, UTRs, phones, UUIDs and names stay visible because the
// investigation searches with them. The persisted-profile copy of the
// request travels separately, in initialData.
import { redactModelFacing } from '../gate/redact.ts';
import type { BlockRecord } from '../types/block.ts';
import { KNOWN_ID_KEYS, type KnownIds } from '../types/core.ts';
import type { InputRequest } from '../types/input-request.ts';
import type { TriageRequest } from '../types/request.ts';

/** What happened to the request's screenshots on the way to the dispatch. */
export type RenderImages = {
  /** Images sent with the message as image parts. */
  readonly attached: number;
  /** Images left out, with the reason given to the model. */
  readonly dropped: number;
  readonly dropReason?: string;
};

const SOURCE_LABEL: Readonly<Record<TriageRequest['source']['kind'], string>> = {
  slack: 'a Slack thread',
  thread_file: 'a thread file',
  text: 'free text',
  json: 'a JSON request',
};

/** The orchestrator's first message: the whole thread, parent first, model-facing profile. */
export function renderThread(request: TriageRequest, images: RenderImages = { attached: 0, dropped: 0 }): string {
  const lines: string[] = [
    `New triage request from ${SOURCE_LABEL[request.source.kind]}, raised by ${request.requested_by}.`,
    `Investigation window: ${request.window.from} to ${request.window.to}.`,
    `Thread (${request.messages.length} message${request.messages.length === 1 ? '' : 's'}, parent first):`,
  ];
  for (const m of request.messages) {
    const author = m.author.trim() === '' ? 'unknown author' : m.author;
    lines.push('', `--- ${m.is_parent ? 'parent' : 'reply'} · ${m.ts} · ${author}`, m.text);
  }
  const imageLines = imageNote(images);
  if (imageLines.length > 0) lines.push('', ...imageLines);
  return redactModelFacing(lines.join('\n'));
}

/** A follow-up question on an existing run, model-facing profile. */
export function renderAsk(question: string, by: string): string {
  return redactModelFacing(
    [
      `Follow-up question from ${by} on this run:`,
      question,
      '',
      'Answer it from the evidence you have, investigate further if needed, and call finish_report with the updated report.',
    ].join('\n'),
  );
}

export type AnswerRender = {
  readonly skip: boolean;
  /** Empty with skip. */
  readonly answer: string;
  readonly by: string;
  /** Ids the person gave, after the ingress identity step. */
  readonly ids: Partial<KnownIds>;
  /** Identity gaps, such as an unreachable database. */
  readonly gaps: readonly string[];
};

/** The answer to a question the run asked, or the skip, model-facing profile. */
export function renderAnswer(request: Pick<InputRequest, 'question_id' | 'question'>, a: AnswerRender): string {
  const lines: string[] = [];
  if (a.skip) {
    lines.push(
      `${a.by} skipped your question ${request.question_id} (${quoted(request.question)}).`,
      '',
      'Continue without it: finish with what you have and list the open question under gaps.',
    );
  } else {
    lines.push(`Answer from ${a.by} to your question ${request.question_id} (${quoted(request.question)}):`, a.answer);
  }
  const ids = KNOWN_ID_KEYS.flatMap((key) => (a.ids[key] === undefined ? [] : [`${key} = ${a.ids[key]}`]));
  if (ids.length > 0) lines.push('', `Ids they gave, resolved by the identity step and in scope: ${ids.join(', ')}.`);
  if (a.gaps.length > 0) lines.push('', `Identity lookups: ${a.gaps.join('; ')}.`);
  if (!a.skip) lines.push('', 'Continue the triage with this. Investigate further if needed and call finish_report with the report.');
  return redactModelFacing(lines.join('\n'));
}

// The stored question, on one line and short enough to quote back.
function quoted(question: string): string {
  const flat = oneLine(question);
  return `"${flat.length > 120 ? `${flat.slice(0, 120)}…` : flat}"`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** What the run was doing when it stopped, for the resume signal. */
export type ResumeFrom =
  /** Parked by stop_blocked; the block names the systems. */
  | { readonly kind: 'blocked'; readonly block: Pick<BlockRecord, 'block_id' | 'systems' | 'reason'> }
  /** Failed after it was dispatched; the reason is the stored phase reason (class name and masked error text, D67). */
  | { readonly kind: 'failed'; readonly reason?: string }
  /** Stopped by a person. */
  | { readonly kind: 'stopped' };

export type ResumeRender = {
  /** Who resumed the run. */
  readonly by: string;
  /** When, ISO 8601. */
  readonly at: string;
  /** The person's message: what was fixed, and anything new the run should take into account. Empty for none. May span lines. */
  readonly note: string;
};

const CONTINUE_LINE =
  'Continue from what you already found: the evidence you noted stands, so do not repeat lookups that answered.';

/** The signal that sends a blocked, failed or stopped run on (D55), model-facing profile. */
export function renderResume(from: ResumeFrom, r: ResumeRender): string {
  const lines: string[] = [];
  if (from.kind === 'blocked') {
    lines.push(`This run was blocked (${from.block.block_id}) because ${listed(from.block.systems)} did not answer: ${oneLine(from.block.reason)}`);
  } else if (from.kind === 'failed') {
    lines.push(`This run failed${from.reason !== undefined ? ` (${from.reason})` : ''} before it finished.`);
  } else {
    lines.push('This run was stopped before it finished.');
  }
  lines.push(`${r.by} resumed it at ${r.at}.`);
  const message = r.note.trim();
  if (message !== '') lines.push('', `Message from ${r.by}:`, message);
  lines.push('');
  if (message !== '') lines.push('Take the message into account: it may change what to check next.');
  if (from.kind === 'blocked') {
    lines.push(
      `${listed(from.block.systems)} ${from.block.systems.length === 1 ? 'is' : 'are'} expected to answer now.`,
      CONTINUE_LINE,
      'Check what was blocked, then call finish_report with the report. If a system still does not answer and you cannot go on without it, call stop_blocked again.',
    );
  } else {
    lines.push(
      CONTINUE_LINE,
      'Finish the investigation and call finish_report with the report. If a system does not answer and you cannot go on without it, call stop_blocked.',
    );
  }
  return redactModelFacing(lines.join('\n'));
}

// "a", "a and b", "a, b and c".
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function imageNote(images: RenderImages): string[] {
  const out: string[] = [];
  if (images.attached > 0) {
    out.push(`${images.attached} screenshot${images.attached === 1 ? ' from the thread is' : 's from the thread are'} attached to this message.`);
  }
  if (images.dropped > 0) {
    const reason = images.dropReason ?? 'they could not be sent';
    out.push(
      `${images.dropped} screenshot${images.dropped === 1 ? ' was' : 's were'} left out: ${reason}. Say in the report that screenshots were not analysed.`,
    );
  }
  return out;
}
