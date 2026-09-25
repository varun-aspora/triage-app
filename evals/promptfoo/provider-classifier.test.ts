import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CompleteFn } from '../../src/classify/classify.ts';
import { applyTierPolicy } from '../../src/classify/policy.ts';
import { loadCategories, type CategoryEntry } from '../../src/classify/prompt.ts';
import { loadCases, policyContextFor, type EvalCase } from '../../src/evals/case-schema.ts';
import type { CostModel } from '../../src/evals/cost.ts';
import type { DecisionProvider } from '../../src/decisions/types.ts';
import { createFakeModel, text } from '../../src/mock/fake-model.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { isNoIoGuardInstalled } from '../../test/support/no-io-guard.ts';
import { parseClassifierOutput, type ClassifierOutput } from './asserts/schema.ts';
import {
  COST_CAP_EXCEEDED,
  ClassifierProvider,
  SuiteBudget,
  caseVars,
  defaultCostModel,
  withClassifierModel,
  type ClassifierProviderDeps,
} from './provider-classifier.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CASES_DIR = join(REPO, 'evals', 'cases');

let home: TestHome;
let cases: EvalCase[];
let categories: CategoryEntry[];

beforeAll(async () => {
  home = makeTestHome({ overrides: { MODEL_CLASSIFIER: 'faux/classifier' } });
  cases = (await loadCases(CASES_DIR)).map((l) => l.case).filter((c) => c.id.startsWith('syn-'));
  categories = await loadCategories(join(REPO, 'knowledge'));
});

afterAll(() => home.cleanup());

const PRICED = (spec: string): CostModel => ({
  provider: spec.split('/')[0] ?? spec,
  id: spec.split('/').slice(1).join('/'),
  // USD per million tokens; high so a single call has a visible cost.
  cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
});

function provider(model: string, deps: ClassifierProviderDeps = {}): ClassifierProvider {
  return new ClassifierProvider({ config: { model } }, { config: home.config, categories, installNetworkDeny: () => {}, ...deps });
}

async function run(p: ClassifierProvider, c: EvalCase) {
  return p.callApi(c.id, { vars: caseVars(c) as never, prompt: { raw: c.id, label: c.id } });
}

function outputOf(res: { output?: unknown; error?: string }): ClassifierOutput {
  expect(res.error).toBeUndefined();
  const parsed = parseClassifierOutput(res.output);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.value;
}

function byId(id: string): EvalCase {
  const c = cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`missing case ${id}`);
  return c;
}

// A completion that answers with a fixed classification and records the spec it was asked for.
function recordingComplete(classification: unknown, seen: string[]): CompleteFn {
  return async (spec, context, { signal }) => {
    seen.push(spec);
    const fake = createFakeModel();
    fake.script([text(JSON.stringify(classification))]);
    const model = fake.provider.getModels()[0];
    if (model === undefined) throw new Error('fake model has no models');
    return fake.provider.stream(model, context, { signal }).result();
  };
}

describe('faux mode', () => {
  test('the synthetic cases are there', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
  });

  test('returns the policy tier and expected category for each syn case', async () => {
    const p = provider('faux/classifier');
    for (const c of cases) {
      const out = outputOf(await run(p, c));
      const policy = applyTierPolicy(c.faux_classification, policyContextFor(c));
      expect({ id: c.id, tier: out.tier.final }).toEqual({ id: c.id, tier: policy.tier_final });
      expect({ id: c.id, tier: out.tier.final }).toEqual({ id: c.id, tier: c.expected.tier });
      expect({ id: c.id, rule: out.tier.rule_fired }).toEqual({ id: c.id, rule: policy.rule_fired });
      expect(out.classification.category).toBe(c.expected.category);
      expect(out.case_id).toBe(c.id);
      expect(out.model).toBe('faux/classifier');
      expect(out.classification.classifier_error).toBeUndefined();
    }
  });

  test('the stable pattern comes from the case patterns, not from the model answer', async () => {
    const c = byId('syn-stable-pattern');
    const out = outputOf(await run(provider('faux/classifier'), c));
    expect(out.classification.matched_pattern_id).toBe('syn-notary-session-expired');
    expect(out.tier.rules_applied).toContain('rule_5_stable_pattern');

    // Without the case's patterns the model's matched_pattern_id is dropped and rule 5 does not fire.
    const { policy: _drop, ...rest } = c;
    const out2 = outputOf(await run(provider('faux/classifier'), rest as EvalCase));
    expect(out2.classification.matched_pattern_id).toBeUndefined();
    expect(out2.tier.rules_applied).not.toContain('rule_5_stable_pattern');
  });

  test('installs the network deny before every faux call', async () => {
    let installs = 0;
    const p = provider('faux/classifier', { installNetworkDeny: () => void installs++ });
    await run(p, byId('syn-unknown'));
    await run(p, byId('syn-money-moved'));
    expect(installs).toBe(2);
  });

  test('the default network deny is the no-io guard', async () => {
    const p = new ClassifierProvider({ config: { model: 'faux/classifier' } }, { config: home.config, categories });
    outputOf(await run(p, byId('syn-unknown')));
    expect(isNoIoGuardInstalled()).toBe(true);
  });

  test('a real model does not install the network deny', async () => {
    let installs = 0;
    const c = byId('syn-money-moved');
    const p = provider('openai/gpt-5-mini', {
      installNetworkDeny: () => void installs++,
      complete: recordingComplete(c.faux_classification, []),
      costModel: PRICED,
    });
    outputOf(await run(p, c));
    expect(installs).toBe(0);
  });

  test('a case without faux_classification is an error in faux mode', async () => {
    const { faux_classification: _drop, ...rest } = byId('syn-unknown');
    const res = await run(provider('faux/classifier'), rest as EvalCase);
    expect(res.error).toContain('faux_classification');
    expect(res.output).toBeUndefined();
  });

  test('invalid vars are an error that names paths, not values', async () => {
    const res = await provider('faux/classifier').callApi('x', {
      vars: { case_id: 'x', thread: [], ids: {}, id_chain: { ids: {}, hops: [] }, basic_state: 'SECRET-VALUE' },
      prompt: { raw: 'x', label: 'x' },
    });
    expect(res.error).toContain('invalid case vars');
    expect(res.error).toContain('thread');
    expect(res.error).not.toContain('SECRET-VALUE');
  });
});

describe('model per provider', () => {
  test('the model is passed per call, not read from process.env or the config', async () => {
    const before = process.env.MODEL_CLASSIFIER;
    process.env.MODEL_CLASSIFIER = 'faux/strong';
    try {
      const c = byId('syn-money-moved');
      const seenA: string[] = [];
      const seenB: string[] = [];
      const a = provider('openai/gpt-5-mini', { complete: recordingComplete(c.faux_classification, seenA), costModel: PRICED });
      const b = provider('anthropic/claude-haiku-4-5', {
        complete: recordingComplete(c.faux_classification, seenB),
        costModel: PRICED,
      });
      const [ra, rb] = await Promise.all([run(a, c), run(b, c)]);
      expect(seenA).toEqual(['openai/gpt-5-mini']);
      expect(seenB).toEqual(['anthropic/claude-haiku-4-5']);
      expect(outputOf(ra).model).toBe('openai/gpt-5-mini');
      expect(outputOf(rb).model).toBe('anthropic/claude-haiku-4-5');
      expect(ra.metadata?.model).toBe('openai/gpt-5-mini');
      expect(home.config.models.classifier).toBe('faux/classifier');
    } finally {
      if (before === undefined) delete process.env.MODEL_CLASSIFIER;
      else process.env.MODEL_CLASSIFIER = before;
    }
  });

  test('two faux providers run concurrently without cross-talk', async () => {
    const a = provider('faux/classifier');
    const b = provider('faux/cheap');
    const results = await Promise.all(cases.flatMap((c) => [run(a, c).then((r) => ['faux/classifier', c, r] as const), run(b, c).then((r) => ['faux/cheap', c, r] as const)]));
    for (const [model, c, res] of results) {
      const out = outputOf(res);
      expect({ model: out.model, case: out.case_id }).toEqual({ model, case: c.id });
      expect(out.tier.final).toBe(c.expected.tier);
    }
  });

  test('without config.model the provider uses MODEL_CLASSIFIER from the config', () => {
    const p = new ClassifierProvider({}, { config: home.config });
    expect(p.model).toBe('faux/classifier');
    expect(p.id()).toBe('triage-classifier:faux/classifier');
  });

  test('withClassifierModel leaves the original config alone', () => {
    const copy = withClassifierModel(home.config, 'faux/mid');
    expect(copy.models.classifier).toBe('faux/mid');
    expect(home.config.models.classifier).toBe('faux/classifier');
  });
});

describe('cost cap', () => {
  test('faux models are free without a registry lookup, whichever faux provider registered last', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(defaultCostModel('faux/classifier')).toEqual({ provider: 'faux', id: 'classifier', cost: zero });
    expect(defaultCostModel('faux/not-listed-anywhere')).toEqual({ provider: 'faux', id: 'not-listed-anywhere', cost: zero });
  });

  async function oneCallCost(c: EvalCase): Promise<number> {
    const budget = new SuiteBudget(undefined);
    outputOf(await run(provider('faux/classifier', { budget, costModel: PRICED }), c));
    return budget.meter.totalUsd();
  }

  test('a cap below two calls stops the third call', async () => {
    const c = byId('syn-money-moved');
    const cost = await oneCallCost(c);
    expect(cost).toBeGreaterThan(0);

    const budget = new SuiteBudget(cost * 1.5);
    const p = provider('faux/classifier', { budget, costModel: PRICED });
    const first = await run(p, c);
    const second = await run(p, c);
    const third = await run(p, c);
    expect(outputOf(first).cost_usd).toBeCloseTo(cost);
    outputOf(second);
    expect(third.error).toStartWith(COST_CAP_EXCEEDED);
    expect(third.output).toBeUndefined();
    expect(third.metadata?.[COST_CAP_EXCEEDED]).toBe(true);
    expect(budget.meter.byModel()).toEqual([{ model: 'faux/classifier', calls: 2, usd: expect.any(Number) }]);
    expect(budget.summary().cost_cap_exceeded).toBe(true);
  });

  test('the budget is shared across providers', async () => {
    const c = byId('syn-money-moved');
    const cost = await oneCallCost(c);
    const budget = new SuiteBudget(cost * 0.5);
    const a = provider('faux/classifier', { budget, costModel: PRICED });
    const b = provider('faux/cheap', { budget, costModel: PRICED });
    outputOf(await run(a, c));
    expect((await run(b, c)).error).toStartWith(COST_CAP_EXCEEDED);
  });

  test('the default budget reads TRIAGE_EVAL_MAX_COST_USD from the config', async () => {
    const capped = makeTestHome({ overrides: { MODEL_CLASSIFIER: 'faux/classifier', TRIAGE_EVAL_MAX_COST_USD: '0' } });
    try {
      const p = new ClassifierProvider(
        {},
        { config: capped.config, categories, costModel: PRICED, installNetworkDeny: () => {} },
      );
      const c = byId('syn-unknown');
      outputOf(await run(p, c));
      expect((await run(p, c)).error).toStartWith(COST_CAP_EXCEEDED);
    } finally {
      capped.cleanup();
    }
  });

  test('no cap means no refusal', async () => {
    const budget = new SuiteBudget('');
    const p = provider('faux/classifier', { budget, costModel: PRICED });
    for (let i = 0; i < 3; i++) outputOf(await run(p, byId('syn-unknown')));
    expect(budget.summary()).toMatchObject({ cap_usd: null, cost_cap_exceeded: false });
  });

  test('a model without cost metadata is an error, not an uncapped call', async () => {
    const p = provider('faux/classifier', {
      budget: new SuiteBudget(10),
      costModel: (spec) => ({ provider: 'faux', id: spec, cost: undefined as never }),
    });
    const res = await run(p, byId('syn-unknown'));
    expect(res.error).toContain('cost meter');
    expect(res.output).toBeUndefined();
  });
});

describe('decision models', () => {
  // A scripted decision provider that reports its own cost, as TypeSafe does.
  function fakeDecisions(costUsd: number | undefined): DecisionProvider & { calls: number } {
    const p = {
      id: 'fake',
      model: 'fake/decider',
      calls: 0,
      async decide() {
        p.calls += 1;
        const answers = {
          category: { kind: 'choice', choice: 'transfer_out', probabilities: { transfer_out: 0.9 } },
          subcategory: { kind: 'choice', choice: 'none' },
          entity_ssfb: { kind: 'yes_no', yes: 0.9 },
          entity_atspl: { kind: 'yes_no', yes: 0.1 },
          entity_rtl: { kind: 'yes_no', yes: 0.1 },
          money_moved: { kind: 'yes_no', yes: 0.9 },
          misdirected_funds: { kind: 'yes_no', yes: 0.1 },
          tier_proposed: { kind: 'choice', choice: 'mid' },
        };
        return { answers, model: 'fake/decider', usage: { inputTokens: 10, outputTokens: 5, ...(costUsd === undefined ? {} : { costUsd }) } } as never;
      },
    };
    return p;
  }

  test('a typesafe spec goes through decide() and meters the reported cost', async () => {
    const budget = new SuiteBudget(undefined);
    const decisions = fakeDecisions(0.002);
    const p = provider('typesafe/jev-1.13', { budget, decisions, complete: async () => { throw new Error('completion path ran'); } });
    const out = outputOf(await run(p, byId('syn-money-moved')));
    expect(decisions.calls).toBe(1);
    expect(out.classification.category).toBe('transfer_out');
    expect(out.cost_usd).toBe(0.002);
    expect(budget.meter.byModel()).toEqual([{ model: 'typesafe/jev-1.13', calls: 1, usd: 0.002 }]);
  });

  test('a decision call that reports no cost is an error, not an uncapped call', async () => {
    const p = provider('openrouter/typesafe/jev-1.13', { budget: new SuiteBudget(10), decisions: fakeDecisions(undefined) });
    const res = await run(p, byId('syn-money-moved'));
    expect(res.error).toContain('cost meter');
    expect(res.output).toBeUndefined();
  });
});

describe('boundaries', () => {
  const FILES = ['provider-classifier.ts', 'provider-judge.ts', 'judge.ts', 'classifier.config.ts'];
  const FORBIDDEN = [
    /config\/registry/,
    /src\/connectors\//,
    /src\/tools\//,
    /src\/mock\/(resolve|store|recorder|index)/,
    /\blookupEnv\b/,
    /\brawKeyState\b/,
    /process\.env/,
  ];

  test('the suite code never touches entity config, connectors or process.env', () => {
    for (const file of FILES) {
      const source = readFileSync(join(REPO, 'evals', 'promptfoo', file), 'utf8');
      const code = source
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      for (const re of FORBIDDEN) expect({ file, hit: re.test(code) }).toEqual({ file, hit: false });
    }
  });
});
