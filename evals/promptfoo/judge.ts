// Picks the grader for the classifier suite (D41, D42, P1 critic "judge
// fallback").
//
// promptfoo falls back to a default grading provider when none is set, so the
// suite always sets one:
// - judge off: RefusingGrader, whose every call is an error;
// - judge on: JudgeProvider on TRIAGE_EVAL_JUDGE_MODEL.
// resolveJudge throws, before any case runs, when the judge is on and the
// model is blank, not a provider/model spec, on openrouter (D41), on a
// provider the judge cannot call, or in the same model family as a model
// under test.
//
// Family is the model lineage, not the provider: every anthropic model is
// 'claude', every openai model is 'openai', and an ollama or openrouter model
// is named by its base model (ollama/qwen3:8b and ollama/qwen3:32b are both
// 'qwen'; openrouter/anthropic/... is 'claude'; ollama/gpt-oss is 'openai').
import type { ApiProvider, ProviderResponse } from 'promptfoo';

import type { Config } from '../../src/config/env.ts';
import { parseSpec } from '../../src/models.ts';
import type { SuiteBudget } from './provider-classifier.ts';
import { JudgeProvider, type JudgeProviderDeps } from './provider-judge.ts';

export const JUDGE_KEY = 'TRIAGE_EVAL_JUDGE_MODEL';

/** Providers the judge may run on: the tier providers of D41, never openrouter. */
export const JUDGE_PROVIDERS: readonly string[] = Object.freeze(['anthropic', 'openai', 'ollama']);

export const GRADER_REFUSED = 'grader refused: the judge is off for this suite, so no model-graded assert may run';

export class JudgeConfigError extends Error {
  override readonly name = 'JudgeConfigError';
}

/** The grader used when the judge is off. Any call is an error, so promptfoo never grades with a default model. */
export class RefusingGrader implements ApiProvider {
  id(): string {
    return 'triage-judge:off';
  }

  async callApi(): Promise<ProviderResponse> {
    return { error: GRADER_REFUSED };
  }
}

// Base model names that belong to another lineage's family.
const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'claude',
  gpt: 'openai',
  chatgpt: 'openai',
  o: 'openai',
  openai: 'openai',
  codellama: 'llama',
  'meta-llama': 'llama',
  meta: 'llama',
  mistralai: 'mistral',
  mixtral: 'mistral',
  codestral: 'mistral',
  google: 'gemini',
  gemma: 'gemini',
  qwq: 'qwen',
};

/** The model family of a spec, used to keep the judge out of the family under test. */
export function modelFamily(spec: string): string {
  const parsed = parseSpec(spec.trim().toLowerCase());
  if (parsed === undefined) return spec.trim().toLowerCase();
  const { provider, modelId } = parsed;
  if (provider === 'anthropic') return 'claude';
  if (provider === 'openai') return 'openai';
  if (provider === 'openrouter') {
    // openrouter/<vendor>/<model>: the vendor names the family when it is a
    // known one, otherwise the base model does.
    const slash = modelId.indexOf('/');
    const vendor = slash > 0 ? modelId.slice(0, slash) : '';
    const aliased = FAMILY_ALIASES[vendor];
    if (aliased !== undefined) return aliased;
    return baseFamily(slash > 0 ? modelId.slice(slash + 1) : modelId);
  }
  if (provider === 'ollama') return baseFamily(modelId);
  // Any other provider (faux in tests) has no shared lineage with the rest.
  return `${provider}:${baseFamily(modelId)}`;
}

// qwen3:8b -> qwen, llama3.1:70b -> llama, gpt-oss:20b -> openai, hf.co/x/y -> y.
function baseFamily(modelId: string): string {
  const name = modelId.split('/').pop() ?? modelId;
  const base = name.split(':')[0] ?? name;
  const word = /^[a-z]+/.exec(base)?.[0] ?? base;
  return FAMILY_ALIASES[word] ?? word;
}

export type ResolveJudgeDeps = Omit<JudgeProviderDeps, 'budget'> & { readonly budget: SuiteBudget };

/**
 * The grader for a suite. env is the eval home config; modelsUnderTest are the
 * classifier specs the suite runs. Throws JudgeConfigError when the judge is
 * on and cannot be used. With the judge off the judge model is ignored.
 */
export function resolveJudge(
  env: Config,
  modelsUnderTest: readonly string[],
  judgeOn: boolean,
  deps: ResolveJudgeDeps,
): ApiProvider {
  if (!judgeOn) return new RefusingGrader();

  const spec = env.evals.judgeModel?.trim() ?? '';
  if (spec === '') throw new JudgeConfigError(`${JUDGE_KEY} is blank; the judge is on and there is no fallback grader`);
  const parsed = parseSpec(spec);
  if (parsed === undefined) throw new JudgeConfigError(`${JUDGE_KEY} must be a 'provider/model' spec`);
  if (parsed.provider === 'openrouter') {
    throw new JudgeConfigError(`${JUDGE_KEY} may not use openrouter (D41)`);
  }
  if (!JUDGE_PROVIDERS.includes(parsed.provider)) {
    throw new JudgeConfigError(`${JUDGE_KEY} must use one of ${JUDGE_PROVIDERS.join(', ')}`);
  }
  if (parsed.provider === 'ollama' && env.providers.ollamaBaseUrl === undefined) {
    throw new JudgeConfigError(`${JUDGE_KEY} uses ollama but OLLAMA_BASE_URL is blank`);
  }

  const family = modelFamily(spec);
  const clash = modelsUnderTest.find((m) => modelFamily(m) === family);
  if (clash !== undefined) {
    // The family is a lineage name, not a value from the env file.
    throw new JudgeConfigError(`${JUDGE_KEY} is in the same model family (${family}) as a model under test`);
  }
  return new JudgeProvider(spec, env, deps);
}
