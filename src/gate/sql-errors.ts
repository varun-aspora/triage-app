// SQLSTATE codes for sql_select failures: which ones the model can fix by
// changing the query, which are worth a retry, and what the model is told.
//
// The model gets the real Postgres message (with its detail and hint), the
// SQLSTATE, the fixed description from the table below and advice for the
// category. pg-client.ts scrubs the message of DSN parts and credentials
// and masks stored values (maskSqlValues below) before it gets here, and the
// tool pipeline applies the model-facing redaction to the whole text.
//
// A data exception can quote a value from any row the query touched, not
// only the model's own input: a systemic
//   SELECT count(*) FROM t WHERE recipient_name::int = 1
// fails with 22P02 'invalid input syntax for type integer: "<a customer's
// name>"'. The persisted redaction profile only knows the run customer's
// names, so those values are masked here, at the source, before the text
// reaches the model, the audit reason, the run event log or the session
// history. Pure: no I/O.

/**
 * query: the query itself is wrong and can be fixed (bad column, table,
 * function, syntax, data type or value).
 * timeout: statement_timeout or lock_timeout ended it.
 * retryable: a transient server condition (serialization failure, deadlock,
 * conflict with recovery on a reader, disk or memory pressure); the same
 * query may work on a second try.
 * access: login, database or privilege problem; a config gap.
 * unavailable: the server or connection could not be used.
 * other: anything else.
 */
export type SqlErrorCategory = 'query' | 'timeout' | 'retryable' | 'access' | 'unavailable' | 'other';

export type SqlStateInfo = {
  readonly sqlstate: string;
  readonly category: SqlErrorCategory;
  /** Fixed lowercase name of the condition, e.g. 'undefined column'. */
  readonly description: string;
};

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function isSqlState(value: unknown): value is string {
  return typeof value === 'string' && SQLSTATE.test(value);
}

// Exact codes first. Names follow the Postgres errcodes appendix.
const EXACT: ReadonlyMap<string, readonly [SqlErrorCategory, string]> = new Map([
  ['42703', ['query', 'undefined column']],
  ['42P01', ['query', 'undefined table']],
  ['42883', ['query', 'undefined function']],
  ['42601', ['query', 'syntax error']],
  ['42804', ['query', 'datatype mismatch']],
  ['42702', ['query', 'ambiguous column']],
  ['42725', ['query', 'ambiguous function']],
  ['42803', ['query', 'grouping error']],
  ['42846', ['query', 'cannot coerce']],
  ['42P02', ['query', 'undefined parameter']],
  ['42P08', ['query', 'ambiguous parameter']],
  ['42P18', ['query', 'indeterminate datatype']],
  ['42P10', ['query', 'invalid column reference']],
  ['42P09', ['query', 'ambiguous alias']],
  ['3F000', ['query', 'invalid schema name']],
  ['21000', ['query', 'cardinality violation']],
  ['0A000', ['query', 'feature not supported']],
  ['54000', ['query', 'program limit exceeded']],
  ['54001', ['query', 'statement too complex']],
  ['22P02', ['query', 'invalid text representation']],
  ['22003', ['query', 'numeric value out of range']],
  ['22007', ['query', 'invalid datetime format']],
  ['22008', ['query', 'datetime field overflow']],
  ['22012', ['query', 'division by zero']],
  ['22023', ['query', 'invalid parameter value']],
  ['22001', ['query', 'string data right truncation']],
  ['2201B', ['query', 'invalid regular expression']],
  ['22004', ['query', 'null value not allowed']],
  ['22025', ['query', 'invalid escape sequence']],
  ['57014', ['timeout', 'query canceled or statement timeout']],
  ['55P03', ['timeout', 'lock not available (lock_timeout)']],
  ['42501', ['access', 'insufficient privilege']],
  ['3D000', ['access', 'invalid catalog name (database does not exist)']],
  ['25006', ['access', 'read-only sql transaction']],
  ['40001', ['retryable', 'serialization failure']],
  ['40P01', ['retryable', 'deadlock detected']],
  ['53100', ['retryable', 'disk full']],
  ['53200', ['retryable', 'out of memory']],
  ['53300', ['unavailable', 'too many connections']],
]);

// Then the two-character class.
const CLASSES: ReadonlyMap<string, readonly [SqlErrorCategory, string]> = new Map([
  ['42', ['query', 'syntax error or access rule violation']],
  ['22', ['query', 'data exception']],
  ['54', ['query', 'program limit exceeded']],
  ['40', ['retryable', 'transaction rollback']],
  ['53', ['retryable', 'insufficient resources']],
  ['28', ['access', 'invalid authorization']],
  ['08', ['unavailable', 'connection exception']],
  ['57', ['unavailable', 'operator intervention']],
]);

/** Category and fixed description of a SQLSTATE. Unknown codes are 'other'. */
export function classifySqlState(sqlstate: string): SqlStateInfo {
  const hit = EXACT.get(sqlstate) ?? CLASSES.get(sqlstate.slice(0, 2));
  if (hit === undefined) return { sqlstate, category: 'other', description: 'database error' };
  return { sqlstate, category: hit[0], description: hit[1] };
}

// ------------------------------------------------------------ value masking

/** What a masked value becomes. */
export const MASKED_VALUE = '<value>';

// Classes whose messages name only identifiers, types, settings or server
// state, never a stored value: 42 must keep 'column "user_id" does not exist'
// readable, which is the point of passing the message on. Every other class
// is masked: 22 (data exception: the value that failed to convert, a JSON
// token, an out-of-range date), 23 (integrity; cannot happen read-only, but
// its Detail quotes the key), P0 (RAISE from a function, any text), XX
// (internal), 38/39/2F (external routines), and codes we do not know.
const KEEPS_TEXT: ReadonlySet<string> = new Set(['08', '0A', '21', '25', '28', '2B', '3D', '3F', '40', '42', '53', '54', '55', '57']);

/** True when a message for this SQLSTATE can quote a stored value and is masked. */
export function masksValues(sqlstate: string): boolean {
  return !KEEPS_TEXT.has(sqlstate.slice(0, 2));
}

// A value at the end of a field, after a colon: everything from the first
// quote to the last one, since Postgres does not escape quotes inside it
// ('invalid input syntax for type integer: "O"Brien"').
const TRAILING_VALUE = /(:\s*)"[\s\S]*"(\s*[.!?]?\s*)$/;
// A quoted value inside a field ('value "12345678901" is out of range',
// 'Token "abc" is invalid'): it ends at a quote followed by a space,
// punctuation or the end.
const INNER_VALUE = /"(?:[^"]|"(?![\s.,;:)!?]|$))*"(?=[\s.,;:)!?]|$)/g;
// A quote left over after the pairs: the rest of the field goes.
const STRAY_QUOTE = /(?<!<value>)"(?!<value>")[\s\S]*$/;
// An odd count of quotes means a value holds one: everything from the first
// quote to the last goes, since the pairs cannot be told apart.
const FIRST_TO_LAST = /"[\s\S]*"/;
// Parser detail that echoes the input without quotes (XML, JSON path):
// 'line 1: <input>'.
const LINE_ECHO = /(\bline \d+:\s*)[\s\S]*$/i;
// Values that are dangerous without quotes too, in RAISE text above all.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_NUMBER = /\+?\d(?:[\d -]{6,}\d)/g;

function maskQuotes(text: string): string {
  const out = text.replace(TRAILING_VALUE, `$1"${MASKED_VALUE}"$2`);
  if ((out.match(/"/g) ?? []).length % 2 === 1) return out.replace(FIRST_TO_LAST, `"${MASKED_VALUE}"`);
  return out.replace(INNER_VALUE, `"${MASKED_VALUE}"`).replace(STRAY_QUOTE, `"${MASKED_VALUE}`);
}

function maskField(text: string): string {
  return maskQuotes(text)
    .replace(LINE_ECHO, `$1${MASKED_VALUE}`)
    .replace(EMAIL, MASKED_VALUE)
    .replace(LONG_NUMBER, MASKED_VALUE);
}

/**
 * Masks the values a Postgres message, Detail or Hint may quote, for the
 * classes that can echo row data (masksValues). Quoted literals become
 * "<value>"; type, function and column words outside quotes stay. Pass each
 * field on its own, before they are joined. Other classes come back as is.
 */
export function maskSqlValues(sqlstate: string, text: string): string {
  if (text === '' || !masksValues(sqlstate)) return text;
  return maskField(text);
}

// What to do next, per code, for the query errors the model can fix.
const ADVICE: ReadonlyMap<string, string> = new Map([
  ['42703', 'Check the column names (SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1), or the model or entity class in the service code, and retry.'],
  ['42P01', 'Check the table name and schema (SELECT table_schema, table_name FROM information_schema.tables) and retry.'],
  ['3F000', 'Check the schema name (SELECT table_schema, table_name FROM information_schema.tables) and retry.'],
  ['42883', 'No function or operator matches these argument types. Check the types in information_schema.columns, add a cast, and retry.'],
  ['42601', 'Fix the SQL syntax and retry.'],
  ['42702', 'Qualify the column with its table alias and retry.'],
  ['42803', 'Every selected column must be in GROUP BY or inside an aggregate. Fix and retry.'],
]);

/**
 * The model-facing text for a failed query: the real Postgres text when there
 * is one, the SQLSTATE and its description, then what to do next.
 */
export function sqlErrorMessage(info: SqlStateInfo, where: string, detail?: string): string {
  const said = detail !== undefined && detail.trim() !== '' ? detail.trim().replace(/\.$/, '') : info.description;
  const head = `Query failed on ${where}: ${said} (SQLSTATE ${info.sqlstate}, ${info.description}).`;
  switch (info.category) {
    case 'query': {
      const advice =
        ADVICE.get(info.sqlstate) ??
        (info.sqlstate.startsWith('22')
          ? 'A value, parameter or cast does not fit the column type. Check the params and casts against information_schema.columns and retry.'
          : info.sqlstate.startsWith('54')
            ? 'The query is too large or complex. Split it or select fewer columns and rows, then retry.'
            : 'Fix the query and retry; information_schema.columns lists the real columns and types.');
      return `${head} ${advice}`;
    }
    case 'timeout':
      return `${head} Narrow the query (filter on an indexed column, a shorter time window) or read its plan with EXPLAIN, then retry once. If it still times out, record the gap.`;
    case 'retryable':
      return `${head} This is a passing server condition, not the query. Retry the same query once; if it fails again, try later or another source, and record the gap if nothing else answers.`;
    case 'access':
      return `${head} This is a database access or configuration problem, not the query. Try another source for the same facts; record the gap if none has them.`;
    case 'unavailable':
      return `${head} The database could not be used. Retry later or try another source; record the gap if nothing else answers.`;
    default:
      return `${head} Check the query against the message; if it looks right, try another source and record the gap if nothing else answers.`;
  }
}
