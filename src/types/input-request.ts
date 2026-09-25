// The question a run asks the person who started it (P6 §4.3, D52). The
// orchestrator opens one through ask_requester, the run pauses in phase
// needs_input, and the CLI shows it and sends the answer back as a new
// submission on the same run.
//
// The record is presentation-neutral: text, fixed choices and whether free
// text is allowed. Nothing here says which interface renders it. Every text
// field is persisted-profile text: the tool refuses a question that carries
// an unmasked identifier rather than masking it, so the model rephrases with
// what the reader can recognise (an amount, a timestamp, the last four).
import * as v from 'valibot';
import { NonEmptyStringSchema, TakenAtSchema } from './core.ts';

/** q1, q2, ... in the order the run asked. */
export const QuestionIdSchema = v.pipe(v.string(), v.regex(/^q[1-9][0-9]{0,3}$/));
export type QuestionId = v.InferOutput<typeof QuestionIdSchema>;

/** 'provide': information only the person has. ('do', a step on the host, is not built; see P6 §4.1.) */
export const INPUT_REQUEST_KINDS = ['provide'] as const;
export const InputRequestKindSchema = v.picklist(INPUT_REQUEST_KINDS);
export type InputRequestKind = v.InferOutput<typeof InputRequestKindSchema>;

export const MAX_QUESTION_CHARS = 600;
export const MAX_WHY_CHARS = 300;
export const MAX_OPTIONS = 6;
export const MAX_OPTION_CHARS = 80;

export const QuestionTextSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_QUESTION_CHARS));
export const WhyTextSchema = v.pipe(v.string(), v.trim(), v.maxLength(MAX_WHY_CHARS));
export const OptionTextSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_OPTION_CHARS));
export const OptionsSchema = v.pipe(v.array(OptionTextSchema), v.maxLength(MAX_OPTIONS));

export const InputRequestSchema = v.object({
  question_id: QuestionIdSchema,
  kind: InputRequestKindSchema,
  question: QuestionTextSchema,
  /** One line on why the run cannot go on without it. Shown next to the question. */
  why: WhyTextSchema,
  /** Fixed choices, when the answer is one of a few. Empty means free text only. */
  options: OptionsSchema,
  /** Whether an answer outside the options is accepted. Always true with no options. */
  free_text: v.boolean(),
  asked_at: TakenAtSchema,
});
export type InputRequest = v.InferOutput<typeof InputRequestSchema>;

export const INPUT_RESOLUTIONS = ['answered', 'skipped'] as const;
export const InputResolutionStatusSchema = v.picklist(INPUT_RESOLUTIONS);
export type InputResolutionStatus = v.InferOutput<typeof InputResolutionStatusSchema>;

/** How an open request was closed. The answer text lives on the submission it started. */
export const InputResolutionSchema = v.object({
  status: InputResolutionStatusSchema,
  resolved_at: TakenAtSchema,
  /** Who answered or skipped: an email, a Slack user id or the OS user. */
  resolved_by: NonEmptyStringSchema,
});
export type InputResolution = v.InferOutput<typeof InputResolutionSchema>;

export const ResolvedInputRequestSchema = v.object({ ...InputRequestSchema.entries, ...InputResolutionSchema.entries });
export type ResolvedInputRequest = v.InferOutput<typeof ResolvedInputRequestSchema>;
