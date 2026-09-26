// Suite 1, the classifier suite (D42, P1 §3.3 and §3.4), as a promptfoo
// test suite for evaluate(). The evals CLI command (T10.8) runs it.
//
// buildClassifierSuite({ providers, judgeOn, repeat }):
// - builds one ClassifierProvider per classifier model spec, all sharing one
//   SuiteBudget capped by TRIAGE_EVAL_MAX_COST_USD;
// - resolves the grader first, so a bad judge setting fails before any case
//   runs;
// - loads evals/cases and makes one test per case with the schema, category
//   and tier asserts. No case has a model-graded assert: the classifier gives
//   decisions only, and each one is checked in code;
// - always sets defaultTest.options.provider (and the rubric's own provider)
//   to the resolved grader, which refuses every call when the judge is off,
//   so promptfoo can never fall back to a default grading model.
//
// faux and real classifier models are not mixed in one suite: faux mode
// installs the no-io guard for the whole process, which would break the real
// provider's calls halfway through.
import { fileURLToPath } from 'node:url';
import type { ApiProvider, Assertion, EvaluateOptions, EvaluateTestSuite, TestCase } from 'promptfoo';

import type { Config } from '../../src/config/env.ts';
import { loadConfig } from '../../src/config/env.ts';
import { TAXONOMY_VERSION, loadCases, type EvalCase } from '../../src/evals/case-schema.ts';
import { parseSpec } from '../../src/models.ts';
import { CATEGORY_METRIC, categoryAssert } from './asserts/category.ts';
import { SCHEMA_METRIC, schemaAssert } from './asserts/schema.ts';
import { TIER_METRIC, tierAssert } from './asserts/tier.ts';
import { resolveJudge } from './judge.ts';
import {
  ClassifierProvider,
  FAUX_PROVIDER,
  SuiteBudget,
  caseVars,
  type ClassifierProviderDeps,
} from './provider-classifier.ts';
import type { JudgeProviderDeps } from './provider-judge.ts';

export const DEFAULT_CASES_DIR = fileURLToPath(new URL('../cases/', import.meta.url));
export const DEFAULT_MAX_CONCURRENCY = 4;

export class SuiteConfigError extends Error {
  override readonly name = 'SuiteConfigError';
}

export type BuildClassifierSuiteOptions = {
  /** Classifier model specs to compare side by side. Default: [MODEL_DECISION]. */
  readonly providers?: readonly string[];
  readonly judgeOn: boolean;
  /** Trials per case, passed to promptfoo as repeat. Default 1. */
  readonly repeat?: number;
  /** The eval home config. Default: loadConfig() from TRIAGE_HOME. */
  readonly config?: Config;
  /** Default: evals/cases in this repo. */
  readonly casesDir?: string;
  readonly maxConcurrency?: number;
  /** Test seams for the providers and the judge; the budget is built here. */
  readonly providerDeps?: Omit<ClassifierProviderDeps, 'config' | 'budget'>;
  readonly judgeDeps?: Omit<JudgeProviderDeps, 'budget'>;
};

export type ClassifierSuite = {
  readonly testSuite: EvaluateTestSuite;
  readonly evaluateOptions: EvaluateOptions;
  readonly providers: readonly ClassifierProvider[];
  /** The grader promptfoo uses for every model-graded assert. */
  readonly grader: ApiProvider;
  /** Spend and cost_cap_exceeded for the run, read after evaluate(). */
  readonly budget: SuiteBudget;
};

export async function buildClassifierSuite(options: BuildClassifierSuiteOptions): Promise<ClassifierSuite> {
  const config = options.config ?? loadConfig();
  const specs = modelSpecs(options.providers, config);
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new SuiteConfigError('repeat must be an integer >= 1');

  const budget = new SuiteBudget(config.evals.maxCostUsd);
  const grader = resolveJudge(config, specs, options.judgeOn, { ...options.judgeDeps, budget });
  const providers = specs.map(
    (model) => new ClassifierProvider({ config: { model } }, { ...options.providerDeps, config, budget }),
  );

  const cases = await loadCases(options.casesDir ?? DEFAULT_CASES_DIR);
  if (cases.length === 0) throw new SuiteConfigError('no eval cases found');
  const stale = cases.filter((c) => c.case.taxonomy_version !== TAXONOMY_VERSION).map((c) => c.case.id);
  if (stale.length > 0) {
    throw new SuiteConfigError(`cases labelled against another taxonomy version: ${stale.join(', ')}`);
  }

  const testSuite: EvaluateTestSuite = {
    description: 'triage classifier suite (suite 1)',
    prompts: ['{{case_id}}'],
    providers,
    defaultTest: { options: { provider: grader } },
    tests: cases.map((c) => caseTest(c.case)),
    sharing: false,
  };
  const evaluateOptions: EvaluateOptions = {
    repeat,
    cache: false,
    maxConcurrency: options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    showProgressBar: false,
  };
  return { testSuite, evaluateOptions, providers, grader, budget };
}

function modelSpecs(requested: readonly string[] | undefined, config: Config): string[] {
  const specs = requested ?? (config.models.decision === undefined ? [] : [config.models.decision]);
  if (specs.length === 0) throw new SuiteConfigError('no classifier model: pass providers or set MODEL_DECISION');
  for (const spec of specs) {
    if (parseSpec(spec) === undefined) throw new SuiteConfigError("each provider must be a 'provider/model' spec");
  }
  if (new Set(specs).size !== specs.length) throw new SuiteConfigError('each classifier model may appear once');
  const faux = specs.filter((s) => parseSpec(s)?.provider === FAUX_PROVIDER).length;
  if (faux > 0 && faux < specs.length) {
    throw new SuiteConfigError('faux and real classifier models cannot run in one suite');
  }
  return [...specs];
}

/** The promptfoo test for one case. */
export function caseTest(c: EvalCase): TestCase {
  const assert: Assertion[] = [
    { type: 'javascript', value: schemaAssert, metric: SCHEMA_METRIC },
    { type: 'javascript', value: categoryAssert, metric: CATEGORY_METRIC },
    { type: 'javascript', value: tierAssert, metric: TIER_METRIC },
  ];
  return {
    description: c.id,
    vars: caseVars(c) as TestCase['vars'],
    assert,
    metadata: { case_id: c.id, label_source: c.label_source, taxonomy_version: c.taxonomy_version },
  };
}
