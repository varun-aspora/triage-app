import { describe, expect, test } from 'bun:test';
import { MAX_TIMEOUT_MS, buildReadOnlyTxn, readOnlyConnectionOptions, wrapWithCap } from './sql-txn.ts';

const WRAPPED = 'SELECT * FROM (SELECT 1\n) _capped LIMIT $1';

describe('buildReadOnlyTxn', () => {
  test('statement order with 30000/2000', () => {
    const { sql } = wrapWithCap('SELECT a FROM t WHERE id = $1', 1);
    expect(buildReadOnlyTxn({ statementTimeoutMs: 30000, lockTimeoutMs: 2000 }, sql)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 30000',
      'SET LOCAL lock_timeout = 2000',
      'SELECT * FROM (SELECT a FROM t WHERE id = $1\n) _capped LIMIT $2',
      'COMMIT',
    ]);
  });

  test('accepts the bounds 1 and MAX_TIMEOUT_MS', () => {
    const out = buildReadOnlyTxn({ statementTimeoutMs: MAX_TIMEOUT_MS, lockTimeoutMs: 1 }, WRAPPED);
    expect(out[1]).toBe(`SET LOCAL statement_timeout = ${MAX_TIMEOUT_MS}`);
    expect(out[2]).toBe('SET LOCAL lock_timeout = 1');
  });

  const bad: ReadonlyArray<[string, unknown]> = [
    ['injection string', '1; DROP TABLE x'],
    ['numeric string', '30000'],
    ['negative', -1],
    ['zero', 0],
    ['fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['10^12', 10 ** 12],
    ['one over the max', MAX_TIMEOUT_MS + 1],
    ['undefined', undefined],
    ['null', null],
    ['bigint', 30000n],
  ];

  for (const [label, value] of bad) {
    test(`deny: statement timeout ${label} throws`, () => {
      expect(() =>
        buildReadOnlyTxn({ statementTimeoutMs: value as number, lockTimeoutMs: 2000 }, WRAPPED),
      ).toThrow(RangeError);
    });

    test(`deny: lock timeout ${label} throws`, () => {
      expect(() =>
        buildReadOnlyTxn({ statementTimeoutMs: 30000, lockTimeoutMs: value as number }, WRAPPED),
      ).toThrow(RangeError);
    });
  }

  test('deny: the error message does not echo the bad value', () => {
    expect(() =>
      buildReadOnlyTxn({ statementTimeoutMs: '1; DROP TABLE x' as unknown as number, lockTimeoutMs: 2000 }, WRAPPED),
    ).toThrow(/^buildReadOnlyTxn: statementTimeoutMs must be an integer from 1 to 3600000$/);
  });

  test('deny: missing timeouts object throws', () => {
    expect(() => buildReadOnlyTxn(undefined as unknown as { statementTimeoutMs: number; lockTimeoutMs: number }, WRAPPED)).toThrow(RangeError);
  });

  test('deny: empty wrapped SQL throws', () => {
    expect(() => buildReadOnlyTxn({ statementTimeoutMs: 30000, lockTimeoutMs: 2000 }, '  ')).toThrow(RangeError);
  });
});

describe('wrapWithCap', () => {
  test("'SELECT a FROM t WHERE id = $1' with 1 param yields LIMIT $2", () => {
    const out = wrapWithCap('SELECT a FROM t WHERE id = $1', 1);
    expect(out.capParam).toBe('$2');
    expect(out.sql).toBe('SELECT * FROM (SELECT a FROM t WHERE id = $1\n) _capped LIMIT $2');
    expect(out.sql).toMatch(/LIMIT \$2$/);
  });

  test('no params puts the cap at $1', () => {
    expect(wrapWithCap('SELECT 1', 0)).toEqual({ sql: WRAPPED, capParam: '$1' });
  });

  test('existing $1..$k stay positional and the cap takes $k+1', () => {
    const inner = 'SELECT a FROM t WHERE x = $1 AND y = $2 AND z = $3';
    const out = wrapWithCap(inner, 3);
    expect(out.capParam).toBe('$4');
    expect(out.sql).toContain(inner);
    expect(out.sql.endsWith('LIMIT $4')).toBe(true);
  });

  test('the cap is a placeholder, never a number', () => {
    const out = wrapWithCap('SELECT 1', 0);
    expect(out.sql).not.toMatch(/LIMIT \d/);
  });

  test("strips a trailing ';' and newline", () => {
    expect(wrapWithCap('SELECT 1;\n', 0).sql).toBe(WRAPPED);
  });

  test('strips mixed trailing semicolons and whitespace', () => {
    expect(wrapWithCap('  SELECT 1 ; ;\n\t ', 0).sql).toBe(WRAPPED);
  });

  test('a trailing line comment does not swallow the closing parenthesis', () => {
    const out = wrapWithCap('SELECT 1 -- note', 0);
    expect(out.sql).toBe('SELECT * FROM (SELECT 1 -- note\n) _capped LIMIT $1');
  });

  test('deny: empty or terminator-only SQL throws', () => {
    expect(() => wrapWithCap('', 0)).toThrow(RangeError);
    expect(() => wrapWithCap(' ;\n; ', 0)).toThrow(RangeError);
  });

  test('deny: non-string SQL throws', () => {
    expect(() => wrapWithCap(42 as unknown as string, 0)).toThrow(TypeError);
  });

  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
    test(`deny: paramCount ${String(bad)} throws`, () => {
      expect(() => wrapWithCap('SELECT 1', bad)).toThrow(RangeError);
    });
  }
});

describe('readOnlyConnectionOptions', () => {
  test('returns the exact option string', () => {
    expect(readOnlyConnectionOptions()).toBe('-c default_transaction_read_only=on');
  });
});
