import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as bt from 'braintrust';
import * as v from 'valibot';

import { configFromRecord, type Config } from '../config/env.ts';
import { installBraintrust, uninstallBraintrust } from '../tracing/braintrust.ts';
import { DecisionError } from '../decisions/decide.ts';
import { fakeDecisionProvider } from '../decisions/fake.ts';
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from '../decisions/types.ts';
import { ClassificationSchema } from '../types/classification.ts';
import type { IdChain } from '../types/id-chain.ts';
import type { ThreadMessage } from '../types/request.ts';
import type { ClassifierUsage } from './classify.ts';
import { classificationFromAnswers, classifierQuestions, NO_SUBCATEGORY } from './decision.ts';
import { applyTierPolicy } from './policy.ts';
import { parseCategories, type CategoryEntry } from './prompt.ts';

// classify.ts imports models.ts, which loads config at import. Clear
// TRIAGE_HOME first so a home exported in the shell is never read.
const savedHome = process.env.TRIAGE_HOME;
delete process.env.TRIAGE_HOME;
const { classify } = await import('./classify.ts');
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
afterAll(() => {
  if (savedHome !== undefined) process.env.TRIAGE_HOME = savedHome;
});

function config(overrides: Record<string, string> = {}): Config {
  return configFromRecord({ MODEL_DECISION: 'typesafe/jev-1.13', TYPESAFE_API_KEY: 'fake-ts-key', ...overrides }, '/triage/home');
}

// ---------------------------------------------------------------- synthetic data (pseudonymised)

const CATS: CategoryEntry[] = parseCategories([
  {
    id: 'delivery',
    label: 'Welcome letter and delivery',
    description: 'The welcome letter was not sent or went to the wrong address.',
    signals: ['welcome letter not received'],
    subcategories: ['welcome_letter', 'address'],
    typical_entities: ['ssfb', 'atspl'],
  },
  {
    id: 'transfer_out',
    label: 'Outward transfer',
    description: 'Money sent out of the account.',
    signals: [],
    subcategories: ['stuck', 'address'],
    typical_entities: ['ssfb'],
  },
  { id: 'unknown', label: 'Unknown', description: 'Nothing else fits.', signals: [], subcategories: [], typical_entities: [] },
]);

const PHONE = '+44 7700 900123';
const ACCOUNT = '001234567890';
const NAME = 'Asha Testuser';
const EMAIL = 'asha.testuser@example.com';

const THREAD: ThreadMessage[] = [
  { ts: '1', author: 'ops-agent-1', text: `Customer ${NAME} (${EMAIL}, ${PHONE}) says the welcome letter never arrived.`, is_parent: true },
  { ts: '2', author: 'ops-agent-2', text: `Account ${ACCOUNT}, opened last week.`, is_parent: false },
];
const ID_CHAIN: IdChain = { ids: { aspora_user_id: '0b7c2a1e-5d4f-4e3a-9b8c-7d6e5f4a3b2c', account_number: ACCOUNT }, hops: [], basic_state: [] };
const INPUT = { thread: THREAD, idChain: ID_CHAIN, basicState: [], images: [] };

const yes = (p: number): DecisionAnswer => ({ kind: 'yes_no', yes: p });

const GOOD: Record<string, DecisionAnswer> = {
  category: { kind: 'choice', choice: 'delivery', probabilities: { delivery: 0.85, transfer_out: 0.1, unknown: 0.05 }, confidence: 0.7 },
  subcategory: { kind: 'choice', choice: 'delivery/welcome_letter' },
  entity_ssfb: yes(0.9),
  entity_atspl: yes(0.6),
  entity_rtl: yes(0.1),
  money_moved: yes(0.2),
  misdirected_funds: yes(0.05),
  tier_proposed: { kind: 'choice', choice: 'cheap' },
};

// The completion path must not run for a decision spec.
const noComplete = async (): Promise<never> => {
  throw new Error('the completion path ran for a decision spec');
};

// ---------------------------------------------------------------- routing

describe('spec routing', () => {
  type Sent = { url: string; model: unknown };

  // Stands in for the network: records where the SDK posted and answers with a synthetic result.
  function stubFetch(): Sent[] {
    const sent: Sent[] = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: unknown }) : {};
      sent.push({ url: String(input instanceof Request ? input.url : input), model: body.model });
      const answers = {
        category: { type: 'choice', choice: 'delivery', probabilities: { delivery: 0.9 } },
        subcategory: { type: 'choice', choice: 'none' },
        entity_ssfb: { type: 'noul', noul: 0.9 },
        entity_atspl: { type: 'noul', noul: 0.1 },
        entity_rtl: { type: 'noul', noul: 0.1 },
        money_moved: { type: 'noul', noul: 0.1 },
        misdirected_funds: { type: 'noul', noul: 0.1 },
        tier_proposed: { type: 'choice', choice: 'mid' },
      };
      return new Response(JSON.stringify({ model: 'synthetic', answers, usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
    spies.push(spy);
    return sent;
  }

  test('typesafe/<model> goes to TypeSafe directly', async () => {
    const sent = stubFetch();
    const result = await classify(INPUT, { config: config(), categories: CATS, complete: noComplete });
    expect(result.classifier_error).toBeUndefined();
    expect(result.category).toBe('delivery');
    expect(sent).toEqual([{ url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13' }]);
  });

  test('openrouter/typesafe/<model> goes through OpenRouter', async () => {
    const sent = stubFetch();
    const cfg = config({ MODEL_DECISION: 'openrouter/typesafe/jev-1.13', OPENROUTER_API_KEY: 'fake-or-key' });
    const result = await classify(INPUT, { config: cfg, categories: CATS, complete: noComplete });
    expect(result.classifier_error).toBeUndefined();
    expect(sent).toEqual([{ url: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13' }]);
  });

  test('a missing key is a classifier_error naming the key the route needs', async () => {
    const direct = await classify(INPUT, { config: config({ TYPESAFE_API_KEY: '' }), categories: CATS, complete: noComplete });
    expect(direct.classifier_error).toContain('TYPESAFE_API_KEY is not set');
    const routed = await classify(INPUT, {
      config: config({ MODEL_DECISION: 'openrouter/typesafe/jev-1.13', TYPESAFE_API_KEY: '' }),
      categories: CATS,
      complete: noComplete,
    });
    expect(routed.classifier_error).toContain('OPENROUTER_API_KEY is not set');
  });

  test('an openrouter chat model stays on the completion path', async () => {
    let called = 0;
    const decisions = fakeDecisionProvider(() => GOOD);
    const complete = async () => {
      called += 1;
      throw new Error('synthetic completion failure');
    };
    const cfg = config({ MODEL_DECISION: 'openrouter/vendor/some-model', OPENROUTER_API_KEY: 'fake-or-key' });
    await classify(INPUT, { config: cfg, categories: CATS, complete, decisions, imageLookup: () => ({ input: ['text'] }) });
    expect(called).toBe(1);
    expect(decisions.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- questions and mapping

describe('questions', () => {
  test('one call asks every field; one yes/no per enabled entity', async () => {
    const decisions = fakeDecisionProvider(() => GOOD);
    await classify(INPUT, { config: config(), categories: CATS, decisions, complete: noComplete });
    expect(decisions.requests).toHaveLength(1);
    const q = (decisions.requests[0] as DecisionRequest).questions;
    expect(Object.keys(q).sort()).toEqual(
      ['category', 'entity_atspl', 'entity_rtl', 'entity_ssfb', 'misdirected_funds', 'money_moved', 'subcategory', 'tier_proposed'].sort(),
    );
    expect(q.category?.kind === 'choice' && Object.keys(q.category.options)).toEqual(['delivery', 'transfer_out', 'unknown']);
    expect(q.subcategory?.kind === 'choice' && Object.keys(q.subcategory.options)).toEqual([
      'delivery/welcome_letter',
      'delivery/address',
      'transfer_out/stuck',
      'transfer_out/address',
      NO_SUBCATEGORY,
    ]);
    expect(q.tier_proposed?.kind === 'choice' && Object.keys(q.tier_proposed.options)).toEqual(['cheap', 'mid', 'strong']);
  });

  test('TRIAGE_ENTITIES limits the entity questions', () => {
    const q = classifierQuestions(CATS, ['ssfb', 'not-an-entity']);
    expect(Object.keys(q).filter((k) => k.startsWith('entity_'))).toEqual(['entity_ssfb']);
  });

  test('unknown is offered even when the categories file has no entry for it', () => {
    const q = classifierQuestions(CATS.slice(0, 1), []);
    expect(Object.keys(q.category.options)).toEqual(['delivery', 'unknown']);
  });
});

describe('answers to Classification', () => {
  test('a full answer set maps field by field', async () => {
    const decisions = fakeDecisionProvider(() => GOOD);
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions, complete: noComplete });
    expect(result).toEqual({
      category: 'delivery',
      subcategory: 'welcome_letter',
      entities_likely: ['ssfb', 'atspl'],
      money_moved: false,
      misdirected_funds: false,
      tier_proposed: 'cheap',
      confidence: 0.85,
      images_seen: false,
    });
  });

  test('none, or a subcategory of another category, maps to empty', () => {
    const none = classificationFromAnswers({ ...GOOD, subcategory: { kind: 'choice', choice: NO_SUBCATEGORY } });
    const other = classificationFromAnswers({ ...GOOD, subcategory: { kind: 'choice', choice: 'transfer_out/address' } });
    expect(none.ok && none.classification.subcategory).toBe('');
    expect(other.ok && other.classification.subcategory).toBe('');
  });

  test('yes at 0.5 or above counts as yes', () => {
    const r = classificationFromAnswers({ ...GOOD, money_moved: yes(0.5), misdirected_funds: yes(0.49) });
    expect(r.ok && [r.classification.money_moved, r.classification.misdirected_funds]).toEqual([true, false]);
  });

  test('confidence falls back to the choice confidence, then to 0', () => {
    const noProbs = classificationFromAnswers({ ...GOOD, category: { kind: 'choice', choice: 'delivery', confidence: 0.7 } });
    const bare = classificationFromAnswers({ ...GOOD, category: { kind: 'choice', choice: 'delivery' } });
    expect(noProbs.ok && noProbs.classification.confidence).toBe(0.7);
    expect(bare.ok && bare.classification.confidence).toBe(0);
  });

  test('images are counted in the state but never sent, and images_seen is false', async () => {
    const decisions = fakeDecisionProvider(() => GOOD);
    const image = { mimeType: 'image/png', data: 'c3ludGhldGljLWltYWdlLWJ5dGVz' };
    const result = await classify({ ...INPUT, images: [image] }, { config: config(), categories: CATS, decisions, complete: noComplete });
    expect(result.images_seen).toBe(false);
    const state = JSON.stringify(decisions.requests[0]?.state);
    expect(state).not.toContain(image.data);
    expect(state).toContain('1 screenshot(s) that are not shown to you');
  });
});

// ---------------------------------------------------------------- failure

describe('decide() failure', () => {
  function expectStrong(result: unknown) {
    expect(v.is(ClassificationSchema, result)).toBe(true);
    const c = result as v.InferOutput<typeof ClassificationSchema>;
    expect(c).toMatchObject({ category: 'unknown', tier_proposed: 'strong', confidence: 0, images_seen: false });
    expect(c.classifier_error).toBeString();
    const policy = applyTierPolicy(c, { imageCapable: () => true, hasImages: false });
    expect(policy.tier_final).toBe('strong');
    expect(policy.rule_fired).toBe('rule_1_invalid_or_unknown');
  }

  test('a DecisionError from the provider leaves the provider text out', async () => {
    const decisions = fakeDecisionProvider(() => {
      throw new DecisionError('bad_request', 'typesafe', { status: 400, detail: `rejected: ${PHONE}` });
    });
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions });
    expectStrong(result);
    expect(result.classifier_error).toBe('decision bad_request from typesafe (HTTP 400)');
  });

  test('a thrown non-DecisionError carries no message text', async () => {
    const decisions = fakeDecisionProvider(() => {
      throw new Error(`thread text: ${THREAD[0]?.text}`);
    });
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions });
    expectStrong(result);
    expect(result.classifier_error).not.toContain('welcome letter');
    expect(result.classifier_error).not.toContain('Testuser');
  });

  test('an answer outside the options is invalid_response, named by field', async () => {
    const decisions = fakeDecisionProvider(() => ({ ...GOOD, category: { kind: 'choice', choice: 'loans-secret-value' } }));
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions });
    expectStrong(result);
    expect(result.classifier_error).toContain('invalid_response');
    expect(result.classifier_error).toContain('category');
    expect(result.classifier_error).not.toContain('loans-secret-value');
  });

  test('a timeout, even when the provider ignores its signal', async () => {
    const hang: DecisionProvider = { id: 'hang', model: 'hang/m', decide: () => new Promise(() => undefined) };
    const started = Date.now();
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions: hang, timeoutMs: 20 });
    expectStrong(result);
    expect(result.classifier_error).toBe('decision timeout from hang: no answer within 20 ms');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a caller abort', async () => {
    const controller = new AbortController();
    const hang: DecisionProvider = { id: 'hang', model: 'hang/m', decide: () => new Promise(() => undefined) };
    const pending = classify(INPUT, { config: config(), categories: CATS, decisions: hang, signal: controller.signal });
    controller.abort();
    expectStrong(await pending);
  });
});

// ---------------------------------------------------------------- usage (D59)

describe('onUsage on the decision path', () => {
  function usageSink() {
    const seen: ClassifierUsage[] = [];
    return { seen, onUsage: (u: ClassifierUsage) => void seen.push(u) };
  }

  // Answers with a fixed usage and a dated model name, as TypeSafe does.
  function withUsage(usage: { inputTokens: number; outputTokens: number; costUsd?: number }, answers = GOOD): DecisionProvider {
    return {
      id: 'typesafe',
      model: 'typesafe/jev-1.13',
      decide: async () => ({ answers, model: 'jev-1.13-20260901', usage }) as DecisionResult,
    };
  }

  test('tokens and the reported cost, under the MODEL_DECISION spec', async () => {
    const { seen, onUsage } = usageSink();
    const decisions = withUsage({ inputTokens: 465, outputTokens: 81, costUsd: 1.953e-5 });
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions, onUsage });
    expect(result.classifier_error).toBeUndefined();
    expect(seen).toEqual([
      { path: 'decision', model: 'typesafe/jev-1.13', failed: false, input: 465, output: 81, cacheRead: 0, cacheWrite: 0, reportedUsd: 1.953e-5 },
    ]);
  });

  test('the openrouter route keeps its own spec', async () => {
    const { seen, onUsage } = usageSink();
    const cfg = config({ MODEL_DECISION: 'openrouter/typesafe/jev-1.13', OPENROUTER_API_KEY: 'fake-or-key' });
    await classify(INPUT, { config: cfg, categories: CATS, decisions: withUsage({ inputTokens: 1, outputTokens: 1 }), onUsage });
    expect(seen[0]?.model).toBe('openrouter/typesafe/jev-1.13');
  });

  test('the fake provider reports 0 tokens and no cost', async () => {
    const { seen, onUsage } = usageSink();
    await classify(INPUT, { config: config(), categories: CATS, decisions: fakeDecisionProvider(() => GOOD), onUsage });
    expect(seen).toEqual([{ path: 'decision', model: 'typesafe/jev-1.13', failed: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]);
  });

  test('a cost that is not a finite number >= 0 is left out', async () => {
    for (const costUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { seen, onUsage } = usageSink();
      await classify(INPUT, { config: config(), categories: CATS, decisions: withUsage({ inputTokens: 10, outputTokens: 2, costUsd }), onUsage });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.reportedUsd).toBeUndefined();
    }
  });

  test('a provider DecisionError is one failed call with 0 tokens', async () => {
    const { seen, onUsage } = usageSink();
    const decisions = fakeDecisionProvider(() => {
      throw new DecisionError('unavailable', 'typesafe', { status: 503 });
    });
    await classify(INPUT, { config: config(), categories: CATS, decisions, onUsage });
    expect(seen).toEqual([{ path: 'decision', model: 'typesafe/jev-1.13', failed: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]);
  });

  test('answers that fail the checks are a failed call that keeps the result tokens', async () => {
    const { seen, onUsage } = usageSink();
    const bad = { ...GOOD, category: { kind: 'choice', choice: 'not-an-option' } } as Record<string, DecisionAnswer>;
    const decisions = withUsage({ inputTokens: 300, outputTokens: 40, costUsd: 0.0001 }, bad);
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions, onUsage });
    expect(result.classifier_error).toContain('invalid_response');
    expect(seen).toEqual([
      { path: 'decision', model: 'typesafe/jev-1.13', failed: true, input: 300, output: 40, cacheRead: 0, cacheWrite: 0, reportedUsd: 0.0001 },
    ]);
  });

  test('a timeout is one failed call with 0 tokens, and a late result is not counted', async () => {
    const { seen, onUsage } = usageSink();
    let answer: ((r: DecisionResult) => void) | undefined;
    const slow: DecisionProvider = {
      id: 'slow',
      model: 'slow/m',
      decide: () => new Promise<DecisionResult>((resolve) => (answer = resolve)),
    };
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions: slow, timeoutMs: 20, onUsage });
    expect(result.classifier_error).toContain('timeout');
    answer?.({ answers: GOOD, model: 'late', usage: { inputTokens: 999, outputTokens: 9 } } as DecisionResult);
    await Promise.resolve();
    expect(seen).toEqual([{ path: 'decision', model: 'typesafe/jev-1.13', failed: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]);
  });

  test('a caller abort after the request is one failed call', async () => {
    const { seen, onUsage } = usageSink();
    const controller = new AbortController();
    const hang: DecisionProvider = { id: 'hang', model: 'hang/m', decide: () => new Promise(() => undefined) };
    const pending = classify(INPUT, { config: config(), categories: CATS, decisions: hang, signal: controller.signal, onUsage });
    // Let decide() reach the provider before aborting.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await pending;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBe(true);
  });

  test('nothing is recorded when no request was sent', async () => {
    const { seen, onUsage } = usageSink();
    // No key: the provider cannot be built.
    await classify(INPUT, { config: config({ TYPESAFE_API_KEY: '' }), categories: CATS, complete: noComplete, onUsage });
    // Already aborted: decide() refuses before asking the provider.
    const controller = new AbortController();
    controller.abort();
    const decisions = fakeDecisionProvider(() => GOOD);
    await classify(INPUT, { config: config(), categories: CATS, decisions, signal: controller.signal, onUsage });
    expect(decisions.requests).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  test('a callback that throws does not change the classification', async () => {
    const onUsage = () => {
      throw new Error('meter down');
    };
    const result = await classify(INPUT, { config: config(), categories: CATS, decisions: fakeDecisionProvider(() => GOOD), onUsage });
    expect(result.classifier_error).toBeUndefined();
    expect(result.category).toBe('delivery');
  });
});

// ---------------------------------------------------------------- redaction

describe('redaction of the state', () => {
  for (const spec of ['typesafe/jev-1.13', 'openrouter/typesafe/jev-1.13']) {
    test(`${spec}: the persisted profile masks phones, account numbers, emails and names`, async () => {
      const decisions = fakeDecisionProvider(() => GOOD);
      const cfg = config({ MODEL_DECISION: spec, OPENROUTER_API_KEY: 'fake-or-key' });
      await classify({ ...INPUT, redactionNames: [NAME] }, { config: cfg, categories: CATS, decisions });
      const sent = JSON.stringify(decisions.requests[0]);
      for (const secret of [PHONE, '7700 900123', ACCOUNT, EMAIL, NAME]) expect(sent).not.toContain(secret);
      expect(sent).toContain('****7890');
      expect(sent).toContain(ID_CHAIN.ids.aspora_user_id as string);
    });
  }
});

// ---------------------------------------------------------------- tracing (D82)

// decide() records the span; this checks the classifier tags it. Braintrust's
// in-memory background logger: nothing leaves the process.
describe('tracing the decision call', () => {
  const T = bt._exportsForTestingOnly;
  // A run id with a 6+ digit run, which the persisted profile would mask.
  const RUN = '01M3EN7034701234ABCDEFGHJK';
  type Row = Record<string, any>;
  let memory: ReturnType<typeof T.useTestBackgroundLogger>;

  beforeAll(async () => {
    await T.simulateLoginForTests();
  });
  beforeEach(() => {
    memory = T.useTestBackgroundLogger();
  });
  afterEach(async () => {
    await uninstallBraintrust();
    T.clearTestBackgroundLogger();
  });
  afterAll(() => {
    T.simulateLogoutForTests();
  });

  const run = () =>
    classify(
      { ...INPUT, runId: RUN },
      { config: config(), categories: CATS, decisions: fakeDecisionProvider(() => GOOD, { id: 'typesafe', model: 'typesafe/jev-1.13' }), complete: noComplete },
    );

  test('off records nothing; on gives the same classification and one span tagged with the run', async () => {
    const off = await run();
    expect(await memory.drain()).toEqual([]);
    await installBraintrust(
      { tracing: { enabled: true, apiKey: 'test-braintrust-key', projectName: 'triage-app', content: 'metadata' } },
      { load: async () => bt, instrument: () => async () => undefined, names: () => [NAME], projectId: 'test-project-id' },
    );
    expect(await run()).toEqual(off);
    const all = (await memory.drain()) as Row[];
    expect(all).toHaveLength(1);
    const row = all[0] as Row;
    expect(row.span_attributes).toMatchObject({ name: 'decision:typesafe/jev-1.13', type: 'llm' });
    expect(row.metadata).toMatchObject({ run_id: RUN, purpose: 'classify', provider: 'typesafe', model: 'typesafe/jev-1.13' });
    const json = JSON.stringify(row);
    for (const marker of [NAME, EMAIL, ACCOUNT, 'welcome letter']) expect(json).not.toContain(marker);
  });
});
