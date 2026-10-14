// The live schema catalogue behind locate (D98): which columns of a service
// database could hold a value, and the count probe for one of them.
//
// The catalogue is read once per run, entity and service from
// information_schema.columns, with pg_index to mark columns that lead an
// index, and kept in memory for the run. information_schema only lists
// columns the read-only role can read, so a table the role cannot read is
// never probed. Partitions are left out (their parent covers them).
//
// A column is a candidate when its type fits the value's kind and its name
// looks like a key. Candidates are ranked indexed first and capped per
// database. Table and column names in a probe come from the catalogue only,
// each quoted, never from model text; the value is always bound as $1.
//
// Pure apart from the per-run cache.

import type { Entity, RunId } from '../../types/core.ts';
import { extractIdShaped, type IdKind } from '../../gate/id-patterns.ts';

export type CatalogueColumn = {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  /** information_schema data_type, such as 'uuid' or 'character varying'. */
  readonly type: string;
  /** The column leads an index, so an equality probe on it is cheap. */
  readonly indexed: boolean;
};

export type Catalogue = {
  readonly columns: readonly CatalogueColumn[];
  /** The connector cut the result at its byte cap, so some columns were not seen. */
  readonly truncated: boolean;
};

/** The only column types locate reads; anything else can never fit a value. */
export const CATALOGUE_TYPES = ['uuid', 'text', 'character varying', 'bigint', 'integer', 'numeric'] as const;

/**
 * The catalogue query. Types are filtered here to keep the result small; key
 * names are filtered in candidateColumns so the rule sits in one place.
 * indkey[0] is the leading column: an index helps an equality only there.
 */
export const CATALOGUE_SQL = [
  'SELECT c.table_schema, c.table_name, c.column_name, c.data_type,',
  '  EXISTS (SELECT 1 FROM pg_catalog.pg_index i',
  '    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]',
  '    WHERE i.indrelid = cl.oid AND a.attname = c.column_name) AS indexed',
  'FROM information_schema.columns c',
  'JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema',
  'JOIN pg_catalog.pg_class cl ON cl.relnamespace = n.oid AND cl.relname = c.table_name',
  "WHERE cl.relkind IN ('r', 'p') AND NOT cl.relispartition",
  "  AND c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg\\_%'",
  `  AND c.data_type IN (${CATALOGUE_TYPES.map((t) => `'${t}'`).join(', ')})`,
  'ORDER BY c.table_schema, c.table_name, c.ordinal_position',
].join('\n');

/**
 * The tables the catalogue fixture key names. pg_catalog is refused to
 * sql_select, so this key never meets one of the model's queries.
 */
export const CATALOGUE_TABLES: readonly string[] = Object.freeze(['information_schema.columns', 'pg_catalog.pg_index']);

// Postgres names are at most 63 bytes; anything else in a row is not a name.
const NAME_MAX = 63;

function name(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= NAME_MAX && !value.includes('\0') ? value : undefined;
}

/** The catalogue from query or fixture rows. Rows that are not a column of a known type are dropped. */
export function parseCatalogue(rows: readonly unknown[], truncated = false): Catalogue {
  const columns: CatalogueColumn[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const schema = name(r.table_schema);
    const table = name(r.table_name);
    const column = name(r.column_name);
    const type = typeof r.data_type === 'string' ? r.data_type : undefined;
    if (schema === undefined || table === undefined || column === undefined || type === undefined) continue;
    if (!(CATALOGUE_TYPES as readonly string[]).includes(type)) continue;
    columns.push({ schema, table, column, type, indexed: r.indexed === true || r.indexed === 't' });
  }
  return Object.freeze({ columns: Object.freeze(columns), truncated });
}

// ------------------------------------------------------------ the value

export type ValueKind = IdKind;

/** The kind of a value that is exactly one id-shaped value, else undefined. */
export function valueKind(value: string): ValueKind | undefined {
  const found = extractIdShaped(value);
  return found.length === 1 && found[0]?.raw === value.trim() ? found[0].kind : undefined;
}

const INTEGER_MAX = 2_147_483_647n;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Whether a column of this type can hold the value. Digits fit a number
 * column only when they have no leading zero (a number drops it, so the
 * probe would match a different value) and fit its range (a larger bound
 * value is an error, not a zero).
 */
export function typeFits(kind: ValueKind, type: string, value: string): boolean {
  if (type === 'text' || type === 'character varying') return true;
  if (kind === 'uuid') return type === 'uuid';
  if (kind !== 'digits' || value.startsWith('0')) return false;
  if (type === 'numeric') return true;
  const n = BigInt(value);
  if (type === 'bigint') return n <= BIGINT_MAX;
  if (type === 'integer') return n <= INTEGER_MAX;
  return false;
}

// The owner's list of key-like names. Email and phone names hold only that
// kind of value, so they are probed only for it.
const EMAIL_NAME = /^email$/;
const PHONE_NAME = /^(?:phone|mobile)/;
const KEY_NAME = /^id$|_id$|_ref$|_reference$|^external_|_number$/;

/** Whether a column name looks like a key that could hold a value of this kind. */
export function nameFits(kind: ValueKind, column: string): boolean {
  const lower = column.toLowerCase();
  if (EMAIL_NAME.test(lower)) return kind === 'email';
  if (PHONE_NAME.test(lower)) return kind === 'phone' || kind === 'digits';
  return KEY_NAME.test(lower);
}

// ------------------------------------------------------------ candidates

export type CandidateOptions = {
  /** resources/<entity>.entity.json locate.exclude_tables: "table" in any schema, or "schema.table". */
  readonly excludeTables?: readonly string[];
  /** The service's scope_exempt_tables: config tables with no customer data. */
  readonly exemptTables?: readonly string[];
  /** TRIAGE_LOCATE_MAX_COLUMNS_PER_DB. */
  readonly maxColumns: number;
};

export type Candidates = {
  /** Indexed first, then in catalogue order; at most maxColumns. */
  readonly columns: readonly CatalogueColumn[];
  /** Columns that fit but sit in an excluded or exempt table. */
  readonly excluded: number;
  /** Columns that fit but are past the cap. */
  readonly overCap: number;
};

function skipped(col: CatalogueColumn, tables: readonly string[]): boolean {
  const table = col.table.toLowerCase();
  const qualified = `${col.schema.toLowerCase()}.${table}`;
  return tables.some((t) => (t.includes('.') ? t === qualified : t === table));
}

/** The columns worth a count probe for this value. */
export function candidateColumns(catalogue: Catalogue, value: string, kind: ValueKind, opts: CandidateOptions): Candidates {
  const skip = [...(opts.excludeTables ?? []), ...(opts.exemptTables ?? [])];
  const fits = catalogue.columns.filter((c) => typeFits(kind, c.type, value) && nameFits(kind, c.column));
  const kept = fits.filter((c) => !skipped(c, skip));
  // A stable sort keeps catalogue order within each group.
  const ranked = [...kept].sort((a, b) => Number(b.indexed) - Number(a.indexed));
  const columns = ranked.slice(0, opts.maxColumns);
  return { columns, excluded: fits.length - kept.length, overCap: ranked.length - columns.length };
}

// ------------------------------------------------------------ the probe

/** A Postgres identifier in double quotes, with inner quotes doubled. */
export function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`;
}

/** The count probe for one catalogue column. The value is always $1. */
export function countSql(col: Pick<CatalogueColumn, 'schema' | 'table' | 'column'>): string {
  return `SELECT count(*) AS count FROM ${quoteIdent(col.schema)}.${quoteIdent(col.table)} WHERE ${quoteIdent(col.column)} = $1`;
}

/**
 * The probe's fixture key table: schema.table.column. The sql_select key has
 * no column field, and a model query's tables never have three parts, so a
 * probe key never meets one of the model's.
 */
export function probeTable(col: Pick<CatalogueColumn, 'schema' | 'table' | 'column'>): string {
  return `${col.schema}.${col.table}.${col.column}`;
}

/** The count in a probe's rows ({ count } from pg, a string for bigint). Undefined when it is not one. */
export function countOf(rows: readonly unknown[]): number | undefined {
  const first = rows[0];
  if (first === null || typeof first !== 'object') return undefined;
  const raw = (first as Record<string, unknown>).count;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

// ------------------------------------------------------------ per-run cache

// Keyed by run id. A run that never settles through releaseCatalogues still
// cannot grow this without bound: the oldest run is dropped past MAX_RUNS.
const MAX_RUNS = 32;
const cache = new Map<RunId, Map<string, Catalogue>>();

const slot = (entity: Entity, service: string): string => `${entity}:${service}`;

/** The catalogue read earlier in this run for this database, if any. */
export function cachedCatalogue(runId: RunId, entity: Entity, service: string): Catalogue | undefined {
  return cache.get(runId)?.get(slot(entity, service));
}

/** Keeps a catalogue for the rest of the run. */
export function rememberCatalogue(runId: RunId, entity: Entity, service: string, catalogue: Catalogue): void {
  let run = cache.get(runId);
  if (run === undefined) {
    if (cache.size >= MAX_RUNS) cache.delete(cache.keys().next().value as RunId);
    cache.set(runId, (run = new Map()));
  }
  run.set(slot(entity, service), catalogue);
}

/** Drops a run's catalogues. Returns false when there were none. */
export function releaseCatalogues(runId: RunId): boolean {
  return cache.delete(runId);
}
