import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { CompleteFn } from '../../src/classify/classify.ts';
import type { CostModel } from '../../src/evals/cost.ts';
import { createFakeModel, text } from '../../src/mock/fake-model.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import {
  GRADER_REFUSED,
  JUDGE_KEY,
  JudgeConfigError,
  RefusingGrader,
  modelFamily,
  resolveJudge,
} from './judge.ts';
import { COST_CAP_EXCEEDED, SuiteBudget } from './provider-classifier.ts';
import { JudgeProvider, rubricContext } from './provider-judge.ts';

const homes: TestHome[] = [];

function configWith(overrides: Record<string, string>) {
  const home = makeTestHome({ overrides });
  homes.push(home);
  return home.config;
}

let blank: TestHome['config'];
beforeAll(() => {
  blank = configWith({});
});
afterAll(() => {
  for (const h of homes) h.cleanup();
});

const deps = () => ({ budget: new SuiteBudget(undefined) });

describe('resolveJudge', () => {
  test('judge on with a blank TRIAGE_EVAL_JUDGE_MODEL throws', () => {
    expect(blank.evals.judgeModel).toBeUndefined();
    expect(() => resolveJudge(blank, ['faux/classifier'], true, deps())).toThrow(JudgeConfigError);
    expect(() => resolveJudge(blank, ['faux/classifier'], true, deps())).toThrow(JUDGE_KEY);
  });

  test('judge off with a blank judge returns the refusing grader', async () => {
    const grader = resolveJudge(blank, ['faux/classifier'], false, deps());
    expect(grader).toBeInstanceOf(RefusingGrader);
    expect((await grader.callApi('grade this')).error).toBe(GRADER_REFUSED);
  });

  test('judge off ignores a set judge model', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' });
    expect(resolveJudge(config, ['anthropic/claude-haiku-4-5'], false, deps())).toBeInstanceOf(RefusingGrader);
  });

  test('an openrouter judge throws', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'openrouter/openai/gpt-5-mini' });
    expect(() => resolveJudge(config, ['anthropic/claude-haiku-4-5'], true, deps())).toThrow(/openrouter/);
  });

  test('an anthropic judge with an anthropic model under test throws', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'anthropic/claude-opus-4-1' });
    expect(() => resolveJudge(config, ['anthropic/claude-sonnet-4-5'], true, deps())).toThrow(/same model family/);
  });

  test('an anthropic judge with a claude model on openrouter under test throws', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'anthropic/claude-opus-4-1' });
    expect(() =>
      resolveJudge(config, ['ollama/qwen3:8b', 'openrouter/anthropic/claude-haiku-4.5'], true, deps()),
    ).toThrow(/same model family/);
  });

  test('an ollama judge on the same base model as the model under test throws', () => {
    const config = configWith({
      TRIAGE_EVAL_JUDGE_MODEL: 'ollama/qwen3:32b',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(() => resolveJudge(config, ['ollama/qwen3:8b'], true, deps())).toThrow(/same model family/);
  });

  test('a judge from a different family is returned as the grader', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' });
    const grader = resolveJudge(config, ['anthropic/claude-haiku-4-5', 'ollama/qwen3:8b'], true, deps());
    expect(grader).toBeInstanceOf(JudgeProvider);
    expect(grader.id()).toBe('triage-judge:openai/gpt-5-mini');
  });

  test('an ollama judge of another base model is fine', () => {
    const config = configWith({
      TRIAGE_EVAL_JUDGE_MODEL: 'ollama/llama3.1:70b',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(resolveJudge(config, ['ollama/qwen3:8b'], true, deps())).toBeInstanceOf(JudgeProvider);
  });

  test('an ollama judge without OLLAMA_BASE_URL throws', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'ollama/llama3.1:70b' });
    expect(() => resolveJudge(config, ['anthropic/claude-haiku-4-5'], true, deps())).toThrow(/OLLAMA_BASE_URL/);
  });

  test('a judge that is not a spec, or on a provider the judge cannot call, throws', () => {
    const bad = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'gpt-5-mini' });
    expect(() => resolveJudge(bad, ['faux/classifier'], true, deps())).toThrow(/provider\/model/);
    const faux = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'faux/strong' });
    expect(() => resolveJudge(faux, ['faux/classifier'], true, deps())).toThrow(/must use one of/);
  });

  test('errors name the key, never the configured value', () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'anthropic/claude-opus-4-1' });
    try {
      resolveJudge(config, ['anthropic/claude-sonnet-4-5'], true, deps());
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).toContain(JUDGE_KEY);
      expect((err as Error).message).not.toContain('opus');
    }
  });
});

describe('modelFamily', () => {
  test.each([
    ['anthropic/claude-haiku-4-5', 'claude'],
    ['anthropic/claude-opus-4-1', 'claude'],
    ['openai/gpt-5-mini', 'openai'],
    ['openai/o3', 'openai'],
    ['ollama/qwen3:8b', 'qwen'],
    ['ollama/qwen3:32b', 'qwen'],
    ['ollama/llama3.1:70b', 'llama'],
    ['ollama/gpt-oss:20b', 'openai'],
    ['ollama/gemma3:12b', 'gemini'],
    ['openrouter/anthropic/claude-haiku-4.5', 'claude'],
    ['openrouter/meta-llama/llama-3.3-70b-instruct', 'llama'],
    ['openrouter/qwen/qwen3-32b', 'qwen'],
    ['faux/classifier', 'faux:classifier'],
  ])('%s is %s', (spec, family) => {
    expect(modelFamily(spec)).toBe(family);
  });
});

describe('JudgeProvider', () => {
  const PRICED = (): CostModel => ({
    provider: 'openai',
    id: 'gpt-5-mini',
    cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
  });

  function fakeComplete(reply: string, seen: { spec: string; system?: string; user: string }[]): CompleteFn {
    return async (spec, context, { signal }) => {
      const first = context.messages[0];
      seen.push({
        spec,
        ...(context.systemPrompt === undefined ? {} : { system: context.systemPrompt }),
        user: typeof first?.content === 'string' ? first.content : '',
      });
      const fake = createFakeModel();
      fake.script([text(reply)]);
      const model = fake.provider.getModels()[0];
      if (model === undefined) throw new Error('fake model has no models');
      return fake.provider.stream(model, context, { signal }).result();
    };
  }

  test('calls pi-ai on the judge model with the rubric roles and meters the cost', async () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' });
    const seen: { spec: string; system?: string; user: string }[] = [];
    const budget = new SuiteBudget(undefined);
    const judge = new JudgeProvider('openai/gpt-5-mini', config, {
      budget,
      complete: fakeComplete('{"reason":"same ask","pass":true,"score":1}', seen),
      costModel: PRICED,
    });
    const prompt = JSON.stringify([
      { role: 'system', content: 'You are grading output.' },
      { role: 'user', content: '<Output>x</Output><Rubric>y</Rubric>' },
    ]);
    const res = await judge.callApi(prompt);
    expect(res.error).toBeUndefined();
    expect(JSON.parse(String(res.output))).toEqual({ reason: 'same ask', pass: true, score: 1 });
    expect(seen).toEqual([{ spec: 'openai/gpt-5-mini', system: 'You are grading output.', user: '<Output>x</Output><Rubric>y</Rubric>' }]);
    expect(res.cost).toBeGreaterThan(0);
    expect(budget.meter.byModel()).toEqual([{ model: 'openai/gpt-5-mini', calls: 1, usd: res.cost as number }]);
  });

  test('refuses without calling once the suite budget is over the cap', async () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' });
    const seen: { spec: string; user: string }[] = [];
    const budget = new SuiteBudget(0);
    budget.add(PRICED(), { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 });
    const judge = new JudgeProvider('openai/gpt-5-mini', config, {
      budget,
      complete: fakeComplete('{}', seen),
      costModel: PRICED,
    });
    const res = await judge.callApi('grade');
    expect(res.error).toStartWith(COST_CAP_EXCEEDED);
    expect(seen).toEqual([]);
  });

  test('a provider error is returned as an error', async () => {
    const config = configWith({ TRIAGE_EVAL_JUDGE_MODEL: 'openai/gpt-5-mini' });
    const judge = new JudgeProvider('openai/gpt-5-mini', config, {
      budget: new SuiteBudget(undefined),
      complete: async () => {
        throw new Error('boom');
      },
    });
    expect((await judge.callApi('grade')).error).toContain('judge call failed');
  });

  test('rubricContext keeps plain strings and refuses assistant turns', () => {
    const plain = rubricContext('just grade it');
    expect(typeof plain).toBe('object');
    expect(typeof plain === 'object' && plain.messages.length).toBe(1);
    expect(rubricContext(JSON.stringify([{ role: 'assistant', content: 'x' }]))).toContain('system and user');
    expect(rubricContext(JSON.stringify([{ role: 'system', content: 'x' }]))).toContain('no user message');
  });
});
