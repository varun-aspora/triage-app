// The text of the first message the Triage orchestrator receives, and of a
// `triage ask` follow-up (LLD 04 §2.4, D24).
//
// Both are built from the in-memory request and then passed through the
// model-facing redaction profile as a whole: PAN, card numbers, passports,
// secrets and email local parts are masked, while account numbers, UTRs,
// phones, UUIDs and names stay visible because the investigation searches
// with them. The persisted-profile copy of the request travels separately,
// in initialData.
import { redactModelFacing } from '../gate/redact.ts';
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
