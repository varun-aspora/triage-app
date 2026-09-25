// The classifier (HLD 02 §1.5, LLD 04 §2.3 and §3, D9, D22, D36, D41, D43).
//
// classify() asks MODEL_CLASSIFIER once and validates the answer with
// ClassificationSchema. It never throws: invalid, unparseable or unreachable
// output, a timeout and a config problem all return category 'unknown' with
// classifier_error set, and the tier policy then routes the run to strong
// (fail upward, D9).
//
// Two paths, picked by the spec:
// - a decision model spec (typesafe/<model> or openrouter/typesafe/<model>,
//   src/decisions/registry.ts) makes one decide() call with the questions in
//   ./decision.ts. Decision models take no images, so images_seen is false.
// - any other spec (anthropic, openai, openrouter chat, ollama, faux) makes
//   one completion call, described below.
//
// Structured output on the completion path: pi-ai has no provider-neutral
// response format, so the prompt asks for one JSON object and this module
// parses and validates it.
// Only the fields the model is asked for are taken from its answer. The
// module sets images_seen and classifier_error itself, and drops any
// matched_pattern_id the model makes up: that id lowers the tier (policy
// rule 5), so only patterns.ts may set it.
//
// Images are attached only when the classifier model takes image input
// (acceptsImages, D36). Otherwise the call is text only and images_seen is
// false; the tier model still gets the images later.
//
// The completion function and the decision provider are injectable. Tests
// and evals pass completeWith(fake.provider) or fakeDecisionProvider(); the
// defaults build a private pi-ai Models instance for the classifier's own
// provider, or decisionProviderFor(spec). Importing ../models.ts runs its
// provider registration side effect before the first call.
import { createModels, type AssistantMessage, type Context, type ImageContent, type Provider, type TextContent } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import * as v from 'valibot';

import type { Config } from '../config/env.ts';
import { decide, DecisionError } from '../decisions/decide.ts';
import { decisionProviderFor, isDecisionSpec } from '../decisions/registry.ts';
import type { DecisionProvider } from '../decisions/types.ts';
import { redactPersisted } from '../gate/redact.ts';
import { acceptsImages, classifierModel, ollamaProvider, parseSpec, type ModelLookup } from '../models.ts';
import { ClassificationSchema, type Classification } from '../types/classification.ts';
import type { BasicStateItem, IdChain } from '../types/id-chain.ts';
import type { ThreadMessage } from '../types/request.ts';
import { classificationFromAnswers, classifierQuestions } from './decision.ts';
import { buildClassifierPrompt, buildDecisionState, loadCategories, type CategoryEntry } from './prompt.ts';

/** One screenshot, already read from the attachment store. */
export type ClassifierImage = {
  readonly mimeType: string;
  /** Base64 image bytes. */
  readonly data: string;
};

export type ClassifyInput = {
  readonly thread: readonly ThreadMessage[];
  readonly idChain: IdChain;
  readonly basicState: readonly BasicStateItem[];
  readonly images: readonly ClassifierImage[];
  /** Names from ingress, masked when the classifier runs on openrouter or typesafe. */
  readonly redactionNames?: readonly string[];
};

/** One completion call. Rejects or returns stopReason 'error' when the provider fails. */
export type CompleteFn = (
  spec: string,
  context: Context,
  options: { readonly signal: AbortSignal },
) => Promise<AssistantMessage>;

export type ClassifyDeps = {
  readonly config: Config;
  /** Completion path only. Default: defaultComplete(config). */
  readonly complete?: CompleteFn;
  /** Decision path only. Default: decisionProviderFor(MODEL_CLASSIFIER, config). */
  readonly decisions?: DecisionProvider;
  /** Default: <knowledgeDir>/classifier/categories.json. */
  readonly categories?: readonly CategoryEntry[];
  /** Model metadata lookup for the image check. Default: models.ts lookupModel. */
  readonly imageLookup?: ModelLookup;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 60_000;

/** classifier_error text is capped at this many characters. */
export const MAX_ERROR_CHARS = 300;

// The fields the model is asked for. Anything else in its answer is dropped.
const MODEL_FIELDS = [
  'category',
  'subcategory',
  'entities_likely',
  'money_moved',
  'misdirected_funds',
  'tier_proposed',
  'confidence',
] as const;

export async function classify(input: ClassifyInput, deps: ClassifyDeps): Promise<Classification> {
  try {
    return await classifyOnce(input, deps);
  } catch (err) {
    // Anything not already handled below (config, categories file, a bug).
    return unknownClassification(`classifier failed: ${describe(err)}`);
  }
}

async function classifyOnce(input: ClassifyInput, deps: ClassifyDeps): Promise<Classification> {
  const spec = classifierModel(deps.config);
  const provider = parseSpec(spec)?.provider ?? '';
  const categories = deps.categories ?? (await loadCategories(deps.config.paths.knowledgeDir));
  if (isDecisionSpec(spec)) return classifyByDecision(input, deps, spec, provider, categories);
  const sendImages = input.images.length > 0 && acceptsImages(spec, deps.imageLookup);

  const prompt = buildClassifierPrompt({
    categories,
    thread: input.thread,
    idChain: input.idChain,
    basicState: input.basicState,
    provider,
    imageCount: input.images.length,
    imagesAttached: sendImages,
    ...(input.redactionNames === undefined ? {} : { redactionNames: input.redactionNames }),
  });

  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: prompt.userText }];
  if (sendImages) {
    for (const img of input.images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  const context: Context = {
    systemPrompt: prompt.systemPrompt,
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  };

  const complete = deps.complete ?? defaultComplete(deps.config);
  const outcome = await callWithTimeout(complete, spec, context, deps.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS, deps.signal);
  if (!outcome.ok) return unknownClassification(outcome.error);

  const message = outcome.message;
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return unknownClassification(`provider error: ${message.errorMessage ?? message.stopReason}`);
  }
  return parseClassification(textOf(message), sendImages);
}

// ---------------------------------------------------------------- decision path

async function classifyByDecision(
  input: ClassifyInput,
  deps: ClassifyDeps,
  spec: string,
  provider: string,
  categories: readonly CategoryEntry[],
): Promise<Classification> {
  const { state } = buildDecisionState({
    thread: input.thread,
    idChain: input.idChain,
    basicState: input.basicState,
    provider,
    imageCount: input.images.length,
    ...(input.redactionNames === undefined ? {} : { redactionNames: input.redactionNames }),
  });
  const questions = classifierQuestions(categories, deps.config.entities);
  try {
    const decider = deps.decisions ?? decisionProviderFor(spec, deps.config);
    const result = await decide(
      decider,
      { state, questions },
      { timeoutMs: deps.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS, ...(deps.signal === undefined ? {} : { signal: deps.signal }) },
    );
    const outcome = classificationFromAnswers(result.answers);
    return outcome.ok ? outcome.classification : unknownClassification(outcome.error);
  } catch (err) {
    return unknownClassification(decisionFailure(err));
  }
}

// A DecisionError message holds only a code, the provider and a status. Its
// detail is kept for the codes whose detail this code base writes itself
// (key names, answer paths, the time limit); a provider's own error text
// could echo the request, so it is left out.
const LOCAL_DETAIL_CODES: ReadonlySet<string> = new Set(['config', 'invalid_response', 'timeout']);

function decisionFailure(err: unknown): string {
  if (!(err instanceof DecisionError)) return `decision failed: ${err instanceof Error ? err.name : typeof err}`;
  return err.detail !== undefined && LOCAL_DETAIL_CODES.has(err.code) ? `${err.message}: ${err.detail}` : err.message;
}

// ---------------------------------------------------------------- parsing

/**
 * Parses the model's text into a Classification. images_seen is set by the
 * caller; classifier_error and matched_pattern_id from the model are dropped.
 */
export function parseClassification(text: string, imagesSeen: boolean): Classification {
  const json = extractJson(text);
  if (json === undefined) return unknownClassification('unparseable output: no JSON object found');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return unknownClassification('unparseable output: invalid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return unknownClassification('unparseable output: not a JSON object');
  }
  const picked: Record<string, unknown> = {};
  for (const key of MODEL_FIELDS) {
    if (key in raw) picked[key] = (raw as Record<string, unknown>)[key];
  }
  picked.images_seen = imagesSeen;
  const result = v.safeParse(ClassificationSchema, picked);
  if (!result.success) {
    // Paths only, never the values, so no thread text lands in the error.
    const paths = [...new Set(result.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
    return unknownClassification(`schema-invalid output at ${paths.join(', ')}`);
  }
  return result.output;
}

// A bare object, or one inside a code fence or surrounded by prose.
function extractJson(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  return body.slice(start, end + 1);
}

function textOf(message: AssistantMessage): string {
  return message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** The fail-upward result: category unknown, strong proposed, classifier_error set. */
export function unknownClassification(error: string): Classification {
  return {
    category: 'unknown',
    subcategory: '',
    entities_likely: [],
    money_moved: false,
    misdirected_funds: false,
    tier_proposed: 'strong',
    confidence: 0,
    images_seen: false,
    classifier_error: sanitize(error),
  };
}

// Error text can quote provider responses; mask it with the persisted profile
// and cap it before it is stored.
function sanitize(error: string): string {
  const masked = redactPersisted(error.replace(/\s+/g, ' ').trim()).value;
  const text = masked === '' ? 'classifier error' : masked;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

function describe(err: unknown): string {
  if (err instanceof v.ValiError) return 'invalid categories file';
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- the call

type CallOutcome = { ok: true; message: AssistantMessage } | { ok: false; error: string };

// Races the call against the timeout and the caller's signal, so a provider
// that ignores its signal still cannot hold the classifier past the deadline.
async function callWithTimeout(
  complete: CompleteFn,
  spec: string,
  context: Context,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<CallOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuterAbort: (() => void) | undefined;
  const stopped = new Promise<CallOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: `timeout after ${timeoutMs} ms` });
    }, timeoutMs);
    onOuterAbort = () => {
      controller.abort();
      resolve({ ok: false, error: 'aborted by caller' });
    };
    if (outer?.aborted) onOuterAbort();
    else outer?.addEventListener('abort', onOuterAbort, { once: true });
  });
  const call = (async (): Promise<CallOutcome> => {
    try {
      return { ok: true, message: await complete(spec, context, { signal: controller.signal }) };
    } catch (err) {
      return { ok: false, error: `provider error: ${describe(err)}` };
    }
  })();
  try {
    return await Promise.race([call, stopped]);
  } finally {
    clearTimeout(timer);
    if (onOuterAbort !== undefined) outer?.removeEventListener('abort', onOuterAbort);
  }
}

// ---------------------------------------------------------------- completion functions

/** A CompleteFn that streams through one pi-ai provider directly (tests: the fake provider). */
export function completeWith(provider: Provider): CompleteFn {
  return async (spec, context, { signal }) => {
    const parsed = parseSpec(spec);
    if (parsed === undefined || parsed.provider !== provider.id) {
      throw new Error(`model spec does not belong to provider ${provider.id}`);
    }
    const model = provider.getModels().find((m) => m.id === parsed.modelId);
    if (model === undefined) throw new Error(`provider ${provider.id} has no model ${parsed.modelId}`);
    return provider.stream(model, context, { signal }).result();
  };
}

/**
 * The served completion function: a private pi-ai Models instance holding the
 * classifier's provider (anthropic, openai, openrouter, or ollama when
 * OLLAMA_BASE_URL is set). API keys come from config. Any other provider,
 * such as faux, must be passed in with completeWith().
 */
export function defaultComplete(config: Config): CompleteFn {
  return async (spec, context, { signal }) => {
    const parsed = parseSpec(spec);
    if (parsed === undefined) throw new Error('MODEL_CLASSIFIER is not a provider/model spec');
    const provider = providerFor(parsed.provider, parsed.modelId, config);
    if (provider === undefined) {
      throw new Error(`no default completion for provider ${parsed.provider}; pass deps.complete`);
    }
    const models = createModels();
    models.setProvider(provider);
    const model = models.getModel(parsed.provider, parsed.modelId);
    if (model === undefined) throw new Error(`provider ${parsed.provider} does not list model ${parsed.modelId}`);
    const apiKey = apiKeyFor(parsed.provider, config);
    return models.complete(model, context, apiKey === undefined ? { signal } : { signal, apiKey });
  };
}

function providerFor(id: string, modelId: string, config: Config): Provider | undefined {
  switch (id) {
    case 'anthropic':
      return anthropicProvider();
    case 'openai':
      return openaiProvider();
    case 'openrouter':
      return openrouterProvider();
    case 'ollama':
      return config.providers.ollamaBaseUrl === undefined
        ? undefined
        : ollamaProvider(config.providers.ollamaBaseUrl, [modelId]);
    default:
      return undefined;
  }
}

function apiKeyFor(id: string, config: Config): string | undefined {
  const p = config.providers;
  if (id === 'anthropic') return p.anthropicApiKey;
  if (id === 'openai') return p.openaiApiKey;
  if (id === 'openrouter') return p.openrouterApiKey;
  return undefined;
}
