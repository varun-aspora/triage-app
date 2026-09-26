// TypeSafe System One decision models (jev) through @typesafe-ai/sdk.
//
// Two routes, one adapter: the SDK POSTs <baseURL>/v1/systemone, so
// - direct:     baseURL https://api.typesafe.ai, TYPESAFE_API_KEY, model 'jev-1.13';
// - openrouter: baseURL https://openrouter.ai/api, OPENROUTER_API_KEY, model 'typesafe/jev-1.13'.
// Both take the same body and return the same answers.
//
// The client is built with every setting passed in code, so the SDK's own
// TYPESAFE_* environment fallbacks never apply, and with logging off: at
// debug level the SDK logs request bodies, which would carry thread text.
// The SDK retries 408, 429 and 5xx with backoff; the overall limit is
// decide()'s, which aborts the signal passed here.
//
// Question and answer shapes are mapped both ways here, and the response is
// validated before it is mapped: fields OpenRouter marks optional
// (probabilities, confidence, usage.cost) stay optional.
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type Fetch,
  type Question,
  type Questions,
} from '@typesafe-ai/sdk';
import * as v from 'valibot';

import { DecisionError, type DecisionErrorCode } from '../decide.ts';
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResult } from '../types.ts';

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/** Per attempt; the SDK's own default is 10 s. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 2;

export type TypeSafeProviderOptions = {
  /** 'typesafe' for direct calls, 'openrouter' when routed through OpenRouter. */
  readonly id: 'typesafe' | 'openrouter';
  readonly apiKey: string;
  /** Model id as the route names it: 'jev-1.13' direct, 'typesafe/jev-1.13' on OpenRouter. */
  readonly model: string;
  /** Default: TYPESAFE_BASE_URL or OPENROUTER_BASE_URL by id. */
  readonly baseURL?: string;
  readonly attemptTimeoutMs?: number;
  readonly maxRetries?: number;
  /** Tests pass a fake; default is the global fetch. */
  readonly fetch?: Fetch;
};

export function typesafeProvider(options: TypeSafeProviderOptions): DecisionProvider {
  if (options.apiKey.trim() === '') throw new DecisionError('config', options.id, { detail: 'no API key' });
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? (options.id === 'openrouter' ? OPENROUTER_BASE_URL : TYPESAFE_BASE_URL),
    defaultModel: options.model,
    logLevel: 'off',
    timeout: options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    retry: { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    id: options.id,
    model: options.model,
    async decide(request: DecisionRequest, { signal }): Promise<DecisionResult> {
      let raw: unknown;
      try {
        raw = await client.systemOne(
          // DecisionContent is readonly JSON; the SDK's EntryType is the same JSON, mutable.
          { model: options.model, state: request.state as never, questions: toQuestions(request) },
          { signal },
        );
      } catch (err) {
        throw toDecisionError(options.id, err);
      }
      return fromResult(options.id, request, raw);
    },
  };
}

// ---------------------------------------------------------------- request

function toQuestions(request: DecisionRequest): Questions {
  return Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, toQuestion(q)]));
}

function toQuestion(q: DecisionQuestion): Question {
  switch (q.kind) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions as never, criteria: q.options as never };
    case 'yes_no':
      return {
        type: 'noul',
        instructions: q.instructions as never,
        ...(q.meaning === undefined ? {} : { criteria: { true: q.meaning.yes as never, false: q.meaning.no as never } }),
      };
    case 'score':
      return { type: 'score', instructions: q.instructions as never, criteria: q.levels as never };
  }
}

// ---------------------------------------------------------------- response

const Unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const Probabilities = v.record(v.string(), v.number());

const AnswerSchema = v.variant('type', [
  v.object({ type: v.literal('choice'), choice: v.string(), probabilities: v.optional(Probabilities), confidence: v.optional(Unit) }),
  v.object({ type: v.literal('noul'), noul: Unit }),
  v.object({ type: v.literal('score'), score: v.number(), probabilities: v.optional(Probabilities), confidence: v.optional(Unit) }),
]);

const ResultSchema = v.object({
  model: v.string(),
  answers: v.record(v.string(), AnswerSchema),
  usage: v.optional(
    v.object({ input_tokens: v.optional(v.number()), output_tokens: v.optional(v.number()), cost: v.optional(v.number()) }),
  ),
});

function fromResult(provider: string, request: DecisionRequest, raw: unknown): DecisionResult {
  const parsed = v.safeParse(ResultSchema, raw);
  if (!parsed.success) {
    // Paths only: an answer never quotes the state, but keep errors content-free anyway.
    const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
    throw new DecisionError('invalid_response', provider, { detail: `unexpected shape at ${paths.join(', ')}` });
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [name, a] of Object.entries(parsed.output.answers)) {
    // Answers the request did not ask for are dropped.
    const q = request.questions[name];
    if (q === undefined) continue;
    answers[name] = fromAnswer(a, q);
  }
  const usage = parsed.output.usage;
  return {
    answers,
    model: parsed.output.model,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      ...(usage?.cost === undefined ? {} : { costUsd: usage.cost }),
    },
  } as DecisionResult;
}

function fromAnswer(a: v.InferOutput<typeof AnswerSchema>, q: DecisionQuestion): DecisionAnswer {
  switch (a.type) {
    case 'choice':
      return {
        kind: 'choice',
        choice: a.choice,
        ...(a.probabilities === undefined ? {} : { probabilities: a.probabilities }),
        ...(a.confidence === undefined ? {} : { confidence: a.confidence }),
      };
    case 'noul':
      return { kind: 'yes_no', yes: a.noul };
    case 'score': {
      const levels = q.kind === 'score' ? q.levels.length : 0;
      const probabilities = a.probabilities === undefined ? undefined : levelArray(a.probabilities, levels);
      return {
        kind: 'score',
        score: a.score,
        ...(probabilities === undefined ? {} : { probabilities }),
        ...(a.confidence === undefined ? {} : { confidence: a.confidence }),
      };
    }
  }
}

// { "0": p0, "1": p1, ... } -> [p0, p1, ...]; a missing level reads as 0.
function levelArray(byLevel: Record<string, number>, levels: number): number[] {
  return Array.from({ length: levels }, (_, i) => byLevel[String(i)] ?? 0);
}

// ---------------------------------------------------------------- errors

function toDecisionError(provider: string, err: unknown): DecisionError {
  if (err instanceof DecisionError) return err;
  // Order matters: APITimeoutError extends APIConnectionError.
  if (err instanceof APIUserAbortError) return new DecisionError('aborted', provider, { cause: err });
  if (err instanceof APITimeoutError) return new DecisionError('timeout', provider, { cause: err, detail: 'attempt timed out' });
  if (err instanceof APIConnectionError) return new DecisionError('unavailable', provider, { cause: err, detail: 'connection failed' });
  if (err instanceof APIError) {
    return new DecisionError(apiErrorCode(err), provider, { cause: err, status: err.status, detail: bodyMessage(err.body) });
  }
  // An aborted signal can also surface as a plain AbortError from fetch.
  if (err instanceof Error && err.name === 'AbortError') return new DecisionError('aborted', provider, { cause: err });
  return new DecisionError('provider', provider, { cause: err, detail: err instanceof Error ? err.name : typeof err });
}

function apiErrorCode(err: APIError): DecisionErrorCode {
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError || err.status === 402) return 'auth';
  if (err instanceof RateLimitError) return 'rate_limited';
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError || err instanceof NotFoundError || err.status === 413) {
    return 'bad_request';
  }
  if (err instanceof InternalServerError) return 'unavailable';
  return 'provider';
}

// OpenRouter: { error: { message } }. TypeSafe: { detail } or { message }.
function bodyMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return typeof body === 'string' ? body : undefined;
  const b = body as { error?: { message?: unknown }; message?: unknown; detail?: unknown };
  return [b.error?.message, b.message, b.detail].find((m): m is string => typeof m === 'string' && m.trim() !== '');
}
