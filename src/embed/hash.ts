// A deterministic hashing-trick embedder for mock mode: each lowercase word is
// hashed into one of a fixed number of buckets with a hash-derived sign, and
// the result is L2-normalised. It makes no call and gives lexical similarity
// that tests and evals can rely on (P2 3.5). It reports 0 input tokens.

import type { EmbedClient } from './spec.ts';

export const HASH_DIMS = 512;
export const HASH_MODEL = `hash/bow-${HASH_DIMS}`;

const WORD = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** FNV-1a, 32 bit. */
function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One text to one vector. Text with no words gives the zero vector. */
export function hashEmbed(text: string, dims = HASH_DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of tokenize(text)) {
    const bucket = fnv1a(word) % dims;
    const sign = fnv1a(word, 0x9747b28c) & 1 ? 1 : -1;
    v[bucket]! += sign;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function createHashClient(dims = HASH_DIMS): EmbedClient {
  return async (texts, opts = {}) => {
    opts.signal?.throwIfAborted();
    return { vectors: texts.map((t) => hashEmbed(t, dims)), inputTokens: 0 };
  };
}
