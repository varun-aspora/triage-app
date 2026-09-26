// Keyed, format-preserving pseudonyms for eval data (D42, P1 critic "Masking
// breaks the evals").
//
// Masks like ****1234 fail the scope gate's id-shape checks and collapse
// distinct accounts that share their last four digits. Eval cases use
// pseudonyms instead: HMAC-SHA256 over the original value, shaped like the
// original, so ids stay well-formed and consistent across the thread text,
// the ids, the ID chain and the basic state of one case.
//
// Derivation is by shape, not by id key, so the same string maps to the same
// pseudonym wherever it appears:
//   uuid    -> an RFC 4122 version 4 UUID, same letter case as the input
//   digits  -> same length; a leading zero stays zero, other leading digits stay non-zero
//   phone   -> country prefix and separators kept, same length; the digits
//              after the prefix come from the last 10 digits only, so
//              +91 98765 43210, +919876543210 and a bare 9876543210 agree
//   token   -> each digit, lowercase and uppercase letter replaced in class
//   email   -> token local part at example.com
// A form id is a UUID when it looks like one and a token otherwise.
// country is not an identifier (it is GB or AE, a choice from
// resources/known-ids.json) and is never pseudonymised.
//
// The key never leaves this module and no function logs values.
import { createHmac } from 'node:crypto';
import * as v from 'valibot';

import { extractIdShaped, lastDigits, PHONE_DIGITS } from '../gate/id-patterns.ts';
import { createScopeSet, inScope, maskId } from '../gate/scope.ts';
import type { KnownIdKey } from '../types/core.ts';
import { CaseSchema, threadTexts, toIdChain, type EvalCase } from './case-schema.ts';

export const PSEUDONYM_KINDS = ['uuid', 'account_number', 'phone', 'form_id', 'token', 'email'] as const;
export type PseudonymKind = (typeof PSEUDONYM_KINDS)[number];

export type PseudonymKey = string | Uint8Array;

/** Shortest key accepted, in bytes. */
export const MIN_KEY_BYTES = 16;

export class PseudonymError extends Error {
  override readonly name = 'PseudonymError';
}

const UUID_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_FULL = /^\d+$/;
// Optional +, then digits with at most one space, dash, dot or bracket between them.
const PHONE_FULL = /^\+?\d(?:[ \-.()]?\d)*$/;
const TOKEN_FULL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const EMAIL_FULL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export const isUuidShaped = (s: string): boolean => UUID_FULL.test(s);

// Country codes we expect in this bank's threads. A longer match wins. An
// unknown code keeps one digit, and anything beyond the last 10 digits is
// kept as prefix in any case.
const COUNTRY_CODES = [
  '1', '7', '20', '27', '33', '44', '49', '60', '61', '64', '65', '66', '81', '86', '91', '92', '94', '353',
  '880', '965', '966', '968', '971', '973', '974', '977',
];

function keyBytes(key: PseudonymKey): Buffer {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
  if (bytes.length < MIN_KEY_BYTES) {
    throw new PseudonymError(`pseudonym key must be at least ${MIN_KEY_BYTES} bytes`);
  }
  return bytes;
}

// A deterministic byte stream for one (key, label) pair.
class Stream {
  private block = Buffer.alloc(0);
  private pos = 0;
  private counter = 0;
  private readonly key: Buffer;
  private readonly label: string;
  constructor(key: Buffer, label: string) {
    this.key = key;
    this.label = label;
  }
  byte(): number {
    if (this.pos >= this.block.length) {
      this.block = createHmac('sha256', this.key).update(`${this.label}\u0000${this.counter++}`).digest();
      this.pos = 0;
    }
    return this.block[this.pos++] as number;
  }
  // Uniform in [0, n) by rejection, so digits and letters are unbiased.
  below(n: number): number {
    const limit = 256 - (256 % n);
    for (;;) {
      const b = this.byte();
      if (b < limit) return b % n;
    }
  }
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const HEX = '0123456789abcdef';

// Tries up to 8 derivations so the output never equals the input. Each
// attempt is deterministic, so the result still is.
function derive(key: Buffer, label: string, input: string, make: (s: Stream) => string): string {
  let out = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    out = make(new Stream(key, `${label}\u0000${attempt}\u0000${input}`));
    if (out !== input) return out;
  }
  return out;
}

function uuidOf(key: Buffer, value: string): string {
  const lower = value.toLowerCase();
  const out = derive(key, 'uuid', lower, (s) => {
    const nibbles: string[] = [];
    for (let i = 0; i < 32; i++) nibbles.push(HEX[s.below(16)] as string);
    nibbles[12] = '4';
    nibbles[16] = HEX[8 + s.below(4)] as string;
    const h = nibbles.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  });
  return value === value.toUpperCase() && value !== lower ? out.toUpperCase() : out;
}

function digitsOf(key: Buffer, value: string): string {
  return derive(key, 'digits', value, (s) => {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      if (i === 0) out += value[0] === '0' ? '0' : String(1 + s.below(9));
      else out += String(s.below(10));
    }
    return out;
  });
}

function countryCodeLength(digits: string): number {
  let best = 0;
  for (const cc of COUNTRY_CODES) if (cc.length > best && digits.startsWith(cc)) best = cc.length;
  return best || 1;
}

function phoneOf(key: Buffer, value: string, bare = !value.startsWith('+')): string {
  const digits = value.replace(/\D/g, '');
  const base = Math.max(0, digits.length - PHONE_DIGITS);
  const national = digits.slice(base);
  const keep = Math.min(digits.length - 1, Math.max(base, bare ? 0 : countryCodeLength(digits)));
  const derived = derive(key, 'phone', national, (s) => {
    let out = '';
    for (let i = 0; i < national.length; i++) out += String(s.below(10));
    return out;
  });
  const newDigits = digits.slice(0, keep) + derived.slice(keep - base);
  let i = 0;
  return value.replace(/\d/g, () => newDigits[i++] as string);
}

function tokenOf(key: Buffer, value: string): string {
  return derive(key, 'token', value, (s) =>
    value.replace(/[0-9a-zA-Z]/g, (ch) => {
      if (ch >= '0' && ch <= '9') return String(s.below(10));
      if (ch >= 'a' && ch <= 'z') return LOWER[s.below(26)] as string;
      return UPPER[s.below(26)] as string;
    }),
  );
}

function emailOf(key: Buffer, value: string): string {
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at).toLowerCase();
  return `${tokenOf(key, local).replace(/[^a-z0-9._-]/g, 'x')}@example.com`;
}

function need(ok: boolean, kind: PseudonymKind): void {
  if (!ok) throw new PseudonymError(`value is not a well-formed ${kind}`);
}

/**
 * The pseudonym of one value. Deterministic for a key and value, different
 * under another key. Throws PseudonymError when the value does not have the
 * shape of its kind or the key is shorter than MIN_KEY_BYTES.
 */
export function pseudonymise(value: string, kind: PseudonymKind, key: PseudonymKey): string {
  const k = keyBytes(key);
  switch (kind) {
    case 'uuid':
      need(UUID_FULL.test(value), kind);
      return uuidOf(k, value);
    case 'account_number':
      need(DIGITS_FULL.test(value), kind);
      return digitsOf(k, value);
    case 'phone': {
      const n = value.replace(/\D/g, '').length;
      need(PHONE_FULL.test(value) && n >= 7 && n <= 15, kind);
      return phoneOf(k, value);
    }
    case 'form_id':
      if (UUID_FULL.test(value)) return uuidOf(k, value);
      need(TOKEN_FULL.test(value), kind);
      return tokenOf(k, value);
    case 'token':
      need(TOKEN_FULL.test(value), kind);
      return tokenOf(k, value);
    case 'email':
      need(EMAIL_FULL.test(value), kind);
      return emailOf(k, value);
    default:
      throw new PseudonymError('unknown pseudonym kind');
  }
}

/** Known id keys whose value is kept as it is: a choice, not an identifier. */
const KEPT_KEYS: ReadonlySet<KnownIdKey> = new Set(['country']);

/**
 * The kind a known id is pseudonymised as, from its key and shape, or
 * undefined for a key that is kept as it is (country).
 */
export function kindForId(idKey: KnownIdKey, value: string): PseudonymKind | undefined {
  if (KEPT_KEYS.has(idKey)) return undefined;
  if (UUID_FULL.test(value)) return 'uuid';
  if (idKey === 'phone_number') return 'phone';
  if (idKey === 'account_form_id') return 'form_id';
  if (DIGITS_FULL.test(value)) return 'account_number';
  return 'token';
}

// Case-level mapping from original strings to pseudonyms. Every string is
// derived once; two originals landing on one pseudonym is refused.
class CaseMap {
  readonly map = new Map<string, string>();
  private readonly reverse = new Map<string, string>();
  readonly phoneNationals = new Set<string>();
  private readonly key: Buffer;
  constructor(key: Buffer) {
    this.key = key;
  }

  // canonical is the form the scope gate compares, so a UUID in two letter
  // cases is one id, not a collision.
  add(original: string, make: () => string, canonical = original): void {
    if (this.map.has(original)) return;
    const pseudo = make();
    const clash = this.reverse.get(pseudo);
    if (clash !== undefined && clash !== canonical) {
      throw new PseudonymError('two ids in the case map to the same pseudonym');
    }
    this.map.set(original, pseudo);
    this.reverse.set(pseudo, canonical);
  }

  addKnown(idKey: KnownIdKey, value: string): void {
    const kind = kindForId(idKey, value);
    if (kind === undefined) return;
    if (kind === 'phone') this.addPhone(value);
    else if (kind === 'uuid') this.addUuid(value);
    else this.addDigitsOrToken(value, kind);
  }

  private addUuid(raw: string): void {
    const lower = raw.toLowerCase();
    this.add(raw, () => uuidOf(this.key, raw), lower);
    // The scope gate compares UUIDs in lowercase, so cover both cases.
    this.add(lower, () => uuidOf(this.key, lower), lower);
    this.add(raw.toUpperCase(), () => uuidOf(this.key, raw.toUpperCase()), lower);
  }

  private addPhone(raw: string): void {
    const digits = raw.replace(/\D/g, '');
    this.phoneNationals.add(lastDigits(digits));
    const pseudo = phoneOf(this.key, raw);
    this.add(raw, () => pseudo);
    // The same phone written as bare digits, with or without its prefix.
    const full = pseudo.replace(/\D/g, '');
    this.add(digits, () => full);
    if (raw.startsWith('+')) this.add(`+${digits}`, () => `+${full}`);
    if (digits.length > PHONE_DIGITS) this.add(lastDigits(digits), () => lastDigits(full));
  }

  private addDigitsOrToken(raw: string, kind: PseudonymKind): void {
    if (kind === 'account_number' && raw.length >= PHONE_DIGITS && this.phoneNationals.has(lastDigits(raw))) {
      // A phone written without its '+'.
      this.add(raw, () => phoneOf(this.key, raw, true));
      return;
    }
    if (kind === 'account_number') this.add(raw, () => digitsOf(this.key, raw));
    else this.add(raw, () => tokenOf(this.key, raw));
  }

  // Id-shaped values found in free text, whether or not the chain has them,
  // so no original id survives.
  addFound(text: string): void {
    for (const found of extractIdShaped(text)) {
      if (this.map.has(found.raw)) continue;
      if (found.kind === 'uuid') this.addUuid(found.raw);
      else if (found.kind === 'phone') this.addPhone(found.raw);
      else if (found.kind === 'email') this.add(found.raw, () => emailOf(this.key, found.raw));
      else this.addDigitsOrToken(found.raw, 'account_number');
    }
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Boundaries that mirror the id-shape regexes in src/gate/id-patterns.ts, so
// every value extractIdShaped found is replaced where it was found: a UUID is
// not part of a longer hex run, a digit run not part of a longer digit run, a
// phone is not followed by a digit. Other known ids (tokens) are whole words.
function boundaryPattern(raw: string): string {
  const body = escapeRe(raw);
  if (UUID_FULL.test(raw)) return `(?<![0-9A-Fa-f])${body}(?![0-9A-Fa-f])`;
  if (DIGITS_FULL.test(raw)) return `(?<!\\d)${body}(?!\\d)`;
  if (raw.startsWith('+')) return `${body}(?!\\d)`;
  if (raw.includes('@')) return body;
  return `(?<![0-9A-Za-z])${body}(?![0-9A-Za-z])`;
}

function replacer(map: ReadonlyMap<string, string>): (text: string) => string {
  if (map.size === 0) return (t) => t;
  const raws = [...map.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const re = new RegExp(raws.map(boundaryPattern).join('|'), 'g');
  return (text) => text.replace(re, (m) => map.get(m) ?? m);
}

// Fields that name the case rather than hold its data.
const UNTOUCHED = new Set(['id', 'taxonomy_version', 'label_source', 'provenance']);

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((x) => mapStrings(x, fn));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) out[k] = mapStrings(x, fn);
    return out;
  }
  return value;
}

function eachString(value: unknown, fn: (s: string) => void): void {
  if (typeof value === 'string') fn(value);
  else if (Array.isArray(value)) for (const x of value) eachString(x, fn);
  else if (value !== null && typeof value === 'object') for (const x of Object.values(value)) eachString(x, fn);
}

/**
 * Returns a copy of the case with every id replaced by its pseudonym, the
 * same original mapping to the same pseudonym in the thread text, ids,
 * id_chain, basic_state and the labels. id, taxonomy_version, label_source
 * and provenance are left alone. Throws PseudonymError on a short key or a
 * pseudonym collision.
 */
export function pseudonymiseCase(c: EvalCase, key: PseudonymKey): EvalCase {
  const map = new CaseMap(keyBytes(key));
  const data: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(c)) if (!UNTOUCHED.has(k)) data[k] = x;

  // Phones first, so bare digit runs that are phones map as phones.
  const known: [KnownIdKey, string][] = [];
  for (const ids of [c.ids, c.id_chain.ids]) {
    for (const [k, x] of Object.entries(ids)) if (typeof x === 'string') known.push([k as KnownIdKey, x]);
  }
  known.sort((a, b) => Number(b[0] === 'phone_number') - Number(a[0] === 'phone_number'));
  for (const [k, x] of known) map.addKnown(k, x);
  eachString(data, (s) => map.addFound(s));

  const replace = replacer(map.map);
  const rewritten = mapStrings(data, replace) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(c)) out[k] = UNTOUCHED.has(k) ? structuredClone(x) : rewritten[k];
  return v.parse(CaseSchema, out);
}

export type CaseIdProblem = {
  /** Where the problem is, as a field path. */
  readonly where: string;
  readonly reason: string;
  /** Kind and last characters only, as the scope gate masks. */
  readonly masked?: string;
};

export type CaseIdCheck = { readonly ok: true } | { readonly ok: false; readonly problems: CaseIdProblem[] };

// A D24 redaction mask (****1234) left in the thread instead of a pseudonym.
const MASK_RE = /\*{4}\d{0,4}/;

function wellFormed(idKey: KnownIdKey, value: string): boolean {
  if (value.includes('*')) return false;
  switch (idKey) {
    // The option keys live in resources/known-ids.json; this is only their
    // shape, as the loader checks it, so no country is named here.
    case 'country':
      return /^[A-Z0-9_]{1,32}$/.test(value);
    case 'aspora_user_id':
    case 'customer_id':
    case 'account_form_id':
    case 'account_id':
      return UUID_FULL.test(value);
    case 'account_number':
      return /^\d{9,}$/.test(value);
    case 'phone_number': {
      const n = value.replace(/\D/g, '').length;
      return PHONE_FULL.test(value) && (value.startsWith('+') ? n >= 10 && n <= 15 : n === PHONE_DIGITS);
    }
    default:
      return TOKEN_FULL.test(value);
  }
}

/**
 * Checks that a case's ids are usable by the gates: every id in id_chain.ids
 * is well-formed for its key, every id in ids is also in the chain with the
 * same value, the thread holds no redaction masks, and every id-shaped value
 * in the thread is in the chain's scope set, as the scope gate would decide.
 */
export function validateCaseIds(c: EvalCase): CaseIdCheck {
  const problems: CaseIdProblem[] = [];
  const chainIds = c.id_chain.ids as Record<string, string | undefined>;
  for (const [k, x] of Object.entries(chainIds)) {
    if (typeof x === 'string' && !wellFormed(k as KnownIdKey, x)) {
      problems.push({ where: `id_chain.ids.${k}`, reason: `not a well-formed ${k}` });
    }
  }
  for (const [k, x] of Object.entries(c.ids)) {
    if (typeof x !== 'string') continue;
    if (chainIds[k] !== x) problems.push({ where: `ids.${k}`, reason: 'not in id_chain.ids with the same value' });
  }
  const scope = createScopeSet(toIdChain(c));
  threadTexts(c).forEach((text, i) => {
    const where = c.request.messages ? `request.messages.${i}.text` : 'request.text';
    if (MASK_RE.test(text)) problems.push({ where, reason: 'holds a redaction mask; use a pseudonym' });
    for (const id of extractIdShaped(text)) {
      if (!inScope(scope, id)) problems.push({ where, reason: `${id.kind} id not in id_chain`, masked: maskId(id) });
    }
  });
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
