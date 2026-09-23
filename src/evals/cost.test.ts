import { describe, expect, test } from 'bun:test';
import { calculateCost, type Api, type Model, type Usage } from '@earendil-works/pi-ai';

import { createFakeModel } from '../mock/fake-model.ts';
import { CostError, CostMeter, parseCapUsd, usageCostUsd, type CostModel } from './cost.ts';

// A priced model defined here, so the test needs no catalog lookup. Rates are
// USD per million tokens, as pi-ai stores them.
const PRICED: CostModel = {
  provider: 'test-provider',
  id: 'priced-model',
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

const TIERED: CostModel = {
  provider: 'test-provider',
  id: 'tiered-model',
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 1000, input: 5, output: 10, cacheRead: 0.5, cacheWrite: 6 }] },
};

const USAGE = { input: 12_000, output: 3_000, cacheRead: 40_000, cacheWrite: 2_000 };

function piUsage(u: typeof USAGE): Usage {
  return {
    ...u,
    totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe('CostMeter', () => {
  test('faux model usage costs 0', () => {
    const fake = createFakeModel();
    const meter = new CostMeter();
    for (const id of ['classifier', 'cheap', 'mid', 'strong']) {
      const model = fake.faux.getModel(id);
      expect(model).toBeDefined();
      expect(meter.add(model as CostModel, USAGE)).toBe(0);
    }
    expect(meter.totalUsd()).toBe(0);
    expect(meter.overCap('0')).toBe(false);
  });

  test('a known model usage matches calculateCost', () => {
    const meter = new CostMeter();
    const expected = calculateCost(PRICED as Model<Api>, piUsage(USAGE)).total;
    expect(expected).toBeGreaterThan(0);
    expect(meter.add(PRICED, USAGE)).toBeCloseTo(expected, 12);
    expect(meter.totalUsd()).toBeCloseTo(expected, 12);
    // Hand check: 12k*3 + 3k*15 + 40k*0.3 + 2k*3.75, per million.
    expect(expected).toBeCloseTo((36_000 + 45_000 + 12_000 + 7_500) / 1e6, 12);
  });

  test('pricing tiers from the metadata are used', () => {
    const expected = calculateCost(TIERED as Model<Api>, piUsage(USAGE)).total;
    expect(usageCostUsd(TIERED, USAGE)).toBeCloseTo(expected, 12);
  });

  test('a cost already on the usage record is ignored and not changed', () => {
    const usage = { ...piUsage(USAGE), cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99, total: 999 } };
    const usd = usageCostUsd(PRICED, usage);
    expect(usd).toBeCloseTo(calculateCost(PRICED as Model<Api>, piUsage(USAGE)).total, 12);
    expect(usage.cost.total).toBe(999);
  });

  test('sums across calls and reports spend per model', () => {
    const meter = new CostMeter();
    const one = meter.add(PRICED, USAGE);
    meter.add(PRICED, USAGE);
    meter.add(createFakeModel().faux.getModel('cheap') as CostModel, USAGE);
    expect(meter.totalUsd()).toBeCloseTo(one * 2, 12);
    expect(meter.byModel()).toEqual([
      { model: 'faux/cheap', calls: 1, usd: 0 },
      { model: 'test-provider/priced-model', calls: 2, usd: meter.totalUsd() },
    ]);
  });

  test('overCap is false when the cap is blank', () => {
    const meter = new CostMeter();
    meter.add(PRICED, USAGE);
    for (const blank of [undefined, null, '', '   ']) expect(meter.overCap(blank)).toBe(false);
  });

  test('cap boundary: equal is not over, above is over', () => {
    const meter = new CostMeter();
    const usd = meter.add(PRICED, USAGE);
    expect(meter.overCap(usd)).toBe(false);
    expect(meter.overCap(String(usd))).toBe(false);
    expect(meter.overCap(usd * 2)).toBe(false);
    meter.add(PRICED, USAGE);
    expect(meter.overCap(usd)).toBe(true);
    expect(meter.overCap('0.0001')).toBe(true);
    expect(meter.overCap(0)).toBe(true);
  });

  test('a zero total is never over a zero cap', () => {
    expect(new CostMeter().overCap(0)).toBe(false);
  });

  test('refuses a cap that is not a number >= 0 instead of treating it as no cap', () => {
    const meter = new CostMeter();
    for (const bad of ['abc', '-1', 'NaN', 'Infinity', -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => meter.overCap(bad)).toThrow(CostError);
    }
    expect(parseCapUsd(' 2.5 ')).toBe(2.5);
  });

  test('refuses bad token counts and leaves the total unchanged', () => {
    const meter = new CostMeter();
    for (const bad of [
      { ...USAGE, input: -1 },
      { ...USAGE, output: Number.NaN },
      { ...USAGE, cacheRead: Number.POSITIVE_INFINITY },
      { ...USAGE, cacheWrite: '10' as unknown as number },
      { ...USAGE, cacheWrite1h: -5 },
    ]) {
      expect(() => meter.add(PRICED, bad)).toThrow(CostError);
    }
    expect(meter.totalUsd()).toBe(0);
    expect(meter.byModel()).toEqual([]);
  });

  test('refuses a model without cost metadata', () => {
    const meter = new CostMeter();
    const noCost = { provider: 'x', id: 'y' } as unknown as CostModel;
    const badRate = { provider: 'x', id: 'z', cost: { input: 1, output: Number.NaN, cacheRead: 0, cacheWrite: 0 } };
    expect(() => meter.add(noCost, USAGE)).toThrow(CostError);
    expect(() => meter.add(badRate, USAGE)).toThrow(CostError);
    expect(meter.totalUsd()).toBe(0);
  });
});
