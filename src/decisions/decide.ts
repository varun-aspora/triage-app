// decide(): the one entry point callers use to ask a decision model.
//
// It wraps a DecisionProvider with the parts every caller needs and no
// provider should repeat:
// - one overall time limit, on top of whatever per-attempt timeout and
//   retries the provider's own client has, plus the caller's signal;
// - a check that every question came back with an answer of its own kind,
//   a choice that is one of its options and numbers in range, so a caller can
//   trust the typed result;
// - one error type, DecisionError, whose message never carries request
//   content (state or questions), only a code, the provider and a status.
//
// The question builders (choice, yesNo, score) keep option keys as literal
// types, so result.answers.x.choice is typed to x's option keys.
import type {
  ChoiceQuestion,
  DecisionAnswer,
  DecisionContent,
  DecisionProvider,
  DecisionQuestion,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  ScoreQuestion,
  YesNoQuestion,
} from './types.ts';

export const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

export type DecisionErrorCode =
  /** The key is missing, wrong or not allowed to use the model. */
  | 'auth'
  /** The request was refused as malformed (bad question shape, unknown model). */
  | 'bad_request'
  | 'rate_limited'
  /** The provider or the network failed; worth retrying later. */
  | 'unavailable'
  | 'timeout'
  | 'aborted'
  /** The provider answered, but not in a shape that matches the questions. */
  | 'invalid_response'
  /** The provider cannot be built from config (unknown spec, no key). */
  | 'config'
  | 'provider';

export class DecisionError extends Error {
  override readonly name = 'DecisionError';
  readonly code: DecisionErrorCode;
  readonly provider: string;
  readonly status: number | undefined;
  /**
   * The provider's own error text, capped. Kept apart from message: it is
   * usually a schema error naming fields, but callers that store it should
   * still pass it through their redaction first.
   */
  readonly detail: string | undefined;

  constructor(code: DecisionErrorCode, provider: string, options: { status?: number; detail?: string; cause?: unknown } = {}) {
    const status = options.status === undefined ? '' : ` (HTTP ${options.status})`;
    super(`decision ${code} from ${provider}${status}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.provider = provider;
    this.status = options.status;
    this.detail = options.detail === undefined ? undefined : capDetail(options.detail);
  }
}

export const MAX_DETAIL_CHARS = 300;

function capDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}...` : flat;
}

// ---------------------------------------------------------------- builders

export function choice<const O extends string>(
  instructions: DecisionContent,
  options: { readonly [K in O]: DecisionContent },
): ChoiceQuestion<O> {
  return { kind: 'choice', instructions, options };
}

export function yesNo(instructions: DecisionContent, meaning?: { yes: DecisionContent; no: DecisionContent }): YesNoQuestion {
  return meaning === undefined ? { kind: 'yes_no', instructions } : { kind: 'yes_no', instructions, meaning };
}

export function score(instructions: DecisionContent, levels: ScoreQuestion['levels']): ScoreQuestion {
  return { kind: 'score', instructions, levels };
}

// ---------------------------------------------------------------- decide

export type DecideOptions = {
  /** Overall limit for the call, retries included. Default DEFAULT_DECISION_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export async function decide<const Q extends DecisionQuestions>(
  provider: DecisionProvider,
  request: DecisionRequest<Q>,
  options: DecideOptions = {},
): Promise<DecisionResult<Q>> {
  checkQuestions(provider.id, request.questions);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
  const result = await withLimit(provider, request, timeoutMs, options.signal);
  checkAnswers(provider.id, request.questions, result);
  return result as DecisionResult<Q>;
}

// Races the provider against the limit and the caller's signal, so a provider
// that ignores its signal still cannot hold the caller past the deadline.
async function withLimit(
  provider: DecisionProvider,
  request: DecisionRequest,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<DecisionResult> {
  if (outer?.aborted) throw new DecisionError('aborted', provider.id);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DecisionError('timeout', provider.id, { detail: `no answer within ${timeoutMs} ms` }));
    }, timeoutMs);
    onAbort = () => {
      controller.abort();
      reject(new DecisionError('aborted', provider.id));
    };
    outer?.addEventListener('abort', onAbort, { once: true });
  });
  const call = provider.decide(request, { signal: controller.signal }).catch((err: unknown) => {
    throw err instanceof DecisionError ? err : new DecisionError('provider', provider.id, { detail: errorName(err), cause: err });
  });
  try {
    return await Promise.race([call, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) outer?.removeEventListener('abort', onAbort);
    // The losing branch must not surface as an unhandled rejection.
    call.catch(() => undefined);
    stopped.catch(() => undefined);
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

// ---------------------------------------------------------------- checks

function checkQuestions(provider: string, questions: DecisionQuestions): void {
  const bad = (detail: string): DecisionError => new DecisionError('bad_request', provider, { detail });
  const names = Object.keys(questions);
  if (names.length === 0) throw bad('no questions');
  for (const name of names) {
    const q = questions[name] as DecisionQuestion;
    if (q.kind === 'choice' && Object.keys(q.options).length < 2) throw bad(`question ${name}: a choice needs at least 2 options`);
    if (q.kind === 'score' && q.levels.length < 2) throw bad(`question ${name}: a score needs at least 2 levels`);
  }
}

function checkAnswers(provider: string, questions: DecisionQuestions, result: DecisionResult): void {
  const invalid = (detail: string): DecisionError => new DecisionError('invalid_response', provider, { detail });
  for (const [name, q] of Object.entries(questions)) {
    const a = (result.answers as Record<string, DecisionAnswer | undefined>)[name];
    if (a === undefined) throw invalid(`no answer for ${name}`);
    if (a.kind !== q.kind) throw invalid(`answer for ${name} is ${a.kind}, asked ${q.kind}`);
    if (a.kind === 'choice' && q.kind === 'choice') {
      if (!Object.hasOwn(q.options, a.choice)) throw invalid(`answer for ${name} is not one of its options`);
    } else if (a.kind === 'yes_no') {
      if (!isUnit(a.yes)) throw invalid(`answer for ${name} is out of range`);
    } else if (a.kind === 'score' && q.kind === 'score') {
      if (!inRange(a.score, q.levels.length - 1)) throw invalid(`score for ${name} is out of range`);
    }
    if (a.kind !== 'yes_no' && a.confidence !== undefined && !isUnit(a.confidence)) throw invalid(`confidence for ${name} is out of range`);
  }
}

function inRange(n: number, max: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= max;
}

function isUnit(n: number): boolean {
  return inRange(n, 1);
}
