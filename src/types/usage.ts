// Token usage and cost of a run (D59), shared by the meter, the run store,
// the HTTP API, the CLI and the web console.
//
// One UsageRow is one submission x model x agent x purpose. seq 0 holds the
// intake calls (classifier, prior-cases embedding); seq 1.. are the run's
// submissions. usd is priced when the row is captured, so a later catalog
// refresh does not change what was stored; null means no price is known.
//
// Rows skip the persisted profile: it masks runs of 6+ digits in string
// values, which would mangle a model id like claude-haiku-4-5-20251001.
// UsageRowSchema allows only a model spec, an agent name, a fixed purpose and
// numbers instead.
import * as v from 'valibot';

export const USAGE_PURPOSES = ['agent', 'compaction', 'classify', 'embed'] as const;
export const UsagePurposeSchema = v.picklist(USAGE_PURPOSES);
export type UsagePurpose = v.InferOutput<typeof UsagePurposeSchema>;

/** 'provider/model', where the model part may hold further slashes (openrouter/typesafe/jev-1.13). */
export const USAGE_MODEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}\/[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
export const UsageModelSchema = v.pipe(v.string(), v.regex(USAGE_MODEL_PATTERN));

/** 'triage' (root), 'synthesis', 'classifier', 'embedder', or a delegate name. */
export const USAGE_AGENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const UsageAgentSchema = v.pipe(v.string(), v.regex(USAGE_AGENT_PATTERN));

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));

export const UsageRowSchema = v.object({
  model: UsageModelSchema,
  agent: UsageAgentSchema,
  purpose: UsagePurposeSchema,
  /** Model calls, failed attempts included. */
  calls: Count,
  failed_calls: Count,
  /** Uncached input, as pi-ai reports it (cache reads and writes are counted apart). */
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  cache_write_tokens: Count,
  /** null: no price is known for the model. Finite, so it survives a JSON round trip. */
  usd: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
});
export type UsageRow = v.InferOutput<typeof UsageRowSchema>;

export const SubmissionUsageSchema = v.object({
  /** 0 = intake, before the first submission. */
  seq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  rows: v.array(UsageRowSchema),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
  /** false: a live snapshot while the submission runs, or a caller-abort write. */
  final: v.boolean(),
});
export type SubmissionUsage = v.InferOutput<typeof SubmissionUsageSchema>;

export const UsageTotalsSchema = v.object({
  calls: Count,
  failed_calls: Count,
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  cache_write_tokens: Count,
  /** Sum of the priced rows. */
  usd: v.pipe(v.number(), v.minValue(0)),
  /** Models with at least one row that has no price, sorted. */
  unpriced_models: v.array(UsageModelSchema),
});
export type UsageTotals = v.InferOutput<typeof UsageTotalsSchema>;

/** What the HTTP API, the CLI and the console show. Built by src/usage/summary.ts. */
export const RunUsageViewSchema = v.object({
  /** false: no rows at all, for example a run from before migration 0004. */
  recorded: v.boolean(),
  total: UsageTotalsSchema,
  by_model: v.record(v.string(), UsageTotalsSchema),
  by_agent: v.record(v.string(), UsageTotalsSchema),
  /** Keyed by String(seq). */
  by_submission: v.record(v.string(), UsageTotalsSchema),
  pricing: v.picklist(['full', 'partial', 'none']),
  /** Every model is faux/*: the tokens are estimates. */
  fake: v.boolean(),
  /** A non-final submission while the run is running. */
  live: v.boolean(),
  /** A non-final submission on a run that is no longer running (a stalled worker counts as not running). */
  incomplete: v.boolean(),
  /** The newest SubmissionUsage.updated_at; null when nothing is recorded. */
  updated_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
});
export type RunUsageView = v.InferOutput<typeof RunUsageViewSchema>;
