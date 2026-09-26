// MODEL_EMBEDDING parsing and the bits both embedding clients share.
//
// MODEL_EMBEDDING=<provider>/<model>, like the other MODEL_* keys (D43).
// Only ollama and openai are accepted: OpenRouter is approved for the
// classifier only (D41), and Anthropic has no embeddings endpoint.
// Errors name the key, never the value.

import { ConfigError } from '../config/errors.ts';

export const EMBEDDING_KEY = 'MODEL_EMBEDDING';

export const EMBEDDING_PROVIDERS = ['ollama', 'openai'] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export type EmbeddingSpec = { readonly provider: EmbeddingProvider; readonly model: string };

/** Parses MODEL_EMBEDDING. A blank or missing value means embeddings are off (null). */
export function parseEmbeddingSpec(value: string | undefined): EmbeddingSpec | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw ConfigError.of(EMBEDDING_KEY, 'must be <provider>/<model>');
  }
  const provider = trimmed.slice(0, slash).toLowerCase();
  const model = trimmed.slice(slash + 1);
  if (provider === 'openrouter') {
    throw ConfigError.of(EMBEDDING_KEY, 'must not use openrouter (approved for the classifier only)');
  }
  if (!isProvider(provider)) {
    throw ConfigError.of(EMBEDDING_KEY, 'provider must be ollama or openai');
  }
  return Object.freeze({ provider, model });
}

function isProvider(value: string): value is EmbeddingProvider {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------ shared client bits

/** The slice of fetch the clients use. Always injected; nothing here calls the global fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What one embed() call used, for the run meter (D59). */
export type EmbedUsage = {
  /** The MODEL_EMBEDDING spec, '<provider>/<model>'. Mock mode reports the spec too, not HASH_MODEL. */
  readonly model: string;
  /** Input tokens the provider reported. 0 when it reported none, and always 0 in mock mode. */
  readonly inputTokens: number;
  /** true when the call threw. The error is rethrown after onUsage runs. */
  readonly failed: boolean;
  /** Set when a successful response carried no token count, so inputTokens is 0 by default. */
  readonly usageMissing?: true;
};

export type ClientOptions = {
  readonly signal?: AbortSignal;
  /**
   * Told once per embed() call with at least one text, after the call settles.
   * A throwing callback is ignored: metering must not fail an embedding.
   */
  readonly onUsage?: (u: EmbedUsage) => void;
};

/** A client's answer: the vectors, and the input tokens the provider reported (null when it reported none). */
export type EmbedResult = { readonly vectors: number[][]; readonly inputTokens: number | null };

/** A provider client over plain strings. index.ts is the only caller and unwraps Persisted first. */
export type EmbedClient = (texts: readonly string[], opts?: { readonly signal?: AbortSignal }) => Promise<EmbedResult>;

/** A provider's token count when it is a non-negative integer, else null. */
export function reportedTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type EmbeddingErrorReason = 'status' | 'timeout' | 'network' | 'malformed';

/**
 * A failed embedding call. The message carries the provider, a fixed reason and
 * the HTTP status only: never the URL, the response body or a key.
 */
export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError';
  readonly provider: EmbeddingProvider;
  readonly reason: EmbeddingErrorReason;
  readonly status?: number;

  constructor(provider: EmbeddingProvider, reason: EmbeddingErrorReason, status?: number) {
    super(`${provider} embeddings request failed: ${status === undefined ? reason : `status ${status}`}`);
    this.provider = provider;
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

export type PostJsonRequest = {
  readonly provider: EmbeddingProvider;
  readonly fetch: FetchLike;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

/**
 * POSTs JSON and returns the parsed response body. A caller abort rethrows the
 * signal's reason; the timeout and every other failure become EmbeddingError.
 */
export async function postJson(req: PostJsonRequest): Promise<unknown> {
  req.signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const fail = (reason: EmbeddingErrorReason, status?: number): never => {
    req.signal?.throwIfAborted();
    if (timeout.aborted) throw new EmbeddingError(req.provider, 'timeout');
    throw new EmbeddingError(req.provider, reason, status);
  };

  let res: Response;
  try {
    res = await req.fetch(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...req.headers },
      body: JSON.stringify(req.body),
      signal,
    });
  } catch {
    return fail('network');
  }
  if (!res.ok) {
    // Drop the body unread: it can echo request details.
    await res.body?.cancel().catch(() => undefined);
    return fail('status', res.status);
  }
  try {
    return await res.json();
  } catch {
    return fail('malformed');
  }
}

/** True when value is an array of finite numbers with at least one entry. */
export function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}
