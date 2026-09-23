// The two redaction profiles and the egress check (HLD 02 §3, D24, A11).
//
// Model-facing: masks secrets, PAN, card numbers, passports and the email
// local part. Account numbers, UTRs, phones, UUIDs and names stay visible,
// because the investigation searches with them.
//
// Persisted (also the egress check): everything above plus the whole email,
// phones, runs of 6+ digits (****last4), supplied names and postcode-matched
// address lines.
//
// Both profiles decode before scanning (redact-decode.ts): an encoded part
// that hides a match is replaced by its decoded, masked text. They deep-walk
// arrays and plain objects, never alter keys, and leave numbers, booleans and
// null as they are. Numbers are not scanned, so ids must travel as strings.
//
// checkEgress reports which patterns redactPersisted would still mask and at
// which JSON paths. It never returns matched text. It is ok exactly when
// redactPersisted would change nothing.

import { MAX_DECODE_DEPTH, jsonUnescape, replaceBase64Blobs, urlDecode } from './redact-decode.ts';
import {
  PATTERN_NAMES,
  card,
  compileNames,
  credential,
  digits6,
  email,
  hexTokenSpans,
  maskEmailLocal,
  name,
  pan,
  passport,
  phone,
  postcodeAddress,
  uuidSpans,
  type Detector,
  type PatternName,
  type Span,
} from './redact-patterns.ts';

export type { PatternName } from './redact-patterns.ts';

// ------------------------------------------------------------------ Persisted<T>

const MINT: unique symbol = Symbol('persisted-mint');

class PersistedBox<T> {
  readonly #value: T;

  constructor(mint: typeof MINT, value: T) {
    if (mint !== MINT) throw new Error('Persisted values come from redactPersisted only');
    this.#value = value;
    Object.freeze(this);
  }

  /** The redacted value. */
  get value(): T {
    return this.#value;
  }

  toJSON(): T {
    return this.#value;
  }
}

/**
 * A value that has been through the persisted profile. Only redactPersisted
 * makes one: the constructor needs a unique symbol this module keeps, and the
 * private field makes the type nominal, so `x as Persisted<X>` does not
 * compile. Read the redacted value with `.value`.
 */
export type Persisted<T> = PersistedBox<T>;

export function isPersisted(value: unknown): value is Persisted<unknown> {
  return value instanceof PersistedBox;
}

// ------------------------------------------------------------------ profiles

type ProfileEntry = { readonly detector: Detector; readonly mask: (text: string) => string };
type Profile = readonly ProfileEntry[];

const use = (detector: Detector, mask: (text: string) => string = detector.mask): ProfileEntry => ({ detector, mask });

// Order matters: each detector runs on the output of the ones before it.
// Addresses go before phones and digits so the postcode is still there.
const MODEL_FACING: Profile = [use(credential), use(email, maskEmailLocal), use(pan), use(card), use(passport)];

const PERSISTED: Profile = [
  use(credential),
  use(email),
  use(pan),
  use(card),
  use(postcodeAddress),
  use(phone),
  use(passport),
  use(name),
  use(digits6),
];

type Scan = { readonly profile: Profile; readonly names: RegExp | null };
type Redacted = { readonly text: string; readonly hits: ReadonlySet<PatternName> };

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function guardSpans(s: string, detector: Detector): Span[] {
  if (detector.guard === 'none') return [];
  const spans = uuidSpans(s);
  return detector.guard === 'uuid+hex' ? [...spans, ...hexTokenSpans(s)] : spans;
}

/** Runs the profile's detectors over raw text, without decoding. */
function maskRaw(s: string, scan: Scan): Redacted {
  const hits = new Set<PatternName>();
  let t = s;
  for (const { detector, mask } of scan.profile) {
    const guards = guardSpans(t, detector);
    const spans = detector
      .find(t, { names: scan.names })
      .filter((sp) => sp.end > sp.start && !guards.some((g) => overlaps(g, sp)))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    let out = '';
    let at = 0;
    for (const sp of spans) {
      if (sp.start < at) continue;
      const text = t.slice(sp.start, sp.end);
      const masked = mask(text);
      if (masked === text) continue;
      out += t.slice(at, sp.start) + masked;
      at = sp.end;
      hits.add(detector.name);
    }
    if (at > 0) t = out + t.slice(at);
  }
  return { text: t, hits };
}

/**
 * Redacts one string. Base64 blobs that hide a match are replaced by their
 * decoded, masked text. For URL and JSON escapes, the decoded form is kept
 * only when decoding reveals something that masking the raw text misses.
 */
function redactText(s: string, scan: Scan, depth: number): Redacted {
  const hits = new Set<PatternName>();
  let t = s;
  if (depth < MAX_DECODE_DEPTH) {
    t = replaceBase64Blobs(t, (blob, decoded) => {
      const inner = redactText(decoded, scan, depth + 1);
      if (inner.text === decoded) return blob;
      for (const h of inner.hits) hits.add(h);
      return inner.text;
    });
    for (const decode of [urlDecode, jsonUnescape]) {
      const d = decode(t);
      if (d === t) continue;
      const inner = redactText(d, scan, depth + 1);
      if (decode(maskRaw(t, scan).text) !== inner.text) {
        for (const h of inner.hits) hits.add(h);
        return { text: inner.text, hits };
      }
    }
  }
  const raw = maskRaw(t, scan);
  for (const h of raw.hits) hits.add(h);
  return { text: raw.text, hits };
}

const MAX_PASSES = 4;

function redactString(s: string, scan: Scan): Redacted {
  const hits = new Set<PatternName>();
  let t = s;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const r = redactText(t, scan, 0);
    for (const h of r.hits) hits.add(h);
    if (r.text === t) break;
    t = r.text;
  }
  return { text: t, hits };
}

// ------------------------------------------------------------------ deep walk

type Visit = (s: string, path: string) => string;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function mapDeep(value: unknown, path: string, visit: Visit, keyPath: (key: string) => string, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return visit(value, path);
  if (value === null || typeof value !== 'object') return value;
  const done = seen.get(value);
  if (done !== undefined) return done;
  if (value instanceof PersistedBox) {
    const inner = mapDeep(value.value, path, visit, keyPath, seen);
    const box = new PersistedBox(MINT, inner);
    seen.set(value, box);
    return box;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    value.forEach((item, i) => {
      out.push(mapDeep(item, `${path}[${i}]`, visit, keyPath, seen));
    });
    return out;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  seen.set(value, out);
  for (const key of Object.keys(value)) {
    // defineProperty, so a '__proto__' key stays an own property.
    Object.defineProperty(out, key, {
      value: mapDeep(value[key], path + keyPath(key), visit, keyPath, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function walk(value: unknown, scan: Scan, onHits?: (hits: ReadonlySet<PatternName>, path: string) => void): unknown {
  // A key that itself holds something the persisted profile would mask is
  // shown as [*] in paths, so a path never carries a value.
  // Paths are only built for the check.
  const persistedKeys: Scan = { profile: PERSISTED, names: scan.names };
  const keyPath = (key: string): string => {
    if (!onHits) return '';
    if (redactString(key, persistedKeys).hits.size > 0) return '[*]';
    return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  };
  return mapDeep(
    value,
    '$',
    (s, path) => {
      const r = redactString(s, scan);
      if (onHits && r.hits.size > 0) onHits(r.hits, path);
      return r.text;
    },
    keyPath,
    new WeakMap(),
  );
}

// ------------------------------------------------------------------ public API

export type PersistedOptions = {
  /** Names collected by ingress (Slack profiles, bot template fields). */
  readonly names?: readonly string[];
};

export type EgressResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly unmasked: PatternName[]; readonly paths: string[] };

/** The model-facing profile. Returns a redacted copy; the input is not changed. */
export function redactModelFacing<T>(value: T): T {
  return walk(value, { profile: MODEL_FACING, names: null }) as T;
}

/** The persisted profile, and the only producer of Persisted<T>. */
export function redactPersisted<T>(value: T, opts: PersistedOptions = {}): Persisted<T> {
  const redacted = walk(value, { profile: PERSISTED, names: compileNames(opts.names) }) as T;
  return new PersistedBox(MINT, redacted);
}

/**
 * The egress check: which persisted-profile patterns are still unmasked, and
 * where. Returns pattern names and JSON paths only, never the matched text.
 */
export function checkEgress(value: unknown, opts: PersistedOptions = {}): EgressResult {
  const found = new Set<PatternName>();
  const paths: string[] = [];
  walk(value, { profile: PERSISTED, names: compileNames(opts.names) }, (hits, path) => {
    for (const h of hits) found.add(h);
    if (!paths.includes(path)) paths.push(path);
  });
  if (found.size === 0) return { ok: true };
  return { ok: false, unmasked: PATTERN_NAMES.filter((p) => found.has(p)), paths };
}
