import { describe, expect, test } from 'bun:test';
import { calculateCost, type Api, type Model, type Usage } from '@earendil-works/pi-ai';

import { lookupModel } from '../models.ts';
import { createFakeModel } from '../mock/fake-model.ts';
import { CostError, EMBEDDING_PRICES, priceUsage, usageCostUsd, type CostModel, type UsageTokens } from './price.ts';
import * as cost from '../evals/cost.ts';

const USAGE = { input: 12_000, output: 3_000, cacheRead: 40_000, cacheWrite: 2_000 };

// Rates are read from the catalog, not hard-coded, so a pi-ai upgrade that
// changes a price does not break the test.
function catalogModel(spec: string): CostModel {
  const found = lookupModel(spec) as unknown as CostModel | undefined;
  if (found === undefined) throw new Error(`${spec} is not in the pi-ai catalog`);
  return found;
}

function expected(model: CostModel, u: UsageTokens): number {
  const usage: Usage = {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (u.cacheWrite1h !== undefined) usage.cacheWrite1h = u.cacheWrite1h;
  return calculateCost(model as Model<Api>, usage).total;
}

describe('priceUsage', () => {
  test('input, output and cache rates come from the catalog', () => {
    const spec = 'anthropic/claude-haiku-4-5';
    const m = catalogModel(spec);
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) expect(m.cost[f]).toBeGreaterThan(0);
    const usd = priceUsage(spec, USAGE, 'agent');
    expect(usd).toBeCloseTo(expected(m, USAGE), 12);
    const byHand =
      (USAGE.input * m.cost.input +
        USAGE.output * m.cost.output +
        USAGE.cacheRead * m.cost.cacheRead +
        USAGE.cacheWrite * m.cost.cacheWrite) /
      1e6;
    expect(usd).toBeCloseTo(byHand, 12);
  });

  test('a tiered model uses the tier above its input threshold', () => {
    const spec = 'openai/gpt-5.4';
    const m = catalogModel(spec);
    const tier = m.cost.tiers?.[0];
    expect(tier).toBeDefined();
    const big = { input: tier!.inputTokensAbove + 1, output: 1_000, cacheRead: 0, cacheWrite: 0 };
    const usd = priceUsage(spec, big);
    expect(usd).toBeCloseTo(expected(m, big), 12);
    const baseRate = (big.input * m.cost.input + big.output * m.cost.output) / 1e6;
    expect(usd!).toBeGreaterThan(baseRate);
  });

  test('a spec with no known rates returns null', () => {
    for (const spec of ['anthropic/not-a-model', 'nowhere/model', 'typesafe/jev-1.13', 'openrouter/typesafe/jev-1.13', 'bad']) {
      expect(priceUsage(spec, USAGE)).toBeNull();
    }
  });

  test('NaN or negative counts throw, even for an unpriced model', () => {
    for (const spec of ['anthropic/claude-haiku-4-5', 'nowhere/model', 'faux/cheap']) {
      for (const bad of [
        { ...USAGE, input: -1 },
        { ...USAGE, output: Number.NaN },
        { ...USAGE, cacheRead: Number.POSITIVE_INFINITY },
        { ...USAGE, cacheWrite: '10' as unknown as number },
        { ...USAGE, cacheWrite1h: -5 },
      ]) {
        expect(() => priceUsage(spec, bad)).toThrow(CostError);
      }
    }
  });

  test('faux and Ollama specs price at 0 and count as priced', () => {
    // Unregistered: the price does not depend on the provider being set up.
    expect(priceUsage('faux/cheap', USAGE)).toBe(0);
    expect(priceUsage('ollama/qwen3:8b', USAGE)).toBe(0);
    expect(priceUsage('ollama/nomic-embed-text', USAGE, 'embed')).toBe(0);
    createFakeModel().install();
    expect(priceUsage('faux/cheap', USAGE)).toBe(0);
    expect(priceUsage('faux/strong', USAGE, 'compaction')).toBe(0);
  });

  test('cacheWrite1h is priced at the 1-hour rate when present', () => {
    const spec = 'anthropic/claude-haiku-4-5';
    const m = catalogModel(spec);
    const long = { ...USAGE, cacheWrite1h: 1_500 };
    const usd = priceUsage(spec, long);
    expect(usd).toBeCloseTo(expected(m, long), 12);
    // pi-ai charges 1-hour writes at 2x input, which differs from the 5-minute rate.
    expect(usd).not.toBeCloseTo(priceUsage(spec, USAGE)!, 12);
  });

  test('embedding models use EMBEDDING_PRICES for purpose embed only', () => {
    const spec = 'openai/text-embedding-3-small';
    expect(lookupModel(spec)).toBeUndefined();
    const tokens = { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(priceUsage(spec, tokens, 'embed')).toBeCloseTo((250_000 * EMBEDDING_PRICES[spec]!) / 1e6, 12);
    expect(priceUsage(spec, tokens, 'agent')).toBeNull();
    expect(priceUsage('openai/text-embedding-9', tokens, 'embed')).toBeNull();
    expect(priceUsage('hash/bow-512', tokens, 'embed')).toBe(0);
  });
});

describe('src/evals/cost.ts re-exports', () => {
  test('the moved exports are the same values', () => {
    expect(cost.usageCostUsd).toBe(usageCostUsd);
    expect(cost.CostError).toBe(CostError);
    expect(typeof cost.CostMeter).toBe('function');
    expect(typeof cost.parseCapUsd).toBe('function');
  });
});
