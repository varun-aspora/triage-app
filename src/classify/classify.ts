// The classifier (HLD 02 §1.5, LLD 04 §2.3 and §3, D9, D22, D36, D41, D43).
//
// classify() asks MODEL_DECISION once and validates the answer with
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
//
// Usage (D59): deps.onUsage hears about the one model call, with model set
// to the MODEL_DECISION spec on both paths.
// - completion path: called once a message comes back, stopReason 'error'
//   or 'aborted' included (failed), with the message's usage. A timeout, a
//   caller abort or a thrown provider error has no message, so no call.
// - decision path: called with the result's usage and the provider-reported
//   cost. When decide() fails after the provider was asked (a provider
//   error, a timeout, an abort, answers that do not match the questions),
//   it is called with failed set and the tokens of the result if one came
//   back, else 0. When decide() fails before that (no key, bad questions,
//   already aborted), nothing was sent and there is no call.
// A callback that throws is ignored; it never changes the classification.
//
// Tracing (D82): the model call on either path is an llm span tagged with
// input.runId. The decision path passes it to decide(), which records
// 'decision:<model>'. The completion path records 'decision:<spec>' here,
// with the prompt texts as input (never the images), the message usage and
// the cost from src/usage/price.ts. Both pass input.redactionNames, so in
// 'redacted' content mode the span masks the ingress names even where the
// prompt keeps them (the model-facing profile). A message with stopReason
// 'error' or 'aborted' is recorded as a failed span. With tracing off both
// are plain calls.
import { createModels, type AssistantMessage, type Context, type ImageContent, type Provider, type TextContent } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import * as v from 'valibot';

import type { Config } from '../config/env.ts';
import { decide, DecisionError } from '../decisions/decide.ts';
import { decisionProviderFor, isDecisionSpec } from '../decisions/registry.ts';
import type { DecisionProvider, DecisionUsage } from '../decisions/types.ts';
import { redactPersisted } from '../gate/redact.ts';
import { acceptsImages, decisionModel, ollamaProvider, parseSpec, type ModelLookup } from '../models.ts';
import { traceModelCall, type ModelCallRecord } from '../tracing/braintrust.ts';
import { ClassificationSchema, type Classification } from '../types/classification.ts';
import type { RunId } from '../types/core.ts';
import type { BasicStateItem, IdChain } from '../types/id-chain.ts';
import type { ThreadMessage } from '../types/request.ts';
import { priceUsage } from '../usage/price.ts';
import { classificationFromAnswers, classifierQuestions, issuePaths } from './decision.ts';
import { buildClassifierPrompt, buildDecisionState, loadCategories, type CategoryEntry, type DecisionStateInput } from './prompt.ts';

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
  /** The run being classified. Tags the trace span (D82); the classification never reads it. */
  readonly runId?: RunId;
};

/** One completion call. Rejects or returns stopReason 'error' when the provider fails. */
export type CompleteFn = (
  spec: string,
  context: Context,
  options: { readonly signal: AbortSignal },
) => Promise<AssistantMessage>;

/** One classifier model call, for the run's usage (D59). */
export type ClassifierUsage = {
  readonly path: 'completion' | 'decision';
  /** The MODEL_DECISION spec, not the name the provider answered with. */
  readonly model: string;
  readonly failed: boolean;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Completion path, when the provider reports it (Anthropic only). */
  readonly cacheWrite1h?: number;
  /** Decision path only: the cost the provider reported, when it is a finite number >= 0. */
  readonly reportedUsd?: number;
};

export type ClassifyDeps = {
  readonly config: Config;
  /** Completion path only. Default: defaultComplete(config). */
  readonly complete?: CompleteFn;
  /** Decision path only. Default: decisionProviderFor(MODEL_DECISION, config). */
  readonly decisions?: DecisionProvider;
  /** Default: <knowledgeDir>/classifier/categories.json. */
  readonly categories?: readonly CategoryEntry[];
  /** Model metadata lookup for the image check. Default: models.ts lookupModel. */
  readonly imageLookup?: ModelLookup;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called at most once per classify(), when a model call was made. */
  readonly onUsage?: (u: ClassifierUsage) => void;
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
  const spec = decisionModel(deps.config);
  const categories = deps.categories ?? (await loadCategories(deps.config.paths.knowledgeDir));
  const stateInput: DecisionStateInput = {
    thread: input.thread,
    idChain: input.idChain,
    basicState: input.basicState,
    provider: parseSpec(spec)?.provider ?? '',
    imageCount: input.images.length,
    ...(input.redactionNames === undefined ? {} : { redactionNames: input.redactionNames }),
  };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;
  if (isDecisionSpec(spec)) return classifyByDecision(stateInput, deps, spec, categories, timeoutMs, input);
  const sendImages = input.images.length > 0 && acceptsImages(spec, deps.imageLookup);
  const prompt = buildClassifierPrompt({ ...stateInput, categories, imagesAttached: sendImages });

  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: prompt.userText }];
  if (sendImages) {
    for (const img of input.images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  const context: Context = {
    systemPrompt: prompt.systemPrompt,
    messages: [{ role: 'user', content, timestamp: Date.now() }],
  };

  const complete = traced(deps.complete ?? defaultComplete(deps.config), {
    systemPrompt: prompt.systemPrompt,
    userText: prompt.userText,
    images: sendImages ? input.images.length : 0,
    names: input.redactionNames ?? [],
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
  const outcome = await callWithTimeout(complete, spec, context, timeoutMs, deps.signal);
  if (!outcome.ok) return unknownClassification(outcome.error);

  const message = outcome.message;
  const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
  const u = message.usage;
  reportUsage(deps, {
    path: 'completion',
    model: spec,
    failed,
    input: tokens(u.input),
    output: tokens(u.output),
    cacheRead: tokens(u.cacheRead),
    cacheWrite: tokens(u.cacheWrite),
    ...(u.cacheWrite1h === undefined ? {} : { cacheWrite1h: tokens(u.cacheWrite1h) }),
  });
  if (failed) {
    return unknownClassification(`provider error: ${message.errorMessage ?? message.stopReason}`);
  }
  return parseClassification(textOf(message), sendImages);
}

// ---------------------------------------------------------------- decision path

async function classifyByDecision(
  stateInput: DecisionStateInput,
  deps: ClassifyDeps,
  spec: string,
  categories: readonly CategoryEntry[],
  timeoutMs: number,
  trace: Pick<ClassifyInput, 'runId' | 'redactionNames'>,
): Promise<Classification> {
  const { state } = buildDecisionState(stateInput);
  const questions = classifierQuestions(categories, deps.config.entities);
  const call: DecisionCall = { sent: false, usage: undefined };
  try {
    const decider = deps.decisions ?? decisionProviderFor(spec, deps.config);
    const result = await decide(
      watched(decider, call),
      { state, questions },
      {
        timeoutMs,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        trace: {
          purpose: 'classify',
          names: trace.redactionNames ?? [],
          ...(trace.runId === undefined ? {} : { runId: trace.runId }),
        },
      },
    );
    reportUsage(deps, decisionUsage(spec, false, result.usage));
    const outcome = classificationFromAnswers(result.answers);
    return outcome.ok ? outcome.classification : unknownClassification(outcome.error);
  } catch (err) {
    // call.usage is read now: a result that lands after a timeout is not counted.
    if (call.sent) reportUsage(deps, decisionUsage(spec, true, call.usage));
    return unknownClassification(decisionFailure(err));
  }
}

type DecisionCall = { sent: boolean; usage: DecisionUsage | undefined };

// decide() drops the result when its answers fail the checks, and throws
// before asking the provider when the questions are bad or the signal is
// already aborted. Wrapping the provider tells the two apart and keeps the
// usage of a result decide() refused.
function watched(inner: DecisionProvider, call: DecisionCall): DecisionProvider {
  return {
    id: inner.id,
    model: inner.model,
    async decide(request, options) {
      call.sent = true;
      const result = await inner.decide(request, options);
      call.usage = result.usage;
      return result;
    },
  };
}

function decisionUsage(spec: string, failed: boolean, usage: DecisionUsage | undefined): ClassifierUsage {
  const cost = usage?.costUsd;
  return {
    path: 'decision',
    model: spec,
    failed,
    input: tokens(usage?.inputTokens),
    output: tokens(usage?.outputTokens),
    cacheRead: 0,
    cacheWrite: 0,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { reportedUsd: cost } : {}),
  };
}

// A token count as a non-negative integer; anything else a provider sends counts as 0.
function tokens(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function reportUsage(deps: ClassifyDeps, u: ClassifierUsage): void {
  if (deps.onUsage === undefined) return;
  try {
    deps.onUsage(u);
  } catch {
    // Usage is bookkeeping; it must not change the classification.
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
    return unknownClassification(`schema-invalid output at ${issuePaths(result.issues)}`);
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

// ---------------------------------------------------------------- tracing

type CompletionTrace = {
  readonly systemPrompt: string;
  readonly userText: string;
  readonly images: number;
  /** The ingress names, masked in the span in 'redacted' content mode. */
  readonly names: readonly string[];
  readonly runId?: RunId;
};

/** Thrown inside the traced call for a message that failed, so its span is an error; traced() turns it back. */
class CompletionStopped extends Error {
  override readonly name = 'CompletionStopped';
  readonly assistant: AssistantMessage;
  constructor(assistant: AssistantMessage) {
    // The stop reason only: errorMessage is provider text and could echo the prompt.
    super(`stop reason ${assistant.stopReason}`);
    this.assistant = assistant;
  }
}

// Wraps one completion in a trace span. The message or error the inner
// function gives is what the caller gets, with tracing on or off.
function traced(complete: CompleteFn, trace: CompletionTrace): CompleteFn {
  return async (spec, context, options) => {
    try {
      return await traceModelCall(
        'decision',
        {
          model: spec,
          input: { system: trace.systemPrompt, user: trace.userText },
          metadata: { purpose: 'classify', path: 'completion', images: trace.images },
          names: trace.names,
          ...(trace.runId === undefined ? {} : { runId: trace.runId }),
        },
        async () => {
          const message = await complete(spec, context, options);
          if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new CompletionStopped(message);
          return message;
        },
        (message) => completionRecord(spec, message),
      );
    } catch (err) {
      if (err instanceof CompletionStopped) return err.assistant;
      throw err;
    }
  };
}

function completionRecord(spec: string, message: AssistantMessage): ModelCallRecord {
  const u = message.usage;
  const counts = {
    input: tokens(u.input),
    output: tokens(u.output),
    cacheRead: tokens(u.cacheRead),
    cacheWrite: tokens(u.cacheWrite),
    ...(u.cacheWrite1h === undefined ? {} : { cacheWrite1h: tokens(u.cacheWrite1h) }),
  };
  let costUsd: number | null = null;
  try {
    costUsd = priceUsage(spec, counts);
  } catch {
    // An unpriceable record leaves the cost off the span.
  }
  return {
    output: textOf(message),
    usage: { input: counts.input, output: counts.output, cacheRead: counts.cacheRead, cacheWrite: counts.cacheWrite },
    costUsd,
    responseModel: message.responseModel ?? message.model,
  };
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
    if (parsed === undefined) throw new Error('MODEL_DECISION is not a provider/model spec');
    const served = servedProvider(parsed.provider, parsed.modelId, config);
    if (served === undefined) {
      throw new Error(`no default completion for provider ${parsed.provider}; pass deps.complete`);
    }
    const models = createModels();
    models.setProvider(served.provider);
    const model = models.getModel(parsed.provider, parsed.modelId);
    if (model === undefined) throw new Error(`provider ${parsed.provider} does not list model ${parsed.modelId}`);
    const { apiKey } = served;
    return models.complete(model, context, apiKey === undefined ? { signal } : { signal, apiKey });
  };
}

// The pi-ai provider for a served provider id, with its API key from config.
function servedProvider(
  id: string,
  modelId: string,
  config: Config,
): { provider: Provider; apiKey: string | undefined } | undefined {
  const p = config.providers;
  switch (id) {
    case 'anthropic':
      return { provider: anthropicProvider(), apiKey: p.anthropicApiKey };
    case 'openai':
      return { provider: openaiProvider(), apiKey: p.openaiApiKey };
    case 'openrouter':
      return { provider: openrouterProvider(), apiKey: p.openrouterApiKey };
    case 'ollama':
      return p.ollamaBaseUrl === undefined ? undefined : { provider: ollamaProvider(p.ollamaBaseUrl, [modelId]), apiKey: undefined };
    default:
      return undefined;
  }
}
