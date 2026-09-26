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
  { name: 'information_schema._pg_foreign_servers', sql: 'SELECT * FROM information_schema._pg_foreign_servers', code: 'CATALOG_RELATION' },
  { name: 'information_schema.user_mapping_options', sql: 'SELECT * FROM information_schema.user_mapping_options', code: 'CATALOG_RELATION' },
  { name: 'information_schema.user_mappings', sql: 'SELECT * FROM information_schema.user_mappings', code: 'CATALOG_RELATION' },
  { name: 'information_schema.foreign_server_options', sql: 'SELECT * FROM information_schema.foreign_server_options', code: 'CATALOG_RELATION' },
  { name: 'information_schema.foreign_data_wrapper_options', sql: 'SELECT * FROM information_schema.foreign_data_wrapper_options', code: 'CATALOG_RELATION' },
  { name: 'information_schema.foreign_table_options', sql: 'SELECT * FROM information_schema.foreign_table_options', code: 'CATALOG_RELATION' },
  { name: 'information_schema.column_options', sql: 'SELECT * FROM information_schema.column_options', code: 'CATALOG_RELATION' },
  { name: 'information_schema.foreign_servers', sql: 'SELECT * FROM information_schema.foreign_servers', code: 'CATALOG_RELATION' },
  { name: 'information_schema.foreign_data_wrappers', sql: 'SELECT * FROM information_schema.foreign_data_wrappers', code: 'CATALOG_RELATION' },
  { name: 'information_schema.foreign_tables', sql: 'SELECT * FROM information_schema.foreign_tables', code: 'CATALOG_RELATION' },
  { name: 'upper-case INFORMATION_SCHEMA.FOREIGN_SERVERS', sql: 'SELECT * FROM INFORMATION_SCHEMA.FOREIGN_SERVERS', code: 'CATALOG_RELATION' },
  { name: 'unqualified user_mappings', sql: 'SELECT * FROM user_mappings', code: 'CATALOG_RELATION' },
  { name: 'unqualified foreign_server_options', sql: 'SELECT option_value FROM foreign_server_options', code: 'CATALOG_RELATION' },
  { name: 'unqualified _pg_user_mappings', sql: 'SELECT * FROM _pg_user_mappings', code: 'CATALOG_RELATION' },
  { name: 'foreign_tables in a subquery', sql: 'SELECT a FROM t WHERE b IN (SELECT foreign_table_name FROM information_schema.foreign_tables)', code: 'CATALOG_RELATION' },
  { name: 'EXPLAIN of user_mapping_options', sql: 'EXPLAIN ANALYZE SELECT * FROM information_schema.user_mapping_options', code: 'CATALOG_RELATION' },
  { name: 'pg_catalog.pg_class', sql: 'SELECT relname FROM pg_catalog.pg_class', code: 'CATALOG_RELATION' },
  { name: 'information_schema joined to pg_class', sql: 'SELECT c.column_name FROM information_schema.columns c JOIN pg_class p ON true', code: 'CATALOG_RELATION' },
  { name: 'pg_toast schema', sql: 'SELECT * FROM pg_toast.pg_toast_1', code: 'CATALOG_RELATION' },
  { name: 'unqualified pg_authid', sql: 'SELECT rolpassword FROM pg_authid', code: 'CATALOG_RELATION' },
  { name: 'catalog in a join', sql: 'SELECT t.a FROM t JOIN pg_roles r ON true', code: 'CATALOG_RELATION' },
  { name: 'catalog in a subquery', sql: 'SELECT a FROM t WHERE b IN (SELECT oid FROM pg_class)', code: 'CATALOG_RELATION' },
  { name: 'TABLE pg_authid', sql: 'TABLE pg_authid', code: 'CATALOG_RELATION' },

  // EXPLAIN: the wrapped statement gets every SELECT rule, so EXPLAIN ANALYZE
  // can never run a write, take a lock or read a catalog.
  { name: 'EXPLAIN ANALYZE DELETE', sql: 'EXPLAIN ANALYZE DELETE FROM t', code: 'NOT_SELECT' },
  { name: 'EXPLAIN ANALYZE UPDATE', sql: 'EXPLAIN ANALYZE UPDATE t SET a = 1', code: 'NOT_SELECT' },
  { name: 'EXPLAIN ANALYZE INSERT', sql: 'EXPLAIN ANALYZE INSERT INTO t VALUES (1)', code: 'NOT_SELECT' },
  { name: 'EXPLAIN (ANALYZE) MERGE', sql: 'EXPLAIN (ANALYZE) MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN DELETE', code: 'NOT_SELECT' },
  { name: 'EXPLAIN DELETE without ANALYZE', sql: 'EXPLAIN DELETE FROM t', code: 'NOT_SELECT' },
  { name: 'EXPLAIN ANALYZE data-modifying CTE', sql: 'EXPLAIN ANALYZE WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', code: 'DATA_MODIFYING_CTE' },
  { name: 'EXPLAIN (ANALYZE, BUFFERS) CTE UPDATE', sql: 'EXPLAIN (ANALYZE, BUFFERS) WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT 1', code: 'DATA_MODIFYING_CTE' },
  { name: 'EXPLAIN ANALYZE SELECT INTO', sql: 'EXPLAIN ANALYZE SELECT * INTO t2 FROM t', code: 'INTO' },
  { name: 'EXPLAIN ANALYZE CREATE TABLE AS', sql: 'EXPLAIN ANALYZE CREATE TABLE x AS SELECT 1', code: 'UTILITY' },
  { name: 'EXPLAIN ANALYZE CREATE MATERIALIZED VIEW', sql: 'EXPLAIN ANALYZE CREATE MATERIALIZED VIEW v AS SELECT 1', code: 'UTILITY' },
  { name: 'EXPLAIN ANALYZE EXECUTE', sql: 'EXPLAIN ANALYZE EXECUTE q', code: 'UTILITY' },
  { name: 'EXPLAIN DECLARE CURSOR', sql: 'EXPLAIN DECLARE c CURSOR FOR SELECT 1', code: 'UTILITY' },
  { name: 'EXPLAIN ANALYZE FOR UPDATE', sql: 'EXPLAIN ANALYZE SELECT * FROM t FOR UPDATE', code: 'LOCKING' },
  { name: 'EXPLAIN ANALYZE FOR SHARE in a subquery', sql: 'EXPLAIN ANALYZE SELECT * FROM (SELECT * FROM t FOR SHARE) s', code: 'LOCKING' },
  { name: 'EXPLAIN ANALYZE pg_catalog', sql: 'EXPLAIN ANALYZE SELECT * FROM pg_catalog.pg_authid', code: 'CATALOG_RELATION' },
  { name: 'EXPLAIN pg_ relation', sql: 'EXPLAIN SELECT * FROM pg_stat_activity', code: 'CATALOG_RELATION' },
  { name: 'EXPLAIN ANALYZE pg_sleep', sql: 'EXPLAIN ANALYZE SELECT pg_sleep(10)', code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'EXPLAIN ANALYZE set_config', sql: "EXPLAIN ANALYZE SELECT set_config('statement_timeout', '0', false)", code: 'FUNCTION_NOT_ALLOWED' },
  { name: 'EXPLAIN ANALYZE parameter gap', sql: 'EXPLAIN ANALYZE SELECT a FROM t WHERE b = $2', code: 'BAD_PARAM' },
  { name: 'EXPLAIN ANALYZE then DELETE', sql: 'EXPLAIN ANALYZE SELECT 1; DELETE FROM t', code: 'MULTI_STATEMENT' },
  { name: 'EXPLAIN then SET', sql: 'EXPLAIN SELECT 1; SET statement_timeout = 0', code: 'MULTI_STATEMENT' },
  { name: 'comment before a second statement', sql: 'EXPLAIN ANALYZE SELECT 1 /* x */; DELETE FROM t', code: 'MULTI_STATEMENT' },
  { name: 'line comment then a second statement', sql: 'EXPLAIN ANALYZE SELECT 1 -- x\n; DELETE FROM t', code: 'MULTI_STATEMENT' },
  { name: 'nested EXPLAIN', sql: 'EXPLAIN EXPLAIN SELECT 1', code: 'PARSE_ERROR' },
  { name: 'nested EXPLAIN ANALYZE', sql: 'EXPLAIN ANALYZE EXPLAIN ANALYZE SELECT 1', code: 'PARSE_ERROR' },
  { name: 'unknown EXPLAIN option', sql: 'EXPLAIN (ANALYZE, BOGUS) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'unknown FORMAT', sql: 'EXPLAIN (FORMAT html) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'FORMAT without a value', sql: 'EXPLAIN (FORMAT) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'boolean option with a word value', sql: 'EXPLAIN (ANALYZE maybe) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'boolean option with a number other than 0 or 1', sql: 'EXPLAIN (ANALYZE 2) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'boolean option yes (Postgres takes true/false/on/off only)', sql: 'EXPLAIN (ANALYZE yes) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'boolean option no', sql: 'EXPLAIN (BUFFERS no) SELECT 1', code: 'EXPLAIN_OPTION' },
  { name: 'comment before a denied EXPLAIN', sql: '/* x */ EXPLAIN ANALYZE DELETE FROM t', code: 'NOT_SELECT' },

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

  // Schema discovery through information_schema.
  {
    name: 'information_schema.columns for one table',
    sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'workflow_executions'",
    tables: ['information_schema.columns'],
  },
  {
    name: 'information_schema.columns with a param and ordering',
    sql: 'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
    tables: ['information_schema.columns'],
    paramCount: 1,
  },
  {
    name: 'information_schema.tables',
    sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    tables: ['information_schema.tables'],
  },
  { name: 'upper-case INFORMATION_SCHEMA', sql: 'SELECT * FROM INFORMATION_SCHEMA.COLUMNS', tables: ['information_schema.columns'] },
  {
    name: 'information_schema key columns',
    sql: 'SELECT k.column_name FROM information_schema.table_constraints c JOIN information_schema.key_column_usage k USING (constraint_name) WHERE c.table_name = $1',
    tables: ['information_schema.key_column_usage', 'information_schema.table_constraints'],
  },

  // EXPLAIN of a SELECT, in every option form.
  { name: 'EXPLAIN', sql: 'EXPLAIN SELECT a FROM t WHERE b = $1', tables: ['t'], paramCount: 1 },
  { name: 'EXPLAIN ANALYZE', sql: 'EXPLAIN ANALYZE SELECT a FROM t WHERE b = $1', tables: ['t'], paramCount: 1 },
  { name: 'EXPLAIN ANALYZE VERBOSE', sql: 'EXPLAIN ANALYZE VERBOSE SELECT count(*) FROM t', functions: ['count'] },
  { name: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)', sql: 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT a FROM t', tables: ['t'] },
  {
    name: 'EXPLAIN option values',
    sql: "EXPLAIN (ANALYZE true, COSTS off, TIMING 0, SUMMARY on, SETTINGS, WAL 1, VERBOSE false, FORMAT 'yaml', SERIALIZE text, MEMORY) SELECT 1",
  },
  { name: 'EXPLAIN (GENERIC_PLAN)', sql: 'EXPLAIN (GENERIC_PLAN) SELECT a FROM t WHERE b = $1', paramCount: 1 },
  { name: 'EXPLAIN of a CTE and joins', sql: 'EXPLAIN WITH x AS (SELECT id FROM a) SELECT * FROM x JOIN b USING (id)', tables: ['a', 'b'] },
  { name: 'EXPLAIN of information_schema', sql: 'EXPLAIN SELECT column_name FROM information_schema.columns', tables: ['information_schema.columns'] },
  { name: 'EXPLAIN with a trailing semicolon', sql: 'EXPLAIN ANALYZE SELECT 1;' },
  { name: 'lower-case explain analyze', sql: 'explain analyze select a from t', tables: ['t'] },
  { name: 'block comment before EXPLAIN', sql: '/* x */ EXPLAIN SELECT 1' },
  { name: 'line comment before EXPLAIN ANALYZE', sql: '-- hi\nEXPLAIN ANALYZE SELECT a FROM t', tables: ['t'] },
  { name: 'nested block comment before EXPLAIN', sql: '/* a /* b */ c */\n  EXPLAIN (ANALYZE on, BUFFERS off) SELECT 1' },
  { name: 'comments and blank lines before EXPLAIN', sql: '\n -- one\r/* two */ -- three\n\texplain select 1;' },

  // A same-named table outside information_schema is an ordinary relation.
  { name: 'user_mappings in another schema', sql: 'SELECT * FROM public.user_mappings', tables: ['public.user_mappings'] },
  { name: 'information_schema.routines', sql: 'SELECT routine_name FROM information_schema.routines', tables: ['information_schema.routines'] },
];
