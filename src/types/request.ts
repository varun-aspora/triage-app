// TriageRequest: what ingress builds from a Slack thread, a thread file, text
// or JSON (LLD 04 §2.1). It has no redaction_names field on purpose: those
// names ride on TriageInit so the run store never receives them.
import * as v from 'valibot';
import {
  EntitySchema,
  InterfaceSchema,
  KnownIdsSchema,
  NonEmptyStringSchema,
  RunIdSchema,
  TakenAtSchema,
  TierSchema,
  TimeWindowSchema,
} from './core.ts';

export const RequestSourceSchema = v.variant('kind', [
  v.object({
    kind: v.literal('slack'),
    channel_id: NonEmptyStringSchema,
    thread_ts: NonEmptyStringSchema,
    permalink: NonEmptyStringSchema,
  }),
  v.object({ kind: v.literal('thread_file') }),
  v.object({ kind: v.literal('text') }),
  v.object({ kind: v.literal('json') }),
]);
export type RequestSource = v.InferOutput<typeof RequestSourceSchema>;

export const ThreadMessageSchema = v.object({
  ts: NonEmptyStringSchema,
  author: v.string(),
  text: v.string(),
  is_parent: v.boolean(),
});
export type ThreadMessage = v.InferOutput<typeof ThreadMessageSchema>;

export const AttachmentSchema = v.object({
  name: NonEmptyStringSchema,
  mime: NonEmptyStringSchema,
  bytes_ref: NonEmptyStringSchema,
});
export type Attachment = v.InferOutput<typeof AttachmentSchema>;

export const RequestHintsSchema = v.object({
  entities: v.optional(v.array(EntitySchema)),
  ids: v.optional(KnownIdsSchema),
  tier: v.optional(TierSchema),
  time_window: v.optional(TimeWindowSchema),
});
export type RequestHints = v.InferOutput<typeof RequestHintsSchema>;

export const TriageRequestSchema = v.object({
  // ULID; also the Flue conversation id (run_id).
  request_id: RunIdSchema,
  interface: InterfaceSchema,
  // Email or Slack user id.
  requested_by: NonEmptyStringSchema,
  source: RequestSourceSchema,
  messages: v.array(ThreadMessageSchema),
  attachments: v.array(AttachmentSchema),
  hints: RequestHintsSchema,
  // Default: first message ts minus the lookback days, up to now; hints override.
  window: TimeWindowSchema,
  received_at: TakenAtSchema,
});
export type TriageRequest = v.InferOutput<typeof TriageRequestSchema>;
