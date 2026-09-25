import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, AgentReply, InitOptions } from '@flue/runtime';
import { FeedbackError, type FeedbackDeps, type FeedbackInput, type FeedbackResult } from '../../report/feedback.ts';
import type { RunPhase, RunRecord, RunStore } from '../../runstore/types.ts';
import type { RunId } from '../../types/core.ts';
import { prepareRequest, type PrepareDeps, type PrepareInput, type PreparedSubmission } from '../prepare.ts';
import { SlackFetchError, type SlackThread, type SlackThreadRef } from '../slack.ts';
import type { AgentHandle, Dispatcher, SettleDeps } from '../submit.ts';
import {
  createTriageRoutes,
  IDEMPOTENCY_TTL_MS,
  MESSAGES_HINT,
  runView,
  SLACK_POST_DISABLED,
  SLACK_POST_NOT_IMPLEMENTED,
  startAsk,
  type AskStart,
  type TriageRouteDeps,
} from './routes.ts';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from './schemas.ts';

// Synthetic ids and people only. The phone below is a made-up test number.
const RUN_A = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const RUN_B = '01J8Z3K4M5N6P7Q8R9S0T1V2W4';
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
  };
}

type FakeStore = RunStore & { claims: Map<string, string>; calls: string[] };

function fakeStore(runs: Record<string, RunRecord> = {}): FakeStore {
  const claims = new Map<string, string>();
  const calls: string[] = [];
  const impl = {
    claims,
    calls,
    provider: 'folder',
    async getRun(runId: string) {
      calls.push('getRun');
      return runs[runId] ?? null;
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
  feedback: [string, FeedbackInput, FeedbackDeps][];
  app: ReturnType<typeof createTriageRoutes>;
};

function harness(over: Partial<TriageRouteDeps> & { runs?: Record<string, RunRecord> } = {}): Harness {
  const { runs, ...rest } = over;
  const store = fakeStore(runs);
  const prepared: PrepareInput[] = [];
  const submitted: PreparedSubmission[] = [];
  const asks: [string, string, string][] = [];
  const feedback: [string, FeedbackInput, FeedbackDeps][] = [];
  const ids = [RUN_A, RUN_B, '01J8Z3K4M5N6P7Q8R9S0T1V2W5'];
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
  return { deps, store, prepared, submitted, asks, feedback, app: createTriageRoutes(deps) };
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
    const res = await post(h.app, '/triage', { messages: MESSAGES, requested_by: 'ops@example.com', tier: 'mid', ids: { user_id: 'u-1' } });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: RUN_A });
    expect(h.prepared).toEqual([
      {
        interface: 'http',
        requested_by: 'ops@example.com',
        kind: 'json',
        body: { messages: MESSAGES, requested_by: 'ops@example.com', tier: 'mid', ids: { user_id: 'u-1' } },
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

  test('an ask that fails before dispatch is mapped, not left hanging', async () => {
    const { RunNotFoundError } = await import('../../runstore/types.ts');
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

  test('FeedbackError codes map to 404, 409 and 400', async () => {
    for (const [code, status] of [
      ['run_not_found', 404],
      ['no_report', 409],
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
