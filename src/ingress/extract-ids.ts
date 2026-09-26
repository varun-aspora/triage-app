// The label fallback of the identity step (D69), and the hints on top.
// Pure: it reads only the request and the fields from resources/known-ids.json.
//
// identity.ts uses it when the id decision (./id-decision.ts) cannot run:
// MODEL_DECISION is unset or not a decision spec, or decide() failed.
//
// Template fields, one per line, as '<label>: <value>' or '<label> = <value>'.
// Every label comes from a field's `labels` in the file, matched
// case-insensitively, with spaces, underscores or hyphens (or nothing)
// between words. Longer labels are tried first, so 'aspora user id' is not
// read as 'user id'. Slack bold and strike markers, quote markers, bullets
// and italic underscores around a label are allowed. A label with an empty
// value takes the next line (Slack block fields), unless that line is itself
// a label. The first value seen for a key wins; the parent message is read
// first.
// - A value field takes the first match of its pattern in the value,
//   normalised by its rule ('Phone: +971 50 123 4567' -> +971501234567).
// - A choice field maps the value through its options' aliases (whole words,
//   any case) to the option key ('Country: UK' -> GB).
// A value with no match is skipped. An id with no label is not guessed into
// any key.
//
// hints.ids from the caller win over the text for the same key.
//
// Nothing is invented: every value returned is text from the request, an
// option key from the file, or a hint.
import type { KnownIdChoiceField, KnownIdField } from '../config/known-ids.ts';
import { KNOWN_ID_KEYS, type KnownIdKey, type KnownIds } from '../types/core.ts';
import type { TriageRequest } from '../types/request.ts';
import { patternValues } from './id-decision.ts';

type Request = Pick<TriageRequest, 'messages' | 'hints'>;

type LabelRule = { readonly source: string; readonly field: KnownIdField };

// Words may be joined by spaces, underscores or hyphens, or not at all.
const SEP = '[\\s_-]*';

// The rules for one fields list, built once per list.
type Rules = { readonly labels: readonly LabelRule[]; readonly line: RegExp; readonly exact: readonly RegExp[] };
const RULES = new WeakMap<readonly KnownIdField[], Rules>();

/** The ids in a request: template labels, then hints.ids on top. Frozen, in KNOWN_ID_KEYS order. */
export function extractKnownIds(request: Request, fields: readonly KnownIdField[]): Partial<KnownIds> {
  return withHints(labelledIds(fields, orderedTexts(request.messages)), request.hints);
}

/** The ids the template labels give, first value per key. texts are parent first. */
export function labelledIds(fields: readonly KnownIdField[], texts: readonly string[]): Partial<KnownIds> {
  const rules = rulesFor(fields);
  const out: { [K in KnownIdKey]?: string } = {};
  for (const text of texts) {
    for (const { key, value } of labelledValues(text, rules)) {
      if (out[key] === undefined) out[key] = value;
    }
  }
  return Object.freeze(ordered(out));
}

/** ids with hints.ids on top: a non-empty hint wins for its key. Frozen, in KNOWN_ID_KEYS order. */
export function withHints(ids: Partial<KnownIds>, hints: Request['hints']): Partial<KnownIds> {
  const out: { [K in KnownIdKey]?: string } = { ...ids };
  for (const [key, value] of Object.entries(hintedIds(hints)) as [KnownIdKey, string][]) out[key] = value;
  return Object.freeze(ordered(out));
}

/** The non-empty hints.ids, trimmed. */
export function hintedIds(hints: Request['hints']): Partial<KnownIds> {
  const out: { [K in KnownIdKey]?: string } = {};
  for (const key of KNOWN_ID_KEYS) {
    const hinted = hints.ids?.[key];
    if (typeof hinted === 'string' && hinted.trim() !== '') out[key] = hinted.trim();
  }
  return out;
}

/** Message texts with the parent first, then the rest in the order given. */
export function orderedTexts(messages: Request['messages']): string[] {
  const parents = messages.filter((m) => m.is_parent);
  const rest = messages.filter((m) => !m.is_parent);
  return [...parents, ...rest].map((m) => m.text);
}

function rulesFor(fields: readonly KnownIdField[]): Rules {
  const cached = RULES.get(fields);
  if (cached !== undefined) return cached;
  const labels = fields
    .flatMap((field) => field.labels.map((label) => ({ label, field })))
    // Longest first; a stable sort keeps file order for labels of equal length.
    .sort((a, b) => b.label.length - a.label.length)
    .map(({ label, field }) => ({ source: labelSource(label), field }));
  // A whole line "<label>: <value>" or "<label> = <value>". Leading quote
  // markers, bullets and italic underscores are allowed around the label.
  const line = new RegExp(`^[\\s>•·-]*_?(${labels.map((l) => l.source).join('|')})_?\\s*[:=]\\s*_?\\s*(.*)$`, 'i');
  const exact = labels.map((l) => new RegExp(`^(?:${l.source})$`, 'i'));
  const rules = { labels, line, exact };
  RULES.set(fields, rules);
  return rules;
}

// A label as regex source: its words escaped and joined by SEP, with an
// optional full stop after it ('A/C No.').
function labelSource(label: string): string {
  return `${label.trim().split(/\s+/).map(escapeRegex).join(SEP)}\\.?`;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The template fields in one message, in line order. */
function labelledValues(text: string, rules: Rules): { key: KnownIdKey; value: string }[] {
  // Bold and strike markers wrap labels and values in Slack mrkdwn.
  const lines = text.replace(/[*~]/g, '').split(/\r?\n/);
  const found: { key: KnownIdKey; value: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = rules.line.exec(lines[i] as string);
    if (match === null) continue;
    const field = fieldOf(match[1] as string, rules);
    let raw = (match[2] ?? '').trim();
    // Block-field form: the value is on the next line, unless that line is
    // itself a label.
    if (raw === '' && i + 1 < lines.length && !rules.line.test(lines[i + 1] as string)) {
      raw = (lines[i + 1] as string).replace(/^[\s>]+/, '').trim();
      i++;
    }
    const value = field.kind === 'choice' ? optionFor(field, raw) : patternValues(field, raw)[0];
    if (value !== undefined) found.push({ key: field.key, value });
  }
  return found;
}

function fieldOf(labelText: string, rules: Rules): KnownIdField {
  const i = rules.exact.findIndex((re) => re.test(labelText.trim()));
  // The line regex only matches the labels above, so this is not reached.
  if (i === -1) throw new Error('unknown template label');
  return (rules.labels[i] as LabelRule).field;
}

// The option whose alias appears in the value as whole words: the earliest
// match, then the longest alias.
function optionFor(field: KnownIdChoiceField, raw: string): string | undefined {
  let best: { at: number; length: number; option: string } | undefined;
  for (const [option, { aliases }] of Object.entries(field.options)) {
    for (const alias of aliases) {
      const words = alias.trim().split(/\s+/).map(escapeRegex).join('\\s+');
      const m = new RegExp(`(?<![A-Za-z0-9])${words}(?![A-Za-z0-9])`, 'i').exec(raw);
      if (m === null) continue;
      if (best === undefined || m.index < best.at || (m.index === best.at && m[0].length > best.length)) {
        best = { at: m.index, length: m[0].length, option };
      }
    }
  }
  return best?.option;
}

/** The ids in KNOWN_ID_KEYS order, so callers and snapshots see a stable shape. */
function ordered(ids: { [K in KnownIdKey]?: string }): Partial<KnownIds> {
  const out: { [K in KnownIdKey]?: string } = {};
  for (const key of KNOWN_ID_KEYS) {
    const value = ids[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
