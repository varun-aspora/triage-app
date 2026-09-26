// Pure statement builders for sql_select (D33). Each call runs in its own
// read-only transaction with bounded timeouts, and the model's SELECT is
// wrapped so the row cap is a bind parameter. An EXPLAIN runs unwrapped.
// Nothing here parses SQL or does I/O; the T04 connector executes the
// statement list in order.

/** Largest timeout accepted, in milliseconds (one hour). */
export const MAX_TIMEOUT_MS = 3_600_000;

export type TxnTimeouts = {
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
};

export type CappedSql = {
  readonly sql: string;
  /** The placeholder that carries the row cap, for example '$2'. */
  readonly capParam: string;
};

// Trailing semicolons and whitespace in any mix, e.g. ";\n ; ".
const TRAILING_TERMINATORS = /[\s;]+$/;

/**
 * Wraps a SELECT as `SELECT * FROM (<sql>) _capped LIMIT $<paramCount+1>`.
 * The caller's $1..$paramCount stay as they are and the cap takes the next
 * slot, so the row limit is never interpolated. The closing parenthesis goes
 * on its own line so a trailing `--` comment cannot swallow it.
 */
export function wrapWithCap(sql: string, paramCount: number): CappedSql {
  if (typeof sql !== 'string') {
    throw new TypeError('wrapWithCap: sql must be a string');
  }
  if (typeof paramCount !== 'number' || !Number.isSafeInteger(paramCount) || paramCount < 0) {
    throw new RangeError('wrapWithCap: paramCount must be a non-negative integer');
  }
  const inner = sql.trim().replace(TRAILING_TERMINATORS, '');
  if (inner === '') {
    throw new RangeError('wrapWithCap: sql is empty');
  }
  const capParam = `$${paramCount + 1}`;
  return { sql: `SELECT * FROM (${inner}\n) _capped LIMIT ${capParam}`, capParam };
}

/**
 * The text of an EXPLAIN as it will run, with outer whitespace and trailing
 * semicolons dropped and nothing else changed. EXPLAIN cannot sit inside the
 * row-cap wrapper, and needs none: it returns plan lines, not table rows.
 * EXPLAIN ANALYZE runs the whole SELECT, bounded by the same statement_timeout
 * and read-only transaction as any other call.
 *
 * The EXPLAIN check skips leading comments the way the Postgres scanner does,
 * so '/* x *\/ EXPLAIN SELECT 1' that the gate admits is accepted here too.
 * The comments stay in the returned text.
 */
export function explainStatement(sql: string): string {
  if (typeof sql !== 'string') {
    throw new TypeError('explainStatement: sql must be a string');
  }
  const text = sql.trim().replace(TRAILING_TERMINATORS, '');
  if (!/^explain\b/i.test(skipLeadingComments(text))) {
    throw new RangeError('explainStatement: sql must start with EXPLAIN');
  }
  return text;
}

/**
 * Drops leading whitespace, '-- ...' line comments and '/* ... *\/' block
 * comments (which nest in Postgres) from the start of sql. An unclosed block
 * comment leaves nothing.
 */
export function skipLeadingComments(sql: string): string {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql.startsWith('--', i)) {
      // A line comment ends at \n or \r, as in the Postgres scanner.
      const end = sql.slice(i).search(/[\n\r]/);
      if (end === -1) return '';
      i += end + 1;
    } else if (sql.startsWith('/*', i)) {
      let depth = 0;
      while (i < sql.length) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      if (depth !== 0) return '';
    } else {
      return sql.slice(i);
    }
  }
}

/**
 * Returns the statements for one read-only call, in execution order.
 * SET LOCAL cannot take bind parameters, so both timeouts are checked as
 * integers in 1..MAX_TIMEOUT_MS before anything is interpolated.
 */
export function buildReadOnlyTxn(timeouts: TxnTimeouts, wrappedSql: string): string[] {
  const statementTimeoutMs = checkTimeout('statementTimeoutMs', timeouts?.statementTimeoutMs);
  const lockTimeoutMs = checkTimeout('lockTimeoutMs', timeouts?.lockTimeoutMs);
  if (typeof wrappedSql !== 'string' || wrappedSql.trim() === '') {
    throw new RangeError('buildReadOnlyTxn: wrappedSql is empty');
  }
  return [
    'BEGIN READ ONLY',
    `SET LOCAL statement_timeout = ${statementTimeoutMs}`,
    `SET LOCAL lock_timeout = ${lockTimeoutMs}`,
    wrappedSql,
    'COMMIT',
  ];
}

/** Session option the connector appends to the DSN `options` parameter. */
export function readOnlyConnectionOptions(): string {
  return '-c default_transaction_read_only=on';
}

// The message names the field and the allowed range, never the value.
function checkTimeout(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`buildReadOnlyTxn: ${name} must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return value;
}
