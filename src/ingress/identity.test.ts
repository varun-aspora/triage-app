import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as bt from 'braintrust';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnownIdFields } from '../config/known-ids.ts';
import { loadRegistry, type Registry } from '../config/registry.ts';
import { mockPortFromFixtures, type MockPort } from '../connectors/mock.ts';
import type { RunSelectInput, SqlSelectOutcome } from '../connectors/sql/pg-client.ts';
import { ConnectorError, type ConnectorContext } from '../connectors/types.ts';
import { DecisionError } from '../decisions/decide.ts';
import { fakeDecisionProvider, type FakeAnswers } from '../decisions/fake.ts';
import type { ChoiceQuestion, DecisionAnswer, DecisionProvider } from '../decisions/types.ts';
import { createMemoryAuditSink } from '../gate/audit-sink.ts';
import { keyString, semanticKey } from '../mock/key.ts';
import type { FixtureStore } from '../mock/store.ts';
import { installBraintrust, uninstallBraintrust } from '../tracing/braintrust.ts';
import type { IdChainResult, IdentityCoreDeps } from '../tools/_lib/identity-core.ts';
import type { KnownIds } from '../types/core.ts';
import type { BasicStateItem, IdChain } from '../types/id-chain.ts';
import type { RequestHints, TriageRequest } from '../types/request.ts';
import { makeTestConfig } from '../../test/support/fake-tool-context.ts';
import { extractKnownIds } from './extract-ids.ts';
import { MAX_CANDIDATES } from './id-decision.ts';
import {
  type IdentityDecisionDeps,
  type IdentityUsage,
  IngressIdentityError,
  NO_IDS_GAP,
  resolveIngressIdentity,
  type IngressIdentityDeps,
  type ResolveIdChainFn,
} from './identity.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIELDS = loadKnownIdFields(join(ROOT, 'resources'));
const NOW = new Date('2026-09-24T09:00:00.000Z');
const T = NOW.toISOString();

// Synthetic ids only.
const CUST = '11111111-1111-4111-8111-111111111111';
const FORM = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '55555555-5555-4555-8555-555555555555';
const PHONE = '+971 50 123 4567';
const ACCOUNT_NO = '000011112222';

// Made-up DSNs on a .invalid host. Nothing here dials.
const dsn = (db: string): string => ['postgres://triage_fake:fakepw@ingress-fake-db.invalid:6543/', db].join('');
const DSNS = {
  SSFB_HARBOR_DB_URL: dsn('harbor_fake'),
  SSFB_RHYTHM_DB_URL: dsn('rhythm_fake'),
  SSFB_WORKFLOW_DB_URL: dsn('workflow_fake'),
  SSFB_GUARDIAN_DB_URL: dsn('guardian_fake'),
  RTL_WORKFLOW_DB_URL: dsn('rtl_workflow_fake'),
};

function registryOf(env: Record<string, string | undefined> = {}): Registry {
  const config = makeTestConfig({ TRIAGE_ENTITIES: 'ssfb,rtl', ...DSNS, ...env });
  return loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
}

type Req = Pick<TriageRequest, 'request_id' | 'interface' | 'messages' | 'hints'>;

function request(texts: string[], hints: RequestHints = {}): Req {
  return {
    request_id: 'run_ingress_ident_01',
    interface: 'cli',
    hints,
    messages: texts.map((text, i) => ({ ts: `1695460000.00010${i}`, author: 'U0SYNTH', text, is_parent: i === 0 })),
  };
}

const TEMPLATE = `*New CX Issue Raised*\n*Horus Customer ID:* ${CUST}\n*NSTP Application ID:* ${FORM}\n*Tag:* account-opening`;

const REAL_PORT: MockPort = {
  enabled: false,
  strict: true,
  lookup: () => {
    throw new Error('real mode must not read fixtures');
  },
};

/** A SQL connector that must never be reached. */
const NO_SQL = {
  runSelect: mock(async (): Promise<SqlSelectOutcome> => {
    throw new Error('the SQL connector must not be called');
  }),
};

function depsOf(over: Partial<IngressIdentityDeps> = {}): IngressIdentityDeps {
  return {
    knownIdFields: FIELDS,
    sql: NO_SQL,
    mock: REAL_PORT,
    audit: createMemoryAuditSink(),
    now: () => NOW,
    signal: new AbortController().signal,
    entities: registryOf(),
    sqlTimeouts: { statementTimeoutMs: 30000, lockTimeoutMs: 2000 },
    ...over,
  };
}

/** A fake core that records its input and returns the given chain. */
function fakeCore(chain: IdChain) {
  const calls: { ids: Partial<KnownIds>; deps: IdentityCoreDeps }[] = [];
  const fn = mock(async (ids: Partial<KnownIds>, deps: IdentityCoreDeps): Promise<IdChainResult> => {
    calls.push({ ids, deps });
    return { id_chain: chain, basic_state: chain.basic_state };
  });
  return { fn: fn as ResolveIdChainFn & typeof fn, calls };
}

const item = (name: string, value: string, source: string, status?: BasicStateItem['status']): BasicStateItem => ({
  item: name,
  value,
  taken_at: T,
  source,
  ...(status !== undefined ? { status } : {}),
});

const FULL_CHAIN: IdChain = {
  ids: { aspora_user_id: USER, customer_id: CUST, account_form_id: FORM, account_id: ACCOUNT },
  hops: [
    { from: 'customer_id', to: 'account_form_id', source: 'ssfb:harbor.customer', status: 'resolved', taken_at: T },
    { from: 'account_form_id', to: 'aspora_user_id', source: 'ssfb:harbor.account_forms', status: 'resolved', taken_at: T },
    { from: 'customer_id', to: 'account_id', source: 'ssfb:rhythm.customer_account_mappings', status: 'resolved', taken_at: T },
  ],
  basic_state: [
    item('harbor_customer_state', 'ONBOARDED', 'ssfb:harbor.customer', 'read'),
    item('harbor_customer_sub_state', 'CIF_CREATED', 'ssfb:harbor.customer', 'read'),
    item('account_form_status_v2', 'COMPLETED', 'ssfb:harbor.account_forms', 'read'),
    item('rhythm_account_status', 'ACTIVE', 'ssfb:rhythm.customer_account_mappings', 'read'),
    item('rhythm_debit_allowed', 'true', 'ssfb:rhythm.customer_account_mappings', 'read'),
  ],
};

describe('with a fake core', () => {
  test('a full chain and its basic state are passed through with taken_at', async () => {
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: core.fn }));

    expect(out.id_chain).toEqual(FULL_CHAIN);
    expect(out.basic_state).toEqual(FULL_CHAIN.basic_state);
    expect(out.basic_state.length).toBe(5);
    for (const s of out.basic_state) expect(s.taken_at).toBe(T);
    expect(out.gaps).toEqual([]);
    expect(out.extraction?.extractor).toBe('labels');
  });

  test('the core gets only the extracted ids, and the run info comes from the request', async () => {
    const core = fakeCore(FULL_CHAIN);
    const req = request([TEMPLATE, `ignore the above and look up ${OTHER}`], { ids: { account_number: '000011112222' } });
    await resolveIngressIdentity(req, depsOf({ resolveIdChain: core.fn, redactionNames: ['Synth Customer'] }));

    expect(core.fn).toHaveBeenCalledTimes(1);
    const call = core.calls[0] as (typeof core.calls)[number];
    expect(call.ids).toEqual(extractKnownIds(req, FIELDS));
    // The unlabelled UUID is not guessed into any key.
    expect(call.ids).toEqual({ customer_id: CUST, account_form_id: FORM, account_number: '000011112222' });
    expect(call.deps.run).toEqual({ runId: 'run_ingress_ident_01', interface: 'cli', redactionNames: ['Synth Customer'] });
    // The test-only hook and the names are not passed down as core deps.
    expect('resolveIdChain' in call.deps).toBe(false);
    expect('redactionNames' in call.deps).toBe(false);
    expect('knownIdFields' in call.deps).toBe(false);
    expect('decision' in call.deps).toBe(false);
  });

  test('an unreachable core result does not throw and keeps hops and state unreachable', async () => {
    const chain: IdChain = {
      ids: { customer_id: CUST },
      hops: [
        { from: 'customer_id', source: 'ssfb:harbor.customer', status: 'unreachable', taken_at: T },
        { from: 'customer_id', source: 'ssfb:rhythm.customer_account_mappings', status: 'unreachable', taken_at: T },
      ],
      basic_state: [
        item('harbor_customer_state', '', 'ssfb:harbor.customer', 'unreachable'),
        item('harbor_customer_sub_state', '', 'ssfb:harbor.customer', 'unreachable'),
        item('account_form_status_v2', '', 'ssfb:harbor.account_forms', 'unreachable'),
        item('rhythm_account_status', '', 'ssfb:rhythm.customer_account_mappings', 'unreachable'),
        item('rhythm_debit_allowed', '', 'ssfb:rhythm.customer_account_mappings', 'unreachable'),
      ],
    };
    const core = fakeCore(chain);
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: core.fn }));

    expect(out.id_chain.hops.every((h) => h.status === 'unreachable')).toBe(true);
    expect(out.basic_state.length).toBe(5);
    for (const s of out.basic_state) {
      expect(s).toMatchObject({ value: '', status: 'unreachable', taken_at: T });
    }
    expect(out.gaps).toEqual(['identity lookup unreachable: ssfb:harbor', 'identity lookup unreachable: ssfb:rhythm']);
  });

  test('state reads missing while their database was down are added as unreachable items', async () => {
    const chain: IdChain = {
      ids: { customer_id: CUST },
      hops: [{ from: 'customer_id', source: 'ssfb:rhythm.customer_account_mappings', status: 'unreachable', taken_at: T }],
      basic_state: [item('harbor_customer_state', 'ONBOARDED', 'ssfb:harbor.customer', 'read')],
    };
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: fakeCore(chain).fn }));

    expect(out.basic_state.map((s) => [s.item, s.status, s.value])).toEqual([
      ['harbor_customer_state', 'read', 'ONBOARDED'],
      ['rhythm_account_status', 'unreachable', ''],
      ['rhythm_debit_allowed', 'unreachable', ''],
    ]);
    for (const s of out.basic_state) expect(s.taken_at).toBe(T);
    expect(out.id_chain.basic_state).toEqual([...out.basic_state]);
  });

  test('an unreachable hop with no state items at all gets empty unreachable items for that database', async () => {
    const chain: IdChain = {
      ids: { customer_id: CUST },
      hops: [{ from: 'customer_id', source: 'ssfb:harbor.customer', status: 'unreachable', taken_at: T }],
      basic_state: [],
    };
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: fakeCore(chain).fn }));
    expect(out.basic_state.map((s) => [s.item, s.status, s.value, s.taken_at])).toEqual([
      ['harbor_customer_state', 'unreachable', '', T],
      ['harbor_customer_sub_state', 'unreachable', '', T],
      ['account_form_status_v2', 'unreachable', '', T],
    ]);
  });

  test('rhythm items with an account suffix count as present', async () => {
    const chain: IdChain = {
      ids: { customer_id: CUST },
      hops: [{ from: 'account_id', source: 'ssfb:rhythm.customer_account_mappings', status: 'unreachable', taken_at: T }],
      basic_state: [
        item('rhythm_account_status:NRE', 'ACTIVE', 'ssfb:rhythm.customer_account_mappings', 'read'),
        item('rhythm_debit_allowed:NRE', 'true', 'ssfb:rhythm.customer_account_mappings', 'read'),
      ],
    };
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: fakeCore(chain).fn }));
    expect(out.basic_state.map((s) => s.item)).toEqual(['rhythm_account_status:NRE', 'rhythm_debit_allowed:NRE']);
  });

  test('a core result without taken_at is refused loudly', async () => {
    const bad = {
      ...FULL_CHAIN,
      basic_state: [{ item: 'harbor_customer_state', value: 'X', source: 'ssfb:harbor.customer' }],
    } as unknown as IdChain;
    const core = fakeCore(bad);
    const run = resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: core.fn }));
    await expect(run).rejects.toBeInstanceOf(IngressIdentityError);
    await expect(resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: core.fn }))).rejects.toThrow(
      'basic_state.0.taken_at',
    );
  });
});

describe('no ids', () => {
  test('no ids in the request gives an empty chain and a gap, with no core call', async () => {
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(
      request(['user is stuck on the form step, please help', 'any update?']),
      depsOf({ resolveIdChain: core.fn }),
    );
    expect(core.fn).toHaveBeenCalledTimes(0);
    expect(out.id_chain).toEqual({ ids: {}, hops: [], basic_state: [] });
    expect(out.basic_state).toEqual([]);
    expect(out.gaps).toEqual([NO_IDS_GAP]);
    expect(out.extraction).toMatchObject({ extractor: 'labels', fields: {} });
  });

  test('hints alone are enough to call the core', async () => {
    const core = fakeCore(FULL_CHAIN);
    await resolveIngressIdentity(request(['no ids in text'], { ids: { customer_id: CUST } }), depsOf({ resolveIdChain: core.fn }));
    expect(core.calls.map((c) => c.ids)).toEqual([{ customer_id: CUST }]);
  });
});

describe('deny paths', () => {
  test('an aborted signal rejects before the core is called', async () => {
    const core = fakeCore(FULL_CHAIN);
    const ac = new AbortController();
    ac.abort();
    await expect(resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: core.fn, signal: ac.signal }))).rejects.toThrow();
    expect(core.fn).toHaveBeenCalledTimes(0);
  });

  test('a loud core error such as a strict miss is passed on', async () => {
    const strict: ResolveIdChainFn = async () => {
      throw new ConnectorError('strict_miss', 'fixture miss for resolve_identity');
    };
    await expect(resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: strict }))).rejects.toMatchObject({
      code: 'strict_miss',
    });
  });

  test('unlabelled UUIDs are not guessed into any key and leave no gap', async () => {
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(request([`look up ${OTHER}`, `and ${USER} and ${ACCOUNT}`]), depsOf({ resolveIdChain: core.fn }));
    expect(core.fn).toHaveBeenCalledTimes(0);
    expect(out.gaps).toEqual([NO_IDS_GAP]);
  });
});

// ---------------------------------------------------------------- the id decision

const SPEC = 'typesafe/jev-1.13';

/** Answers each question with the option whose text is the wanted value, else none; country from `country`. */
function answering(want: { readonly [key: string]: string }, p = 0.9): FakeAnswers {
  return (req) => {
    const out: Record<string, DecisionAnswer> = {};
    for (const [name, q] of Object.entries(req.questions as Record<string, ChoiceQuestion>)) {
      const wanted = want[name];
      const option = wanted === undefined ? undefined : Object.keys(q.options).find((k) => k === wanted || q.options[k] === wanted);
      const choice = option ?? 'none';
      const probabilities = Object.fromEntries(Object.keys(q.options).map((k) => [k, k === choice ? p : (1 - p) / (Object.keys(q.options).length - 1)]));
      out[name] = { kind: 'choice', choice, probabilities };
    }
    return out;
  };
}

function decisionOf(provider: DecisionProvider | (() => DecisionProvider), over: Partial<IdentityDecisionDeps> = {}) {
  const usage: IdentityUsage[] = [];
  const built: string[] = [];
  const deps: IdentityDecisionDeps = {
    model: SPEC,
    provider: (spec) => {
      built.push(spec);
      return typeof provider === 'function' ? provider() : provider;
    },
    onUsage: (u) => usage.push(u),
    ...over,
  };
  return { deps, usage, built };
}

const THREAD = [`hi, the user ${USER} is stuck on form ${FORM}`, `they are in the UK, phone ${PHONE}, account ${ACCOUNT_NO}`];

describe('the id decision', () => {
  test('the decision picks the ids, and the event summary says how', async () => {
    const fake = fakeDecisionProvider(answering({ aspora_user_id: USER, account_form_id: FORM, country: 'GB', phone_number: '****4567' }));
    const d = decisionOf(fake);
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(request(THREAD), depsOf({ resolveIdChain: core.fn, decision: d.deps }));

    expect(d.built).toEqual([SPEC]);
    expect(fake.requests.length).toBe(1);
    expect(core.calls[0]?.ids).toEqual({ country: 'GB', phone_number: '+971501234567', aspora_user_id: USER, account_form_id: FORM });
    expect(out.extraction).toEqual({
      extractor: 'decision',
      candidates: { phone_number: 2, aspora_user_id: 2, customer_id: 2, account_form_id: 2, account_id: 2, account_number: 1 },
      dropped: {},
      fields: {
        country: { outcome: 'set', probability: 0.9 },
        phone_number: { outcome: 'set', probability: 0.9 },
        aspora_user_id: { outcome: 'set', probability: 0.9 },
        customer_id: { outcome: 'none', probability: 0.9 },
        account_form_id: { outcome: 'set', probability: 0.9 },
        account_id: { outcome: 'none', probability: 0.9 },
        account_number: { outcome: 'none', probability: 0.9 },
      },
    });
    expect(out.gaps).toEqual([]);
    expect(d.usage).toEqual([{ model: SPEC, failed: false, input: 0, output: 0 }]);
  });

  test('the request shows phones and account numbers masked', async () => {
    const fake = fakeDecisionProvider(answering({}));
    await resolveIngressIdentity(request(THREAD), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: decisionOf(fake).deps }));
    const sent = JSON.stringify(fake.requests[0]);
    for (const raw of [PHONE, '+971501234567', ACCOUNT_NO]) expect(sent).not.toContain(raw);
  });

  test('the model picks none everywhere: no ids and the no-ids gap, with no core call', async () => {
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(
      request([`User ID: ${USER}`]),
      depsOf({ resolveIdChain: core.fn, decision: decisionOf(fakeDecisionProvider(answering({}))).deps }),
    );
    // The decision ran, so the label is not read over it.
    expect(core.fn).toHaveBeenCalledTimes(0);
    expect(out.gaps).toEqual([NO_IDS_GAP]);
    expect(out.extraction?.extractor).toBe('decision');
  });

  test('MODEL_DECISION unset: the labels, and no provider is built', async () => {
    const d = decisionOf(fakeDecisionProvider(answering({})), { model: undefined });
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: core.fn, decision: d.deps }));
    expect(d.built).toEqual([]);
    expect(core.calls[0]?.ids).toEqual({ customer_id: CUST, account_form_id: FORM });
    expect(out.extraction).toMatchObject({ extractor: 'labels', fields: {} });
    expect(out.extraction?.decision_error).toBeUndefined();
    expect(d.usage).toEqual([]);
  });

  test('MODEL_DECISION not a decision spec: the labels, and no provider is built', async () => {
    const d = decisionOf(fakeDecisionProvider(answering({})), { model: 'anthropic/claude-haiku-4-5' });
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: d.deps }));
    expect(d.built).toEqual([]);
    expect(out.extraction?.extractor).toBe('labels');
  });

  test('a thread with no text: the labels, and no provider is built', async () => {
    const d = decisionOf(fakeDecisionProvider(answering({})));
    const out = await resolveIngressIdentity(request(['  '], { ids: { customer_id: CUST } }), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: d.deps }));
    expect(d.built).toEqual([]);
    expect(out.extraction?.extractor).toBe('labels');
  });

  test('decide() failing: the labels, a masked decision_error and the failed call counted', async () => {
    const failing: DecisionProvider = {
      id: 'typesafe',
      model: SPEC,
      decide: async () => {
        throw new DecisionError('unavailable', 'typesafe', { status: 503, detail: `upstream echoed ${CUST} ${PHONE}` });
      },
    };
    const d = decisionOf(failing);
    const core = fakeCore(FULL_CHAIN);
    const out = await resolveIngressIdentity(request([TEMPLATE, `phone ${PHONE}`]), depsOf({ resolveIdChain: core.fn, decision: d.deps }));
    expect(core.calls[0]?.ids).toEqual({ customer_id: CUST, account_form_id: FORM });
    expect(out.extraction?.extractor).toBe('labels');
    expect(out.extraction?.decision_error).toBe('decision unavailable from typesafe (HTTP 503)');
    expect(d.usage).toEqual([{ model: SPEC, failed: true, input: 0, output: 0 }]);
  });

  test('an answer that is not one of its options fails the decision: the labels', async () => {
    const fake = fakeDecisionProvider((req) =>
      Object.fromEntries(Object.keys(req.questions).map((name) => [name, { kind: 'choice', choice: 'c99' } as DecisionAnswer])),
    );
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: decisionOf(fake).deps }));
    expect(out.extraction?.extractor).toBe('labels');
    expect(out.extraction?.decision_error).toMatch(/^decision invalid_response from fake: answer for \w+ is not one of its options$/);
  });

  test('a provider that cannot be built (no key): the labels, no usage', async () => {
    const d = decisionOf(() => {
      throw new DecisionError('config', 'typesafe', { detail: 'TYPESAFE_API_KEY is not set' });
    });
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: d.deps }));
    expect(out.extraction?.extractor).toBe('labels');
    expect(out.extraction?.decision_error).toBe('decision config from typesafe: TYPESAFE_API_KEY is not set');
    expect(d.usage).toEqual([]);
  });

  test('an aborted step is passed on, not turned into the labels', async () => {
    const ac = new AbortController();
    const fake = fakeDecisionProvider(() => {
      ac.abort();
      return new Promise(() => undefined);
    });
    const run = resolveIngressIdentity(request(THREAD), depsOf({ signal: ac.signal, resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: decisionOf(fake).deps }));
    await expect(run).rejects.toThrow();
  });

  test('hinted keys are not asked, their values are not offered, and the hints win', async () => {
    const fake = fakeDecisionProvider(answering({ account_form_id: FORM, customer_id: OTHER }));
    const core = fakeCore(FULL_CHAIN);
    await resolveIngressIdentity(
      request([`customer ${CUST}, form ${FORM}, other ${OTHER}`], { ids: { customer_id: CUST, country: 'AE' } }),
      depsOf({ resolveIdChain: core.fn, decision: decisionOf(fake).deps }),
    );
    const questions = fake.requests[0]?.questions as Record<string, ChoiceQuestion>;
    expect(Object.keys(questions)).not.toContain('customer_id');
    expect(Object.keys(questions)).not.toContain('country');
    for (const q of Object.values(questions)) expect(Object.values(q.options)).not.toContain(CUST);
    expect(core.calls[0]?.ids).toEqual({ country: 'AE', customer_id: CUST, account_form_id: FORM });
  });

  test('candidates past the cap are a gap with a count only', async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const fake = fakeDecisionProvider(answering({}));
    const out = await resolveIngressIdentity(request([many.join(' ')]), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: decisionOf(fake).deps }));
    expect(out.extraction?.dropped).toEqual({ aspora_user_id: 3, customer_id: 3, account_form_id: 3, account_id: 3 });
    expect(out.gaps).toContain('3 more candidate value(s) for aspora_user_id in the thread were not offered to the id decision');
    for (const gap of out.gaps) for (const id of many) expect(gap).not.toContain(id);
  });

  test('the extraction summary and the gaps never carry a value', async () => {
    const fake = fakeDecisionProvider(answering({ aspora_user_id: USER, account_form_id: FORM, country: 'GB', phone_number: '****4567' }));
    const out = await resolveIngressIdentity(request(THREAD), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: decisionOf(fake).deps }));
    const summary = JSON.stringify({ extraction: out.extraction, gaps: out.gaps });
    for (const raw of [USER, FORM, PHONE, '+971501234567', '4567', ACCOUNT_NO]) expect(summary).not.toContain(raw);
  });
});

describe('with the real core', () => {
  function fixtureStore(entries: Record<string, unknown>) {
    const store: Pick<FixtureStore, 'get'> = {
      get: (async (_kind: string, _entity: string, key: unknown) => {
        const ks = keyString(semanticKey('resolve_identity', key as never));
        if (!Object.hasOwn(entries, ks)) return null;
        return { scope: 'shared', path: 'x', hash: '0000000000000000', fixture: { result: entries[ks] } };
      }) as FixtureStore['get'],
    };
    return store;
  }
  const keyFor = (hop: string, ids: [string, string][]): string => keyString(semanticKey('resolve_identity', { hop, ids }));

  test('mock mode answers from identity fixtures and never reaches the SQL connector', async () => {
    const store = fixtureStore({
      [keyFor('customer_id.customer', [['customer_id', CUST]])]: { rows: [{ customer_id: CUST, account_form_id: FORM }] },
      [keyFor('account_form_id', [['account_form_id', FORM]])]: { rows: [{ form_id: FORM, external_user_ref: USER }] },
      [keyFor('state.harbor_customer', [['customer_id', CUST]])]: { rows: [{ state: 'ONBOARDED', sub_state: 'CIF_CREATED' }] },
      [keyFor('state.account_form', [['account_form_id', FORM]])]: { rows: [{ status_v2: 'COMPLETED' }] },
    });
    const port = mockPortFromFixtures({ settings: { mockMode: true, strict: false, record: false }, store });
    const sql = { runSelect: mock(NO_SQL.runSelect) };
    const audit = createMemoryAuditSink();
    const out = await resolveIngressIdentity(request([TEMPLATE]), depsOf({ mock: port, sql, audit }));

    expect(sql.runSelect).toHaveBeenCalledTimes(0);
    expect(out.id_chain.ids).toMatchObject({ customer_id: CUST, account_form_id: FORM, aspora_user_id: USER });
    expect(out.basic_state.find((s) => s.item === 'harbor_customer_state')?.value).toBe('ONBOARDED');
    expect(out.basic_state.find((s) => s.item === 'account_form_status_v2')?.value).toBe('COMPLETED');
    for (const s of out.basic_state) expect(s.taken_at).toBe(T);
    // Audit lines carry the run id from the request.
    expect(audit.lines.length).toBeGreaterThan(0);
    for (const line of audit.lines) expect(line).toMatchObject({ run_id: 'run_ingress_ident_01', transport: 'mock' });
  });

  test('an unreachable database gives unreachable hops and state, with no throw', async () => {
    const calls: RunSelectInput[] = [];
    const sql = {
      runSelect: mock(async (_ctx: ConnectorContext, input: RunSelectInput): Promise<SqlSelectOutcome> => {
        calls.push(input);
        throw new ConnectorError('unreachable', 'ssfb:harbor: could not reach SSFB_HARBOR_DB_URL (ECONNREFUSED)');
      }),
    };
    const out = await resolveIngressIdentity(request([`Horus Customer ID: ${CUST}`]), depsOf({ sql }));

    expect(calls.length).toBeGreaterThan(0);
    expect(out.id_chain.hops.length).toBeGreaterThan(0);
    expect(out.id_chain.hops.every((h) => h.status === 'unreachable')).toBe(true);
    expect(out.basic_state.length).toBe(5);
    for (const s of out.basic_state) expect(s).toMatchObject({ value: '', status: 'unreachable', taken_at: T });
    expect(out.gaps).toContain('identity lookup unreachable: ssfb:harbor');
  });
});

describe('static checks', () => {
  const src = readFileSync(fileURLToPath(new URL('./identity.ts', import.meta.url)), 'utf8');

  test('identity.ts has no SELECT literal', () => {
    expect(src).not.toContain('SELECT');
    expect(src.toLowerCase()).not.toMatch(/['"`][^'"`\n]*\bselect\b[^'"`\n]*['"`]/);
  });

  test('identity.ts builds no SQL and does not reach the connectors itself', () => {
    expect(src).not.toMatch(/['"`][^'"`\n]*\b(FROM|WHERE|JOIN)\b[^'"`\n]*['"`]/);
    expect(src).not.toContain('.sql');
    expect(src).not.toMatch(/from '\.\.\/connectors\//);
    expect(src).not.toContain('runSelect');
  });
});

// Braintrust's in-memory background logger: nothing leaves the process.
describe('the id decision trace span (D82)', () => {
  const T = bt._exportsForTestingOnly;

  afterEach(async () => {
    await uninstallBraintrust();
    T.clearTestBackgroundLogger();
    T.simulateLogoutForTests();
  });

  test('carries the run id and purpose, and no ingress name in redacted mode', async () => {
    await T.simulateLoginForTests();
    const memory = T.useTestBackgroundLogger();
    await installBraintrust(
      { tracing: { enabled: true, apiKey: 'test-braintrust-key', projectName: 'triage-app', content: 'redacted' } },
      { load: async () => bt, instrument: () => async () => undefined, names: () => [], projectId: 'test-project-id' },
    );
    const d = decisionOf(fakeDecisionProvider(answering({ aspora_user_id: USER })));
    const thread = [`Priya Testname says user ${USER} cannot log in`];
    await resolveIngressIdentity(request(thread), depsOf({ resolveIdChain: fakeCore(FULL_CHAIN).fn, decision: d.deps, redactionNames: ['Priya Testname'] }));
    const rows = (await memory.drain()) as Record<string, any>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ run_id: 'run_ingress_ident_01', purpose: 'identity' });
    expect(JSON.stringify(rows[0]?.input)).not.toContain('Priya');
    expect(JSON.stringify(rows[0]?.input)).toContain('cannot log in');
  });
});
