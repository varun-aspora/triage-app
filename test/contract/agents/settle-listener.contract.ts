// Agent contract: the settle listener (D70) on Flue's real events.
//
// Triage runs on the fake model in strict mock mode, dispatched the way
// dispatchAndSettle does it (a submission, phase investigating, a 'dispatch'
// line), but nobody calls read(): that is the process a recovery settles in.
// The listener alone has to move the phase, from the submission_settled
// Flue emits, and write the submission's usage final.
//
// It also pins what the listener reads from the envelope on this Flue
// version: submission_settled carries the instanceId, the receipt's
// submissionId and the outcome; submission_running the instanceId, the
// receipt's submissionId and the attemptCount.
//
// A steer that missed the live response (D72) is
// dispatched to the idle instance after the host settled, and nobody reads
// it either: its submission_running moves the run from completed back to
// investigating, and its settle completes it again.

import { type FlueObservation, init, observe } from '@flue/runtime';
import { redactPersisted } from '../../../src/gate/redact.ts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SETTLE_LISTENER_VIA, flushSettleListener, installSettleListener, uninstallSettleListenerForTests } from '../../../src/ingress/settle-listener.ts';
import { flushRunEventLog, installRunEventLog, logRunEvent, uninstallRunEventLog } from '../../../src/runlog/event-log.ts';
import { readRunEvents } from '../../../src/runlog/read.ts';
import { createFakeModel, finish, text } from '../../../src/mock/fake-model.ts';
import { installUsageMeter, resetUsageMeterForTests } from '../../../src/usage/meter.ts';
import { bootTriage, type Booted, contractHome, createRun, nextRunId, reportDraft, scriptAgents, triageInit } from './harness.ts';

const fake = createFakeModel();
const home = contractHome(fake);
let b: Booted;

beforeAll(async () => {
  b = await bootTriage(fake, home);
  installRunEventLog({ runsDir: home.config.paths.runsDir, observe: () => () => undefined });
  resetUsageMeterForTests();
  installUsageMeter();
  installSettleListener({ store: () => b.store, runsDir: home.config.paths.runsDir, graceMs: 0 });
});

afterAll(async () => {
  await flushSettleListener();
  uninstallSettleListenerForTests();
  resetUsageMeterForTests();
  await flushRunEventLog();
  uninstallRunEventLog();
  await b?.flue.stop();
  home.dispose();
});

type Envelope = Record<string, unknown>;

/** Dispatches like dispatchAndSettle, without the read, and resolves with the submission_settled envelope once the listener is done. */
async function dispatchUnread(runId: string, initialData: unknown): Promise<{ settled: Envelope; submissionId: string }> {
  let resolveSettled: (e: Envelope) => void = () => undefined;
  const seen = new Promise<Envelope>((resolve) => {
    resolveSettled = resolve;
  });
  const off = observe((o: FlueObservation) => {
    const e = o as unknown as Envelope;
    if (e.instanceId === runId && e.type === 'submission_settled') resolveSettled(e);
  });
  try {
    await b.store.setPhase(runId, 'dispatched');
    const receipt = await init(b.Triage, { id: runId }).dispatch({ message: 'Triage this report.', initialData });
    logRunEvent(runId, 'dispatch', { submission_seq: 1, kind: 'initial', submission_id: receipt.submissionId });
    await flushRunEventLog();
    await b.store.setPhase(runId, 'investigating');
    const settled = await seen;
    await flushSettleListener();
    await flushRunEventLog();
    return { settled, submissionId: receipt.submissionId };
  } finally {
    off();
  }
}

async function listenerPhaseLines(runId: string): Promise<Envelope[]> {
  const page = await readRunEvents(home.config.paths.runsDir, runId, { limit: 5000 });
  return page.events
    .filter((e) => e.source === 'pipeline' && e.type === 'phase')
    .map((e) => e.data as Envelope)
    .filter((d) => d.via === SETTLE_LISTENER_VIA);
}

describe('a settle nobody reads', () => {
  test('a completed response moves investigating to completed and its usage is final', async () => {
    const runId = nextRunId('settle_done');
    const initial = triageInit(runId);
    await createRun(b.store, initial);
    scriptAgents(fake, { triage: [finish(reportDraft(initial)), text('report written')] });

    const { settled, submissionId } = await dispatchUnread(runId, initial);

    expect(settled).toMatchObject({ type: 'submission_settled', instanceId: runId, submissionId, outcome: 'completed' });
    const run = await b.store.getRun(runId);
    expect(run?.phase).toBe('completed');
    expect(await listenerPhaseLines(runId)).toEqual([{ phase: 'completed', via: SETTLE_LISTENER_VIA }]);
    const usage = run?.usage.find((u) => u.seq === 1);
    expect(usage?.final).toBe(true);
    expect(usage?.rows.reduce((n, r) => n + r.calls, 0)).toBe(2);
  });

  test('a failed response moves investigating to failed with the AgentRunError reason', async () => {
    const runId = nextRunId('settle_fail');
    const initial = triageInit(runId);
    await createRun(b.store, initial);
    // No finish_report: one finish_required signal, then the submission settles failed.
    scriptAgents(fake, { triage: [text('I am done'), text('still done')] });

    const { settled } = await dispatchUnread(runId, initial);

    expect(settled.outcome).toBe('failed');
    const run = await b.store.getRun(runId);
    expect(run?.phase).toBe('failed');
    expect(run?.phase_reason).toMatch(/^AgentRunError: /);
    expect((await listenerPhaseLines(runId)).map((d) => d.phase)).toEqual(['failed']);
    expect(run?.usage.find((u) => u.seq === 1)?.final).toBe(true);
  });
});

describe('a steer that runs as its own response, read by nobody', () => {
  test('its submission_running moves completed back to investigating, and its settle completes the run', async () => {
    const runId = nextRunId('settle_steer_own');
    const initial = triageInit(runId);
    await createRun(b.store, initial);
    scriptAgents(fake, {
      triage: [finish(reportDraft(initial)), text('report written'), finish(reportDraft(initial)), text('report updated')],
    });
    await dispatchUnread(runId, initial);
    expect((await b.store.getRun(runId))?.phase).toBe('completed');

    const seq = await b.store.addSubmission(runId, redactPersisted({ kind: 'steer' as const, note: 'check the payout too' }));
    const seen: Envelope[] = [];
    let resolveSettled: () => void = () => undefined;
    const settledSeen = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let steerId = '';
    const off = observe((o: FlueObservation) => {
      const e = o as unknown as Envelope;
      if (e.instanceId !== runId) return;
      if (e.type === 'submission_running') seen.push(e);
      if (e.type === 'submission_settled' && e.submissionId === steerId && steerId !== '') resolveSettled();
    });
    // A grace long enough for the receipt's id to be stored before the listener reads the run, as in production.
    installSettleListener({ store: () => b.store, runsDir: home.config.paths.runsDir, graceMs: 200 });
    try {
      const receipt = await init(b.Triage, { id: runId }).dispatch({
        // A steer is a user message, as resumeRun sends it (D72).
        message: { kind: 'user', body: 'Note from oncall-ops: check the payout too.' },
      });
      steerId = receipt.submissionId;
      await b.store.setSubmissionFlueId(runId, seq, steerId);
      await settledSeen;
      await flushSettleListener();
      await flushRunEventLog();
    } finally {
      off();
      installSettleListener({ store: () => b.store, runsDir: home.config.paths.runsDir, graceMs: 0 });
    }

    expect(fake.failures()).toEqual([]);
    expect(seen.find((e) => e.submissionId === steerId)).toMatchObject({ instanceId: runId, submissionId: steerId, attemptCount: 1 });
    const run = await b.store.getRun(runId);
    expect(run?.phase).toBe('completed');
    expect((await listenerPhaseLines(runId)).map((d) => d.phase)).toEqual(['completed', 'investigating', 'completed']);
    expect((await listenerPhaseLines(runId))[1]).toMatchObject({ submission_seq: seq, steer: 'own_response' });
    expect(run?.usage.find((u) => u.seq === seq)?.final).toBe(true);
  });
});
