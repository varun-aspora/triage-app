// A fake Embedder for tests: records each call's texts, then returns one
// vector per text (`answer` itself, or `answer` floats when it is a number),
// or throws `answer` when it is an Error.

import type { Embedder } from '../../src/embed/index.ts';

export type FakeEmbedder = Embedder & { readonly calls: string[][] };

export function fakeEmbedder(answer: number | readonly number[] | Error, model = 'ollama/fake-embed'): FakeEmbedder {
  const calls: string[][] = [];
  return {
    model,
    calls,
    embed: async (texts) => {
      calls.push(texts.map((t) => t.value));
      if (answer instanceof Error) throw answer;
      const vector = typeof answer === 'number' ? Array.from({ length: answer }, (_, i) => i / answer) : [...answer];
      return texts.map(() => vector);
    },
  };
}
