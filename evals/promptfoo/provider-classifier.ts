// promptfoo provider for suite 1, the classifier suite (D42, P1 §3.3).
//
// One instance per classifier model. callApi reads the case vars (thread,
// ids, id_chain, basic_state, attachments, policy), calls classify() once,
// sets matched_pattern_id from the case's patterns the way patterns.ts would,
// applies the tier policy and returns the result as JSON (the shape in
// asserts/schema.ts). It can be loaded as file://evals/promptfoo/provider-classifier.ts
// (default export) or built directly by buildClassifierSuite.
//
// The model is fixed when the provider is built and passed to classify() in a
// per-call copy of the config. Nothing reads MODEL_CLASSIFIER from
// process.env, so several providers in one promptfoo process do not race.
//
// Faux mode (a faux/* model): each call scripts a fresh fake model with the
// case's faux_classification and installs the no-io guard first (the one
// network deny, test/support/no-io-guard.ts; T10.2 adds no second one). A
// fresh fake per call keeps concurrent cases from taking each other's
// response.
//
// Cost: every call is metered with CostMeter from the model's pi-ai cost
// metadata. Once the suite total is above TRIAGE_EVAL_MAX_COST_USD, the
// remaining calls return a cost_cap_exceeded error without calling a model.
// The budget is shared by every provider of a suite and by the judge.
//
// The provider uses only the models, evals and knowledge path parts of the
// config. It never loads the entity registry, never reads entity keys and
// never calls an entity connector. Images are not sent to the classifier:
// case attachments name files, not bytes. The policy still sees has-images.
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { hasProvider } from '@flue/runtime/internal';
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderOptions, ProviderResponse } from 'promptfoo';
import * as v from 'valibot';

import { classify, completeWith, defaultComplete, type CompleteFn } from '../../src/classify/classify.ts';
import { matchPattern } from '../../src/classify/patterns.ts';
import { applyTierPolicy } from '../../src/classify/policy.ts';
import type { CategoryEntry } from '../../src/classify/prompt.ts';
import { loadConfig, type Config } from '../../src/config/env.ts';
import {
  CaseIdChainSchema,
  CasePolicySchema,
  policyContextFor,
  toIdChain,
  type EvalCase,
} from '../../src/evals/case-schema.ts';
import { CostError, CostMeter, parseCapUsd, type CostModel, type ModelSpend, type UsageTokens } from '../../src/evals/cost.ts';
import { createFakeModel, text } from '../../src/mock/fake-model.ts';
import { lookupModel, parseSpec } from '../../src/models.ts';
import { ClassificationSchema } from '../../src/types/classification.ts';
import { KnownIdsSchema, NonEmptyStringSchema } from '../../src/types/core.ts';
import { BasicStateItemSchema } from '../../src/types/id-chain.ts';
import { AttachmentSchema, ThreadMessageSchema, type ThreadMessage } from '../../src/types/request.ts';
import { installNoIoGuard } from '../../test/support/no-io-guard.ts';
import type { ClassifierOutput } from './asserts/schema.ts';

export const COST_CAP_EXCEEDED = 'cost_cap_exceeded';
export const FAUX_PROVIDER = 'faux';
export const PROVIDER_ID_PREFIX = 'triage-classifier:';

// ---------------------------------------------------------------- suite budget

export type BudgetSummary = {
  readonly total_usd: number;
  readonly cap_usd: number | null;
  readonly cost_cap_exceeded: boolean;
  readonly by_model: readonly ModelSpend[];
};

/** One spend meter and cap for a whole suite run. */
export class SuiteBudget {
  readonly meter: CostMeter;
  readonly capUsd: number | undefined;
  private hitCap = false;

  constructor(capUsd: number | string | null | undefined, meter: CostMeter = new CostMeter()) {
    this.capUsd = parseCapUsd(capUsd);
    this.meter = meter;
  }

  /** An error message once the total is above the cap, otherwise undefined. */
  refusal(): string | undefined {
    if (!this.meter.overCap(this.capUsd)) return undefined;
    this.hitCap = true;
    return `${COST_CAP_EXCEEDED}: suite spend is above TRIAGE_EVAL_MAX_COST_USD; the remaining cases are not run`;
  }

  add(model: CostModel, usage: UsageTokens): number {
    return this.meter.add(model, usage);
  }

  /** True once a call was refused for the cap. */
  get exceeded(): boolean {
    return this.hitCap;
  }

  summary(): BudgetSummary {
    return {
      total_usd: this.meter.totalUsd(),
      cap_usd: this.capUsd ?? null,
      cost_cap_exceeded: this.hitCap,
      by_model: this.meter.byModel(),
    };
  }
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Cost metadata for a model spec. ollama is local and free. Other models come
 * from the runtime registry or the pi-ai catalog; a model without cost
 * metadata makes the meter throw rather than run uncapped.
 */
export function defaultCostModel(spec: string): CostModel {
  const parsed = parseSpec(spec);
  const provider = parsed?.provider ?? '';
  const id = parsed?.modelId ?? spec;
  if (provider === 'ollama') return { provider, id, cost: { ...ZERO_COST } };
  const meta = lookupModel(spec) as Partial<CostModel> | undefined;
  return { provider, id, cost: meta?.cost as CostModel['cost'] };
}

// ---------------------------------------------------------------- case vars

export const ClassifierVarsSchema = v.object({
  case_id: NonEmptyStringSchema,
  thread: v.pipe(v.array(ThreadMessageSchema), v.minLength(1)),
  attachments: v.optional(v.array(AttachmentSchema), []),
  ids: KnownIdsSchema,
  id_chain: CaseIdChainSchema,
  basic_state: v.array(BasicStateItemSchema),
  policy: v.optional(CasePolicySchema),
  faux_classification: v.optional(ClassificationSchema),
});
export type ClassifierVars = v.InferOutput<typeof ClassifierVarsSchema>;

/** The thread a case holds, as messages. A text request becomes one parent message. */
export function caseThread(c: Pick<EvalCase, 'request'>): ThreadMessage[] {
  if (c.request.messages) return c.request.messages.map((m) => ({ ...m }));
  return [{ ts: '0', author: 'caller', is_parent: true, text: c.request.text ?? '' }];
}

/** The promptfoo vars for one case. expected rides along for the asserts. */
export function caseVars(c: EvalCase): Record<string, unknown> {
  const vars: Record<string, unknown> = {
    case_id: c.id,
    thread: caseThread(c),
    attachments: c.request.attachments ?? [],
    ids: c.ids,
    id_chain: c.id_chain,
    basic_state: c.basic_state,
    expected: c.expected,
  };
  if (c.policy !== undefined) vars.policy = c.policy;
  if (c.faux_classification !== undefined) vars.faux_classification = c.faux_classification;
  return vars;
}

// ---------------------------------------------------------------- provider

export type ClassifierProviderOptions = ProviderOptions & {
  config?: { model?: string; timeoutMs?: number };
};

export type ClassifierProviderDeps = {
  /** The eval home config. Default: loadConfig() from TRIAGE_HOME. */
  readonly config?: Config;
  /** Shared suite budget. Default: one per provider, capped by config.evals.maxCostUsd. */
  readonly budget?: SuiteBudget;
  /** Completion for non-faux models. Default: defaultComplete(config). */
  readonly complete?: CompleteFn;
  /** Cost metadata per spec. Default: defaultCostModel. */
  readonly costModel?: (spec: string) => CostModel;
  /** Installed before every faux call. Default: installNoIoGuard. */
  readonly installNetworkDeny?: () => void;
  /** Default: loaded from <knowledgeDir>/classifier/categories.json by classify(). */
  readonly categories?: readonly CategoryEntry[];
};

export class ClassifierProvider implements ApiProvider {
  readonly model: string;
  readonly faux: boolean;
  readonly label?: string;
  readonly config: { model: string; timeoutMs?: number };
  private readonly env: Config;
  private readonly budget: SuiteBudget;
  private readonly deps: ClassifierProviderDeps;

  constructor(options: ClassifierProviderOptions = {}, deps: ClassifierProviderDeps = {}) {
    this.env = deps.config ?? loadConfig();
    const model = options.config?.model ?? this.env.models.classifier;
    if (model === undefined || parseSpec(model) === undefined) {
      throw new Error("classifier provider needs a 'provider/model' spec in config.model or MODEL_CLASSIFIER");
    }
    this.model = model;
    this.faux = parseSpec(model)?.provider === FAUX_PROVIDER;
    this.config = { model, ...(options.config?.timeoutMs === undefined ? {} : { timeoutMs: options.config.timeoutMs }) };
    if (options.label !== undefined) this.label = options.label;
    this.budget = deps.budget ?? new SuiteBudget(this.env.evals.maxCostUsd);
    this.deps = deps;
  }

  id(): string {
    return `${PROVIDER_ID_PREFIX}${this.model}`;
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
    options?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    const parsed = v.safeParse(ClassifierVarsSchema, context?.vars);
    if (!parsed.success) {
      const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
      return this.fail(`invalid case vars at ${paths.join(', ')}`);
    }
    const vars = parsed.output;

    const refusal = this.budget.refusal();
    if (refusal !== undefined) return this.fail(refusal, { case_id: vars.case_id, [COST_CAP_EXCEEDED]: true });

    let inner: CompleteFn;
    if (this.faux) {
      (this.deps.installNetworkDeny ?? installNoIoGuard)();
      if (vars.faux_classification === undefined) {
        return this.fail('faux mode needs faux_classification in the case', { case_id: vars.case_id });
      }
      inner = fauxCompletion(vars.faux_classification);
    } else {
      inner = this.deps.complete ?? defaultComplete(this.env);
    }

    let reply: AssistantMessage | undefined;
    const complete: CompleteFn = async (spec, ctx, opts) => {
      reply = await inner(spec, ctx, opts);
      return reply;
    };

    const classification = await classify(
      { thread: vars.thread, idChain: toIdChain(vars), basicState: vars.basic_state, images: [] },
      {
        config: withClassifierModel(this.env, this.model),
        complete,
        ...(this.deps.categories === undefined ? {} : { categories: this.deps.categories }),
        ...(this.config.timeoutMs === undefined ? {} : { timeoutMs: this.config.timeoutMs }),
        ...(options?.abortSignal === undefined ? {} : { signal: options.abortSignal }),
      },
    );

    let costUsd = 0;
    if (reply !== undefined) {
      try {
        costUsd = this.budget.add((this.deps.costModel ?? defaultCostModel)(this.model), reply.usage);
      } catch (err) {
        const message = err instanceof CostError ? err.message : 'cost could not be computed';
        return this.fail(`cost meter: ${message}`, { case_id: vars.case_id });
      }
    }

    // The model's matched_pattern_id is dropped by classify(); the pattern
    // comes from the case's patterns, as patterns.ts sets it in the pipeline.
    const patterns = vars.policy?.patterns ?? [];
    if (classification.classifier_error === undefined && patterns.length > 0) {
      const hit = matchPattern(vars.thread.map((m) => m.text).join('\n'), [], classification.category, patterns);
      if (hit !== null) classification.matched_pattern_id = hit.matched_pattern_id;
    }

    const policy = applyTierPolicy(
      classification,
      policyContextFor({ request: { messages: vars.thread, attachments: vars.attachments }, policy: vars.policy }),
    );
    const output: ClassifierOutput = {
      case_id: vars.case_id,
      model: this.model,
      classification: policy.classification,
      tier: {
        proposed: policy.tier_proposed,
        final: policy.tier_final,
        rule_fired: policy.rule_fired,
        rules_applied: policy.rules_applied,
        ...(policy.tier_raised_for_images ? { tier_raised_for_images: true as const } : {}),
        ...(policy.images_dropped ? { images_dropped: true as const } : {}),
      },
      cost_usd: costUsd,
    };
    const usage = reply?.usage;
    return {
      output: JSON.stringify(output),
      cost: costUsd,
      ...(usage === undefined
        ? {}
        : {
            tokenUsage: {
              prompt: usage.input + usage.cacheRead + usage.cacheWrite,
              completion: usage.output,
              total: usage.totalTokens,
              numRequests: 1,
            },
          }),
      metadata: { model: this.model, case_id: vars.case_id },
    };
  }

  private fail(error: string, extra: Record<string, unknown> = {}): ProviderResponse {
    return { error, metadata: { model: this.model, ...extra } };
  }
}

export default ClassifierProvider;

/** A config copy whose MODEL_CLASSIFIER is the given spec. The original stays frozen and untouched. */
export function withClassifierModel(config: Config, model: string): Config {
  return { ...config, models: { ...config.models, classifier: model } };
}

// A fresh fake per call, scripted with the case's classification. The faux id
// must be in the runtime registry for classifierModel() to accept the spec;
// it is registered once and only when no other fake is there already.
function fauxCompletion(classification: unknown): CompleteFn {
  if (!hasProvider(FAUX_PROVIDER)) createFakeModel().install();
  const fake = createFakeModel();
  fake.script([text(JSON.stringify(classification))]);
  return completeWith(fake.provider);
}
