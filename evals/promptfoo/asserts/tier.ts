// Suite 1 assert: the policy's final tier against the case's expected.tier
// (metric 'tier'). Binary: a tier below the expected one fails, because the
// run would go to a weaker model than the case needs (D9 fails upward). The
// expected tier or one above it passes; the reason records how far above.
import type { AssertionValueFunctionContext, GradingResult } from 'promptfoo';

import { TIERS, type Tier } from '../../../src/types/core.ts';
import { expectedFrom } from './category.ts';
import { grade, parseClassifierOutput } from './schema.ts';

export const TIER_METRIC = 'tier';

/** Signed distance of got from expected: negative is under-tiering. */
export function tierDelta(got: Tier, expected: Tier): number {
  return TIERS.indexOf(got) - TIERS.indexOf(expected);
}

export function tierAssert(output: string, context: AssertionValueFunctionContext): GradingResult {
  const expected = expectedFrom(context);
  if (expected === undefined) return grade(false, 'the test has no valid expected labels');
  const parsed = parseClassifierOutput(output);
  if (!parsed.ok) return grade(false, parsed.reason);
  const got = parsed.value.tier.final;
  const delta = tierDelta(got, expected.tier);
  if (delta < 0) return grade(false, `under-tiered: ${got}, expected ${expected.tier}`);
  if (delta === 0) return grade(true, `tier ${got}`);
  return grade(true, `over-tiered by ${delta}: ${got}, expected ${expected.tier}`);
}

export default tierAssert;
