// Agent contract: a run that parks on a system that did not answer, and is
// sent on by a person (D55). Every run here goes through the ingress
// pipeline (runSubmission and resumeRun from src/ingress/submit.ts) on the
// real Flue runtime, the way the CLI and the HTTP routes submit, so the
// settle's blocked status and the resume are what is tested.
//
// - stop_blocked after a recorded connector failure ends the response: no
//   triage.finish_required signal, the submission settles blocked with the
//   block in the result, the phase is the one the tool set, there is no
//   report, nothing is embedded, and the step log gets a 'blocked' line.
// - resumeRun closes the block as resumed and dispatches the triage.resume
//   signal on the same conversation as a submission of kind 'resume'; the
//   model's finish_report completes the run. The connector failure record
//   was released when the run parked, so a second stop_blocked on the
//   resumed run is refused until the system fails again.
// - A run that failed after it was dispatched is resumed the same way, with
//   the failure named in the signal.
// - stop_blocked naming a system with no recorded failure is refused, and
//   the run goes on to a report.
// - Every audit line written here says transport 'mock', and no stop_blocked
//   line carries the reason text.
//
// Mock mode answers every connector from fixtures and never raises a
// connector error (src/mock/resolve.ts), so the failure stop_blocked checks
// against is recorded here with recordConnectorFailure, the way the tool
// pipeline does on a "did not answer" outcome (test/tools/pipeline.test.ts
// covers that side).

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { FINISH_REQUIRED_SIGNAL } from '../../../src/agents/triage-plan.ts';
import type { PreparedSubmission } from '../../../src/ingress/prepare.ts';
import type { SubmissionDeps } from '../../../src/ingress/submit.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../../../src/runlog/event-log.ts';
import { readRunEvents } from '../../../src/runlog/read.ts';
import { recordConnectorFailure } from '../../../src/tools/_lib/connector-failures.ts';
import { STOP_BLOCKED } from '../../../src/tools/stop-blocked.tool.ts';
import { BLOCK_RESUME_SIGNAL, type ConnectorFailure } from '../../../src/types/block.ts';
import type { Classification } from '../../../src/types/classification.ts';
import type { IdChain } from '../../../src/types/id-chain.ts';
import {
  auditLines,
  bootTriage,
  type Booted,
  contractHome,
  nextRunId,
  reportDraft,
  type SeenCall,
  scriptAgents,
  triageInit,
} from './harness.ts';

type SubmitModule = typeof import('../../../src/ingress/submit.ts');

const fake = createFakeModel();
const home = contractHome(fake);
let b: Booted;
let submit: SubmitModule;
let deps: SubmissionDeps;
/** The run ids embedRun was called for, in order. */
const embedded: string[] = [];

const HARBOR = 'ssfb:harbor';
const PACKAGE = 'atspl:package';
const FAILED_AT = '2026-09-20T10:00:00.000Z';
const RESUMED_AT = '2026-09-20T12:00:00.000Z';
// Not an email: the persisted profile masks the whole address, and the
// model-facing one its local part, so an email could not be read back as is.
const RESUMED_BY = 'oncall-ops';
const REASON = 'The payout state lives in harbor and harbor did not answer; no other source shows whether the transfer left.';
const NOTE = 'harbor is back after the database failover.';
const FAILURE: ConnectorFailure = { system: HARBOR, tool: 'sql_select', code: 'unreachable', at: FAILED_AT };
const CHAIN: IdChain = { ids: { customer_id: 'cust-contract-1' }, hops: [], basic_state: [] };
// What the fake classifier answers. No tier rule fires on it, so the proposed mid tier stands.
const CLASSIFICATION: Classification = {
  category: 'transfer_out',
  subcategory: 'transfer not received',
  entities_likely: ['ssfb'],
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'mid',
  confidence: 0.9,
  images_seen: false,
};

const SIGNAL_OPEN = `<signal type="${FINISH_REQUIRED_SIGNAL}">`;
const signalsIn = (call: SeenCall | undefined): number =>
  (call?.userTexts ?? []).filter((t) => t.includes(SIGNAL_OPEN)).length;
const resultOf = (call: SeenCall | undefined, tool: string) => call?.toolResults.filter((r) => r.toolName === tool).at(-1);

/** A synthetic run's request, the way prepareRequest hands it to runSubmission. */
function preparedFor(runId: string): PreparedSubmission {
  return { run_id: runId, request: triageInit(runId).request, redaction_names: [] };
}

type PipelineLine = { readonly type: string; readonly data: Record<string, unknown> };

/** The pipeline's lines in a run's step log, in order. */
async function pipelineLines(runId: string): Promise<PipelineLine[]> {
  await flushRunEventLog();
  const page = await readRunEvents(home.config.paths.runsDir, runId, { limit: 5000 });
  return page.events.filter((e) => e.source === 'pipeline').map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

beforeAll(async () => {
  // The step log before start(), as bootRuntime does, so the 'blocked' and 'resume' lines can be read back.
  installRunEventLog({ runsDir: home.config.paths.runsDir });
  b = await bootTriage(fake, home);
  // submit.ts imports the agent module, so it is loaded after TRIAGE_HOME is set, like the harness does.
  submit = await import('../../../src/ingress/submit.ts');
  // The production deps on the harness runtime, with: the identity step and
  // the classifier answering fixed values (no model call, no fixture); no
  // known patterns, so no rule moves the tier; an embedder spy; and a fixed
  // clock for the resume.
  deps = {
    ...submit.submissionDeps({ runtime: b.plan.triageRuntime() }),
    identity: async () => ({ id_chain: CHAIN, basic_state: [], gaps: [] }),
    classify: async () => CLASSIFICATION,
    patterns: async () => [],
    embedRun: async (_store, _embedder, runId) => {
      embedded.push(runId);
      return { written: [], unchanged: [], empty: [], gaps: [] };
    },
    now: () => new Date(RESUMED_AT),
  };
});

afterAll(async () => {
  await b?.flue.stop();
  uninstallRunEventLog();
  home.dispose();
});

describe('a run blocked on a system that did not answer', () => {
  test('stop_blocked parks the run; resumeRun sends it on and finish_report completes it', async () => {
    const id = nextRunId('blocked_park');
    // What the tool pipeline records when harbor does not answer (see the file comment).
    recordConnectorFailure(id, FAILURE);
    const s = scriptAgents(fake, { triage: [toolCall(STOP_BLOCKED, { systems: [HARBOR], reason: REASON }), text('parked')] });

    const first = await submit.runSubmission(preparedFor(id), deps);

    expect(fake.failures()).toEqual([]);
    expect(first).toMatchObject({ run_id: id, status: 'blocked', submission_seq: 1, gaps: [] });
    expect(first.block).toMatchObject({ block_id: 'b1', systems: [HARBOR], failures: [FAILURE], reason: REASON, submission_seq: 1 });
    const calls = s.callsFor('triage');
    expect(calls).toHaveLength(2);
    const parked = resultOf(calls[1], STOP_BLOCKED);
    expect(parked?.isError).toBe(false);
    expect(parked?.text).toContain('"block_id":"b1"');
    expect(parked?.text).toContain('"status":"blocked"');
    // The stop after the block gets no finish_required signal.
    expect(signalsIn(calls[1])).toBe(0);
    expect(s.left()).toMatchObject({ triage: 0 });
    // A parked run is not embedded.
    expect(embedded).not.toContain(id);

    const parkedRun = await b.store.getRun(id);
    expect(parkedRun?.phase).toBe('blocked');
    expect(parkedRun?.classification?.decision.tier_final).toBe('mid');
    expect(parkedRun?.block).toMatchObject({ block_id: 'b1', systems: [HARBOR], failures: [FAILURE], reason: REASON, submission_seq: 1 });
    expect(parkedRun?.block_history).toEqual([]);
    expect(parkedRun?.report).toBeNull();
    expect(parkedRun?.submissions.map((x) => x.kind)).toEqual(['initial']);

    // The person resumes with a note. The model tries stop_blocked again
    // first: the failure record was released when the run parked, so the
    // call is refused until harbor fails again; then finish_report
    // completes the run.
    const s2 = scriptAgents(fake, {
      triage: [toolCall(STOP_BLOCKED, { systems: [HARBOR], reason: REASON }), finish(reportDraft(triageInit(id))), text('report written')],
    });

    const second = await submit.resumeRun(id, { by: RESUMED_BY, note: NOTE }, deps);

    expect(fake.failures()).toEqual([]);
    expect(second).toMatchObject({ run_id: id, status: 'completed', submission_seq: 2, reply_text: 'report written' });
    expect(second.block).toBeUndefined();
    const calls2 = s2.callsFor('triage');
    expect(calls2).toHaveLength(3);
    // The same conversation: the first response's stop_blocked result is
    // still in the context, and the signal names the block, the person, the
    // time and the note.
    expect(calls2[0]?.toolResults.some((r) => r.toolName === STOP_BLOCKED)).toBe(true);
    const signal = calls2[0]?.userTexts.at(-1) ?? '';
    expect(signal).toContain(`<signal type="${BLOCK_RESUME_SIGNAL}">`);
    expect(signal).toContain(`This run was blocked (b1) because ${HARBOR} did not answer: ${REASON}`);
    expect(signal).toContain(`${RESUMED_BY} resumed it at ${RESUMED_AT}.`);
    expect(signal).toContain(`Message from ${RESUMED_BY}:\n${NOTE}`);
    expect(signal).toContain('Take the message into account');
    expect(signal).toContain(`${HARBOR} is expected to answer now.`);
    const again = resultOf(calls2[1], STOP_BLOCKED);
    expect(again?.isError).toBe(false);
    expect(again?.text).toContain('"status":"refused"');
    expect(again?.text).toContain(`no tool result in this run said ${HARBOR} did not answer`);
    expect(signalsIn(calls2[2])).toBe(0);
    expect(s2.left()).toMatchObject({ triage: 0 });
    // Embedded once, at the completion.
    expect(embedded.filter((r) => r === id)).toEqual([id]);

    const done = await b.store.getRun(id);
    expect(done?.phase).toBe('completed');
    expect(done?.report).not.toBeNull();
    expect(done?.block).toBeNull();
    expect(done?.block_history).toHaveLength(1);
    expect(done?.block_history[0]).toMatchObject({
      block_id: 'b1',
      systems: [HARBOR],
      reason: REASON,
      status: 'resumed',
      resolved_at: RESUMED_AT,
      resolved_by: RESUMED_BY,
      note: NOTE,
    });
    expect(done?.submissions.map((x) => [x.seq, x.kind])).toEqual([
      [1, 'initial'],
      [2, 'resume'],
    ]);
    expect(done?.submissions[1]).toMatchObject({ block_id: 'b1', note: NOTE });
    expect(done?.submissions[1]?.report).not.toBeNull();

    // The step log: the pipeline left the phase to the tool, logged the block
    // at the settle, then the resume, and the resume's dispatch says so.
    const lines = await pipelineLines(id);
    expect(lines.find((l) => l.type === 'blocked')?.data).toEqual({ submission_seq: 1, block_id: 'b1', systems: [HARBOR] });
    expect(lines.filter((l) => l.type === 'settled').map((l) => l.data.status)).toEqual(['blocked', 'completed']);
    expect(lines.find((l) => l.type === 'resume')?.data).toEqual({ kind: 'resume', from: 'blocked', block_id: 'b1', by: RESUMED_BY, note: NOTE });
    const phases = lines.filter((l) => l.type === 'phase').map((l) => l.data);
    expect(phases.map((p) => p.phase)).not.toContain('blocked');
    expect(phases.filter((p) => p.phase === 'dispatched').map((p) => p.resume === true)).toEqual([false, true]);

    // A completed run is not resumed: a follow-up is the way on.
    const refusal = await submit.resumeRun(id, { by: RESUMED_BY }, deps).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(submit.RunNotResumableError);
    expect(refusal).toMatchObject({ phase: 'completed', hint: submit.RESUME_HINTS.completed });
  });

  test('a run that failed after it was dispatched is resumed on the same conversation, with the failure named', async () => {
    const id = nextRunId('blocked_failed');
    // No finish_report: the one reminder, then the response fails.
    const s = scriptAgents(fake, { triage: [text('I am done'), text('still done')] });

    const first = await submit.runSubmission(preparedFor(id), deps);

    expect(first).toMatchObject({ run_id: id, status: 'failed', submission_seq: 1, error: expect.stringMatching(/^AgentRunError: /) });
    expect(signalsIn(s.callsFor('triage')[1])).toBe(1);
    const failed = await b.store.getRun(id);
    expect(failed?.phase).toBe('failed');
    expect(failed?.phase_reason).toBe(first.error);
    expect(failed?.block).toBeNull();

    const s2 = scriptAgents(fake, { triage: [finish(reportDraft(triageInit(id))), text('report written')] });

    const second = await submit.resumeRun(id, { by: RESUMED_BY }, deps);

    expect(fake.failures()).toEqual([]);
    expect(second).toMatchObject({ run_id: id, status: 'completed', submission_seq: 2 });
    const calls2 = s2.callsFor('triage');
    expect(calls2).toHaveLength(2);
    const signal = calls2[0]?.userTexts.at(-1) ?? '';
    expect(signal).toContain(`<signal type="${BLOCK_RESUME_SIGNAL}">`);
    expect(signal).toContain(`This run failed (${first.error}) before it finished.`);
    expect(signal).toContain(`${RESUMED_BY} resumed it at ${RESUMED_AT}.`);
    expect(signal).not.toContain('Message from');
    // The failed response's reminder is still in the conversation, and the resume gets no new one.
    expect(signalsIn(calls2[0])).toBe(1);
    expect(signalsIn(calls2[1])).toBe(1);

    const done = await b.store.getRun(id);
    expect(done?.phase).toBe('completed');
    expect(done?.report).not.toBeNull();
    expect(done?.block_history).toEqual([]);
    expect(done?.submissions.map((x) => x.kind)).toEqual(['initial', 'resume']);
    expect(done?.submissions[1]?.block_id).toBeUndefined();
    const lines = await pipelineLines(id);
    expect(lines.find((l) => l.type === 'resume')?.data).toEqual({ kind: 'resume', from: 'failed', by: RESUMED_BY });
    expect(lines.filter((l) => l.type === 'settled').map((l) => l.data.status)).toEqual(['failed', 'completed']);
  });

  test('stop_blocked on a system with no recorded failure is refused, and the run goes on to a report', async () => {
    const id = nextRunId('blocked_unrecorded');
    const s = scriptAgents(fake, {
      triage: [toolCall(STOP_BLOCKED, { systems: [PACKAGE], reason: REASON }), finish(reportDraft(triageInit(id))), text('done')],
    });

    const result = await submit.runSubmission(preparedFor(id), deps);

    expect(fake.failures()).toEqual([]);
    expect(result).toMatchObject({ run_id: id, status: 'completed', submission_seq: 1 });
    expect(result.block).toBeUndefined();
    const refused = resultOf(s.callsFor('triage')[1], STOP_BLOCKED);
    expect(refused?.isError).toBe(false);
    expect(refused?.text).toContain('"status":"refused"');
    expect(refused?.text).toContain(`no tool result in this run said ${PACKAGE} did not answer`);
    expect(refused?.text).toContain('finish with finish_report');
    expect(signalsIn(s.callsFor('triage')[2])).toBe(0);

    const run = await b.store.getRun(id);
    expect(run?.phase).toBe('completed');
    expect(run?.block).toBeNull();
    expect(run?.block_history).toEqual([]);
    expect(run?.report).not.toBeNull();
    expect((await pipelineLines(id)).map((l) => l.type)).not.toContain('blocked');
  });
});

test('every audit line written in this file has transport mock, and no stop_blocked line carries the reason', () => {
  const lines = auditLines(home);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.transport !== 'mock')).toEqual([]);
  const blocks = lines.filter((l) => l.tool === STOP_BLOCKED);
  expect(blocks.some((l) => l.decision === 'allow')).toBe(true);
  expect(blocks.some((l) => l.decision === 'deny')).toBe(true);
  for (const l of blocks) expect(JSON.stringify(l)).not.toContain('payout state');
});
