// Suite 1 assert: the classified category equals the case's expected.category
// (metric 'category'). The expected labels come from the test vars.
import type { AssertionValueFunctionContext, GradingResult } from 'promptfoo';
import * as v from 'valibot';

import { ExpectedSchema, type Expected } from '../../../src/evals/case-schema.ts';
import { grade, parseClassifierOutput } from './schema.ts';

export const CATEGORY_METRIC = 'category';

/** The case's expected labels from context.vars.expected, or undefined when missing or invalid. */
export function expectedFrom(context: Pick<AssertionValueFunctionContext, 'vars'> | undefined): Expected | undefined {
  const parsed = v.safeParse(ExpectedSchema, context?.vars?.expected);
  return parsed.success ? parsed.output : undefined;
}

export function categoryAssert(output: string, context: AssertionValueFunctionContext): GradingResult {
  const expected = expectedFrom(context);
  if (expected === undefined) return grade(false, 'the test has no valid expected labels');
  const parsed = parseClassifierOutput(output);
  if (!parsed.ok) return grade(false, parsed.reason);
  const got = parsed.value.classification.category;
  return got === expected.category
    ? grade(true, `category ${got}`)
    : grade(false, `category ${got}, expected ${expected.category}`);
}

export default categoryAssert;
