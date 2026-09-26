// createEmbedder: the one way to get an embedder from config (D43).
//
// - Blank MODEL_EMBEDDING: embeddings are off and this returns null.
// - The spec is always parsed first, so a refused provider fails in every mode.
// - forbidRemote (set by the eval driver) refuses openai/*; ollama/* is local.
// - TRIAGE_MOCK_MODE=true: the hash embedder, whatever the provider. The
//   injected fetch is never touched.
// - embed() takes Persisted<string> only, so nothing but persisted-profile
//   text can be embedded.
// - opts.onUsage hears once per call what it used (D59): the MODEL_EMBEDDING
//   spec, the provider's input tokens and whether it failed.

import { ConfigError } from '../config/errors.ts';
import type { Config } from '../config/env.ts';
import { isPersisted, type Persisted } from '../gate/redact.ts';
import { HASH_MODEL, createHashClient } from './hash.ts';
import { createOllamaClient } from './ollama.ts';
import { createOpenAiClient } from './openai.ts';
import {
  EMBEDDING_KEY,
  parseEmbeddingSpec,
  type ClientOptions,
  type EmbedClient,
  type EmbedResult,
  type EmbedUsage,
  type FetchLike,
} from './spec.ts';

export {
  EmbeddingError,
  parseEmbeddingSpec,
  type ClientOptions,
  type EmbedUsage,
  type EmbeddingSpec,
  type FetchLike,
} from './spec.ts';
export { HASH_MODEL, cosine } from './hash.ts';

export type EmbedConfig = {
  readonly mock: Pick<Config['mock'], 'enabled'>;
  readonly models: Pick<Config['models'], 'embedding'>;
  readonly providers: Pick<Config['providers'], 'openaiApiKey' | 'ollamaBaseUrl'>;
  readonly budgets: Pick<Config['budgets'], 'httpTimeoutMs'>;
};

export type EmbedderOptions = {
  /** Used for ollama and openai calls only. Never called in mock mode. */
  readonly fetch: FetchLike;
  /** true refuses remote embedders (openai). The eval driver sets it. */
  readonly forbidRemote?: boolean;
  /** Per-request timeout; defaults to TRIAGE_HTTP_TIMEOUT_MS. */
  readonly timeoutMs?: number;
};

export type Embedder = {
  /** The vector space id: '<provider>/<model>', or HASH_MODEL in mock mode. */
  readonly model: string;
  embed(texts: readonly Persisted<string>[], opts?: ClientOptions): Promise<number[][]>;
};

export function createEmbedder(config: EmbedConfig, options: EmbedderOptions): Embedder | null {
  const spec = parseEmbeddingSpec(config.models.embedding);
  if (spec === null) return null;
  if (options.forbidRemote === true && spec.provider === 'openai') {
    throw ConfigError.of(EMBEDDING_KEY, 'must be a local provider (ollama) here; remote embedders are refused');
  }
  const model = `${spec.provider}/${spec.model}`;
  if (config.mock.enabled) return wrap(HASH_MODEL, model, createHashClient());

  const timeoutMs = options.timeoutMs ?? config.budgets.httpTimeoutMs;
  if (spec.provider === 'ollama') {
    const baseUrl = config.providers.ollamaBaseUrl?.trim();
    if (!baseUrl) throw ConfigError.of('OLLAMA_BASE_URL', `is required when ${EMBEDDING_KEY} uses ollama`);
    return wrap(model, model, createOllamaClient({ baseUrl, model: spec.model, fetch: options.fetch, timeoutMs }));
  }
  const apiKey = config.providers.openaiApiKey?.trim();
  if (!apiKey) throw ConfigError.of('OPENAI_API_KEY', `is required when ${EMBEDDING_KEY} uses openai`);
  return wrap(model, model, createOpenAiClient({ apiKey, model: spec.model, fetch: options.fetch, timeoutMs }));
}

/** usageModel is the MODEL_EMBEDDING spec; it differs from model in mock mode only. */
function wrap(model: string, usageModel: string, client: EmbedClient): Embedder {
  return Object.freeze({
    model,
    embed: async (texts: readonly Persisted<string>[], opts: ClientOptions = {}) => {
      // The type already refuses plain strings; this catches untyped callers.
      if (!texts.every((t) => isPersisted(t) && typeof t.value === 'string')) {
        throw new TypeError('embed() takes Persisted<string> values from redactPersisted only');
      }
      // An empty call makes no request, so it is not reported.
      const report = (u: Omit<EmbedUsage, 'model'>): void => {
        if (texts.length === 0 || !opts.onUsage) return;
        try {
          opts.onUsage({ model: usageModel, ...u });
        } catch {
          // A broken sink must not fail the embedding.
        }
      };
      let result: EmbedResult;
      try {
        result = await client(
          texts.map((t) => t.value),
          opts.signal ? { signal: opts.signal } : {},
        );
      } catch (err) {
        report({ inputTokens: 0, failed: true });
        throw err;
      }
      report(
        result.inputTokens === null
          ? { inputTokens: 0, failed: false, usageMissing: true }
          : { inputTokens: result.inputTokens, failed: false },
      );
      return result.vectors;
    },
  });
}
