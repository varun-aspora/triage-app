// Core shared schemas: entities, tiers, interfaces, known ids and timestamps.
// Files in src/types import only valibot and each other.
import * as v from 'valibot';

export const ENTITIES = ['ssfb', 'atspl', 'rtl'] as const;
export const EntitySchema = v.picklist(ENTITIES);
export type Entity = v.InferOutput<typeof EntitySchema>;

export const TIERS = ['cheap', 'mid', 'strong'] as const;
export const TierSchema = v.picklist(TIERS);
export type Tier = v.InferOutput<typeof TierSchema>;

export const INTERFACES = ['cli', 'http', 'claude-code', 'slack'] as const;
export const InterfaceSchema = v.picklist(INTERFACES);
export type Interface = v.InferOutput<typeof InterfaceSchema>;

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const ConfidenceSchema = v.picklist(CONFIDENCE_LEVELS);
export type Confidence = v.InferOutput<typeof ConfidenceSchema>;

// Report status lives here, not in report.ts, because prior cases in
// classification.ts also carry it and report.ts imports classification.ts.
export const REPORT_STATUSES = [
  'root_cause_confirmed',
  'resolved',
  'pending_user',
  'pending_bank',
  'inconclusive',
] as const;
export const ReportStatusSchema = v.picklist(REPORT_STATUSES);
export type ReportStatus = v.InferOutput<typeof ReportStatusSchema>;

// ISO 8601 timestamp, as produced by Date.prototype.toISOString().
export const TakenAtSchema = v.pipe(v.string(), v.isoTimestamp());
export type TakenAt = v.InferOutput<typeof TakenAtSchema>;

export const NonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
export type NonEmptyString = v.InferOutput<typeof NonEmptyStringSchema>;

// A run id is also a folder name under the runs dir, so only a safe charset is
// allowed. ULIDs match.
export const RunIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
export type RunId = v.InferOutput<typeof RunIdSchema>;

// The identifiers a run knows (D69). resources/known-ids.json describes each
// one (question, candidate pattern, labels); this list must name the same
// keys in the same order, which src/config/known-ids.test.ts checks. The list
// stays here as a literal so the key type is a union, not string.
export const KNOWN_ID_KEYS = [
  'country',
  'phone_number',
  'aspora_user_id',
  'customer_id',
  'account_form_id',
  'account_id',
  'account_number',
] as const;
export const KnownIdKeySchema = v.picklist(KNOWN_ID_KEYS);
export type KnownIdKey = v.InferOutput<typeof KnownIdKeySchema>;

// Every key is optional, so the inferred type is already Partial<KnownIds>.
export const KnownIdsSchema = v.object({
  country: v.optional(NonEmptyStringSchema),
  phone_number: v.optional(NonEmptyStringSchema),
  aspora_user_id: v.optional(NonEmptyStringSchema),
  customer_id: v.optional(NonEmptyStringSchema),
  account_form_id: v.optional(NonEmptyStringSchema),
  account_id: v.optional(NonEmptyStringSchema),
  account_number: v.optional(NonEmptyStringSchema),
});
export type KnownIds = v.InferOutput<typeof KnownIdsSchema>;

export const TimeWindowSchema = v.pipe(
  v.object({ from: TakenAtSchema, to: TakenAtSchema }),
  v.check((w) => Date.parse(w.from) <= Date.parse(w.to), 'window.from must not be after window.to'),
);
export type TimeWindow = v.InferOutput<typeof TimeWindowSchema>;
