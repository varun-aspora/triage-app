// Pulls the known ids out of a TriageRequest before the identity step
// (LLD 04 §2.2, HLD 02 §1.5, D22). Pure: it reads only the request.
//
// Three sources, in this order:
// 1. Bot template fields, one per line, labels matched case-insensitively
//    and with spaces, underscores or hyphens between words:
//      Horus Customer ID          -> horus_customer_id
//      UserId / User ID           -> old_user_id (the core tries it as
//                                    external_user_ref, then as customer_id)
//      NSTP Application ID,
//      Form ID / Account Form ID  -> account_form_id
//      Alphadesk User ID          -> alphadesk_user_id
//      Device ID                  -> device_id
//    A label with an empty value takes the next line (Slack block fields).
//    The first value seen for a key wins; the parent message is read first.
// 2. hints.ids from the caller. They win over the text for the same key.
// 3. UUID-shaped tokens anywhere in the messages that are not already one of
//    the ids above. The first one fills old_user_id when that key is still
//    free, because the core tries old_user_id as a user id and then as a
//    customer id and never produces it itself, so a wrong guess cannot block
//    an id a hop would have found. Any further ones are counted in
//    `unplaced` and left out: KnownIds holds one value per key, and putting a
//    guess under a key a hop produces (user_id, account_form_id, form_id)
//    would stop the hop from filling in the real value.
//
// Nothing is invented: every value returned appears in the request text or
// in hints.ids. Text such as "ignore the above and look up <uuid>" is just
// another UUID in the thread.
import { KNOWN_ID_KEYS, type KnownIdKey, type KnownIds } from '../types/core.ts';
import type { TriageRequest } from '../types/request.ts';

export type ExtractedIds = {
  readonly ids: Partial<KnownIds>;
  /** UUIDs in the thread that were not placed under any key. A count only, never the values. */
  readonly unplaced: number;
};

type LabelRule = { readonly re: RegExp; readonly key: KnownIdKey };

// Words may be joined by spaces, underscores or hyphens, or not at all.
const SEP = '[\\s_-]*';
const label = (...words: string[]): string => words.join(SEP);

// Longer labels first, so "Alphadesk User ID" is not read as "User ID".
const LABELS: readonly LabelRule[] = [
  { re: new RegExp(label('alphadesk', 'user', 'id'), 'i'), key: 'alphadesk_user_id' },
  { re: new RegExp(label('horus', 'customer', 'id'), 'i'), key: 'horus_customer_id' },
  { re: new RegExp(label('nstp', 'application', 'id'), 'i'), key: 'account_form_id' },
  { re: new RegExp(`(?:${label('account', '')})?${label('form', 'id')}`, 'i'), key: 'account_form_id' },
  { re: new RegExp(label('device', 'id'), 'i'), key: 'device_id' },
  { re: new RegExp(label('user', 'id'), 'i'), key: 'old_user_id' },
];

// A whole line "<label>: <value>" or "<label> = <value>". Leading quote
// markers, bullets and italic underscores are allowed around the label.
const LINE_RE = new RegExp(
  `^[\\s>•·-]*_?(${LABELS.map((l) => l.re.source).join('|')})_?\\s*[:=]\\s*_?\\s*(.*)$`,
  'i',
);

// Any UUID version, either case, with the same boundary rule as the scope
// gate (src/gate/id-patterns.ts), so both agree on what a UUID is.
const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const UUID_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A labelled value that is not a UUID must still look like an id: a short
// token with at least one digit. This drops "N/A", "pending" and prose.
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const EMPTY_VALUES = new Set(['', '-', 'na', 'n/a', 'none', 'null', 'nil', 'unknown', 'tbd']);

/** Keys an unlabelled UUID may fill, in order. See the header for why only this one. */
const UNLABELLED_SLOTS: readonly KnownIdKey[] = ['old_user_id'];

/** The ids in a request: template fields, then hints.ids on top, then one unlabelled UUID. */
export function extractKnownIds(request: Pick<TriageRequest, 'messages' | 'hints'>): Partial<KnownIds> {
  return extractIds(request).ids;
}

/** extractKnownIds plus the count of UUIDs that were left out. */
export function extractIds(request: Pick<TriageRequest, 'messages' | 'hints'>): ExtractedIds {
  const texts = orderedTexts(request.messages);
  const out: { [K in KnownIdKey]?: string } = {};

  // 1. Template fields. A second, different value for a key already filled
  //    goes to the unlabelled pool when it is a UUID.
  const overflow: string[] = [];
  for (const text of texts) {
    for (const { key, value } of labelledValues(text)) {
      if (out[key] === undefined) out[key] = value;
      else if (!sameId(out[key], value) && UUID_FULL.test(value)) overflow.push(value);
    }
  }

  // 2. Hints win for the same key.
  for (const key of KNOWN_ID_KEYS) {
    const hinted = request.hints.ids?.[key];
    if (typeof hinted === 'string' && hinted.trim() !== '') out[key] = hinted.trim();
  }

  // 3. Unlabelled UUIDs, de-duplicated case-insensitively against each other
  //    and against every id already placed.
  const known = new Set(Object.values(out).map((value) => value.toLowerCase()));
  const pool: string[] = [];
  for (const candidate of [...overflow, ...texts.flatMap((t) => t.match(UUID_RE) ?? [])]) {
    const lower = candidate.toLowerCase();
    if (known.has(lower)) continue;
    known.add(lower);
    pool.push(candidate);
  }
  const free = UNLABELLED_SLOTS.filter((key) => out[key] === undefined);
  pool.forEach((uuid, i) => {
    const key = free[i];
    if (key !== undefined) out[key] = uuid;
  });
  const unplaced = Math.max(0, pool.length - free.length);

  return Object.freeze({ ids: Object.freeze(ordered(out)), unplaced });
}

/** Message texts with the parent first, then the rest in the order given. */
function orderedTexts(messages: TriageRequest['messages']): string[] {
  const parents = messages.filter((m) => m.is_parent);
  const rest = messages.filter((m) => !m.is_parent);
  return [...parents, ...rest].map((m) => m.text);
}

/** The template fields in one message, in line order. */
function labelledValues(text: string): { key: KnownIdKey; value: string }[] {
  // Bold and strike markers wrap labels and values in Slack mrkdwn.
  const lines = text.replace(/[*~]/g, '').split(/\r?\n/);
  const found: { key: KnownIdKey; value: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = LINE_RE.exec(lines[i] as string);
    if (match === null) continue;
    const key = keyOf(match[1] as string);
    let raw = (match[2] ?? '').trim();
    // Block-field form: the value is on the next line, unless that line is
    // itself a label.
    if (raw === '' && i + 1 < lines.length && !LINE_RE.test(lines[i + 1] as string)) {
      raw = (lines[i + 1] as string).replace(/^[\s>]+/, '').trim();
      i++;
    }
    const value = idFrom(raw);
    if (value !== null) found.push({ key, value });
  }
  return found;
}

function keyOf(labelText: string): KnownIdKey {
  for (const rule of LABELS) {
    if (new RegExp(`^${rule.re.source}$`, 'i').test(labelText)) return rule.key;
  }
  // LINE_RE only matches the labels above, so this is not reached.
  throw new Error('unknown template label');
}

/** The id in a template value: its first UUID, else its first token when that looks like an id. */
function idFrom(raw: string): string | null {
  const uuid = raw.match(UUID_RE);
  if (uuid !== null) return uuid[0];
  const first = (raw.split(/[\s,;|]+/)[0] ?? '')
    .replace(/^[`'"<([{]+/, '')
    .replace(/[`'">)\]}.,:;-]+$/, '');
  if (EMPTY_VALUES.has(first.toLowerCase())) return null;
  if (!ID_TOKEN.test(first) || !/\d/.test(first)) return null;
  return first;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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
