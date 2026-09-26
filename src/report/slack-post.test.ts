// slack-client.ts and slack-post.ts with a fake run store, a temp fixtures
// tree, a memory audit sink and an injected fake fetch. No network: the real
// client only ever sees the fake fetch, and the no-io guard blocks the rest.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import * as v from 'valibot';
import { configFromRecord } from '../config/env.ts';
import { createMemoryAuditSink } from '../gate/audit-sink.ts';
import { serializeAuditLine } from '../gate/audit.ts';
import { keyHash, keyString, semanticKey } from '../mock/key.ts';
import { createResolver } from '../mock/resolve.ts';
import { createFixtureStore } from '../mock/store.ts';
import type { RunRecord } from '../runstore/types.ts';
import type { TriageRequest } from '../types/request.ts';
import { requireApproval, type Approval } from './approval.ts';
import { ReportSchema, type Report } from './schema.ts';
import {
  createMemorySlackSink,
  createRealSlackClient,
  createRecordingSlackClient,
  createSlackClient,
  SLACK_API_BASE,
  SlackClientError,
  type FetchLike,
} from './slack-client.ts';
import {
  AUDIT_TARGET,
  AUDIT_TOOL,
  postReport,
  prepareSlackPost,
  recordApprovalRefusal,
  SlackPostRefusal,
  slackTargetOf,
  type PreparedSlackPost,
  type SlackPostDeps,
} from './slack-post.ts';

// All values below are synthetic.
// A ULID with six digits in a row, which the persisted profile would mask.
const RUN_ID = '01J8ZQ7XK3PSEUDRUN00000001';
const CHANNEL = 'C0SYNTH01';
const THREAD_TS = '1695460000.123456';
const REVIEWER_EMAIL = 'reviewer@example.test';
const REVIEWER_ID = 'U0PSEUDOREV';
const GROUP = '@banking-triage';
const TOKEN = 'xoxb-synthetic-test-token-value';
const NOW = () => new Date('2026-09-24T10:00:00.000Z');

const REPORT_TEXT = readFileSync(join(import.meta.dir, '__fixtures__', 'sample-report.json'), 'utf8');
const sampleReport = (): Report => v.parse(ReportSchema, JSON.parse(REPORT_TEXT));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'triage-slack-post-'));
  dirs.push(d);
  return d;
}

// ------------------------------------------------------------------ helpers

type Source = TriageRequest['source'];

function runRecord(o: { report?: Report | null; source?: Source; requestedBy?: string; slackTarget?: unknown } = {}): RunRecord {
  const report = o.report === undefined ? sampleReport() : o.report;
  const request: TriageRequest = {
    request_id: RUN_ID,
    interface: 'cli',
    requested_by: o.requestedBy ?? 'cx-oncall',
    source: o.source ?? { kind: 'slack', channel_id: CHANNEL, thread_ts: THREAD_TS, permalink: 'https://example.test/p' },
    messages: [],
    attachments: [],
    hints: {},
    window: { from: '2026-09-17T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' },
    received_at: '2026-09-20T10:00:00.000Z',
  } as TriageRequest;
  const record: RunRecord = {
    run_id: RUN_ID,
    schema_version: 1,
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-20T10:15:00.000Z',
    phase: 'completed',
    input_request: null,
    input_history: [],
    block: null,
    block_history: [],
    request,
    classification: null,
    evidence: {},
    submissions: [],
    report,
    report_md: report === null ? null : '# report',
    feedback: [],
    feedback_latest: null,
    embeddings: [],
    usage: [],
  };
  return (o.slackTarget !== undefined ? { ...record, slack_target: o.slackTarget } : record) as RunRecord;
}

function fakeStore(record: RunRecord | null) {
  const calls: string[] = [];
  return {
    calls,
    store: {
      async getRun(runId: string) {
        calls.push(runId);
        return record !== null && runId === record.run_id ? record : null;
      },
    },
  };
}

/** A fixtures tree with one slack_user fixture, and a strict mock resolver over it. */
function fixtureResolver(o: { user?: { id: string; active: boolean } | null; email?: string; strict?: boolean } = {}) {
  const dir = tempDir();
  if (o.user !== undefined) {
    const key = semanticKey('slack_user', { email: o.email ?? REVIEWER_EMAIL });
    const path = join(dir, 'shared', 'slack_user', 'global', `${keyHash(key)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    const fixture = {
      schema: 1,
      kind: 'slack_user',
      entity: 'global',
      key,
      key_string: keyString(key),
      result: o.user,
      meta: { source: 'hand', recorded_at: '2026-09-23T00:00:00.000Z' },
    };
    writeFileSync(path, JSON.stringify(fixture, null, 2));
  }
  const settings = { mockMode: true, strict: o.strict ?? true, record: false, fixturesDir: dir };
  return createResolver({ settings, store: createFixtureStore({ fixturesDir: dir }) });
}

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(answers: Record<string, unknown> = {}) {
  const calls: FetchCall[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const method = new URL(url).pathname.replace('/api/', '');
    const body = answers[method] ?? { ok: true };
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

const slackConfig = (o: { email?: string; fallback?: string } = {}) => ({
  slack: { reviewerEmail: o.email ?? REVIEWER_EMAIL, fallbackGroupHandle: o.fallback ?? GROUP },
});

function mockDeps(
  o: { record?: RunRecord | null; user?: { id: string; active: boolean } | null; noFixture?: boolean; strict?: boolean; email?: string; fallback?: string } = {},
) {
  const sink = createMemorySlackSink();
  const audit = createMemoryAuditSink();
  const { store, calls } = fakeStore(o.record === undefined ? runRecord() : o.record);
  const client = createRecordingSlackClient({
    resolveIo: fixtureResolver({
      ...(o.noFixture === true ? {} : { user: o.user === undefined ? { id: REVIEWER_ID, active: true } : o.user }),
      ...(o.strict !== undefined ? { strict: o.strict } : {}),
    }),
    sink,
  });
  const deps: SlackPostDeps = {
    store,
    client,
    audit,
    config: slackConfig({ ...(o.email !== undefined ? { email: o.email } : {}), ...(o.fallback !== undefined ? { fallback: o.fallback } : {}) }),
    interface: 'cli',
    now: NOW,
  };
  return { deps, sink, audit, storeCalls: calls };
}

async function flagApproval(approvedBy = 'ops.lead'): Promise<Approval> {
  const r = await requireApproval({
    mode: 'cli',
    stdinIsTTY: false,
    yes: true,
    approvedBy,
    verbatimText: 'text',
    show: () => {},
    confirm: async () => null,
    now: NOW,
  });
  if (!r.ok) throw new Error(r.reason);
  return r.approval;
}

async function refusal(p: Promise<unknown>): Promise<SlackPostRefusal> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SlackPostRefusal) return err;
    throw err;
  }
  throw new Error('expected a SlackPostRefusal');
}

// ------------------------------------------------------------------ mock end to end

describe('mock mode end to end', () => {
  test('prepare then post: the sink gets one post with the right thread, the audit line says mock', async () => {
    const { deps, sink, audit } = mockDeps();
    const post = await prepareSlackPost(RUN_ID, deps);
    expect(post.target).toEqual({ channel_id: CHANNEL, thread_ts: THREAD_TS });
    expect(post.reviewer).toEqual({ kind: 'user', id: REVIEWER_ID });
    expect(post.text.startsWith(`<@${REVIEWER_ID}> please validate`)).toBe(true);
    expect(post.text).toContain(`\`${RUN_ID}\``);
    expect(post.transport).toBe('mock');
    expect(sink.posts).toHaveLength(0);

    const result = await postReport(post, await flagApproval(), deps);
    expect(sink.posts).toHaveLength(1);
    expect(sink.posts[0]).toEqual({ channel: CHANNEL, thread_ts: THREAD_TS, text: post.text });
    expect(result).toMatchObject({ run_id: RUN_ID, channel: CHANNEL, thread_ts: THREAD_TS, transport: 'mock', approved_by: 'ops.lead' });

    expect(audit.lines).toHaveLength(1);
    const line = audit.lines[0]!;
    expect(line).toMatchObject({
      run_id: RUN_ID,
      interface: 'cli',
      entity: null,
      tool: AUDIT_TOOL,
      decision: 'allow',
      target: 'SLACK_BOT_TOKEN',
      transport: 'mock',
      exit: 0,
    });
    expect(line.summary_redacted).toContain('approved_by ops.lead (flag)');
  });

  test('with mock mode on, createSlackClient never calls fetch', async () => {
    const f = fakeFetch();
    const dir = tempDir();
    const config = configFromRecord({ TRIAGE_MOCK_MODE: 'true', SLACK_BOT_TOKEN: TOKEN, TRIAGE_FIXTURES_DIR: dir }, dir);
    const sink = createMemorySlackSink();
    const client = createSlackClient(config, { fetch: f.fn, sink, resolveIo: fixtureResolver({ user: { id: REVIEWER_ID, active: true } }) });
    expect(client.transport).toBe('mock');
    const { store } = fakeStore(runRecord());
    const audit = createMemoryAuditSink();
    const deps: SlackPostDeps = { store, client, audit, config: slackConfig(), now: NOW };
    await postReport(await prepareSlackPost(RUN_ID, deps), await flagApproval(), deps);
    expect(f.calls).toHaveLength(0);
    expect(sink.posts).toHaveLength(1);
    expect(audit.lines[0]!.transport).toBe('mock');
  });

  test('createSlackClient in mock mode reads the fixtures dir from config', async () => {
    const dir = tempDir();
    const config = configFromRecord({ TRIAGE_MOCK_MODE: 'true', TRIAGE_FIXTURES_DIR: dir }, dir);
    const client = createSlackClient(config);
    // An empty fixtures tree and strict mock: the lookup is a loud miss.
    await expect(client.lookupUserByEmail(REVIEWER_EMAIL, new AbortController().signal)).rejects.toThrow('fixture_miss');
  });

  test('a stored report whose run_id was masked is posted with the real run id', async () => {
    const report = { ...sampleReport(), run_id: '01J8ZQ7XK3PSEUDRUN****0001' };
    const { deps } = mockDeps({ record: runRecord({ report }) });
    const post = await prepareSlackPost(RUN_ID, deps);
    expect(post.text).toContain(`\`${RUN_ID}\``);
    expect(post.text).not.toContain('****');
  });

  test('a structural slack_target on the run record wins over the request source', async () => {
    const { deps, sink } = mockDeps({
      record: runRecord({ source: { kind: 'text' }, slackTarget: { channel_id: 'C0OTHER01', thread_ts: '1695460999.000001' } }),
    });
    await postReport(await prepareSlackPost(RUN_ID, deps), await flagApproval(), deps);
    expect(sink.posts[0]).toMatchObject({ channel: 'C0OTHER01', thread_ts: '1695460999.000001' });
  });
});

// ------------------------------------------------------------------ reviewer

describe('reviewer choice', () => {
  test('an inactive reviewer falls back to the group', async () => {
    const { deps } = mockDeps({ user: { id: REVIEWER_ID, active: false } });
    const post = await prepareSlackPost(RUN_ID, deps);
    expect(post.reviewer).toEqual({ kind: 'group', handle: GROUP });
    expect(post.text.startsWith(`${GROUP} please validate`)).toBe(true);
  });

  test('a null fixture (no Slack user with that email) falls back to the group', async () => {
    const { deps } = mockDeps({ user: null });
    expect((await prepareSlackPost(RUN_ID, deps)).reviewer).toEqual({ kind: 'group', handle: GROUP });
  });

  test('the requester is not tagged as their own reviewer', async () => {
    const { deps } = mockDeps({ record: runRecord({ requestedBy: REVIEWER_ID }) });
    expect((await prepareSlackPost(RUN_ID, deps)).reviewer).toEqual({ kind: 'group', handle: GROUP });
  });

  test('a blank reviewer email skips the lookup and tags the group', async () => {
    const { deps } = mockDeps({ email: '  ', strict: true, noFixture: true });
    // No fixture is needed because no lookup happens.
    expect((await prepareSlackPost(RUN_ID, deps)).reviewer).toEqual({ kind: 'group', handle: GROUP });
  });

  test('a non-strict miss falls back to the group', async () => {
    const sink = createMemorySlackSink();
    const client = createRecordingSlackClient({ resolveIo: fixtureResolver({ strict: false }), sink });
    const { store } = fakeStore(runRecord());
    const deps: SlackPostDeps = { store, client, audit: createMemoryAuditSink(), config: slackConfig(), now: NOW };
    expect((await prepareSlackPost(RUN_ID, deps)).reviewer).toEqual({ kind: 'group', handle: GROUP });
  });
});

// ------------------------------------------------------------------ deny paths

describe('deny paths', () => {
  test('postReport refuses a value that did not come from requireApproval, posts nothing and audits a deny', async () => {
    const { deps, sink, audit } = mockDeps();
    const post = await prepareSlackPost(RUN_ID, deps);
    const forged = { approved_by: 'someone', method: 'flag', at: NOW().toISOString() } as unknown as Approval;
    const r = await refusal(postReport(post, forged, deps));
    expect(r.code).toBe('not_approved');
    expect(sink.posts).toHaveLength(0);
    expect(audit.lines.map((l) => [l.decision, l.tool, l.exit])).toEqual([['deny', AUDIT_TOOL, 'not_approved']]);
  });

  test('postReport needs an Approval at the type level', async () => {
    const { deps } = mockDeps();
    const post = await prepareSlackPost(RUN_ID, deps);
    const plain = { approved_by: 'someone', method: 'flag' as const, at: NOW().toISOString() };
    // @ts-expect-error a plain object is not an Approval
    await expect(postReport(post, plain, deps)).rejects.toThrow(SlackPostRefusal);
    // @ts-expect-error nor is undefined
    await expect(postReport(post, undefined, deps)).rejects.toThrow(SlackPostRefusal);
  });

  test('a refused approval writes an audit deny line and posts nothing', async () => {
    const { deps, sink, audit } = mockDeps();
    const post = await prepareSlackPost(RUN_ID, deps);
    const r = await requireApproval({
      mode: 'cli',
      stdinIsTTY: false,
      yes: false,
      verbatimText: post.text,
      show: () => {},
      confirm: async () => null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    recordApprovalRefusal(post, r.reason, deps);
    expect(sink.posts).toHaveLength(0);
    expect(audit.lines).toHaveLength(1);
    expect(audit.lines[0]).toMatchObject({ decision: 'deny', tool: AUDIT_TOOL, transport: 'mock', target: AUDIT_TARGET });
    expect(audit.lines[0]!.reason).toContain('not approved');
  });

  test('an unmasked pattern in the formatted text refuses in prepare, before any approval', async () => {
    const report = sampleReport();
    report.cx_answer.reply_text = 'We called you on 9876543210 and will call again.';
    const { deps, audit } = mockDeps({ record: runRecord({ report }) });
    const r = await refusal(prepareSlackPost(RUN_ID, deps));
    expect(r.code).toBe('egress');
    expect(r.message).toContain('phone');
    expect(r.message).not.toContain('9876543210');
    expect(audit.lines[0]).toMatchObject({ decision: 'deny', exit: 'egress' });
    expect(serializeAuditLine(audit.lines[0]!)).not.toContain('9876543210');
  });

  test('a prepared post that was edited or built by hand is not sent', async () => {
    const { deps, sink } = mockDeps();
    const post = await prepareSlackPost(RUN_ID, deps);
    const edited: PreparedSlackPost = { ...post, text: `${post.text}\nextra` };
    const r = await refusal(postReport(edited, await flagApproval(), deps));
    expect(r.code).toBe('not_prepared');
    expect(sink.posts).toHaveLength(0);
  });

  test('a missing slack_target (run started from --text) refuses with no Slack thread for this run', async () => {
    const { deps, audit } = mockDeps({ record: runRecord({ source: { kind: 'text' } }) });
    const r = await refusal(prepareSlackPost(RUN_ID, deps));
    expect(r.code).toBe('no_target');
    expect(r.message).toContain('no Slack thread for this run');
    expect(audit.lines[0]).toMatchObject({ decision: 'deny', exit: 'no_target' });
  });

  test('a thread ts masked by the persisted profile refuses as no Slack thread', async () => {
    const source: Source = { kind: 'slack', channel_id: CHANNEL, thread_ts: '****0000.****3456', permalink: 'x' };
    const { deps } = mockDeps({ record: runRecord({ source }) });
    const r = await refusal(prepareSlackPost(RUN_ID, deps));
    expect(r.code).toBe('no_target');
    expect(r.message).toContain('no Slack thread for this run');
  });

  test('no report yet', async () => {
    const { deps } = mockDeps({ record: runRecord({ report: null }) });
    const r = await refusal(prepareSlackPost(RUN_ID, deps));
    expect(r.code).toBe('no_report');
    expect(r.message).toContain('no report yet');
  });

  test('an unknown run and a bad run id refuse; the bad id is not audited', async () => {
    const { deps, audit } = mockDeps();
    expect((await refusal(prepareSlackPost('01J8ZQ7XK3OTHERRUNAAAAAAAA', deps))).code).toBe('not_found');
    expect((await refusal(prepareSlackPost('../etc', deps))).code).toBe('invalid_run_id');
    expect(audit.lines).toHaveLength(1);
  });

  test('a strict fixture miss on the reviewer lookup refuses and never names the email', async () => {
    const { deps, sink, audit } = mockDeps({ noFixture: true });
    const r = await refusal(prepareSlackPost(RUN_ID, deps));
    expect(r.code).toBe('reviewer');
    expect(r.message).toContain('fixture_miss');
    expect(r.message).toContain('SLACK_REVIEWER_EMAIL');
    expect(r.message).not.toContain(REVIEWER_EMAIL);
    expect(sink.posts).toHaveLength(0);
    expect(serializeAuditLine(audit.lines[0]!)).not.toContain(REVIEWER_EMAIL);
  });

  test('a bad fixture result refuses', async () => {
    const { deps } = mockDeps({ user: { id: '', active: true } });
    expect((await refusal(prepareSlackPost(RUN_ID, deps))).message).toContain('bad_fixture');
  });

  test('a blank fallback group handle refuses naming the key', async () => {
    const { deps } = mockDeps({ fallback: '', user: { id: REVIEWER_ID, active: false } });
    const r = await refusal(prepareSlackPost(RUN_ID, deps));
    expect(r.code).toBe('reviewer');
    expect(r.message).toContain('SLACK_FALLBACK_GROUP_HANDLE');
  });

  test('a stored report that fails the schema refuses', async () => {
    const report = { ...sampleReport(), status: 'nonsense' } as unknown as Report;
    const { deps } = mockDeps({ record: runRecord({ report }) });
    expect((await refusal(prepareSlackPost(RUN_ID, deps))).code).toBe('bad_report');
  });
});

// ------------------------------------------------------------------ real client

describe('real client (fake fetch, no network)', () => {
  function realConfig(token: string) {
    const dir = tempDir();
    return configFromRecord({ TRIAGE_MOCK_MODE: 'false', SLACK_BOT_TOKEN: token }, dir);
  }

  test('chat.postMessage body shape and the bearer header come from config', async () => {
    const f = fakeFetch({
      'users.lookupByEmail': { ok: true, user: { id: REVIEWER_ID, deleted: false } },
      'chat.postMessage': { ok: true, channel: CHANNEL, ts: '1695460500.000900' },
    });
    const client = createSlackClient(realConfig(TOKEN), { fetch: f.fn });
    expect(client.transport).toBe('real');
    const { store } = fakeStore(runRecord());
    const audit = createMemoryAuditSink();
    const deps: SlackPostDeps = { store, client, audit, config: slackConfig(), now: NOW };

    const post = await prepareSlackPost(RUN_ID, deps);
    expect(f.calls).toHaveLength(1);
    const lookup = f.calls[0]!;
    expect(lookup.url).toBe(`${SLACK_API_BASE}users.lookupByEmail?email=${encodeURIComponent(REVIEWER_EMAIL)}`);
    expect(lookup.init.method).toBe('GET');
    expect((lookup.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

    const result = await postReport(post, await flagApproval(), deps);
    expect(f.calls).toHaveLength(2);
    const sent = f.calls[1]!;
    expect(sent.url).toBe(`${SLACK_API_BASE}chat.postMessage`);
    expect(sent.init.method).toBe('POST');
    expect(sent.init.redirect).toBe('error');
    expect(sent.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    });
    expect(JSON.parse(String(sent.init.body))).toEqual({
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      text: post.text,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(result).toMatchObject({ ts: '1695460500.000900', transport: 'real' });
    expect(audit.lines[0]).toMatchObject({ transport: 'real', target: 'SLACK_BOT_TOKEN', decision: 'allow', exit: 0 });
  });

  test('a blank SLACK_BOT_TOKEN refuses naming the key, before any fetch', async () => {
    const f = fakeFetch();
    const client = createSlackClient(realConfig('   '), { fetch: f.fn });
    const { store, calls } = fakeStore(runRecord());
    const audit = createMemoryAuditSink();
    const r = await refusal(prepareSlackPost(RUN_ID, { store, client, audit, config: slackConfig(), now: NOW }));
    expect(r.code).toBe('not_ready');
    expect(r.message).toContain('SLACK_BOT_TOKEN');
    expect(f.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(audit.lines[0]).toMatchObject({ decision: 'deny', transport: 'real', exit: 'not_ready' });
    // The methods refuse on their own as well.
    const blank = createRealSlackClient({ token: '', fetch: f.fn });
    await expect(blank.postThreadReply(CHANNEL, THREAD_TS, 'x', new AbortController().signal)).rejects.toThrow('SLACK_BOT_TOKEN');
    expect(f.calls).toHaveLength(0);
  });

  test('real mode without an injected fetch refuses to build', () => {
    expect(() => createSlackClient(realConfig(TOKEN))).toThrow(SlackClientError);
  });

  test('users_not_found is no reviewer; other Slack errors are refusals without the token', async () => {
    const notFound = fakeFetch({ 'users.lookupByEmail': { ok: false, error: 'users_not_found' } });
    const client = createRealSlackClient({ token: TOKEN, fetch: notFound.fn });
    expect(await client.lookupUserByEmail(REVIEWER_EMAIL, new AbortController().signal)).toBeNull();

    const failing = fakeFetch({
      'users.lookupByEmail': { ok: true, user: { id: REVIEWER_ID } },
      'chat.postMessage': { ok: false, error: 'not_in_channel' },
    });
    const c2 = createRealSlackClient({ token: TOKEN, fetch: failing.fn });
    const { store } = fakeStore(runRecord());
    const audit = createMemoryAuditSink();
    const deps: SlackPostDeps = { store, client: c2, audit, config: slackConfig(), now: NOW };
    const post = await prepareSlackPost(RUN_ID, deps);
    const err = await postReport(post, await flagApproval(), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackClientError);
    expect((err as SlackClientError).code).toBe('not_in_channel');
    expect((err as Error).message).not.toContain(TOKEN);
    expect(audit.lines[0]).toMatchObject({ decision: 'allow', exit: 'not_in_channel', transport: 'real' });
  });

  test('HTTP 429 and a network failure are reported by code', async () => {
    const limited = fakeFetch({ 'chat.postMessage': new Response('', { status: 429 }) });
    const c = createRealSlackClient({ token: TOKEN, fetch: limited.fn });
    await expect(c.postThreadReply(CHANNEL, THREAD_TS, 'x', new AbortController().signal)).rejects.toThrow('rate_limited');
    const broken: FetchLike = async () => {
      throw new Error(`connect failed with Bearer ${TOKEN}`);
    };
    const c2 = createRealSlackClient({ token: TOKEN, fetch: broken });
    const err = await c2.postThreadReply(CHANNEL, THREAD_TS, 'x', new AbortController().signal).catch((e: unknown) => e);
    expect((err as SlackClientError).code).toBe('network_error');
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

// ------------------------------------------------------------------ audit shape

describe('audit line', () => {
  test('carries approved_by and the env var name, never the token or the message text', async () => {
    const f = fakeFetch({
      'users.lookupByEmail': { ok: true, user: { id: REVIEWER_ID } },
      'chat.postMessage': { ok: true, channel: CHANNEL, ts: '1695460500.000900' },
    });
    const client = createRealSlackClient({ token: TOKEN, fetch: f.fn });
    const { store } = fakeStore(runRecord());
    const audit = createMemoryAuditSink();
    const deps: SlackPostDeps = { store, client, audit, config: slackConfig(), now: NOW };
    const post = await prepareSlackPost(RUN_ID, deps);
    await postReport(post, await flagApproval('cx.approver'), deps);

    expect(audit.lines).toHaveLength(1);
    const line = audit.lines[0]!;
    expect(Object.keys(line).sort()).toEqual(
      ['decision', 'duration_ms', 'entity', 'exit', 'interface', 'run_id', 'summary_redacted', 'target', 'tool', 'transport', 'ts'].sort(),
    );
    expect(line.target).toBe('SLACK_BOT_TOKEN');
    expect(line.summary_redacted).toBe(`slack_post ${CHANNEL}: posted to the thread, approved_by cx.approver (flag)`);
    const serialized = serializeAuditLine(line);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('xoxb');
    for (const fragment of post.text.split('\n').filter((l) => l.trim().length > 12)) {
      expect(serialized).not.toContain(fragment);
    }
  });
});

// ------------------------------------------------------------------ helpers

describe('slackTargetOf', () => {
  test('non-Slack sources have no target; bad ids are unusable', () => {
    expect(slackTargetOf(runRecord({ source: { kind: 'thread_file' } }))).toBeNull();
    expect(slackTargetOf(runRecord({ source: { kind: 'json' } }))).toBeNull();
    expect(slackTargetOf(runRecord())).toEqual({ channel_id: CHANNEL, thread_ts: THREAD_TS });
    expect(slackTargetOf(runRecord({ slackTarget: { channel_id: 'nope', thread_ts: THREAD_TS } }))).toBe('unusable');
  });
});

// ------------------------------------------------------------------ import boundary

describe('import boundary (D13)', () => {
  const SRC = join(import.meta.dir, '..');

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...files(path));
      else if (/\.(?:ts|mts|js|mjs)$/.test(name)) out.push(path);
    }
    return out;
  }

  test('nothing under src/tools or src/agents imports slack-post or slack-client', () => {
    const scanned = [...files(join(SRC, 'tools')), ...files(join(SRC, 'agents'))];
    expect(scanned.length).toBeGreaterThan(0);
    const offenders = scanned.filter((path) =>
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*report\/slack-(?:post|client)(?:\.ts)?['"]/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });

  test('the pattern catches a static and a dynamic import', () => {
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*report\/slack-(?:post|client)(?:\.ts)?['"]/;
    expect(re.test("import { postReport } from '../report/slack-post.ts';")).toBe(true);
    expect(re.test("await import('../../report/slack-client.ts')")).toBe(true);
    expect(re.test("import { formatSlackReport } from '../report/slack-format.ts';")).toBe(false);
  });
});

