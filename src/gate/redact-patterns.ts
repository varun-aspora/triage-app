// Named PII and secret detectors used by the two redaction profiles in
// redact.ts (HLD 02 §3, D24). Each detector finds spans in a string and has a
// mask function for the text of one span. Masks never match their own
// detector again, which is what makes redaction idempotent.
//
// Detectors are plain regex plus small checks (Luhn, digit counts). They see
// raw text only; decoding is redact-decode.ts's job.

export const PATTERN_NAMES = [
  'credential',
  'email',
  'pan',
  'card',
  'postcode_address',
  'phone',
  'passport',
  'name',
  'digits6',
] as const;
export type PatternName = (typeof PATTERN_NAMES)[number];

export type Span = { readonly start: number; readonly end: number };

/**
 * Which protected spans a detector must not touch. UUIDs pass both profiles
 * (A11). Lowercase hex tokens such as commit SHAs are kept from the digit
 * detectors, because a SHA often holds a run of six or more digits.
 */
export type Guard = 'none' | 'uuid' | 'uuid+hex';

export type FindOptions = { readonly names?: RegExp | null };

export type Detector = {
  readonly name: PatternName;
  readonly guard: Guard;
  find(s: string, opts: FindOptions): Span[];
  mask(text: string): string;
};

const MASK = '****';

// ------------------------------------------------------------------ helpers

function spansOf(re: RegExp, s: string, keep?: (m: RegExpExecArray) => boolean): Span[] {
  const out: Span[] = [];
  for (const m of s.matchAll(re)) {
    if (keep && !keep(m)) continue;
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Span of capture group 1 of each match; the regex must use the d flag. */
function groupSpans(re: RegExp, s: string, keep?: (value: string) => boolean): Span[] {
  const out: Span[] = [];
  for (const m of s.matchAll(re)) {
    const at = m.indices?.[1];
    const value = m[1];
    if (at === undefined || value === undefined) continue;
    if (keep && !keep(value)) continue;
    out.push({ start: at[0], end: at[1] });
  }
  return out;
}

function lastDigits(text: string, n: number): string {
  return text.replace(/\D/g, '').slice(-n);
}

function maskLast4(text: string): string {
  return MASK + lastDigits(text, 4);
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

// Card networks start with 2-6 (Visa, Mastercard, Amex, Discover, RuPay 60/65,
// Maestro) or 81/82 (RuPay). Account numbers starting with 0, 1, 7 or 9 are
// therefore never read as a PAN.
function cardPrefix(digits: string): boolean {
  return /^(?:[2-6]|8[12])/.test(digits);
}

const PLACEHOLDER = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

// ------------------------------------------------------------------ guards

const UUID_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f])/g;

export function uuidSpans(s: string): Span[] {
  return spansOf(UUID_RE, s);
}

const HEX_TOKEN_RE = /(?<![0-9A-Za-z])[0-9a-f]{7,64}(?![0-9A-Za-z])/g;

/** Lowercase hex tokens with at least two letters, such as commit SHAs. */
export function hexTokenSpans(s: string): Span[] {
  return spansOf(HEX_TOKEN_RE, s, (m) => (m[0].match(/[a-f]/g)?.length ?? 0) >= 2);
}

export function isUuid(s: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(s);
}

// ------------------------------------------------------------------ credential

// Password in URL userinfo: scheme://user:PASSWORD@host. The password may run
// over a line break (a DSN wrapped in a multi-line value).
const URL_PASSWORD_RE = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s:@\/'"`]{1,256}:((?:[^\s@\/'"`]|\r?\n){1,512})@/dg;

// KEY=value, KEY: value, "key": "value", with an optional export prefix.
// The value may be double quoted (and span lines), single quoted or bare.
// Key parts are bounded so a long token cannot make the match quadratic.
const SECRET_KEY =
  '[A-Za-z0-9_.-]{0,64}(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|_key)[A-Za-z0-9_.-]{0,64}';
const KEY_VALUE_RE = new RegExp(
  `(?<![A-Za-z0-9_.-])(?:export\\s+)?["']?${SECRET_KEY}["']?\\s*[=:]\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s"',;&}\\]]+)`,
  'dgi',
);

const AUTH_HEADER_RE = /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+\/-]{8,}=*)/dg;

const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]*?)-----END [A-Z ]*PRIVATE KEY-----/dg;

function secretValueSpan(s: string): Span[] {
  const out: Span[] = [];
  for (const m of s.matchAll(KEY_VALUE_RE)) {
    const at = m.indices?.[1];
    const raw = m[1];
    if (at === undefined || raw === undefined) continue;
    const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'");
    const start = quoted ? at[0] + 1 : at[0];
    const end = quoted ? at[1] - 1 : at[1];
    const inner = s.slice(start, end);
    if (inner.length === 0 || inner === MASK || PLACEHOLDER.test(inner)) continue;
    out.push({ start, end });
  }
  return out;
}

export const credential: Detector = {
  name: 'credential',
  guard: 'none',
  find(s) {
    const keep = (v: string) => v !== MASK && !PLACEHOLDER.test(v);
    return [
      ...groupSpans(URL_PASSWORD_RE, s, keep),
      ...secretValueSpan(s),
      ...groupSpans(AUTH_HEADER_RE, s, keep),
      ...groupSpans(PEM_RE, s, (v) => v.trim().length > 0 && v !== MASK),
    ];
  },
  mask: () => MASK,
};

// ------------------------------------------------------------------ email

const EMAIL_RE =
  /(?<![A-Za-z0-9._%+*-])[A-Za-z0-9._%+*-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){0,8}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

// user@host inside a URL authority is not an email address.
const URL_AUTHORITY_BEFORE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/@]*$/;

export const email: Detector = {
  name: 'email',
  guard: 'none',
  find(s) {
    return spansOf(EMAIL_RE, s, (m) => !URL_AUTHORITY_BEFORE.test(s.slice(Math.max(0, m.index - 200), m.index)));
  },
  mask: () => '[email]',
};

/** Model-facing mask: hide the local part, keep the domain. */
export function maskEmailLocal(text: string): string {
  const at = text.lastIndexOf('@');
  return MASK + text.slice(at);
}

// ------------------------------------------------------------------ pan and card

const PAN_RE = /(?<!\d)\d{13,19}(?!\d)/g;

export const pan: Detector = {
  name: 'pan',
  guard: 'uuid',
  find(s) {
    return spansOf(PAN_RE, s, (m) => cardPrefix(m[0]) && luhnValid(m[0]));
  },
  mask: maskLast4,
};

// Grouped card numbers: 4-4-4-4 (and 4-4-4-1..7) or Amex 4-6-5, spaces or dashes.
const CARD_RE = /(?<![\d-])(?:\d{4}([ -])\d{6}\1\d{5}|\d{4}([ -])\d{4}\2\d{4}\2\d{1,7})(?![\d-])/g;

export const card: Detector = {
  name: 'card',
  guard: 'uuid',
  find(s) {
    return spansOf(CARD_RE, s, (m) => {
      const digits = m[0].replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    });
  },
  mask: maskLast4,
};

// ------------------------------------------------------------------ postcode address

// Indian PIN (6 digits, optional space after the third) and UK postcodes.
const POSTCODE_RE = /(?<![\dA-Za-z])(?:[1-9]\d{2} ?\d{3}|(?:[A-Z]{1,2}\d[A-Z\d]?|GIR) ?\d[A-Z]{2})(?![\dA-Za-z])/g;

const ADDRESS_WORD =
  /\b(?:flat|house|h\.?\s?no|door|plot|street|road|rd|lane|marg|nagar|colony|sector|block|floor|apartments?|apt|building|bldg|society|tower|residency|layout|avenue|village|district|city|town|near|opp)\b/i;

// An address segment starts after one of these (including key= in log lines),
// or after a "label:" prefix.
const SEGMENT_BREAK = /[\n\r\t"{}\[\]|;=]|:\s/g;
const MAX_ADDRESS_LOOKBACK = 120;

function addressStart(s: string, postcodeStart: number): number {
  const from = Math.max(0, postcodeStart - MAX_ADDRESS_LOOKBACK);
  const window = s.slice(from, postcodeStart);
  let start = 0;
  for (const m of window.matchAll(SEGMENT_BREAK)) start = m.index + m[0].length;
  let at = from + start;
  while (at < postcodeStart && /\s/.test(s[at] ?? '')) at++;
  return at;
}

export const postcodeAddress: Detector = {
  name: 'postcode_address',
  guard: 'uuid',
  find(s) {
    const out: Span[] = [];
    for (const m of s.matchAll(POSTCODE_RE)) {
      const start = addressStart(s, m.index);
      const before = s.slice(start, m.index);
      if (!/[A-Za-z]{2,}/.test(before)) continue;
      // Either an address word, or "..., City 700016" with a capitalised
      // place name right before the postcode.
      const placeBefore = before.includes(',') && /[A-Z][A-Za-z]+[\s,-]*$/.test(before);
      if (!placeBefore && !ADDRESS_WORD.test(before)) continue;
      out.push({ start, end: m.index + m[0].length });
    }
    return out;
  },
  mask: () => '[address]',
};

// ------------------------------------------------------------------ phone

// A candidate is digit groups with optional +country code, (area code) and
// space or dash separators. The digit count decides whether it is a phone.
const PHONE_RE = /(?<![\w+*])(?:\+\d{1,3}[ -]?)?(?:\(\d{1,5}\)[ -]?)?\d{2,5}(?:[ -]?\d{2,5}){1,5}(?![\w:])/g;

function looksLikePhone(text: string): boolean {
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length >= 10 && digits.length <= 15;
  if (/[ ()-]/.test(text)) return digits.length >= 10 && digits.length <= 12;
  // Plain runs: Indian mobile numbers only; other runs fall to digits6.
  return /^(?:[6-9]\d{9}|0[6-9]\d{9}|91[6-9]\d{9})$/.test(digits);
}

// When a whole candidate is not a phone (for example a reference number
// followed by a phone), try runs of its digit groups, longest first.
function phoneSpans(s: string, m: RegExpExecArray): Span[] {
  const text = m[0];
  if (looksLikePhone(text)) return [{ start: m.index, end: m.index + text.length }];
  const groups = [...text.matchAll(/\+?\(?\d+\)?/g)].map((g) => ({ start: g.index, end: g.index + g[0].length }));
  const out: Span[] = [];
  let i = 0;
  while (i < groups.length) {
    let found = -1;
    for (let j = groups.length - 1; j > i; j--) {
      const sub = text.slice(groups[i]!.start, groups[j]!.end);
      if (looksLikePhone(sub)) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      i++;
      continue;
    }
    out.push({ start: m.index + groups[i]!.start, end: m.index + groups[found]!.end });
    i = found + 1;
  }
  return out;
}

export const phone: Detector = {
  name: 'phone',
  guard: 'uuid+hex',
  find(s) {
    return [...s.matchAll(PHONE_RE)].flatMap((m) => phoneSpans(s, m));
  },
  mask: maskLast4,
};

// ------------------------------------------------------------------ passport

// Indian passport shape (one letter, seven digits), and any 6-9 character
// value that follows the word "passport".
const PASSPORT_RE = /(?<![A-Za-z0-9])[A-Z][0-9]{7}(?![A-Za-z0-9])/g;
const PASSPORT_KEYWORD_RE = /passport(?:[\s_-]*(?:no\.?|number|num|#))?[\s_]*[:#=-]?\s*([A-Z0-9]{6,9})(?![A-Za-z0-9])/dgi;

export const passport: Detector = {
  name: 'passport',
  guard: 'uuid',
  find(s) {
    return [...spansOf(PASSPORT_RE, s), ...groupSpans(PASSPORT_KEYWORD_RE, s, (v) => /\d/.test(v))];
  },
  mask: () => '[passport]',
};

// ------------------------------------------------------------------ names

// Words that are mask tokens themselves; a name equal to one would make
// redaction non-idempotent.
const RESERVED_NAMES = new Set(['name', 'email', 'address', 'passport']);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles supplied names into one case-insensitive, whole-word regex, or
 * null when there is nothing to match. Longer names are tried first.
 */
export function compileNames(names: readonly string[] | undefined): RegExp | null {
  if (!names || names.length === 0) return null;
  const parts = [
    ...new Set(
      names
        .map((n) => n.trim().replace(/\s+/g, ' '))
        .filter((n) => n.length >= 2 && !n.includes('*') && !RESERVED_NAMES.has(n.toLowerCase())),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.split(' ').map(escapeRegex).join('\\s+'));
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}

export const name: Detector = {
  name: 'name',
  guard: 'none',
  find(s, opts) {
    return opts.names ? spansOf(opts.names, s) : [];
  },
  mask: () => '[name]',
};

// ------------------------------------------------------------------ digits6

const DIGITS6_RE = /(?<!\d)\d{6,}(?!\d)/g;

export const digits6: Detector = {
  name: 'digits6',
  guard: 'uuid+hex',
  find(s) {
    return spansOf(DIGITS6_RE, s);
  },
  mask: maskLast4,
};
