// The Slack message for a finished report, and the choice of who is tagged to
// review it (LLD 04 §2.9, HLD 02 §6, D13, D41). Both functions are pure: no
// clock, no env reads and no I/O. The caller (slack-post, T08.7) resolves the
// reviewer from config, runs the egress check over the returned text and posts
// it only after approval.
//
// The message never carries suggested_fix command text. Commands stay in
// report.md, where a human reads them next to their preconditions.
import type { Report } from './schema.ts';

// ---------------------------------------------------------------------------
// Reviewer choice

export type ReviewerTag = { kind: 'user'; id: string } | { kind: 'group'; handle: string };

export type PickReviewerInput = {
  // The configured reviewer, already looked up in Slack (SLACK_REVIEWER_EMAIL).
  reviewer?: { id: string; active: boolean };
  // The Slack user id of the person approving the post.
  approverSlackId?: string;
  // The Slack user id of the person who asked for the triage.
  requesterSlackId?: string;
  // SLACK_FALLBACK_GROUP_HANDLE: @handle or <!subteam^ID> / <!subteam^ID|@handle>.
  fallbackHandle: string;
};

// Slack user ids are upper-case letters and digits (U0123ABCD, W0123ABCD).
const SLACK_USER_ID = /^[A-Z0-9]{2,32}$/;
const GROUP_HANDLE = /^@?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SUBTEAM_MENTION = /^<!subteam\^[A-Z0-9]{2,32}(?:\|@?[A-Za-z0-9._-]{1,80})?>$/;

function sameUser(a: string, b: string | undefined): boolean {
  return b !== undefined && b.trim() !== '' && a === b.trim();
}

/**
 * Picks who is tagged at the top of the Slack message. The configured
 * reviewer is tagged unless they are blank, not a valid Slack user id,
 * inactive, the approver or the requester; then the fallback group is.
 * Someone must not validate their own request or their own approval.
 *
 * Throws when the fallback handle is blank or not a Slack group handle,
 * because then nobody could be tagged.
 */
export function pickReviewer(input: PickReviewerInput): ReviewerTag {
  const handle = input.fallbackHandle.trim();
  if (!GROUP_HANDLE.test(handle) && !SUBTEAM_MENTION.test(handle)) {
    throw new Error('SLACK_FALLBACK_GROUP_HANDLE must be a Slack group handle (@name or <!subteam^ID>)');
  }
  const group: ReviewerTag = { kind: 'group', handle };
  const reviewer = input.reviewer;
  if (reviewer === undefined) return group;
  const id = reviewer.id.trim();
  if (!SLACK_USER_ID.test(id)) return group;
  if (!reviewer.active) return group;
  if (sameUser(id, input.approverSlackId)) return group;
  if (sameUser(id, input.requesterSlackId)) return group;
  return { kind: 'user', id };
}

export function renderReviewerTag(tag: ReviewerTag): string {
  if (tag.kind === 'user') return `<@${tag.id}>`;
  if (tag.handle.startsWith('<')) return tag.handle;
  return tag.handle.startsWith('@') ? tag.handle : `@${tag.handle}`;
}

// ---------------------------------------------------------------------------
// Text helpers

export const DISCLAIMER =
  'please validate this before acting on it. It was written by an automated triage run and may be wrong.';
export const MIN_BULLETS = 2;
export const MAX_BULLETS = 5;

const BULLET = '• ';
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Commands shorter than this are not searched for in free text, so a short
// manual step does not blank out unrelated words.
const MIN_COMMAND_LENGTH = 8;

const STATUS_LABELS: Record<Report['status'], string> = {
  root_cause_confirmed: 'Root cause confirmed',
  resolved: 'Resolved',
  pending_user: 'Waiting on the user',
  pending_bank: 'Waiting on the bank',
  inconclusive: 'Inconclusive',
};

// Slack mrkdwn needs &, < and > escaped, which also stops model text from
// writing <!channel> or <@U...> mentions. Backticks become quotes so free text
// cannot open a code block or break the id code spans.
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, "'");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type TextContext = {
  // suggested_fix commands and verify_with texts, never shown in Slack.
  commands: string[];
  // Known ids from the report, rendered as inline code.
  ids: string[];
};

function buildContext(report: Report): TextContext {
  const commands = new Set<string>();
  for (const fix of report.suggested_fix) {
    for (const text of [fix.command, fix.verify_with]) {
      // Both forms, because bullet and action text is collapsed to one line.
      for (const form of [text.trim(), oneLine(text)]) {
        if (form.length >= MIN_COMMAND_LENGTH) commands.add(form);
      }
    }
  }
  const ids = new Set<string>([report.run_id]);
  for (const value of Object.values(report.id_chain.ids)) {
    if (typeof value === 'string' && value.trim().length >= 6) ids.add(value.trim());
  }
  // Longest first, so a command that contains another is removed whole.
  const byLength = (a: string, b: string) => b.length - a.length;
  return { commands: [...commands].sort(byLength), ids: [...ids].sort(byLength) };
}

// Model text, cleaned for Slack: commands removed, mrkdwn escaped, ids as code.
function render(text: string, ctx: TextContext): string {
  let out = text;
  for (const command of ctx.commands) {
    out = out.split(command).join('(command in report.md)');
  }
  out = escapeText(out);
  const idPatterns = ctx.ids.map((id) => escapeRegExp(escapeText(id)));
  const idRegex = idPatterns.length > 0 ? new RegExp(`${idPatterns.join('|')}|${UUID.source}`, 'gi') : UUID;
  return out.replace(idRegex, (id) => `\`${id}\``);
}

function formatAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// ---------------------------------------------------------------------------
// Bullets

function scopeLine(scope: Report['scope'], ctx: TextContext): string | null {
  if (scope.kind === 'unknown' && scope.affected_count === undefined) return null;
  let line = `*Scope:* ${scope.kind}`;
  if (scope.affected_count !== undefined) line += `, ${scope.affected_count} affected`;
  if (scope.how_measured !== undefined && scope.how_measured.trim() !== '') {
    line += ` (${render(oneLine(scope.how_measured), ctx)})`;
  }
  return line;
}

/**
 * The 2 to 5 bullets under the TL;DR. The scope line is kept when it is
 * known; the remaining slots are split between current state (first items)
 * and timeline (latest events, in order). When there are fewer than two
 * candidates, fixed filler lines pad the list.
 */
export function pickBullets(report: Report): string[] {
  return bulletsFor(report, buildContext(report));
}

function bulletsFor(report: Report, ctx: TextContext): string[] {
  const scope = scopeLine(report.scope, ctx);
  const slots = MAX_BULLETS - (scope === null ? 0 : 1);
  const state = report.current_state;
  const timeline = report.timeline;

  let stateTake = Math.min(state.length, Math.ceil(slots / 2));
  const timelineTake = Math.min(timeline.length, slots - stateTake);
  stateTake = Math.min(state.length, slots - timelineTake);

  const bullets: string[] = [];
  for (const item of state.slice(0, stateTake)) {
    bullets.push(
      `*${render(oneLine(item.item), ctx)}:* ${render(oneLine(item.value), ctx)} (as of ${formatAt(item.taken_at)})`,
    );
  }
  for (const event of timeline.slice(timeline.length - timelineTake)) {
    bullets.push(`${formatAt(event.at)}, ${event.entity}: ${render(oneLine(event.what), ctx)}`);
  }
  if (scope !== null) bullets.push(scope);

  const fillers = [
    ...(scope === null ? ['*Scope:* not measured'] : []),
    'Nothing else was recorded; the gaps are listed in report.md',
  ];
  for (const filler of fillers) {
    if (bullets.length >= MIN_BULLETS) break;
    bullets.push(filler);
  }
  return bullets.slice(0, MAX_BULLETS);
}

// ---------------------------------------------------------------------------
// Message

function tldr(report: Report, ctx: TextContext): string {
  const parts = [`${STATUS_LABELS[report.status]}.`];
  if (report.root_cause !== null) parts.push(render(oneLine(report.root_cause.statement), ctx));
  else parts.push('No root cause was confirmed.');
  parts.push(`Confidence: ${report.confidence}.`);
  return parts.join(' ');
}

function quote(text: string, ctx: TextContext): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return ['_No customer reply was drafted._'];
  return lines.map((line) => `> ${render(line, ctx)}`);
}

function actionLines(actions: Report['actions'], ctx: TextContext): string[] {
  const groups: [string, string[]][] = [
    ['CX', actions.cx],
    ['Eng', actions.eng],
    ['Ops/bank', actions.ops_bank],
  ];
  const lines: string[] = [];
  for (const [label, items] of groups) {
    const kept = items.map(oneLine).filter((item) => item !== '');
    if (kept.length === 0) continue;
    lines.push(`_${label}_`);
    for (const item of kept) lines.push(`${BULLET}${render(item, ctx)}`);
  }
  if (lines.length === 0) lines.push('None recorded.');
  return lines;
}

function fixPointer(count: number): string {
  if (count === 0) return 'No suggested fixes. The full report is in report.md.';
  const noun = count === 1 ? 'fix is' : 'fixes are';
  return `${count} suggested ${noun} in report.md with their preconditions. Commands are not posted in Slack.`;
}

/**
 * Formats a report as Slack mrkdwn, in this order: reviewer tag with the
 * validate-before-acting disclaimer, the Triage report line (run_id and
 * env_label), TL;DR, 2 to 5 bullets, the customer reply, recommended actions
 * and a pointer to the suggested fixes in report.md.
 */
export function formatSlackReport(report: Report, reviewerTag: ReviewerTag): string {
  const ctx = buildContext(report);
  const lines = [
    `${renderReviewerTag(reviewerTag)} ${DISCLAIMER}`,
    `*Triage report* \`${report.run_id}\` · ${escapeText(oneLine(report.env_label))}`,
    '',
    `*TL;DR:* ${tldr(report, ctx)}`,
    ...bulletsFor(report, ctx).map((bullet) => `${BULLET}${bullet}`),
    '',
    '*Reply for the customer*',
    ...quote(report.cx_answer.reply_text, ctx),
    '',
    '*Recommended actions* (recommendations only; nothing has been run)',
    ...actionLines(report.actions, ctx),
    '',
    fixPointer(report.suggested_fix.length),
  ];
  return lines.join('\n');
}
