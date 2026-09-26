// buildClassifierSuite, and the suite run end to end through promptfoo's
// evaluate() with faux providers. The no-io guard from the test preload is
// installed, so any network call promptfoo or the providers tried would throw.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Assertion, EvaluateSummaryV3 } from 'promptfoo';

import type { CompleteFn } from '../../src/classify/classify.ts';
import type { CostModel } from '../../src/evals/cost.ts';
import { createFakeModel, text } from '../../src/mock/fake-model.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { assertNoIoGuardInstalled } from '../../test/support/no-io-guard.ts';
import { parseClassifierOutput } from './asserts/schema.ts';
import {
  SuiteConfigError,
  buildClassifierSuite,
  type BuildClassifierSuiteOptions,
  type ClassifierSuite,
} from './classifier.config.ts';
import { GRADER_REFUSED, JudgeConfigError, RefusingGrader } from './judge.ts';
import { COST_CAP_EXCEEDED } from './provider-classifier.ts';
import { JudgeProvider } from './provider-judge.ts';

const KNOWLEDGE = join(import.meta.dir, '..', '..', 'knowledge');
const homes: TestHome[] = [];
let promptfooDir: string;
let evaluate: typeof import('promptfoo').evaluate;
const saved: Record<string, string | undefined> = {};

// promptfoo's own off switches, set in this process only, before promptfoo is imported.
const PROMPTFOO_ENV = {
  PROMPTFOO_DISABLE_TELEMETRY: '1',
  PROMPTFOO_DISABLE_UPDATE: '1',
  PROMPTFOO_DISABLE_SHARING: '1',
  PROMPTFOO_DISABLE_REMOTE_GENERATION: '1',
  PROMPTFOO_CACHE_ENABLED: 'false',
};

beforeAll(async () => {
  assertNoIoGuardInstalled();
  promptfooDir = mkdtempSync(join(tmpdir(), 'triage-promptfoo-'));
  for (const [k, v] of Object.entries({ ...PROMPTFOO_ENV, PROMPTFOO_CONFIG_DIR: promptfooDir })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  ({ evaluate } = await import('promptfoo'));
});

afterAll(() => {
  for (const h of homes) h.cleanup();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(promptfooDir, { recursive: true, force: true });
});

function config(overrides: Record<string, string> = {}) {
  const home = makeTestHome({
    overrides: { MODEL_DECISION: 'faux/classifier', TRIAGE_KNOWLEDGE_DIR: KNOWLEDGE, ...overrides },
  });
  homes.push(home);
  return home.config;
}

const quiet = { installNetworkDeny: () => {} };

async function build(options: Partial<BuildClassifierSuiteOptions> & { overrides?: Record<string, string> } = {}) {
  const { overrides, ...rest } = options;
  return buildClassifierSuite({ judgeOn: false, config: config(overrides), providerDeps: quiet, ...rest });
}

async function runSuite(suite: ClassifierSuite): Promise<EvaluateSummaryV3> {
  const ev = await evaluate(suite.testSuite, { ...suite.evaluateOptions, silent: true } as never);
  return (await ev.toEvaluateSummary()) as EvaluateSummaryV3;
}

function metricsOf(result: EvaluateSummaryV3['results'][number]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of result.gradingResult?.componentResults ?? []) {
    if (c.assertion?.metric) out[c.assertion.metric] = c.pass;
  }
  return out;
}

function judgeComplete(seen: string[]): CompleteFn {
  return async (_spec, context, { signal }) => {
    seen.push(context.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
    const fake = createFakeModel();
    fake.script([text('{"reason":"The output asks for the same thing.","pass":true,"score":1}')]);
    const model = fake.provider.getModels()[0];
    if (model === undefined) throw new Error('fake model has no models');
    return fake.provider.stream(model, context, { signal }).result();
  };
}

describe('buildClassifierSuite', () => {
  test('judge off: the refusing grader is always set and there is no rubric assert', async () => {
    const suite = await build();
    expect(suite.grader).toBeInstanceOf(RefusingGrader);
    expect(suite.testSuite.defaultTest).toMatchObject({ options: { provider: suite.grader } });
    const tests = suite.testSuite.tests as { assert: Assertion[] }[];
    expect(tests.length).toBeGreaterThanOrEqual(6);
    for (const t of tests) {
      expect(t.assert.map((a) => a.metric)).toEqual(['schema', 'category', 'tier']);
    }
    expect((await suite.grader.callApi('grade')).error).toBe(GRADER_REFUSED);
  });

  test('judge on: the judge is the grader, and no case has a rubric assert', async () => {
    const suite = await build({
      judgeOn: true,
      overrides: { TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' },
      judgeDeps: { complete: judgeComplete([]) },
    });
    expect(suite.grader).toBeInstanceOf(JudgeProvider);
    expect(suite.testSuite.defaultTest).toMatchObject({ options: { provider: suite.grader } });
    const tests = suite.testSuite.tests as { assert: Assertion[] }[];
    for (const t of tests) {
      expect(t.assert.map((a) => a.metric)).toEqual(['schema', 'category', 'tier']);
    }
  });

  test('judge on with a blank judge model fails before any case is loaded', async () => {
    const run = build({ judgeOn: true, casesDir: '/nonexistent/cases' });
    await expect(run).rejects.toThrow(JudgeConfigError);
  });

  test('an openrouter or same-family judge fails before any case is loaded', async () => {
    await expect(
      build({ judgeOn: true, casesDir: '/nonexistent/cases', overrides: { TRIAGE_EVAL_JUDGE_MODEL: 'openrouter/openai/gpt-5' } }),
    ).rejects.toThrow(/openrouter/);
    await expect(
      build({
        judgeOn: true,
        casesDir: '/nonexistent/cases',
        providers: ['anthropic/claude-haiku-4-5'],
        overrides: { TRIAGE_EVAL_JUDGE_MODEL: 'anthropic/claude-opus-4-1' },
      }),
    ).rejects.toThrow(/same model family/);
  });

  test('faux and real classifier models are not mixed', async () => {
    await expect(build({ providers: ['faux/classifier', 'openai/gpt-5-mini'] })).rejects.toThrow(SuiteConfigError);
  });

  test('bad provider lists and repeat values are refused', async () => {
    await expect(build({ providers: [] })).rejects.toThrow(/no classifier model/);
    await expect(build({ providers: ['nospec'] })).rejects.toThrow(/provider\/model/);
    await expect(build({ providers: ['faux/cheap', 'faux/cheap'] })).rejects.toThrow(/once/);
    await expect(build({ repeat: 0 })).rejects.toThrow(/repeat/);
  });

  test('repeat and the providers are passed through', async () => {
    const suite = await build({ repeat: 3, providers: ['faux/classifier', 'faux/cheap'] });
    expect(suite.evaluateOptions).toMatchObject({ repeat: 3, cache: false });
    expect(suite.providers.map((p) => p.id())).toEqual(['triage-classifier:faux/classifier', 'triage-classifier:faux/cheap']);
    expect(suite.testSuite.providers).toEqual([...suite.providers]);
  });

  test('the default provider is MODEL_DECISION from the config', async () => {
    const suite = await build();
    expect(suite.providers.map((p) => p.model)).toEqual(['faux/classifier']);
  });
});

describe('suite run through promptfoo evaluate()', () => {
  test('judge off, two faux providers: every assert passes and each result names its model', async () => {
    const suite = await build({ providers: ['faux/classifier', 'faux/cheap'], providerDeps: {} });
    const summary = await runSuite(suite);
    expect(summary.stats.errors).toBe(0);
    expect(summary.stats.failures).toBe(0);
    expect(summary.results.length).toBe((suite.testSuite.tests as unknown[]).length * 2);
    for (const r of summary.results) {
      expect(metricsOf(r)).toEqual({ schema: true, category: true, tier: true });
      const out = parseClassifierOutput(r.response?.output);
      if (!out.ok) throw new Error(out.reason);
      expect(`triage-classifier:${out.value.model}`).toBe(String(r.provider?.id));
      expect(out.value.case_id).toBe(String(r.vars.case_id));
    }
  });

  test('judge off: a model-graded assert gets the refusing grader, never a default one', async () => {
    const suite = await build();
    const first = (suite.testSuite.tests as { assert: Assertion[] }[])[0];
    first?.assert.push({ type: 'llm-rubric', value: 'The output is polite.', metric: 'probe' });
    const summary = await runSuite(suite);
    const graded = summary.results.find((r) => metricsOf(r).probe !== undefined);
    expect(graded).toBeDefined();
    expect(metricsOf(graded!).probe).toBe(false);
    expect(JSON.stringify(graded!.gradingResult)).toContain('grader refused');
  });

  test('judge on: a model-graded assert goes to the judge', async () => {
    const seen: string[] = [];
    const suite = await build({
      judgeOn: true,
      overrides: { TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' },
      judgeDeps: { complete: judgeComplete(seen) },
    });
    const first = (suite.testSuite.tests as { assert: Assertion[] }[])[0];
    first?.assert.push({ type: 'llm-rubric', value: 'The output is polite.', metric: 'probe' });
    const summary = await runSuite(suite);
    expect(summary.stats.errors).toBe(0);
    expect(summary.stats.failures).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('The output is polite.');
    const graded = summary.results.find((r) => metricsOf(r).probe !== undefined);
    expect(metricsOf(graded!).probe).toBe(true);
  });

  test('cost cap exceeded: the remaining cases return an error and the budget reports it', async () => {
    const priced = (): CostModel => ({
      provider: 'faux',
      id: 'classifier',
      cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    });
    const suite = await build({
      overrides: { TRIAGE_EVAL_MAX_COST_USD: '0' },
      maxConcurrency: 1,
      providerDeps: { ...quiet, costModel: priced },
    });
    const summary = await runSuite(suite);
    const total = (suite.testSuite.tests as unknown[]).length;
    expect(summary.stats.successes).toBe(1);
    expect(summary.stats.errors).toBe(total - 1);
    const errored = summary.results.filter((r) => r.error);
    for (const r of errored) expect(String(r.error)).toContain(COST_CAP_EXCEEDED);
    expect(suite.budget.summary()).toMatchObject({ cap_usd: 0, cost_cap_exceeded: true });
    expect(suite.budget.meter.byModel()[0]?.calls).toBe(1);
  });
});
