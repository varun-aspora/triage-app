// Suite 1 assert: the provider output is a valid classifier result (metric
// 'schema'). Used as a promptfoo javascript assert, as a function value in
// buildClassifierSuite or through file://evals/promptfoo/asserts/schema.ts.
//
// The output shape is defined here, and provider-classifier.ts builds it, so
// the three asserts and the provider agree on one schema.
//
// A classification that carries classifier_error fails: classify() turned
// garbage, schema-invalid output or a provider error into the fail-upward
// 'unknown' result, which is valid data but a failed model answer.
import type { AssertionValueFunctionContext, GradingResult } from 'promptfoo';
import * as v from 'valibot';

import { ClassificationSchema } from '../../../src/types/classification.ts';
import { NonEmptyStringSchema, TierSchema } from '../../../src/types/core.ts';

export const SCHEMA_METRIC = 'schema';

export const ClassifierTierSchema = v.object({
  proposed: TierSchema,
  final: TierSchema,
  rule_fired: NonEmptyStringSchema,
  rules_applied: v.array(v.string()),
  tier_raised_for_images: v.optional(v.literal(true)),
  images_dropped: v.optional(v.literal(true)),
});

export const ClassifierOutputSchema = v.object({
  case_id: NonEmptyStringSchema,
  /** The classifier model spec this result was produced with. */
  model: NonEmptyStringSchema,
  classification: ClassificationSchema,
  tier: ClassifierTierSchema,
  cost_usd: v.pipe(v.number(), v.finite(), v.minValue(0)),
});
export type ClassifierOutput = v.InferOutput<typeof ClassifierOutputSchema>;

export type ParsedOutput = { ok: true; value: ClassifierOutput } | { ok: false; reason: string };

/** Parses the provider's JSON output. Reasons name field paths, never values. */
export function parseClassifierOutput(output: unknown): ParsedOutput {
  let raw: unknown = output;
  if (typeof output === 'string') {
    try {
      raw = JSON.parse(output);
    } catch {
      return { ok: false, reason: 'output is not JSON' };
    }
  }
  const parsed = v.safeParse(ClassifierOutputSchema, raw);
  if (!parsed.success) {
    const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
    return { ok: false, reason: `output does not match the classifier schema at ${paths.join(', ')}` };
  }
  return { ok: true, value: parsed.output };
}

export function grade(pass: boolean, reason: string): GradingResult {
  return { pass, score: pass ? 1 : 0, reason };
}

export function schemaAssert(output: string, _context?: AssertionValueFunctionContext): GradingResult {
  const parsed = parseClassifierOutput(output);
  if (!parsed.ok) return grade(false, parsed.reason);
  if (parsed.value.classification.classifier_error !== undefined) {
    return grade(false, 'the classifier did not return a valid classification (classifier_error is set)');
  }
  return grade(true, 'valid classification');
}

export default schemaAssert;
