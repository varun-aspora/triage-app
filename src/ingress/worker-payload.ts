// The payload `triage start` and `triage ask` hand to the detached __worker
// process. It travels only over the child's stdin, never on argv or disk, so
// the raw thread in a submit payload is never stored anywhere (D43).
//
// Three kinds:
// - submit: the prepared TriageRequest for a new run, plus the names ingress
//   collected for redaction (they ride next to the request, not inside it, so
//   the run store never receives them).
// - ask: a follow-up question on an existing run.
// - answer: the answer to the question a run is waiting on (or a skip), with
//   any ids the person gave for the ingress identity step (P6 §4.5).
//
// Error messages name the failing field and what was expected. They never
// quote the received value, since it can be customer data.
import * as v from 'valibot';
import { KnownIdsSchema, NonEmptyStringSchema, RunIdSchema } from '../types/core.ts';
import { QuestionIdSchema } from '../types/input-request.ts';
import { TriageRequestSchema } from '../types/request.ts';

/** Upper bound on what decodePayload reads. Attachments travel as refs, so this is generous. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const SubmitPayloadSchema = v.pipe(
  v.strictObject({
    kind: v.literal('submit'),
    run_id: RunIdSchema,
    request: TriageRequestSchema,
    redaction_names: v.optional(v.array(NonEmptyStringSchema)),
  }),
  v.forward(
    v.check((p) => p.run_id === p.request.request_id, 'must equal request.request_id'),
    ['run_id'],
  ),
);
export type SubmitPayload = v.InferOutput<typeof SubmitPayloadSchema>;

export const AskPayloadSchema = v.strictObject({
  kind: v.literal('ask'),
  run_id: RunIdSchema,
  question: NonEmptyStringSchema,
  // Who asked: an email or a Slack user id.
  by: NonEmptyStringSchema,
});
export type AskPayload = v.InferOutput<typeof AskPayloadSchema>;

export const AnswerPayloadSchema = v.pipe(
  v.strictObject({
    kind: v.literal('answer'),
    run_id: RunIdSchema,
    question_id: QuestionIdSchema,
    answer: v.optional(NonEmptyStringSchema),
    skip: v.optional(v.literal(true)),
    ids: v.optional(KnownIdsSchema),
    by: NonEmptyStringSchema,
  }),
  v.forward(
    v.check((p) => (p.skip === true) !== (p.answer !== undefined), 'must be given, or skip must be true, not both'),
    ['answer'],
  ),
);
export type AnswerPayload = v.InferOutput<typeof AnswerPayloadSchema>;

export const WorkerPayloadSchema = v.variant('kind', [SubmitPayloadSchema, AskPayloadSchema, AnswerPayloadSchema]);
export type WorkerPayload = v.InferOutput<typeof WorkerPayloadSchema>;

/** A payload that is not valid JSON, too large, or fails the schema. */
export class WorkerPayloadError extends Error {
  override readonly name = 'WorkerPayloadError';
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`worker payload: ${field} ${reason}`);
    this.field = field;
    this.reason = reason;
  }
}

function issueReason(issue: v.BaseIssue<unknown>): string {
  // check() messages are fixed strings written in this repo; other issues
  // carry the received value in their message, so only `expected` is used.
  if (issue.type === 'check') return issue.message;
  if (issue.type === 'strict_object' && issue.expected === 'never') return 'is not allowed';
  if (issue.expected) return `is invalid (expected ${issue.expected})`;
  return 'is invalid';
}

function validate(input: unknown): WorkerPayload {
  const result = v.safeParse(WorkerPayloadSchema, input);
  if (result.success) return result.output;
  const issue = result.issues[0];
  throw new WorkerPayloadError(v.getDotPath(issue) ?? 'payload', issueReason(issue));
}

/** Validates the payload and returns the text to write to the worker's stdin. */
export function encodePayload(payload: WorkerPayload): string {
  return JSON.stringify(validate(payload));
}

/** Parses and validates payload text already read in full. */
export function parsePayload(text: string): WorkerPayload {
  if (text.trim() === '') throw new WorkerPayloadError('payload', 'is empty');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WorkerPayloadError('payload', 'is not valid JSON');
  }
  return validate(json);
}

/**
 * Reads the whole of the stream (the worker passes process.stdin) and
 * validates it. Throws WorkerPayloadError when it is empty, larger than
 * maxBytes, not JSON, or fails WorkerPayloadSchema.
 */
export async function decodePayload(
  input: AsyncIterable<Uint8Array | string>,
  opts: { readonly maxBytes?: number } = {},
): Promise<WorkerPayload> {
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    size += buf.byteLength;
    if (size > maxBytes) throw new WorkerPayloadError('payload', `is larger than ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return parsePayload(Buffer.concat(chunks).toString('utf8'));
}
