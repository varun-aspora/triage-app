// SQL gate: admits exactly one read-only SELECT and refuses everything else.
//
// The query is parsed with libpg-query, the real Postgres grammar compiled to
// WASM, so the gate sees the same statement the server would. It does not run
// anything and reads nothing: validateSelect takes a string and returns a
// SqlCheck, and never throws. The WASM module is loaded once, when this file is
// first imported.
//
// What is admitted:
// - one statement whose root is SELECT (including WITH ... SELECT, UNION and
//   friends, VALUES and TABLE t), with at most one trailing ';'
// - CTEs that are themselves SELECTs (no INSERT/UPDATE/DELETE/MERGE inside)
// - functions from the allowlist in sql-functions.ts, called by plain name
// - casts to the scalar types in sql-functions.ts, and arrays of them
// - relations outside pg_catalog, information_schema and pg_*
// - $n parameters numbered contiguously from $1
//
// What is refused: INTO, FOR UPDATE/SHARE (any locking clause), LATERAL over a
// function, set-returning functions anywhere, XMLTABLE and JSON_TABLE,
// schema-qualified functions and operators, and every non-SELECT statement.
//
// aggregateOnly rules (used by the scope rule for 'systemic' queries, T02.5):
// aggregateOnly is true only when the query cannot return id-like values row
// by row. For the outermost SELECT (each branch of a UNION):
// 1. If any GROUP BY expression references an id-like column, it is false.
// 2. Every target entry must be one of:
//    - a literal or a $n parameter;
//    - count(...) in any form (count(*), count(x), count(DISTINCT x)), sum(...)
//      or avg(...), without an OVER clause;
//    - min(...) or max(...) whose argument has no id-like column;
//    - an expression equal to a GROUP BY expression (or picked by GROUP BY
//      ordinal or output alias) with no id-like column;
//    - an operator, cast, CASE, COALESCE or allowlisted scalar function whose
//      parts all follow these rules.
//    A bare column, `*`, a subquery, a window function or any other aggregate
//    (array_agg, string_agg, json_agg, ...) makes it false.
// 3. VALUES lists and an empty target list are false.
// A column is id-like when its name (the last part of a qualified name,
// lowercased) is `id`, ends in `_id` or `uuid`, starts with `account`, or has
// a `_`-separated part equal to phone, mobile, email, utr or cif (so
// customer_id, account_number, phone_number, user_email and utr all count).

import { loadModule, parseSync, scanSync } from 'libpg-query';
import {
  AGGREGATE_FUNCTIONS,
  ALLOWED_CAST_TYPES,
  ALLOWED_TABLESAMPLE_METHODS,
  classifyFunction,
  PARSER_QUALIFIED_FUNCTIONS,
} from './sql-functions.ts';

await loadModule();

export const SQL_REFUSAL_CODES = [
  'NOT_SELECT',
  'MULTI_STATEMENT',
  'UTILITY',
  'DATA_MODIFYING_CTE',
  'INTO',
  'LOCKING',
  'LATERAL_FUNCTION',
  'FUNCTION_NOT_ALLOWED',
  'SCHEMA_QUALIFIED_FUNCTION',
  'SET_RETURNING_FUNCTION',
  'CAST_NOT_ALLOWED',
  'CATALOG_RELATION',
  'BAD_PARAM',
  'PARSE_ERROR',
] as const;
export type SqlRefusalCode = (typeof SQL_REFUSAL_CODES)[number];

export type SqlAllowed = {
  ok: true;
  // Relations read, sorted and de-duplicated, schema-qualified only when the
  // query qualified them. CTE names are not tables and are left out.
  tables: string[];
  // Functions called, by bare lowercase name, sorted and de-duplicated.
  functions: string[];
  aggregateOnly: boolean;
  // Highest $n used; the caller must bind exactly this many params.
  paramCount: number;
};
export type SqlRefused = { ok: false; code: SqlRefusalCode; message: string };
export type SqlCheck = SqlAllowed | SqlRefused;

export const MAX_SQL_LENGTH = 20_000;

const DML_STATEMENTS = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);
const CATALOG_SCHEMAS = new Set(['pg_catalog', 'information_schema']);
const ID_PARTS = new Set(['phone', 'mobile', 'email', 'utr', 'cif']);

class Refusal {
  readonly code: SqlRefusalCode;
  readonly message: string;
  constructor(code: SqlRefusalCode, message: string) {
    this.code = code;
    this.message = message;
  }
}

function refuse(code: SqlRefusalCode, message: string): never {
  throw new Refusal(code, `Refused: ${message}`);
}

export function validateSelect(sql: string): SqlCheck {
  try {
    return check(sql);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: 'PARSE_ERROR', message: 'Refused: the query could not be checked. Send one plain SELECT.' };
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function check(sql: string): SqlAllowed {
  if (typeof sql !== 'string' || sql.trim() === '') refuse('PARSE_ERROR', 'the query is empty. Send one SELECT.');
  if (sql.length > MAX_SQL_LENGTH) refuse('PARSE_ERROR', `the query is longer than ${MAX_SQL_LENGTH} characters.`);
  if (sql.includes('\0')) refuse('PARSE_ERROR', 'the query contains a NUL character.');

  let stmts: Json[];
  try {
    stmts = (parseSync(sql).stmts ?? []) as unknown as Json[];
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 200) : 'syntax error';
    refuse('PARSE_ERROR', `the query does not parse (${detail}).`);
  }
  if (stmts.length === 0) refuse('PARSE_ERROR', 'the query has no statement. Send one SELECT.');
  if (stmts.length > 1 || hasExtraSemicolon(sql)) {
    refuse('MULTI_STATEMENT', 'send exactly one statement, with at most one trailing semicolon.');
  }

  const first = stmts[0];
  const root = isObject(first) ? first.stmt : undefined;
  const [kind, select] = isObject(root) ? (Object.entries(root)[0] ?? []) : [];
  if (kind !== 'SelectStmt' || !isObject(select)) {
    if (kind !== undefined && DML_STATEMENTS.has(kind)) {
      refuse('NOT_SELECT', 'only SELECT is allowed. If a write is needed, recommend it in the report instead.');
    }
    refuse('UTILITY', 'only SELECT is allowed; SET, SHOW, EXPLAIN, COPY, DDL and other statements are refused.');
  }

  const walker = new Walker();
  walker.walk(select);
  const paramCount = walker.paramCount();
  const tables = [...walker.relations]
    .filter((r) => r.qualified || !walker.cteNames.has(r.name))
    .map((r) => r.name);
  return {
    ok: true,
    tables: [...new Set(tables)].sort(),
    functions: [...walker.functions].sort(),
    aggregateOnly: isAggregateOnly(select),
    paramCount,
  };
}

// The parser drops empty statements, so 'SELECT 1;;' parses as one. The scanner
// sees every ';' outside literals and comments; only one, at the end, is fine.
function hasExtraSemicolon(sql: string): boolean {
  const tokens = scanSync(sql).tokens;
  const semis = tokens.filter((t) => t.text === ';');
  if (semis.length === 0) return false;
  if (semis.length > 1) return true;
  const at = tokens.indexOf(semis[0]!);
  return tokens.slice(at + 1).some((t) => t.tokenName !== 'SQL_COMMENT' && t.tokenName !== 'C_COMMENT');
}

type Relation = { name: string; qualified: boolean };

class Walker {
  readonly relations: Relation[] = [];
  readonly cteNames = new Set<string>();
  readonly functions = new Set<string>();
  private readonly params = new Set<number>();

  walk(value: Json | undefined): void {
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item);
      return;
    }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      this.visit(key, child);
      this.walk(child);
    }
  }

  paramCount(): number {
    if (this.params.size === 0) return 0;
    const max = Math.max(...this.params);
    for (let i = 1; i <= max; i++) {
      if (!this.params.has(i)) refuse('BAD_PARAM', `parameters must run $1..$${max} with no gaps; $${i} is missing.`);
    }
    return max;
  }

  // Checks one key of a parse-tree object. Node types appear as the single key
  // of a wrapper object ({ FuncCall: {...} }); a few fields hold raw structs.
  private visit(key: string, node: Json): void {
    switch (key) {
      case 'intoClause':
        refuse('INTO', 'SELECT ... INTO creates a table; drop the INTO clause.');
      case 'lockingClause':
        if (Array.isArray(node) && node.length > 0) refuse('LOCKING', 'FOR UPDATE / FOR SHARE take row locks; drop the locking clause.');
        return;
      case 'typeName':
      case 'TypeName':
        if (isObject(node)) checkType(node);
        return;
    }
    if (!isObject(node)) return;
    switch (key) {
      case 'FuncCall':
        this.funcCall(node);
        return;
      case 'RangeFunction':
        if (node.lateral === true) refuse('LATERAL_FUNCTION', 'LATERAL over a function is not allowed; use a join or a subquery.');
        return;
      case 'RangeVar':
        this.relation(node);
        return;
      case 'CommonTableExpr':
        if (typeof node.ctename === 'string') this.cteNames.add(node.ctename);
        return;
      case 'ParamRef': {
        const n = typeof node.number === 'number' ? node.number : 0;
        if (!Number.isInteger(n) || n < 1) refuse('BAD_PARAM', 'parameters are $1, $2, ... starting at $1.');
        this.params.add(n);
        return;
      }
      case 'A_Expr':
        if (Array.isArray(node.name) && node.name.length > 1) {
          refuse('SCHEMA_QUALIFIED_FUNCTION', 'schema-qualified operators are not allowed; use the plain operator.');
        }
        return;
      case 'RangeTableSample': {
        const method = names(node.method).join('.');
        if (!ALLOWED_TABLESAMPLE_METHODS.has(method)) refuse('FUNCTION_NOT_ALLOWED', `TABLESAMPLE method ${method} is not allowed.`);
        return;
      }
      case 'RangeTableFunc':
      case 'XmlExpr':
      case 'XmlSerialize':
        refuse('FUNCTION_NOT_ALLOWED', 'XML functions are not allowed.');
      case 'JsonTable':
        refuse('SET_RETURNING_FUNCTION', 'JSON_TABLE returns a set of rows and is not allowed; use ->, ->> or jsonb_extract_path.');
    }
    if (DML_STATEMENTS.has(key)) {
      refuse('DATA_MODIFYING_CTE', 'INSERT, UPDATE, DELETE and MERGE are not allowed, including inside WITH.');
    }
    if (key.endsWith('Stmt') && key !== 'SelectStmt') {
      refuse('UTILITY', 'only SELECT is allowed inside a query.');
    }
  }

  private funcCall(node: JsonObject): void {
    const parts = names(node.funcname);
    // The parser has already folded unquoted names to lowercase. A quoted
    // "LOWER" is a different function in Postgres, so it is not folded here.
    const name = parts[parts.length - 1] ?? '';
    if (parts.length > 1) {
      const parserAdded = parts.length === 2 && parts[0] === 'pg_catalog' && PARSER_QUALIFIED_FUNCTIONS.has(name);
      if (!parserAdded) {
        refuse('SCHEMA_QUALIFIED_FUNCTION', `${parts.join('.')} is schema-qualified; call allowlisted built-ins by plain name.`);
      }
    }
    switch (classifyFunction(name)) {
      case 'allowed':
        this.functions.add(name);
        return;
      case 'set_returning':
        refuse('SET_RETURNING_FUNCTION', `${name} returns a set of rows and is not allowed.`);
      case 'denied':
        refuse('FUNCTION_NOT_ALLOWED', `${name} is not allowed.`);
      case 'unlisted':
        refuse('FUNCTION_NOT_ALLOWED', `${name} is not on the function allowlist (string, date, math, aggregate and JSON built-ins).`);
    }
  }

  private relation(node: JsonObject): void {
    const schema = typeof node.schemaname === 'string' ? node.schemaname : undefined;
    const rel = typeof node.relname === 'string' ? node.relname : '';
    const catalog = typeof node.catalogname === 'string' ? node.catalogname : undefined;
    const schemaLower = schema?.toLowerCase();
    if (
      (schemaLower !== undefined && (CATALOG_SCHEMAS.has(schemaLower) || schemaLower.startsWith('pg_'))) ||
      rel.toLowerCase().startsWith('pg_')
    ) {
      refuse('CATALOG_RELATION', 'system catalogs (pg_catalog, information_schema, pg_*) are not readable.');
    }
    const name = [catalog, schema, rel].filter((p) => p !== undefined).join('.');
    this.relations.push({ name, qualified: schema !== undefined });
  }
}

// Reads a list of { String: { sval } } nodes into plain strings.
function names(list: Json | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const s = isObject(item) && isObject(item.String) ? item.String.sval : undefined;
    out.push(typeof s === 'string' ? s : '');
  }
  return out;
}

function checkType(t: JsonObject): void {
  const parts = names(t.names);
  const shown = parts.join('.');
  if (t.setof === true || t.pct_type === true) refuse('CAST_NOT_ALLOWED', `type ${shown} is not allowed.`);
  let base: string | undefined;
  if (parts.length === 1) base = parts[0];
  else if (parts.length === 2 && parts[0] === 'pg_catalog') base = parts[1];
  if (base === undefined || !ALLOWED_CAST_TYPES.has(base)) {
    refuse('CAST_NOT_ALLOWED', `cast to ${shown} is not allowed; cast to a plain scalar type such as text, int8, numeric, timestamptz, uuid or jsonb.`);
  }
}

// ---- aggregateOnly -------------------------------------------------------

export function isIdLikeColumn(column: string): boolean {
  const n = column.toLowerCase();
  if (n === 'id' || n.endsWith('_id') || n.endsWith('uuid') || n.startsWith('account')) return true;
  return n.split('_').some((part) => ID_PARTS.has(part));
}

function stripLocations(value: Json | undefined): string {
  return JSON.stringify(value ?? null, (k, v) => (k === 'location' ? undefined : v));
}

function unwrap(value: Json | undefined): [string, JsonObject] | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length !== 1) return undefined;
  const [kind, body] = entries[0]!;
  if (!/^[A-Z]/.test(kind) || !isObject(body)) return undefined;
  return [kind, body];
}

function containsIdLike(value: Json | undefined): boolean {
  if (Array.isArray(value)) return value.some(containsIdLike);
  if (!isObject(value)) return false;
  const node = unwrap(value);
  if (node && node[0] === 'ColumnRef') {
    const fields = Array.isArray(node[1].fields) ? node[1].fields : [];
    const last = names(fields.slice(-1))[0] ?? '';
    return last !== '' && isIdLikeColumn(last);
  }
  return Object.values(value).some(containsIdLike);
}

function isAggregateOnly(select: JsonObject): boolean {
  if (typeof select.op === 'string' && select.op !== 'SETOP_NONE') {
    return isObject(select.larg) && isObject(select.rarg) && isAggregateOnly(select.larg) && isAggregateOnly(select.rarg);
  }
  if (select.valuesLists !== undefined) return false;
  const targets = Array.isArray(select.targetList) ? select.targetList : [];
  if (targets.length === 0) return false;

  const groupItems = flattenGroup(Array.isArray(select.groupClause) ? select.groupClause : []);
  if (groupItems.some(containsIdLike)) return false;

  const groupKeys = new Set<string>();
  const groupOrdinals = new Set<number>();
  const groupAliases = new Set<string>();
  for (const item of groupItems) {
    groupKeys.add(stripLocations(item));
    const node = unwrap(item);
    if (node?.[0] === 'A_Const' && isObject(node[1].ival) && typeof node[1].ival.ival === 'number') {
      groupOrdinals.add(node[1].ival.ival);
    }
    if (node?.[0] === 'ColumnRef' && Array.isArray(node[1].fields) && node[1].fields.length === 1) {
      const alias = names(node[1].fields)[0];
      if (alias) groupAliases.add(alias);
    }
  }

  return targets.every((entry, i) => {
    const rt = unwrap(entry);
    if (!rt || rt[0] !== 'ResTarget') return false;
    const { val, name } = rt[1];
    if (groupOrdinals.has(i + 1) || (typeof name === 'string' && groupAliases.has(name))) {
      return !containsIdLike(val);
    }
    return aggregateSafe(val, groupKeys);
  });
}

function flattenGroup(items: Json[]): Json[] {
  const out: Json[] = [];
  for (const item of items) {
    const node = unwrap(item);
    if (node?.[0] === 'GroupingSet') out.push(...flattenGroup(Array.isArray(node[1].content) ? node[1].content : []));
    else out.push(item);
  }
  return out;
}

function aggregateSafe(expr: Json | undefined, groupKeys: ReadonlySet<string>): boolean {
  if (groupKeys.has(stripLocations(expr))) return !containsIdLike(expr);
  const node = unwrap(expr);
  if (!node) return false;
  const [kind, body] = node;
  switch (kind) {
    case 'A_Const':
    case 'ParamRef':
    case 'String':
    case 'Integer':
    case 'Float':
    case 'Boolean':
    case 'SQLValueFunction':
      return true;
    case 'ColumnRef':
    case 'SubLink':
    case 'A_Star':
      return false;
    case 'FuncCall': {
      if (body.over !== undefined) return false;
      const parts = names(body.funcname);
      const fn = (parts[parts.length - 1] ?? '').toLowerCase();
      if (fn === 'count' || fn === 'sum' || fn === 'avg') return true;
      if (fn === 'min' || fn === 'max') return !containsIdLike(body.args);
      if (AGGREGATE_FUNCTIONS.has(fn)) return false;
      return children(body).every((c) => aggregateSafe(c, groupKeys));
    }
  }
  return children(body).every((c) => aggregateSafe(c, groupKeys));
}

// The expression children of a node: wrapped nodes held directly or in arrays.
// Raw structs such as a cast's typeName are skipped.
function children(body: JsonObject): Json[] {
  const out: Json[] = [];
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) {
      for (const item of value) if (unwrap(item)) out.push(item);
    } else if (unwrap(value)) {
      out.push(value);
    }
  }
  return out;
}
