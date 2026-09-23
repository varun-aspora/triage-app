// Finds id-shaped values inside tool parameters, for the scope rule (D26).
// Pure: no I/O, no config. The patterns are deliberately broad; a false match
// only means the value has to be in the run's ID chain.

export type IdKind = 'uuid' | 'digits' | 'phone' | 'email';

export type IdShaped = {
  kind: IdKind;
  // The matched text as it appeared in the input.
  raw: string;
  // The form used for comparison: lowercase UUID or email, bare digits, or the
  // last 10 digits of a +<cc> phone.
  normalised: string;
};

// Any UUID version, hyphenated, either case.
const UUID_RE = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// A leading + and 10 to 15 digits in total, with at most one space, dash, dot
// or bracket between digits.
const PHONE_RE = /\+\d(?:[ \-.()]?\d){9,14}(?!\d)/g;
// Account numbers, CIFs and bare 10-digit phones.
const DIGITS_RE = /(?<!\d)\d{9,}(?!\d)/g;

export const PHONE_DIGITS = 10;

export function lastDigits(value: string, n: number = PHONE_DIGITS): string {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-n);
}

// Pulls every match of re out of text, blanking each match so later patterns
// do not match inside it again (a UUID's last group can be 12 digits).
function take(text: string, re: RegExp, kind: IdKind, normalise: (raw: string) => string, out: IdShaped[]): string {
  return text.replace(re, (raw) => {
    out.push({ kind, raw, normalised: normalise(raw) });
    return ' '.repeat(raw.length);
  });
}

function fromString(text: string, out: IdShaped[]): void {
  let rest = text;
  rest = take(rest, UUID_RE, 'uuid', (raw) => raw.toLowerCase(), out);
  rest = take(rest, EMAIL_RE, 'email', (raw) => raw.toLowerCase(), out);
  rest = take(rest, PHONE_RE, 'phone', (raw) => lastDigits(raw), out);
  take(rest, DIGITS_RE, 'digits', (raw) => raw, out);
}

function walk(value: unknown, out: IdShaped[], seen: WeakSet<object>): void {
  if (typeof value === 'string') {
    fromString(value, out);
    return;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) fromString(String(value), out);
    return;
  }
  if (typeof value === 'bigint') {
    fromString(value.toString(), out);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, seen);
    return;
  }
  // Keys are checked too: an id can be smuggled in as an object key.
  for (const [key, item] of Object.entries(value)) {
    fromString(key, out);
    walk(item, out, seen);
  }
}

// Walks strings, numbers, arrays and plain objects and returns every id-shaped
// value found, in the order met.
export function extractIdShaped(value: unknown): IdShaped[] {
  const out: IdShaped[] = [];
  walk(value, out, new WeakSet());
  return out;
}
