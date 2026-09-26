import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { UsageRowSchema, type UsageRow } from './usage.ts';

const row: UsageRow = {
  model: 'anthropic/claude-haiku-4-5-20251001',
  agent: 'triage',
  purpose: 'agent',
  calls: 1,
  failed_calls: 0,
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  usd: 0.01,
};

describe('UsageRowSchema usd', () => {
  test('takes a finite price, $0 and null', () => {
    for (const usd of [0.01, 0, null]) expect(v.is(UsageRowSchema, { ...row, usd })).toBe(true);
  });

  test('refuses Infinity, NaN and a negative price', () => {
    for (const usd of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -0.01]) {
      expect(v.is(UsageRowSchema, { ...row, usd })).toBe(false);
    }
  });
});
