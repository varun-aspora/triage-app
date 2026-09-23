// What delegates return through note_evidence: EntityFindings from
// investigate_<entity>, CodeFindings from code_walker (HLD 02 §1.2, §1.4).
// Both are strict objects so a stray field (for example an entity the model
// tries to set) is refused instead of silently dropped; the entity comes from
// the tool's closure.
import * as v from 'valibot';
import { ConfidenceSchema, EntitySchema, NonEmptyStringSchema, TakenAtSchema } from './core.ts';

export const EVIDENCE_LADDER_STEPS = ['api', 'db', 'logs', 'cbs', 'code'] as const;
export const EvidenceLadderStepSchema = v.picklist(EVIDENCE_LADDER_STEPS);
export type EvidenceLadderStep = v.InferOutput<typeof EvidenceLadderStepSchema>;

// A pointer to where a claim came from. 'thread' covers facts read from the
// Slack thread itself.
export const EVIDENCE_SOURCES = [...EVIDENCE_LADDER_STEPS, 'thread'] as const;
export const EvidenceSourceSchema = v.picklist(EVIDENCE_SOURCES);
export type EvidenceSource = v.InferOutput<typeof EvidenceSourceSchema>;

export const EvidenceRefSchema = v.object({
  source: EvidenceSourceSchema,
  entity: v.optional(EntitySchema),
  service: v.optional(NonEmptyStringSchema),
  // Staged file or tool call id, for example '/data/<toolCallId>.json'.
  raw_ref: v.optional(NonEmptyStringSchema),
});
export type EvidenceRef = v.InferOutput<typeof EvidenceRefSchema>;

export const EvidenceItemSchema = v.object({
  source: EvidenceLadderStepSchema,
  at: TakenAtSchema,
  query_or_path: v.string(),
  summary: NonEmptyStringSchema,
  raw_ref: v.optional(NonEmptyStringSchema),
});
export type EvidenceItem = v.InferOutput<typeof EvidenceItemSchema>;

export const FindingsTimelineItemSchema = v.object({
  at: TakenAtSchema,
  what: NonEmptyStringSchema,
  source: EvidenceRefSchema,
});
export type FindingsTimelineItem = v.InferOutput<typeof FindingsTimelineItemSchema>;

export const EntityFindingsSchema = v.strictObject({
  evidence: v.array(EvidenceItemSchema),
  timeline: v.array(FindingsTimelineItemSchema),
  hypotheses: v.array(NonEmptyStringSchema),
  confidence: ConfidenceSchema,
  gaps: v.array(v.string()),
  suggested_next_entity: v.optional(EntitySchema),
});
export type EntityFindings = v.InferOutput<typeof EntityFindingsSchema>;

export const CodeClaimSchema = v.object({
  repo: NonEmptyStringSchema,
  file: NonEmptyStringSchema,
  // Line or range, for example '120-148'.
  lines: NonEmptyStringSchema,
  what_it_shows: NonEmptyStringSchema,
});
export type CodeClaim = v.InferOutput<typeof CodeClaimSchema>;

export const CodeFindingsSchema = v.strictObject({
  claims: v.array(CodeClaimSchema),
  matches_known_pattern: v.optional(NonEmptyStringSchema),
  confidence: ConfidenceSchema,
});
export type CodeFindings = v.InferOutput<typeof CodeFindingsSchema>;
