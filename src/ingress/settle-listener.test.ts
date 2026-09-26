// The settle listener (D70) with a fake observe(): events are fed in by hand,
// the run store is a folder store in a temp dir, and the run event log writes
// to the same runs dir so the 'dispatch' lines map a submission to its seq.
// No Flue runtime, model or network is involved.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import type { SubmissionLease } from '../db/submission-lease.ts';
import type { Embedder } from '../embed/index.ts';
import { redactPersisted } from '../gate/redact.ts';
import { flushRunEventLog, installRunEventLog, logRunEvent, uninstallRunEventLog } from '../runlog/event-log.ts';
import { readRunEvents } from '../runlog/read.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import type { RunPhase, RunStore, SubmissionInput } from '../runstore/types.ts';
import type { TriageRequest } from '../types/request.ts';
import type { UsageRow } from '../types/usage.ts';
import { recordUsage, resetUsageMeterForTests, snapshotSubmission } from '../usage/meter.ts';
import type { EmbedRunFn } from './submit.ts';
import {
  droppedSettles,
  flushSettleListener,
  installSettleListener,
  SETTLE_LISTENER_VIA,
  settleListenerInstalled,
  uninstallSettleListenerForTests,
} from './settle-listener.ts';

const SUB_1 = 'sub_01JSETTLEAAAAAAAAAAAAAAAA1';
const SUB_2 = 'sub_01JSETTLEAAAAAAAAAAAAAAAA2';
const MODEL = 'faux/cheap';

let dir: string;
let runsDir: string;
let store: RunStore;
let emit: (o: Record<string, unknown>, ctx?: Partial<FlueEventContext>) => void;
let runSeq = 0;
/** The runs the fake embedRun was called for, with the embedder it got. */
let embedded: { runId: string; embedder: Embedder | null }[];
/** The leases the listener's lease reader answers, by Flue id. */
let leaseMap: Record<string, SubmissionLease>;

const FAKE_EMBEDDER = { model: 'faux/embed' } as unknown as Embedder;

/** Set by a test: the fake embed call reports this many input tokens, counted as usage. */
let embedTokens: number | undefined;

const fakeEmbedRun: EmbedRunFn = async (_store, embedder, runId, options) => {
  embedded.push({ runId, embedder });
  if (embedTokens !== undefined) options?.onUsage?.({ model: 'faux/embed', inputTokens: embedTokens, failed: false });
  return { written: [], unchanged: [], empty: [], gaps: ['a gap'] };
};

function request(runId: string): TriageRequest {
  return {
    request_id: runId,
    interface: 'cli',
    requested_by: 'ops@example.test',
    source: { kind: 'text' },
    messages: [{ ts: '1726826400.000100', author: 'U000TEST', text: 'transfer not received', is_parent: true }],
    attachments: [],
    hints: {},
    window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-23T00:00:00.000Z' },
    received_at: '2026-09-23T10:00:00.000Z',
  } as TriageRequest;
}

/** A run with one dispatched submission (seq 1, SUB_1) in the given phase, as dispatchAndSettle leaves it. */
async function runIn(phase: RunPhase, opts: { dispatchLine?: boolean } = {}): Promise<string> {
  runSeq += 1;
  const runId = `01JSETTLE${String(runSeq).padStart(17, 'A')}`.slice(0, 26);
  await store.createRun(runId, redactPersisted(request(runId)));
  await addSubmission(runId, { kind: 'initial' }, SUB_1, opts.dispatchLine !== false);
  await store.setPhase(runId, 'investigating');
  if (phase !== 'investigating') await store.setPhase(runId, phase);
  return runId;
}

async function addSubmission(runId: string, input: SubmissionInput, submissionId: string, dispatchLine = true): Promise<number> {
  const seq = await store.addSubmission(runId, redactPersisted(input));
  if (dispatchLine) logRunEvent(runId, 'dispatch', { submission_seq: seq, kind: input.kind, submission_id: submissionId });
  await flushRunEventLog();
  return seq;
}

function settled(runId: string, submissionId: string, outcome: 'completed' | 'failed' | 'aborted', extra: Record<string, unknown> = {}) {
  emit({ type: 'submission_settled', instanceId: runId, submissionId, outcome, timestamp: new Date().toISOString(), ...extra });
}

async function settle(): Promise<void> {
  await flushSettleListener();
  await flushRunEventLog();
}

async function phaseOf(runId: string): Promise<{ phase: RunPhase; reason?: string }> {
  const run = await store.getRun(runId);
  if (run === null) throw new Error('no run');
  return { phase: run.phase, ...(run.phase_reason !== undefined ? { reason: run.phase_reason } : {}) };
}

async function pipelineLines(runId: string, type: string) {
  const page = await readRunEvents(runsDir, runId, { limit: 5000 });
  return page.events.filter((e) => e.source === 'pipeline' && e.type === type).map((e) => e.data as Record<string, unknown>);
}

/** One row; every counted turn here has one output token. */
function row(calls: number, input: number): UsageRow {
  return {
    model: MODEL,
    agent: 'triage',
    purpose: 'agent',
    calls,
    failed_calls: 0,
    input_tokens: input,
    output_tokens: calls,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usd: null,
  };
}

function countTurn(runId: string, submissionId: string, input: number): void {
  recordUsage(runId, { submissionId }, {
    model: MODEL,
    agent: 'triage',
    purpose: 'agent',
    isError: false,
    input,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    usd: null,
  });
}

function install(storeFn: () => RunStore | Promise<RunStore> = () => store): void {
  installSettleListener({
    store: storeFn,
    runsDir,
    graceMs: 0,
    embedder: () => FAKE_EMBEDDER,
    embedRun: fakeEmbedRun,
    lease: async (id) => leaseMap[id] ?? null,
    observe: (subscriber) => {
      emit = (o, ctx) => subscriber(o as unknown as FlueObservation, (ctx ?? {}) as FlueEventContext);
      return () => undefined;
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'triage-settle-'));
  runsDir = join(dir, 'runs');
  store = createFolderRunStore({ runsDir, dataDir: join(dir, 'data') });
  installRunEventLog({ runsDir, observe: () => () => undefined });
  resetUsageMeterForTests();
  embedded = [];
  embedTokens = undefined;
  leaseMap = {};
  install();
});

afterEach(async () => {
  await settle();
  uninstallSettleListenerForTests();
  uninstallRunEventLog();
  resetUsageMeterForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('installSettleListener', () => {
  test('subscribes once; a second call only updates the options', () => {
    let subscribed = 0;
    uninstallSettleListenerForTests();
    const observe = () => {
      subscribed += 1;
      return () => undefined;
    };
    installSettleListener({ store: () => store, observe });
    installSettleListener({ store: () => store, observe });
    expect(subscribed).toBe(1);
    expect(settleListenerInstalled()).toBe(true);
    uninstallSettleListenerForTests();
    expect(settleListenerInstalled()).toBe(false);
  });
});

describe('the phase follows the settle', () => {
  test('a failed settle moves investigating to failed with a D67 reason', async () => {
    const runId = await runIn('investigating');
    settled(runId, SUB_1, 'failed', { error: { name: 'SubmissionRetryExhaustedError', message: 'submission_retry_exhausted after 2 attempts' } });
    await settle();
    const { phase, reason } = await phaseOf(runId);
    expect(phase).toBe('failed');
    expect(reason).toStartWith('AgentRunError: ');
    expect(reason).toContain('submission_retry_exhausted after 2 attempts');
    const phases = await pipelineLines(runId, 'phase');
    expect(phases.at(-1)).toMatchObject({ phase: 'failed', via: SETTLE_LISTENER_VIA, reason });
    expect((await pipelineLines(runId, 'settled')).at(-1)).toMatchObject({ status: 'failed', submission_seq: 1, via: SETTLE_LISTENER_VIA });
  });

  test('an aborted settle moves dispatched to failed, marked aborted', async () => {
    const runId = await runIn('dispatched');
    settled(runId, SUB_1, 'aborted');
    await settle();
    const { phase, reason } = await phaseOf(runId);
    expect(phase).toBe('failed');
    expect(reason).toStartWith('AgentRunError (aborted)');
  });

  test('a completed settle moves investigating to completed', async () => {
    const runId = await runIn('investigating');
    settled(runId, SUB_1, 'completed');
    await settle();
    expect(await phaseOf(runId)).toEqual({ phase: 'completed' });
    expect((await pipelineLines(runId, 'phase')).at(-1)).toMatchObject({ phase: 'completed', via: SETTLE_LISTENER_VIA });
  });

  test('the run id comes from ctx.id when the event has no instanceId', async () => {
    const runId = await runIn('investigating');
    emit({ type: 'submission_settled', submissionId: SUB_1, outcome: 'completed' }, { id: runId });
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
  });
});

describe('phases the settle never changes', () => {
  const LEFT: readonly RunPhase[] = ['stopped', 'completed', 'failed', 'needs_input', 'blocked'];
  for (const outcome of ['completed', 'failed', 'aborted'] as const) {
    for (const phase of LEFT) {
      test(`${outcome} leaves ${phase} alone`, async () => {
        const runId = await runIn(phase);
        const before = await phaseOf(runId);
        const linesBefore = (await pipelineLines(runId, 'phase')).length;
        settled(runId, SUB_1, outcome, outcome === 'completed' ? {} : { error: { message: 'boom' } });
        await settle();
        expect(await phaseOf(runId)).toEqual(before);
        expect(await pipelineLines(runId, 'phase')).toHaveLength(linesBefore);
      });
    }
  }

  test('completed leaves dispatched alone', async () => {
    const runId = await runIn('dispatched');
    settled(runId, SUB_1, 'completed');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('dispatched');
  });

  test('the normal path wrote first: the listener writes nothing more', async () => {
    const runId = await runIn('investigating');
    await store.setPhase(runId, 'failed', { reason: 'AgentRunError: from read()' });
    settled(runId, SUB_1, 'failed', { error: { message: 'other text' } });
    await settle();
    expect(await phaseOf(runId)).toEqual({ phase: 'failed', reason: 'AgentRunError: from read()' });
    expect(await pipelineLines(runId, 'settled')).toEqual([]);
  });

  test('two settles of one run (a host and a joined steer) write once', async () => {
    const runId = await runIn('investigating');
    await addSubmission(runId, { kind: 'steer', note: 'look at the ledger too' }, SUB_2);
    settled(runId, SUB_1, 'completed');
    settled(runId, SUB_2, 'completed');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
    expect((await pipelineLines(runId, 'phase')).filter((d) => d.via === SETTLE_LISTENER_VIA)).toHaveLength(1);
  });
});

describe('a settle the run has moved past', () => {
  test('a later ask owns the phase: the old settle is left alone', async () => {
    const runId = await runIn('completed');
    await addSubmission(runId, { kind: 'ask', question: 'and the refund?' }, SUB_2);
    await store.setPhase(runId, 'investigating');
    settled(runId, SUB_1, 'failed', { error: { message: 'late' } });
    await settle();
    expect((await phaseOf(runId)).phase).toBe('investigating');
  });

  test('a later submission not yet dispatched counts too', async () => {
    const runId = await runIn('stopped');
    await addSubmission(runId, { kind: 'resume', note: 'go on' }, SUB_2, false);
    await store.setPhase(runId, 'dispatched', { resume: true });
    settled(runId, SUB_1, 'aborted');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('dispatched');
  });

  test('a later steer does not: the host settle still moves the run', async () => {
    const runId = await runIn('investigating');
    await addSubmission(runId, { kind: 'steer', note: 'check the ledger' }, SUB_2);
    settled(runId, SUB_1, 'completed');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
  });

  test('the stored Flue id gives the seq when there is no dispatch line', async () => {
    const runId = await runIn('completed', { dispatchLine: false });
    await store.setSubmissionFlueId(runId, 1, SUB_1);
    const seq = await addSubmission(runId, { kind: 'ask', question: 'and the refund?' }, SUB_2, false);
    await store.setSubmissionFlueId(runId, seq, SUB_2);
    await store.setPhase(runId, 'investigating');
    settled(runId, SUB_1, 'failed', { timestamp: new Date(Date.now() + 60_000).toISOString() });
    await settle();
    expect((await phaseOf(runId)).phase).toBe('investigating');
    settled(runId, SUB_2, 'completed');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
  });

  test('with no dispatch line, a submission created after the settle counts', async () => {
    const runId = await runIn('investigating', { dispatchLine: false });
    const at = new Date(Date.now() - 60_000).toISOString();
    await addSubmission(runId, { kind: 'ask', question: 'again?' }, SUB_2, false);
    settled(runId, SUB_1, 'failed', { timestamp: at });
    await settle();
    expect((await phaseOf(runId)).phase).toBe('investigating');
  });

  test('with no dispatch line and nothing later, the settle still moves the run', async () => {
    const runId = await runIn('investigating', { dispatchLine: false });
    settled(runId, SUB_1, 'completed');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
  });
});

describe('usage', () => {
  test('a recovery settle writes the stored rows and the recovering attempt final, then drops them', async () => {
    const runId = await runIn('investigating');
    // The first attempt's live flush, from the process that is gone.
    await store.putUsage(runId, 1, [row(2, 100)], false);
    emit({ type: 'submission_running', instanceId: runId, submissionId: SUB_1, attemptCount: 2, maxAttempts: 2 });
    countTurn(runId, SUB_1, 30);
    settled(runId, SUB_1, 'failed', { error: { message: 'submission_retry_exhausted' } });
    await settle();
    const usage = (await store.getRun(runId))?.usage.find((u) => u.seq === 1);
    expect(usage?.final).toBe(true);
    expect(usage?.rows).toEqual([row(3, 130)]);
    expect(snapshotSubmission(runId, SUB_1)).toEqual([]);
  });

  test('a settle with no attempt seen here marks the stored rows final as they are', async () => {
    const runId = await runIn('investigating');
    await store.putUsage(runId, 1, [row(2, 100)], false);
    settled(runId, SUB_1, 'failed');
    await settle();
    const usage = (await store.getRun(runId))?.usage.find((u) => u.seq === 1);
    expect(usage).toMatchObject({ final: true, rows: [row(2, 100)] });
  });

  test('when this process ran the first attempt, the meter rows are written as they are and kept', async () => {
    const runId = await runIn('investigating');
    await store.putUsage(runId, 1, [row(1, 10)], false);
    emit({ type: 'submission_running', instanceId: runId, submissionId: SUB_1, attemptCount: 1, maxAttempts: 2 });
    countTurn(runId, SUB_1, 10);
    countTurn(runId, SUB_1, 20);
    settled(runId, SUB_1, 'completed');
    await settle();
    const usage = (await store.getRun(runId))?.usage.find((u) => u.seq === 1);
    expect(usage).toMatchObject({ final: true, rows: [row(2, 30)] });
    expect(snapshotSubmission(runId, SUB_1)).toEqual([row(2, 30)]);
  });

  test('final rows the normal path wrote are left as they are', async () => {
    const runId = await runIn('completed');
    await store.putUsage(runId, 1, [row(5, 500)], true);
    countTurn(runId, SUB_1, 1);
    settled(runId, SUB_1, 'completed');
    await settle();
    expect((await store.getRun(runId))?.usage.find((u) => u.seq === 1)?.rows).toEqual([row(5, 500)]);
  });

  test('a stopped run still gets its settled usage final', async () => {
    const runId = await runIn('stopped');
    await store.putUsage(runId, 1, [row(1, 10)], false);
    settled(runId, SUB_1, 'aborted');
    await settle();
    expect((await store.getRun(runId))?.usage.find((u) => u.seq === 1)?.final).toBe(true);
    expect((await phaseOf(runId)).phase).toBe('stopped');
  });
});

describe('the compare-and-set', () => {
  test('a needs_input written after the listener read the run is not overwritten', async () => {
    const runId = await runIn('investigating');
    // The tool parks the run between the listener's read and its write.
    const racing: RunStore = {
      ...store,
      getRun: async (id) => {
        const run = await store.getRun(id);
        await store.setPhase(id, 'needs_input');
        return run;
      },
      setPhaseIf: (...a) => store.setPhaseIf(...a),
      putUsage: (...a) => store.putUsage(...a),
    };
    uninstallSettleListenerForTests();
    install(() => racing);
    settled(runId, SUB_1, 'completed');
    await settle();
    expect((await phaseOf(runId)).phase).toBe('needs_input');
    expect((await pipelineLines(runId, 'phase')).filter((d) => d.via === SETTLE_LISTENER_VIA)).toEqual([]);
    expect(await pipelineLines(runId, 'settled')).toEqual([]);
    expect(embedded).toEqual([]);
  });
});

describe('the embedding after a settle it writes', () => {
  test('a completed or failed write embeds the run, counts the call on the submission and logs the gaps', async () => {
    const runId = await runIn('investigating');
    embedTokens = 7;
    settled(runId, SUB_1, 'completed');
    await settle();
    expect(embedded).toEqual([{ runId, embedder: FAKE_EMBEDDER }]);
    expect((await pipelineLines(runId, 'settled')).at(-1)).toMatchObject({ status: 'completed', gaps: ['a gap'], via: SETTLE_LISTENER_VIA });
    const usage = (await store.getRun(runId))?.usage.find((u) => u.seq === 1);
    expect(usage?.final).toBe(true);
    expect(usage?.rows).toEqual([
      { ...row(1, 7), model: 'faux/embed', agent: 'embedder', purpose: 'embed', output_tokens: 0, usd: 0 },
    ]);

    const failed = await runIn('dispatched');
    settled(failed, SUB_1, 'aborted');
    await settle();
    expect(embedded.map((e) => e.runId)).toEqual([runId, failed]);
  });

  test('a settle it does not write embeds nothing', async () => {
    const runId = await runIn('completed');
    settled(runId, SUB_1, 'completed');
    const parked = await runIn('needs_input');
    settled(parked, SUB_1, 'completed');
    await settle();
    expect(embedded).toEqual([]);
  });

  test('the embedder is built once, on the first settle that embeds', async () => {
    let built = 0;
    uninstallSettleListenerForTests();
    installSettleListener({
      store: () => store,
      runsDir,
      graceMs: 0,
      embedder: () => {
        built += 1;
        return null;
      },
      embedRun: fakeEmbedRun,
      observe: (subscriber) => {
        emit = (o, ctx) => subscriber(o as unknown as FlueObservation, (ctx ?? {}) as FlueEventContext);
        return () => undefined;
      },
    });
    expect(built).toBe(0);
    settled(await runIn('investigating'), SUB_1, 'completed');
    settled(await runIn('investigating'), SUB_1, 'failed');
    await settle();
    expect(built).toBe(1);
    expect(embedded.map((e) => e.embedder)).toEqual([null, null]);
  });
});

describe('a steer that runs as its own response', () => {
  function running(runId: string, submissionId: string, attemptCount = 1): void {
    emit({ type: 'submission_running', instanceId: runId, submissionId, kind: 'dispatch', attemptCount, maxAttempts: 2 });
  }

  for (const phase of ['completed', 'failed'] as const) {
    test(`moves ${phase} back to investigating, and its settle then completes the run`, async () => {
      const runId = await runIn(phase);
      if (phase === 'failed') await store.setPhase(runId, 'failed', { reason: 'AgentRunError: host' });
      const seq = await addSubmission(runId, { kind: 'steer', note: 'check the payout too' }, SUB_2);
      await store.setSubmissionFlueId(runId, seq, SUB_2);
      running(runId, SUB_2);
      await settle();
      expect(await phaseOf(runId)).toEqual({ phase: 'investigating' });
      expect((await pipelineLines(runId, 'phase')).at(-1)).toMatchObject({
        phase: 'investigating',
        submission_seq: seq,
        steer: 'own_response',
        via: SETTLE_LISTENER_VIA,
      });

      settled(runId, SUB_2, 'completed');
      await settle();
      expect(await phaseOf(runId)).toEqual({ phase: 'completed' });
      expect((await pipelineLines(runId, 'settled')).at(-1)).toMatchObject({ submission_seq: seq, status: 'completed' });
    });
  }

  test('the host settle and the steer start, handled in order, end investigating', async () => {
    const runId = await runIn('investigating');
    await addSubmission(runId, { kind: 'steer', note: 'and the ledger' }, SUB_2);
    settled(runId, SUB_1, 'completed');
    running(runId, SUB_2);
    await settle();
    expect((await phaseOf(runId)).phase).toBe('investigating');
  });

  test('its failure is handled: the run fails', async () => {
    const runId = await runIn('completed');
    await addSubmission(runId, { kind: 'steer', note: 'and the ledger' }, SUB_2);
    running(runId, SUB_2);
    settled(runId, SUB_2, 'failed', { error: { message: 'model gone' } });
    await settle();
    const { phase, reason } = await phaseOf(runId);
    expect(phase).toBe('failed');
    expect(reason).toContain('model gone');
  });

  test('a joined steer never moves the run', async () => {
    const runId = await runIn('completed');
    await addSubmission(runId, { kind: 'steer', note: 'and the ledger' }, SUB_2);
    leaseMap[SUB_2] = { status: 'joined', leaseExpiresAt: 0, joinedInto: SUB_1 };
    running(runId, SUB_2);
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
    leaseMap[SUB_2] = { status: 'settled', leaseExpiresAt: 0, joinedInto: SUB_1, settledAt: Date.now() };
    running(runId, SUB_2);
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
  });

  test('a head that starts running is left alone', async () => {
    const runId = await runIn('completed');
    running(runId, SUB_1);
    const ask = await runIn('completed');
    await addSubmission(ask, { kind: 'ask', question: 'and the refund?' }, SUB_2);
    running(ask, SUB_2);
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
    expect((await phaseOf(ask)).phase).toBe('completed');
  });

  test('a stopped, parked or unknown run, or a steer a later submission passed, is left alone', async () => {
    for (const phase of ['stopped', 'needs_input', 'blocked'] as const) {
      const runId = await runIn(phase);
      await addSubmission(runId, { kind: 'steer', note: 'x' }, SUB_2);
      running(runId, SUB_2);
      await settle();
      expect((await phaseOf(runId)).phase).toBe(phase);
    }
    const passed = await runIn('completed');
    await addSubmission(passed, { kind: 'steer', note: 'x' }, SUB_2);
    await addSubmission(passed, { kind: 'ask', question: 'y' }, 'sub_01JSETTLEAAAAAAAAAAAAAAAA3', false);
    running(passed, SUB_2);
    running('01JSETTLEUNKNOWNAAAAAAAAAA', SUB_2);
    await settle();
    expect((await phaseOf(passed)).phase).toBe('completed');
    expect(droppedSettles()).toBe(0);
  });

  test('a steer with no Flue id stored and no dispatch line is not recognised', async () => {
    const runId = await runIn('completed');
    await addSubmission(runId, { kind: 'steer', note: 'x' }, SUB_2, false);
    running(runId, SUB_2);
    await settle();
    expect((await phaseOf(runId)).phase).toBe('completed');
  });
});

describe('what the listener ignores and survives', () => {
  test('an unknown run is ignored', async () => {
    settled('01JSETTLEUNKNOWNAAAAAAAAAA', SUB_1, 'failed');
    await settle();
    expect(droppedSettles()).toBe(0);
  });

  test('events that are not a run settle are ignored', async () => {
    const runId = await runIn('investigating');
    emit({ type: 'submission_settled', instanceId: 'not a run id!', submissionId: SUB_1, outcome: 'completed' });
    emit({ type: 'submission_settled', instanceId: runId, outcome: 'completed' });
    emit({ type: 'submission_settled', instanceId: runId, submissionId: SUB_1, outcome: 'weird' });
    emit({ type: 'turn', instanceId: runId, submissionId: SUB_1 });
    await settle();
    expect((await phaseOf(runId)).phase).toBe('investigating');
    expect(droppedSettles()).toBe(0);
  });

  test('a store error is swallowed, counted and logged', async () => {
    const runId = await runIn('investigating');
    class StoreDownError extends Error {}
    uninstallSettleListenerForTests();
    install(() => ({ getRun: async () => Promise.reject(new StoreDownError('pool gone')) }) as unknown as RunStore);
    expect(() => settled(runId, SUB_1, 'failed')).not.toThrow();
    await settle();
    expect(droppedSettles()).toBe(1);
    expect(await pipelineLines(runId, 'settle_listener_failed')).toEqual([{ submission_id: SUB_1, error: 'StoreDownError' }]);
    expect((await phaseOf(runId)).phase).toBe('investigating');
  });

  test('a store that cannot be built is swallowed too', async () => {
    const runId = await runIn('investigating');
    uninstallSettleListenerForTests();
    install(() => {
      throw new Error('config did not load');
    });
    settled(runId, SUB_1, 'completed');
    await settle();
    expect(droppedSettles()).toBe(1);
  });

  test('a subscriber that throws inside is counted, never thrown to Flue', () => {
    const bad = { get type(): string {
      throw new Error('bad event');
    } };
    expect(() => emit(bad as unknown as Record<string, unknown>)).not.toThrow();
    expect(droppedSettles()).toBe(1);
  });
});
