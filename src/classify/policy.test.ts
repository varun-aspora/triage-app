import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { TierDecisionSchema, type Classification } from '../types/classification.ts';
import type { Tier } from '../types/core.ts';
import { parsePatterns, type Pattern } from './patterns.ts';
import { applyTierPolicy, RULES, toTierDecision, type TierPolicyContext } from './policy.ts';

// A classification that trips no rule: cheap onboarding case, high confidence.
const base = (over: Partial<Classification> = {}): Classification => ({
  category: 'onboarding',
  subcategory: 'sim_binding',
  entities_likely: ['ssfb'],
  current_ask: 'why is the form stuck',
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'cheap',
  confidence: 0.9,
  missing_info: [],
  images_seen: false,
  ...over,
});

const pattern = (id: string, stable: boolean): Record<string, unknown> => ({
  id,
  category: 'onboarding',
  signature: { regex: ['x'], services: [] },
  entities: ['ssfb'],
  query_recipe: 'logs_search',
  tier_hint: 'cheap',
  stable,
  source_ref: 'fixture',
});
const PATTERNS: Pattern[] = parsePatterns([pattern('stable-one', true), pattern('flaky-one', false)]);

const allImages = () => true;
const imagesFrom = (...tiers: Tier[]) => (t: Tier) => tiers.includes(t);

const ctx = (over: Partial<TierPolicyContext> = {}): TierPolicyContext => ({
  imageCapable: allImages,
  hasImages: false,
  patterns: PATTERNS,
  ...over,
});

describe('baseline', () => {
  test('no rule matches: the proposed tier stands', () => {
    for (const t of ['cheap', 'mid', 'strong'] as const) {
      const r = applyTierPolicy(base({ tier_proposed: t }), ctx());
      expect(r.tier_final).toBe(t);
      expect(r.tier_proposed).toBe(t);
      expect(r.rule_fired).toBe(RULES.proposed);
      expect(r.rules_applied).toEqual([]);
      expect(r.policy_errors).toBeUndefined();
    }
  });
});

describe('each rule alone', () => {
  test('rule 1: category unknown -> strong', () => {
    const r = applyTierPolicy(base({ category: 'unknown' }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidOrUnknown);
  });

  test('rule 1: invalid classifier output -> strong', () => {
    const r = applyTierPolicy({ category: 'onboarding', tier_proposed: 'cheap' }, ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidOrUnknown);
    expect(r.classification.category).toBe('unknown');
    expect(r.classification.classifier_error).toContain('policy: invalid classification');
  });

  test('rule 1: classifier_error set -> strong', () => {
    const r = applyTierPolicy(base({ classifier_error: 'timeout' }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidOrUnknown);
  });

  for (const category of ['beneficiary', 'funding_in', 'systemic'] as const) {
    test(`rule 2: category ${category} -> strong`, () => {
      const r = applyTierPolicy(base({ category }), ctx());
      expect(r.tier_final).toBe('strong');
      expect(r.rule_fired).toBe(RULES.highRisk);
    });
  }

  test('rule 2: misdirected_funds -> strong', () => {
    const r = applyTierPolicy(base({ misdirected_funds: true }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.highRisk);
  });

  test('rule 3: confidence < 0.6 -> strong', () => {
    const r = applyTierPolicy(base({ confidence: 0.59 }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.lowConfidence);
  });

  test('rule 3: confidence exactly 0.6 does not fire', () => {
    const r = applyTierPolicy(base({ confidence: 0.6 }), ctx());
    expect(r.tier_final).toBe('cheap');
    expect(r.rule_fired).toBe(RULES.proposed);
  });

  test('rule 4: money_moved raises cheap to mid', () => {
    const r = applyTierPolicy(base({ money_moved: true }), ctx());
    expect(r.tier_final).toBe('mid');
    expect(r.rule_fired).toBe(RULES.moneyMoved);
  });

  test('rule 4: money_moved leaves strong at strong', () => {
    const r = applyTierPolicy(base({ money_moved: true, tier_proposed: 'strong' }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.moneyMoved);
  });

  test('rule 5: stable pattern lowers mid to cheap', () => {
    const r = applyTierPolicy(base({ tier_proposed: 'mid', matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('cheap');
    expect(r.rule_fired).toBe(RULES.stablePattern);
  });

  test('rule 5: stable pattern lowers strong by one tier only', () => {
    const r = applyTierPolicy(base({ tier_proposed: 'strong', matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('mid');
    expect(r.rule_fired).toBe(RULES.stablePattern);
  });

  test('rule 5: floor is cheap', () => {
    const r = applyTierPolicy(base({ tier_proposed: 'cheap', matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('cheap');
    expect(r.rule_fired).toBe(RULES.proposed);
  });

  test('rule 6: images and a text-only tier -> first image-capable tier', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: imagesFrom('mid', 'strong') }));
    expect(r.tier_final).toBe('mid');
    expect(r.rule_fired).toBe(RULES.images);
    expect(r.tier_raised_for_images).toBe(true);
    expect(r.images_dropped).toBeUndefined();
  });

  test('rule 6: skips a text-only mid and lands on strong', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: imagesFrom('strong') }));
    expect(r.tier_final).toBe('strong');
    expect(r.tier_raised_for_images).toBe(true);
  });

  test('rule 6: no images, no raise', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: false, imageCapable: () => false }));
    expect(r.tier_final).toBe('cheap');
    expect(r.tier_raised_for_images).toBeUndefined();
  });

  test('rule 6: an image-capable tier is not raised', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: allImages }));
    expect(r.tier_final).toBe('cheap');
    expect(r.rule_fired).toBe(RULES.proposed);
  });

  test('rule 6: no tier takes images -> images_dropped instead of a silent drop', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: () => false }));
    expect(r.tier_final).toBe('cheap');
    expect(r.images_dropped).toBe(true);
    expect(r.tier_raised_for_images).toBeUndefined();
  });

  test('rule 7: caller override is honoured and recorded', () => {
    const r = applyTierPolicy(base(), ctx({ override: { tier: 'strong', by: 'cli:--tier' } }));
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.override);
    expect(r.tier_override_by).toBe('cli:--tier');
    expect(r.tier_proposed).toBe('cheap');
  });

  test('rule 7: override may lower a rule 1-3 strong', () => {
    const r = applyTierPolicy(base({ category: 'beneficiary' }), ctx({ override: { tier: 'cheap', by: 'operator' } }));
    expect(r.tier_final).toBe('cheap');
    expect(r.rule_fired).toBe(RULES.override);
    expect(r.rules_applied).toEqual([RULES.highRisk, RULES.override]);
  });

  test('rule 7: override tier without image input -> images_dropped', () => {
    const r = applyTierPolicy(
      base(),
      ctx({ hasImages: true, imageCapable: imagesFrom('strong'), override: { tier: 'cheap', by: 'operator' } }),
    );
    expect(r.tier_final).toBe('cheap');
    expect(r.images_dropped).toBe(true);
    expect(r.tier_raised_for_images).toBeUndefined();
  });

  test('rule 7: image-capable override tier keeps the images', () => {
    const r = applyTierPolicy(
      base(),
      ctx({ hasImages: true, imageCapable: imagesFrom('mid', 'strong'), override: { tier: 'mid', by: 'operator' } }),
    );
    expect(r.images_dropped).toBeUndefined();
  });
});

describe('rule order', () => {
  test('rule 2 then 5: a stable pattern does not lower a high-risk category', () => {
    const r = applyTierPolicy(base({ category: 'funding_in', matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.highRisk);
    expect(r.rules_applied).toEqual([RULES.highRisk]);
  });

  test('rule 1 then 5: a stable pattern does not lower unknown', () => {
    const r = applyTierPolicy(base({ category: 'unknown', matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidOrUnknown);
  });

  test('rule 3 then 5: a stable pattern does not lower low confidence', () => {
    const r = applyTierPolicy(base({ confidence: 0.2, matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('strong');
  });

  test('rule 4 then 5: a stable pattern cannot take money_moved below mid', () => {
    for (const t of ['cheap', 'mid'] as const) {
      const r = applyTierPolicy(base({ money_moved: true, tier_proposed: t, matched_pattern_id: 'stable-one' }), ctx());
      expect(r.tier_final).toBe('mid');
      expect(r.rule_fired).toBe(RULES.moneyMoved);
    }
  });

  test('rule 4 then 5: money_moved strong lowers to mid, not cheap', () => {
    const r = applyTierPolicy(base({ money_moved: true, tier_proposed: 'strong', matched_pattern_id: 'stable-one' }), ctx());
    expect(r.tier_final).toBe('mid');
    expect(r.rule_fired).toBe(RULES.stablePattern);
    expect(r.rules_applied).toEqual([RULES.moneyMoved, RULES.stablePattern]);
  });

  test('rule 3 then 6: strong that takes images is not changed', () => {
    const r = applyTierPolicy(base({ confidence: 0.1 }), ctx({ hasImages: true, imageCapable: imagesFrom('strong') }));
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.lowConfidence);
    expect(r.tier_raised_for_images).toBeUndefined();
  });

  test('rule 3 then 6: strong without image input records images_dropped', () => {
    const r = applyTierPolicy(base({ confidence: 0.1 }), ctx({ hasImages: true, imageCapable: imagesFrom('mid') }));
    expect(r.tier_final).toBe('strong');
    expect(r.images_dropped).toBe(true);
  });

  test('rule 5 then 6: images raise back up after a stable lowering', () => {
    const r = applyTierPolicy(
      base({ tier_proposed: 'mid', matched_pattern_id: 'stable-one' }),
      ctx({ hasImages: true, imageCapable: imagesFrom('mid', 'strong') }),
    );
    expect(r.tier_final).toBe('mid');
    expect(r.rule_fired).toBe(RULES.images);
    expect(r.rules_applied).toEqual([RULES.stablePattern, RULES.images]);
  });

  test('rule 6 then 7: an override clears tier_raised_for_images', () => {
    const r = applyTierPolicy(
      base(),
      ctx({ hasImages: true, imageCapable: imagesFrom('strong'), override: { tier: 'strong', by: 'operator' } }),
    );
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.override);
    expect(r.tier_raised_for_images).toBeUndefined();
    expect(r.images_dropped).toBeUndefined();
  });
});

describe('patterns', () => {
  test('a non-stable pattern lowers nothing', () => {
    const r = applyTierPolicy(base({ tier_proposed: 'strong', matched_pattern_id: 'flaky-one' }), ctx());
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.proposed);
  });

  test('a pattern id not in patterns.json lowers nothing', () => {
    const r = applyTierPolicy(base({ tier_proposed: 'strong', matched_pattern_id: 'not-there' }), ctx());
    expect(r.tier_final).toBe('strong');
  });

  test('no patterns loaded: nothing is lowered', () => {
    const r = applyTierPolicy(base({ tier_proposed: 'strong', matched_pattern_id: 'stable-one' }), ctx({ patterns: undefined }));
    expect(r.tier_final).toBe('strong');
  });
});

describe('fail upward on malformed input', () => {
  const malformed: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'category: onboarding'],
    ['an array', []],
    ['an empty object', {}],
    ['a bad category', { ...base(), category: 'weather' }],
    ['a bad tier_proposed', { ...base(), tier_proposed: 'tiny' }],
    ['confidence above 1', { ...base(), confidence: 1.5 }],
    ['confidence below 0', { ...base(), confidence: -0.1 }],
    ['confidence NaN', { ...base(), confidence: Number.NaN }],
    ['confidence as a string', { ...base(), confidence: '0.9' }],
    ['money_moved as a string', { ...base(), money_moved: 'yes' }],
    ['misdirected_funds missing', (({ misdirected_funds: _m, ...rest }) => rest)(base())],
    ['an unknown entity', { ...base(), entities_likely: ['shivalik'] }],
    ['an empty matched_pattern_id', { ...base(), matched_pattern_id: '  ' }],
  ];

  for (const [name, raw] of malformed) {
    test(`${name} -> strong via rule 1`, () => {
      const r = applyTierPolicy(raw, ctx());
      expect(r.tier_final).toBe('strong');
      expect(r.rule_fired).toBe(RULES.invalidOrUnknown);
      expect(r.classification.category).toBe('unknown');
      expect(r.classification.classifier_error).toBeTruthy();
    });
  }

  test('invalid output with a stable pattern and money_moved is still strong', () => {
    const r = applyTierPolicy({ ...base({ money_moved: true, matched_pattern_id: 'stable-one' }), confidence: 'high' }, ctx());
    expect(r.tier_final).toBe('strong');
  });

  test('an invalid override is not honoured and the run goes strong', () => {
    const bad = [{ tier: 'huge', by: 'x' }, { tier: 'cheap', by: '' }, { tier: 'cheap' }, 'cheap', null];
    for (const override of bad) {
      const r = applyTierPolicy(base(), ctx({ override: override as never }));
      expect(r.tier_final).toBe('strong');
      expect(r.rule_fired).toBe(RULES.invalidInput);
      expect(r.tier_override_by).toBeUndefined();
      expect(r.policy_errors?.[0]).toContain('override');
    }
  });

  test('hasImages not a boolean is treated as images present, and the run goes strong', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: 'yes' as never, imageCapable: imagesFrom('mid') }));
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidInput);
    expect(r.images_dropped).toBe(true);
  });

  test('imageCapable that throws -> strong, error recorded', () => {
    const r = applyTierPolicy(
      base(),
      ctx({
        hasImages: true,
        imageCapable: () => {
          throw new Error('no metadata');
        },
      }),
    );
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidInput);
    expect(r.policy_errors?.join(' ')).toContain('no metadata');
  });

  test('imageCapable returning a non-boolean -> strong', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: (() => 'yes') as never }));
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidInput);
  });

  test('imageCapable missing -> strong', () => {
    const r = applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: undefined as never }));
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidInput);
  });

  test('a missing ctx does not throw and goes strong', () => {
    const r = applyTierPolicy(base(), undefined as never);
    expect(r.tier_final).toBe('strong');
    expect(r.rule_fired).toBe(RULES.invalidInput);
  });

  test('a malformed ctx never lowers: invalid override on top of rule 2 stays strong', () => {
    const r = applyTierPolicy(base({ category: 'systemic' }), ctx({ override: { tier: 'nope' } as never }));
    expect(r.tier_final).toBe('strong');
  });
});

describe('purity and output shape', () => {
  test('the input classification is not mutated', () => {
    const c = base({ tier_proposed: 'mid', matched_pattern_id: 'stable-one' });
    const before = JSON.stringify(c);
    applyTierPolicy(c, ctx());
    expect(JSON.stringify(c)).toBe(before);
  });

  test('same input, same output', () => {
    const c = base({ money_moved: true, tier_proposed: 'strong', matched_pattern_id: 'stable-one' });
    expect(applyTierPolicy(c, ctx())).toEqual(applyTierPolicy(c, ctx()));
  });

  test('toTierDecision produces a schema-valid TierDecision', () => {
    const cases = [
      applyTierPolicy(base(), ctx()),
      applyTierPolicy(undefined, ctx()),
      applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: imagesFrom('strong') })),
      applyTierPolicy(base(), ctx({ hasImages: true, imageCapable: imagesFrom('strong'), override: { tier: 'cheap', by: 'op' } })),
    ];
    for (const r of cases) {
      const d = toTierDecision(r);
      expect(v.safeParse(TierDecisionSchema, d).success).toBe(true);
      expect(d.tier_final).toBe(r.tier_final);
      expect(d.rule_fired).toBe(r.rule_fired);
    }
    const overridden = toTierDecision(cases[3]!);
    expect(overridden.tier_override_by).toBe('op');
    expect(overridden.images_dropped).toBe(true);
    expect(toTierDecision(cases[2]!).tier_raised_for_images).toBe(true);
  });
});
