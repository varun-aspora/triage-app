// Renders report.md from a validated Report (HLD 02 §6, LLD 04 §2.9).
//
// renderReportMarkdown is pure: it reads no clock, no env and no files, so the
// same Report always gives the same text. env_label is printed as display
// text only; nothing here branches on it.
//
// Escaping. Every string in a Report can carry text from the thread or the
// model, so none of it is trusted as markdown:
// - multi-line text (commands, verify_with, reply_text) goes in a fenced
//   block whose fence is longer than any backtick run inside it, so no line
//   of the content can close the fence early;
// - single-line text has its line breaks folded into spaces and its markdown
//   punctuation backslash-escaped, so it cannot open a fence, a heading, a
//   quote, a table or raw HTML;
// - short identifiers (repos, files, commits) go in code spans sized the same
//   way as fences.

import type { Entity } from '../types/core.ts';
import type { EvidenceLadderStep, EvidenceRef } from '../types/findings.ts';
import type { SuggestedFixKind } from '../types/report.ts';
import type { Report, SuggestedFix } from './schema.ts';

/** The level-2 headings of report.md, in the order they always appear. */
export const REPORT_SECTIONS = [
  'TL;DR',
  'Customer answer',
  'Current state',
  'Timeline',
  'Findings by entity',
  'Root cause',
  'Scope',
  'Actions',
  'Suggested fixes',
  'Escalation record',
  'Evidence ladder and confidence',
  'Gaps',
  'Cost',
] as const;

export const SUGGESTED_FIX_BANNER =
  '> Triage never runs these commands. A human runs them, and only after checking the preconditions.';

export const ACTIONS_BANNER =
  '> These are recommendations only. Triage has not carried out any of them.';

export const NO_ROOT_CAUSE = 'No confirmed root cause.';

// ---------------------------------------------------------------------------
// Escaping helpers

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** Single-line text with markdown punctuation escaped. */
export function inline(text: string): string {
  return text
    .replace(/\r\n?|\n|\u2028|\u2029/g, ' ')
    .replace(/[\\`~*[\]<>#|!]/g, (c) => `\\${c}`)
    .trim();
}

/** A code span that the content cannot close early. */
export function codeSpan(text: string): string {
  const flat = text.replace(/\r\n?|\n/g, ' ');
  const ticks = '`'.repeat(longestRun(flat, '`') + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') || flat.startsWith(' ') ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/** A fenced block that no line of the content can close early. */
export function fenced(lang: string, text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

function list(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.map((item) => `- ${item}`).join('\n');
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

// ---------------------------------------------------------------------------
// Labels

const STATUS_LABELS: Record<Report['status'], string> = {
  root_cause_confirmed: 'Root cause confirmed',
  resolved: 'Resolved',
  pending_user: 'Waiting on the user',
  pending_bank: 'Waiting on the bank',
  inconclusive: 'Inconclusive',
};

const RUNG_LABELS: Record<EvidenceLadderStep, string> = {
  api: 'Admin API',
  db: 'DB',
  logs: 'Logs',
  cbs: 'CBS',
  code: 'Code',
};

const CONFIDENCE_LABELS: Record<Report['confidence'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const FENCE_LANG: Record<SuggestedFixKind, string> = {
  curl: 'bash',
  sql: 'sql',
  manual: 'text',
};

function sourceLabel(ref: EvidenceRef): string {
  const parts: string[] = [ref.source];
  const where = [ref.entity, ref.service].filter((part) => part !== undefined).join('/');
  if (where !== '') parts.push(inline(where));
  if (ref.raw_ref !== undefined) parts.push(codeSpan(ref.raw_ref));
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Sections

function header(r: Report): string {
  const lines = [
    `# Triage report ${codeSpan(r.run_id)}`,
    '',
    `- Run: ${codeSpan(r.run_id)}`,
    `- Environment: ${r.env_label.trim() === '' ? 'not set' : inline(r.env_label)}`,
    `- Generated at: ${inline(r.generated_at)}`,
    `- Requested by: ${inline(r.request.requested_by)}`,
    `- Current ask: ${r.request.current_ask.trim() === '' ? 'not stated' : inline(r.request.current_ask)}`,
  ];
  if (r.request.permalink !== undefined) lines.push(`- Thread: ${inline(r.request.permalink)}`);
  return lines.join('\n');
}

function tldr(r: Report): string {
  const statement = r.root_cause === null ? NO_ROOT_CAUSE : inline(r.root_cause.statement);
  return [
    `Status: **${STATUS_LABELS[r.status]}** (${codeSpan(r.status)})`,
    '',
    statement,
  ].join('\n');
}

function customerAnswer(r: Report): string {
  const cx = r.cx_answer;
  const lines = [
    `- Action owner: ${cx.action_owner}`,
    `- Money safe: ${cx.money_safe}`,
    `- Should retry: ${cx.should_retry}`,
    `- Escalate to: ${cx.escalate_to === undefined ? 'nobody named' : inline(cx.escalate_to)}`,
    '',
  ];
  if (cx.reply_text.trim() === '') {
    lines.push('No reply drafted.');
  } else {
    lines.push('Reply to send:', '', fenced('text', cx.reply_text));
  }
  return lines.join('\n');
}

function currentState(r: Report): string {
  const items = r.current_state.map(
    (s) =>
      `**${inline(s.item)}**: ${s.value.trim() === '' ? '(empty)' : inline(s.value)} ` +
      `(as of ${inline(s.taken_at)}, may have changed since; source: ${sourceLabel(s.source)})`,
  );
  return list(items, 'No point-in-time reads recorded.');
}

function timelineItem(t: Report['timeline'][number], withEntity: boolean): string {
  const entity = withEntity ? ` [${t.entity}]` : '';
  return `${inline(t.at)}${entity} ${inline(t.what)} (source: ${sourceLabel(t.source)})`;
}

function timeline(r: Report): string {
  return list(
    r.timeline.map((t) => timelineItem(t, true)),
    'No timeline recorded.',
  );
}

// Gaps are plain strings with no entity field, so a gap belongs to an entity
// when it names the entity id as a word ("ssfb: tunnel down").
function mentionsEntity(text: string, entity: Entity): boolean {
  return new RegExp(`(^|[^a-z0-9])${entity}([^a-z0-9]|$)`, 'i').test(text);
}

function findingsByEntity(r: Report): string {
  if (r.entities_consulted.length === 0) return 'No entity was consulted.';
  const blocks = r.entities_consulted.map((entity) => {
    const items = r.timeline.filter((t) => t.entity === entity).map((t) => timelineItem(t, false));
    const gaps = r.gaps.filter((g) => mentionsEntity(g, entity)).map(inline);
    return [
      `### ${entity}`,
      '',
      'Timeline:',
      '',
      list(items, 'No timeline items for this entity.'),
      '',
      'Gaps:',
      '',
      list(gaps, 'No gaps named for this entity.'),
    ].join('\n');
  });
  return blocks.join('\n\n');
}

function rootCause(r: Report): string {
  const lines: string[] = [];
  if (r.root_cause === null) {
    lines.push(NO_ROOT_CAUSE);
  } else {
    lines.push(inline(r.root_cause.statement));
    if (r.root_cause.matched_pattern_id !== undefined) {
      lines.push('', `Matched known pattern: ${codeSpan(r.root_cause.matched_pattern_id)}`);
    }
    const refs = r.root_cause.code_refs.map(
      (c) => `${codeSpan(c.repo)} ${codeSpan(c.file)} lines ${inline(c.lines)}`,
    );
    lines.push('', 'Code references:', '', list(refs, 'No code references.'));
  }
  const commits = r.repo_commits.map((c) => {
    const branch = c.branch === undefined ? '' : ` on branch ${codeSpan(c.branch)}`;
    return `${codeSpan(c.repo)} at ${codeSpan(c.commit)}${branch}`;
  });
  lines.push('', 'Repo commits read:', '', list(commits, 'No repos were read.'));
  return lines.join('\n');
}

function scope(r: Report): string {
  const s = r.scope;
  return [
    `- Kind: ${s.kind}`,
    `- Affected count: ${s.affected_count === undefined ? 'not counted' : formatInt(s.affected_count)}`,
    `- How measured: ${s.how_measured === undefined || s.how_measured.trim() === '' ? 'not stated' : inline(s.how_measured)}`,
  ].join('\n');
}

function actions(r: Report): string {
  const group = (title: string, items: readonly string[]) =>
    [`### ${title}`, '', list(items.map(inline), 'None.')].join('\n');
  return [
    ACTIONS_BANNER,
    '',
    group('CX (recommended)', r.actions.cx),
    '',
    group('Engineering (recommended)', r.actions.eng),
    '',
    group('Ops and bank (recommended)', r.actions.ops_bank),
  ].join('\n');
}

// verify_with is a query, a curl call, or for a manual fix a sentence.
function verifyLang(fix: SuggestedFix): string {
  if (/(?:^|[\s;|&(])curl\s/.test(fix.verify_with)) return 'bash';
  return fix.kind === 'manual' ? 'text' : 'sql';
}

function suggestedFix(fix: SuggestedFix, index: number): string {
  const lines = [
    `### ${index + 1}. ${inline(fix.title)} (${fix.kind})`,
    '',
    fenced(FENCE_LANG[fix.kind], fix.command),
    '',
    'Preconditions:',
    '',
    list(fix.preconditions.map(inline), 'None listed.'),
    '',
  ];
  if (fix.verify_with.trim() === '') {
    lines.push('Verify with: nothing given.');
  } else {
    lines.push('Verify with:', '', fenced(verifyLang(fix), fix.verify_with));
  }
  return lines.join('\n');
}

function suggestedFixes(r: Report): string {
  const fixes = r.suggested_fix.length === 0
    ? ['No suggested fixes.']
    : r.suggested_fix.map(suggestedFix);
  return [SUGGESTED_FIX_BANNER, '', ...fixes.flatMap((f, i) => (i === 0 ? [f] : ['', f]))].join('\n');
}

function escalationRecord(r: Report): string {
  const c = r.classification;
  const reasons = r.escalation_reasons.filter((reason) => reason.trim() !== '').map(inline);
  return [
    `- Escalated: ${yesNo(r.escalated)}`,
    `- Reasons:${reasons.length === 0 ? ' none' : ''}`,
    ...reasons.map((reason) => `  - ${reason}`),
    `- Final tier: ${c.tier_final}`,
    `- Rule fired: ${codeSpan(c.rule_fired)}`,
    `- Tier override by: ${c.tier_override_by === undefined ? 'nobody' : inline(c.tier_override_by)}`,
    `- Images seen: ${yesNo(r.images_seen)}`,
  ].join('\n');
}

// The team's closing lines:
//   Evidence ladder: <rung reached> (<rungs tried>)
//   Confidence: <High|Medium|Low> — <why>
function evidenceAndConfidence(r: Report): string {
  const rungs = r.evidence_ladder.map((step) => RUNG_LABELS[step]);
  const ladder = rungs.length === 0
    ? 'Evidence ladder: none (no rung recorded)'
    : `Evidence ladder: ${rungs[rungs.length - 1]} (rungs used in order: ${rungs.join(', ')})`;
  const why = r.confidence_reason.trim();
  const confidence = `Confidence: ${CONFIDENCE_LABELS[r.confidence]}${why === '' ? '' : ` — ${inline(why)}`}`;
  return `${ladder}\n\n${confidence}`;
}

function gaps(r: Report): string {
  return list(r.gaps.filter((g) => g.trim() !== '').map(inline), 'No gaps recorded.');
}

function formatInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function cost(r: Report): string {
  if (r.cost === null) {
    return 'Not costed: a model in this run has no pricing data.';
  }
  const c = r.cost;
  const lines = [
    `- Wall time: ${(c.wall_ms / 1000).toFixed(1)} s`,
    `- USD total: ${c.usd_total === undefined ? 'not known' : `$${c.usd_total.toFixed(4)}`}`,
    '',
  ];
  const models = Object.keys(c.models).sort();
  if (models.length === 0) {
    lines.push('No model calls recorded.');
  } else {
    lines.push('| Model | Calls | Input tokens | Output tokens |', '| --- | ---: | ---: | ---: |');
    for (const name of models) {
      const m = c.models[name]!;
      lines.push(
        `| ${codeSpan(name).replace(/\|/g, '\\|')} | ${formatInt(m.calls)} | ${formatInt(m.input_tokens)} | ${formatInt(m.output_tokens)} |`,
      );
    }
  }
  return lines.join('\n');
}

const SECTION_BODIES: Record<(typeof REPORT_SECTIONS)[number], (r: Report) => string> = {
  'TL;DR': tldr,
  'Customer answer': customerAnswer,
  'Current state': currentState,
  Timeline: timeline,
  'Findings by entity': findingsByEntity,
  'Root cause': rootCause,
  Scope: scope,
  Actions: actions,
  'Suggested fixes': suggestedFixes,
  'Escalation record': escalationRecord,
  'Evidence ladder and confidence': evidenceAndConfidence,
  Gaps: gaps,
  Cost: cost,
};

/** Renders report.md. Pure and deterministic. */
export function renderReportMarkdown(report: Report): string {
  const parts = [header(report)];
  for (const title of REPORT_SECTIONS) {
    parts.push(`## ${title}\n\n${SECTION_BODIES[title](report)}`);
  }
  return `${parts.join('\n\n')}\n`;
}
