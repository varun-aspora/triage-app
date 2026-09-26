// OpenAI embeddings: POST https://api.openai.com/v1/embeddings with
// { model, input[] } and a bearer key, answered with
// { data: [{ index, embedding }], usage: { prompt_tokens } }. The fetch is
// injected and the key only ever goes into the Authorization header.

import { EmbeddingError, isVector, postJson, reportedTokens, type EmbedClient, type FetchLike } from './spec.ts';

export const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

export type OpenAiClientConfig = {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
};

export function createOpenAiClient(cfg: OpenAiClientConfig): EmbedClient {
  return async (texts, opts = {}) => {
    if (texts.length === 0) return { vectors: [], inputTokens: 0 };
    const body = await postJson({
      provider: 'openai',
      fetch: cfg.fetch,
      url: OPENAI_EMBEDDINGS_URL,
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: { model: cfg.model, input: [...texts] },
      timeoutMs: cfg.timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { vectors: parseOpenAiResponse(body, texts.length), inputTokens: openAiInputTokens(body) };
  };
}

/** usage.prompt_tokens from the response body; null when it is missing or not a count. */
export function openAiInputTokens(body: unknown): number | null {
  const usage = (body as { usage?: unknown } | null)?.usage;
  return reportedTokens((usage as { prompt_tokens?: unknown } | null | undefined)?.prompt_tokens);
}

type Item = { index: number; embedding: number[] };

export function parseOpenAiResponse(body: unknown, expected: number): number[][] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) throw new EmbeddingError('openai', 'malformed');
  const out = new Array<number[] | undefined>(expected);
  for (const raw of data) {
    const item = raw as Partial<Item> | null;
    const index = item?.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= expected) {
      throw new EmbeddingError('openai', 'malformed');
    }
    if (out[index] !== undefined || !isVector(item?.embedding)) throw new EmbeddingError('openai', 'malformed');
    out[index] = item.embedding;
  }
  const vectors = out as number[][];
  const dims = vectors[0]!.length;
  if (!vectors.every((v) => v.length === dims)) throw new EmbeddingError('openai', 'malformed');
  return vectors;
}
