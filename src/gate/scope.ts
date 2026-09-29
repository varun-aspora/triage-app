// Scope rule (HLD 02 §3, D26, birds-eye rule 10). Every id-shaped value a
// data tool is asked to use must belong to the run's ID chain, so the
// investigation stays on the case. In scope are the chain's ids, every seed
// lead (D96: an id-shaped value the requester wrote in the thread, an
// ask_requester answer or hints.ids, whether or not a known id key took it)
// and every derived lead (D97, below). Model text never adds a value; an id
// that appears only there is refused. The only way around it is an explicit
// systemic SQL call, which is limited to aggregate-only select lists. A
// systemic logs_search is limited to count, group_by or count_distinct and
// still has its ids checked, because a multi-field group_by over one
// customer's id is close to reading their lines (D76).
//
// Derived leads (D97): an id-shaped value in any field of a result becomes a
// lead, in scope for later calls, when the call that fetched it was tied to
// an id already in scope. For sql_select that is a row key (a WHERE equality
// the parser found, rowKeys in sql.ts) bound to an in-scope id; a join counts
// when the row key is on the anchor. For logs_search it is an in-scope id in
// a part every hit must match: terms, fields, message, error, or an any_of
// group whose every value is in scope. Systemic calls, contains and exclude
// never tie a call. A chain id or seed has depth 0 and a derived lead one more
// than the smallest depth of the ids that tied its call; nothing is added past
// TRIAGE_MAX_LEAD_DEPTH. A field of one result with more new values than
// TRIAGE_MAX_DERIVED_PER_FIELD adds none. Another customer's id found this way
// (a referral's other user, a transfer's beneficiary) is allowed. deriveLeads
// is pure; the pipeline adds what it returns to the run's chain (addLeads in
// src/tools/_lib/context.ts), so derived leads persist with it and survive a
// settle and a resume.
//
// One exception (D77): a value in a logs_search correlation field (x_req_id,
// x_txn_id and the hyphenated forms), or a terms value that is exactly one id,
// is also in scope when an earlier logs_search result in the same run showed
// it in a correlation field. The terms form is how RTL and ATSPL search a UUID
// (Q8, D76). Those values are kept in a process-level registry keyed by
// run_id, like the run budgets, and dropped when the run settles. They are
// logs-only trace ids and never become leads.
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
import type { IdChain, Lead } from '../types/id-chain.ts';
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

export const SCOPED_TOOLS = ['sql_select', 'http_call', 'logs_search'] as const;
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
  // Correlation ids seen in earlier results of the run (observedIds).
  observed?: ReadonlySet<string>;
  // TRIAGE_MAX_LEAD_DEPTH, for the refusal text. Defaults to DEFAULT_LEAD_DEPTH.
  maxLeadDepth?: number;
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
// last 10, so the chain can hold it with or without the country code. The
// identity step compares leads with the same forms (D96).
export function chainValues(key: KnownIdKey | undefined, value: string): { group: Group; value: string }[] {
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
  for (const entry of chainEntries(chain)) groups[entry.group].add(entry.value);
  return Object.freeze(groups);
}

// chain.ids and chain.leads carry values; hops name keys only. Every id is
// taken whatever the status of the hop that produced it. depth is 0 for ids
// and seeds, a derived lead's own depth otherwise.
function chainEntries(chain: IdChain): { group: Group; value: string; depth: number }[] {
  const out: { group: Group; value: string; depth: number }[] = [];
  for (const [key, value] of Object.entries(chain.ids)) {
    if (typeof value !== 'string') continue;
    for (const entry of chainValues(key as KnownIdKey, value)) out.push({ ...entry, depth: 0 });
  }
  for (const lead of chain.leads ?? []) {
    for (const entry of chainValues(lead.key, lead.value)) out.push({ ...entry, depth: lead.depth ?? 0 });
  }
  return out;
}

// Built from the IdChain only: its ids, its seed leads, which come from the
// requester's own text (D96), and its derived leads (D97). There is
// deliberately no way to add a value from model text.
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

// ------------------------------------------------------ derived leads (D97)

/** TRIAGE_MAX_LEAD_DEPTH's default, for a caller that passes no limit. */
export const DEFAULT_LEAD_DEPTH = 3;

export type LeadLimits = {
  /** TRIAGE_MAX_LEAD_DEPTH: the deepest a derived lead may be. */
  readonly maxDepth: number;
  /** TRIAGE_MAX_DERIVED_PER_FIELD: a field of one result with more new values adds none. */
  readonly maxPerField: number;
};

/** The call whose result is read for leads. */
export type LeadCall = {
  /** The bare tool name. Only sql_select and logs_search can be tied. */
  readonly tool: string;
  readonly toolCallId: string;
  /** The tool's validated input. */
  readonly params: unknown;
  /** From the SQL parser, for sql_select. */
  readonly rowKeys?: RowKeys;
  readonly systemic?: boolean;
};

/** A field that added nothing: over the fan-out limit, or past the depth limit. Counts only. */
export type LeadSkip = { readonly reason: 'fan-out' | 'depth'; readonly field: string; readonly count: number };

export type DerivedLeads = { readonly leads: Lead[]; readonly skipped: LeadSkip[] };

function inScopeIds(value: unknown, set: ScopeSet): IdShaped[] {
  return extractIdShaped(value).filter((id) => inScope(set, id));
}

// A fields value of the form [<number> TO <number>] is a range, not one value.
const FIELD_RANGE = /^\s*\[.*\bTO\b.*\]\s*$/;

// The in-scope ids that tie every result of the call to them: for sql_select
// those bound to a row key (a WHERE equality the parser found), for
// logs_search those in a part all hits must match (terms, fields other than
// a range, message, error, or an any_of group whose every value holds one).
// The builder ORs denoise "with_message" with the message, and an any_of
// group's level and service values with its other values, so those tie
// nothing. exclude, contains and systemic calls tie nothing either. Empty
// when the call is not tied.
function tyingIds(call: LeadCall, set: ScopeSet): IdShaped[] {
  if (call.systemic === true || field(call.params, 'scope') === 'systemic') return [];
  if (call.tool === 'sql_select') {
    if (call.rowKeys === undefined) return [];
    const bound = field(call.params, 'params');
    const values = call.rowKeys.params.map((n) => (Array.isArray(bound) ? bound[n - 1] : undefined));
    return inScopeIds([...values, ...call.rowKeys.literals], set);
  }
  if (call.tool !== 'logs_search') return [];
  const fields = field(call.params, 'fields');
  const fieldValues = fields !== null && typeof fields === 'object' ? Object.values(fields).filter((f) => !FIELD_RANGE.test(String(f))) : [];
  const message = field(call.params, 'denoise') === 'with_message' ? undefined : field(call.params, 'message');
  const out = [field(call.params, 'terms'), fieldValues, message, field(call.params, 'error')].flatMap((value) => inScopeIds(value, set));
  const anyOf = field(call.params, 'any_of');
  for (const group of Array.isArray(anyOf) ? anyOf : []) {
    if (strings([field(group, 'level'), field(group, 'service')]).length > 0) continue;
    const perValue = strings([field(group, 'message'), field(group, 'terms')]).map((s) => inScopeIds(s, set));
    if (perValue.length > 0 && perValue.every((ids) => ids.length > 0)) out.push(...perValue.flat());
  }
  return out;
}

// The id-shaped values under each field of a record. A nested object's
// fields are named by their dotted path; array items share their field.
// Object keys are not values and are not read, and a key that is itself an
// id (a map keyed by user id) is named '*', so a field name never carries one.
function fieldIds(value: unknown, path: string, out: Map<string, IdShaped[]>): void {
  if (Array.isArray(value)) return value.forEach((item) => fieldIds(item, path, out));
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const name = extractIdShaped(key).length > 0 ? '*' : key;
      fieldIds(item, path === '' ? name : `${path}.${name}`, out);
    }
    return;
  }
  const ids = extractIdShaped(value);
  if (ids.length > 0) out.set(path, [...(out.get(path) ?? []), ...ids]);
}

// A phone keeps its country code, as seed leads do, so the scope set gets both forms.
function leadValue(id: IdShaped): string {
  return id.kind === 'phone' ? `+${id.raw.replace(/\D/g, '')}` : id.normalised;
}

/**
 * The derived leads in the records of one call's result (D97): every
 * id-shaped value in any field that is not already in scope, when the call
 * was tied to an in-scope id (tyingIds). Correlation fields are left to their
 * own rule. A field with more new values than limits.maxPerField adds none,
 * and nothing is added when the depth would pass limits.maxDepth; each such
 * field is returned in skipped. Pure; the caller adds the leads to the chain.
 */
export function deriveLeads(chain: IdChain, set: ScopeSet, call: LeadCall, records: readonly unknown[], limits: LeadLimits): DerivedLeads {
  const anchors = tyingIds(call, set);
  if (anchors.length === 0) return { leads: [], skipped: [] };
  const depths = new Map<string, number>();
  for (const entry of chainEntries(chain)) {
    const key = `${entry.group}:${entry.value}`;
    depths.set(key, Math.min(depths.get(key) ?? entry.depth, entry.depth));
  }
  // An id in the scope set that the chain no longer lists was a chain id.
  const parent = anchors
    .map((id) => ({ id, depth: depths.get(observedKey(id)) ?? 0 }))
    .reduce((best, next) => (next.depth < best.depth ? next : best));
  const depth = parent.depth + 1;

  const fresh = new Map<string, Map<string, IdShaped>>();
  for (const record of records) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const byField = new Map<string, IdShaped[]>();
    fieldIds(record, '', byField);
    for (const [name, ids] of byField) {
      // A correlation field keeps its own rule, nested or not.
      if (CORRELATION_FIELDS.includes(name.slice(name.lastIndexOf('.') + 1))) continue;
      for (const id of ids) {
        if (inScope(set, id)) continue;
        let values = fresh.get(name);
        if (values === undefined) fresh.set(name, (values = new Map()));
        values.set(observedKey(id), id);
      }
    }
  }

  const leads: Lead[] = [];
  const skipped: LeadSkip[] = [];
  const taken = new Set<string>();
  for (const [name, values] of fresh) {
    if (depth > limits.maxDepth) skipped.push({ reason: 'depth', field: name, count: values.size });
    else if (values.size > limits.maxPerField) skipped.push({ reason: 'fan-out', field: name, count: values.size });
    else {
      for (const [key, id] of values) {
        if (taken.has(key)) continue;
        taken.add(key);
        leads.push({
          value: leadValue(id),
          kind: id.kind,
          source: 'derived',
          status: 'derived',
          depth,
          parent: maskId(parent.id),
          via: { tool: call.tool, tool_call_id: call.toolCallId, field: name },
        });
      }
    }
  }
  return { leads, skipped };
}

/** The correlation ids seen so far in the run's results. */
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
    case 'sql_select':
      return [field(params, 'sql'), field(params, 'params')];
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

// A value that may also be a correlation id seen earlier in the run (D77):
// 'correlation' in a correlation field, where only that applies, 'either' in
// a whole terms value, which may also be a lead.
type SeenAs = 'correlation' | 'either';

// One checked input value. An id in it is in scope when it is in the chain, or
// when accepts is set and an earlier result showed it in a correlation field.
type Part = { value: unknown; accepts?: SeenAs };

// Every logs_search input that holds a searched value, free text included
// (D76). Values that may also be correlation ids (D77): the correlation
// fields, and terms values (any_of terms too) that are exactly one id.
function logsParts(params: unknown): Part[] {
  const parts: Part[] = ['message', 'error', 'exclude', 'contains'].map((name) => ({ value: field(params, name) }));
  const sortTerms = (terms: unknown): void => {
    if (!Array.isArray(terms)) return void parts.push({ value: terms });
    for (const t of terms) parts.push(wholeId(t) ? { value: t, accepts: 'either' } : { value: t });
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
    parts.push(CORRELATION_FIELDS.includes(name) ? { value, accepts: 'correlation' } : { value });
  }
  return parts;
}

// What a refused id can still become: a lead (D96, D97), or a correlation id.
function leadNote(maxDepth: number): string {
  return (
    "usable once it is in the requester's text or shows up in a result fetched by an id already in scope " +
    `(at most ${maxDepth} ${maxDepth === 1 ? 'step' : 'steps'})`
  );
}

function notesFor(accepts: SeenAs | undefined, maxDepth: number): string[] {
  if (accepts === 'correlation') return [CORRELATION_NOTE];
  return accepts === 'either' ? [leadNote(maxDepth), CORRELATION_NOTE] : [leadNote(maxDepth)];
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
  const parts = logs ? logsParts(input.params) : checkedValues(input.tool, input.params).map((value): Part => ({ value }));
  const idsOf = (value: unknown): IdShaped[] => (logs ? [...extractIdShaped(value), ...rejoinedUuids(value)] : extractIdShaped(value));
  const notes = new Set<string>();
  for (const part of parts) {
    for (const id of idsOf(part.value)) {
      if (inScope(input.scopeSet, id) || (part.accepts !== undefined && input.observed?.has(observedKey(id)) === true)) continue;
      offend(id);
      for (const note of notesFor(part.accepts, input.maxLeadDepth ?? DEFAULT_LEAD_DEPTH)) notes.add(note);
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
