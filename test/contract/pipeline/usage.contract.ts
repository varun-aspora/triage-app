// Pipeline contract: every model call of a run is counted in the run store
// (D59; plan 3.3-3.10 and section 5).
//
// Each case goes through the eval driver (runCase), and the follow-ups go
// through askRun and answerRun from src/ingress/submit.ts, with the fake model,
// strict mock mode and no network. The home is booted once with:
// - TRIAGE_USAGE_FLUSH_MS=2000, the lowest allowed, so a run that waits
//   between turns has its counts written before it settles;
// - TRIAGE_PRIOR_CASES=true and MODEL_EMBEDDING=ollama/..., which mock mode
//   turns into the hash embedder, recorded as faux/hash-embed.
//
// What is checked:
// - a cheap run that escalates has rows for the classifier and the embedder on
//   seq 0, and for triage, the delegate, the synthesis and the embedder on
//   seq 1; the synthesis row equals the usage Flue reports for its prompt
//   operation (what harness.prompt() returns as response.usage);
// - a follow-up ask adds seq 2 and leaves seq 1 as it was;
// - a run parked on needs_input and then answered has rows for both submissions;
// - a stopped run and a failed run (the fake model throws) have final rows;
// - the store holds non-final rows while the run is still running;
// - report.cost.usd_total is 0 on faux and cost_partial is false.

import { type FlueObservation, observe } from '@flue/runtime';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { triageRuntime } from '../../../src/agents/triage-plan.ts';
import { fauxScript } from '../../../src/evals/contract/faux-script.ts';
import { type CaseResult, bootEvalRuntime, evalRuntime, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { stopRun } from '../../../src/ingress/stop.ts';
import { answerRun, askRun, HASH_USAGE_MODEL, submissionDeps, type SettleDeps } from '../../../src/ingress/submit.ts';
import { ULID_RE } from '../../../src/ingress/ulid.ts';
import { createFakeModel, type FakeStep, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import type { RunRecord, RunStore } from '../../../src/runstore/types.ts';
import { ASK_REQUESTER } from '../../../src/tools/ask-requester.tool.ts';
import type { RunId } from '../../../src/types/core.ts';
import type { SubmissionUsage, UsageRow } from '../../../src/types/usage.ts';
import { brief, evalHome, reportDraft } from '../eval-support.ts';
import { findingsFixture, reportCase } from '../report/report-support.ts';

// Fixed ids with no run of six digits, so the stored report keeps its run_id.
const RUN_IDS = Object.freeze({
  escalate: '01JPQ7PAPAVSGAAAAAAAAAAAA1',
  follow_up: '01JPQ7PAPAVSGAAAAAAAAAAAA2',
  needs_input: '01JPQ7PAPAVSGAAAAAAAAAAAA3',
  stopped: '01JPQ7PAPAVSGAAAAAAAAAAAA4',
  failed: '01JPQ7PAPAVSGAAAAAAAAAAAA5',
  live: '01JPQ7PAPAVSGAAAAAAAAAAAA6',
}) satisfies Record<string, RunId>;

const FLUSH_MS = 2000;
const EMBEDDING = 'ollama/nomic-embed-text';
const BY = 'ops-reviewer';
const QUESTION = { question: 'Which card is this about: the debit card or the credit card?', why: 'Both cards appear in the thread.' };

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Envelope = Record<string, unknown>;

const fake = createFakeModel();
const home = evalHome();
const c = reportCase('cheap');
const draft = reportDraft(c.expected.tier);
// Every Flue envelope of the runs in this file, for the synthesis oracle.
const envelopes: Envelope[] = [];
let unobserve: (() => void) | undefined;
let deps: SettleDeps;

beforeAll(async () => {
  await bootEvalRuntime({
    faux: fake,
    overrides: { TRIAGE_USAGE_FLUSH_MS: String(FLUSH_MS), TRIAGE_PRIOR_CASES: 'true', MODEL_EMBEDDING: EMBEDDING },
  });
  const ids = new Set<string>(Object.values(RUN_IDS));
  unobserve = observe((o: FlueObservation) => {
    const e = o as unknown as Envelope;
    if (typeof e.instanceId === 'string' && ids.has(e.instanceId)) envelopes.push(e);
  });
  deps = submissionDeps({ runtime: triageRuntime(), fetch: () => Promise.reject(new Error('evals make no network calls')) });
});

afterAll(async () => {
  unobserve?.();
  await stopEvalRuntime();
  home.dispose();
});

// ------------------------------------------------------------------ helpers

function store(): RunStore {
  const rt = evalRuntime();
  if (rt === undefined) throw new Error('the eval runtime is not booted');
  return rt.store;
}

async function storedRun(runId: RunId): Promise<RunRecord> {
  const run = await store().getRun(runId);
  if (run === null) throw new Error('the run is not in the store');
  return run;
}

function atSeq(run: RunRecord, seq: number): SubmissionUsage | undefined {
  return run.usage.find((u) => u.seq === seq);
}

/** [model, agent, purpose] of each row of a seq, in store order. */
function keysAt(run: RunRecord, seq: number): [string, string, string][] {
  return (atSeq(run, seq)?.rows ?? []).map((r) => [r.model, r.agent, r.purpose]);
}

function rowFor(run: RunRecord, seq: number, agent: string): UsageRow | undefined {
  return atSeq(run, seq)?.rows.find((r) => r.agent === agent);
}

const tokensOf = (row: UsageRow | undefined): Usage => ({
  input: row?.input_tokens ?? -1,
  output: row?.output_tokens ?? -1,
  cacheRead: row?.cache_read_tokens ?? -1,
  cacheWrite: row?.cache_write_tokens ?? -1,
});

function usageOf(u: unknown): Usage {
  const x = (u ?? {}) as Partial<Usage>;
  return { input: x.input ?? 0, output: x.output ?? 0, cacheRead: x.cacheRead ?? 0, cacheWrite: x.cacheWrite ?? 0 };
}

/** Seq 0 of every run here: the classifier call and the prior-cases embedding. */
const INTAKE: [string, string, string][] = [
  ['faux/classifier', 'classifier', 'classify'],
  [HASH_USAGE_MODEL, 'embedder', 'embed'],
];

function expectIntake(run: RunRecord): void {
  expect(atSeq(run, 0)?.final).toBe(true);
  expect(keysAt(run, 0)).toEqual(INTAKE);
  expect(rowFor(run, 0, 'classifier')).toMatchObject({ calls: 1, failed_calls: 0, usd: 0 });
  expect(rowFor(run, 0, 'embedder')).toMatchObject({ calls: 1, failed_calls: 0, input_tokens: 0, usd: 0 });
}

/** Installs a script for a follow-up, which runCase does not drive. */
function scriptFollowUp(turns: Record<string, readonly FakeStep[]>) {
  const rt = evalRuntime();
  if (rt === undefined) throw new Error('the eval runtime is not booted');
  const script = fauxScript(turns);
  script.install(rt.faux);
  return script;
}

const delegateTurns = (): Record<string, readonly FakeStep[]> => ({
  investigate_ssfb: [toolCall('note_evidence', findingsFixture('medium')), text('recorded')],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ set-up checks

test('the fixed run ids are ULIDs with no run of six digits', () => {
  for (const id of Object.values(RUN_IDS)) {
    expect(id).toMatch(ULID_RE);
    expect(id).not.toMatch(/\d{6}/);
  }
});

// ------------------------------------------------------------------ one full run

describe('a cheap run with a delegate that escalates to the strong synthesis', () => {
  let r: CaseResult;
  let run: RunRecord;

  beforeAll(async () => {
    r = await runCase(c, {
      runId: RUN_IDS.escalate,
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(draft), text('report written')],
        investigate_ssfb: [toolCall('note_evidence', findingsFixture('low')), text('recorded, low confidence')],
        synthesis: [toolCall('finish', { ...draft, confidence: 'low', confidence_reason: 'rebuilt on the strong model' })],
      },
    });
    run = await storedRun(RUN_IDS.escalate);
  });

  test('the run completes, escalated, with a $0 cost that is not partial', () => {
    expect(r.status).toBe('completed');
    expect(r.faux_failures).toEqual([]);
    expect(r.report?.escalated).toBe(true);
    expect(r.cost_usd).toBe(0);
    expect(r.cost_partial).toBe(false);
    expect(r.report?.cost?.usd_total).toBe(0);
    expect(r.report?.cost?.unpriced_models).toBeUndefined();
  });

  test('seq 0 holds the classifier and the prior-cases embedding', () => {
    expectIntake(run);
  });

  test('seq 1 holds triage, the delegate, the synthesis and the embedding after the settle, all final', () => {
    expect(run.usage.map((u) => u.seq)).toEqual([0, 1]);
    expect(atSeq(run, 1)?.final).toBe(true);
    expect(keysAt(run, 1)).toEqual([
      ['faux/cheap', 'investigate_ssfb', 'agent'],
      ['faux/cheap', 'triage', 'agent'],
      [HASH_USAGE_MODEL, 'embedder', 'embed'],
      ['faux/strong', 'synthesis', 'agent'],
    ]);
    expect(rowFor(run, 1, 'triage')).toMatchObject({ calls: 3, failed_calls: 0 });
    expect(rowFor(run, 1, 'investigate_ssfb')).toMatchObject({ calls: 2, failed_calls: 0 });
    expect(rowFor(run, 1, 'synthesis')).toMatchObject({ calls: 1, failed_calls: 0 });
    expect(rowFor(run, 1, 'embedder')?.calls).toBeGreaterThan(0);
    expect(atSeq(run, 1)?.rows.every((row) => row.usd === 0)).toBe(true);
  });

  test('the synthesis row equals the usage of its prompt operation', () => {
    const turns = envelopes.filter((e) => e.instanceId === RUN_IDS.escalate && e.type === 'turn');
    const strong = turns.filter((t) => (t.request as { requestedModel?: string }).requestedModel === 'strong');
    expect(strong).toHaveLength(1);
    const op = envelopes.find((e) => e.type === 'operation' && e.operationId === strong[0]?.operationId);
    expect(op?.usage).toBeDefined();
    expect(tokensOf(rowFor(run, 1, 'synthesis'))).toEqual(usageOf(op?.usage));
  });

  test('the report cost covers the submission in memory: not the intake, which was written before dispatch', () => {
    // The embedding after the settle comes after the report, so it is left out too.
    expect(Object.keys(r.report?.cost?.models ?? {}).sort()).toEqual(['faux/cheap', 'faux/strong']);
  });

  test('listRuns sums the rows', async () => {
    const summary = (await store().listRuns({ limit: 50 })).find((s) => s.run_id === RUN_IDS.escalate);
    expect(summary?.usd_total).toBe(0);
    const tokens = run.usage
      .flatMap((u) => u.rows)
      .reduce((n, row) => n + row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens, 0);
    expect(summary?.tokens_total).toBe(tokens);
  });
});

// ------------------------------------------------------------------ follow-up

describe('a follow-up ask', () => {
  let before: RunRecord;
  let after: RunRecord;
  let seq: number;

  beforeAll(async () => {
    const first = await runCase(c, {
      runId: RUN_IDS.follow_up,
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(draft), text('report written')],
        ...delegateTurns(),
      },
    });
    expect(first.status).toBe('completed');
    before = await storedRun(RUN_IDS.follow_up);
    const script = scriptFollowUp({ root: [finish(draft), text('follow-up written')] });
    const result = await askRun(RUN_IDS.follow_up, 'And what about the second card?', BY, deps);
    expect(result.status).toBe('completed');
    expect(script.failures()).toEqual([]);
    seq = result.submission_seq;
    after = await storedRun(RUN_IDS.follow_up);
  });

  test('adds seq 2 with its own final rows', () => {
    expect(seq).toBe(2);
    expect(after.usage.map((u) => u.seq)).toEqual([0, 1, 2]);
    expect(atSeq(after, 2)?.final).toBe(true);
    expect(keysAt(after, 2)).toEqual([
      ['faux/cheap', 'triage', 'agent'],
      [HASH_USAGE_MODEL, 'embedder', 'embed'],
    ]);
    expect(rowFor(after, 2, 'triage')).toMatchObject({ calls: 2, failed_calls: 0 });
  });

  test('keeps seq 0 and seq 1 as they were', () => {
    expect(atSeq(after, 0)).toEqual(atSeq(before, 0));
    expect(atSeq(after, 1)).toEqual(atSeq(before, 1));
    expect(rowFor(after, 1, 'investigate_ssfb')?.calls).toBe(2);
  });
});

// ------------------------------------------------------------------ needs_input

describe('a run parked on needs_input and then answered', () => {
  let parked: RunRecord;
  let answered: RunRecord;

  beforeAll(async () => {
    const first = await runCase(c, { runId: RUN_IDS.needs_input, turns: { root: [toolCall(ASK_REQUESTER, QUESTION), text('waiting')] } });
    expect(first.status).toBe('needs_input');
    expect(first.report).toBeNull();
    expect(first.cost_usd).toBeNull();
    expect(first.cost_partial).toBe(false);
    parked = await storedRun(RUN_IDS.needs_input);
    const script = scriptFollowUp({ root: [finish(draft), text('report written')] });
    const result = await answerRun(RUN_IDS.needs_input, { answer: 'the debit card', by: BY }, deps);
    expect(result.status).toBe('completed');
    expect(script.failures()).toEqual([]);
    answered = await storedRun(RUN_IDS.needs_input);
  });

  test('the parked submission has final rows without an embedding', () => {
    expectIntake(parked);
    expect(atSeq(parked, 1)?.final).toBe(true);
    // A parked run is embedded when it settles for real, so seq 1 has no embedder row.
    expect(keysAt(parked, 1)).toEqual([['faux/cheap', 'triage', 'agent']]);
    expect(rowFor(parked, 1, 'triage')).toMatchObject({ calls: 2, failed_calls: 0 });
  });

  test('the answer is its own submission and the parked one is kept', () => {
    expect(answered.usage.map((u) => [u.seq, u.final])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
    expect(atSeq(answered, 1)).toEqual(atSeq(parked, 1));
    expect(keysAt(answered, 2)).toEqual([
      ['faux/cheap', 'triage', 'agent'],
      [HASH_USAGE_MODEL, 'embedder', 'embed'],
    ]);
    expect(rowFor(answered, 2, 'triage')).toMatchObject({ calls: 2, failed_calls: 0 });
  });
});

// ------------------------------------------------------------------ stopped and failed

describe('a stopped run and a failed run', () => {
  test('a run stopped while its model is working has final rows for what it did', async () => {
    // The second root turn stops the run, then waits for the stop watcher to abort it.
    const stopAndWait: FakeStep = async (_context, options) => {
      await stopRun(RUN_IDS.stopped, { by: BY, interface: 'cli', verdict: false }, { store: store(), home: home.home });
      const signal = options?.signal;
      const until = Date.now() + 10_000;
      while (signal?.aborted !== true && Date.now() < until) await sleep(50);
      return text('stopped');
    };
    const r = await runCase(c, {
      runId: RUN_IDS.stopped,
      turns: { root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), stopAndWait], ...delegateTurns() },
    });

    expect(r.status).toBe('stopped');
    expect(r.cost_usd).toBeNull();
    const run = await storedRun(RUN_IDS.stopped);
    expect(run.phase).toBe('stopped');
    expectIntake(run);
    expect(atSeq(run, 1)?.final).toBe(true);
    // A stopped run is not embedded.
    expect(keysAt(run, 1).map(([, agent]) => agent)).toEqual(['investigate_ssfb', 'triage']);
    expect(rowFor(run, 1, 'investigate_ssfb')?.calls).toBe(2);
    expect(rowFor(run, 1, 'triage')?.calls).toBeGreaterThanOrEqual(1);
  });

  test('a run whose model fails has final rows with the failed call counted', async () => {
    const broken: FakeStep = () => {
      throw new Error('fake model: injected failure for the usage contract');
    };
    const r = await runCase(c, {
      runId: RUN_IDS.failed,
      turns: { root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), broken], ...delegateTurns() },
    });

    expect(r.status).toBe('failed');
    expect(r.report).toBeNull();
    const run = await storedRun(RUN_IDS.failed);
    expectIntake(run);
    expect(atSeq(run, 1)?.final).toBe(true);
    const triage = rowFor(run, 1, 'triage');
    expect(triage?.calls).toBeGreaterThanOrEqual(2);
    expect(triage?.failed_calls).toBeGreaterThanOrEqual(1);
    expect(rowFor(run, 1, 'investigate_ssfb')).toMatchObject({ calls: 2, failed_calls: 0 });
    // A failed run is embedded when it settles, so the embedding is counted too.
    expect(rowFor(run, 1, 'embedder')?.purpose).toBe('embed');
  });
});

// ------------------------------------------------------------------ live counts

describe('the live flush', () => {
  test('the store holds non-final rows while the run is running, and final rows after', async () => {
    let seenWhileRunning: SubmissionUsage | undefined;
    let phaseWhileRunning: string | undefined;
    // The second root turn waits until a flush has written seq 1, then writes the report.
    const waitForFlush: FakeStep = async () => {
      const until = Date.now() + FLUSH_MS * 5;
      while (seenWhileRunning === undefined && Date.now() < until) {
        const run = await store().getRun(RUN_IDS.live);
        seenWhileRunning = run === null ? undefined : atSeq(run, 1);
        phaseWhileRunning = run?.phase;
        if (seenWhileRunning === undefined) await sleep(100);
      }
      return finish(draft);
    };
    const r = await runCase(c, {
      runId: RUN_IDS.live,
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), waitForFlush, text('report written')],
        ...delegateTurns(),
      },
    });

    expect(r.status).toBe('completed');
    expect(phaseWhileRunning).toBe('investigating');
    expect(seenWhileRunning?.final).toBe(false);
    // What had been counted by then: the first root turn and the delegate.
    expect(seenWhileRunning?.rows.map((row) => row.agent)).toEqual(['investigate_ssfb', 'triage']);
    const run = await storedRun(RUN_IDS.live);
    expect(atSeq(run, 1)?.final).toBe(true);
    expect(rowFor(run, 1, 'triage')?.calls).toBe(3);
  });
});
