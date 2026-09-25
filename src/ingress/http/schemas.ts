// Valibot schemas for the HTTP API bodies and headers (HLD 02 §5.2, LLD 04 §2.1).
//
// Only the shape is checked here. Id keys, entity names, timestamps and the
// Slack link are checked by prepareRequest, which gives the same answers as
// the CLI. Error helpers report field paths, never the values received.

import * as v from 'valibot';
import { NonEmptyStringSchema, TierSchema } from '../../types/core.ts';
import { MAX_CONTEXT_CHARS, ThreadFileMessageSchema } from '../normalise.ts';
import { FEEDBACK_VERDICTS, FINDING_VERDICTS } from '../../runstore/types.ts';
import { MAX_FEEDBACK_TEXT, MAX_FINDING_VERDICTS } from '../../report/feedback.ts';

/** Longest Idempotency-Key header accepted. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
/** Printable ASCII, space included. */
const IDEMPOTENCY_KEY_RE = /^[\x20-\x7e]+$/;

const MAX_REQUESTED_BY = 200;
const MAX_SLACK_URL = 2048;
const MAX_QUESTION = 4000;

const WhoSchema = v.pipe(NonEmptyStringSchema, v.maxLength(MAX_REQUESTED_BY));

/**
 * POST /triage. Exactly one of slack_url and messages. requested_by is
 * required (self-declared: one shared token is a known v1 limit). context is
 * optional with either source and is appended after the thread.
 */
export const TriageBodySchema = v.pipe(
  v.object({
    slack_url: v.optional(v.pipe(NonEmptyStringSchema, v.maxLength(MAX_SLACK_URL))),
    messages: v.optional(v.pipe(v.array(ThreadFileMessageSchema), v.minLength(1))),
    ids: v.optional(v.record(v.string(), v.string())),
    entities: v.optional(v.array(v.string())),
    tier: v.optional(TierSchema),
    requested_by: WhoSchema,
    time_window: v.optional(v.object({ from: v.string(), to: v.string() })),
    context: v.optional(v.pipe(v.string(), v.maxLength(MAX_CONTEXT_CHARS))),
  }),
  v.check((b) => (b.slack_url === undefined) !== (b.messages === undefined), 'send exactly one of slack_url and messages'),
);
export type TriageBody = v.InferOutput<typeof TriageBodySchema>;

/** POST /triage/:run_id/ask. */
export const AskBodySchema = v.object({
  question: v.pipe(NonEmptyStringSchema, v.maxLength(MAX_QUESTION)),
  requested_by: WhoSchema,
});
export type AskBody = v.InferOutput<typeof AskBodySchema>;

/** POST /triage/:run_id/feedback. The interface is always 'http' and is not read from the body. */
export const FeedbackBodySchema = v.object({
  verdict: v.picklist(FEEDBACK_VERDICTS),
  actual_root_cause: v.optional(v.pipe(v.string(), v.maxLength(MAX_FEEDBACK_TEXT))),
  faster_path: v.optional(v.pipe(v.string(), v.maxLength(MAX_FEEDBACK_TEXT))),
  notes: v.optional(v.pipe(v.string(), v.maxLength(MAX_FEEDBACK_TEXT))),
  findings: v.optional(
    v.pipe(
      v.array(
        v.object({
          id: v.pipe(NonEmptyStringSchema, v.maxLength(64)),
          verdict: v.picklist(FINDING_VERDICTS),
          note: v.optional(v.pipe(v.string(), v.maxLength(MAX_FEEDBACK_TEXT))),
        }),
      ),
      v.maxLength(MAX_FINDING_VERDICTS),
    ),
  ),
  given_by: WhoSchema,
});
export type FeedbackBody = v.InferOutput<typeof FeedbackBodySchema>;

/** POST /triage/:run_id/stop. verdict: false stops without recording the Cancel verdict. */
export const StopBodySchema = v.object({
  given_by: WhoSchema,
  verdict: v.optional(v.boolean()),
});
export type StopBody = v.InferOutput<typeof StopBodySchema>;

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fields: readonly string[] };

/** Parses a body and, on failure, returns the failing field paths only ('body' for the root). */
export function parseBody<S extends v.GenericSchema>(schema: S, value: unknown): ParseResult<v.InferOutput<S>> {
  const r = v.safeParse(schema, value);
  if (r.success) return { ok: true, value: r.output };
  const fields = [...new Set(r.issues.map((i) => v.getDotPath(i) ?? 'body'))];
  return { ok: false, fields };
}

export type IdempotencyKeyResult =
  | { readonly ok: true; readonly key: string | undefined }
  | { readonly ok: false; readonly reason: string };

/** Checks the optional Idempotency-Key header. A present but blank or oversized key is refused. */
export function checkIdempotencyKey(header: string | undefined): IdempotencyKeyResult {
  if (header === undefined) return { ok: true, key: undefined };
  if (header.trim() === '') return { ok: false, reason: 'is blank' };
  if (header.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` };
  }
  if (!IDEMPOTENCY_KEY_RE.test(header)) return { ok: false, reason: 'must be printable ASCII' };
  return { ok: true, key: header };
}
