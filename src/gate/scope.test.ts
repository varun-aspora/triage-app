import { afterEach, describe, expect, test } from 'bun:test';
import { makeToolContext } from '../../test/support/fake-tool-context.ts';
import type { Entity } from '../types/core.ts';
import type { IdChain, Lead } from '../types/id-chain.ts';
import { extractIdShaped } from './id-patterns.ts';
import {
  checkScope,
  createScopeSet,
  deriveLeads,
  extendScopeSet,
  type LeadLimits,
  maskId,
  observeCorrelationIds,
  observedIds,
  onlyExemptTables,
  releaseObservedIds,
  type ScopeCheckResult,
} from './scope.ts';
import { validateSelect } from './sql.ts';

// Synthetic ids only.
const RUN_CUSTOMER = '3f2b8c1e-5a47-4d9e-9b1a-0c6d2e7f8a91';
const RUN_FORM = '7a1c9e2d-4b3f-4e8a-a5d6-1f0e9c8b7a62';
const RUN_ACCOUNT = '100200300400';
const RUN_PHONE = '9000012345';
const FOREIGN_UUID = 'b4e7d2a9-1c3f-4a6b-8e5d-9f2a0c1b3d47';
const FOREIGN_ACCOUNT = '555666777888';
const FOREIGN_PHONE = '+91 90000 99999';
const TAKEN_AT = '2026-09-23T10:00:00.000Z';

function chain(ids: IdChain['ids'], hops: IdChain['hops'] = []): IdChain {
  return { ids, hops, basic_state: [] };
}

const runChain = chain(
  { customer_id: RUN_CUSTOMER, account_form_id: RUN_FORM, account_number: RUN_ACCOUNT, phone_number: RUN_PHONE },
  [
    { from: 'account_number', to: 'customer_id', source: 'ssfb:rhythm.customer_account_mappings', status: 'resolved', taken_at: TAKEN_AT },
    { from: 'customer_id', to: 'account_form_id', source: 'ssfb:harbor.customer', status: 'unverified', taken_at: TAKEN_AT },
  ],
);
const set = createScopeSet(runChain);

function expectDenied(result: ScopeCheckResult): Extract<ScopeCheckResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a deny');
  expect(result.reason.startsWith('scope: ')).toBe(true);
  return result;
}

describe('extractIdShaped', () => {
  test('finds uuids of any version, digit runs, +cc phones and emails', () => {
    const found = extractIdShaped({
      a: 'ID 3F2B8C1E-5A47-1D9E-9B1A-0C6D2E7F8A91 here',
      b: [123456789, 'short 12345678'],
      c: { phone: '+91 98765-43210', mail: 'Someone@Example.COM' },
    });
    expect(found).toEqual([
      { kind: 'uuid', raw: '3F2B8C1E-5A47-1D9E-9B1A-0C6D2E7F8A91', normalised: '3f2b8c1e-5a47-1d9e-9b1a-0c6d2e7f8a91' },
      { kind: 'digits', raw: '123456789', normalised: '123456789' },
      { kind: 'phone', raw: '+91 98765-43210', normalised: '9876543210' },
      { kind: 'email', raw: 'Someone@Example.COM', normalised: 'someone@example.com' },
    ]);
  });

  test('a uuid whose last group is all digits is reported once, as a uuid', () => {
    const found = extractIdShaped('11111111-2222-4333-8444-555555555555');
    expect(found.map((f) => f.kind)).toEqual(['uuid']);
  });

  test('object keys are checked too', () => {
    expect(extractIdShaped({ [FOREIGN_UUID]: 1 }).map((f) => f.normalised)).toEqual([FOREIGN_UUID]);
  });

  test('short numbers, timestamps and plain words are not id-shaped', () => {
    expect(extractIdShaped(['LIMIT 100', TAKEN_AT, 42, 'harbor.account_forms', null, true])).toEqual([]);
  });

  test('cyclic objects do not loop', () => {
    const a: Record<string, unknown> = { id: FOREIGN_UUID };
    a.self = a;
    expect(extractIdShaped(a)).toHaveLength(1);
  });
});

describe('createScopeSet', () => {
  test('is built from every IdChain id whatever the hop status', () => {
    expect(set.uuid.has(RUN_CUSTOMER)).toBe(true);
    expect(set.uuid.has(RUN_FORM)).toBe(true);
    expect(set.num.has(RUN_ACCOUNT)).toBe(true);
    expect(set.num.has(RUN_PHONE)).toBe(true);
  });

  test('chain values match after normalisation', () => {
    const upper = createScopeSet(chain({ customer_id: RUN_CUSTOMER.toUpperCase() }));
    expect(checkScope({ tool: 'sql_select', params: { sql: 'select 1', params: [RUN_CUSTOMER] }, scopeSet: upper }).ok).toBe(
      true,
    );
    const withCc = createScopeSet(chain({ phone_number: '+919000012345' }));
    expect(checkScope({ tool: 'http_call', params: { path: '/x', body: { mobile: RUN_PHONE } }, scopeSet: withCc }).ok).toBe(true);
    expect(checkScope({ tool: 'http_call', params: { path: '/x', body: { mobile: '919000012345' } }, scopeSet: withCc }).ok).toBe(
      true,
    );
  });

  test('a bare-digit phone_number also matches its last 10 digits; the same digits under another key do not', () => {
    const phone = createScopeSet(chain({ phone_number: '919000012345' }));
    expect(checkScope({ tool: 'http_call', params: { path: '/x', body: { mobile: RUN_PHONE } }, scopeSet: phone }).ok).toBe(true);
    const account = createScopeSet(chain({ account_number: '919000012345' }));
    expect(checkScope({ tool: 'http_call', params: { path: '/x', body: { mobile: RUN_PHONE } }, scopeSet: account }).ok).toBe(false);
  });
});

describe('checkScope allows ids in the chain', () => {
  test('run customer_id as $1', () => {
    const result = checkScope({
      tool: 'sql_select',
      params: { service: 'harbor', sql: 'SELECT * FROM customers WHERE id = $1', params: [RUN_CUSTOMER] },
      scopeSet: set,
    });
    expect(result).toEqual({ ok: true });
  });

  test('account_form_id in an http path segment', () => {
    const result = checkScope({
      tool: 'http_call',
      params: { service: 'harbor', path: `/v1/forms/${RUN_FORM}/status`, query: { verbose: 'true' } },
      scopeSet: set,
    });
    expect(result).toEqual({ ok: true });
  });

  test('account number in a logs term', () => {
    const result = checkScope({
      tool: 'logs_search',
      params: { service: 'harbor', terms: [RUN_ACCOUNT], fields: { level: 'ERROR' } },
      scopeSet: set,
      logsMode: 'search',
    });
    expect(result).toEqual({ ok: true });
  });

  test('a +91 phone with spaces matches the same 10 digits stored in the chain', () => {
    const result = checkScope({
      tool: 'logs_search',
      params: { service: 'harbor', terms: ['+91 90000 12345'] },
      scopeSet: set,
    });
    expect(result).toEqual({ ok: true });
  });

  test('params with no id-shaped values pass', () => {
    const result = checkScope({
      tool: 'sql_select',
      params: { sql: 'SELECT count(*) FROM forms WHERE status = $1 LIMIT 100', params: ['PENDING', 3] },
      scopeSet: set,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('checkScope denies ids outside the chain', () => {
  test('foreign UUID in $1', () => {
    const deny = expectDenied(
      checkScope({ tool: 'sql_select', params: { sql: 'SELECT * FROM customers WHERE id = $1', params: [FOREIGN_UUID] }, scopeSet: set }),
    );
    expect(deny.offending).toEqual([{ kind: 'uuid', masked: 'uuid:***3d47' }]);
  });

  test('foreign UUID inside a JSON string param', () => {
    const json = JSON.stringify({ filter: { customer_id: FOREIGN_UUID } });
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'SELECT $1::jsonb', params: [json] }, scopeSet: set }));
  });

  test('foreign UUID written as a literal in the SQL text', () => {
    expectDenied(
      checkScope({ tool: 'sql_select', params: { sql: `SELECT * FROM customers WHERE id = '${FOREIGN_UUID}'` }, scopeSet: set }),
    );
  });

  test('foreign UUID in an http path segment', () => {
    expectDenied(checkScope({ tool: 'http_call', params: { path: `/v1/forms/${FOREIGN_UUID}/status` }, scopeSet: set }));
  });

  test('percent-encoded foreign UUID in an http path segment', () => {
    const encoded = FOREIGN_UUID.replaceAll('-', '%2D');
    expectDenied(checkScope({ tool: 'http_call', params: { path: `/v1/forms/${encoded}` }, scopeSet: set }));
  });

  test('foreign UUID in an http query value', () => {
    expectDenied(
      checkScope({ tool: 'http_call', params: { path: `/v1/forms/${RUN_FORM}`, query: { other: FOREIGN_UUID } }, scopeSet: set }),
    );
  });

  test('foreign UUID in an http body', () => {
    expectDenied(checkScope({ tool: 'http_call', params: { path: '/v1/search', body: { ids: [FOREIGN_UUID] } }, scopeSet: set }));
  });

  test('foreign account number in a logs term', () => {
    const deny = expectDenied(
      checkScope({ tool: 'logs_search', params: { terms: [RUN_ACCOUNT, FOREIGN_ACCOUNT] }, scopeSet: set }),
    );
    expect(deny.offending).toEqual([{ kind: 'digits', masked: 'digits:***7888' }]);
  });

  test('foreign id in a logs field value or message', () => {
    expectDenied(checkScope({ tool: 'logs_search', params: { fields: { customer_id: FOREIGN_UUID } }, scopeSet: set }));
    expectDenied(checkScope({ tool: 'logs_search', params: { message: `failed for ${FOREIGN_ACCOUNT}` }, scopeSet: set }));
  });

  test('foreign id in logs any_of, exclude or contains', () => {
    for (const params of [
      { any_of: [{ terms: [RUN_ACCOUNT, FOREIGN_UUID] }] },
      { any_of: [{ message: [`failed for ${FOREIGN_ACCOUNT}`] }] },
      { exclude: [FOREIGN_UUID] },
      { contains: FOREIGN_ACCOUNT },
    ]) {
      expectDenied(checkScope({ tool: 'logs_search', params, scopeSet: set, logsMode: 'search' }));
    }
  });

  test('a foreign UUID with spaces or other separators in place of dashes is denied (D76)', () => {
    const spaced = FOREIGN_UUID.replace(/-/g, ' ');
    for (const params of [
      { terms: [spaced] },
      { terms: [FOREIGN_UUID.replace(/-/g, '_')] },
      { exclude: [spaced] },
      { any_of: [{ terms: [spaced] }] },
      { message: `failed for ${spaced}` },
      { fields: { x_req_id: spaced } },
    ]) {
      const deny = expectDenied(checkScope({ tool: 'logs_search', params, scopeSet: set }));
      expect(deny.offending).toEqual([{ kind: 'uuid', masked: 'uuid:***3d47' }]);
    }
    // The run's own UUID with spaces passes.
    expect(checkScope({ tool: 'logs_search', params: { terms: [RUN_CUSTOMER.replace(/-/g, ' ')] }, scopeSet: set })).toEqual({ ok: true });
  });

  test('contains is checked as a fragment: a piece of a foreign id is denied (D76)', () => {
    for (const [contains, kind] of [
      [FOREIGN_UUID.slice(0, -1), 'uuid'],
      ['90000999', 'digits'],
      ['someone.else@gmail', 'email'],
    ] as const) {
      const deny = expectDenied(checkScope({ tool: 'logs_search', params: { contains }, scopeSet: set }));
      expect(deny.offending.map((o) => o.kind)).toEqual([kind]);
      expect(deny.reason).toContain('contains is a substring match');
      expect(deny.reason).not.toContain(contains);
    }
  });

  test('contains passes when the fragment is part of a run id, or holds no id-like run', () => {
    for (const contains of [RUN_CUSTOMER.slice(0, 13), RUN_ACCOUNT.slice(2, 10), 'CBS_timeout', 'error-code-42']) {
      expect(checkScope({ tool: 'logs_search', params: { contains }, scopeSet: set })).toEqual({ ok: true });
    }
    const withEmail = createScopeSet(chain({ customer_id: RUN_CUSTOMER, aspora_user_id: 'someone@example.com' }));
    expect(checkScope({ tool: 'logs_search', params: { contains: 'someone@example' }, scopeSet: withEmail })).toEqual({ ok: true });
  });

  test('foreign phone in an http_call body', () => {
    const deny = expectDenied(
      checkScope({ tool: 'http_call', params: { path: '/fi/customer', body: { mobile: FOREIGN_PHONE } }, scopeSet: set }),
    );
    expect(deny.offending).toEqual([{ kind: 'phone', masked: 'phone:***9999' }]);
  });

  test('foreign account number in a finacle path', () => {
    expectDenied(checkScope({ tool: 'http_call', params: { path: `/fi/accounts/${FOREIGN_ACCOUNT}` }, scopeSet: set }));
  });

  test('foreign id uppercased or with surrounding whitespace is still denied', () => {
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'x', params: [FOREIGN_UUID.toUpperCase()] }, scopeSet: set }));
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'x', params: [`  ${FOREIGN_UUID}\n`] }, scopeSet: set }));
    expectDenied(checkScope({ tool: 'logs_search', params: { terms: [` ${FOREIGN_ACCOUNT} `] }, scopeSet: set }));
  });

  test('a seed lead from the requester text is in scope, a phone with or without its country code (D96)', () => {
    const seeded = createScopeSet({
      ...chain({}),
      leads: [
        { value: FOREIGN_UUID, kind: 'uuid', source: 'thread', label: 'Alphadesk user ID', status: 'seed' },
        { value: '+919000099999', kind: 'phone', source: 'answer', status: 'seed' },
      ],
    });
    expect(checkScope({ tool: 'sql_select', params: { sql: 'x', params: [FOREIGN_UUID] }, scopeSet: seeded })).toEqual({ ok: true });
    expect(checkScope({ tool: 'http_call', params: { path: '/fi/customer', body: { mobile: FOREIGN_PHONE } }, scopeSet: seeded })).toEqual({ ok: true });
    expect(checkScope({ tool: 'logs_search', params: { terms: ['919000099999'] }, scopeSet: seeded })).toEqual({ ok: true });
    // A later chain without the leads keeps them in scope.
    expect(extendScopeSet(seeded, chain({ customer_id: RUN_CUSTOMER })).uuid.has(FOREIGN_UUID)).toBe(true);
  });

  test('an id that appears only in model text, or in a result no in-scope id tied, is out of scope', () => {
    const modelText = `I should also look up ${FOREIGN_UUID}`;
    const toolResult = { rows: [{ referrer_id: FOREIGN_UUID }] };
    // The chain holds the resolved ids and the requester's leads; nothing else is an input.
    const fromChain = createScopeSet({
      ...chain({ customer_id: RUN_CUSTOMER }),
      leads: [{ value: RUN_FORM, kind: 'uuid', source: 'thread', status: 'seed' }],
    });
    expect(fromChain.uuid.has(RUN_FORM)).toBe(true);
    expect(fromChain.uuid.has(FOREIGN_UUID)).toBe(false);
    expect(modelText.includes(FOREIGN_UUID) && JSON.stringify(toolResult).includes(FOREIGN_UUID)).toBe(true);
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'x', params: [FOREIGN_UUID] }, scopeSet: fromChain }));
  });

  test('an empty chain denies every id-shaped value', () => {
    const empty = createScopeSet(chain({}));
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'x', params: [RUN_CUSTOMER] }, scopeSet: empty }));
  });

  test('a tool the rule does not know has its whole input checked', () => {
    expectDenied(checkScope({ tool: 'future_tool', params: { anything: FOREIGN_UUID }, scopeSet: set }));
  });
});

describe('systemic mode', () => {
  const aggregateSql = `SELECT count(*) FROM forms WHERE customer_id <> '${FOREIGN_UUID}'`;

  test('denied for sql_select when the select list is not aggregate-only', () => {
    const deny = expectDenied(
      checkScope({ tool: 'sql_select', params: { sql: 'SELECT * FROM forms' }, scopeSet: set, systemic: true, sqlAggregateOnly: false }),
    );
    expect(deny.reason).toContain('aggregate-only');
    // Missing flag is treated as not aggregate-only.
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'SELECT * FROM forms' }, scopeSet: set, systemic: true }));
  });

  test('denied for logs_search in search mode', () => {
    const deny = expectDenied(
      checkScope({ tool: 'logs_search', params: { terms: ['timeout'] }, scopeSet: set, systemic: true, logsMode: 'search' }),
    );
    expect(deny.reason).toContain('count or group_by');
    expectDenied(checkScope({ tool: 'logs_search', params: { terms: ['timeout'] }, scopeSet: set, systemic: true }));
  });

  test('systemic sql_select aggregate-only with a foreign-looking literal passes', () => {
    const result = checkScope({
      tool: 'sql_select',
      params: { sql: aggregateSql, params: [FOREIGN_ACCOUNT] },
      scopeSet: set,
      systemic: true,
      sqlAggregateOnly: true,
    });
    expect(result).toEqual({ ok: true });
  });

  test('systemic logs count and group_by pass without a foreign id, and still check ids (D76)', () => {
    const params = { message: 'CBS API error', count: true };
    expect(checkScope({ tool: 'logs_search', params, scopeSet: set, systemic: true, logsMode: 'count' })).toEqual({ ok: true });
    expect(checkScope({ tool: 'logs_search', params, scopeSet: set, systemic: true, logsMode: 'group_by' })).toEqual({ ok: true });
    const grouped = { terms: [FOREIGN_UUID], group_by: ['customer_id', 'x_req_id', 'message', 'error'] };
    for (const logsMode of ['count', 'group_by'] as const) {
      const deny = expectDenied(checkScope({ tool: 'logs_search', params: grouped, scopeSet: set, systemic: true, logsMode }));
      expect(deny.reason).toContain('scope "systemic" does not lift the id check for logs_search');
    }
  });

  test('never widens scope for http_call, a finacle path included', () => {
    expectDenied(checkScope({ tool: 'http_call', params: { path: `/v1/forms/${FOREIGN_UUID}` }, scopeSet: set, systemic: true }));
    expectDenied(
      checkScope({ tool: 'http_call', params: { path: '/x', body: { mobile: FOREIGN_PHONE } }, scopeSet: set, systemic: true }),
    );
  });

  test('aggregate-only without systemic still checks ids', () => {
    expectDenied(checkScope({ tool: 'sql_select', params: { sql: aggregateSql }, scopeSet: set, sqlAggregateOnly: true }));
    expectDenied(
      checkScope({ tool: 'logs_search', params: { terms: [FOREIGN_ACCOUNT] }, scopeSet: set, logsMode: 'count' }),
    );
  });
});

describe('config tables exempt from the id check (D89)', () => {
  // The lists come from the real registry, read the way sql_select reads them.
  const registry = makeToolContext().registry;
  const exemptFor = (entity: Entity, service: string): readonly string[] => registry.service(entity, service).scope_exempt_tables ?? [];
  const run = (sql: string, id: string, exempt: readonly string[]): ScopeCheckResult => {
    const check = validateSelect(sql);
    if (!check.ok) throw new Error(`test SQL did not parse: ${sql}`);
    return checkScope({ tool: 'sql_select', params: { sql, params: [id] }, scopeSet: set, sqlConfigTablesOnly: onlyExemptTables(check.tables, exempt) });
  };
  const BY_DEFINITION = 'SELECT steps FROM workflow_definitions WHERE external_id = $1';

  test('an unknown UUID on workflow_definitions alone is allowed on rtl:workflow', () => {
    expect(exemptFor('rtl', 'workflow')).toEqual(['workflow_definitions']);
    expect(run(BY_DEFINITION, FOREIGN_UUID, exemptFor('rtl', 'workflow'))).toEqual({ ok: true });
  });

  test('a join or subquery with workflow_executions is still checked', () => {
    const exempt = exemptFor('rtl', 'workflow');
    expectDenied(
      run(
        'SELECT d.steps FROM workflow_definitions d JOIN workflow_executions e ON e.workflow_identifier = d.external_id WHERE d.external_id = $1',
        FOREIGN_UUID,
        exempt,
      ),
    );
    expectDenied(
      run('SELECT steps FROM workflow_definitions WHERE external_id IN (SELECT workflow_identifier FROM workflow_executions WHERE reference_id = $1)', FOREIGN_UUID, exempt),
    );
    expectDenied(run('SELECT * FROM workflow_executions WHERE reference_id = $1', FOREIGN_UUID, exempt));
  });

  test('the list does not apply to another service or entity', () => {
    expect(exemptFor('rtl', 'banking')).toEqual([]);
    expect(exemptFor('ssfb', 'workflow')).toEqual([]);
    expectDenied(run(BY_DEFINITION, FOREIGN_UUID, []));
    // Without parser facts nothing is exempt.
    expect(onlyExemptTables([], ['workflow_definitions'])).toBe(false);
  });
});

describe('extendScopeSet', () => {
  test('adds a new customer_id and the old one stays allowed', () => {
    const NEW_CUSTOMER = 'c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f';
    const extended = extendScopeSet(set, chain({ customer_id: NEW_CUSTOMER }));
    const q = (id: string) => checkScope({ tool: 'sql_select', params: { sql: 'x', params: [id] }, scopeSet: extended });
    expect(q(NEW_CUSTOMER)).toEqual({ ok: true });
    expect(q(RUN_CUSTOMER)).toEqual({ ok: true });
    expect(q(RUN_ACCOUNT)).toEqual({ ok: true });
    expectDenied(q(FOREIGN_UUID));
  });

  test('does not change the original set', () => {
    const NEW_CUSTOMER = 'c9d8e7f6-a5b4-4c3d-9e2f-1a0b9c8d7e6f';
    extendScopeSet(set, chain({ customer_id: NEW_CUSTOMER }));
    expect(set.uuid.has(NEW_CUSTOMER)).toBe(false);
  });
});

describe('masking', () => {
  test('offending entries and the reason never contain the full value', () => {
    const foreign = [FOREIGN_UUID, FOREIGN_ACCOUNT, FOREIGN_PHONE, 'Other.Person@Example.com'];
    const deny = expectDenied(
      checkScope({ tool: 'http_call', params: { path: `/v1/forms/${FOREIGN_UUID}`, body: { ids: foreign } }, scopeSet: set }),
    );
    expect(deny.offending.map((o) => o.kind).sort()).toEqual(['digits', 'email', 'phone', 'uuid']);
    const text = JSON.stringify(deny);
    for (const value of [...foreign, '9000099999', 'other.person@example.com']) {
      expect(text.toLowerCase().includes(value.toLowerCase())).toBe(false);
    }
    for (const o of deny.offending) {
      expect(o.masked.startsWith(`${o.kind}:***`)).toBe(true);
      expect(o.masked.length).toBeLessThanOrEqual(o.kind.length + 4 + 4);
    }
  });

  test('a repeated foreign id is reported once', () => {
    const deny = expectDenied(
      checkScope({ tool: 'http_call', params: { path: `/v1/forms/${FOREIGN_UUID}`, query: { id: FOREIGN_UUID.toUpperCase() } }, scopeSet: set }),
    );
    expect(deny.offending).toHaveLength(1);
  });

  test('maskId keeps at most half of a short value', () => {
    expect(maskId({ kind: 'digits', normalised: '123456' })).toBe('digits:***456');
  });
});

describe('correlation ids seen earlier in the run (D77)', () => {
  const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const OTHER_REQ_ID = 'f0e1d2c3-b4a5-4968-8776-655443322110';
  const runId = 'run-scope-correlation';

  afterEach(() => void releaseObservedIds(runId));

  function observed(): ReadonlySet<string> | undefined {
    return observedIds(runId);
  }

  test('a dashed-UUID x_req_id seen in an earlier logs_search result is allowed', () => {
    observeCorrelationIds(runId, [{ service: 'harbor', x_req_id: REQ_ID.toUpperCase(), message: 'CBS API error' }]);
    for (const name of ['x_req_id', 'x-req-id']) {
      const params = { fields: { [name]: REQ_ID } };
      expect(checkScope({ tool: 'logs_search', params, scopeSet: set, observed: observed() })).toEqual({ ok: true });
    }
  });

  test('an x_txn_id never seen is refused, and the reason says why', () => {
    observeCorrelationIds(runId, [{ x_txn_id: REQ_ID }]);
    const deny = expectDenied(
      checkScope({ tool: 'logs_search', params: { fields: { x_txn_id: OTHER_REQ_ID } }, scopeSet: set, observed: observed() }),
    );
    expect(deny.reason).toBe(
      "scope: 1 id is not in the run's ID chain for logs_search (uuid:***2110); a correlation id (x_req_id, x_txn_id, x-req-id " +
        'or x-txn-id) is allowed in fields, or as a whole terms value, only once an earlier logs_search result in this run has shown it',
    );
    // Nothing observed yet: refused the same way.
    releaseObservedIds(runId);
    expectDenied(checkScope({ tool: 'logs_search', params: { fields: { x_req_id: REQ_ID } }, scopeSet: set, observed: observed() }));
  });

  test('a seen id is allowed as a whole terms value, as RTL and ATSPL search a UUID (D76)', () => {
    observeCorrelationIds(runId, [{ 'x-txn-id': REQ_ID }]);
    for (const params of [{ terms: [REQ_ID] }, { terms: [` ${REQ_ID} `, RUN_ACCOUNT] }, { any_of: [{ terms: [REQ_ID, RUN_CUSTOMER] }] }]) {
      expect(checkScope({ tool: 'logs_search', params, scopeSet: set, observed: observed() })).toEqual({ ok: true });
    }
    // Never seen: refused, with the correlation note.
    const deny = expectDenied(checkScope({ tool: 'logs_search', params: { terms: [OTHER_REQ_ID] }, scopeSet: set, observed: observed() }));
    expect(deny.reason).toContain('only once an earlier logs_search result in this run has shown it');
  });

  test('the same value in a non-correlation field, a longer term or a message is still refused', () => {
    observeCorrelationIds(runId, [{ x_req_id: REQ_ID }]);
    for (const params of [
      { fields: { form_id: REQ_ID } },
      { terms: [`req ${REQ_ID}`] },
      { message: `failed for ${REQ_ID}` },
      { fields: { x_req_id: REQ_ID, customer_id: REQ_ID } },
    ]) {
      const deny = expectDenied(checkScope({ tool: 'logs_search', params, scopeSet: set, observed: observed() }));
      expect(deny.reason).not.toContain('earlier logs_search result');
    }
  });

  test('ids are kept per run and dropped on release', () => {
    observeCorrelationIds(runId, [{ x_req_id: REQ_ID }, null, 'text', { x_txn_id: 42 }]);
    expect(observedIds('run-scope-other')).toBeUndefined();
    expect(releaseObservedIds(runId)).toBe(true);
    expect(observedIds(runId)).toBeUndefined();
    expect(releaseObservedIds(runId)).toBe(false);
  });
});

describe('derived leads (D97)', () => {
  const DEVICE_ID = 'c0ffee00-1234-4abc-8def-00000000d001';
  const VERIFICATION_ID = 'c0ffee00-1234-4abc-8def-00000000e002';
  const OTHER_DEVICE_ID = 'c0ffee00-1234-4abc-8def-00000000d003';
  const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const BY_DEVICE = 'SELECT * FROM device_auth_attempts WHERE device_id = $1';
  const LIMITS: LeadLimits = { maxDepth: 3, maxPerField: 10 };
  const LEAD_NOTE =
    "usable once it is in the requester's text or shows up in a result fetched by an id already in scope (at most 3 steps)";

  // The SQL facts come from the parser, as the pipeline passes them.
  const derive = (base: IdChain, tool: string, params: unknown, records: readonly unknown[], limits: LeadLimits = LIMITS) => {
    const check = tool === 'sql_select' ? validateSelect(String((params as { sql?: unknown }).sql)) : undefined;
    const rowKeys = check?.ok === true ? check.rowKeys : undefined;
    return deriveLeads(base, createScopeSet(base), { tool, toolCallId: 'toolu_1', params, ...(rowKeys !== undefined ? { rowKeys } : {}) }, records, limits);
  };
  const withLeads = (base: IdChain, leads: readonly Lead[]): IdChain => ({ ...base, leads: [...(base.leads ?? []), ...leads] });
  const allowed = (base: IdChain, tool: string, params: unknown): ScopeCheckResult => checkScope({ tool, params, scopeSet: createScopeSet(base) });
  const byCustomer = { fields: { 'x-customer-id': RUN_CUSTOMER } };
  const derived = (value: string, field: string, depth = 1, parent = 'uuid:***8a91'): Lead => ({
    value,
    kind: 'uuid',
    source: 'derived',
    status: 'derived',
    depth,
    parent,
    via: { tool: 'sql_select', tool_call_id: 'toolu_0', field },
  });

  test('a value from any field of a tied sql_select row becomes usable anywhere', () => {
    const sql = { service: 'rewards', sql: 'SELECT * FROM referrals WHERE referrer_id = $1', params: [RUN_CUSTOMER] };
    const rows = [{ id: 7, referee_id: FOREIGN_UUID, meta: { device: DEVICE_ID, seen: [VERIFICATION_ID] }, referrer_id: RUN_CUSTOMER }];
    const found = derive(runChain, 'sql_select', sql, rows);
    expect(found.skipped).toEqual([]);
    expect(found.leads).toEqual([
      { value: FOREIGN_UUID, kind: 'uuid', source: 'derived', status: 'derived', depth: 1, parent: 'uuid:***8a91', via: { tool: 'sql_select', tool_call_id: 'toolu_1', field: 'referee_id' } },
      { value: DEVICE_ID, kind: 'uuid', source: 'derived', status: 'derived', depth: 1, parent: 'uuid:***8a91', via: { tool: 'sql_select', tool_call_id: 'toolu_1', field: 'meta.device' } },
      { value: VERIFICATION_ID, kind: 'uuid', source: 'derived', status: 'derived', depth: 1, parent: 'uuid:***8a91', via: { tool: 'sql_select', tool_call_id: 'toolu_1', field: 'meta.seen' } },
    ]);
    const next = withLeads(runChain, found.leads);
    // A derived lead is full scope, like a chain id: any column, the SQL text, any logs part.
    for (const [tool, params] of [
      ['sql_select', { sql: BY_DEVICE, params: [DEVICE_ID] }],
      ['sql_select', { sql: 'SELECT * FROM refresh_tokens WHERE subject = $1', params: [FOREIGN_UUID] }],
      ['sql_select', { sql: `SELECT * FROM device_auth_attempts WHERE verification_id = '${VERIFICATION_ID}'` }],
      ['logs_search', { message: `bound ${DEVICE_ID}` }],
      ['logs_search', { contains: VERIFICATION_ID }],
    ] as const) {
      expect(allowed(next, tool, params)).toEqual({ ok: true });
    }
    // Before the call it was refused.
    expectDenied(allowed(runChain, 'sql_select', { sql: BY_DEVICE, params: [DEVICE_ID] }));
  });

  test('a value from any field of a tied logs_search hit becomes a lead; correlation fields keep their own rule', () => {
    const hits = [{ service: 'app-server', message: `SIM bound for device ${DEVICE_ID}`, x_req_id: REQ_ID, 'x-device-id': DEVICE_ID }];
    const found = derive(runChain, 'logs_search', byCustomer, hits);
    expect(found.leads.map((l) => [l.value, l.via?.tool, l.via?.field])).toEqual([[DEVICE_ID, 'logs_search', 'message']]);
    const next = withLeads(runChain, found.leads);
    expect(allowed(next, 'sql_select', { sql: BY_DEVICE, params: [DEVICE_ID] })).toEqual({ ok: true });
    expectDenied(allowed(next, 'sql_select', { sql: 'SELECT 1 WHERE $1 = $1', params: [REQ_ID] }));
  });

  test('an any_of group of in-scope ids ties the hits; one with other values does not', () => {
    const hits = [{ device_id: DEVICE_ID }];
    expect(derive(runChain, 'logs_search', { any_of: [{ terms: [RUN_CUSTOMER, RUN_FORM] }] }, hits).leads).toHaveLength(1);
    expect(derive(runChain, 'logs_search', { any_of: [{ terms: [RUN_CUSTOMER, 'poll'] }] }, hits).leads).toEqual([]);
  });

  test('parts the query builder ORs with other values do not tie the hits', () => {
    const hits = [{ device_id: DEVICE_ID }];
    for (const params of [
      // level and service values are ORed with the group's terms.
      { any_of: [{ terms: [RUN_CUSTOMER], level: ['error'] }] },
      { any_of: [{ terms: [RUN_CUSTOMER], service: ['app-server'] }] },
      // denoise "with_message" ORs the message with the noise filter.
      { message: `bound ${RUN_CUSTOMER}`, denoise: 'with_message' },
      // A range is not one value.
      { fields: { account_number: `[${RUN_ACCOUNT} TO 999999999999]` } },
    ]) {
      expect(derive(runChain, 'logs_search', params, hits)).toEqual({ leads: [], skipped: [] });
    }
    expect(derive(runChain, 'logs_search', { message: `bound ${RUN_CUSTOMER}`, denoise: 'only' }, hits).leads).toHaveLength(1);
    expect(derive(runChain, 'logs_search', { fields: { account_number: RUN_ACCOUNT } }, hits).leads).toHaveLength(1);
  });

  test('a key that is itself an id is named * in the field, and a nested correlation field does not mint', () => {
    const sql = { sql: 'SELECT * FROM wallets WHERE subject = $1', params: [RUN_CUSTOMER] };
    const rows = [{ balances: { [FOREIGN_UUID]: { device: DEVICE_ID } }, meta: { x_req_id: REQ_ID } }];
    const found = derive(runChain, 'sql_select', sql, rows);
    expect(found.leads.map((l) => [l.value, l.via?.field])).toEqual([[DEVICE_ID, 'balances.*.device']]);
  });

  test('rows of a join tied by a WHERE equality on the anchor count', () => {
    const sql =
      'SELECT daa.* FROM refresh_tokens rt JOIN device_auth_attempts daa ON daa.verification_id = rt.verification_id ' +
      'WHERE rt.subject = $1 ORDER BY daa.created_at';
    const found = derive(runChain, 'sql_select', { sql, params: [RUN_CUSTOMER] }, [{ device_id: DEVICE_ID }, { device_id: OTHER_DEVICE_ID }]);
    expect(found.leads.map((l) => l.value)).toEqual([DEVICE_ID, OTHER_DEVICE_ID]);
  });

  test('systemic calls, contains, exclude and untied queries never add leads', () => {
    const records = [{ 'x-device-id': DEVICE_ID, verification_id: VERIFICATION_ID, device_id: DEVICE_ID }];
    const since = 'created_at > (SELECT min(created_at) FROM refresh_tokens WHERE subject = $1)';
    for (const [tool, params] of [
      // No id at all, a correlation id, an in-scope id only in exclude or contains.
      ['logs_search', { message: 'SIM binding poll' }],
      ['logs_search', { fields: { x_req_id: REQ_ID } }],
      ['logs_search', { message: 'poll', exclude: [RUN_CUSTOMER] }],
      ['logs_search', { contains: RUN_CUSTOMER }],
      ['logs_search', { contains: RUN_CUSTOMER.slice(0, 8) }],
      ['logs_search', { terms: [RUN_CUSTOMER], group_by: ['device_id'], scope: 'systemic' }],
      // SQL whose rows are not all tied to an in-scope id.
      ['sql_select', { sql: 'SELECT device_id FROM device_auth_attempts LIMIT 5' }],
      ['sql_select', { sql: 'SELECT device_id FROM refresh_tokens WHERE subject = $1', params: [RUN_CUSTOMER], scope: 'systemic' }],
      ['sql_select', { sql: 'SELECT device_id FROM refresh_tokens WHERE subject <> $1', params: [RUN_CUSTOMER] }],
      ['sql_select', { sql: `SELECT device_id FROM refresh_tokens -- ${RUN_CUSTOMER}` }],
      ['sql_select', { sql: 'SELECT device_id FROM refresh_tokens WHERE subject = $1 OR true', params: [RUN_CUSTOMER] }],
      ['sql_select', { sql: 'SELECT device_id FROM refresh_tokens WHERE NOT (subject = $1)', params: [RUN_CUSTOMER] }],
      ['sql_select', { sql: `SELECT device_id FROM device_auth_attempts WHERE ${since}`, params: [RUN_CUSTOMER] }],
      ['sql_select', { sql: 'SELECT d.device_id FROM refresh_tokens r, device_auth_attempts d WHERE r.subject = $1', params: [RUN_CUSTOMER] }],
      ['sql_select', { sql: 'SELECT d.device_id FROM refresh_tokens r JOIN device_auth_attempts d ON r.status = d.status WHERE r.subject = $1', params: [RUN_CUSTOMER] }],
      ['sql_select', { sql: 'SELECT device_id FROM refresh_tokens WHERE subject = $1 UNION SELECT device_id FROM device_auth_attempts', params: [RUN_CUSTOMER] }],
      // A tool the rule cannot tie.
      ['http_call', { path: `/users/${RUN_CUSTOMER}` }],
    ] as const) {
      expect(derive(runChain, tool, params, records)).toEqual({ leads: [], skipped: [] });
    }
    // The pipeline's own systemic flag counts too.
    const bySubject = { sql: 'SELECT device_id FROM refresh_tokens WHERE subject = $1', params: [RUN_CUSTOMER] };
    const check = validateSelect(bySubject.sql);
    const rowKeys = check.ok ? check.rowKeys : undefined;
    expect(rowKeys).toBeDefined();
    const call = { tool: 'sql_select', toolCallId: 'toolu_1', params: bySubject, systemic: true, ...(rowKeys !== undefined ? { rowKeys } : {}) };
    expect(deriveLeads(runChain, set, call, records, LIMITS).leads).toEqual([]);
  });

  test('a value already in scope is not added again', () => {
    const rows = [{ subject: RUN_CUSTOMER, form: RUN_FORM, account: RUN_ACCOUNT, phone: `+91 ${RUN_PHONE}` }];
    expect(derive(runChain, 'sql_select', { sql: 'SELECT * FROM t WHERE subject = $1', params: [RUN_CUSTOMER] }, rows).leads).toEqual([]);
  });

  test('a phone keeps its country code and is then in scope with or without it', () => {
    const found = derive(runChain, 'sql_select', { sql: 'SELECT * FROM t WHERE subject = $1', params: [RUN_CUSTOMER] }, [{ mobile: FOREIGN_PHONE }]);
    expect(found.leads.map((l) => [l.value, l.kind])).toEqual([['+919000099999', 'phone']]);
    const next = withLeads(runChain, found.leads);
    expect(allowed(next, 'logs_search', { terms: ['9000099999'] })).toEqual({ ok: true });
    expect(allowed(next, 'http_call', { path: '/fi/customer', body: { mobile: FOREIGN_PHONE } })).toEqual({ ok: true });
  });

  test('depth is one more than the shallowest anchor, and nothing is added past the limit', () => {
    const byDevice = { sql: BY_DEVICE, params: [DEVICE_ID] };
    const rows = [{ verification_id: VERIFICATION_ID }];
    // Anchored on a depth-1 lead: depth 2, parent that lead.
    const one = withLeads(runChain, [derived(DEVICE_ID, 'device_id', 1)]);
    expect(derive(one, 'sql_select', byDevice, rows).leads.map((l) => [l.depth, l.parent])).toEqual([[2, 'uuid:***d001']]);
    // Anchored on a depth-3 lead: past the limit, the field is skipped with a count.
    const three = withLeads(runChain, [derived(DEVICE_ID, 'device_id', 3)]);
    expect(derive(three, 'sql_select', byDevice, rows)).toEqual({ leads: [], skipped: [{ reason: 'depth', field: 'verification_id', count: 1 }] });
    // A lower limit stops earlier.
    expect(derive(one, 'sql_select', byDevice, rows, { ...LIMITS, maxDepth: 1 }).skipped).toEqual([{ reason: 'depth', field: 'verification_id', count: 1 }]);
    // Tied by a chain id as well: the shallowest anchor wins.
    const both = { sql: 'SELECT * FROM device_auth_attempts WHERE device_id = $1 AND subject = $2', params: [DEVICE_ID, RUN_CUSTOMER] };
    expect(derive(three, 'sql_select', both, rows).leads.map((l) => [l.depth, l.parent])).toEqual([[1, 'uuid:***8a91']]);
    // A lead the chain also holds as an id is depth 0.
    const alsoId = withLeads(chain({ customer_id: DEVICE_ID }), [derived(DEVICE_ID, 'device_id', 3)]);
    expect(derive(alsoId, 'sql_select', byDevice, rows).leads.map((l) => l.depth)).toEqual([1]);
  });

  test('a field with more new values than the limit adds none; other fields still do', () => {
    const uuid = (n: number): string => `c0ffee00-1234-4abc-8def-${String(n).padStart(12, '0')}`;
    const sql = { sql: 'SELECT * FROM referrals WHERE referrer_id = $1', params: [RUN_CUSTOMER] };
    const rows = Array.from({ length: 11 }, (_, i) => ({ referee_id: uuid(i), device_id: i < 10 ? uuid(100 + i) : uuid(100) }));
    const found = derive(runChain, 'sql_select', sql, rows);
    expect(found.skipped).toEqual([{ reason: 'fan-out', field: 'referee_id', count: 11 }]);
    expect(found.leads.map((l) => l.via?.field)).toEqual(Array(10).fill('device_id'));
    // Exactly at the limit: all ten are added.
    expect(derive(runChain, 'sql_select', sql, rows.slice(0, 10)).leads.filter((l) => l.via?.field === 'referee_id')).toHaveLength(10);
  });

  test('a value only in model text is still refused, and the reason says how it could become usable', () => {
    const modelText = `the referee is probably ${FOREIGN_UUID}`;
    expect(modelText).toContain(FOREIGN_UUID);
    const sql = expectDenied(allowed(runChain, 'sql_select', { sql: 'SELECT * FROM refresh_tokens WHERE subject = $1', params: [FOREIGN_UUID] }));
    expect(sql.reason).toBe(`scope: 1 id is not in the run's ID chain for sql_select (uuid:***3d47); ${LEAD_NOTE}`);
    const terms = expectDenied(allowed(runChain, 'logs_search', { terms: [FOREIGN_UUID] }));
    expect(terms.reason).toContain(LEAD_NOTE);
    expect(terms.reason).toContain('a correlation id');
    // A correlation field gets only the correlation note: it never becomes a lead.
    const field = expectDenied(allowed(runChain, 'logs_search', { fields: { x_req_id: FOREIGN_UUID } }));
    expect(field.reason).not.toContain(LEAD_NOTE);
    // The limit in the note follows TRIAGE_MAX_LEAD_DEPTH.
    const two = expectDenied(checkScope({ tool: 'sql_select', params: { sql: 'x', params: [FOREIGN_UUID] }, scopeSet: set, maxLeadDepth: 1 }));
    expect(two.reason).toContain('(at most 1 step)');
  });
});
