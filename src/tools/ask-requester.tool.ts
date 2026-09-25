// ask_requester: the orchestrator's one way to reach the person who started
// the run (P6 §4.3, D53). Mounted on the triage root only; investigators
// return blocked_on in their gaps and the root decides whether to ask.
//
// The call opens an input request in the run store, which moves the run to
// phase needs_input, and tells the model to stop. useAgentFinish treats a
// successful call as a valid end of the response, the submission settles,
// and nothing runs until the CLI sends the answer back as a new submission
// (answerRun in src/ingress/submit.ts). The tool never waits.
//
// Order: signal -> budget (one tool call) -> shape -> the run as stored ->
// one open question at a time -> the per-run limit (TRIAGE_MAX_ASKS_PER_RUN,
// counted from the store, so it survives a restart) -> egress check with
// refuse semantics -> store write (persisted profile, ingress names masked)
// -> audit line -> envelope.
//
// The egress check refuses instead of masking: a question that carries an
// account number or a phone would come back to the reader as ****1234 and
// be unanswerable, so the model is asked to rephrase with what the reader
// can recognise. The record is presentation-neutral
// (src/types/input-request.ts); which interface shows it is not this tool's
// concern.

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { makeAuditLine } from '../gate/audit.ts';
import { checkEgress, redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { InputRequestOpenError, RunNotFoundError } from '../runstore/types.ts';
import type { AuditTransport } from '../types/audit.ts';
import { type InputRequest, OptionsSchema, QuestionTextSchema, WhyTextSchema } from '../types/input-request.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const ASK_REQUESTER = 'ask_requester';

export const AskRequesterInputSchema = v.strictObject({
  question: QuestionTextSchema,
  why: WhyTextSchema,
  options: v.optional(OptionsSchema),
  free_text: v.optional(v.boolean()),
});
export type AskRequesterInput = v.InferOutput<typeof AskRequesterInputSchema>;

/** What the model is told after a question is opened. */
export const STOP_NOTE =
  'Stop now: the run is paused until the requester answers, and it resumes with their answer as your next message. Do not call finish_report.';

const DESCRIPTION =
  'Ask the person who started this run for one thing only they can provide, when the investigation cannot ' +
  'go on without it: which customer or account the thread is about when no id resolves, which of several ' +
  'matching records they mean, or the exact error text when it is only in a screenshot you were not shown. ' +
  'The run pauses until they answer; after this call stop and do not call finish_report. Never ask for ' +
  'anything an investigator can look up, and do not ask when the report can list what is missing under gaps. ' +
  'Phrase the question with what the reader can recognise (a date, an amount, the last four digits); a ' +
  'question that carries a full account number, phone or other unmasked identifier is refused. Give options ' +
  'when the answer is one of a few. A run gets a small number of questions; the tool refuses past the limit.';

const MAX_LISTED_PATHS = 8;

type AskRunContext = { readonly data: unknown; readonly signal?: AbortSignal };

/** Builds the tool. toolModule.create() calls it; tests call it with a fake context. */
export function createAskRequesterTool(ctx: ToolContext): ToolDefinition {
  const run = async ({ data, signal }: AskRunContext): Promise<ToolEnvelope> => {
    signal?.throwIfAborted();
    const deps = ctx.deps;
    const now = deps.now;
    const started = now().getTime();
    const names = [...new Set([...(deps.initialData?.redaction_names ?? []), ...deps.run.redactionNames])];
    const transport: AuditTransport = deps.fixtures.settings.mockMode ? 'mock' : 'real';
    const target = deps.runStore.provider === 'postgres' ? 'TRIAGE_DB_URL' : 'TRIAGE_RUNS_DIR';

    const audit = (decision: 'allow' | 'deny', exit: string, summary: string, reason?: string): void => {
      deps.audit.write(
        makeAuditLine(
          {
            run_id: ctx.runId,
            ts: now().toISOString(),
            interface: deps.run.interface,
            entity: null,
            tool: ASK_REQUESTER,
            decision,
            ...(reason !== undefined ? { reason } : {}),
            service: 'input',
            target,
            transport,
            summary,
            duration_ms: Math.max(0, now().getTime() - started),
            exit,
          },
          { names },
        ),
      );
    };
    const refuse = (message: string, reason: string): ToolEnvelope => {
      audit('deny', 'refused', 'ask_requester: refused', reason);
      return refused(redactModelFacing(message), now);
    };

    const budget = deps.budget.consumeToolCall(ASK_REQUESTER);
    if (!budget.ok) return refuse(budget.message, `budget: ${budget.reason}`);

    const parsed = v.safeParse(AskRequesterInputSchema, data);
    if (!parsed.success) {
      const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(input)'))];
      const listed = paths.slice(0, MAX_LISTED_PATHS).join(', ') + (paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : '');
      return refuse(`Refused: the input does not fit at ${listed}. Fix those fields and call ask_requester again.`, `shape: ${listed}`);
    }
    const input = parsed.output;
    const options = input.options ?? [];
    // Free text is always accepted when there is nothing to choose from.
    const freeText = options.length === 0 ? true : (input.free_text ?? true);

    const record = await deps.runStore.getRun(ctx.runId);
    if (record === null) throw new RunNotFoundError(ctx.runId);
    signal?.throwIfAborted();

    if (record.input_request !== null) {
      return refuse(`Refused: question ${record.input_request.question_id} is already open. ${STOP_NOTE}`, 'already open');
    }
    const asked = record.input_history.length;
    const max = ctx.config.budgets.maxAsksPerRun;
    if (asked >= max) {
      return refuse(
        `Refused: this run has used its ${max} question${max === 1 ? '' : 's'} to the requester. Finish with what you have and list what is missing under gaps.`,
        `limit: ${max}`,
      );
    }

    const request: InputRequest = {
      question_id: `q${asked + 1}`,
      kind: 'provide',
      question: input.question,
      why: input.why,
      options,
      free_text: freeText,
      asked_at: now().toISOString(),
    };
    const check = checkEgress({ question: request.question, why: request.why, options: request.options });
    if (!check.ok) {
      const found = check.unmasked.join(', ');
      return refuse(
        `Refused: the question carries an unmasked ${found}. Rephrase it with what the reader can recognise (a date, an amount, the last four digits) and call ask_requester again.`,
        `unmasked: ${found}`,
      );
    }

    try {
      await deps.runStore.putInputRequest(ctx.runId, redactPersisted(request, { names }));
    } catch (err) {
      if (err instanceof InputRequestOpenError) return refuse(`Refused: question ${err.questionId} is already open. ${STOP_NOTE}`, 'already open');
      throw err;
    }
    audit('allow', 'ok', `ask_requester ${request.question_id} opened with ${options.length} option${options.length === 1 ? '' : 's'}`);
    return ok({ question_id: request.question_id, status: 'waiting', note: STOP_NOTE }, now);
  };

  return defineTool({
    name: ASK_REQUESTER,
    description: DESCRIPTION,
    input: AskRequesterInputSchema,
    run: (context) => run(context),
  });
}

export const toolModule: ToolModule = {
  name: ASK_REQUESTER,
  mounts: ['triage'],
  entities: 'all',
  enabled: (ctx) => (ctx.config.budgets.maxAsksPerRun > 0 ? { on: true } : { on: false, reason: 'TRIAGE_MAX_ASKS_PER_RUN is 0' }),
  create: (ctx) => createAskRequesterTool(ctx),
};
