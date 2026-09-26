// Classifier output, the tier decision made from it, and TriageInit, the
// initial data of the Triage root agent (LLD 04 §2.3 and §2.4).
import * as v from 'valibot';
import {
  EntitySchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  ReportStatusSchema,
  TierSchema,
} from './core.ts';
import { IdChainSchema } from './id-chain.ts';
import { TriageRequestSchema } from './request.ts';

export const CATEGORIES = [
  'onboarding',
  'auth',
  'delivery',
  'transfer_out',
  'funding_in',
  'card',
  'beneficiary',
  'account_view',
  'upi_third_party',
  'fd_td',
  'systemic',
  'unknown',
] as const;
export const CategorySchema = v.picklist(CATEGORIES);
export type Category = v.InferOutput<typeof CategorySchema>;

export const ClassificationSchema = v.object({
  category: CategorySchema,
  subcategory: v.string(),
  entities_likely: v.array(EntitySchema),
  // A transfer, credit or reversal is involved.
  money_moved: v.boolean(),
  misdirected_funds: v.boolean(),
  tier_proposed: TierSchema,
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  matched_pattern_id: v.optional(NonEmptyStringSchema),
  images_seen: v.boolean(),
  // Set when the classifier output was invalid; the tier policy then forces strong.
  classifier_error: v.optional(v.string()),
});
export type Classification = v.InferOutput<typeof ClassificationSchema>;

export const TierDecisionSchema = v.object({
  proposed: ClassificationSchema,
  tier_final: TierSchema,
  rule_fired: NonEmptyStringSchema,
  tier_raised_for_images: v.optional(v.boolean()),
  // Who overrode the tier, when a caller did.
  tier_override_by: v.optional(NonEmptyStringSchema),
  // True when an override tier cannot take the request's images.
  images_dropped: v.optional(v.boolean()),
});
export type TierDecision = v.InferOutput<typeof TierDecisionSchema>;

// A structured projection of an earlier case, in the shape priorCasesFor
// (src/runstore/prior-cases.ts) builds: no run id, no ids and no free text
// (D43). strictObject, so an extra field such as a run id is refused.
export const PriorCaseSchema = v.strictObject({
  category: CategorySchema,
  subcategory: v.optional(v.string()),
  report_status: v.optional(ReportStatusSchema),
  matched_pattern_id: v.optional(NonEmptyStringSchema),
  escalated: v.optional(v.boolean()),
  feedback_verdict: v.optional(v.picklist(['correct', 'partial', 'pending'])),
  age_days: NonNegativeIntSchema,
  similarity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});
export type PriorCase = v.InferOutput<typeof PriorCaseSchema>;

export const PreflightWarningSchema = v.object({
  entity: v.optional(EntitySchema),
  step: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  fix: v.optional(v.string()),
});
export type PreflightWarning = v.InferOutput<typeof PreflightWarningSchema>;

export const TriageInitSchema = v.object({
  request: TriageRequestSchema,
  classification: TierDecisionSchema,
  id_chain: IdChainSchema,
  prior_cases: v.optional(v.array(PriorCaseSchema)),
  // Names collected by ingress (Slack profiles, bot template fields) for the
  // egress check in finish_report. Kept off TriageRequest so the run store
  // never receives them. Empty names are refused because they would match
  // every string.
  redaction_names: v.optional(v.array(NonEmptyStringSchema)),
  // Pre-flight warnings, copied into the report's gaps.
  preflight_warnings: v.optional(v.array(PreflightWarningSchema)),
});
export type TriageInit = v.InferOutput<typeof TriageInitSchema>;
