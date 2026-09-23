import { describe, expect, test } from 'bun:test';
import type { AssertionValueFunctionContext } from 'promptfoo';

import { unknownClassification } from '../../../src/classify/classify.ts';
import type { Classification } from '../../../src/types/classification.ts';
import type { Tier } from '../../../src/types/core.ts';
import { categoryAssert } from './category.ts';
import { schemaAssert, type ClassifierOutput } from './schema.ts';
import { tierAssert, tierDelta } from './tier.ts';

const CLASSIFICATION: Classification = {
  category: 'card',
  subcategory: 'card_view',
  entities_likely: ['ssfb'],
  current_ask: 'Explain the error on the card screen.',
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'cheap',
  confidence: 0.8,
  missing_info: [],
  images_seen: false,
};

function output(final: Tier, classification: Classification = CLASSIFICATION): string {
  const out: ClassifierOutput = {
    case_id: 'syn-x',
    model: 'faux/classifier',
    classification,
    tier: { proposed: 'cheap', final, rule_fired: 'classifier_proposed', rules_applied: [] },
    cost_usd: 0,
  };
  return JSON.stringify(out);
}

function ctx(expected: unknown): AssertionValueFunctionContext {
  return { vars: { expected } as never, prompt: undefined, test: {} as never, logProbs: undefined, provider: undefined, providerResponse: undefined };
}

const EXPECTED = { category: 'card', tier: 'mid' };

describe('tier assert', () => {
  test('under-tiering fails', () => {
    const r = tierAssert(output('cheap'), ctx(EXPECTED));
    expect(r).toMatchObject({ pass: false, score: 0 });
    expect(r.reason).toContain('under-tiered');
  });

  test('the exact tier passes', () => {
    expect(tierAssert(output('mid'), ctx(EXPECTED))).toMatchObject({ pass: true, score: 1, reason: 'tier mid' });
  });

  test('over-tiering passes and says by how much', () => {
    const r = tierAssert(output('strong'), ctx(EXPECTED));
    expect(r).toMatchObject({ pass: true, score: 1 });
    expect(r.reason).toContain('over-tiered by 1');
  });

  test('missing expected labels or bad output fail', () => {
    expect(tierAssert(output('mid'), ctx(undefined)).pass).toBe(false);
    expect(tierAssert('not json', ctx(EXPECTED)).pass).toBe(false);
  });

  test('tierDelta is signed', () => {
    expect(tierDelta('cheap', 'strong')).toBe(-2);
    expect(tierDelta('strong', 'cheap')).toBe(2);
    expect(tierDelta('mid', 'mid')).toBe(0);
  });
});

describe('category assert', () => {
  test('passes when the category equals expected.category', () => {
    expect(categoryAssert(output('mid'), ctx(EXPECTED))).toMatchObject({ pass: true, score: 1 });
  });

  test('fails on another category', () => {
    const r = categoryAssert(output('mid'), ctx({ category: 'transfer_out', tier: 'mid' }));
    expect(r).toMatchObject({ pass: false, score: 0 });
    expect(r.reason).toBe('category card, expected transfer_out');
  });

  test('fails when the expected labels are missing or invalid', () => {
    expect(categoryAssert(output('mid'), ctx(undefined)).pass).toBe(false);
    expect(categoryAssert(output('mid'), ctx({ category: 'not-a-category', tier: 'mid' })).pass).toBe(false);
  });
});

describe('schema assert', () => {
  test('a valid output passes', () => {
    expect(schemaAssert(output('mid'))).toMatchObject({ pass: true, score: 1 });
  });

  test('non-JSON or a wrong shape fails, naming paths only', () => {
    expect(schemaAssert('garbage')).toMatchObject({ pass: false, reason: 'output is not JSON' });
    const bad = JSON.parse(output('mid')) as Record<string, unknown>;
    bad.tier = { final: 'SECRET-TIER' };
    const r = schemaAssert(JSON.stringify(bad));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('tier');
    expect(r.reason).not.toContain('SECRET-TIER');
  });

  test('a fail-upward classification with classifier_error fails', () => {
    expect(schemaAssert(output('strong', unknownClassification('schema-invalid output at category'))).pass).toBe(false);
  });
});
