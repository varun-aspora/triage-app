import { describe, expect, test } from 'bun:test';

import { DecisionError } from './decide.ts';
import { decisionProviderFor, decisionRoute, isDecisionSpec } from './registry.ts';

describe('decisionRoute', () => {
  test('direct and OpenRouter specs', () => {
    expect(decisionRoute('typesafe/jev-1.13')).toEqual({ provider: 'typesafe', model: 'jev-1.13', keyName: 'TYPESAFE_API_KEY' });
    expect(decisionRoute('openrouter/typesafe/jev-1.13')).toEqual({
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
      keyName: 'OPENROUTER_API_KEY',
    });
    expect(decisionRoute('openrouter/~typesafe/jev-latest')?.model).toBe('~typesafe/jev-latest');
  });

  test('chat model specs are not decision specs', () => {
    for (const spec of ['openai/gpt-6-sol', 'openrouter/openai/gpt-5', 'ollama/qwen3:8b', 'typesafe', 'typesafe/a/b']) {
      expect(isDecisionSpec(spec)).toBe(false);
    }
  });
});

describe('decisionProviderFor', () => {
  const keys = { providers: { openrouterApiKey: 'fake-or-key', typesafeApiKey: 'fake-ts-key' } };

  test('builds a provider named after its route', () => {
    expect(decisionProviderFor('openrouter/typesafe/jev-1.13', keys)).toMatchObject({ id: 'openrouter', model: 'typesafe/jev-1.13' });
    expect(decisionProviderFor('typesafe/jev-1.13', keys)).toMatchObject({ id: 'typesafe', model: 'jev-1.13' });
  });

  test('a missing key is a config error naming the key, not its value', () => {
    let err: unknown;
    try {
      decisionProviderFor('typesafe/jev-1.13', { providers: { openrouterApiKey: 'fake-or-key' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecisionError);
    expect((err as DecisionError).code).toBe('config');
    expect((err as DecisionError).detail).toBe('TYPESAFE_API_KEY is not set');
  });

  test('an unknown spec is a config error', () => {
    expect(() => decisionProviderFor('openai/gpt-6-sol', keys)).toThrow(DecisionError);
  });
});
