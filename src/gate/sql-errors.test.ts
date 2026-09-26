import { describe, expect, test } from 'bun:test';
import { classifySqlState, isSqlState, maskSqlValues, masksValues, sqlErrorMessage } from './sql-errors.ts';

describe('classifySqlState', () => {
  test('exact codes and classes get their category', () => {
    const want: [string, string][] = [
      ['42703', 'query'],
      ['22P02', 'query'],
      ['54000', 'query'],
      ['54001', 'query'],
      ['54011', 'query'],
      ['57014', 'timeout'],
      ['55P03', 'timeout'],
      ['40001', 'retryable'],
      ['40P01', 'retryable'],
      ['40003', 'retryable'],
      ['53100', 'retryable'],
      ['53200', 'retryable'],
      ['53400', 'retryable'],
      ['53300', 'unavailable'],
      ['08006', 'unavailable'],
      ['28P01', 'access'],
      ['42501', 'access'],
      ['XX000', 'other'],
    ];
    for (const [code, category] of want) expect([code, classifySqlState(code).category]).toEqual([code, category]);
  });

  test('isSqlState checks the shape only', () => {
    expect(isSqlState('42703')).toBe(true);
    expect(isSqlState('4270')).toBe(false);
    expect(isSqlState(42703)).toBe(false);
  });
});

describe('sqlErrorMessage', () => {
  const where = 'rtl:workflow';

  test('leads with the Postgres text, then the SQLSTATE and description, then the advice', () => {
    const text = sqlErrorMessage(classifySqlState('42703'), where, 'column "stauts" does not exist.');
    expect(text).toStartWith('Query failed on rtl:workflow: column "stauts" does not exist (SQLSTATE 42703, undefined column).');
    expect(text).toContain('information_schema.columns');
    expect(text).toContain('service code');
  });

  test('without the Postgres text the description stands in', () => {
    expect(sqlErrorMessage(classifySqlState('42P01'), where)).toStartWith('Query failed on rtl:workflow: undefined table (SQLSTATE 42P01, undefined table).');
  });

  test('54000 says the query is too large or complex', () => {
    expect(sqlErrorMessage(classifySqlState('54000'), where)).toContain('too large or complex');
  });

  test('retryable codes say to retry, not that access is broken', () => {
    for (const code of ['40001', '40P01', '53100', '53200']) {
      const text = sqlErrorMessage(classifySqlState(code), where, 'canceling statement due to conflict with recovery');
      expect(text).toContain('Retry the same query once');
      expect(text).not.toContain('access or configuration');
    }
  });

  test('no category tells the model only to record the gap', () => {
    for (const code of ['42703', '22P02', '54000', '57014', '40001', '53300', '28P01', 'XX000']) {
      const text = sqlErrorMessage(classifySqlState(code), where, 'x');
      const advice = text.slice(text.indexOf(').') + 2).trim();
      expect(advice.toLowerCase()).toMatch(/retry|fix|narrow|split|another source|check/);
    }
  });
});

describe('maskSqlValues', () => {
  // Stored values of other customers that a systemic query can hit.
  const NAME = 'Asha Verma';
  const PHONE = '+91 98765 43210';

  test('a 22P02 from a cast over a stored column loses the stored value, keeps the type', () => {
    const out = maskSqlValues('22P02', `invalid input syntax for type integer: "${NAME}, ${PHONE}"`);
    expect(out).toBe('invalid input syntax for type integer: "<value>"');
  });

  test('other data exceptions mask their quoted values and keep the rest', () => {
    const want: [string, string, string][] = [
      ['22003', 'value "98765432109876" is out of range for type integer', 'value "<value>" is out of range for type integer'],
      ['22007', `invalid input syntax for type timestamp: "${NAME}"`, 'invalid input syntax for type timestamp: "<value>"'],
      ['22008', 'date/time field value out of range: "2024-13-45"', 'date/time field value out of range: "<value>"'],
      ['22023', `invalid value "${NAME}" for "YYYY"`, 'invalid value "<value>" for "<value>"'],
      ['22P02', `Token "${NAME}" is invalid.`, 'Token "<value>" is invalid.'],
      ['22P02', `invalid input value for enum payout_status: "${NAME}"`, 'invalid input value for enum payout_status: "<value>"'],
      ['2200N', `line 1: ${NAME} <x>`, 'line 1: <value>'],
      ['22P02', `invalid "${NAME}" for type x: "${NAME}"`, 'invalid "<value>" for type x: "<value>"'],
    ];
    for (const [code, text, masked] of want) expect([code, maskSqlValues(code, text)]).toEqual([code, masked]);
  });

  test('a value holding a quote is masked whole', () => {
    expect(maskSqlValues('22P02', 'invalid input syntax for type integer: "O"Brien"')).toBe('invalid input syntax for type integer: "<value>"');
    expect(maskSqlValues('22003', 'value "a" b" is out of range')).not.toContain('b');
  });

  test('class 42 keeps identifiers readable, and classes without values are left alone', () => {
    for (const [code, text] of [
      ['42703', 'column "user_id" does not exist'],
      ['42P01', 'relation "payouts" does not exist'],
      ['21000', 'more than one row returned by a subquery used as an expression'],
      ['57014', 'canceling statement due to statement timeout'],
      ['40P01', 'deadlock detected'],
    ] as const) {
      expect(masksValues(code)).toBe(false);
      expect(maskSqlValues(code, text)).toBe(text);
    }
  });

  test('RAISE, integrity, internal and unknown classes are masked, unquoted emails and long numbers too', () => {
    expect(maskSqlValues('P0001', `customer "${NAME}" has no KYC`)).toBe('customer "<value>" has no KYC');
    expect(maskSqlValues('P0001', `no account for asha@example.com / ${PHONE}`)).toBe('no account for <value> / <value>');
    expect(maskSqlValues('23505', `Key (email)=("asha@example.com") already exists.`)).not.toContain('asha');
    expect(maskSqlValues('XX000', `unexpected value "${NAME}"`)).toBe('unexpected value "<value>"');
    expect(maskSqlValues('ZZ999', `odd "${NAME}"`)).toBe('odd "<value>"');
  });

  test('masking twice gives the same text', () => {
    const once = maskSqlValues('22P02', `invalid input syntax for type integer: "${NAME}"`);
    expect(maskSqlValues('22P02', once)).toBe(once);
  });
});
