// Semantic keys for fixtures (D27). Each builder takes facts the calling tool
// has already parsed (tables from the SQL AST, the built HTTP path, the
// de-duplicated search terms) and returns a normalised key, so two calls that
// ask the same question in a different order resolve to the same fixture.
//
// key_string is canonical JSON with sorted object keys. The fixture file name
// is sha256(key_string) cut to 16 hex characters.
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { Entity } from '../types/core.ts';
import {
  SEMANTIC_KEY_SCHEMAS,
  type CodeQueryCommand,
  type FixtureEntity,
  type FixtureKind,
  type LogsMode,
  type SemanticKey,
} from './types.ts';

export const HASH_LENGTH = 16;

type Scalar = string | number | boolean | null;
type PairsOrRecord = Readonly<Record<string, Scalar | readonly Scalar[]>> | readonly (readonly [string, Scalar])[];

export type SqlSelectFacts = {
  readonly entity: Entity;
  readonly service: string;
  readonly tables: readonly string[];
  readonly params: readonly Scalar[];
};

export type HttpCallFacts = {
  readonly entity: Entity;
  readonly service: string;
  readonly method: string;
  readonly path: string;
  readonly query?: PairsOrRecord;
};

export type LogsSearchFacts = {
  readonly entity: Entity;
  readonly service: string;
  readonly terms: readonly string[];
  readonly mode: LogsMode;
  readonly group_by?: string;
};

export type ResolveIdentityFacts = {
  readonly hop?: string;
  readonly ids: PairsOrRecord;
};

export type GetAccountStatementFacts = {
  readonly entity: Entity;
  readonly account_id: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: number;
};

export type DetectSilentReversalsFacts = {
  readonly entity: Entity;
  readonly account_id: string;
  readonly customer_id: string;
  readonly since?: string;
  readonly limit?: number;
};

export type CbsCallFacts = {
  readonly entity: Entity;
  readonly method?: string;
  readonly path: string;
  readonly body?: unknown;
};

export type SlackReadFacts = { readonly channel: string; readonly thread_ts: string };

export type DoctorProbeFacts = { readonly entity: FixtureEntity; readonly probe: string };

export type FieldCryptoFacts = {
  readonly op: 'encrypt' | 'decrypt';
  readonly kind?: 'phone' | 'email' | 'cif';
  readonly values: readonly string[];
};

export type CodeQueryFacts = { readonly repo: string; readonly command: CodeQueryCommand; readonly query: string };

export type SemanticKeyFacts = {
  sql_select: SqlSelectFacts;
  http_call: HttpCallFacts;
  logs_search: LogsSearchFacts;
  resolve_identity: ResolveIdentityFacts;
  get_account_statement: GetAccountStatementFacts;
  detect_silent_reversals: DetectSilentReversalsFacts;
  cbs_call: CbsCallFacts;
  slack_read: SlackReadFacts;
  doctor_probe: DoctorProbeFacts;
  field_crypto: FieldCryptoFacts;
  code_query: CodeQueryFacts;
};

/** Thrown when facts cannot form a valid key. The message names fields, never values. */
export class SemanticKeyError extends Error {
  override readonly name = 'SemanticKeyError';
  readonly kind: string;
  readonly fields: readonly string[];

  constructor(kind: string, fields: readonly string[]) {
    super(`invalid ${kind} semantic key: ${fields.join(', ')}`);
    this.kind = kind;
    this.fields = Object.freeze([...fields]);
  }
}

const BUILDERS: { [K in FixtureKind]: (facts: SemanticKeyFacts[K]) => unknown } = {
  sql_select: (f) => ({
    entity: f.entity,
    service: trim(f.service),
    tables: sortedSet(f.tables.map(trim)),
    params: [...f.params.map(paramText)].sort(compareNullable),
  }),
  http_call: (f) => ({
    entity: f.entity,
    service: trim(f.service),
    method: upper(f.method),
    path: canonicalPath(f.path),
    query: sortedPairs(f.query),
  }),
  logs_search: (f) => ({
    entity: f.entity,
    service: trim(f.service),
    terms: sortedSet(f.terms.map(trim).filter((t) => t !== '')),
    mode: f.mode,
    group_by: optionalTrim(f.group_by),
  }),
  resolve_identity: (f) => ({
    hop: optionalTrim(f.hop),
    ids: identityPairs(f.ids),
  }),
  get_account_statement: (f) => ({
    entity: f.entity,
    account_id: trim(f.account_id),
    from: optionalTrim(f.from),
    to: optionalTrim(f.to),
    page: f.page,
  }),
  detect_silent_reversals: (f) => ({
    entity: f.entity,
    account_id: trim(f.account_id),
    customer_id: trim(f.customer_id),
    since: optionalTrim(f.since),
    limit: f.limit,
  }),
  cbs_call: (f) => ({
    entity: f.entity,
    method: upper(f.method ?? 'GET'),
    path: canonicalPath(f.path),
    body: f.body,
  }),
  slack_read: (f) => ({ channel: trim(f.channel), thread_ts: trim(f.thread_ts) }),
  doctor_probe: (f) => ({ entity: f.entity, probe: trim(f.probe) }),
  // The caller has already normalised the values; their order is kept.
  field_crypto: (f) => ({ op: f.op, kind: f.kind, values: [...f.values] }),
  // Symbols are case-sensitive, so the query is trimmed and nothing more.
  code_query: (f) => ({ repo: trim(f.repo), command: f.command, query: trim(f.query) }),
};

/**
 * Builds the normalised semantic key for one call. Pure: facts in a different
 * order give the same key. A normalised key passed back in gives itself.
 */
export function semanticKey<K extends FixtureKind>(kind: K, facts: SemanticKeyFacts[K]): SemanticKey<K> {
  const build = BUILDERS[kind] as ((facts: SemanticKeyFacts[K]) => unknown) | undefined;
  if (build === undefined) throw new SemanticKeyError(String(kind), ['kind']);
  const raw = dropUndefined(build(facts));
  const parsed = v.safeParse(SEMANTIC_KEY_SCHEMAS[kind], raw);
  if (!parsed.success) {
    throw new SemanticKeyError(kind, [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))]);
  }
  return parsed.output as SemanticKey<K>;
}

/** Canonical JSON of a key: object keys sorted, undefined dropped, arrays in order. */
export function keyString(key: unknown): string {
  return canonicalJson(key);
}

/** The fixture file name (without .json) for a key. */
export function keyHash(key: unknown): string {
  return hashKeyString(keyString(key));
}

/** sha256 of an already built key_string, cut to 16 hex characters. */
export function hashKeyString(key_string: string): string {
  return createHash('sha256').update(key_string, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: numbers must be finite');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonicalJson: only plain objects, arrays and scalars are allowed');
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => compare(a, b));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not allowed`);
  }
}

/**
 * Leading slash, duplicate slashes collapsed, trailing slash removed. Case and
 * concrete ids are kept: /users/ABC/ and /users/abc are different calls.
 */
export function canonicalPath(path: string): string {
  const collapsed = `/${path.trim()}`.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

// Code-unit order, so the result does not depend on the host locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return compare(a, b);
}

function trim(s: string): string {
  return typeof s === 'string' ? s.trim() : s;
}

function optionalTrim(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = trim(s);
  return t === '' ? undefined : t;
}

function upper(s: string): string {
  return typeof s === 'string' ? s.trim().toUpperCase() : s;
}

function sortedSet(items: readonly string[]): string[] {
  return [...new Set(items)].sort(compare);
}

function paramText(p: Scalar): string | null {
  return p === null ? null : String(p);
}

function scalarText(p: Scalar): string {
  return p === null ? '' : String(p);
}

function sortedPairs(input: PairsOrRecord | undefined): [string, string][] {
  if (input === undefined) return [];
  const pairs: [string, string][] = [];
  if (Array.isArray(input)) {
    for (const [k, val] of input as readonly (readonly [string, Scalar])[]) pairs.push([trim(k), scalarText(val)]);
  } else {
    for (const [k, val] of Object.entries(input as Readonly<Record<string, Scalar | readonly Scalar[]>>)) {
      const values = Array.isArray(val) ? (val as readonly Scalar[]) : [val as Scalar];
      for (const one of values) pairs.push([trim(k), scalarText(one)]);
    }
  }
  return pairs.sort(([ak, av], [bk, bv]) => compare(ak, bk) || compare(av, bv));
}

// Identity pairs: values trimmed, blank values dropped, duplicates removed, sorted.
function identityPairs(input: PairsOrRecord): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const [k, raw] of sortedPairs(input)) {
    const val = raw.trim();
    const id = JSON.stringify([k, val]);
    if (val === '' || seen.has(id)) continue;
    seen.add(id);
    out.push([k, val]);
  }
  return out.sort(([ak, av], [bk, bv]) => compare(ak, bk) || compare(av, bv));
}

function dropUndefined(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
