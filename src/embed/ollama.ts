// Ollama embeddings: POST {OLLAMA_BASE_URL}/api/embed with { model, input[] },
// answered with { embeddings: number[][], prompt_eval_count }. The fetch is
// injected.

import { EmbeddingError, isVector, postJson, reportedTokens, type EmbedClient, type FetchLike } from './spec.ts';

export type OllamaClientConfig = {
  readonly baseUrl: string;
  readonly model: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
};

/**
 * The embed endpoint lives on Ollama's native API at the server root.
 * OLLAMA_BASE_URL is often written with the OpenAI-compatible /v1 suffix
 * (the chat models use it), so that suffix is dropped here.
 */
export function ollamaEmbedUrl(baseUrl: string): string {
  const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${root}/api/embed`;
}

export function createOllamaClient(cfg: OllamaClientConfig): EmbedClient {
  const url = ollamaEmbedUrl(cfg.baseUrl);
  return async (texts, opts = {}) => {
    if (texts.length === 0) return { vectors: [], inputTokens: 0 };
    const body = await postJson({
      provider: 'ollama',
      fetch: cfg.fetch,
      url,
      headers: {},
      body: { model: cfg.model, input: [...texts] },
      timeoutMs: cfg.timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { vectors: parseOllamaResponse(body, texts.length), inputTokens: ollamaInputTokens(body) };
  };
}

/** prompt_eval_count from the response body; null when it is missing or not a count. */
export function ollamaInputTokens(body: unknown): number | null {
  return reportedTokens((body as { prompt_eval_count?: unknown } | null)?.prompt_eval_count);
}

export function parseOllamaResponse(body: unknown, expected: number): number[][] {
  const embeddings = (body as { embeddings?: unknown } | null)?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== expected || !embeddings.every(isVector)) {
    throw new EmbeddingError('ollama', 'malformed');
  }
  const dims = embeddings[0]!.length;
  if (!embeddings.every((e) => e.length === dims)) throw new EmbeddingError('ollama', 'malformed');
  return embeddings;
}
