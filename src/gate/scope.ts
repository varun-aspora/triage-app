// Scope rule (HLD 02 §3, D26, birds-eye rule 10). Every id-shaped value a
// data tool is asked to use must belong to the run's ID chain, so the
// investigation stays on the ticket's customer and ids smuggled in through the
// thread text are refused. The only way around it is an explicit systemic
// SQL call, which is limited to aggregate-only select lists. A systemic
// logs_search is limited to count, group_by or count_distinct and still has
// its ids checked, because a multi-field group_by over one customer's id is
// close to reading their lines (D76).
//
// One exception (D77): a value in a logs_search correlation field (x_req_id,
// x_txn_id and the hyphenated forms), or a terms value that is exactly one id,
// is also in scope when an earlier logs_search result in the same run showed
// it in a correlation field. The terms form is how RTL and ATSPL search a UUID
// (Q8, D76). Those values are kept in a process-level registry keyed by
// run_id, like the run budgets, and dropped when the run settles.
//
// The same registry holds journey keys (D77, owner answer Q13): a value under
// device_id, x-device-id or verification_id in a logs_search hit or an
// sql_select row. They belong to one customer, so they are recorded only from
// a result fetched by a chain id; for sql_select, only when the parser found a
// chain id in a WHERE equality that ties every row (rowKeys in sql.ts). Once
// recorded, such a value is in scope in a logs_search field of those names, a
// whole terms value or contains, and in an sql_select only as a $n param
// compared to a device_id or verification_id column (journeyParams).
//
// One more exception (D89): an sql_select that reads only tables its service
// lists in scope_exempt_tables (config tables with no customer data) skips the
// id check.
//
// logs_search also gets two checks for what Quickwit matches beyond the whole
// value (D76): a UUID written with spaces or other separators (the tokeniser
// splits on them), and a contains fragment, which is a substring match.
// No I/O, no config.
import type { KnownIdKey, RunId } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
import type { RowKeys } from './sql.ts';
import { extractIdShaped, lastDigits, PHONE_DIGITS, type IdKind, type IdShaped } from './id-patterns.ts';

// Values are grouped by how they compare: UUIDs, emails, and numbers (digit
// runs and phones share one group so a +91 phone matches its 10 bare digits).
export type ScopeSet = Readonly<{
  uuid: ReadonlySet<string>;
  num: ReadonlySet<string>;
  email: ReadonlySet<string>;
}>;

export type LogsMode = 'search' | 'count' | 'group_by';

export const SCOPED_TOOLS = ['sql_select', 'http_call', 'logs_search', 'cbs_call'] as const;
export type ScopedTool = (typeof SCOPED_TOOLS)[number];

export type ScopeCheckInput = {
  tool: string;
  // The tool's validated input object.
  params: unknown;
  scopeSet: ScopeSet;
  systemic?: boolean;
  // Set by the SQL parser check: true when the select list is aggregate-only.
  sqlAggregateOnly?: boolean;
  logsMode?: LogsMode;
  // Correlation ids and journey keys seen in earlier results of the run (observedIds).
  observed?: ReadonlySet<string>;
  // Set by the SQL parser check: the $n params compared only to a device_id or
  // verification_id column. Only these may be journey keys (Q13).
  sqlJourneyParams?: readonly number[];
  // Set by sql_select: every table the query reads is on its service's
  // scope_exempt_tables (onlyExemptTables, D89).
  sqlConfigTablesOnly?: boolean;
};

export type ScopeOffender = { kind: IdKind; masked: string };

export type ScopeCheckResult = { ok: true } | { ok: false; reason: string; offending: ScopeOffender[] };

type Group = keyof ScopeSet;

function groupOf(kind: IdKind): Group {
  if (kind === 'uuid') return 'uuid';
  if (kind === 'email') return 'email';
  return 'num';
}

// The values one chain entry adds. A phone adds both its full digits and its
// last 10, so the chain can hold it with or without the country code.
function chainValues(key: KnownIdKey, value: string): { group: Group; value: string }[] {
  const out: { group: Group; value: string }[] = [];
  for (const found of extractIdShaped(value)) {
    out.push({ group: groupOf(found.kind), value: found.normalised });
    if (found.kind === 'phone' || (key === 'phone_number' && found.kind === 'digits')) {
      const all = found.raw.replace(/\D/g, '');
      out.push({ group: 'num', value: all });
      if (all.length > PHONE_DIGITS) out.push({ group: 'num', value: lastDigits(all) });
    }
  }
  return out;
}

function build(base: ScopeSet | undefined, chain: IdChain): ScopeSet {
  const groups = { uuid: new Set(base?.uuid), num: new Set(base?.num), email: new Set(base?.email) };
  // Only chain.ids carries values; hops name keys only. Every id is taken
  // whatever the status of the hop that produced it.
  for (const [key, value] of Object.entries(chain.ids)) {
    if (typeof value !== 'string') continue;
    for (const entry of chainValues(key as KnownIdKey, value)) groups[entry.group].add(entry.value);
  }
  return Object.freeze(groups);
}

// Built from the IdChain only. There is deliberately no way to add a value
// from the thread text or the model.
export function createScopeSet(idChain: IdChain): ScopeSet {
  return build(undefined, idChain);
}

// Returns a new set with the ids of a later IdChain (a resolve_identity re-run)
// added. Earlier ids stay in scope.
export function extendScopeSet(set: ScopeSet, idChain: IdChain): ScopeSet {
  return build(set, idChain);
}

export function inScope(set: ScopeSet, id: IdShaped): boolean {
  return set[groupOf(id.kind)].has(id.normalised);
}

// Kind plus the last 4 characters, so an audit line never carries a full
// foreign id.
export function maskId(id: Pick<IdShaped, 'kind' | 'normalised'>): string {
  const keep = Math.min(4, Math.floor(id.normalised.length / 2));
  return `${id.kind}:***${keep > 0 ? id.normalised.slice(-keep) : ''}`;
}

// ------------------------------------------------------ correlation ids (D77)

export const CORRELATION_FIELDS: readonly string[] = ['x_req_id', 'x_txn_id', 'x-req-id', 'x-txn-id'];

const observedByRun = new Map<RunId, Set<string>>();

function observedKey(id: IdShaped): string {
  return `${groupOf(id.kind)}:${id.normalised}`;
}

function remember(runId: RunId, key: string): void {
  let set = observedByRun.get(runId);
  if (set === undefined) observedByRun.set(runId, (set = new Set()));
  set.add(key);
}

/** Records the id-shaped values in the correlation fields of these hits for the run. */
export function observeCorrelationIds(runId: RunId, hits: readonly unknown[]): void {
  for (const hit of hits) {
    if (hit === null || typeof hit !== 'object' || Array.isArray(hit)) continue;
    for (const name of CORRELATION_FIELDS) {
      const value = (hit as Record<string, unknown>)[name];
      if (typeof value !== 'string') continue;
      for (const id of extractIdShaped(value)) remember(runId, observedKey(id));
    }
  }
}

const CORRELATION_NOTE =
  `a correlation id (${CORRELATION_FIELDS.slice(0, -1).join(', ')} or ${CORRELATION_FIELDS.at(-1)}) is allowed in fields, ` +
  'or as a whole terms value, only once an earlier logs_search result in this run has shown it';

// ------------------------------------------------------ journey keys (D77, Q13)

export const JOURNEY_FIELDS: readonly string[] = ['device_id', 'x-device-id', 'verification_id'];

const JOURNEY_NOTE =
  `a device or verification id (${JOURNEY_FIELDS.slice(0, -1).join(', ')} or ${JOURNEY_FIELDS.at(-1)}) is allowed only once ` +
  'an earlier logs_search or sql_select result in this run, fetched by an id from the chain, has shown it under one of those keys, ' +
  'and then only in a logs_search field of those names, a whole terms value or contains, or as an sql_select $n param ' +
  'compared to a device_id or verification_id column';

function journeyKey(id: IdShaped): string {
  return `journey:${observedKey(id)}`;
}

function hasChainId(value: unknown, set: ScopeSet): boolean {
  return extractIdShaped(value).some((id) => inScope(set, id));
}

// True when every result of the call is tied to a chain id: for sql_select a
// row key (a WHERE equality the parser found) bound to a chain id, for
// logs_search a chain id in a part that all hits must match (terms, fields,
// message, error, or an any_of group whose every value is a chain id).
// exclude, contains and systemic calls do not count.
function fetchedByChainId(tool: string, params: unknown, set: ScopeSet, rowKeys: RowKeys | undefined): boolean {
  if (field(params, 'scope') === 'systemic') return false;
  if (tool === 'sql_select') {
    if (rowKeys === undefined) return false;
    const bound = field(params, 'params');
    return hasChainId([...rowKeys.params.map((n) => (Array.isArray(bound) ? bound[n - 1] : undefined)), ...rowKeys.literals], set);
  }
  if (tool !== 'logs_search') return false;
  if (['terms', 'fields', 'message', 'error'].some((name) => hasChainId(field(params, name), set))) return true;
  const anyOf = field(params, 'any_of');
  if (!Array.isArray(anyOf)) return false;
  return anyOf.some((group) => {
    const values = strings([field(group, 'message'), field(group, 'terms')]);
    return values.length > 0 && values.every((s) => hasChainId(s, set));
  });
}

/**
 * Records the device and verification ids in these hits or rows for the run,
 * when the call that fetched them was tied to a chain id (Q13). rowKeys is the
 * SQL parser's rowKeys for an sql_select.
 */
export function observeJourneyKeys(
  runId: RunId,
  tool: string,
  params: unknown,
  set: ScopeSet,
  records: readonly unknown[],
  rowKeys?: RowKeys,
): void {
  if (!fetchedByChainId(tool, params, set, rowKeys)) return;
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    for (const name of JOURNEY_FIELDS) {
      for (const id of extractIdShaped((record as Record<string, unknown>)[name])) remember(runId, journeyKey(id));
    }
  }
}

/** The correlation ids and journey keys seen so far in the run's results. */
export function observedIds(runId: RunId): ReadonlySet<string> | undefined {
  return observedByRun.get(runId);
}

/** Drops a settled run's observed ids. Returns false when there were none. */
export function releaseObservedIds(runId: RunId): boolean {
  return observedByRun.delete(runId);
}

function field(params: unknown, name: string): unknown {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined;
  return (params as Record<string, unknown>)[name];
}

// Path segments are also checked percent-decoded, so %2D and friends do not
// hide an id.
function pathParts(path: unknown): unknown[] {
  if (typeof path !== 'string') return [path];
  const parts: unknown[] = [path];
  for (const segment of path.split(/[/?&=#;]/)) {
    if (!segment.includes('%')) continue;
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      // A malformed escape cannot be decoded by the connector either.
    }
  }
  return parts;
}

// The parts of each tool's input that are checked for ids; logs_search uses logsParts.
function checkedValues(tool: string, params: unknown): unknown[] {
  switch (tool) {
    case 'http_call':
      return [...pathParts(field(params, 'path')), field(params, 'query'), field(params, 'body')];
    case 'cbs_call':
      return [...pathParts(field(params, 'path')), field(params, 'body')];
    default:
      // A tool this rule does not know gets its whole input checked.
      return [params];
  }
}

function fieldEntries(params: unknown): [string, unknown][] {
  const fields = field(params, 'fields');
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return fields === undefined ? [] : [['', fields]];
  return Object.entries(fields as Record<string, unknown>);
}

// A terms value that is exactly one id-shaped value.
function wholeId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const ids = extractIdShaped(value);
  return ids.length === 1 && ids[0]?.raw === value.trim();
}

// Which observed ids a value may be: a correlation id, a journey key, or
// either (a whole terms value).
type SeenAs = 'correlation' | 'journey' | 'either';

// One checked input value. An id in it is in scope when it is in the chain, or
// when accepts is set and an earlier result showed it as that. note is added to
// the refusal when an id in it is refused.
type Part = { value: unknown; accepts?: SeenAs; note?: string };

// Every logs_search input that holds a searched value, free text included
// (D76). Values that may also be observed ids (D77): the correlation and
// journey fields, terms values (any_of terms too) that are exactly one id, and
// a whole journey key in contains.
function logsParts(params: unknown): Part[] {
  const parts: Part[] = ['message', 'error', 'exclude'].map((name) => ({ value: field(params, name) }));
  parts.push({ value: field(params, 'contains'), accepts: 'journey' });
  const sortTerms = (terms: unknown): void => {
    if (!Array.isArray(terms)) return void parts.push({ value: terms });
    for (const t of terms) parts.push(wholeId(t) ? { value: t, accepts: 'either', note: CORRELATION_NOTE } : { value: t });
  };
  sortTerms(field(params, 'terms'));
  const anyOf = field(params, 'any_of');
  if (!Array.isArray(anyOf)) parts.push({ value: anyOf });
  else {
    for (const group of anyOf) {
      if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        parts.push({ value: group });
        continue;
      }
      const { terms, ...rest } = group as Record<string, unknown>;
      parts.push({ value: rest });
      sortTerms(terms);
    }
  }
  for (const [name, value] of fieldEntries(params)) {
    if (CORRELATION_FIELDS.includes(name)) parts.push({ value, accepts: 'correlation', note: CORRELATION_NOTE });
    else if (JOURNEY_FIELDS.includes(name)) parts.push({ value, accepts: 'journey', note: JOURNEY_NOTE });
    else parts.push({ value });
  }
  return parts;
}

// sql_select: the SQL text and the bound params. Only a param the parser
// found compared to a device_id or verification_id column may be a journey key
// (Q13). The journey note is given for such a param, or for an id in a query
// that names one of those columns.
function sqlParts(input: ScopeCheckInput): Part[] {
  const sql = field(input.params, 'sql');
  const params = field(input.params, 'params');
  const journey = new Set(input.sqlJourneyParams ?? []);
  const parts: Part[] = [typeof sql === 'string' && /device_id|verification_id/i.test(sql) ? { value: sql, note: JOURNEY_NOTE } : { value: sql }];
  if (!Array.isArray(params)) parts.push({ value: params });
  else params.forEach((value, i) => parts.push(journey.has(i + 1) ? { value, accepts: 'journey', note: JOURNEY_NOTE } : { value }));
  return parts;
}

function wasSeen(observed: ReadonlySet<string> | undefined, id: IdShaped, as: SeenAs): boolean {
  if (observed === undefined) return false;
  const correlation = as !== 'journey' && observed.has(observedKey(id));
  return correlation || (as !== 'correlation' && observed.has(journeyKey(id)));
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

// Quickwit splits a value on anything that is not a letter or digit, so
// '26caff50 d980 4c95 ...' matches the same tokens as the dashed UUID. Only
// the UUIDs of the rejoined form are taken; the value itself is checked as is.
function rejoinedUuids(value: unknown): IdShaped[] {
  return strings(value).flatMap((s) => extractIdShaped(s.replace(/[^0-9a-z]+/gi, '-')).filter((id) => id.kind === 'uuid'));
}

// contains is a substring match on raw_message, so a piece of an id finds the
// lines that hold the whole id. A run of 6 or more digits, of 8 or more hex
// characters and dashes, or an @ is an id fragment; it is in scope only as
// part of an id in the chain or an observed id.
const FRAGMENTS: readonly [RegExp, IdKind][] = [
  [/\d{6,}/g, 'digits'],
  [/[0-9a-f-]{8,}/gi, 'uuid'],
];

function containsFragments(params: unknown): IdShaped[] {
  const value = field(params, 'contains');
  if (typeof value !== 'string') return [];
  const out: IdShaped[] = [];
  for (const [re, kind] of FRAGMENTS) {
    for (const m of value.matchAll(re)) {
      // An all-digit run is already a digits fragment.
      if (kind === 'uuid' && /^\d+$/.test(m[0])) continue;
      out.push({ kind, raw: m[0], normalised: m[0].toLowerCase() });
    }
  }
  if (value.includes('@')) out.push({ kind: 'email', raw: value, normalised: value.trim().toLowerCase() });
  return out;
}

function partOfKnownId(fragment: string, set: ScopeSet, observed: ReadonlySet<string> | undefined): boolean {
  for (const group of [set.uuid, set.num, set.email]) for (const id of group) if (id.includes(fragment)) return true;
  for (const key of observed ?? []) if (key.slice(key.lastIndexOf(':') + 1).includes(fragment)) return true;
  return false;
}

function systemicDecision(input: ScopeCheckInput): ScopeCheckResult | undefined {
  if (!input.systemic) return undefined;
  if (input.tool === 'sql_select') {
    if (input.sqlAggregateOnly === true) return { ok: true };
    return {
      ok: false,
      reason: 'scope: systemic sql_select allows only an aggregate-only select list',
      offending: [],
    };
  }
  if (input.tool === 'logs_search') {
    const mode = input.logsMode ?? 'search';
    // The ids are still checked (D76).
    if (mode === 'count' || mode === 'group_by') return undefined;
    return {
      ok: false,
      reason: 'scope: systemic logs_search allows only count or group_by, not search',
      offending: [],
    };
  }
  // Systemic does not apply to other tools; their ids are checked as usual.
  return undefined;
}

// A query that reads only config tables the registry lists for its service
// has no customer id to check (D89). One other table, joined or in a
// subquery, and the ids are checked as usual.
export function onlyExemptTables(tables: readonly string[], exempt: readonly string[]): boolean {
  return tables.length > 0 && tables.every((t) => exempt.includes(t));
}

export function checkScope(input: ScopeCheckInput): ScopeCheckResult {
  const systemic = systemicDecision(input);
  if (systemic) return systemic;
  if (input.sqlConfigTablesOnly === true) return { ok: true };

  const offending: ScopeOffender[] = [];
  const reported = new Set<string>();
  const offend = (id: IdShaped): void => {
    const key = observedKey(id);
    if (reported.has(key)) return;
    reported.add(key);
    offending.push({ kind: id.kind, masked: maskId(id) });
  };
  const logs = input.tool === 'logs_search';
  const parts = logs
    ? logsParts(input.params)
    : input.tool === 'sql_select'
      ? sqlParts(input)
      : checkedValues(input.tool, input.params).map((value): Part => ({ value }));
  const idsOf = (value: unknown): IdShaped[] => (logs ? [...extractIdShaped(value), ...rejoinedUuids(value)] : extractIdShaped(value));
  const notes = new Set<string>();
  for (const part of parts) {
    for (const id of idsOf(part.value)) {
      if (inScope(input.scopeSet, id) || (part.accepts !== undefined && wasSeen(input.observed, id, part.accepts))) continue;
      offend(id);
      if (part.note !== undefined) notes.add(part.note);
    }
  }
  if (logs) {
    const fragments = containsFragments(input.params).filter((piece) => !partOfKnownId(piece.normalised, input.scopeSet, input.observed));
    for (const piece of fragments) offend(piece);
    if (fragments.length > 0) {
      notes.add('contains is a substring match, so a run of 6 or more digits, 8 or more hex characters, or an @ in it must be part of an id in the chain');
    }
    if (input.systemic === true) notes.add('scope "systemic" does not lift the id check for logs_search');
  }
  if (offending.length === 0) return { ok: true };
  const noun = offending.length === 1 ? 'id is' : 'ids are';
  return {
    ok: false,
    reason: `scope: ${offending.length} ${noun} not in the run's ID chain for ${input.tool} (${offending
      .map((o) => o.masked)
      .join(', ')})${[...notes].map((n) => `; ${n}`).join('')}`,
    offending,
  };
}
