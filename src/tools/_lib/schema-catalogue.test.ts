import { describe, expect, test } from 'bun:test';
import {
  type Catalogue,
  type CatalogueColumn,
  cachedCatalogue,
  candidateColumns,
  CATALOGUE_SQL,
  countOf,
  countSql,
  nameFits,
  parseCatalogue,
  probeTable,
  quoteIdent,
  releaseCatalogues,
  rememberCatalogue,
  typeFits,
  valueKind,
} from './schema-catalogue.ts';

const UUID = 'c0ffee00-1111-4222-8333-444455556666';

const col = (table: string, column: string, type: string, indexed = false, schema = 'public'): CatalogueColumn => ({
  schema,
  table,
  column,
  type,
  indexed,
});
const catalogue = (...columns: CatalogueColumn[]): Catalogue => ({ columns, truncated: false });
const names = (list: readonly CatalogueColumn[]): string[] => list.map(probeTable);

describe('valueKind', () => {
  test('takes one whole id and nothing else', () => {
    expect(valueKind(UUID)).toBe('uuid');
    expect(valueKind(` ${UUID} `)).toBe('uuid');
    expect(valueKind('Someone@Example.com')).toBe('email');
    expect(valueKind('+91 98765 43210')).toBe('phone');
    expect(valueKind('123456789012')).toBe('digits');
    expect(valueKind(`${UUID} ${UUID}`)).toBeUndefined();
    expect(valueKind(`id=${UUID}`)).toBeUndefined();
    expect(valueKind('12345')).toBeUndefined();
    expect(valueKind("x'; drop table users; --")).toBeUndefined();
  });
});

describe('candidate columns by kind and name', () => {
  const cat = catalogue(
    col('users', 'id', 'uuid'),
    col('users', 'email', 'text'),
    col('users', 'phone_number', 'character varying'),
    col('users', 'mobile', 'text'),
    col('users', 'created_by', 'uuid'),
    col('workflow_executions', 'reference_id', 'character varying'),
    col('accounts', 'account_number', 'bigint'),
    col('accounts', 'legacy_id', 'integer'),
    col('accounts', 'amount_ref', 'numeric'),
    col('accounts', 'external_key', 'text'),
    col('accounts', 'bank_reference', 'text'),
    col('notes', 'body', 'text'),
  );

  test('a UUID fits uuid and text columns with key names, never numbers, email or phone names', () => {
    const { columns } = candidateColumns(cat, UUID, 'uuid', { maxColumns: 40 });
    expect(names(columns)).toEqual([
      'public.users.id',
      'public.workflow_executions.reference_id',
      'public.accounts.external_key',
      'public.accounts.bank_reference',
    ]);
  });

  test('digits fit number columns in range, text key columns and phone names', () => {
    const { columns } = candidateColumns(cat, '123456789012', 'digits', { maxColumns: 40 });
    expect(names(columns)).toEqual([
      'public.users.phone_number',
      'public.users.mobile',
      'public.workflow_executions.reference_id',
      'public.accounts.account_number',
      'public.accounts.amount_ref',
      'public.accounts.external_key',
      'public.accounts.bank_reference',
    ]);
  });

  test('a small number also fits integer; a leading zero keeps it out of every number column', () => {
    expect(names(candidateColumns(cat, '123456789', 'digits', { maxColumns: 40 }).columns)).toContain('public.accounts.legacy_id');
    const zero = names(candidateColumns(cat, '0123456789', 'digits', { maxColumns: 40 }).columns);
    expect(zero).not.toContain('public.accounts.account_number');
    expect(zero).not.toContain('public.accounts.amount_ref');
    expect(zero).toContain('public.accounts.external_key');
  });

  test('an email fits only text columns: the email column and key names', () => {
    const { columns } = candidateColumns(cat, 'a@example.com', 'email', { maxColumns: 40 });
    expect(names(columns)).toEqual([
      'public.users.email',
      'public.workflow_executions.reference_id',
      'public.accounts.external_key',
      'public.accounts.bank_reference',
    ]);
  });

  test('type and name rules on their own', () => {
    expect(typeFits('digits', 'integer', '9999999999')).toBe(false);
    expect(typeFits('digits', 'bigint', '99999999999999999999')).toBe(false);
    expect(typeFits('phone', 'bigint', '+919876543210')).toBe(false);
    expect(typeFits('email', 'uuid', 'a@b.co')).toBe(false);
    expect(nameFits('uuid', 'User_ID')).toBe(true);
    expect(nameFits('uuid', 'identity')).toBe(false);
    expect(nameFits('uuid', 'status')).toBe(false);
    expect(nameFits('email', 'email')).toBe(true);
    expect(nameFits('uuid', 'email')).toBe(false);
  });
});

describe('ranking, cap and exclusions', () => {
  const cat = catalogue(
    col('a', 'user_id', 'uuid'),
    col('b', 'user_id', 'uuid', true),
    col('c', 'user_id', 'uuid'),
    col('d', 'user_id', 'uuid', true),
    col('workflow_definitions', 'owner_id', 'uuid', true),
    col('e', 'user_id', 'uuid', false, 'audit'),
  );

  test('indexed first, catalogue order within each group, cut at the cap', () => {
    const found = candidateColumns(cat, UUID, 'uuid', { maxColumns: 3 });
    expect(names(found.columns)).toEqual(['public.b.user_id', 'public.d.user_id', 'public.workflow_definitions.owner_id']);
    expect(found.overCap).toBe(3);
    expect(found.excluded).toBe(0);
  });

  test('excluded tables (bare or with a schema) and exempt config tables are skipped and counted', () => {
    const found = candidateColumns(cat, UUID, 'uuid', {
      maxColumns: 40,
      excludeTables: ['a', 'audit.e', 'public.c_other'],
      exemptTables: ['workflow_definitions'],
    });
    expect(names(found.columns)).toEqual(['public.b.user_id', 'public.d.user_id', 'public.c.user_id']);
    expect(found.excluded).toBe(3);
  });

  test('a schema-qualified exclusion does not hit the same table in another schema', () => {
    const found = candidateColumns(cat, UUID, 'uuid', { maxColumns: 40, excludeTables: ['public.e'] });
    expect(names(found.columns)).toContain('audit.e.user_id');
  });
});

describe('the probe', () => {
  test('quotes every identifier and binds the value as $1', () => {
    expect(countSql(col('workflow_executions', 'reference_id', 'text'))).toBe(
      'SELECT count(*) AS count FROM "public"."workflow_executions" WHERE "reference_id" = $1',
    );
    // A catalogue name with a quote cannot break out of its identifier.
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(countSql(col('t"; DROP TABLE x; --', 'Id', 'text', false, 'My Schema'))).toBe(
      'SELECT count(*) AS count FROM "My Schema"."t""; DROP TABLE x; --" WHERE "Id" = $1',
    );
  });

  test('reads the count as pg returns it (bigint as a string) or from a fixture', () => {
    expect(countOf([{ count: '42' }])).toBe(42);
    expect(countOf([{ count: 3 }])).toBe(3);
    expect(countOf([])).toBeUndefined();
    expect(countOf([{ count: 'many' }])).toBeUndefined();
    expect(countOf([{ count: -1 }])).toBeUndefined();
  });

  test('the catalogue query reads only the catalogue and filters to the types that can fit', () => {
    expect(CATALOGUE_SQL.startsWith('SELECT ')).toBe(true);
    expect(CATALOGUE_SQL).toContain('information_schema.columns');
    expect(CATALOGUE_SQL).toContain('NOT cl.relispartition');
    expect(CATALOGUE_SQL).toContain("'uuid', 'text', 'character varying', 'bigint', 'integer', 'numeric'");
  });
});

describe('parseCatalogue and the per-run cache', () => {
  test('keeps well-formed rows of known types and drops the rest', () => {
    const parsed = parseCatalogue(
      [
        { table_schema: 'public', table_name: 'users', column_name: 'id', data_type: 'uuid', indexed: true },
        { table_schema: 'public', table_name: 'users', column_name: 'note', data_type: 'text', indexed: 't' },
        { table_schema: 'public', table_name: 'users', column_name: 'flag', data_type: 'boolean', indexed: false },
        { table_schema: 'public', table_name: '', column_name: 'x', data_type: 'text' },
        { table_schema: 'public', table_name: 'users', column_name: 'x'.repeat(64), data_type: 'text' },
        'not a row',
        null,
      ],
      true,
    );
    expect(parsed.truncated).toBe(true);
    expect(parsed.columns).toEqual([col('users', 'id', 'uuid', true), col('users', 'note', 'text', true)]);
  });

  test('a catalogue is kept per run, entity and service until the run is released', () => {
    const run = `run_catalogue_${Date.now().toString(36)}`;
    const cat = catalogue(col('users', 'id', 'uuid'));
    rememberCatalogue(run, 'rtl', 'workflow', cat);
    expect(cachedCatalogue(run, 'rtl', 'workflow')).toBe(cat);
    expect(cachedCatalogue(run, 'rtl', 'banking')).toBeUndefined();
    expect(cachedCatalogue(run, 'ssfb', 'workflow')).toBeUndefined();
    expect(cachedCatalogue(`${run}_other`, 'rtl', 'workflow')).toBeUndefined();
    expect(releaseCatalogues(run)).toBe(true);
    expect(cachedCatalogue(run, 'rtl', 'workflow')).toBeUndefined();
  });
});
