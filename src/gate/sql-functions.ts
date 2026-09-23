// Function and type lists for the SQL gate (src/gate/sql.ts). Names are the
// lowercase names the Postgres parser produces. A function that is not in
// ALLOWED_FUNCTIONS is refused, so adding a name here is the only way to let
// the model call it.

// Aggregates. count/sum/avg/min/max also drive the aggregateOnly check.
const AGGREGATES = [
  'count', 'sum', 'avg', 'min', 'max',
  'array_agg', 'string_agg', 'json_agg', 'jsonb_agg', 'json_object_agg', 'jsonb_object_agg',
  'bool_and', 'bool_or', 'every', 'bit_and', 'bit_or',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'percentile_cont', 'percentile_disc', 'mode',
] as const;

// Window functions. They return one value per row, never a set.
const WINDOW = [
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile',
  'lag', 'lead', 'first_value', 'last_value', 'nth_value',
] as const;

const STRING = [
  'lower', 'upper', 'initcap', 'length', 'char_length', 'character_length', 'octet_length',
  'substring', 'substr', 'left', 'right', 'btrim', 'ltrim', 'rtrim', 'lpad', 'rpad',
  'position', 'strpos', 'starts_with', 'replace', 'translate', 'overlay', 'reverse', 'repeat',
  'concat', 'concat_ws', 'split_part', 'format', 'ascii', 'chr', 'md5',
  'regexp_replace', 'regexp_match', 'regexp_like', 'regexp_count', 'regexp_substr', 'regexp_instr',
  'similar_to_escape', 'normalize', 'is_normalized',
  'to_char', 'to_number', 'encode', 'decode', 'quote_literal', 'quote_nullable',
  'string_to_array', 'array_to_string', 'array_length', 'array_position', 'cardinality',
] as const;

const DATE = [
  'now', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp',
  'date_trunc', 'date_part', 'date_bin', 'extract', 'age', 'timezone', 'isfinite',
  'to_date', 'to_timestamp', 'make_date', 'make_time', 'make_timestamp', 'make_timestamptz',
  'make_interval', 'justify_days', 'justify_hours', 'justify_interval', 'overlaps',
] as const;

const MATH = [
  'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'mod', 'div', 'power', 'sqrt', 'cbrt',
  'exp', 'ln', 'log', 'log10', 'sign', 'width_bucket', 'num_nulls', 'num_nonnulls',
] as const;

// JSON accessors and builders that return a single value.
const JSON_FNS = [
  'json_extract_path', 'json_extract_path_text', 'jsonb_extract_path', 'jsonb_extract_path_text',
  'json_typeof', 'jsonb_typeof', 'json_array_length', 'jsonb_array_length',
  'json_build_object', 'jsonb_build_object', 'json_build_array', 'jsonb_build_array',
  'to_json', 'to_jsonb', 'jsonb_pretty', 'jsonb_strip_nulls', 'json_strip_nulls',
  'jsonb_path_exists', 'jsonb_path_match', 'jsonb_path_query_first', 'jsonb_path_query_array',
] as const;

export const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set<string>(AGGREGATES);

export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  ...AGGREGATES, ...WINDOW, ...STRING, ...DATE, ...MATH, ...JSON_FNS,
]);

// Set-returning functions get their own refusal code so the model learns why.
// None of them is in ALLOWED_FUNCTIONS.
export const SET_RETURNING_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  'generate_series', 'generate_subscripts', 'unnest',
  'json_array_elements', 'json_array_elements_text', 'jsonb_array_elements', 'jsonb_array_elements_text',
  'json_each', 'json_each_text', 'jsonb_each', 'jsonb_each_text',
  'json_object_keys', 'jsonb_object_keys', 'json_populate_recordset', 'jsonb_populate_recordset',
  'json_to_recordset', 'jsonb_to_recordset', 'jsonb_path_query',
  'regexp_matches', 'regexp_split_to_table', 'string_to_table',
]);

// Named out loud so the refusal is explicit even if someone widens the
// allowlist carelessly: a name matching these is refused before the allowlist
// is consulted.
export const DENIED_FUNCTION_PREFIXES: readonly string[] = ['pg_', 'lo_', 'dblink'];
export const DENIED_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  'set_config', 'current_setting', 'query_to_xml', 'query_to_xml_and_xmlschema',
  'table_to_xml', 'cursor_to_xml', 'xpath', 'xpath_exists',
  'nextval', 'setval', 'currval', 'lastval', 'txid_current',
]);

// The parser rewrites some SQL-standard syntax into pg_catalog-qualified calls
// (trim(x) -> pg_catalog.btrim, x AT TIME ZONE 'UTC' -> pg_catalog.timezone,
// SIMILAR TO -> pg_catalog.similar_to_escape). For these names only, a
// pg_catalog qualifier is treated as the bare name; any other qualified call
// is refused.
export const PARSER_QUALIFIED_FUNCTIONS: ReadonlySet<string> = new Set<string>([
  'substring', 'btrim', 'ltrim', 'rtrim', 'position', 'overlay', 'timezone', 'extract',
  'similar_to_escape', 'normalize', 'is_normalized', 'overlaps', 'pg_collation_for',
]);

// Scalar types a cast may target, by the name the parser produces
// (int -> int4, double precision -> float8). Arrays of these are allowed too.
// A pg_catalog qualifier is accepted (the parser adds it for keyword types);
// any other schema, reg* types, oid and composite types are refused.
export const ALLOWED_CAST_TYPES: ReadonlySet<string> = new Set<string>([
  'text', 'varchar', 'bpchar', 'char',
  'int2', 'int4', 'int8', 'smallint', 'integer', 'int', 'bigint',
  'numeric', 'decimal', 'float4', 'float8', 'real',
  'bool', 'boolean',
  'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval',
  'uuid', 'json', 'jsonb', 'bytea', 'inet', 'cidr', 'bit', 'varbit',
]);

// TABLESAMPLE methods that ship with Postgres.
export const ALLOWED_TABLESAMPLE_METHODS: ReadonlySet<string> = new Set<string>(['bernoulli', 'system']);

export type FunctionVerdict = 'allowed' | 'denied' | 'set_returning' | 'unlisted';

// Classifies an unqualified, lowercase function name.
export function classifyFunction(name: string): FunctionVerdict {
  if (DENIED_FUNCTIONS.has(name)) return 'denied';
  if (DENIED_FUNCTION_PREFIXES.some((p) => name.startsWith(p))) return 'denied';
  if (SET_RETURNING_FUNCTIONS.has(name)) return 'set_returning';
  if (ALLOWED_FUNCTIONS.has(name)) return 'allowed';
  return 'unlisted';
}
