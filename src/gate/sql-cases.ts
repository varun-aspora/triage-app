// Case tables for the SQL gate tests (sql.test.ts). Kept as data so the same
// table can be reused by later suites. Every query is synthetic: made-up table
// and column names, no customer data.
import type { SqlRefusalCode } from './sql.ts';

export type SqlDenyCase = { name: string; sql: string; code: SqlRefusalCode };
export type SqlAllowCase = {
  name: string;
  sql: string;
  tables?: string[];
  functions?: string[];
  paramCount?: number;
};

// The keyword denylist of the old safe_sql.sh guard, one case per keyword or
// check, with the code the parser guard now gives. The regex guard matched
// these words anywhere in the text; the parser refuses them only where they
// are real syntax.
export const SAFE_SQL_PORTED_CASES: readonly SqlDenyCase[] = [
  { name: 'safe_sql: not SELECT/WITH', sql: 'SHOW search_path', code: 'UTILITY' },
  { name: 'safe_sql: second statement', sql: 'SELECT 1; SELECT 2', code: 'MULTI_STATEMENT' },
  { name: 'safe_sql: INSERT', sql: 'INSERT INTO t (a) VALUES (1)', code: 'NOT_SELECT' },
  { name: 'safe_sql: UPDATE', sql: 'UPDATE t SET a = 1 WHERE b = 2', code: 'NOT_SELECT' },
  { name: 'safe_sql: DELETE', sql: 'DELETE FROM t WHERE a = 1', code: 'NOT_SELECT' },
  { name: 'safe_sql: DROP', sql: 'DROP TABLE t', code: 'UTILITY' },
  { name: 'safe_sql: ALTER', sql: 'ALTER TABLE t ADD COLUMN b int', code: 'UTILITY' },
  { name: 'safe_sql: TRUNCATE', sql: 'TRUNCATE t', code: 'UTILITY' },
  { name: 'safe_sql: GRANT', sql: 'GRANT SELECT ON t TO someone', code: 'UTILITY' },
  { name: 'safe_sql: REVOKE', sql: 'REVOKE SELECT ON t FROM someone', code: 'UTILITY' },
  { name: 'safe_sql: CREATE', sql: 'CREATE TABLE t2 (a int)', code: 'UTILITY' },
  { name: 'safe_sql: MERGE', sql: 'MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DELETE', code: 'NOT_SELECT' },
  { name: 'safe_sql: CALL', sql: 'CALL do_something()', code: 'UTILITY' },
  { name: 'safe_sql: EXECUTE', sql: 'EXECUTE plan_a', code: 'UTILITY' },
  { name: 'safe_sql: COPY', sql: "COPY t TO '/tmp/out.csv'", code: 'UTILITY' },
  { name: 'safe_sql: VACUUM', sql: 'VACUUM t', code: 'UTILITY' },
  { name: 'safe_sql: REINDEX', sql: 'REINDEX TABLE t', code: 'UTILITY' },
  { name: 'safe_sql: INTO', sql: 'SELECT a INTO t2 FROM t', code: 'INTO' },
  { name: 'safe_sql: FOR UPDATE', sql: 'SELECT a FROM t FOR UPDATE', code: 'LOCKING' },
  { name: 'safe_sql: FOR SHARE', sql: 'SELECT a FROM t FOR SHARE', code: 'LOCKING' },
  { name: 'safe_sql: PG_READ_FILE', sql: "SELECT pg_read_file('/etc/hosts')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'safe_sql: PG_LS_DIR', sql: "SELECT pg_ls_dir('.')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'safe_sql: LO_EXPORT', sql: "SELECT lo_export(1, '/tmp/x')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'safe_sql: LO_IMPORT', sql: "SELECT lo_import('/etc/hosts')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'safe_sql: DBLINK', sql: "SELECT * FROM dblink('dbname=x', 'SELECT 1') AS r(a int)", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'safe_sql: PG_SLEEP', sql: 'SELECT pg_sleep(10)', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'safe_sql: REFRESH MATERIALIZED', sql: 'REFRESH MATERIALIZED VIEW v', code: 'UTILITY' },
];

// Words the old regex guard refused although they were only identifiers or
// text inside literals and comments.
export const SAFE_SQL_FALSE_POSITIVES: readonly SqlAllowCase[] = [
  { name: 'column named last_update', sql: 'SELECT last_update FROM t', tables: ['t'] },
  { name: 'columns named like keywords', sql: 'SELECT deleted_at, created_by, update_count, "insert" FROM t' },
  { name: 'column named into_account', sql: 'SELECT into_account FROM transfers', tables: ['transfers'] },
  { name: "'--' inside a literal", sql: "SELECT a FROM t WHERE note = 'x -- y'", tables: ['t'] },
  { name: "';' inside a literal", sql: "SELECT ';' AS a, 'SELECT 1; DROP TABLE t' AS b" },
  { name: 'keyword inside a literal', sql: "SELECT a FROM t WHERE note = 'please update or delete'" },
  { name: "';' inside a comment", sql: 'SELECT a /* ; DROP TABLE t; */ FROM t -- ; trailing' },
  { name: 'single trailing semicolon', sql: 'SELECT 1;' },
  { name: 'trailing semicolon then comment', sql: 'SELECT 1; -- done' },
];

export const DENY_CASES: readonly SqlDenyCase[] = [
  // DML and DDL
  { name: 'INSERT', sql: 'INSERT INTO t VALUES (1)', code: 'NOT_SELECT' },
  { name: 'INSERT ... SELECT', sql: 'INSERT INTO t SELECT * FROM u', code: 'NOT_SELECT' },
  { name: 'UPDATE', sql: 'UPDATE t SET a = 1', code: 'NOT_SELECT' },
  { name: 'DELETE', sql: 'DELETE FROM t', code: 'NOT_SELECT' },
  { name: 'MERGE', sql: 'MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = s.b', code: 'NOT_SELECT' },
  { name: 'TRUNCATE', sql: 'TRUNCATE TABLE t', code: 'UTILITY' },
  { name: 'COPY FROM', sql: "COPY t FROM '/tmp/in.csv'", code: 'UTILITY' },
  { name: 'COPY TO', sql: "COPY t TO '/tmp/out.csv'", code: 'UTILITY' },
  { name: 'COPY query TO STDOUT', sql: 'COPY (SELECT 1) TO STDOUT', code: 'UTILITY' },
  { name: 'CREATE TABLE', sql: 'CREATE TABLE x (a int)', code: 'UTILITY' },
  { name: 'CREATE TABLE AS', sql: 'CREATE TABLE x AS SELECT 1', code: 'UTILITY' },
  { name: 'CREATE FUNCTION', sql: "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT 1'", code: 'UTILITY' },
  { name: 'ALTER', sql: 'ALTER TABLE t DROP COLUMN a', code: 'UTILITY' },
  { name: 'DROP', sql: 'DROP TABLE IF EXISTS t', code: 'UTILITY' },
  { name: 'GRANT', sql: 'GRANT ALL ON t TO someone', code: 'UTILITY' },
  { name: 'REVOKE', sql: 'REVOKE ALL ON t FROM someone', code: 'UTILITY' },

  // Utility statements
  { name: 'SET statement_timeout', sql: 'SET statement_timeout = 0', code: 'UTILITY' },
  { name: 'SET LOCAL', sql: 'SET LOCAL statement_timeout = 0', code: 'UTILITY' },
  { name: 'SET ROLE', sql: 'SET ROLE postgres', code: 'UTILITY' },
  { name: 'RESET ALL', sql: 'RESET ALL', code: 'UTILITY' },
  { name: 'SHOW', sql: 'SHOW statement_timeout', code: 'UTILITY' },
  { name: 'EXPLAIN', sql: 'EXPLAIN SELECT 1', code: 'UTILITY' },
  { name: 'EXPLAIN ANALYZE', sql: 'EXPLAIN ANALYZE SELECT 1', code: 'UTILITY' },
  { name: 'DO', sql: 'DO $$ BEGIN PERFORM 1; END $$', code: 'UTILITY' },
  { name: 'CALL', sql: 'CALL p()', code: 'UTILITY' },
  { name: 'PREPARE', sql: 'PREPARE q AS SELECT 1', code: 'UTILITY' },
  { name: 'EXECUTE', sql: 'EXECUTE q', code: 'UTILITY' },
  { name: 'LISTEN', sql: 'LISTEN chan', code: 'UTILITY' },
  { name: 'NOTIFY', sql: "NOTIFY chan, 'x'", code: 'UTILITY' },
  { name: 'LOCK', sql: 'LOCK TABLE t IN ACCESS EXCLUSIVE MODE', code: 'UTILITY' },
  { name: 'VACUUM', sql: 'VACUUM FULL t', code: 'UTILITY' },
  { name: 'BEGIN', sql: 'BEGIN', code: 'UTILITY' },
  { name: 'COMMIT', sql: 'COMMIT', code: 'UTILITY' },
  { name: 'ROLLBACK', sql: 'ROLLBACK', code: 'UTILITY' },
  { name: 'DISCARD', sql: 'DISCARD ALL', code: 'UTILITY' },
  { name: 'DECLARE CURSOR', sql: 'DECLARE c CURSOR FOR SELECT 1', code: 'UTILITY' },

  // More than one statement
  { name: 'two SELECTs', sql: 'SELECT 1; SELECT 2', code: 'MULTI_STATEMENT' },
  { name: 'double semicolon', sql: 'SELECT 1;;', code: 'MULTI_STATEMENT' },
  { name: 'SELECT then UPDATE', sql: 'SELECT 1; UPDATE t SET a = 1', code: 'MULTI_STATEMENT' },
  { name: 'SELECT then SET', sql: 'SELECT 1; SET statement_timeout = 0', code: 'MULTI_STATEMENT' },

  // Data-modifying CTEs
  { name: 'CTE DELETE', sql: 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', code: 'DATA_MODIFYING_CTE' },
  { name: 'CTE UPDATE', sql: 'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x', code: 'DATA_MODIFYING_CTE' },
  { name: 'CTE INSERT', sql: 'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', code: 'DATA_MODIFYING_CTE' },
  { name: 'CTE DELETE after a plain CTE', sql: 'WITH a AS (SELECT 1), b AS (DELETE FROM t RETURNING 1) SELECT * FROM a', code: 'DATA_MODIFYING_CTE' },
  { name: 'nested CTE DELETE', sql: 'SELECT * FROM (WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x) s', code: 'DATA_MODIFYING_CTE' },

  // INTO and locking
  { name: 'SELECT INTO', sql: 'SELECT * INTO t2 FROM t', code: 'INTO' },
  { name: 'SELECT INTO TEMP', sql: 'SELECT * INTO TEMP t2 FROM t', code: 'INTO' },
  { name: 'FOR UPDATE', sql: 'SELECT * FROM t FOR UPDATE', code: 'LOCKING' },
  { name: 'FOR SHARE', sql: 'SELECT * FROM t FOR SHARE', code: 'LOCKING' },
  { name: 'FOR NO KEY UPDATE', sql: 'SELECT * FROM t FOR NO KEY UPDATE', code: 'LOCKING' },
  { name: 'FOR KEY SHARE', sql: 'SELECT * FROM t FOR KEY SHARE', code: 'LOCKING' },
  { name: 'FOR UPDATE in a subquery', sql: 'SELECT * FROM (SELECT * FROM t FOR UPDATE) s', code: 'LOCKING' },

  // Functions
  { name: 'pg_sleep', sql: 'SELECT pg_sleep(1)', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'pg_sleep in WHERE', sql: 'SELECT a FROM t WHERE pg_sleep(1) IS NOT NULL', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'pg_read_file', sql: "SELECT pg_read_file('/etc/passwd')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'set_config', sql: "SELECT set_config('statement_timeout', '0', false)", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'current_setting', sql: "SELECT current_setting('statement_timeout')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'dblink', sql: "SELECT dblink('dbname=x', 'SELECT 1')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'dblink_exec', sql: "SELECT dblink_exec('dbname=x', 'DELETE FROM t')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'lo_import', sql: "SELECT lo_import('/etc/passwd')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'lo_export', sql: "SELECT lo_export(1, '/tmp/x')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'query_to_xml', sql: "SELECT query_to_xml('SELECT 1', true, true, '')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'xpath', sql: "SELECT xpath('/a', '<a/>'::xml)", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'nextval', sql: "SELECT nextval('s')", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'unlisted function', sql: 'SELECT my_function(1)', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'unlisted function in FROM', sql: 'SELECT * FROM my_function(1) f', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'collation for (parser-qualified pg_ name)', sql: 'SELECT collation for (a) FROM t', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'xmlelement', sql: 'SELECT xmlelement(name a)', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'XMLTABLE', sql: "SELECT * FROM t, xmltable('/a' PASSING t.doc COLUMNS b text) x", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'unknown TABLESAMPLE method', sql: 'SELECT * FROM t TABLESAMPLE system_rows(10)', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'public.fn()', sql: 'SELECT public.fn()', code: 'SCHEMA_QUALIFIED_FUNCTION' },
  { name: 'pg_catalog.now()', sql: 'SELECT pg_catalog.now()', code: 'SCHEMA_QUALIFIED_FUNCTION' },
  { name: 'pg_catalog.lower()', sql: "SELECT pg_catalog.lower('A')", code: 'SCHEMA_QUALIFIED_FUNCTION' },
  { name: 'qualified operator', sql: 'SELECT 1 OPERATOR(public.+) 2', code: 'SCHEMA_QUALIFIED_FUNCTION' },

  // Set-returning functions and LATERAL
  { name: 'generate_series in target list', sql: 'SELECT generate_series(1, 3)', code: 'SET_RETURNING_FUNCTION' },
  { name: 'generate_series in FROM', sql: 'SELECT * FROM generate_series(1, 3) g', code: 'SET_RETURNING_FUNCTION' },
  { name: 'generate_series in ROWS FROM', sql: 'SELECT * FROM ROWS FROM (generate_series(1, 3)) g', code: 'SET_RETURNING_FUNCTION' },
  { name: 'generate_series under LATERAL', sql: 'SELECT * FROM t, LATERAL generate_series(1, t.n) g', code: 'LATERAL_FUNCTION' },
  { name: 'jsonb_array_elements in target list', sql: 'SELECT jsonb_array_elements(j) FROM t', code: 'SET_RETURNING_FUNCTION' },
  { name: 'jsonb_array_elements in FROM', sql: "SELECT * FROM jsonb_array_elements('[1]'::jsonb) e", code: 'SET_RETURNING_FUNCTION' },
  { name: 'jsonb_array_elements under LATERAL', sql: 'SELECT e FROM t CROSS JOIN LATERAL jsonb_array_elements(t.j) e', code: 'LATERAL_FUNCTION' },
  { name: 'LATERAL over an allowlisted function', sql: 'SELECT * FROM t, LATERAL lower(t.a) l', code: 'LATERAL_FUNCTION' },
  { name: 'unnest', sql: 'SELECT unnest(ARRAY[1, 2])', code: 'SET_RETURNING_FUNCTION' },
  { name: 'SRF inside an expression', sql: 'SELECT 1 + generate_series(1, 2)', code: 'SET_RETURNING_FUNCTION' },
  { name: 'JSON_TABLE', sql: "SELECT * FROM JSON_TABLE('[]'::jsonb, '$[*]' COLUMNS (a int)) jt", code: 'SET_RETURNING_FUNCTION' },

  // Casts
  { name: 'cast to regclass', sql: "SELECT 't'::regclass", code: 'CAST_NOT_ALLOWED' },
  { name: 'CAST AS regclass', sql: "SELECT CAST('t' AS regclass)", code: 'CAST_NOT_ALLOWED' },
  { name: 'cast to regproc', sql: "SELECT 'now'::regproc", code: 'CAST_NOT_ALLOWED' },
  { name: 'cast to oid', sql: 'SELECT 1::oid', code: 'CAST_NOT_ALLOWED' },
  { name: 'cast to a composite type', sql: 'SELECT ROW(1, 2)::my_pair', code: 'CAST_NOT_ALLOWED' },
  { name: 'cast to a schema-qualified type', sql: 'SELECT a::public.t FROM t', code: 'CAST_NOT_ALLOWED' },
  { name: 'cast to an array of an unknown type', sql: "SELECT '{}'::my_type[]", code: 'CAST_NOT_ALLOWED' },
  { name: 'regclass in a column definition list', sql: 'SELECT * FROM lower(a) AS x(b regclass)', code: 'CAST_NOT_ALLOWED' },

  // Catalog relations
  { name: 'pg_catalog.pg_stat_activity', sql: 'SELECT * FROM pg_catalog.pg_stat_activity', code: 'CATALOG_RELATION' },
  { name: 'pg_shadow', sql: 'SELECT * FROM pg_shadow', code: 'CATALOG_RELATION' },
  { name: 'information_schema.tables', sql: 'SELECT * FROM information_schema.tables', code: 'CATALOG_RELATION' },
  { name: 'unqualified pg_authid', sql: 'SELECT rolpassword FROM pg_authid', code: 'CATALOG_RELATION' },
  { name: 'catalog in a join', sql: 'SELECT t.a FROM t JOIN pg_roles r ON true', code: 'CATALOG_RELATION' },
  { name: 'catalog in a subquery', sql: 'SELECT a FROM t WHERE b IN (SELECT oid FROM pg_class)', code: 'CATALOG_RELATION' },
  { name: 'TABLE pg_authid', sql: 'TABLE pg_authid', code: 'CATALOG_RELATION' },

  // Parameters
  { name: 'parameter gap', sql: 'SELECT a FROM t WHERE b = $1 AND c = $3', code: 'BAD_PARAM' },
  { name: '$0', sql: 'SELECT $0', code: 'BAD_PARAM' },
  { name: 'starts at $2', sql: 'SELECT a FROM t WHERE b = $2', code: 'BAD_PARAM' },

  // Input that does not parse or is out of bounds
  { name: 'empty', sql: '', code: 'PARSE_ERROR' },
  { name: 'whitespace only', sql: '  \n\t ', code: 'PARSE_ERROR' },
  { name: 'comment only', sql: '-- nothing', code: 'PARSE_ERROR' },
  { name: 'semicolon only', sql: ';', code: 'PARSE_ERROR' },
  { name: 'syntax error', sql: 'SELEC 1', code: 'PARSE_ERROR' },
  { name: 'NUL character', sql: 'SELECT 1\0; DROP TABLE t', code: 'PARSE_ERROR' },
  { name: 'unterminated literal', sql: "SELECT 'abc", code: 'PARSE_ERROR' },
];

export const ALLOW_CASES: readonly SqlAllowCase[] = [
  { name: 'count(*)', sql: 'SELECT count(*) FROM orders', tables: ['orders'], functions: ['count'] },
  {
    name: 'date_trunc with GROUP BY',
    sql: "SELECT date_trunc('day', created_at) AS d, count(*) FROM orders GROUP BY 1 ORDER BY 1",
    functions: ['count', 'date_trunc'],
  },
  { name: 'coalesce', sql: "SELECT coalesce(a, b, 'none') FROM t" },
  { name: 'lower', sql: 'SELECT lower(email) FROM users', functions: ['lower'] },
  { name: 'jsonb ->> and ->', sql: "SELECT payload ->> 'status', payload -> 'meta' -> 'k' FROM events", tables: ['events'] },
  { name: 'now()', sql: 'SELECT now()', tables: [], functions: ['now'] },
  { name: 'interval arithmetic', sql: "SELECT a FROM t WHERE created_at > now() - interval '1 day'", functions: ['now'] },
  { name: 'interval cast', sql: "SELECT now() - '2 hours'::interval, current_date + 1" },
  {
    name: 'CTE with plain SELECTs',
    sql: 'WITH x AS (SELECT id FROM a), y AS (SELECT id FROM b) SELECT * FROM x JOIN y USING (id)',
    tables: ['a', 'b'],
  },
  { name: 'recursive CTE', sql: 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r', tables: [] },
  {
    name: 'joins',
    sql: 'SELECT a.x, b.y FROM a JOIN b ON a.id = b.a_id LEFT JOIN public.c ON c.id = b.c_id',
    tables: ['a', 'b', 'public.c'],
  },
  { name: 'IN subquery', sql: "SELECT * FROM t WHERE id IN (SELECT t_id FROM u WHERE status = 'x')", tables: ['t', 'u'] },
  { name: 'EXISTS subquery', sql: 'SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.t_id = t.id)', tables: ['t', 'u'] },
  { name: 'derived table', sql: 'SELECT s.a FROM (SELECT a FROM t) s', tables: ['t'] },
  { name: 'LATERAL subquery', sql: 'SELECT * FROM t, LATERAL (SELECT u.b FROM u WHERE u.a = t.a LIMIT 1) s', tables: ['t', 'u'] },
  { name: 'UNION ALL', sql: 'SELECT a FROM t UNION ALL SELECT a FROM u', tables: ['t', 'u'] },
  { name: 'VALUES', sql: 'VALUES (1, 2)', tables: [] },
  { name: 'TABLE t', sql: 'TABLE t', tables: ['t'] },
  {
    name: 'SQL-syntax functions',
    sql: "SELECT trim(a), substring(a from 1 for 3), position('x' in a), extract(epoch from now()), b AT TIME ZONE 'UTC' FROM t",
    functions: ['btrim', 'extract', 'now', 'position', 'substring', 'timezone'],
  },
  { name: 'LIKE and SIMILAR TO', sql: "SELECT a FROM t WHERE b LIKE 'x%' AND c SIMILAR TO 'y%' AND d ILIKE 'z'" },
  {
    name: 'scalar casts',
    sql: 'SELECT a::text, b::int, c::numeric(10,2), d::timestamptz, e::uuid, f::jsonb, g::int[], CAST(h AS bigint), i::pg_catalog.int4 FROM t',
  },
  { name: 'window function', sql: 'SELECT row_number() OVER (PARTITION BY a ORDER BY b), lag(b) OVER w FROM t WINDOW w AS (ORDER BY b)' },
  { name: 'CASE, NULLIF, GREATEST', sql: "SELECT CASE WHEN a > 1 THEN 'big' ELSE 'small' END, nullif(a, 0), greatest(a, b) FROM t" },
  { name: 'aggregate FILTER and DISTINCT', sql: "SELECT count(DISTINCT a), count(*) FILTER (WHERE b = 'x'), sum(c), avg(c) FROM t" },
  { name: 'TABLESAMPLE bernoulli', sql: 'SELECT * FROM t TABLESAMPLE bernoulli(10)', tables: ['t'] },
  { name: 'two params', sql: 'SELECT a FROM t WHERE b = $1 AND c = $2 AND d = $1', paramCount: 2 },
  { name: "'$1' inside a literal is not a param", sql: "SELECT '$1' AS a, \"$2\" FROM t", paramCount: 0 },
  { name: 'quoted mixed-case table', sql: 'SELECT 1 FROM "Orders"', tables: ['Orders'] },
  { name: 'regexp and split_part', sql: "SELECT regexp_replace(a, '[0-9]', '', 'g'), split_part(b, '-', 1) FROM t" },
];
