import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, AgentReply, InitOptions } from '@flue/runtime';
import * as v from 'valibot';
import { FeedbackError, type FeedbackDeps, type FeedbackInput, type FeedbackResult } from '../../report/feedback.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { sampleBlock, sampleClassification, sampleFeedback, sampleRequest, sampleUsageRow, USAGE_MODEL } from '../../runstore/contract.ts';
import { createFolderRunStore } from '../../runstore/folder.ts';
import { RunNotFoundError, type RunPhase, type RunQuery, type RunRecord, type RunStore, type RunSummary } from '../../runstore/types.ts';
import { BLOCK_RESUME_SIGNAL, MAX_RESUME_NOTE_CHARS } from '../../types/block.ts';
import type { RunId } from '../../types/core.ts';
import { RunUsageViewSchema, type RunUsageView, type SubmissionUsage } from '../../types/usage.ts';
import { IngressInputError } from '../normalise.ts';
import { prepareRequest, type PrepareDeps, type PrepareInput, type PreparedSubmission } from '../prepare.ts';
import { SlackFetchError, type SlackThread, type SlackThreadRef } from '../slack.ts';
import { RESUME_HINTS, RunNotResumableError, STALLED_STOP_HOLD_MS, type AgentHandle, type Dispatcher, type ResumeInput, type SettleDeps } from '../submit.ts';
import { flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../../runlog/event-log.ts';
import { readRunEvents } from '../../runlog/read.ts';
import {
  createTriageRoutes,
  IDEMPOTENCY_TTL_MS,
  MESSAGES_HINT,
  runView,
  SLACK_POST_DISABLED,
  SLACK_POST_NOT_IMPLEMENTED,
  startAsk,
  startResume,
  type AskStart,
  type ResumeStart,
  type TriageRouteDeps,
} from './routes.ts';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from './schemas.ts';

// Synthetic ids and people only. The phone below is a made-up test number.
const RUN_A = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const RUN_B = '01J8Z3K4M5N6P7Q8R9S0T1V2W4';
const RUN_C = '01J8Z3K4M5N6P7Q8R9S0T1V2W5';
const UNKNOWN_RUN = '01J8Z3K4M5N6P7Q8R9S0T1V2W9';
const SYNTHETIC_PHONE = '9876543210';
const PERMALINK = 'https://example.slack.com/archives/C0123456789/p1695460000123456';
const MESSAGES = [{ ts: '1695460000.123456', author: 'ops-bot', text: 'transfer stuck for a test user' }];

// ------------------------------------------------------------------ fakes

function record(runId: string, phase: RunPhase, report: unknown = null): RunRecord {
  return {
    run_id: runId,
    schema_version: 1,
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
    phase,
    input_request: null,
    input_history: [],
    block: null,
    block_history: [],
    request: {} as RunRecord['request'],
    classification: {
      decision: { category: 'payment_stuck', tier_final: 'mid' } as unknown as NonNullable<RunRecord['classification']>['decision'],
      id_chain: { hops: [] } as unknown as NonNullable<RunRecord['classification']>['id_chain'],
    },
    evidence: {},
    submissions: [],
    report: report as RunRecord['report'],
    report_md: null,
    feedback: [],
    feedback_latest: null,
    embeddings: [],
    usage: [],
  };
}

type FakeStore = RunStore & { claims: Map<string, string>; calls: string[]; listQueries: RunQuery[] };

function fakeStore(runs: Record<string, RunRecord> = {}, summaries: RunSummary[] = []): FakeStore {
  const claims = new Map<string, string>();
  const calls: string[] = [];
  const listQueries: RunQuery[] = [];
  const impl = {
    claims,
    calls,
    listQueries,
    provider: 'folder',
    async getRun(runId: string) {
      calls.push('getRun');
      return runs[runId] ?? null;
    },
    // Filters nothing itself, so the tests see exactly what the route drops.
    async listRuns(query: RunQuery = {}) {
      calls.push('listRuns');
      listQueries.push(query);
      return query.limit === undefined ? [...summaries] : summaries.slice(0, query.limit);
    },
    async claimIdempotencyKey(key: string, runId: string, ttlMs: number) {
      calls.push('claimIdempotencyKey');
      expect(ttlMs).toBe(IDEMPOTENCY_TTL_MS);
      const held = claims.get(key);
      if (held !== undefined) return held;
      claims.set(key, runId);
      return runId;
    },
    async addSubmission() {
      calls.push('addSubmission');
      return 2;
    },
    async setPhase(_runId: string, phase: string) {
      calls.push(`setPhase:${phase}`);
    },
    async setPhaseIf(_runId: string, _from: readonly string[], phase: string) {
      calls.push(`setPhaseIf:${phase}`);
      return true;
    },
    async setSubmissionFlueId() {
      calls.push('setSubmissionFlueId');
    },
  };
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      if (prop === 'then') return undefined;
      throw new Error(`fake store: ${String(prop)} is not expected here`);
    },
  }) as unknown as FakeStore;
}

type Harness = {
  deps: TriageRouteDeps;
  store: FakeStore;
  prepared: PrepareInput[];
  submitted: PreparedSubmission[];
  asks: [string, string, string][];
  resumes: [string, ResumeInput][];
  feedback: [string, FeedbackInput, FeedbackDeps][];
  app: ReturnType<typeof createTriageRoutes>;
};

function harness(
  over: Partial<TriageRouteDeps> & { runs?: Record<string, RunRecord>; summaries?: RunSummary[] } = {},
): Harness {
  const { runs, summaries, ...rest } = over;
  const store = fakeStore(runs, summaries);
  const prepared: PrepareInput[] = [];
  const submitted: PreparedSubmission[] = [];
  const asks: [string, string, string][] = [];
  const resumes: [string, ResumeInput][] = [];
  const feedback: [string, FeedbackInput, FeedbackDeps][] = [];
  const ids = [RUN_A, RUN_B, RUN_C];
  const deps: TriageRouteDeps = {
    store,
    home: '/tmp/triage-test-home',
    allowSlackPost: false,
    prepare: async (input) => {
      prepared.push(input);
      const run_id = ids[prepared.length - 1] as string;
      return { run_id, request: {} as PreparedSubmission['request'], redaction_names: [] };
    },
    submit: async (p) => {
      submitted.push(p);
    },
    ask: (runId, question, by): AskStart => {
      asks.push([runId, question, by]);
      return { dispatched: Promise.resolve('sub-2'), settled: new Promise(() => undefined) };
    },
    resume: (runId, input): AskStart => {
      resumes.push([runId, input]);
      return { dispatched: Promise.resolve('sub-3'), settled: new Promise(() => undefined) };
    },
    recordFeedback: async (runId, input, fdeps): Promise<FeedbackResult> => {
      feedback.push([runId, input, fdeps]);
      return {
        run_id: runId,
        record: { verdict: input.verdict, given_by: input.given_by, given_at: '2026-09-24T00:00:00.000Z', interface: 'http' },
        count: 1,
        draft_dir: '/tmp/x',
        draft_files: { feedback_md: '/tmp/x/feedback.md', report_json: '/tmp/x/report.json' },
      };
    },
    onBackgroundError: () => undefined,
    ...rest,
  };
  return { deps, store, prepared, submitted, asks, resumes, feedback, app: createTriageRoutes(deps) };
}

const AT = '2026-09-24T00:00:00.000Z';
const INITIAL: RunRecord['submissions'][number] = { seq: 1, kind: 'initial', created_at: AT, report: null, report_md: null };

/** A run parked on b1 after its first submission, the way stop_blocked leaves it. */
function blockedRecord(runId: string): RunRecord {
  return { ...record(runId, 'blocked'), block: sampleBlock('b1'), submissions: [INITIAL] };
}

function post(app: Harness['app'], path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

// ------------------------------------------------------------------ POST /triage

describe('POST /triage schema', () => {
  const cases: [string, unknown][] = [
    ['neither slack_url nor messages', { requested_by: 'ops@example.com' }],
    ['both slack_url and messages', { slack_url: PERMALINK, messages: MESSAGES, requested_by: 'ops@example.com' }],
    ['missing requested_by', { messages: MESSAGES }],
    ['blank requested_by', { messages: MESSAGES, requested_by: '   ' }],
    ['empty messages', { messages: [], requested_by: 'ops@example.com' }],
    ['a bad tier', { messages: MESSAGES, requested_by: 'ops@example.com', tier: 'huge' }],
    ['a body that is not an object', [1, 2, 3]],
  ];
  for (const [name, body] of cases) {
    test(`${name} -> 400, nothing prepared`, async () => {
      const h = harness();
      const res = await post(h.app, '/triage', body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; fields: string[] };
      expect(json.error).toBe('invalid request');
      expect(Array.isArray(json.fields)).toBe(true);
      expect(h.prepared).toHaveLength(0);
      expect(h.submitted).toHaveLength(0);
    });
  }

  test('invalid JSON -> 400', async () => {
    const h = harness();
    const res = await post(h.app, '/triage', '{not json');
    expect(res.status).toBe(400);
    expect(h.prepared).toHaveLength(0);
  });

  test(`an Idempotency-Key over ${MAX_IDEMPOTENCY_KEY_LENGTH} chars -> 400`, async () => {
    const h = harness();
    const body = { messages: MESSAGES, requested_by: 'ops@example.com' };
    const res = await post(h.app, '/triage', body, { 'idempotency-key': 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['Idempotency-Key']);
    expect(h.prepared).toHaveLength(0);
    expect(h.store.calls).toEqual([]);
  });

  test('an Idempotency-Key of exactly the limit is accepted', async () => {
    const h = harness();
    const body = { messages: MESSAGES, requested_by: 'ops@example.com' };
    const res = await post(h.app, '/triage', body, { 'idempotency-key': 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH) });
    expect(res.status).toBe(202);
  });

  test('error bodies name fields, never the values sent', async () => {
    const h = harness();
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com', tier: `x${SYNTHETIC_PHONE}` });
    expect(await res.text()).not.toContain(SYNTHETIC_PHONE);
  });
});

describe('POST /triage accept', () => {
  test('messages -> 202 {run_id}, then runSubmission runs in the background', async () => {
    const h = harness();
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com', tier: 'mid', ids: { aspora_user_id: 'u-1' } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A });
    expect(h.prepared).toEqual([
      {
        interface: 'http',
        requested_by: 'ops@example.com',
        kind: 'json',
        body: { messages: MESSAGES, requested_by: 'ops@example.com', tier: 'mid', ids: { aspora_user_id: 'u-1' } },
      },
    ]);
    await tick();
    expect(h.submitted.map((p) => p.run_id)).toEqual([RUN_A]);
  });

  test('slack_url -> a slack prepare input with the hints', async () => {
    const h = harness();
    const res = await post(h.app, '/triage', { slack_url: PERMALINK, requested_by: 'ops@example.com', entities: ['ssfb'] });
    expect(res.status).toBe(202);
    expect(h.prepared).toEqual([
      { interface: 'http', requested_by: 'ops@example.com', kind: 'slack', url: PERMALINK, hints: { entities: ['ssfb'] } },
    ]);
  });

  test('context rides along with slack_url and with messages', async () => {
    const h = harness();
    await post(h.app, '/triage', { slack_url: PERMALINK, requested_by: 'ops@example.com', context: 'checked KYC' });
    await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com', context: 'checked KYC' });
    expect(h.prepared).toEqual([
      { interface: 'http', requested_by: 'ops@example.com', context: 'checked KYC', kind: 'slack', url: PERMALINK, hints: {} },
      {
        interface: 'http',
        requested_by: 'ops@example.com',
        context: 'checked KYC',
        kind: 'json',
        body: { messages: MESSAGES, requested_by: 'ops@example.com' },
      },
    ]);
  });

  test('the same Idempotency-Key twice -> the same run_id, runSubmission once', async () => {
    const h = harness();
    const body = { messages: MESSAGES, requested_by: 'ops@example.com' };
    const first = await post(h.app, '/triage', body, { 'idempotency-key': 'retry-1' });
    const second = await post(h.app, '/triage', body, { 'idempotency-key': 'retry-1' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.json()).toEqual({ run_id: RUN_A });
    expect(await second.json()).toEqual({ run_id: RUN_A, deduplicated: true });
    await tick();
    expect(h.submitted.map((p) => p.run_id)).toEqual([RUN_A]);
  });

  test('a different key starts a different run', async () => {
    const h = harness();
    const body = { messages: MESSAGES, requested_by: 'ops@example.com' };
    await post(h.app, '/triage', body, { 'idempotency-key': 'k-1' });
    const res = await post(h.app, '/triage', body, { 'idempotency-key': 'k-2' });
    expect(await res.json()).toEqual({ run_id: RUN_B });
    await tick();
    expect(h.submitted).toHaveLength(2);
  });

  test('no key -> no claim', async () => {
    const h = harness();
    await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com' });
    expect(h.store.calls).not.toContain('claimIdempotencyKey');
  });

  test('a background failure is reported, never thrown into the response', async () => {
    const seen: string[] = [];
    const h = harness({
      submit: async () => {
        throw new Error('boom');
      },
      onBackgroundError: (runId, what) => seen.push(`${what}:${runId}`),
    });
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com' });
    expect(res.status).toBe(202);
    await tick();
    await tick();
    expect(seen).toEqual([`submission:${RUN_A}`]);
  });
});

describe('POST /triage with the real prepareRequest', () => {
  function realPrepare(fetchThread?: (ref: SlackThreadRef) => Promise<SlackThread>): (input: PrepareInput) => Promise<PreparedSubmission> {
    const deps: PrepareDeps = {
      normalise: {
        now: new Date('2026-09-24T00:00:00.000Z'),
        lookbackDays: 7,
        enabledEntities: ['ssfb'],
        resolveEntity: (name) => (name === 'ssfb' || name === 'shivalik' ? 'ssfb' : undefined),
      },
      newId: () => RUN_A,
      slack: {} as NonNullable<PrepareDeps['slack']>,
      ...(fetchThread !== undefined ? { fetchThread } : {}),
    };
    return (input) => prepareRequest(input, deps);
  }

  test('a Slack fetch failure -> 422 with the messages[] hint, nothing submitted', async () => {
    const h = harness({
      prepare: realPrepare(async () => {
        throw new SlackFetchError('not_in_channel', 'the bot is not in the channel');
      }),
    });
    const res = await post(h.app, '/triage', { slack_url: PERMALINK, requested_by: 'ops@example.com' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'slack thread read failed', code: 'not_in_channel', hint: MESSAGES_HINT });
    await tick();
    expect(h.submitted).toHaveLength(0);
  });

  test('a link that is not a Slack permalink -> 400', async () => {
    const h = harness({ prepare: realPrepare() });
    const res = await post(h.app, '/triage', { slack_url: 'https://example.com/nope', requested_by: 'ops@example.com' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['slack_url']);
  });

  test('an unknown id key -> 400 naming the key', async () => {
    const h = harness({ prepare: realPrepare() });
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com', ids: { not_a_key: 'x' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['ids.not_a_key']);
  });

  test('entities with no enabled entity -> 400', async () => {
    const h = harness({ prepare: realPrepare() });
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com', entities: ['rtl'] });
    expect(res.status).toBe(400);
  });

  test('messages build an http request for runSubmission', async () => {
    const h = harness({ prepare: realPrepare() });
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com' });
    expect(res.status).toBe(202);
    await tick();
    const p = h.submitted[0] as PreparedSubmission;
    expect(p.request.interface).toBe('http');
    expect(p.request.requested_by).toBe('ops@example.com');
    expect(p.request.source).toEqual({ kind: 'json' });
  });
});

// ------------------------------------------------------------------ GET

describe('GET /triage/:run_id', () => {
  test('an unknown run -> 404', async () => {
    const h = harness();
    const res = await h.app.request(`/triage/${UNKNOWN_RUN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'run not found' });
  });

  test('a malformed run id -> 400', async () => {
    const h = harness();
    const res = await h.app.request('/triage/not%20a%20run');
    expect(res.status).toBe(400);
  });

  test('a synthetic phone in the stored report comes back masked', async () => {
    const report = { summary: `customer called from ${SYNTHETIC_PHONE}`, status: 'resolved' };
    const h = harness({ runs: { [RUN_A]: record(RUN_A, 'completed', report) } });
    const res = await h.app.request(`/triage/${RUN_A}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SYNTHETIC_PHONE);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json.run_id).toBe(RUN_A);
    expect(json.status).toBe('completed');
    expect(json.phase).toBe('completed');
    expect(json.classification).toEqual({ category: 'payment_stuck', tier_final: 'mid' });
    expect(json.id_chain).toEqual({ hops: [] });
    expect((json.report as { summary: string }).summary).toContain('****3210');
  });

  test('a running run has no report key and status running', async () => {
    const h = harness({ runs: { [RUN_A]: record(RUN_A, 'investigating') } });
    const json = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as Record<string, unknown>;
    expect(json.status).toBe('running');
    expect('report' in json).toBe(false);
  });

  test('runView keeps a run id that the persisted profile would mask', () => {
    const digits = '01J8Z3123456789012345678AB';
    expect(runView(record(digits, 'failed')).run_id).toBe(digits);
    expect(runView(record(digits, 'failed')).status).toBe('failed');
  });
});

describe('GET /triage/:run_id detail fields', () => {
  const AT1 = '2026-09-24T00:00:00.000Z';
  const AT2 = '2026-09-24T00:05:00.000Z';

  function detailRecord(over: Partial<RunRecord> = {}): RunRecord {
    const base = record(RUN_A, 'investigating');
    return {
      ...base,
      updated_at: AT2,
      phase_reason: 'waiting on a delegate',
      request: {
        interface: 'slack',
        requested_by: 'U0TESTUSER',
        source: { kind: 'slack', channel_id: 'C0TEST', thread_ts: '1695460000.123456', permalink: PERMALINK },
      } as unknown as RunRecord['request'],
      classification: {
        decision: {
          proposed: { category: 'transfer_out' },
          tier_final: 'mid',
        } as unknown as NonNullable<RunRecord['classification']>['decision'],
        id_chain: { hops: [] } as unknown as NonNullable<RunRecord['classification']>['id_chain'],
        preflight_warnings: [{ entity: 'rtl', step: 'db', message: 'database not configured' }],
      },
      evidence: {
        code: { key: 'code', version: 1, findings: {} as never },
        ssfb: { key: 'ssfb', version: 2, findings: {} as never },
      },
      submissions: [
        { seq: 1, kind: 'initial', created_at: AT1, report: null, report_md: null },
        { seq: 2, kind: 'ask', question: `is ${SYNTHETIC_PHONE} linked?`, created_at: AT2, report: null, report_md: null },
      ],
      feedback: [
        { verdict: 'partial', actual_root_cause: 'the payout was on hold', given_by: 'ops-a', given_at: AT1, interface: 'http' },
        { verdict: 'correct', given_by: 'ops-b', given_at: AT2, interface: 'cli' },
      ],
      ...over,
    };
  }

  async function getJson(runs: Record<string, RunRecord>): Promise<{ text: string; json: Record<string, unknown> }> {
    const res = await harness({ runs }).app.request(`/triage/${RUN_A}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, json: JSON.parse(text) as Record<string, unknown> };
  }

  test('returns every new field, in the documented shapes', async () => {
    const { json } = await getJson({ [RUN_A]: detailRecord() });
    expect(json.run_id).toBe(RUN_A);
    expect(json.status).toBe('running');
    expect(json.created_at).toBe(AT1);
    expect(json.updated_at).toBe(AT2);
    expect(json.phase_reason).toBe('waiting on a delegate');
    expect(json.requested_by).toBe('U0TESTUSER');
    expect(json.interface).toBe('slack');
    expect(typeof json.permalink).toBe('string');
    expect(json.preflight_warnings).toEqual([{ entity: 'rtl', step: 'db', message: 'database not configured' }]);
    // EVIDENCE_KEYS order, not insertion order.
    expect(json.evidence).toEqual([
      { key: 'ssfb', version: 2 },
      { key: 'code', version: 1 },
    ]);
    const subs = json.submissions as Record<string, unknown>[];
    expect(subs.map((s) => [s.seq, s.kind, s.created_at, s.has_report])).toEqual([
      [1, 'initial', AT1, false],
      [2, 'ask', AT2, false],
    ]);
    expect('question' in (subs[0] as object)).toBe(false);
    expect(json.feedback).toEqual([
      { verdict: 'partial', actual_root_cause: 'the payout was on hold', given_by: 'ops-a', given_at: AT1, interface: 'http' },
      { verdict: 'correct', given_by: 'ops-b', given_at: AT2, interface: 'cli' },
    ]);
    expect('report' in json).toBe(false);
    expect('report_md' in json).toBe(false);
    // The classifier gives no current_ask, so there is none until the report exists.
    expect(json.current_ask).toBeNull();
  });

  test('a synthetic phone in current_ask and in a submission question comes back masked', async () => {
    const report = {
      status: 'resolved',
      request: { current_ask: `why can ${SYNTHETIC_PHONE} not send money`, requested_by: 'ops' },
    } as unknown as RunRecord['report'];
    const { text, json } = await getJson({ [RUN_A]: detailRecord({ report }) });
    expect(text).not.toContain(SYNTHETIC_PHONE);
    expect(json.current_ask).toContain('****3210');
    const subs = json.submissions as { question?: string }[];
    expect(subs[1]?.question).toContain('****3210');
  });

  test("current_ask is the report's, and report_md comes with the report", async () => {
    const report = { status: 'resolved', request: { current_ask: 'where is the refund', requested_by: 'ops' } };
    const run = detailRecord({
      phase: 'completed',
      report: report as unknown as RunRecord['report'],
      report_md: '# Report\n\nThe refund is on its way.',
      submissions: [{ seq: 1, kind: 'initial', created_at: AT1, report: report as unknown as RunRecord['report'], report_md: '# r' }],
    });
    const { json } = await getJson({ [RUN_A]: run });
    expect(json.status).toBe('completed');
    expect(json.current_ask).toBe('where is the refund');
    expect(json.report_md).toBe('# Report\n\nThe refund is on its way.');
    expect((json.submissions as { has_report: boolean }[])[0]?.has_report).toBe(true);
  });

  test('a non-slack source has no permalink; a bare record still renders', async () => {
    const text = detailRecord({
      request: { interface: 'cli', requested_by: 'ops', source: { kind: 'text' } } as unknown as RunRecord['request'],
    });
    const { json } = await getJson({ [RUN_A]: text });
    expect('permalink' in json).toBe(false);
    expect(json.interface).toBe('cli');

    const bare = runView(record(RUN_A, 'created'));
    expect(bare.current_ask).toBeNull();
    expect(bare.evidence).toEqual([]);
    expect(bare.submissions).toEqual([]);
    expect(bare.feedback).toEqual([]);
    expect('permalink' in bare).toBe(false);
    expect('phase_reason' in bare).toBe(false);
  });
});

describe('GET /triage/:run_id request (D66)', () => {
  const AT = '2026-09-24T00:00:00.000Z';

  function withRequest(request: unknown): RunRecord {
    return { ...record(RUN_A, 'investigating'), request: request as RunRecord['request'] };
  }

  async function requestOf(run: RunRecord): Promise<{ text: string; json: Record<string, unknown> }> {
    const res = await harness({ runs: { [RUN_A]: run } }).app.request(`/triage/${RUN_A}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    return { text, json: JSON.parse(text) as Record<string, unknown> };
  }

  test('a slack request: the thread, the hints given, the attachment count, and the permalink as before', async () => {
    const run = withRequest({
      interface: 'slack',
      requested_by: 'U0TESTUSER',
      source: { kind: 'slack', channel_id: 'C0TEST', thread_ts: '1695460000.123456', permalink: PERMALINK },
      messages: [
        // The stored copy is the persisted profile, so a Slack ts is usually masked already.
        { ts: '****0000.****3456', author: 'ops-bot', text: `transfer stuck for ${SYNTHETIC_PHONE}`, is_parent: true },
        { ts: AT, author: 'ops-lead', text: 'any update?', is_parent: false },
      ],
      attachments: [{ name: 'shot.png', mime: 'image/png', bytes_ref: 'a1' }],
      hints: { ids: { aspora_user_id: 'u-test-1' }, entities: ['ssfb'], tier: 'mid' },
      window: { from: AT, to: AT },
      received_at: AT,
    });
    const { text, json } = await requestOf(run);
    expect(text).not.toContain(SYNTHETIC_PHONE);
    expect(typeof json.permalink).toBe('string');
    expect(json.request).toEqual({
      source: 'slack',
      messages: [
        { author: 'ops-bot', text: 'transfer stuck for ****3210', is_parent: true },
        { author: 'ops-lead', text: 'any update?', is_parent: false, at: AT },
      ],
      hints: { ids: { aspora_user_id: 'u-test-1' }, entities: ['ssfb'], tier: 'mid' },
      attachments: 1,
    });
  });

  test('a pasted (json) request has no hints key when none were given', async () => {
    const run = withRequest({
      interface: 'http',
      requested_by: 'ops@example.com',
      source: { kind: 'json' },
      messages: [{ ts: '****0000.****0000', author: 'pasted', text: 'line one\nline two', is_parent: true }],
      attachments: [],
      hints: {},
    });
    const { json } = await requestOf(run);
    expect(json.request).toEqual({
      source: 'json',
      messages: [{ author: 'pasted', text: 'line one\nline two', is_parent: true }],
      attachments: 0,
    });
    expect('permalink' in json).toBe(false);
  });

  test('the added context message is split out of the thread', async () => {
    const run = withRequest({
      source: { kind: 'text' },
      messages: [
        { ts: AT, author: 'support', text: 'refund missing', is_parent: true },
        { ts: AT, author: 'added context', text: `already checked KYC for ${SYNTHETIC_PHONE}`, is_parent: false },
      ],
      hints: { time_window: { from: AT, to: AT } },
    });
    const { text, json } = await requestOf(run);
    expect(text).not.toContain(SYNTHETIC_PHONE);
    const req = json.request as { messages: { author: string }[]; context?: string; hints?: unknown; attachments: number };
    expect(req.messages.map((m) => m.author)).toEqual(['support']);
    expect(req.context).toBe('already checked KYC for ****3210');
    expect(req.hints).toEqual({ time_window: { from: AT, to: AT } });
    expect(req.attachments).toBe(0);
  });

  test('a record without these fields renders: no request key, or an empty thread', () => {
    expect('request' in runView(record(RUN_A, 'created'))).toBe(false);
    const { request: _dropped, ...older } = record(RUN_A, 'failed');
    expect('request' in runView(older as unknown as RunRecord)).toBe(false);
    const sourceOnly = runView(withRequest({ source: { kind: 'thread_file' } }));
    expect(sourceOnly.request).toEqual({ source: 'thread_file', messages: [], attachments: 0 });
  });
});

describe('GET /triage/:run_id usage (D59)', () => {
  const AT = '2026-09-24T00:05:00.000Z';
  const LATER = '2026-09-24T00:06:00.000Z';
  const OTHER_MODEL = 'openai/text-embedding-3-small';
  const submission = (seq: number, rows: SubmissionUsage['rows'], final = true, updated_at = AT): SubmissionUsage => ({
    seq,
    rows,
    updated_at,
    final,
  });

  async function usageOf(run: RunRecord, isAlive?: (pid: number) => boolean): Promise<{ text: string; usage: RunUsageView }> {
    const extra = isAlive === undefined ? {} : { isAlive };
    const res = await harness({ runs: { [run.run_id]: run }, ...extra }).app.request(`/triage/${run.run_id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const usage = (JSON.parse(text) as { usage: RunUsageView }).usage;
    expect(() => v.parse(RunUsageViewSchema, usage)).not.toThrow();
    return { text, usage };
  }

  test('the view carries totals and breakdowns by model, agent and submission', async () => {
    const run = {
      ...record(RUN_A, 'completed'),
      usage: [
        submission(0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify', calls: 1, failed_calls: 0, usd: 0.01 })]),
        submission(1, [sampleUsageRow(), sampleUsageRow({ model: OTHER_MODEL, agent: 'embedder', purpose: 'embed', calls: 1, failed_calls: 0, usd: 0 })], true, LATER),
      ],
    };
    const { usage } = await usageOf(run);
    expect(usage.recorded).toBe(true);
    expect(usage.total.calls).toBe(5);
    expect(usage.total.failed_calls).toBe(1);
    expect(usage.total.usd).toBeCloseTo(0.26);
    expect(Object.keys(usage.by_model)).toEqual([USAGE_MODEL, OTHER_MODEL]);
    expect(Object.keys(usage.by_agent)).toEqual(['classifier', 'embedder', 'triage']);
    expect(Object.keys(usage.by_submission)).toEqual(['0', '1']);
    expect(usage.pricing).toBe('full');
    expect(usage.live).toBe(false);
    expect(usage.incomplete).toBe(false);
    expect(usage.updated_at).toBe(LATER);
  });

  test('usage is added after the redaction: model ids keep their digits, other text is still masked', async () => {
    // The profile masks digit runs in string values; an unpriced model id is one.
    expect(JSON.stringify(redactPersisted({ m: USAGE_MODEL }).value)).not.toContain(USAGE_MODEL);
    const report = { summary: `customer called from ${SYNTHETIC_PHONE}`, status: 'resolved' };
    const run = { ...record(RUN_A, 'completed', report), usage: [submission(1, [sampleUsageRow({ usd: null })])] };
    const { text, usage } = await usageOf(run);
    expect(text).not.toContain(SYNTHETIC_PHONE);
    expect(usage.total.unpriced_models).toEqual([USAGE_MODEL]);
    expect(usage.by_model[USAGE_MODEL]?.unpriced_models).toEqual([USAGE_MODEL]);
    expect(usage.pricing).toBe('none');
    expect(text).not.toContain('****1001');
  });

  test('a run with no usage rows, or a record from before D59, says not recorded', async () => {
    for (const run of [record(RUN_A, 'completed'), { ...record(RUN_A, 'completed'), usage: [submission(1, [])] }]) {
      const { usage } = await usageOf(run);
      expect(usage.recorded).toBe(false);
      expect(usage.total.calls).toBe(0);
      expect(usage.total.usd).toBe(0);
      expect(usage.by_model).toEqual({});
    }
    const { usage: _dropped, ...older } = record(RUN_A, 'failed');
    const view = runView(older as unknown as RunRecord);
    expect((view.usage as RunUsageView).recorded).toBe(false);
    expect((view.usage as RunUsageView).updated_at).toBeNull();
  });

  test('a non-final count is live while the run is running and incomplete once it is not', async () => {
    const open = [submission(1, [sampleUsageRow()], false)];
    for (const [phase, live, incomplete] of [
      ['investigating', true, false],
      ['needs_input', true, false],
      ['blocked', false, true],
      ['failed', false, true],
      ['stopped', false, true],
    ] as const) {
      const { usage } = await usageOf({ ...record(RUN_A, phase), usage: open });
      expect([phase, usage.live, usage.incomplete]).toEqual([phase, live, incomplete]);
    }
  });

  test('a running run whose worker pid is dead shows its open count as incomplete, not live', async () => {
    const open = [submission(1, [sampleUsageRow()], false)];
    const checked: number[] = [];
    const dead = (pid: number): boolean => {
      checked.push(pid);
      return false;
    };
    const stalled = await usageOf({ ...record(RUN_A, 'investigating'), worker_pid: 4242, usage: open }, dead);
    expect([stalled.usage.live, stalled.usage.incomplete]).toEqual([false, true]);
    expect(checked).toEqual([4242]);
    // A live pid, no recorded pid, or no checker at all: still live.
    const alive = await usageOf({ ...record(RUN_A, 'investigating'), worker_pid: 4242, usage: open }, () => true);
    expect([alive.usage.live, alive.usage.incomplete]).toEqual([true, false]);
    const noPid = await usageOf({ ...record(RUN_A, 'investigating'), usage: open }, dead);
    expect([noPid.usage.live, noPid.usage.incomplete]).toEqual([true, false]);
    const noChecker = await usageOf({ ...record(RUN_A, 'investigating'), worker_pid: 4242, usage: open });
    expect(noChecker.usage.live).toBe(true);
    // A finished run never asks about its pid.
    checked.length = 0;
    await usageOf({ ...record(RUN_A, 'completed'), worker_pid: 4242, usage: [submission(1, [sampleUsageRow()])] }, dead);
    expect(checked).toEqual([]);
  });

  test('some rows unpriced -> partial, with the unpriced model named', async () => {
    const run = {
      ...record(RUN_A, 'completed'),
      usage: [submission(1, [sampleUsageRow(), sampleUsageRow({ model: OTHER_MODEL, agent: 'embedder', purpose: 'embed', usd: null })])],
    };
    const { usage } = await usageOf(run);
    expect(usage.pricing).toBe('partial');
    expect(usage.total.usd).toBe(0.25);
    expect(usage.total.unpriced_models).toEqual([OTHER_MODEL]);
  });
});

// ------------------------------------------------------------------ GET /triage

describe('GET /triage stalled (D71)', () => {
  const T = '2026-09-24T10:00:00.000Z';
  const summary = (run_id: string, over: Partial<RunSummary> = {}): RunSummary => ({
    run_id,
    created_at: T,
    updated_at: T,
    phase: 'investigating',
    submissions: 1,
    ...over,
  });

  test('a working row gets stalled; no row carries the flue ids or the worker pid', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'triage-routes-list-stalled-'));
    try {
      const quiet = '2026-09-24T00:00:00.000Z';
      mkdirSync(join(runsDir, RUN_B), { recursive: true });
      writeFileSync(join(runsDir, RUN_B, 'events.jsonl'), `${JSON.stringify({ ts: quiet, source: 'pipeline', type: 'phase', data: {} })}\n`);
      const checked: number[] = [];
      const h = harness({
        runsDir,
        stalledAfterMs: 60_000,
        isAlive: (pid) => {
          checked.push(pid);
          return false;
        },
        summaries: [
          summary(RUN_A, { worker_pid: 4242, flue_submission_id: 'sub_a' }),
          summary(RUN_B, { phase: 'dispatched' }),
          // A finished row never reads anything, and carries no inputs from a store anyway.
          summary(RUN_C, { phase: 'completed', worker_pid: 777 }),
        ],
      });
      const json = (await (await h.app.request('/triage')).json()) as { runs: Record<string, unknown>[] };
      expect(json.runs.map((r) => r.stalled)).toEqual([
        // No lease can be read in this process, so the dead pid counts.
        { reason: 'no_owner', since: T },
        { reason: 'no_progress', since: quiet },
        undefined,
      ]);
      for (const r of json.runs) {
        expect(Object.keys(r)).not.toContain('flue_submission_id');
        expect(Object.keys(r)).not.toContain('steer_flue_submission_id');
        expect(Object.keys(r)).not.toContain('worker_pid');
      }
      expect(checked).toEqual([4242]);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test('a working row that is not stalled has no stalled field', async () => {
    const h = harness({ summaries: [summary(RUN_A)] });
    const json = (await (await h.app.request('/triage')).json()) as { runs: Record<string, unknown>[] };
    expect(json.runs).toEqual([summary(RUN_A)]);
  });
});

describe('GET /triage', () => {
  const T1 = '2026-09-24T10:00:00.000Z';
  const T2 = '2026-09-24T09:00:00.000Z';
  const summary = (run_id: string, created_at: string, over: Partial<RunSummary> = {}): RunSummary => ({
    run_id,
    created_at,
    updated_at: created_at,
    phase: 'completed',
    submissions: 1,
    ...over,
  });
  // Store order: created_at desc, run_id desc.
  const rows = [
    summary(RUN_B, T1, { phase: 'investigating' }),
    summary(RUN_A, T1, { category: 'transfer_out', tier_final: 'mid', report_status: 'resolved', feedback_verdict: 'correct' }),
    summary(UNKNOWN_RUN, T2, { phase: 'failed', submissions: 0 }),
  ];

  test('200 {runs, next_cursor}; the store gets limit + 1 when nothing is filtered here', async () => {
    const h = harness({ summaries: rows });
    const res = await h.app.request('/triage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: rows, next_cursor: null });
    expect(h.store.listQueries).toEqual([{ limit: 51 }]);
  });

  test('store-side filters are passed down with limit + 1', async () => {
    const h = harness({ summaries: rows });
    const res = await h.app.request('/triage?phase=completed&category=transfer_out&since=2026-09-01T00:00:00.000Z&limit=5');
    expect(res.status).toBe(200);
    expect(h.store.listQueries).toEqual([
      { phase: 'completed', category: 'transfer_out', since: new Date('2026-09-01T00:00:00.000Z'), limit: 6 },
    ]);
  });

  test.each([['status=running'], ['feedback=none'], [`cursor=${encodeURIComponent(`${T1},${RUN_B}`)}`]])(
    'with %s the store gets no limit and the route filters',
    async (qs) => {
      const h = harness({ summaries: rows });
      const res = await h.app.request(`/triage?${qs}&limit=1`);
      expect(res.status).toBe(200);
      expect(h.store.listQueries).toHaveLength(1);
      expect('limit' in (h.store.listQueries[0] as object)).toBe(false);
    },
  );

  test('status and feedback filters drop rows', async () => {
    const h = harness({ summaries: rows });
    const running = (await (await h.app.request('/triage?status=running')).json()) as { runs: RunSummary[] };
    expect(running.runs.map((r) => r.run_id)).toEqual([RUN_B]);
    const none = (await (await h.app.request('/triage?feedback=none')).json()) as { runs: RunSummary[] };
    expect(none.runs.map((r) => r.run_id)).toEqual([RUN_B, UNKNOWN_RUN]);
  });

  test('usd_total and tokens_total pass through to the list items', async () => {
    const priced = [summary(RUN_A, T1, { usd_total: 0.42, tokens_total: 12_345 }), summary(RUN_B, T2)];
    const h = harness({ summaries: priced });
    const body = (await (await h.app.request('/triage')).json()) as { runs: RunSummary[] };
    expect(body.runs.map((r) => [r.run_id, r.usd_total, r.tokens_total])).toEqual([
      [RUN_A, 0.42, 12_345],
      [RUN_B, undefined, undefined],
    ]);
  });

  test('a blocked run lists under status blocked, not running', async () => {
    const h = harness({ summaries: [summary(RUN_C, T1, { phase: 'blocked' }), ...rows] });
    const blocked = (await (await h.app.request('/triage?status=blocked')).json()) as { runs: RunSummary[] };
    expect(blocked.runs.map((r) => r.run_id)).toEqual([RUN_C]);
    const running = (await (await h.app.request('/triage?status=running')).json()) as { runs: RunSummary[] };
    expect(running.runs.map((r) => r.run_id)).toEqual([RUN_B]);
  });

  test('next_cursor walks two pages', async () => {
    const h = harness({ summaries: rows });
    const first = (await (await h.app.request('/triage?limit=2')).json()) as { runs: RunSummary[]; next_cursor: string | null };
    expect(first.runs.map((r) => r.run_id)).toEqual([RUN_B, RUN_A]);
    expect(first.next_cursor).toBe(`${T1},${RUN_A}`);
    const second = (await (
      await h.app.request(`/triage?limit=2&cursor=${encodeURIComponent(first.next_cursor as string)}`)
    ).json()) as { runs: RunSummary[]; next_cursor: string | null };
    expect(second.runs.map((r) => r.run_id)).toEqual([UNKNOWN_RUN]);
    expect(second.next_cursor).toBeNull();
  });

  test.each([
    ['status', 'status=done'],
    ['phase', 'phase=sleeping'],
    ['phase', 'status=running&phase=completed'],
    ['category', 'category=nope'],
    ['feedback', 'feedback=maybe'],
    ['since', 'since=yesterday'],
    ['cursor', 'cursor=nocomma'],
    ['limit', 'limit=0'],
    ['limit', 'limit=201'],
  ])('a bad %s (%s) -> 400 naming it; the store is not read', async (field, qs) => {
    const h = harness({ summaries: rows });
    const res = await h.app.request(`/triage?${qs}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: string[]; reason?: string };
    expect(body.error).toBe('invalid request');
    expect(body.fields).toEqual([field]);
    expect(h.store.listQueries).toHaveLength(0);
  });

  test('with the folder store: filters and the detail view end to end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'triage-list-'));
    try {
      let now = Date.parse('2026-09-24T08:00:00.000Z');
      const store = createFolderRunStore({ runsDir: join(root, 'runs'), dataDir: join(root, 'data'), now: () => now });
      const make = async (id: RunId, phase: RunPhase) => {
        await store.createRun(id, redactPersisted(sampleRequest(id)));
        await store.setPhase(id, phase);
        now += 60_000;
      };
      await make(RUN_A, 'completed');
      await make(RUN_B, 'investigating');
      await make(UNKNOWN_RUN, 'failed');
      await store.putClassification(RUN_A, redactPersisted(sampleClassification()));
      await store.addSubmission(RUN_A, redactPersisted({ kind: 'initial' as const }));
      await store.putFeedback(RUN_A, redactPersisted(sampleFeedback('wrong', '2026-09-24T09:00:00.000Z')));

      const h = harness({ store });
      const all = (await (await h.app.request('/triage')).json()) as { runs: RunSummary[]; next_cursor: string | null };
      expect(all.runs.map((r) => r.run_id)).toEqual([UNKNOWN_RUN, RUN_B, RUN_A]);
      expect(all.next_cursor).toBeNull();

      const wrong = (await (await h.app.request('/triage?feedback=wrong')).json()) as { runs: RunSummary[] };
      expect(wrong.runs.map((r) => [r.run_id, r.category, r.submissions])).toEqual([[RUN_A, 'transfer_out', 1]]);
      const running = (await (await h.app.request('/triage?status=running')).json()) as { runs: RunSummary[] };
      expect(running.runs.map((r) => r.run_id)).toEqual([RUN_B]);
      const byCategory = (await (await h.app.request('/triage?category=onboarding')).json()) as { runs: RunSummary[] };
      expect(byCategory.runs).toEqual([]);

      const detail = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as Record<string, unknown>;
      expect(detail.requested_by).toBe('ops-reviewer');
      expect(detail.interface).toBe('cli');
      expect('permalink' in detail).toBe(false);
      // No report yet, and the classification carries no current_ask.
      expect(detail.current_ask).toBeNull();
      expect((detail.submissions as { seq: number; kind: string }[]).map((s) => [s.seq, s.kind])).toEqual([[1, 'initial']]);
      expect((detail.feedback as { verdict: string }[]).map((f) => f.verdict)).toEqual(['wrong']);
      expect((detail.usage as RunUsageView).recorded).toBe(false);

      // Usage written through the store shows in the list totals and the detail view.
      await store.putUsage(RUN_A, 0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify', usd: 0.05 })], true);
      await store.putUsage(RUN_A, 1, [sampleUsageRow(), sampleUsageRow({ agent: 'synthesis', usd: null })], true);
      const listed = (await (await h.app.request('/triage?feedback=wrong')).json()) as { runs: RunSummary[] };
      expect(listed.runs[0]?.usd_total).toBeCloseTo(0.3);
      expect(listed.runs[0]?.tokens_total).toBe(3 * (1200 + 300 + 4000 + 500));
      const withUsage = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as { usage: RunUsageView };
      expect(withUsage.usage.recorded).toBe(true);
      expect(withUsage.usage.pricing).toBe('partial');
      expect(Object.keys(withUsage.usage.by_submission)).toEqual(['0', '1']);
      expect(withUsage.usage.total.unpriced_models).toEqual([USAGE_MODEL]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ ask

describe('POST /triage/:run_id/ask', () => {
  test('an unknown run -> 404, nothing dispatched', async () => {
    const h = harness();
    const res = await post(h.app, `/triage/${UNKNOWN_RUN}/ask`, { question: 'why?', requested_by: 'ops@example.com' });
    expect(res.status).toBe(404);
    expect(h.asks).toHaveLength(0);
  });

  test('a known run -> 202 {run_id, submission_id}', async () => {
    const h = harness({ runs: { [RUN_A]: record(RUN_A, 'completed') } });
    const res = await post(h.app, `/triage/${RUN_A}/ask`, { question: 'why?', requested_by: 'ops@example.com' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: 'sub-2' });
    expect(h.asks).toEqual([[RUN_A, 'why?', 'ops@example.com']]);
  });

  test('a missing question -> 400', async () => {
    const h = harness({ runs: { [RUN_A]: record(RUN_A, 'completed') } });
    const res = await post(h.app, `/triage/${RUN_A}/ask`, { requested_by: 'ops@example.com' });
    expect(res.status).toBe(400);
    expect(h.asks).toHaveLength(0);
  });

  test('a blocked run -> 409 pointing at resume, nothing dispatched', async () => {
    const h = harness({ runs: { [RUN_A]: blockedRecord(RUN_A) } });
    const res = await post(h.app, `/triage/${RUN_A}/ask`, { question: 'why?', requested_by: 'ops@example.com' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run is blocked', hint: 'resume it first' });
    expect(h.asks).toHaveLength(0);
  });

  test('an ask that fails before dispatch is mapped, not left hanging', async () => {
    const h = harness({
      runs: { [RUN_A]: record(RUN_A, 'completed') },
      ask: () => ({ dispatched: new Promise(() => undefined), settled: Promise.reject(new RunNotFoundError(RUN_A)) }),
    });
    const res = await post(h.app, `/triage/${RUN_A}/ask`, { question: 'why?', requested_by: 'ops@example.com' });
    expect(res.status).toBe(404);
  });
});

describe('startAsk', () => {
  test('resolves dispatched with Flue submission id before the reply arrives', async () => {
    let finishRead: ((reply: AgentReply) => void) | undefined;
    const inits: InitOptions[] = [];
    const store = fakeStore({ [RUN_A]: record(RUN_A, 'completed') });
    const dispatcher: Dispatcher = {
      init(_agent, options) {
        inits.push(options);
        const handle = {
          dispatch: async () => ({ submissionId: 'sub-7', acceptedAt: '2026-09-24T00:00:00.000Z' }),
          read: () => new Promise<AgentReply>((resolve) => (finishRead = resolve)),
          abort: async () => undefined,
        };
        return handle as unknown as AgentHandle;
      },
    };
    const deps: SettleDeps = {
      config: { mock: { enabled: true }, runs: { priorCases: false }, budgets: { runTimeoutMs: 60_000, runMaxAttempts: 1 } },
      store,
      dispatcher,
      agent: {} as Agent,
      embedder: null,
      embedRun: async () => ({ gaps: [] }) as unknown as Awaited<ReturnType<NonNullable<SettleDeps['embedRun']>>>,
    };
    const started = startAsk(RUN_A as RunId, 'why?', 'ops@example.com', deps);
    expect(await started.dispatched).toBe('sub-7');
    expect(inits).toEqual([{ id: RUN_A }]);
    // The reply is still pending: read() is called after the investigating phase is stored.
    for (let i = 0; i < 20 && finishRead === undefined; i++) await tick();
    expect(finishRead).toBeDefined();
    finishRead?.({ text: 'because', submissionId: 'sub-7' } as unknown as AgentReply);
    const result = (await started.settled) as { status: string; submission_id: string };
    expect(result.status).toBe('completed');
    expect(result.submission_id).toBe('sub-7');
  });
});

// ------------------------------------------------------------------ feedback

describe('POST /triage/:run_id/feedback', () => {
  test('a bad verdict -> 400, recordFeedback not called', async () => {
    const h = harness();
    const res = await post(h.app, `/triage/${RUN_A}/feedback`, { verdict: 'great', given_by: 'ops@example.com' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(['verdict']);
    expect(h.feedback).toHaveLength(0);
  });

  test('a missing given_by -> 400', async () => {
    const h = harness();
    const res = await post(h.app, `/triage/${RUN_A}/feedback`, { verdict: 'correct' });
    expect(res.status).toBe(400);
    expect(h.feedback).toHaveLength(0);
  });

  test('success calls recordFeedback with interface http', async () => {
    const h = harness();
    const res = await post(h.app, `/triage/${RUN_A}/feedback`, {
      verdict: 'partial',
      actual_root_cause: 'webhook retry',
      given_by: 'ops@example.com',
      interface: 'cli',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: RUN_A, verdict: 'partial', count: 1 });
    expect(h.feedback).toHaveLength(1);
    const [runId, input, fdeps] = h.feedback[0] as [string, FeedbackInput, FeedbackDeps];
    expect(runId).toBe(RUN_A);
    expect(input).toEqual({ verdict: 'partial', actual_root_cause: 'webhook retry', given_by: 'ops@example.com', interface: 'http' });
    expect(fdeps.store).toBe(h.store);
    expect(fdeps.home).toBe('/tmp/triage-test-home');
  });

  test('FeedbackError codes map to 404 and 400', async () => {
    for (const [code, status] of [
      ['run_not_found', 404],
      ['invalid_run_id', 400],
      ['invalid_input', 400],
    ] as const) {
      const h = harness({
        recordFeedback: async () => {
          throw new FeedbackError(code, 'refused', ['verdict']);
        },
      });
      const res = await post(h.app, `/triage/${RUN_A}/feedback`, { verdict: 'correct', given_by: 'ops@example.com' });
      expect(res.status).toBe(status);
    }
  });
});

// ------------------------------------------------------------------ post-to-slack

describe('POST /triage/:run_id/post-to-slack', () => {
  const body = { approved_by: 'boss@example.com', text: 'post this' };

  test('403 when TRIAGE_HTTP_ALLOW_SLACK_POST is false; no store read, no Slack call', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    const h = harness({ runs: { [RUN_A]: record(RUN_A, 'completed', { summary: 'done' }) } });
    const res = await post(h.app, `/triage/${RUN_A}/post-to-slack`, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SLACK_POST_DISABLED });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(h.store.calls).toEqual([]);
  });

  test('501 even when enabled; a caller-sent approved_by changes nothing', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    const h = harness({ allowSlackPost: true, runs: { [RUN_A]: record(RUN_A, 'completed', { summary: 'done' }) } });
    for (const b of [body, {}, { approved_by: 'ops@example.com', yes: true }]) {
      const res = await post(h.app, `/triage/${RUN_A}/post-to-slack`, b);
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: SLACK_POST_NOT_IMPLEMENTED });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(h.store.calls).toEqual([]);
  });

  test('routes.ts has no path to a Slack writer', () => {
    const source = readFileSync(fileURLToPath(new URL('./routes.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/slack-client|slack-post|postThreadReply|postReport/);
    expect(source).not.toMatch(/\.approved_by\b|['"]approved_by['"]/);
  });
});

// ------------------------------------------------------------------ lazy deps

describe('deps source', () => {
  test('a function source is called once, on the first request', async () => {
    let builds = 0;
    const h = harness();
    const app = createTriageRoutes(() => {
      builds++;
      return h.deps;
    });
    expect(builds).toBe(0);
    await app.request(`/triage/${UNKNOWN_RUN}`);
    await app.request(`/triage/${UNKNOWN_RUN}`);
    expect(builds).toBe(1);
  });

  test('a failed build answers 500 without detail and is retried', async () => {
    let builds = 0;
    const h = harness();
    const app = createTriageRoutes(() => {
      builds++;
      if (builds === 1) throw new Error(`secret-ish ${SYNTHETIC_PHONE}`);
      return h.deps;
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await app.request(`/triage/${UNKNOWN_RUN}`);
    errorSpy.mockRestore();
    expect(first.status).toBe(500);
    expect(await first.text()).not.toContain(SYNTHETIC_PHONE);
    expect((await app.request(`/triage/${UNKNOWN_RUN}`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ source rules

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const REPO = join(SRC, '..');

function tsFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('source rules', () => {
  test('no file in src/ references createAgentRouter', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => readFileSync(f, 'utf8').includes('createAgentRouter'))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
    expect(tsFiles(SRC).length).toBeGreaterThan(50);
  });

  test('src/ingress/http and src/http do not import src/ingress/runtime.ts', () => {
    const files = [...tsFiles(join(SRC, 'ingress', 'http')), ...tsFiles(join(SRC, 'http'))];
    expect(files.map((f) => relative(REPO, f))).toEqual(
      expect.arrayContaining(['src/ingress/http/routes.ts', 'src/ingress/http/auth.ts', 'src/http/bearer-auth.http.ts', 'src/http/triage.http.ts']),
    );
    const importsRuntime = /from\s+['"][^'"]*(?:ingress\/|\.\.?\/)runtime(?:\.ts)?['"]|import\(\s*['"][^'"]*runtime(?:\.ts)?['"]\s*\)/;
    const offenders = files.filter((f) => importsRuntime.test(readFileSync(f, 'utf8'))).map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
    expect(importsRuntime.test("import { x } from '../runtime.ts';")).toBe(true);
    expect(importsRuntime.test("import { x } from '../ingress/runtime.ts';")).toBe(true);
  });

  test('src/app.ts is not changed by the HTTP modules: it still mounts the generated list only', () => {
    const source = readFileSync(join(SRC, 'app.ts'), 'utf8');
    expect(source).toContain("from './http/http-modules.gen.ts'");
    expect(source).not.toContain('routes.ts');
  });
});

// ------------------------------------------------------------------ blocked runs and resume (D55)

describe('GET /triage/:run_id on a blocked run', () => {
  test('status blocked, the open block, an empty history and no report', async () => {
    const h = harness({ runs: { [RUN_A]: blockedRecord(RUN_A) } });
    const res = await h.app.request(`/triage/${RUN_A}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('blocked');
    expect(json.phase).toBe('blocked');
    expect(json.block).toEqual(sampleBlock('b1'));
    expect(json.block_history).toEqual([]);
    expect('report' in json).toBe(false);
  });

  test('a closed block sits in block_history with block null, and the resume submission is listed', async () => {
    const closed = { ...sampleBlock('b1'), status: 'resumed' as const, resolved_at: AT, resolved_by: 'ops-reviewer', note: 'harbor is back' };
    const resume: RunRecord['submissions'][number] = { seq: 2, kind: 'resume', block_id: 'b1', note: 'harbor is back', created_at: AT, report: null, report_md: null };
    const run: RunRecord = { ...record(RUN_A, 'investigating'), block_history: [closed], submissions: [INITIAL, resume] };
    const json = (await (await harness({ runs: { [RUN_A]: run } }).app.request(`/triage/${RUN_A}`)).json()) as Record<string, unknown>;
    expect(json.status).toBe('running');
    expect(json.block).toBeNull();
    expect(json.block_history).toEqual([closed]);
    expect((json.submissions as Record<string, unknown>[])[1]).toEqual({ seq: 2, kind: 'resume', created_at: AT, has_report: false });
  });

  test('a synthetic phone in the block reason comes back masked', async () => {
    const run: RunRecord = { ...blockedRecord(RUN_A), block: { ...sampleBlock('b1'), reason: `harbor did not answer for ${SYNTHETIC_PHONE}` } };
    const text = await (await harness({ runs: { [RUN_A]: run } }).app.request(`/triage/${RUN_A}`)).text();
    expect(text).not.toContain(SYNTHETIC_PHONE);
    expect((JSON.parse(text) as { block: { reason: string } }).block.reason).toContain('****3210');
  });

  test('a bare record renders block null and an empty history', () => {
    const view = runView(record(RUN_A, 'created'));
    expect(view.block).toBeNull();
    expect(view.block_history).toEqual([]);
  });
});

describe('GET /triage/:run_id stalled (D71)', () => {
  const STALLED = { reason: 'no_owner' as const, since: '2026-09-24T00:01:00.000Z' };

  test('runView adds stalled when given, next to usage and outside the redaction, and keeps status running', () => {
    const view = runView(record(RUN_A, 'investigating'), undefined, STALLED);
    expect(view.stalled).toEqual(STALLED);
    expect(view.status).toBe('running');
    expect(view.phase).toBe('investigating');
    expect('stalled' in runView(record(RUN_A, 'investigating'))).toBe(false);
    expect('stalled' in runView(record(RUN_A, 'investigating'), undefined, null)).toBe(false);
  });

  test('the route passes the run to deps.stalled and answers what it returns', async () => {
    const seen: string[] = [];
    const h = harness({
      runs: { [RUN_A]: record(RUN_A, 'investigating') },
      stalled: async (run) => {
        seen.push(run.run_id);
        return STALLED;
      },
    });
    const json = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as Record<string, unknown>;
    expect(seen).toEqual([RUN_A]);
    expect(json.stalled).toEqual(STALLED);
    expect(json.status).toBe('running');
  });

  test('a stalled check that fails leaves stalled out', async () => {
    const h = harness({
      runs: { [RUN_A]: record(RUN_A, 'investigating') },
      stalled: async () => {
        throw new Error('lease read failed');
      },
    });
    const res = await h.app.request(`/triage/${RUN_A}`);
    expect(res.status).toBe(200);
    expect('stalled' in ((await res.json()) as Record<string, unknown>)).toBe(false);
  });

  test('by default a dead worker pid shows no_owner, and a quiet events.jsonl no_progress', async () => {
    const pidRun: RunRecord = { ...record(RUN_A, 'investigating'), worker_pid: 4242 };
    let json = (await (await harness({ runs: { [RUN_A]: pidRun }, isAlive: () => false }).app.request(`/triage/${RUN_A}`)).json()) as Record<
      string,
      unknown
    >;
    expect((json.stalled as { reason: string }).reason).toBe('no_owner');

    const runsDir = mkdtempSync(join(tmpdir(), 'triage-routes-stalled-'));
    try {
      const quiet = '2026-09-24T00:00:00.000Z';
      mkdirSync(join(runsDir, RUN_B), { recursive: true });
      writeFileSync(join(runsDir, RUN_B, 'events.jsonl'), `${JSON.stringify({ ts: quiet, source: 'pipeline', type: 'phase', data: {} })}\n`);
      const h = harness({ runs: { [RUN_B]: record(RUN_B, 'investigating') }, runsDir, stalledAfterMs: 60_000 });
      json = (await (await h.app.request(`/triage/${RUN_B}`)).json()) as Record<string, unknown>;
      expect(json.stalled).toEqual({ reason: 'no_progress', since: quiet });
      expect(json.status).toBe('running');

      // A finished run is never stalled, whatever its log says.
      writeFileSync(join(runsDir, RUN_B, 'events.jsonl'), `${JSON.stringify({ ts: quiet, source: 'pipeline', type: 'phase', data: {} })}\n`);
      const done = harness({ runs: { [RUN_B]: record(RUN_B, 'completed') }, runsDir, stalledAfterMs: 60_000 });
      json = (await (await done.app.request(`/triage/${RUN_B}`)).json()) as Record<string, unknown>;
      expect('stalled' in json).toBe(false);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe('POST /triage/:run_id/resume', () => {
  const body = { requested_by: 'ops@example.com', note: 'harbor is back' };

  test('a blocked run -> 202 {run_id, submission_id}; the resume gets who and the note', async () => {
    const h = harness({ runs: { [RUN_A]: blockedRecord(RUN_A) } });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, body);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: 'sub-3', mode: 'resume' });
    expect(h.resumes).toEqual([[RUN_A, { by: 'ops@example.com', note: 'harbor is back' }]]);
  });

  test('the note is trimmed; a blank or missing note is left out', async () => {
    const h = harness({ runs: { [RUN_A]: blockedRecord(RUN_A) } });
    await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: '  fixed the tunnel  ' });
    await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: '   ' });
    await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    expect(h.resumes.map(([, input]) => input)).toEqual([{ by: 'ops', note: 'fixed the tunnel' }, { by: 'ops' }, { by: 'ops' }]);
  });

  test('a run that failed or was stopped after dispatch is resumed', async () => {
    for (const phase of ['failed', 'stopped'] as const) {
      const h = harness({ runs: { [RUN_A]: { ...record(RUN_A, phase), phase_reason: 'AgentRunError', submissions: [INITIAL] } } });
      const res = await post(h.app, `/triage/${RUN_A}/resume`, body);
      expect(res.status).toBe(202);
      expect(h.resumes).toEqual([[RUN_A, { by: 'ops@example.com', note: 'harbor is back' }]]);
    }
  });

  test.each([
    ['created', record(RUN_A, 'created'), RESUME_HINTS.starting],
    ['investigating with no submission', record(RUN_A, 'investigating'), RESUME_HINTS.starting],
    ['waiting on a question', record(RUN_A, 'needs_input'), RESUME_HINTS.needs_input],
    ['completed', { ...record(RUN_A, 'completed'), submissions: [INITIAL] }, RESUME_HINTS.completed],
    ['failed before dispatch', record(RUN_A, 'failed'), RESUME_HINTS.never_started],
    ['stopped before dispatch', record(RUN_A, 'stopped'), RESUME_HINTS.never_started],
  ])('a run that is %s -> 409 with the phase and a hint, nothing started', async (_name, run, hint) => {
    const h = harness({ runs: { [RUN_A]: run } });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, body);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run is not resumable', phase: run.phase, hint });
    expect(h.resumes).toHaveLength(0);
  });

  test('an unknown run -> 404 and a malformed id -> 400; nothing started', async () => {
    const h = harness();
    expect((await post(h.app, `/triage/${UNKNOWN_RUN}/resume`, body)).status).toBe(404);
    expect((await post(h.app, '/triage/not%20a%20run/resume', body)).status).toBe(400);
    expect(h.resumes).toHaveLength(0);
  });

  test.each([
    ['a missing requested_by', { note: 'x' }, ['requested_by']],
    ['a blank requested_by', { requested_by: '   ' }, ['requested_by']],
    ['a note over the limit', { requested_by: 'ops', note: 'x'.repeat(MAX_RESUME_NOTE_CHARS + 1) }, ['note']],
    ['a note that is not text', { requested_by: 'ops', note: 5 }, ['note']],
    ['a body that is not an object', '"just text"', ['body']],
  ])('%s -> 400 naming the field, nothing started', async (_name, b, fields) => {
    const h = harness({ runs: { [RUN_A]: blockedRecord(RUN_A) } });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, b);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; fields: string[] };
    expect(json.error).toBe('invalid request');
    expect(json.fields).toEqual(fields);
    expect(h.resumes).toHaveLength(0);
  });

  test('invalid JSON -> 400; error bodies never repeat the values sent', async () => {
    const h = harness({ runs: { [RUN_A]: blockedRecord(RUN_A) } });
    expect((await post(h.app, `/triage/${RUN_A}/resume`, '{not json')).status).toBe(400);
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: `${'x'.repeat(MAX_RESUME_NOTE_CHARS)} ${SYNTHETIC_PHONE}` });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SYNTHETIC_PHONE);
    expect(h.resumes).toHaveLength(0);
  });

  test('a resume that fails before dispatch is mapped, not left hanging', async () => {
    const failing = (err: unknown) => (): AskStart => ({ dispatched: new Promise(() => undefined), settled: Promise.reject(err) });
    const runs = { [RUN_A]: blockedRecord(RUN_A) };

    const gone = await post(harness({ runs, resume: failing(new RunNotFoundError(RUN_A)) }).app, `/triage/${RUN_A}/resume`, body);
    expect(gone.status).toBe(404);

    // The run moved on between the route's check and the resume.
    const moved = await post(
      harness({ runs, resume: failing(new RunNotResumableError(RUN_A, 'investigating', RESUME_HINTS.running)) }).app,
      `/triage/${RUN_A}/resume`,
      body,
    );
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ error: 'run is not resumable', phase: 'investigating', hint: RESUME_HINTS.running });

    const bad = await post(harness({ runs, resume: failing(new IngressInputError('by', 'is required')) }).app, `/triage/${RUN_A}/resume`, body);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: string[] }).fields).toEqual(['requested_by']);
  });

  test('when the reply lands before the receipt, the submission id comes from the result', async () => {
    const h = harness({
      runs: { [RUN_A]: blockedRecord(RUN_A) },
      resume: () => ({ dispatched: new Promise(() => undefined), settled: Promise.resolve({ submission_id: 'sub-9' }) }),
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, body);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: 'sub-9', mode: 'resume' });

    const steered = harness({
      runs: { [RUN_A]: { ...record(RUN_A, 'investigating'), submissions: [INITIAL] } },
      resume: () => ({ dispatched: new Promise(() => undefined), settled: Promise.resolve({ submission_id: 'sub-9', mode: 'steer' }) }),
    });
    const r = await post(steered.app, `/triage/${RUN_A}/resume`, body);
    expect(await r.json()).toEqual({ run_id: RUN_A, submission_id: 'sub-9', mode: 'steer' });
  });

  test('a later failure of the resume is reported as resume, never thrown into the response', async () => {
    const seen: string[] = [];
    const h = harness({
      runs: { [RUN_A]: blockedRecord(RUN_A) },
      resume: () => ({
        dispatched: Promise.resolve('sub-3'),
        settled: tick().then(() => {
          throw new Error('boom');
        }),
      }),
      onBackgroundError: (runId, what) => seen.push(`${what}:${runId}`),
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, body);
    expect(res.status).toBe(202);
    await tick();
    await tick();
    expect(seen).toEqual([`resume:${RUN_A}`]);
  });
});

describe('POST /triage/:run_id/resume on a working run (D72)', () => {
  const working = (): RunRecord => ({ ...record(RUN_A, 'investigating'), submissions: [INITIAL] });
  const STALLED = { reason: 'no_owner' as const, since: AT };

  test('with a message -> 202 with the mode resumeRun chose', async () => {
    const h = harness({
      runs: { [RUN_A]: working() },
      resume: (runId, input): ResumeStart => {
        h.resumes.push([runId, input]);
        return { dispatched: Promise.resolve('sub-4'), mode: Promise.resolve('steer'), settled: new Promise(() => undefined) };
      },
      // A stalled check that fails counts as not stalled: the message is a steer.
      stalled: async () => {
        throw new Error('no lease to read');
      },
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'the payout went out at 10:02' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: 'sub-4', mode: 'steer' });
    expect(h.resumes).toEqual([[RUN_A, { by: 'ops', note: 'the payout went out at 10:02' }]]);
  });

  test('stalled: 202 {submission_id: null, mode: resume} at once, before the stop and the dispatch; a later failure is reported', async () => {
    let fail!: (err: unknown) => void;
    const seen: string[] = [];
    const h = harness({
      runs: { [RUN_A]: working() },
      stalled: async () => STALLED,
      resume: (runId, input): ResumeStart => {
        h.resumes.push([runId, input]);
        return {
          // The stop, the abort and the wait are still running.
          dispatched: new Promise(() => undefined),
          mode: Promise.resolve('resume'),
          settled: new Promise((_, reject) => (fail = reject)),
        };
      },
      onBackgroundError: (runId, what, err) => seen.push(`${what}:${runId}:${(err as Error).message}`),
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'the worker died' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: null, mode: 'resume' });
    expect(h.resumes).toEqual([[RUN_A, { by: 'ops', note: 'the worker died' }]]);
    fail(new Error('abort failed'));
    await tick();
    await tick();
    expect(seen).toEqual([`resume:${RUN_A}:abort failed`]);
  });

  test('stalled, but resumeRun steers it after all: the answer waits for the steer and gives its id', async () => {
    const h = harness({
      runs: { [RUN_A]: working() },
      stalled: async () => STALLED,
      resume: (): ResumeStart => ({ dispatched: tick().then(() => 'sub-6'), mode: Promise.resolve('steer'), settled: new Promise(() => undefined) }),
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'look' });
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: 'sub-6', mode: 'steer' });
  });

  test('stalled: a refusal before resumeRun chose (the tunnel) is still 409, and not reported as a background failure', async () => {
    const seen: string[] = [];
    const h = harness({
      runs: { [RUN_A]: working() },
      stalled: async () => STALLED,
      resume: (): ResumeStart => ({
        dispatched: new Promise(() => undefined),
        mode: new Promise(() => undefined),
        settled: Promise.reject(new RunNotResumableError(RUN_A, 'investigating', 'SSFB DB tunnel did not start; triage tunnel up')),
      }),
      onBackgroundError: (runId, what) => seen.push(`${what}:${runId}`),
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run is not resumable', phase: 'investigating', hint: 'SSFB DB tunnel did not start; triage tunnel up' });
    await tick();
    expect(seen).toEqual([]);
  });

  test('a run another process stopped as stalled a moment ago is 409 in_progress; one left over past the hold is resumed', async () => {
    const long = new Date(Date.now() - 10 * STALLED_STOP_HOLD_MS).toISOString();
    const initial = { ...INITIAL, created_at: long };
    const runs = { [RUN_A]: { ...working(), submissions: [initial], phase: 'stopped' as const, phase_reason: 'stalled', updated_at: new Date().toISOString() } };
    const h = harness({ runs });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'again' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run is not resumable', phase: 'stopped', hint: RESUME_HINTS.in_progress });
    expect(h.resumes).toHaveLength(0);

    // The process that stopped it died: once the hold has passed the stop is left over.
    runs[RUN_A] = { ...runs[RUN_A]!, updated_at: new Date(Date.now() - STALLED_STOP_HOLD_MS - 1000).toISOString() };
    const later = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'again' });
    expect(later.status).toBe(202);
    expect(h.resumes).toHaveLength(1);
  });

  test('a stalled resume that fails after its stop and before its dispatch leaves the run failed, with the reason and a phase line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'triage-stalled-fail-'));
    const runsDir = join(root, 'runs');
    installRunEventLog({ runsDir, observe: () => () => undefined });
    try {
      const folder = createFolderRunStore({ runsDir, dataDir: join(root, 'data') });
      await folder.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
      await folder.addSubmission(RUN_A, redactPersisted({ kind: 'initial' as const }));
      await folder.setPhase(RUN_A, 'investigating');
      // The resume's own submission cannot be written, once: it fails after the stop, before the dispatch.
      let broken = true;
      const store = new Proxy(folder, {
        get(target, prop) {
          if (prop === 'addSubmission' && broken) {
            broken = false;
            return async () => Promise.reject(new Error('store went away'));
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const dispatcher: Dispatcher = {
        init() {
          return {
            dispatch: async () => ({ submissionId: 'sub-9', acceptedAt: AT }),
            read: () => new Promise<AgentReply>(() => undefined),
            abort: async () => undefined,
          } as unknown as AgentHandle;
        },
      };
      const settle: SettleDeps = {
        config: { mock: { enabled: true }, runs: { priorCases: false }, budgets: { runTimeoutMs: 60_000, runMaxAttempts: 1 } },
        store,
        dispatcher,
        agent: {} as Agent,
        embedder: null,
        stalled: async () => STALLED,
        lease: async () => null,
        stopPollMs: 0,
      };
      let reported!: () => void;
      const failed = new Promise<void>((resolve) => (reported = resolve));
      const seen: string[] = [];
      const h = harness({
        store,
        stalled: async () => STALLED,
        resume: (runId, input) => startResume(runId, input, settle),
        onBackgroundError: (runId, what, err) => {
          seen.push(`${what}:${runId}:${(err as Error).message}`);
          reported();
        },
      });
      const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'the worker died' });
      expect(res.status).toBe(202);
      await failed;
      expect(seen).toEqual([`resume:${RUN_A}:store went away`]);
      const run = await folder.getRun(RUN_A);
      expect([run?.phase, run?.phase_reason]).toEqual(['failed', 'Error: store went away']);
      // Failed, it takes a resume again at once.
      expect((await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' })).status).toBe(202);

      await flushRunEventLog();
      const { events } = await readRunEvents(runsDir, RUN_A);
      const pipeline = events.filter((e) => e.source === 'pipeline').map((e) => [e.type, e.data]);
      expect(pipeline).toContainEqual(['phase', { phase: 'failed', reason: 'Error: store went away' }]);
    } finally {
      await flushRunEventLog();
      uninstallRunEventLog();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('one resume at a time per run: a second one while the first has not dispatched is 409 in_progress', async () => {
    let dispatch!: (id: string) => void;
    let calls = 0;
    const runs = { [RUN_A]: working(), [RUN_B]: { ...record(RUN_B, 'investigating'), submissions: [INITIAL] } };
    const h = harness({
      runs,
      stalled: async () => STALLED,
      resume: (runId, input): ResumeStart => {
        calls += 1;
        h.resumes.push([runId, input]);
        if (runId === RUN_B) return { dispatched: Promise.resolve('sub-b'), mode: Promise.resolve('resume'), settled: new Promise(() => undefined) };
        return { dispatched: new Promise((resolve) => (dispatch = resolve)), mode: Promise.resolve('resume'), settled: new Promise(() => undefined) };
      },
    });
    const first = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    expect(first.status).toBe(202);
    // The run shows stopped while the resume waits for the old submission; a second press must not resume it again.
    runs[RUN_A] = { ...working(), phase: 'stopped', phase_reason: 'stalled' };
    const second = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'again' });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'run is not resumable', phase: 'stopped', hint: RESUME_HINTS.in_progress });
    // Another run is not held up.
    expect((await post(h.app, `/triage/${RUN_B}/resume`, { requested_by: 'ops' })).status).toBe(202);
    expect(calls).toBe(2);

    // Once the first resume dispatched, the run takes a resume again.
    dispatch('sub-a');
    await tick();
    runs[RUN_A] = working();
    const third = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'look' });
    expect(third.status).toBe(202);
    expect(calls).toBe(3);
  });

  test('the guard covers any resume: a blocked run whose resume has not dispatched yet refuses a second one', async () => {
    let dispatch!: (id: string) => void;
    const h = harness({
      runs: { [RUN_A]: blockedRecord(RUN_A) },
      resume: (): ResumeStart => ({ dispatched: new Promise((resolve) => (dispatch = resolve)), settled: new Promise(() => undefined) }),
    });
    const first = post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    await tick();
    const second = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { hint: string }).hint).toBe(RESUME_HINTS.in_progress);
    dispatch('sub-3');
    expect((await first).status).toBe(202);
  });

  test('a resume that fails before its dispatch frees the run for the next one', async () => {
    let n = 0;
    const h = harness({
      runs: { [RUN_A]: blockedRecord(RUN_A) },
      resume: (): ResumeStart => {
        n += 1;
        return n === 1
          ? { dispatched: new Promise(() => undefined), settled: Promise.reject(new Error('dispatch failed')) }
          : { dispatched: Promise.resolve('sub-3'), settled: new Promise(() => undefined) };
      },
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    errorSpy.mockRestore();
    expect(failed.status).toBe(500);
    expect((await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' })).status).toBe(202);
  });

  test('no message: 409 with the steer hint unless the run stalled, then 202 resume', async () => {
    const quiet = harness({ runs: { [RUN_A]: working() }, stalled: async () => null });
    const refused = await post(quiet.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'run is not resumable', phase: 'investigating', hint: RESUME_HINTS.running });
    expect(quiet.resumes).toHaveLength(0);

    const seen: RunRecord[] = [];
    const h = harness({
      runs: { [RUN_A]: working() },
      stalled: async (run) => {
        seen.push(run);
        return STALLED;
      },
      resume: (runId, input): ResumeStart => {
        h.resumes.push([runId, input]);
        return { dispatched: Promise.resolve('sub-5'), mode: Promise.resolve('resume'), settled: new Promise(() => undefined) };
      },
    });
    const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A, submission_id: null, mode: 'resume' });
    expect(seen.map((r) => r.run_id)).toEqual([RUN_A]);
  });

  test('a waiting or completed run stays 409 with its own hint, with or without a message', async () => {
    for (const [run, hint] of [
      [record(RUN_A, 'needs_input'), RESUME_HINTS.needs_input],
      [{ ...record(RUN_A, 'completed'), submissions: [INITIAL] }, RESUME_HINTS.completed],
    ] as const) {
      const h = harness({ runs: { [RUN_A]: run } });
      const res = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops', note: 'look at the bank reply' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'run is not resumable', phase: run.phase, hint });
      expect(h.resumes).toHaveLength(0);
    }
  });
});

describe('startResume', () => {
  test('closes the block, dispatches the resume signal on the same instance and resolves dispatched before the reply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'triage-resume-'));
    try {
      const store = createFolderRunStore({ runsDir: join(root, 'runs'), dataDir: join(root, 'data') });
      await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
      await store.addSubmission(RUN_A, redactPersisted({ kind: 'initial' as const }));
      await store.putBlock(RUN_A, redactPersisted(sampleBlock('b1')));

      let finishRead: ((reply: AgentReply) => void) | undefined;
      const inits: InitOptions[] = [];
      const messages: { kind: string; type?: string; body: string }[] = [];
      const dispatcher: Dispatcher = {
        init(_agent, options) {
          inits.push(options);
          const handle = {
            dispatch: async (request: { message?: { kind: string; type?: string; body: string } }) => {
              if (request.message !== undefined) messages.push(request.message);
              return { submissionId: 'sub-8', acceptedAt: AT };
            },
            read: () => new Promise<AgentReply>((resolve) => (finishRead = resolve)),
            abort: async () => undefined,
          };
          return handle as unknown as AgentHandle;
        },
      };
      const deps: SettleDeps = {
        config: { mock: { enabled: true }, runs: { priorCases: false }, budgets: { runTimeoutMs: 60_000, runMaxAttempts: 1 } },
        store,
        dispatcher,
        agent: {} as Agent,
        embedder: null,
        embedRun: async () => ({ gaps: [] }) as unknown as Awaited<ReturnType<NonNullable<SettleDeps['embedRun']>>>,
        now: () => new Date(AT),
      };
      const started = startResume(RUN_A as RunId, { by: 'ops-reviewer', note: 'harbor is back' }, deps);
      expect(await started.dispatched).toBe('sub-8');
      expect(await started.mode).toBe('resume');
      expect(inits).toEqual([{ id: RUN_A }]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'signal', type: BLOCK_RESUME_SIGNAL });
      expect(messages[0]?.body).toContain('ssfb:harbor');
      expect(messages[0]?.body).toContain('harbor is back');

      // The block is closed and the resume submission stored before the reply arrives.
      const parked = await store.getRun(RUN_A);
      expect(parked?.block).toBeNull();
      expect(parked?.block_history.map((b) => [b.block_id, b.status, b.resolved_by, b.note])).toEqual([['b1', 'resumed', 'ops-reviewer', 'harbor is back']]);
      expect(parked?.submissions.map((s) => [s.seq, s.kind, s.block_id, s.note])).toEqual([
        [1, 'initial', undefined, undefined],
        [2, 'resume', 'b1', 'harbor is back'],
      ]);

      for (let i = 0; i < 20 && finishRead === undefined; i++) await tick();
      expect(finishRead).toBeDefined();
      finishRead?.({ text: 'done', submissionId: 'sub-8' } as unknown as AgentReply);
      const result = (await started.settled) as { status: string; submission_id: string; submission_seq: number };
      expect(result).toMatchObject({ status: 'completed', submission_id: 'sub-8', submission_seq: 2 });
      expect((await store.getRun(RUN_A))?.phase).toBe('completed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('startResume on a working run (D72)', () => {
  test('mode resolves steer before the dispatch, and the steer is sent as its own submission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'triage-steer-'));
    try {
      const store = createFolderRunStore({ runsDir: join(root, 'runs'), dataDir: join(root, 'data') });
      await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
      await store.addSubmission(RUN_A, redactPersisted({ kind: 'initial' as const }));
      await store.setPhase(RUN_A, 'investigating');

      const order: string[] = [];
      const dispatcher: Dispatcher = {
        init() {
          return {
            dispatch: async () => {
              order.push('dispatch');
              return { submissionId: 'sub-9', acceptedAt: AT };
            },
            read: () => new Promise<AgentReply>(() => undefined),
            abort: async () => undefined,
          } as unknown as AgentHandle;
        },
      };
      const deps: SettleDeps = {
        config: { mock: { enabled: true }, runs: { priorCases: false }, budgets: { runTimeoutMs: 60_000, runMaxAttempts: 1 } },
        store,
        dispatcher,
        agent: {} as Agent,
        embedder: null,
        now: () => new Date(AT),
        stalled: async () => null,
        onResumeMode: (m) => order.push(`mode:${m}`),
      };
      const started = startResume(RUN_A as RunId, { by: 'ops', note: 'the payout went out' }, deps);
      expect(await started.dispatched).toBe('sub-9');
      expect(await started.mode).toBe('steer');
      // The caller's own listener still hears it, before the dispatch.
      expect(order).toEqual(['mode:steer', 'dispatch']);
      const run = await store.getRun(RUN_A);
      expect(run?.phase).toBe('investigating');
      expect(run?.submissions.map((s) => [s.seq, s.kind, s.note])).toEqual([
        [1, 'initial', undefined],
        [2, 'steer', 'the payout went out'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ stop, events and verdicts before the report

describe('POST /triage/:run_id/stop, GET /triage/:run_id/events, feedback on a running run', () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function realStore(): Promise<{ store: RunStore; runsDir: string; home: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'triage-routes-stop-'));
    tmp.push(dir);
    const runsDir = join(dir, 'runs');
    const store = createFolderRunStore({ runsDir, dataDir: join(dir, 'data') });
    await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
    await store.addSubmission(RUN_A, redactPersisted({ kind: 'initial' as const }));
    await store.setPhase(RUN_A, 'investigating');
    return { store, runsDir, home: dir };
  }

  test('stop marks the run stopped, records the Cancel verdict and asks Flue to abort', async () => {
    const { store, home } = await realStore();
    const aborted: string[] = [];
    const h = harness({ store, home, abortRun: async (id) => void aborted.push(id), recordFeedback: undefined as never });
    const res = await post(h.app, `/triage/${RUN_A}/stop`, { given_by: 'ops@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: RUN_A, stopped_from: 'investigating', aborted: true, feedback_count: 1, gaps: [] });
    expect(aborted).toEqual([RUN_A]);
    const view = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as Record<string, any>;
    expect(view.status).toBe('stopped');
    expect(view.phase).toBe('stopped');
    expect(view.feedback[0]).toMatchObject({ verdict: 'wrong', cancelled: true, phase: 'investigating' });

    // A second stop: the run has finished.
    const again = await post(h.app, `/triage/${RUN_A}/stop`, { given_by: 'ops@example.com' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'run is not running', phase: 'stopped' });
  });

  test('stop on a blocked run closes the block as cancelled; the stopped run can then be resumed', async () => {
    const { store, home } = await realStore();
    await store.putBlock(RUN_A, redactPersisted(sampleBlock('b1')));
    const h = harness({ store, home, recordFeedback: undefined as never });
    const before = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as Record<string, any>;
    expect(before.status).toBe('blocked');
    expect(before.block.block_id).toBe('b1');

    // A plain name: the persisted profile masks an email in the stored resolution.
    const res = await post(h.app, `/triage/${RUN_A}/stop`, { given_by: 'ops-reviewer' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped_from: string }).stopped_from).toBe('blocked');
    const view = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as Record<string, any>;
    expect(view.status).toBe('stopped');
    expect(view.block).toBeNull();
    expect(view.block_history).toHaveLength(1);
    expect(view.block_history[0]).toMatchObject({ block_id: 'b1', status: 'cancelled', resolved_by: 'ops-reviewer' });

    // Stopped after dispatch: the conversation exists, so a resume is accepted.
    const resumed = await post(h.app, `/triage/${RUN_A}/resume`, { requested_by: 'ops-reviewer' });
    expect(resumed.status).toBe(202);
    expect(h.resumes).toEqual([[RUN_A, { by: 'ops-reviewer' }]]);
  });

  test('stop with verdict false records no feedback; bad bodies and unknown runs are refused', async () => {
    const { store, home } = await realStore();
    const h = harness({ store, home });
    expect((await post(h.app, `/triage/${RUN_A}/stop`, {})).status).toBe(400);
    expect((await post(h.app, `/triage/${RUN_A}/stop`, 'not json')).status).toBe(400);
    expect((await post(h.app, '/triage/..%2Fx/stop', { given_by: 'ops' })).status).toBe(400);
    expect((await post(h.app, `/triage/${RUN_B}/stop`, { given_by: 'ops' })).status).toBe(404);
    const res = await post(h.app, `/triage/${RUN_A}/stop`, { given_by: 'ops', verdict: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { feedback_count: unknown }).feedback_count).toBeNull();
    expect((await store.getRun(RUN_A))?.feedback).toEqual([]);
  });

  test('feedback on a run with no report is stored, with notes and the phase', async () => {
    const { store, home } = await realStore();
    const h = harness({ store, home, recordFeedback: undefined as never });
    const res = await post(h.app, `/triage/${RUN_A}/feedback`, { verdict: 'correct', notes: 'on the right track', given_by: 'ops' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: RUN_A, verdict: 'correct', count: 1 });
    expect((await store.getRun(RUN_A))?.feedback_latest).toMatchObject({ notes: 'on the right track', phase: 'investigating' });
    // Finding verdicts are checked against the run's findings.
    const bad = await post(h.app, `/triage/${RUN_A}/feedback`, { verdict: 'wrong', findings: [{ id: 'ssfb.v1.e1', verdict: 'wrong' }], given_by: 'ops' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: string[] }).fields).toEqual(['findings.0.id']);
  });

  test('the run view lists the findings the feedback route takes', async () => {
    const { store, home } = await realStore();
    await store.putEvidence(
      RUN_A,
      'ssfb',
      redactPersisted({ evidence: [{ source: 'db' as const, at: '2026-09-20T10:00:00.000Z', query_or_path: 'select 1', summary: 'row found' }], timeline: [], hypotheses: ['h'], confidence: 'low' as const, gaps: [] }),
    );
    const h = harness({ store, home });
    const view = (await (await h.app.request(`/triage/${RUN_A}`)).json()) as { findings: { id: string }[] };
    expect(view.findings.map((f) => f.id)).toEqual(['ssfb.v1.e1', 'ssfb.v1.h1']);
  });

  test('events pages through the run event log', async () => {
    const { store, home, runsDir } = await realStore();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(runsDir, RUN_A), { recursive: true });
    const line = (i: number) => JSON.stringify({ ts: '2026-09-25T10:00:00.000Z', source: 'pipeline', type: 'phase', data: { i } });
    writeFileSync(join(runsDir, RUN_A, 'events.jsonl'), `${line(0)}\n${line(1)}\n${line(2)}\n`);
    const h = harness({ store, home, runsDir });
    const first = (await (await h.app.request(`/triage/${RUN_A}/events?limit=2`)).json()) as { events: { index: number }[]; next: number; more: boolean };
    expect(first.events.map((e) => e.index)).toEqual([0, 1]);
    expect(first).toMatchObject({ next: 2, more: true });
    const rest = (await (await h.app.request(`/triage/${RUN_A}/events?after=2`)).json()) as { events: unknown[]; more: boolean };
    expect(rest.events).toHaveLength(1);
    expect((await h.app.request(`/triage/${RUN_A}/events?after=x`)).status).toBe(400);
    expect((await h.app.request(`/triage/${RUN_B}/events`)).status).toBe(404);
    // Without a runs dir the log is empty.
    const none = harness({ store, home });
    expect(await (await none.app.request(`/triage/${RUN_A}/events`)).json()).toEqual({ events: [], next: 0, more: false });
  });
});
