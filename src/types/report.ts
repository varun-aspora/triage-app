// The Report written by finish_report (LLD 04 §2.9, HLD 02 §6). Adds status,
// cx_answer, suggested_fix (D35) and repo_commits (D37). Pre-flight warnings
// are folded into gaps, so there is no separate field for them. There is no
// root_cause.service field (D42).
import * as v from 'valibot';
import {
  ConfidenceSchema,
  EntitySchema,
  NonEmptyStringSchema,
  ReportStatusSchema,
  RunIdSchema,
  TakenAtSchema,
} from './core.ts';
import { TierDecisionSchema } from './classification.ts';
import { EvidenceLadderStepSchema, EvidenceRefSchema } from './findings.ts';
import { IdChainSchema } from './id-chain.ts';

export const ReportRequestSchema = v.object({
  permalink: v.optional(NonEmptyStringSchema),
  current_ask: v.string(),
  requested_by: NonEmptyStringSchema,
});
export type ReportRequest = v.InferOutput<typeof ReportRequestSchema>;

export const CurrentStateItemSchema = v.object({
  item: NonEmptyStringSchema,
  value: v.string(),
  taken_at: TakenAtSchema,
  source: EvidenceRefSchema,
});
export type CurrentStateItem = v.InferOutput<typeof CurrentStateItemSchema>;

export const ReportTimelineItemSchema = v.object({
  at: TakenAtSchema,
  entity: EntitySchema,
  what: NonEmptyStringSchema,
  source: EvidenceRefSchema,
});
export type ReportTimelineItem = v.InferOutput<typeof ReportTimelineItemSchema>;

export const CodeRefSchema = v.object({
  repo: NonEmptyStringSchema,
  file: NonEmptyStringSchema,
  lines: NonEmptyStringSchema,
});
export type CodeRef = v.InferOutput<typeof CodeRefSchema>;

export const RootCauseSchema = v.object({
  statement: NonEmptyStringSchema,
  code_refs: v.array(CodeRefSchema),
  matched_pattern_id: v.optional(NonEmptyStringSchema),
});
export type RootCause = v.InferOutput<typeof RootCauseSchema>;

export const ImpactScopeSchema = v.object({
  kind: v.picklist(['single', 'systemic', 'unknown']),
  affected_count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  how_measured: v.optional(v.string()),
});
export type ImpactScope = v.InferOutput<typeof ImpactScopeSchema>;

export const CxAnswerSchema = v.object({
  action_owner: v.picklist(['user', 'backend', 'bank', 'unknown']),
  money_safe: v.picklist(['yes', 'no', 'unknown']),
  should_retry: v.picklist(['yes', 'no', 'wait']),
  reply_text: v.string(),
  escalate_to: v.optional(NonEmptyStringSchema),
});
export type CxAnswer = v.InferOutput<typeof CxAnswerSchema>;

// Writes are recommendations only; the runtime never executes them.
export const ReportActionsSchema = v.object({
  cx: v.array(v.string()),
  eng: v.array(v.string()),
  ops_bank: v.array(v.string()),
});
export type ReportActions = v.InferOutput<typeof ReportActionsSchema>;

export const SUGGESTED_FIX_KINDS = ['curl', 'sql', 'manual'] as const;
export const SuggestedFixKindSchema = v.picklist(SUGGESTED_FIX_KINDS);
export type SuggestedFixKind = v.InferOutput<typeof SuggestedFixKindSchema>;

// A command for a human to run (D35). Hosts and tokens appear only as $VAR
// placeholders; src/report checks that.
export const SuggestedFixSchema = v.object({
  title: NonEmptyStringSchema,
  kind: SuggestedFixKindSchema,
  command: v.string(),
  preconditions: v.array(v.string()),
  verify_with: v.string(),
});
export type SuggestedFix = v.InferOutput<typeof SuggestedFixSchema>;

// The commit of each repo the code walker read (D37).
export const RepoCommitSchema = v.object({
  repo: NonEmptyStringSchema,
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/)),
  branch: v.optional(NonEmptyStringSchema),
});
export type RepoCommit = v.InferOutput<typeof RepoCommitSchema>;

const TokenCount = v.pipe(v.number(), v.integer(), v.minValue(0));

// Usage per model in the report (D59). The cache fields and usd are optional
// so reports written before D59 still parse.
export const ModelUsageSchema = v.object({
  calls: TokenCount,
  input_tokens: TokenCount,
  output_tokens: TokenCount,
  cache_read_tokens: v.optional(TokenCount),
  cache_write_tokens: v.optional(TokenCount),
  // Absent when the model has no price; it is then listed in unpriced_models.
  usd: v.optional(v.pipe(v.number(), v.minValue(0))),
});
export type ModelUsage = v.InferOutput<typeof ModelUsageSchema>;

export const ReportCostSchema = v.object({
  models: v.record(v.string(), ModelUsageSchema),
  wall_ms: v.pipe(v.number(), v.minValue(0)),
  // The sum of the priced models. Since D59 it is set whenever usage exists,
  // and leaves out the models in unpriced_models. Reports written before D59
  // may lack it.
  usd_total: v.optional(v.pipe(v.number(), v.minValue(0))),
  // Models with no price, sorted. Absent or empty: the total is complete.
  unpriced_models: v.optional(v.array(v.string())),
});
export type ReportCost = v.InferOutput<typeof ReportCostSchema>;

export const ReportSchema = v.object({
  run_id: RunIdSchema,
  env_label: v.string(),
  generated_at: TakenAtSchema,
  request: ReportRequestSchema,
  classification: TierDecisionSchema,
  id_chain: IdChainSchema,
  current_state: v.array(CurrentStateItemSchema),
  timeline: v.array(ReportTimelineItemSchema),
  root_cause: v.nullable(RootCauseSchema),
  scope: ImpactScopeSchema,
  status: ReportStatusSchema,
  cx_answer: CxAnswerSchema,
  actions: ReportActionsSchema,
  suggested_fix: v.array(SuggestedFixSchema),
  confidence: ConfidenceSchema,
  confidence_reason: v.string(),
  evidence_ladder: v.array(EvidenceLadderStepSchema),
  entities_consulted: v.array(EntitySchema),
  gaps: v.array(v.string()),
  escalated: v.boolean(),
  escalation_reasons: v.array(v.string()),
  images_seen: v.boolean(),
  repo_commits: v.array(RepoCommitSchema),
  // Null when no token usage was recorded for the run (D59). Before D59 it was
  // also null when a model had no pricing.
  cost: v.nullable(ReportCostSchema),
});
export type Report = v.InferOutput<typeof ReportSchema>;

// The fields the model drafts. The harness fills run_id, env_label,
// generated_at, repo_commits and cost itself.
export const ReportDraftSchema = v.omit(ReportSchema, [
  'run_id',
  'env_label',
  'generated_at',
  'repo_commits',
  'cost',
]);
export type ReportDraft = v.InferOutput<typeof ReportDraftSchema>;
