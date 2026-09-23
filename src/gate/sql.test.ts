import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOW_CASES, DENY_CASES, SAFE_SQL_FALSE_POSITIVES, SAFE_SQL_PORTED_CASES } from './sql-cases.ts';
import { classifyFunction } from './sql-functions.ts';
import { isIdLikeColumn, MAX_SQL_LENGTH, SQL_REFUSAL_CODES, type SqlAllowed, type SqlCheck, validateSelect } from './sql.ts';

function allowed(sql: string): SqlAllowed {
  const r = validateSelect(sql);
  if (!r.ok) throw new Error(`expected allow for ${JSON.stringify(sql)}, got ${r.code}: ${r.message}`);
  return r;
}

function codeOf(r: SqlCheck): string {
  return r.ok ? 'ALLOWED' : r.code;
}

describe('validateSelect deny cases', () => {
  for (const c of [...DENY_CASES, ...SAFE_SQL_PORTED_CASES]) {
    test(`${c.name} -> ${c.code}`, () => {
      expect(codeOf(validateSelect(c.sql))).toBe(c.code);
    });
  }
});

describe('validateSelect allow cases', () => {
  for (const c of [...ALLOW_CASES, ...SAFE_SQL_FALSE_POSITIVES]) {
    test(c.name, () => {
      const r = allowed(c.sql);
      if (c.tables) expect(r.tables).toEqual(c.tables);
      if (c.functions) expect(r.functions).toEqual(c.functions);
      if (c.paramCount !== undefined) expect(r.paramCount).toBe(c.paramCount);
    });
  }
});

describe('refusal shape', () => {
  test('every refusal has a known code and a short model-facing message', () => {
    for (const c of [...DENY_CASES, ...SAFE_SQL_PORTED_CASES]) {
      const r = validateSelect(c.sql);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(SQL_REFUSAL_CODES).toContain(r.code);
      expect(r.message.startsWith('Refused: ')).toBe(true);
      expect(r.message.length).toBeLessThan(300);
    }
  });

  test('every refusal code is exercised by at least one case', () => {
    const seen = new Set([...DENY_CASES, ...SAFE_SQL_PORTED_CASES].map((c) => c.code));
    for (const code of SQL_REFUSAL_CODES) expect(seen.has(code)).toBe(true);
  });

  test('refusals are stable for the same input', () => {
    expect(validateSelect('SELECT pg_sleep(1)')).toEqual(validateSelect('SELECT pg_sleep(1)'));
  });
});

describe('purity and bounds', () => {
  test('returns instead of throwing for empty, oversized, NUL and non-string input', () => {
    const inputs: unknown[] = ['', 'SELECT 1\0', `SELECT ${'1 + '.repeat(MAX_SQL_LENGTH / 4)}1`, undefined, null, 42, {}];
    for (const input of inputs) {
      const r = validateSelect(input as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('PARSE_ERROR');
    }
  });

  test('input at the length limit is still parsed', () => {
    const base = 'SELECT 1';
    const sql = base + ' '.repeat(MAX_SQL_LENGTH - base.length);
    expect(sql.length).toBe(MAX_SQL_LENGTH);
    expect(validateSelect(sql).ok).toBe(true);
    expect(codeOf(validateSelect(sql + ' '))).toBe('PARSE_ERROR');
  });

  test('deeply nested input returns a result', () => {
    const sql = `SELECT ${'('.repeat(5000)}1${')'.repeat(5000)}`;
    const r = validateSelect(sql);
    expect(typeof r.ok).toBe('boolean');
  });

  test('reads no environment variables', () => {
    const original = process.env;
    const reads: string[] = [];
    process.env = new Proxy(original, {
      get(target, key) {
        reads.push(String(key));
        return Reflect.get(target, key);
      },
      has(target, key) {
        reads.push(String(key));
        return Reflect.has(target, key);
      },
    });
    try {
      validateSelect('SELECT count(*) FROM t WHERE a = $1');
      validateSelect('UPDATE t SET a = 1');
    } finally {
      process.env = original;
    }
    expect(reads).toEqual([]);
  });

  test('sql.ts imports only the parser and the function lists', () => {
    const src = readFileSync(join(import.meta.dir, 'sql.ts'), 'utf8');
    const imports = [...src.matchAll(/^import\b[^;]*?from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./sql-functions.ts', 'libpg-query']);
    expect(src).not.toMatch(/process\.|require\(|Bun\./);
  });
});

describe('tables', () => {
  test('stable under whitespace, comments and alias changes', () => {
    const variants = [
      'SELECT o.id FROM orders o JOIN public.users u ON u.id = o.user_id',
      'select   o.id\n  from ORDERS as o\n  join PUBLIC.USERS usr on usr.id = o.user_id',
      '/* lookup */ SELECT x.id -- id\nFROM orders x INNER JOIN public.users y ON y.id = x.user_id;',
      'SELECT id FROM orders JOIN public.users ON users.id = orders.user_id',
    ];
    for (const sql of variants) expect(allowed(sql).tables).toEqual(['orders', 'public.users']);
  });

  test('sorted and de-duplicated', () => {
    expect(allowed('SELECT 1 FROM zeta, alpha, zeta z2, beta').tables).toEqual(['alpha', 'beta', 'zeta']);
  });

  test('CTE names are left out but a qualified table of the same name is kept', () => {
    expect(allowed('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent').tables).toEqual(['orders']);
    expect(allowed('WITH recent AS (SELECT 1) SELECT * FROM recent, public.recent').tables).toEqual(['public.recent']);
  });

  test('tables inside subqueries and set operations are included', () => {
    const r = allowed('SELECT a FROM t WHERE b IN (SELECT b FROM u) UNION SELECT a FROM (SELECT a FROM v) s');
    expect(r.tables).toEqual(['t', 'u', 'v']);
  });
});

describe('functions', () => {
  test('lists the allowlisted functions used, sorted', () => {
    expect(allowed("SELECT upper(a), lower(a), count(*), lower(b), date_trunc('day', c) FROM t").functions).toEqual([
      'count', 'date_trunc', 'lower', 'upper',
    ]);
  });

  test('classifyFunction orders denied before the allowlist', () => {
    expect(classifyFunction('pg_sleep')).toBe('denied');
    expect(classifyFunction('dblink_connect')).toBe('denied');
    expect(classifyFunction('lo_unlink')).toBe('denied');
    expect(classifyFunction('generate_series')).toBe('set_returning');
    expect(classifyFunction('lower')).toBe('allowed');
    expect(classifyFunction('whatever')).toBe('unlisted');
  });

  test('function names are matched case-insensitively', () => {
    expect(codeOf(validateSelect('SELECT PG_SLEEP(1)'))).toBe('FUNCTION_NOT_ALLOWED');
    expect(allowed('SELECT LOWER(a) FROM t').functions).toEqual(['lower']);
  });

  test('a quoted uppercase name is not folded into an allowed one', () => {
    expect(codeOf(validateSelect('SELECT "LOWER"(a) FROM t'))).toBe('FUNCTION_NOT_ALLOWED');
  });
});

describe('parameters', () => {
  test('paramCount is the highest $n', () => {
    expect(allowed('SELECT 1').paramCount).toBe(0);
    expect(allowed('SELECT a FROM t WHERE b = $1').paramCount).toBe(1);
    expect(allowed('SELECT a FROM t WHERE b = $2 OR c = $1 OR d = $3').paramCount).toBe(3);
  });

  test("'$1' inside a string literal, quoted identifier or comment is not a param", () => {
    expect(allowed("SELECT a FROM t WHERE b = '$1' -- $2\n").paramCount).toBe(0);
    expect(codeOf(validateSelect("SELECT a FROM t WHERE b = '$1' AND c = $2"))).toBe('BAD_PARAM');
  });

  test('params inside subqueries and CTEs count', () => {
    expect(allowed('WITH x AS (SELECT a FROM t WHERE b = $1) SELECT * FROM x WHERE a IN (SELECT a FROM u WHERE c = $2)').paramCount).toBe(2);
  });
});

describe('aggregateOnly', () => {
  const cases: [string, boolean][] = [
    ['SELECT status, count(*) FROM t GROUP BY status', true],
    ['SELECT count(*) FROM t', true],
    ['SELECT count(DISTINCT customer_id) FROM t', true],
    ['SELECT sum(amount), avg(amount) FROM t', true],
    ["SELECT 'x' AS label, 1, count(*) FROM t", true],
    ['SELECT status, count(*) FROM t GROUP BY 1', true],
    ['SELECT status AS s, count(*) FROM t GROUP BY s', true],
    ["SELECT date_trunc('day', created_at), count(*) FROM t GROUP BY date_trunc('day', created_at)", true],
    ['SELECT round(avg(amount), 2), count(*) * 2 FROM t', true],
    ['SELECT max(created_at), min(amount) FROM t', true],
    ['SELECT count(*) FROM t UNION ALL SELECT count(*) FROM u', true],
    ['WITH x AS (SELECT customer_id FROM t) SELECT count(*) FROM x', true],
    ['SELECT customer_id FROM t', false],
    ['SELECT customer_id, count(*) FROM t GROUP BY customer_id', false],
    ['SELECT count(*) FROM t GROUP BY customer_id', false],
    ['SELECT status, count(*) FROM t GROUP BY status, account_number', false],
    ['SELECT max(customer_id) FROM t', false],
    ['SELECT min(t.id) FROM t', false],
    ['SELECT max(lower(email)) FROM t', false],
    ['SELECT status FROM t', false],
    ['SELECT * FROM t', false],
    ['SELECT array_agg(status) FROM t', false],
    ['SELECT string_agg(phone, \',\') FROM t', false],
    ['SELECT count(*) OVER () FROM t', false],
    ['SELECT (SELECT max(id) FROM u) FROM t', false],
    ['SELECT count(*) FROM t UNION ALL SELECT customer_id FROM u', false],
    ['SELECT status, count(*) FROM t GROUP BY ROLLUP (status, customer_id)', false],
    ['VALUES (1)', false],
  ];
  for (const [sql, want] of cases) {
    test(`${want ? 'true ' : 'false'}: ${sql}`, () => {
      expect(allowed(sql).aggregateOnly).toBe(want);
    });
  }

  test('id-like column names', () => {
    for (const n of ['id', 'customer_id', 'user_id', 'form_uuid', 'account', 'account_number', 'accountno', 'phone', 'phone_number', 'mobile_no', 'email', 'user_email', 'utr', 'bank_utr', 'cif', 'CUSTOMER_ID']) {
      expect([n, isIdLikeColumn(n)]).toEqual([n, true]);
    }
    for (const n of ['status', 'created_at', 'amount', 'vendor', 'last_update', 'paid', 'kind']) {
      expect([n, isIdLikeColumn(n)]).toEqual([n, false]);
    }
  });
});
