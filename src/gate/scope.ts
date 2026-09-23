// Scope rule (HLD 02 §3, D26, birds-eye rule 10). Every id-shaped value a
// data tool is asked to use must belong to the run's ID chain, so the
// investigation stays on the ticket's customer and ids smuggled in through the
// thread text are refused. The only way around it is an explicit systemic call,
// which is limited to aggregate-only SQL and count or group_by log queries.
// Pure: no I/O, no config.
import type { KnownIdKey } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
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
    if (found.kind === 'phone' || (key === 'phone' && found.kind === 'digits')) {
      const all = found.raw.replace(/\D/g, '');
      out.push({ group: 'num', value: all });
      if (all.length > PHONE_DIGITS) out.push({ group: 'num', value: lastDigits(all) });
    }
  }
  return out;
}

function build(base: ScopeSet | undefined, chain: IdChain): ScopeSet {
  const uuid = new Set(base?.uuid);
  const num = new Set(base?.num);
  const email = new Set(base?.email);
  const groups = { uuid, num, email };
  // Only chain.ids carries values; hops name keys only. Every id is taken
  // whatever the status of the hop that produced it.
  for (const [key, value] of Object.entries(chain.ids)) {
    if (typeof value !== 'string') continue;
    for (const entry of chainValues(key as KnownIdKey, value)) groups[entry.group].add(entry.value);
  }
  return Object.freeze({ uuid, num, email });
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

// The parts of each tool's input that are checked for ids.
function checkedValues(tool: string, params: unknown): unknown[] {
  switch (tool) {
    case 'sql_select':
      // Bound $n params and literals written into the SQL text.
      return [field(params, 'params'), field(params, 'sql')];
    case 'http_call':
      return [...pathParts(field(params, 'path')), field(params, 'query'), field(params, 'body')];
    case 'logs_search':
      // message and error are free-text search strings, so they are checked
      // alongside terms and fields.
      return [field(params, 'terms'), field(params, 'fields'), field(params, 'message'), field(params, 'error')];
    case 'cbs_call':
      return [...pathParts(field(params, 'path')), field(params, 'body')];
    default:
      // A tool this rule does not know gets its whole input checked.
      return [params];
  }
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
    if (mode === 'count' || mode === 'group_by') return { ok: true };
    return {
      ok: false,
      reason: 'scope: systemic logs_search allows only count or group_by, not search',
      offending: [],
    };
  }
  // Systemic does not apply to other tools; their ids are checked as usual.
  return undefined;
}

export function checkScope(input: ScopeCheckInput): ScopeCheckResult {
  const systemic = systemicDecision(input);
  if (systemic) return systemic;

  const offending: ScopeOffender[] = [];
  const seen = new Set<string>();
  for (const value of checkedValues(input.tool, input.params)) {
    for (const id of extractIdShaped(value)) {
      if (inScope(input.scopeSet, id)) continue;
      const key = `${groupOf(id.kind)}:${id.normalised}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offending.push({ kind: id.kind, masked: maskId(id) });
    }
  }
  if (offending.length === 0) return { ok: true };
  const noun = offending.length === 1 ? 'id is' : 'ids are';
  return {
    ok: false,
    reason: `scope: ${offending.length} ${noun} not in the run's ID chain for ${input.tool} (${offending
      .map((o) => o.masked)
      .join(', ')})`,
    offending,
  };
}
