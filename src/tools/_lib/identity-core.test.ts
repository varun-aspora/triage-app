import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistry, type Registry } from '../../config/registry.ts';
import { mockPortFromFixtures, type MockPort } from '../../connectors/mock.ts';
import { createSqlConnector, type RunSelectInput, type SqlSelectOutcome } from '../../connectors/sql/pg-client.ts';
import { fakePg } from '../../connectors/sql/pg-fake.ts';
import { RoleCheckCache } from '../../connectors/sql/readonly-role.ts';
import { ConnectorError, envVarName, type ConnectorContext } from '../../connectors/types.ts';
import { createMemoryAuditSink } from '../../gate/audit-sink.ts';
import { serializeAuditLine } from '../../gate/audit.ts';
import { keyString, semanticKey } from '../../mock/key.ts';
import type { FixtureStore } from '../../mock/store.ts';
import type { KnownIds } from '../../types/core.ts';
import { makeTestConfig } from '../../../test/support/fake-tool-context.ts';
import { IdentityCoreError, resolveIdChain, type IdentityCoreDeps } from './identity-core.ts';
import * as statements from './identity-statements.ts';

const S = statements;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const NOW = new Date('2026-09-24T09:00:00.000Z');

// Made-up DSNs. The .invalid host never resolves and nothing here dials.
const FAKE_PASSWORD = 'idchain-fakepw-9191';
const FAKE_HOST = 'idchain-fake-db.invalid';
const dsn = (db: string): string => ['postgres://triage_fake:', FAKE_PASSWORD, '@', FAKE_HOST, ':6543/', db].join('');
const DSNS = {
  SSFB_HARBOR_DB_URL: dsn('harbor_fake'),
  SSFB_RHYTHM_DB_URL: dsn('rhythm_fake'),
  SSFB_WORKFLOW_DB_URL: dsn('workflow_fake'),
  SSFB_GUARDIAN_DB_URL: dsn('guardian_fake'),
  RTL_WORKFLOW_DB_URL: dsn('rtl_workflow_fake'),
};
const SECRETS = [...Object.values(DSNS), FAKE_PASSWORD, FAKE_HOST, 'triage_fake'];

// Synthetic ids.
const CUST = 'cust-0000-aaaa';
const FORM = 'form-0000-bbbb';
const OLD_FORM = 'form-0000-old0';
const USER = 'user-0000-cccc';
const ACCOUNT = 'acct-0000-dddd';
const ACCOUNT_NUMBER = '000011112222';

type Env = Record<string, string | undefined>;

function registryOf(env: Env = {}): Registry {
  const config = makeTestConfig({ TRIAGE_ENTITIES: 'ssfb,rtl', ...DSNS, ...env });
  return loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
}

type Handler = (params: readonly unknown[], input: RunSelectInput) => Record<string, unknown>[] | Error;

/** A fake SQL connector that answers by statement text. Unscripted statements return no rows. */
function fakeSql(handlers: Map<string, Handler> = new Map()) {
  const calls: { ctx: ConnectorContext; input: RunSelectInput }[] = [];
  const runSelect = mock(async (ctx: ConnectorContext, input: RunSelectInput): Promise<SqlSelectOutcome> => {
    calls.push({ ctx, input });
    const handler = handlers.get(input.plan[3] as string);
    const out = handler === undefined ? [] : handler(input.params, input);
    if (out instanceof Error) throw out;
    return {
      data: { rows: out, row_count: out.length, columns: [] },
      transport: 'real',
      target_env: envVarName('SSFB_HARBOR_DB_URL'),
      taken_at: ctx.now().toISOString(),
      duration_ms: 0,
    };
  });
  return { runSelect, calls, sqlOf: () => calls.map((c) => c.input.plan[3]) };
}

const REAL_PORT: MockPort = {
  enabled: false,
  strict: true,
  lookup: () => {
    throw new Error('real mode must not read fixtures');
  },
};

function depsOf(sql: { runSelect: IdentityCoreDeps['sql']['runSelect'] }, over: Partial<IdentityCoreDeps> = {}) {
  const audit = createMemoryAuditSink();
  const deps: IdentityCoreDeps = {
    sql,
    mock: REAL_PORT,
    audit,
    now: () => NOW,
    signal: new AbortController().signal,
    entities: registryOf(),
    run: { runId: 'run_idchain_0001', interface: 'cli' },
    sqlTimeouts: { statementTimeoutMs: 30000, lockTimeoutMs: 2000 },
    ...over,
  };
  return { deps, audit };
}

function hopOf(result: Awaited<ReturnType<typeof resolveIdChain>>, source: string, from?: string) {
  return result.id_chain.hops.filter((h) => h.source === source && (from === undefined || h.from === from));
}

const rows = (...r: Record<string, unknown>[]): Handler => () => r;

describe('hop table', () => {
  test('horus_customer_id reads the harbor customer and gives customer_id and account_form_id', async () => {
    const sql = fakeSql(new Map([[S.HARBOR_CUSTOMER_BY_ID, rows({ customer_id: CUST, account_form_id: FORM, cif_exists: true })]]));
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ horus_customer_id: CUST }, deps);

    expect(result.id_chain.ids).toMatchObject({ horus_customer_id: CUST, customer_id: CUST, account_form_id: FORM, form_id: FORM });
    expect(result.id_chain.hops[0]).toEqual({
      from: 'horus_customer_id',
      to: 'customer_id',
      source: 'ssfb:harbor.customer',
      status: 'resolved',
      taken_at: NOW.toISOString(),
    });
    const first = sql.calls[0]?.input as RunSelectInput;
    expect(first.params).toEqual([CUST]);
    expect(first.service).toBe('harbor');
    expect(first.entity).toBe('ssfb');
  });

  test('every statement runs inside the read-only transaction with $n params only', async () => {
    const sql = fakeSql(new Map([[S.HARBOR_CUSTOMER_BY_ID, rows({ customer_id: CUST, account_form_id: FORM })]]));
    const { deps } = depsOf(sql);
    await resolveIdChain({ horus_customer_id: CUST }, deps);
    expect(sql.calls.length).toBeGreaterThan(3);
    for (const { input } of sql.calls) {
      expect(input.plan).toEqual([
        'BEGIN READ ONLY',
        'SET LOCAL statement_timeout = 30000',
        'SET LOCAL lock_timeout = 2000',
        input.plan[3] as string,
        'COMMIT',
      ]);
      expect(Object.values(S)).toContain(input.plan[3] as never);
      expect(input.params.length).toBe(1);
      expect(input.keyInput.params).toEqual(input.params);
    }
  });

  test('account_form_id / nstp_application_id reads the form and gives user_id', async () => {
    const sql = fakeSql(
      new Map([
        [S.HARBOR_FORM_BY_ID, rows({ form_id: FORM, external_user_ref: USER, session_id: 'sess-1' })],
        [S.HARBOR_CUSTOMER_BY_FORM, rows({ customer_id: CUST, account_form_id: FORM })],
      ]),
    );
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ account_form_id: FORM }, deps);

    expect(result.id_chain.ids).toMatchObject({ account_form_id: FORM, form_id: FORM, user_id: USER, customer_id: CUST });
    expect(hopOf(result, 'ssfb:harbor.account_forms', 'account_form_id')[0]).toMatchObject({ status: 'resolved', to: 'user_id' });
    expect(hopOf(result, 'ssfb:harbor.customer', 'account_form_id')[0]).toMatchObject({ status: 'resolved', to: 'customer_id' });
    const formCall = sql.calls.find((c) => c.input.plan[3] === S.HARBOR_FORM_BY_ID);
    expect(formCall?.input.params).toEqual([FORM]);
  });

  test('a form_id alone is read as the account form', async () => {
    const sql = fakeSql(new Map([[S.HARBOR_FORM_BY_ID, rows({ form_id: FORM, external_user_ref: USER })]]));
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ form_id: FORM }, deps);
    expect(result.id_chain.ids).toMatchObject({ account_form_id: FORM, user_id: USER });
    expect(hopOf(result, 'ssfb:harbor.account_forms', 'form_id')[0]?.status).toBe('resolved');
  });

  test('alphadesk_user_id reads the forms by external_user_ref and takes the newest', async () => {
    const sql = fakeSql(
      new Map([[S.HARBOR_FORMS_BY_USER, rows({ form_id: FORM, external_user_ref: USER }, { form_id: OLD_FORM, external_user_ref: USER })]]),
    );
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ alphadesk_user_id: USER }, deps);
    expect(result.id_chain.ids).toMatchObject({ user_id: USER, account_form_id: FORM });
    expect(hopOf(result, 'ssfb:harbor.account_forms', 'alphadesk_user_id')[0]).toMatchObject({ status: 'resolved', to: 'user_id' });
    // The forms for that user are not read a second time under user_id.
    expect(sql.sqlOf().filter((s) => s === S.HARBOR_FORMS_BY_USER).length).toBe(1);
  });

  test('alphadesk_user_id that does not resolve is not_found', async () => {
    const sql = fakeSql();
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ alphadesk_user_id: USER }, deps);
    expect(hopOf(result, 'ssfb:harbor.account_forms', 'alphadesk_user_id')[0]?.status).toBe('not_found');
    expect(result.id_chain.ids).toEqual({ alphadesk_user_id: USER });
  });

  test('old_user_id resolves as external_user_ref first and skips the customer_id try', async () => {
    const sql = fakeSql(new Map([[S.HARBOR_FORMS_BY_USER, rows({ form_id: FORM, external_user_ref: USER })]]));
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ old_user_id: USER }, deps);
    const old = result.id_chain.hops.filter((h) => h.from === 'old_user_id');
    expect(old.map((h) => [h.source, h.status])).toEqual([
      ['ssfb:harbor.account_forms', 'resolved'],
      ['ssfb:harbor.customer', 'skipped'],
    ]);
    expect(result.id_chain.ids).toMatchObject({ user_id: USER, account_form_id: FORM });
    expect(sql.calls.some((c) => c.input.plan[3] === S.HARBOR_CUSTOMER_BY_ID)).toBe(false);
  });

  test('old_user_id falls back to customer_id when external_user_ref finds nothing', async () => {
    const sql = fakeSql(new Map([[S.HARBOR_CUSTOMER_BY_ID, rows({ customer_id: CUST, account_form_id: FORM })]]));
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ old_user_id: CUST }, deps);
    const old = result.id_chain.hops.filter((h) => h.from === 'old_user_id');
    expect(old.map((h) => [h.source, h.status, h.to])).toEqual([
      ['ssfb:harbor.account_forms', 'not_found', undefined],
      ['ssfb:harbor.customer', 'resolved', 'customer_id'],
    ]);
    expect(result.id_chain.ids).toMatchObject({ customer_id: CUST, account_form_id: FORM });
    expect(result.id_chain.ids.user_id).toBeUndefined();
  });

  test('customer_id reads the rhythm account mappings', async () => {
    const sql = fakeSql(
      new Map([[S.RHYTHM_ACCOUNTS_BY_CUSTOMER, rows({ account_id: ACCOUNT, account_number: ACCOUNT_NUMBER, account_type: 'NRE' })]]),
    );
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ customer_id: CUST }, deps);
    expect(result.id_chain.ids).toMatchObject({ account_id: ACCOUNT, account_number: ACCOUNT_NUMBER });
    expect(hopOf(result, 'ssfb:rhythm.customer_account_mappings', 'customer_id')[0]).toMatchObject({
      status: 'resolved',
      to: 'account_id',
    });
  });

  test('device_id through guardian is reported as unverified', async () => {
    const sql = fakeSql(new Map([[S.GUARDIAN_USER_BY_DEVICE, rows({ subject: USER })]]));
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ device_id: 'dev-0000-eeee' }, deps);
    expect(hopOf(result, 'ssfb:guardian.device_auth_attempts')[0]).toMatchObject({ status: 'unverified', to: 'user_id' });
    expect(result.id_chain.ids.user_id).toBe(USER);
    // Nothing is chained from an unverified user id.
    expect(sql.sqlOf()).toEqual([S.GUARDIAN_USER_BY_DEVICE]);
  });

  test('input ids are never overwritten by hop results', async () => {
    const sql = fakeSql(new Map([[S.HARBOR_CUSTOMER_BY_ID, rows({ customer_id: 'other-cust', account_form_id: 'other-form' })]]));
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ horus_customer_id: CUST, customer_id: CUST, account_form_id: FORM }, deps);
    expect(result.id_chain.ids).toMatchObject({ customer_id: CUST, account_form_id: FORM });
  });
});

describe('form_id workflow copies', () => {
  test('falls back from the SSFB workflow copy to the RTL copy when the first is empty', async () => {
    const sql = fakeSql(
      new Map<string, Handler>([
        [S.SSFB_WORKFLOW_BY_FORM, (_p, input) => (input.entity === 'rtl' ? [{ workflow_identifier: 'wf-rtl', status: 'RUNNING', current_step_identifier: 'kyc' }] : [])],
      ]),
    );
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ form_id: FORM }, deps);

    const wf = result.id_chain.hops.filter((h) => h.source.endsWith('workflow.workflow_executions'));
    expect(wf.map((h) => [h.source, h.status])).toEqual([
      ['ssfb:workflow.workflow_executions', 'not_found'],
      ['rtl:workflow.workflow_executions', 'resolved'],
    ]);
    const wfCalls = sql.calls.filter((c) => c.input.service === 'workflow').map((c) => [c.input.entity, c.input.params[0]]);
    expect(wfCalls).toEqual([
      ['ssfb', FORM],
      ['rtl', FORM],
    ]);
    const status = result.basic_state.find((i) => i.item === 'workflow_status');
    expect(status).toMatchObject({ value: 'RUNNING', source: 'rtl:workflow.workflow_executions', status: 'read' });
  });

  test('the RTL copy is skipped when the SSFB copy has the form', async () => {
    const sql = fakeSql(
      new Map([[S.SSFB_WORKFLOW_BY_FORM, rows({ workflow_identifier: 'wf-ssfb', status: 'DONE', current_step_identifier: 'end' })]]),
    );
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ form_id: FORM }, deps);
    expect(hopOf(result, 'rtl:workflow.workflow_executions')[0]?.status).toBe('skipped');
    expect(sql.calls.some((c) => c.input.entity === 'rtl')).toBe(false);
    expect(result.basic_state.find((i) => i.item === 'workflow_status')?.source).toBe('ssfb:workflow.workflow_executions');
  });

  test('the RTL copy is skipped when rtl is not enabled', async () => {
    const sql = fakeSql();
    const { deps } = depsOf(sql, { entities: registryOf({ TRIAGE_ENTITIES: 'ssfb' }) });
    const result = await resolveIdChain({ form_id: FORM }, deps);
    expect(hopOf(result, 'rtl:workflow.workflow_executions')[0]?.status).toBe('skipped');
    expect(sql.calls.some((c) => c.input.entity === 'rtl')).toBe(false);
  });
});

describe('unreachable databases', () => {
  test('an unreachable harbor marks that hop and dependent hops unreachable and does not throw', async () => {
    const down = (): Error => new ConnectorError('unreachable', 'ssfb:harbor: could not reach SSFB_HARBOR_DB_URL (ECONNREFUSED)');
    const sql = fakeSql(
      new Map<string, Handler>([
        [S.HARBOR_CUSTOMER_BY_ID, down],
        [S.HARBOR_FORM_BY_ID, down],
        [S.HARBOR_FORMS_BY_USER, down],
        [S.HARBOR_CUSTOMER_BY_FORM, down],
        [S.STATE_HARBOR_CUSTOMER, down],
        [S.STATE_ACCOUNT_FORM, down],
      ]),
    );
    const { deps, audit } = depsOf(sql);
    const result = await resolveIdChain({ horus_customer_id: CUST }, deps);

    const statuses = result.id_chain.hops.map((h) => [h.from, h.source, h.status]);
    expect(statuses).toEqual([
      ['horus_customer_id', 'ssfb:harbor.customer', 'unreachable'],
      ['account_form_id', 'ssfb:harbor.account_forms', 'unreachable'],
      ['account_form_id', 'ssfb:harbor.customer', 'unreachable'],
      ['form_id', 'ssfb:workflow.workflow_executions', 'unreachable'],
      ['customer_id', 'ssfb:rhythm.customer_account_mappings', 'unreachable'],
    ]);
    // Harbor was tried once; nothing else could run.
    expect(sql.calls.length).toBe(1);
    expect(audit.lines.length).toBe(1);
    expect(audit.lines[0]).toMatchObject({ exit: 'unreachable', target: 'SSFB_HARBOR_DB_URL' });
    expect(result.id_chain.ids).toEqual({ horus_customer_id: CUST });
    // The basic state that needed the missing ids is unreachable too.
    expect(result.basic_state.map((i) => [i.item, i.status])).toEqual([
      ['harbor_customer_state', 'unreachable'],
      ['harbor_customer_sub_state', 'unreachable'],
      ['account_form_status_v2', 'unreachable'],
      ['rhythm_account_status', 'unreachable'],
      ['rhythm_debit_allowed', 'unreachable'],
    ]);
  });

  test('a down harbor still lets hops on other databases run with ids from the thread', async () => {
    const sql = fakeSql(
      new Map<string, Handler>([
        [S.HARBOR_FORM_BY_ID, () => new ConnectorError('timeout', 'ssfb:harbor: timed out')],
        [S.RHYTHM_ACCOUNTS_BY_CUSTOMER, rows({ account_id: ACCOUNT, account_number: ACCOUNT_NUMBER })],
      ]),
    );
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ form_id: FORM, customer_id: CUST }, deps);
    expect(hopOf(result, 'ssfb:harbor.account_forms')[0]?.status).toBe('unreachable');
    expect(hopOf(result, 'ssfb:rhythm.customer_account_mappings')[0]?.status).toBe('resolved');
    expect(hopOf(result, 'ssfb:workflow.workflow_executions')[0]?.status).toBe('not_found');
    // Harbor is not tried again after the timeout.
    expect(sql.sqlOf().filter((s) => s === S.STATE_HARBOR_CUSTOMER || s === S.STATE_ACCOUNT_FORM)).toEqual([]);
    expect(result.basic_state.find((i) => i.item === 'harbor_customer_state')?.status).toBe('unreachable');
  });

  test('a blank DSN in real mode is not_configured: hop unreachable, audited, no connector call', async () => {
    const sql = fakeSql();
    const { deps, audit } = depsOf(sql, { entities: registryOf({ SSFB_HARBOR_DB_URL: '' }) });
    const result = await resolveIdChain({ horus_customer_id: CUST }, deps);
    expect(result.id_chain.hops[0]?.status).toBe('unreachable');
    expect(sql.calls.length).toBe(0);
    expect(audit.lines[0]).toMatchObject({ exit: 'not_configured', target: 'SSFB_HARBOR_DB_URL', transport: 'real' });
  });

  test('a non-connector error still throws', async () => {
    const sql = fakeSql(new Map<string, Handler>([[S.HARBOR_CUSTOMER_BY_ID, () => new TypeError('bug')]]));
    const { deps } = depsOf(sql);
    await expect(resolveIdChain({ horus_customer_id: CUST }, deps)).rejects.toThrow(TypeError);
  });

  test('an aborted signal throws before any statement runs', async () => {
    const sql = fakeSql();
    const ac = new AbortController();
    ac.abort();
    const { deps } = depsOf(sql, { signal: ac.signal });
    await expect(resolveIdChain({ horus_customer_id: CUST }, deps)).rejects.toThrow();
    expect(sql.calls.length).toBe(0);
  });

  test('invalid ids are refused with field names only', async () => {
    const sql = fakeSql();
    const { deps } = depsOf(sql);
    const bad = { horus_customer_id: 42 } as unknown as Partial<KnownIds>;
    await expect(resolveIdChain(bad, deps)).rejects.toThrow(IdentityCoreError);
    expect(sql.calls.length).toBe(0);
  });
});

describe('basic state', () => {
  function fullSql() {
    return fakeSql(
      new Map([
        [S.HARBOR_CUSTOMER_BY_ID, rows({ customer_id: CUST, account_form_id: FORM })],
        [S.HARBOR_FORM_BY_ID, rows({ form_id: FORM, external_user_ref: USER })],
        [S.SSFB_WORKFLOW_BY_FORM, rows({ workflow_identifier: 'wf', status: 'RUNNING', current_step_identifier: 'kyc' })],
        [S.RHYTHM_ACCOUNTS_BY_CUSTOMER, rows({ account_id: ACCOUNT, account_number: ACCOUNT_NUMBER })],
        [S.STATE_HARBOR_CUSTOMER, rows({ state: 'ONBOARDED', sub_state: 'ACTIVE' })],
        [S.STATE_ACCOUNT_FORM, rows({ status_v2: 'COMPLETED' })],
        [
          S.STATE_RHYTHM_ACCOUNT,
          rows(
            { account_type: 'NRE', account_status: 'ACTIVE', debit_allowed: true },
            { account_type: 'NRO', account_status: 'FROZEN', debit_allowed: false },
          ),
        ],
      ]),
    );
  }

  test('runs the three fixed reads and every item carries taken_at and source', async () => {
    const sql = fullSql();
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ horus_customer_id: CUST }, deps);

    const byItem = Object.fromEntries(result.basic_state.map((i) => [i.item, i]));
    expect(byItem.harbor_customer_state).toMatchObject({ value: 'ONBOARDED', source: 'ssfb:harbor.customer', status: 'read' });
    expect(byItem.harbor_customer_sub_state?.value).toBe('ACTIVE');
    expect(byItem.account_form_status_v2).toMatchObject({ value: 'COMPLETED', source: 'ssfb:harbor.account_forms' });
    expect(byItem['rhythm_account_status:NRE']?.value).toBe('ACTIVE');
    expect(byItem['rhythm_account_status:NRO']?.value).toBe('FROZEN');
    expect(byItem['rhythm_debit_allowed:NRO']).toMatchObject({ value: 'false', source: 'ssfb:rhythm.customer_account_mappings' });
    for (const item of result.basic_state) {
      expect(item.taken_at).toBe(NOW.toISOString());
      expect(item.source.length).toBeGreaterThan(0);
    }
    expect(result.id_chain.basic_state).toEqual(result.basic_state as typeof result.id_chain.basic_state);

    const stateCalls = sql.calls.filter((c) => (c.input.plan[3] as string).startsWith('SELECT') && [S.STATE_HARBOR_CUSTOMER, S.STATE_ACCOUNT_FORM, S.STATE_RHYTHM_ACCOUNT].includes(c.input.plan[3] as string));
    expect(stateCalls.map((c) => c.input.params[0])).toEqual([CUST, FORM, CUST]);
  });

  test('a read with no row gives not_found items', async () => {
    const sql = fakeSql();
    const { deps } = depsOf(sql);
    const result = await resolveIdChain({ customer_id: CUST }, deps);
    expect(result.basic_state.map((i) => [i.item, i.status, i.value])).toEqual([
      ['harbor_customer_state', 'not_found', ''],
      ['harbor_customer_sub_state', 'not_found', ''],
      ['rhythm_account_status', 'not_found', ''],
      ['rhythm_debit_allowed', 'not_found', ''],
    ]);
  });

  test('no ids means no statements and an empty chain', async () => {
    const sql = fakeSql();
    const { deps, audit } = depsOf(sql);
    const result = await resolveIdChain({}, deps);
    expect(result.id_chain).toEqual({ ids: {}, hops: [], basic_state: [] });
    expect(sql.calls.length).toBe(0);
    expect(audit.lines.length).toBe(0);
  });
});

describe('mock mode', () => {
  function fixtureStore(entries: Record<string, unknown>) {
    const reads: string[] = [];
    const store: Pick<FixtureStore, 'get'> = {
      get: (async (kind: string, entity: string, key: unknown) => {
        const ks = keyString(semanticKey('resolve_identity', key as never));
        reads.push([kind, entity, ks].join(' '));
        if (!Object.hasOwn(entries, ks)) return null;
        return { scope: 'shared', path: 'x', hash: '0000000000000000', fixture: { result: entries[ks] } };
      }) as FixtureStore['get'],
    };
    return { store, reads };
  }

  const keyFor = (hop: string, ids: [string, string][]): string => keyString(semanticKey('resolve_identity', { hop, ids }));

  test('answers from resolve_identity fixtures and never calls the SQL connector', async () => {
    const { store, reads } = fixtureStore({
      [keyFor('horus_customer_id', [['horus_customer_id', CUST]])]: { rows: [{ customer_id: CUST, account_form_id: FORM }] },
      [keyFor('state.harbor_customer', [['customer_id', CUST]])]: { rows: [{ state: 'ONBOARDED', sub_state: 'X' }] },
    });
    const port = mockPortFromFixtures({ settings: { mockMode: true, strict: false, record: false }, store });
    const sql = fakeSql();
    const { deps, audit } = depsOf(sql, { mock: port, entities: registryOf({ SSFB_HARBOR_DB_URL: '' }) });
    const result = await resolveIdChain({ horus_customer_id: CUST }, deps);

    expect(sql.runSelect).toHaveBeenCalledTimes(0);
    expect(result.id_chain.ids).toMatchObject({ customer_id: CUST, account_form_id: FORM });
    expect(result.id_chain.hops[0]?.status).toBe('resolved');
    expect(result.basic_state[0]).toMatchObject({ item: 'harbor_customer_state', value: 'ONBOARDED' });
    // Every lookup is under the resolve_identity kind, in the global folder.
    expect(reads.length).toBeGreaterThan(2);
    for (const r of reads) expect(r.startsWith('resolve_identity global ')).toBe(true);
    // Non-strict misses read as not_found, and every line says mock.
    expect(hopOf(result, 'ssfb:harbor.account_forms')[0]?.status).toBe('not_found');
    expect(audit.lines.length).toBe(reads.length);
    for (const line of audit.lines) expect(line.transport).toBe('mock');
  });

  test('a strict miss throws naming the fixture key, with no SQL call', async () => {
    const { store } = fixtureStore({});
    const port = mockPortFromFixtures({ settings: { mockMode: true, strict: true, record: false }, store });
    const sql = fakeSql();
    const { deps } = depsOf(sql, { mock: port });
    let caught: unknown;
    try {
      await resolveIdChain({ horus_customer_id: CUST }, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    expect((caught as ConnectorError).code).toBe('strict_miss');
    expect((caught as Error).message).toContain('resolve_identity');
    expect((caught as Error).message).toContain(keyFor('horus_customer_id', [['horus_customer_id', CUST]]));
    expect(sql.runSelect).toHaveBeenCalledTimes(0);
  });

  test('a fixture without a rows array is a loud error naming the hop', async () => {
    const { store } = fixtureStore({ [keyFor('horus_customer_id', [['horus_customer_id', CUST]])]: [{ customer_id: CUST }] });
    const port = mockPortFromFixtures({ settings: { mockMode: true, strict: true, record: false }, store });
    const { deps } = depsOf(fakeSql(), { mock: port });
    await expect(resolveIdChain({ horus_customer_id: CUST }, deps)).rejects.toThrow('hop horus_customer_id');
  });
});

describe('audit lines', () => {
  test('one line per statement, target is the env var name', async () => {
    const sql = fakeSql(
      new Map([
        [S.HARBOR_CUSTOMER_BY_ID, rows({ customer_id: CUST, account_form_id: FORM })],
        [S.SSFB_WORKFLOW_BY_FORM, rows({ workflow_identifier: 'wf', status: 'S', current_step_identifier: 'c' })],
      ]),
    );
    const { deps, audit } = depsOf(sql);
    await resolveIdChain({ horus_customer_id: CUST }, deps);

    expect(audit.lines.length).toBe(sql.calls.length);
    const envFor: Record<string, string> = {
      'ssfb:harbor': 'SSFB_HARBOR_DB_URL',
      'ssfb:rhythm': 'SSFB_RHYTHM_DB_URL',
      'ssfb:workflow': 'SSFB_WORKFLOW_DB_URL',
    };
    audit.lines.forEach((line, i) => {
      const call = sql.calls[i]?.input as RunSelectInput;
      expect(line.tool).toBe('resolve_identity');
      expect(line.decision).toBe('allow');
      expect(line.transport).toBe('real');
      expect(line.target).toBe(envFor[[call.entity, call.service].join(':')] as string);
      expect(line.target).toMatch(/^[A-Z][A-Z0-9_]*$/);
      // Summaries carry the hop name, never an id value.
      expect(line.summary_redacted).not.toContain(CUST);
      expect(line.summary_redacted).not.toContain(FORM);
    });
  });

  test('a seeded fake DSN never appears, with the real connector over a fake pg', async () => {
    const registry = registryOf();
    const config = makeTestConfig({ TRIAGE_ENTITIES: 'ssfb,rtl', ...DSNS, TRIAGE_REQUIRE_READONLY_DB_ROLE: 'false' });
    const pg = fakePg({
      respond: (q) => {
        if (q.text === S.HARBOR_CUSTOMER_BY_ID) return { rows: [{ customer_id: CUST, account_form_id: FORM }], fields: [] };
        if (q.text === S.STATE_RHYTHM_ACCOUNT) {
          const err = Object.assign(new Error(['connect failed for', DSNS.SSFB_RHYTHM_DB_URL].join(' ')), { code: 'ECONNREFUSED' });
          throw err;
        }
        return undefined;
      },
    });
    const connector = createSqlConnector({ registry, config, pgFactory: pg.factory, roleCache: new RoleCheckCache() });
    const { deps, audit } = depsOf(connector, { entities: registry });
    const result = await resolveIdChain({ horus_customer_id: CUST, device_id: 'dev-1' }, deps);

    expect(result.id_chain.hops[0]?.status).toBe('resolved');
    expect(result.basic_state.find((i) => i.item === 'rhythm_account_status')?.status).toBe('unreachable');
    // The connector saw the DSN (it opened fake pools with it); the audit trail did not.
    expect(pg.configs.map((c) => c.connectionString)).toContain(DSNS.SSFB_HARBOR_DB_URL);
    const dataStatements = pg.selectClients().length;
    expect(audit.lines.length).toBe(dataStatements);
    const text = [...audit.lines.map((l) => serializeAuditLine(l)), JSON.stringify(result)].join('\n');
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(new Set(audit.lines.map((l) => l.target))).toEqual(
      new Set(['SSFB_HARBOR_DB_URL', 'SSFB_WORKFLOW_DB_URL', 'SSFB_RHYTHM_DB_URL', 'SSFB_GUARDIAN_DB_URL', 'RTL_WORKFLOW_DB_URL']),
    );
  });
});

describe('static checks', () => {
  const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
  // Drops // and /* */ comments. Good enough for these two files, whose
  // string literals hold no comment markers.
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

  test('identity-statements.ts has no template literal and no + concatenation', () => {
    const src = code(read('./identity-statements.ts'));
    expect(src).not.toContain('`');
    expect(src).not.toContain('+');
    expect(src).not.toContain('${');
    expect(src).not.toMatch(/\.concat\(|\.join\(/);
  });

  test('identity-core.ts builds no SQL: no template literal and no string concatenation', () => {
    const src = code(read('./identity-core.ts'));
    expect(src).not.toContain('`');
    expect(src).not.toMatch(/['"]\s*\+|\+\s*['"]/);
    expect(src).not.toMatch(/\.concat\(/);
    // No SQL keyword appears in a string literal of the core.
    expect(src).not.toMatch(/['"][^'"\n]*\b(SELECT|FROM|WHERE|JOIN)\b[^'"\n]*['"]/);
  });

  test('every exported statement is a constant SELECT with $n placeholders only', () => {
    const sqlConstants = Object.entries(statements).filter(([, value]) => typeof value === 'string') as [string, string][];
    expect(sqlConstants.length).toBe(11);
    for (const [name, sql] of sqlConstants) {
      expect(sql, name).toMatch(/^SELECT /);
      expect(sql, name).toContain('$1');
      expect(sql, name).not.toContain(';');
      expect(sql, name).not.toMatch(/\$(?![1-9])/);
    }
    // Each statement's declaration is a plain string literal.
    const src = code(read('./identity-statements.ts'));
    for (const [name] of sqlConstants) {
      expect(src, name).toMatch(new RegExp(['export const ', name, "\\s*=\\s*['\"]"].join('')));
    }
    for (const stmt of Object.values(statements.IDENTITY_STATEMENTS)) {
      expect(Object.values(statements)).toContain(stmt.sql as never);
      const placeholders = new Set(stmt.sql.match(/\$[0-9]+/g));
      expect(placeholders.size, stmt.hop).toBe(stmt.params.length);
    }
  });
});
