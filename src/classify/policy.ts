// Deterministic tier policy (HLD 02 §4.3, D9, D36). Rules run in order:
//   1. classifier output invalid, category unknown or classifier_error set -> strong
//   2. category beneficiary|funding_in|systemic, or misdirected_funds       -> strong
//   3. confidence < 0.6                                                      -> strong
//   4. money_moved                                                           -> at least mid
//   5. matched pattern marked stable -> lower one tier, never below cheap and
//      never below rule 4's mid floor; does nothing after rules 1-3
//   6. images present and the tier's model has no image input -> raise to the
//      first image-capable tier above it
//   7. caller override -> used as is, recorded; images_dropped when that tier
//      cannot take the images
// The first of rules 1-4 to match sets the floor; later rules only raise,
// except rule 5 and rule 7. Uncertainty always routes up: any malformed input
// ends at strong.
//
// The module is pure. Image capability comes in through ctx.imageCapable so
// it does not depend on src/models.ts, and the stable flag comes from the
// loaded patterns. Prior cases are never an input (D43).
import * as v from 'valibot';

import {
  ClassificationSchema,
  type Classification,
  type TierDecision,
} from '../types/classification.ts';
import { NonEmptyStringSchema, TIERS, TierSchema, type Tier } from '../types/core.ts';
import type { Pattern } from './patterns.ts';

export const LOW_CONFIDENCE = 0.6;

const HIGH_RISK_CATEGORIES: ReadonlySet<string> = new Set(['beneficiary', 'funding_in', 'systemic']);

export const RULES = {
  invalidOrUnknown: 'rule_1_invalid_or_unknown',
  highRisk: 'rule_2_high_risk_category',
  lowConfidence: 'rule_3_low_confidence',
  moneyMoved: 'rule_4_money_moved',
  stablePattern: 'rule_5_stable_pattern',
  images: 'rule_6_images',
  override: 'rule_7_override',
  // No rule matched: the classifier's proposed tier stands.
  proposed: 'classifier_proposed',
  // The policy context itself was malformed.
  invalidInput: 'invalid_policy_input',
} as const;
export type RuleFired = (typeof RULES)[keyof typeof RULES];

export type TierOverride = { tier: Tier; by: string };

export type TierPolicyContext = {
  /** Whether the model behind this tier accepts image input. */
  imageCapable: (tier: Tier) => boolean;
  /** Whether the request has image attachments. */
  hasImages: boolean;
  /** Loaded patterns.json, used to look up the matched pattern's stable flag. */
  patterns?: readonly Pattern[];
  /** Caller --tier, with who asked for it. */
  override?: TierOverride;
};

export type TierPolicyResult = {
  /** The validated classification, or a fail-upward stand-in when it was invalid. */
  classification: Classification;
  tier_proposed: Tier;
  tier_final: Tier;
  /** The rule that decided tier_final. */
  rule_fired: RuleFired;
  /** Every rule that took effect, in order. */
  rules_applied: RuleFired[];
  tier_raised_for_images?: true;
  tier_override_by?: string;
  images_dropped?: true;
  /** Malformed policy input, when there was any. */
  policy_errors?: string[];
};

const rank = (t: Tier): number => TIERS.indexOf(t);
const maxTier = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b);
const lowerOne = (t: Tier): Tier => TIERS[Math.max(0, rank(t) - 1)] as Tier;

function fallbackClassification(raw: unknown, reason: string): Classification {
  const rawError = (raw as { classifier_error?: unknown } | null)?.classifier_error;
  return {
    category: 'unknown',
    subcategory: '',
    entities_likely: [],
    current_ask: '',
    money_moved: false,
    misdirected_funds: false,
    tier_proposed: 'strong',
    confidence: 0,
    missing_info: [],
    images_seen: false,
    classifier_error:
      typeof rawError === 'string' && rawError.trim() ? rawError : `policy: invalid classification: ${reason}`,
  };
}

const OverrideSchema = v.object({ tier: TierSchema, by: NonEmptyStringSchema });

export function applyTierPolicy(raw: unknown, ctx: TierPolicyContext): TierPolicyResult {
  const errors: string[] = [];
  const applied: RuleFired[] = [];

  // Context checks. Each malformed field is recorded and treated in the
  // direction that needs the stronger or image-capable model.
  let hasImages = true;
  if (typeof ctx?.hasImages === 'boolean') hasImages = ctx.hasImages;
  else errors.push('hasImages is not a boolean');
  const capable = (tier: Tier): boolean => {
    if (typeof ctx?.imageCapable !== 'function') {
      errors.push('imageCapable is not a function');
      return false;
    }
    try {
      const answer = ctx.imageCapable(tier);
      if (typeof answer === 'boolean') return answer;
      errors.push(`imageCapable(${tier}) did not return a boolean`);
    } catch (err) {
      errors.push(`imageCapable(${tier}) threw: ${(err as Error)?.message ?? String(err)}`);
    }
    return false;
  };

  // Rule 1 input check.
  const parsed = v.safeParse(ClassificationSchema, raw);
  const classification = parsed.success
    ? parsed.output
    : fallbackClassification(raw, parsed.issues.map((i) => i.message).join('; '));
  const c = classification;

  let tier: Tier = c.tier_proposed;
  let fired: RuleFired = RULES.proposed;
  let locked = false;
  let midFloor = false;
  const set = (t: Tier, rule: RuleFired) => {
    tier = t;
    fired = rule;
    applied.push(rule);
  };

  // Rules 1-3: strong, and nothing later may lower it.
  if (!parsed.success || c.category === 'unknown' || (c.classifier_error ?? '').trim() !== '') {
    set('strong', RULES.invalidOrUnknown);
    locked = true;
  } else if (HIGH_RISK_CATEGORIES.has(c.category) || c.misdirected_funds) {
    set('strong', RULES.highRisk);
    locked = true;
  } else if (c.confidence < LOW_CONFIDENCE) {
    set('strong', RULES.lowConfidence);
    locked = true;
  } else if (c.money_moved) {
    // Rule 4 sets the mid floor.
    set(maxTier(tier, 'mid'), RULES.moneyMoved);
    midFloor = true;
  }

  // Rule 5: a stable matched pattern lowers one tier at most.
  if (!locked && c.matched_pattern_id) {
    const pattern = ctx?.patterns?.find((p) => p.id === c.matched_pattern_id);
    if (pattern?.stable === true) {
      const lowered = maxTier(lowerOne(tier), midFloor ? 'mid' : 'cheap');
      if (rank(lowered) < rank(tier)) set(lowered, RULES.stablePattern);
    }
  }

  // Rule 6: raise to the first image-capable tier.
  let raisedForImages = false;
  let imagesDropped = false;
  if (hasImages && !capable(tier)) {
    const next = TIERS.slice(rank(tier) + 1).find((t) => capable(t));
    if (next) {
      set(next, RULES.images);
      raisedForImages = true;
    } else {
      // No tier at or above this one takes images (doctor should have caught
      // this for strong). Say so instead of dropping them silently.
      imagesDropped = true;
    }
  }

  // Rule 7: caller override.
  let overrideBy: string | undefined;
  if (ctx?.override !== undefined) {
    const o = v.safeParse(OverrideSchema, ctx.override);
    if (o.success) {
      set(o.output.tier, RULES.override);
      overrideBy = o.output.by;
      raisedForImages = false;
      imagesDropped = hasImages && !capable(o.output.tier);
    } else {
      errors.push(`override is invalid: ${o.issues.map((i) => i.message).join('; ')}`);
    }
  }

  // Malformed context: fail upward to strong and drop the override.
  if (errors.length > 0) {
    tier = 'strong';
    fired = RULES.invalidInput;
    applied.push(RULES.invalidInput);
    overrideBy = undefined;
    raisedForImages = false;
    imagesDropped = hasImages && !capable('strong');
  }

  const result: TierPolicyResult = {
    classification,
    tier_proposed: c.tier_proposed,
    tier_final: tier,
    rule_fired: fired,
    rules_applied: applied,
  };
  if (raisedForImages) result.tier_raised_for_images = true;
  if (overrideBy !== undefined) result.tier_override_by = overrideBy;
  if (imagesDropped) result.images_dropped = true;
  if (errors.length > 0) result.policy_errors = [...new Set(errors)];
  return result;
}

/** Shapes a policy result as the TierDecision saved with the run. */
export function toTierDecision(result: TierPolicyResult): TierDecision {
  const decision: TierDecision = {
    proposed: result.classification,
    tier_final: result.tier_final,
    rule_fired: result.rule_fired,
  };
  if (result.tier_raised_for_images) decision.tier_raised_for_images = true;
  if (result.tier_override_by !== undefined) decision.tier_override_by = result.tier_override_by;
  if (result.images_dropped) decision.images_dropped = true;
  return decision;
}
