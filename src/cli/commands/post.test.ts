// triage post, run through buildProgram and runCli with a test home, fake io,
// a fake run store, a fixture reviewer lookup, a memory audit sink and a
// scripted prompt. No real .env is read and nothing reaches Slack.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import * as v from 'valibot';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { configFromRecord, type Config } from '../../config/env.ts';
import { createMemoryAuditSink, type MemoryAuditSink } from '../../gate/audit-sink.ts';
import { keyHash, keyString, semanticKey } from '../../mock/key.ts';
import { createResolver } from '../../mock/resolve.ts';
import { createFixtureStore } from '../../mock/store.ts';
import { ReportSchema, type Report } from '../../report/schema.ts';
import {
  createMemorySlackSink,
  createSlackClient,
  type FetchLike,
  type SlackClient,
  type SlackPostSink,
} from '../../report/slack-client.ts';
import type { RunRecord } from '../../runstore/types.ts';
import type { TriageRequest } from '../../types/request.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { command, createPostCommand, type PostCommandOptions } from './post.command.ts';

// All values below are synthetic.
const RUN_ID = '01J8ZQ7XK3PSEUDRUNAAAAAAAA';
const CHANNEL = 'C0SYNTH01';
const THREAD_TS = '1695460000.123456';
const REVIEWER_EMAIL = 'reviewer@example.test';
const REVIEWER_ID = 'U0PSEUDOREV';
const GROUP = '@banking-triage';

const REPORT_TEXT = readFileSync(join(import.meta.dir, '..', '..', 'report', '__fixtures__', 'sample-report.json'), 'utf8');
const sampleReport = (): Report => v.parse(ReportSchema, JSON.parse(REPORT_TEXT));

const homes: TestHome[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): TestHome {
  const h = makeTestHome({ overrides: { SLACK_FALLBACK_GROUP_HANDLE: GROUP } });
  homes.push(h);
  return h;
}

function runRecord(o: { report?: Report | null; source?: TriageRequest['source'] } = {}): RunRecord {
  const report = o.report === undefined ? { ...sampleReport(), run_id: RUN_ID } : o.report;
  return {
    run_id: RUN_ID,
    schema_version: 1,
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-20T10:15:00.000Z',
    phase: 'completed',
    input_request: null,
    input_history: [],
    block: null,
    block_history: [],
    request: {
      request_id: RUN_ID,
      interface: 'cli',
      requested_by: 'cx-oncall',
      source: o.source ?? { kind: 'slack', channel_id: CHANNEL, thread_ts: THREAD_TS, permalink: 'https://example.test/p' },
      messages: [],
      attachments: [],
      hints: {},
      window: { from: '2026-09-17T00:00:00.000Z', to: '2026-09-20T00:00:00.000Z' },
      received_at: '2026-09-20T10:00:00.000Z',
    } as TriageRequest,
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
}

/** A strict mock resolver over a temp fixtures tree holding the reviewer. */
function reviewerResolver() {
  const dir = mkdtempSync(join(tmpdir(), 'triage-post-fixtures-'));
  dirs.push(dir);
  const key = semanticKey('slack_user', { email: REVIEWER_EMAIL });
  const path = join(dir, 'shared', 'slack_user', 'global', `${keyHash(key)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schema: 1,
      kind: 'slack_user',
      entity: 'global',
      key,
      key_string: keyString(key),
      result: { id: REVIEWER_ID, active: true },
      meta: { source: 'hand', recorded_at: '2026-09-23T00:00:00.000Z' },
    }),
  );
  return createResolver({
    settings: { mockMode: true, strict: true, record: false, fixturesDir: dir },
    store: createFixtureStore({ fixturesDir: dir }),
  });
}

type Harness = {
  code: number;
  out: string;
  err: string;
  asked: string[];
  sink: SlackPostSink;
  audit: MemoryAuditSink;
  fetchCalls: number;
  clientBuilt: number;
  lookups: number;
  storeBuilt: number;
};

type RunOptions = {
  config?: Config;
  record?: RunRecord | null;
  tty?: boolean;
  answers?: (string | null)[];
  ttyUser?: string;
};

async function post(argv: string[], o: RunOptions = {}): Promise<Harness> {
  const h = o.config === undefined ? home() : undefined;
  const config = o.config ?? h!.config;
  // With the reviewer email set, the lookup goes to the fixture.
  const withReviewer: Config = { ...config, slack: { ...config.slack, reviewerEmail: REVIEWER_EMAIL, fallbackGroupHandle: GROUP } };

  let out = '';
  let err = '';
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const sink = createMemorySlackSink();
  const audit = createMemoryAuditSink();
  let fetchCalls = 0;
  let clientBuilt = 0;
  let lookups = 0;
  let storeBuilt = 0;
  const fetchSpy: FetchLike = async () => {
    fetchCalls++;
    throw new Error('the real transport must not be used');
  };

  const options: PostCommandOptions = {
    store: async () => {
      storeBuilt++;
      const record = o.record === undefined ? runRecord() : o.record;
      return { getRun: async (id: string) => (record !== null && id === record.run_id ? record : null) };
    },
    client: (c) => {
      clientBuilt++;
      const inner = createSlackClient(c, { fetch: fetchSpy, sink, resolveIo: reviewerResolver() });
      const counted: SlackClient = {
        transport: inner.transport,
        ready: () => inner.ready(),
        lookupUserByEmail: (email, signal) => {
          lookups++;
          return inner.lookupUserByEmail(email, signal);
        },
        postThreadReply: (...args) => inner.postThreadReply(...args),
      };
      return counted;
    },
    audit: () => audit,
    confirm: (_io, write) => async (q) => {
      asked.push(q);
      write(q);
      return answers.length > 0 ? (answers.shift() as string | null) : null;
    },
    ttyUser: () => o.ttyUser ?? 'tty.user',
    now: () => new Date('2026-09-24T10:00:00.000Z'),
  };
  const ctx: CliContext = {
    config: () => withReviewer,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: o.tty ?? false,
    },
    deps: {},
  };
  const program = buildProgram([createPostCommand(options)], ctx);
  const code = await runCli(program, ['post', ...argv]);
  return { code, out, err, asked, sink, audit, fetchCalls, clientBuilt, lookups, storeBuilt };
}

const TEXT_START = `<@${REVIEWER_ID}> please validate`;

// ------------------------------------------------------------------ registration

describe('registration', () => {
  test('exports command at post and the generated list picks it up', () => {
    expect(command.path).toEqual(['post']);
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('post');
  });
});

// ------------------------------------------------------------------ approval deny matrix

describe('approval deny matrix', () => {
  const cases: { name: string; argv: string[] }[] = [
    { name: 'non-TTY without flags', argv: [] },
    { name: '--yes only', argv: ['--yes'] },
    { name: '--approved-by only', argv: ['--approved-by', 'ops.lead'] },
    { name: 'empty --approved-by with --yes', argv: ['--yes', '--approved-by', ''] },
    { name: 'bad --approved-by with --yes', argv: ['--yes', '--approved-by', 'two words'] },
  ];
  for (const c of cases) {
    test(`${c.name}: exit 2, the text is still shown, nothing is sent, an audit deny is written`, async () => {
      const r = await post([RUN_ID, ...c.argv]);
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.out).toContain(TEXT_START);
      expect(r.err).toContain('not posted');
      expect(r.asked).toEqual([]);
      expect(r.sink.posts).toHaveLength(0);
      expect(r.fetchCalls).toBe(0);
      expect(r.audit.lines.map((l) => [l.tool, l.decision])).toEqual([['slack_post', 'deny']]);
    });
  }

  test('--yes only names --approved-by in the refusal', async () => {
    const r = await post([RUN_ID, '--yes']);
    expect(r.err).toContain('--approved-by');
  });

  test('TRIAGE_APPROVAL_MODE=slack refuses naming v2 before any Slack call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-post-home-'));
    dirs.push(dir);
    const config = configFromRecord({ TRIAGE_APPROVAL_MODE: 'slack', TRIAGE_MOCK_MODE: 'true' }, dir, { policyChecks: false });
    const r = await post([RUN_ID, '--yes', '--approved-by', 'ops.lead'], { config });
    expect(r.code).toBe(EXIT.CONFIG);
    expect(r.err).toContain('v2');
    expect(r.err).toContain('TRIAGE_APPROVAL_MODE');
    expect(r.clientBuilt).toBe(0);
    expect(r.lookups).toBe(0);
    expect(r.storeBuilt).toBe(0);
    expect(r.sink.posts).toHaveLength(0);
    expect(r.fetchCalls).toBe(0);
  });
});

// ------------------------------------------------------------------ TTY prompt

describe('TTY prompt', () => {
  test('y approves: the text is shown before the question, one post is sent, approved_by is the TTY user', async () => {
    const r = await post([RUN_ID], { tty: true, answers: ['y'] });
    expect(r.code).toBe(EXIT.OK);
    expect(r.asked).toEqual(['Post this to Slack? [y/N] ']);
    expect(r.out.indexOf(TEXT_START)).toBeGreaterThanOrEqual(0);
    expect(r.out.indexOf(TEXT_START)).toBeLessThan(r.out.indexOf('Post this to Slack?'));
    expect(r.sink.posts).toHaveLength(1);
    expect(r.sink.posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    expect(r.out).toContain('approved by tty.user');
    expect(r.audit.lines).toHaveLength(1);
    expect(r.audit.lines[0]!.summary_redacted).toContain('approved_by tty.user (tty)');
  });

  for (const answer of ['n', '', null]) {
    test(`${JSON.stringify(answer)} declines: exit 1, nothing is sent`, async () => {
      const r = await post([RUN_ID], { tty: true, answers: [answer] });
      expect(r.code).toBe(EXIT.ERROR);
      expect(r.asked).toHaveLength(1);
      expect(r.sink.posts).toHaveLength(0);
      expect(r.fetchCalls).toBe(0);
      expect(r.err).toContain('not posted');
      expect(r.audit.lines.map((l) => l.decision)).toEqual(['deny']);
    });
  }
});

// ------------------------------------------------------------------ flags

describe('--yes --approved-by', () => {
  test('mock mode: the sink is called once, the real transport never, approved_by reaches the audit line', async () => {
    const r = await post([RUN_ID, '--yes', '--approved-by', 'ops.lead']);
    expect(r.code).toBe(EXIT.OK);
    expect(r.sink.posts).toHaveLength(1);
    expect(r.sink.posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    expect(r.sink.posts[0]!.text.startsWith(TEXT_START)).toBe(true);
    expect(r.fetchCalls).toBe(0);
    expect(r.lookups).toBe(1);
    expect(r.out).toContain(r.sink.posts[0]!.text);
    expect(r.out).toContain('mock sink (not sent to Slack)');
    const line = r.audit.lines[0]!;
    expect(line).toMatchObject({ tool: 'slack_post', decision: 'allow', transport: 'mock', target: 'SLACK_BOT_TOKEN', interface: 'cli' });
    expect(line.summary_redacted).toContain('approved_by ops.lead (flag)');
  });

  test('--json: stdout holds one document with the posted text; the preview goes to stderr', async () => {
    const r = await post([RUN_ID, '--yes', '--approved-by', 'ops.lead', '--json']);
    expect(r.code).toBe(EXIT.OK);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ posted: true, run_id: RUN_ID, channel: CHANNEL, thread_ts: THREAD_TS, transport: 'mock', approved_by: 'ops.lead' });
    expect(doc.text).toBe(r.sink.posts[0]!.text);
    expect(r.err).toContain(TEXT_START);
  });
});

// ------------------------------------------------------------------ run state

describe('run state', () => {
  test('no report: exit 1 with no report yet, no prompt, nothing sent', async () => {
    const r = await post([RUN_ID, '--yes', '--approved-by', 'ops.lead'], { record: runRecord({ report: null }) });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('no report yet');
    expect(r.sink.posts).toHaveLength(0);
    expect(r.lookups).toBe(0);
  });

  test('no report with --json prints the error as JSON', async () => {
    const r = await post([RUN_ID, '--json'], { record: runRecord({ report: null }) });
    expect(r.code).toBe(EXIT.ERROR);
    expect(JSON.parse(r.out).error.message).toContain('no report yet');
  });

  test('a run from --text: exit 1 with no Slack thread for this run', async () => {
    const r = await post([RUN_ID, '--yes', '--approved-by', 'ops.lead'], { record: runRecord({ source: { kind: 'text' } }) });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('no Slack thread for this run');
    expect(r.sink.posts).toHaveLength(0);
  });

  test('an unknown run exits 1; a malformed run id exits 2', async () => {
    expect((await post(['01J8ZQ7XK3OTHERRUNAAAAAAAA', '--yes', '--approved-by', 'x'])).code).toBe(EXIT.ERROR);
    expect((await post(['../x', '--yes', '--approved-by', 'x'])).code).toBe(EXIT.USAGE);
  });

  test('an unmasked pattern in the text refuses before approval is asked', async () => {
    const report = { ...sampleReport(), run_id: RUN_ID };
    report.cx_answer.reply_text = 'We called you on 9876543210.';
    const r = await post([RUN_ID], { record: runRecord({ report }), tty: true, answers: ['y'] });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.asked).toEqual([]);
    expect(r.err).toContain('unmasked');
    expect(r.err).not.toContain('9876543210');
    expect(r.out).not.toContain('9876543210');
    expect(r.sink.posts).toHaveLength(0);
  });

  test('real mode with a blank SLACK_BOT_TOKEN refuses naming the key, with no fetch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-post-home-'));
    dirs.push(dir);
    const config = configFromRecord({ TRIAGE_MOCK_MODE: 'false', SLACK_BOT_TOKEN: '' }, dir);
    const r = await post([RUN_ID, '--yes', '--approved-by', 'ops.lead'], { config });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('SLACK_BOT_TOKEN');
    expect(r.fetchCalls).toBe(0);
    expect(r.sink.posts).toHaveLength(0);
    expect(r.audit.lines[0]).toMatchObject({ decision: 'deny', transport: 'real' });
  });
});
