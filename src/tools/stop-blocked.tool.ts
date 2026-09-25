// stop_blocked: the orchestrator's way to park a run on a system that did
// not answer (D55). Mounted on the triage root only; investigators return
// the "did not answer" outcome in their gaps and the root decides whether
// the investigation can go on without that system.
//
// The call stores a block record in the run store, which moves the run to
// phase blocked, and tells the model to stop. useAgentFinish treats a
// successful call as a valid end of the response, the submission settles
// with no report and nothing is embedded, and nothing runs until a person
// sends the run on with `triage resume` (resumeRun in src/ingress/submit.ts),
// a new submission on the same conversation. The tool never waits.
//
// The model names the systems and the tool checks the claim: every named
// system must have a failure the tool pipeline recorded for this run
// (src/tools/_lib/connector-failures.ts). A system that never failed is
// refused with the usual reply, record the gap and finish. Blank config,
// gate refusals and fixture misses are never recorded, so they cannot block.
//
// Order: signal -> budget (one tool call) -> shape -> every system has a
// recorded failure -> the run as stored -> no open question, no open block
// -> egress check with refuse semantics on the reason -> store write
// (persisted profile, ingress names masked) -> audit line -> envelope.
//
// Like ask_requester, the egress check refuses instead of masking: the
// reason is read by the person who resumes the run, and a masked reason
// would tell them less than a rephrased one.

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { makeAuditLine } from '../gate/audit.ts';
import { checkEgress, redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { BlockOpenError, InputRequestOpenError } from '../runstore/types.ts';
import type { AuditTransport } from '../types/audit.ts';
import { type BlockRecord, BlockReasonSchema, MAX_BLOCK_SYSTEMS, SystemRefSchema } from '../types/block.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import { connectorFailuresFor } from './_lib/connector-failures.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const STOP_BLOCKED = 'stop_blocked';

export const StopBlockedInputSchema = v.strictObject({
  systems: v.pipe(v.array(SystemRefSchema), v.minLength(1), v.maxLength(MAX_BLOCK_SYSTEMS)),
  reason: BlockReasonSchema,
});
export type StopBlockedInput = v.InferOutput<typeof StopBlockedInputSchema>;

/** What the model is told after the run is parked. */
export const BLOCKED_NOTE =
  'Stop now: the run is parked until a person resumes it, and it continues on this conversation with everything you have found so far. Do not call finish_report.';

const DESCRIPTION =
  'Park this run when a tool result said a system did not answer (<entity>:<service> did not answer) and the ' +
  'investigation cannot go on without it. Name each system exactly as the tool result did, for example ' +
  "'ssfb:harbor', and say in one or two lines what could not be checked and why the run cannot go on. " +
  'A person resumes the run once the system is back, and it continues from what you have found; after this ' +
  'call stop and do not call finish_report. Only a system that failed in this run can be named; one that ' +
  'is not needed for the current ask, or that is not configured, or that refused the call, is a gap in the ' +
  'report, not a block. Do not put account numbers, phones or other identifiers in the reason.';

const MAX_LISTED_PATHS = 8;

type StopBlockedRunContext = { readonly data: unknown; readonly signal?: AbortSignal };

/** Builds the tool. toolModule.create() calls it; tests call it with a fake context. */
export function createStopBlockedTool(ctx: ToolContext): ToolDefinition {
  const run = async ({ data, signal }: StopBlockedRunContext): Promise<ToolEnvelope> => {
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
            tool: STOP_BLOCKED,
            decision,
            ...(reason !== undefined ? { reason } : {}),
            service: 'block',
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
      audit('deny', 'refused', 'stop_blocked: refused', reason);
      return refused(redactModelFacing(message), now);
    };

    const budget = deps.budget.consumeToolCall(STOP_BLOCKED);
    if (!budget.ok) return refuse(budget.message, `budget: ${budget.reason}`);

    const parsed = v.safeParse(StopBlockedInputSchema, data);
    if (!parsed.success) {
      const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(input)'))];
      const listed = paths.slice(0, MAX_LISTED_PATHS).join(', ') + (paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : '');
      return refuse(`Refused: the input does not fit at ${listed}. Fix those fields and call stop_blocked again.`, `shape: ${listed}`);
    }
    const input = parsed.output;
    const systems = [...new Set(input.systems)];

    // Every named system must have failed in this run. The pipeline records
    // the "did not answer" outcomes; the model cannot claim one it never saw.
    const recorded = connectorFailuresFor(ctx.runId);
    const failed = new Set(recorded.map((f) => f.system));
    const unknown = systems.find((s) => !failed.has(s));
    if (unknown !== undefined) {
      const seen = [...failed];
      const hint = seen.length > 0 ? ` Systems that did not answer in this run: ${seen.join(', ')}.` : '';
      return refuse(
        `Refused: no tool result in this run said ${unknown} did not answer.${hint} Record the gap and finish with finish_report.`,
        `no recorded failure: ${unknown}`,
      );
    }

    const record = await deps.runStore.getRun(ctx.runId);
    if (record === null) return refuse('Refused: this run is not in the run store. Record the gap and finish with finish_report.', 'run not found');
    signal?.throwIfAborted();

    if (record.input_request !== null) {
      return refuse(
        `Refused: question ${record.input_request.question_id} to the requester is still open. Stop now; the run resumes with their answer.`,
        'question open',
      );
    }
    if (record.block !== null) {
      return refuse(`Refused: block ${record.block.block_id} is already open. ${BLOCKED_NOTE}`, 'already open');
    }

    const check = checkEgress({ reason: input.reason });
    if (!check.ok) {
      const found = check.unmasked.join(', ');
      return refuse(
        `Refused: the reason carries an unmasked ${found}. Rephrase it without identifiers (name the system and what it holds) and call stop_blocked again.`,
        `unmasked: ${found}`,
      );
    }

    const block: BlockRecord = {
      block_id: `b${record.block_history.length + 1}`,
      systems,
      failures: recorded.filter((f) => systems.includes(f.system)),
      reason: input.reason,
      blocked_at: now().toISOString(),
      submission_seq: record.submissions.at(-1)?.seq ?? 1,
    };

    try {
      await deps.runStore.putBlock(ctx.runId, redactPersisted(block, { names }));
    } catch (err) {
      if (err instanceof BlockOpenError) return refuse(`Refused: block ${err.blockId} is already open. ${BLOCKED_NOTE}`, 'already open');
      if (err instanceof InputRequestOpenError) {
        return refuse(`Refused: question ${err.questionId} to the requester is still open. Stop now; the run resumes with their answer.`, 'question open');
      }
      throw err;
    }
    audit('allow', 'ok', `stop_blocked ${block.block_id} opened on ${systems.join(', ')} with ${block.failures.length} recorded failure${block.failures.length === 1 ? '' : 's'}`);
    return ok({ block_id: block.block_id, status: 'blocked', note: BLOCKED_NOTE }, now);
  };

  return defineTool({
    name: STOP_BLOCKED,
    description: DESCRIPTION,
    input: StopBlockedInputSchema,
    run: (context) => run(context),
  });
}

export const toolModule: ToolModule = {
  name: STOP_BLOCKED,
  mounts: ['triage'],
  entities: 'all',
  enabled: () => ({ on: true }),
  create: (ctx) => createStopBlockedTool(ctx),
};
