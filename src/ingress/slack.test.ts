import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryAuditSink, type MemoryAuditSink } from '../gate/audit-sink.ts';
import { FixtureMissError } from '../mock/errors.ts';
import { createMockLayer } from '../mock/index.ts';
import {
  SlackFetchError,
  THREAD_FILE_HINT,
  dedupeNames,
  fetchSlackThread,
  isSlackAuthHost,
  templateFieldValues,
  toRawThread,
  type FetchLike,
  type SlackFetchDeps,
} from './slack.ts';

const REPO_FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));
const PAGE1 = JSON.parse(readFileSync(new URL('./__fixtures__/slack-replies.page1.json', import.meta.url), 'utf8'));
const PAGE2 = JSON.parse(readFileSync(new URL('./__fixtures__/slack-replies.page2.json', import.meta.url), 'utf8'));

// Synthetic values only. The token is a seeded fake used to prove it never leaks.
const TOKEN = 'xoxb-FAKE-SEEDED-0000-TOKENVALUE';
const RUN_ID = '01TESTRUN00000000000000001';
const REF = { channel_id: 'C0SYNTH01', thread_ts: '1695460000.123456' };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const USERS: Record<string, unknown> = {
  U0SYNTHA: { id: 'U0SYNTHA', real_name: 'Synth Ops One', profile: { display_name: 'synth.ops.one', real_name: 'Synth Ops One' } },
  U0SYNTHB: { id: 'U0SYNTHB', real_name: 'Synth Ops Two', profile: { display_name: '', real_name: 'SYNTH OPS TWO' } },
};

type Call = { url: URL; headers: Record<string, string> };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake Slack: two reply pages, users.info and one downloadable png. */
function fakeSlack(over: { route?: (url: URL) => Response | undefined } = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    const custom = over.route?.(url);
    if (custom !== undefined) return custom;
    if (url.hostname === 'slack.com' && url.pathname === '/api/conversations.replies') {
      return json(url.searchParams.get('cursor') ? PAGE2 : PAGE1);
    }
    if (url.hostname === 'slack.com' && url.pathname === '/api/users.info') {
      const user = USERS[url.searchParams.get('user') ?? ''];
      return json(user === undefined ? { ok: false, error: 'user_not_found' } : { ok: true, user });
    }
    if (url.hostname === 'files.slack.com' && url.pathname.endsWith('/screen-1.png')) {
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return json({ ok: false, error: 'unexpected_call' }, 404);
  };
  return { fetch, calls };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'triage-slack-'));
  dirs.push(d);
  return d;
}

function deps(
  over: Partial<SlackFetchDeps> & { mockMode?: boolean; strict?: boolean; fixturesDir?: string } = {},
): SlackFetchDeps & { audit: MemoryAuditSink } {
  const { mockMode = false, strict = true, fixturesDir, ...rest } = over;
  const mock = createMockLayer({
    mock: { enabled: mockMode, strict, record: false },
    paths: { fixturesDir: fixturesDir ?? tempDir() },
  });
  return {
    token: TOKEN,
    fetch: fakeSlack().fetch,
    mock,
    audit: createMemoryAuditSink(),
    maxAttachmentBytes: 1024,
    dataDir: tempDir(),
    run_id: RUN_ID,
    interface: 'cli',
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    ...rest,
  } as SlackFetchDeps & { audit: MemoryAuditSink };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the read to fail');
}

describe('fetchSlackThread, real transport with an injected fetch', () => {
  test('merges two cursor pages into one ordered list with the parent first', async () => {
    const slack = fakeSlack();
    const d = deps({ fetch: slack.fetch });
    const thread = await fetchSlackThread(REF, d);

    expect(thread.messages.map((m) => m.ts)).toEqual([
      '1695460000.123456',
      '1695460010.000100',
      '1695460200.000200',
      '1695460300.000300',
    ]);
    expect(thread.messages.map((m) => m.is_parent)).toEqual([true, false, false, false]);
    expect(thread.messages[0]?.author).toBe('CX Issue Bot');
    expect(thread.messages[1]?.author).toBe('synth.ops.one');
    expect(thread.messages[2]?.author).toBe('SYNTH OPS TWO');

    const replies = slack.calls.filter((c) => c.url.pathname === '/api/conversations.replies');
    expect(replies).toHaveLength(2);
    expect(replies[0]?.url.searchParams.get('cursor')).toBeNull();
    expect(replies[1]?.url.searchParams.get('cursor')).toBe('c3ludGgtY3Vyc29yLTI=');
    expect(replies[0]?.url.searchParams.get('channel')).toBe('C0SYNTH01');
    expect(replies[0]?.url.searchParams.get('ts')).toBe('1695460000.123456');

    expect(d.audit.lines).toHaveLength(1);
    expect(d.audit.lines[0]).toMatchObject({ tool: 'slack_read', transport: 'real', target: 'SLACK_BOT_TOKEN', decision: 'allow', exit: 0 });
  });

  test('downloads only image mimes under the cap; other files are listed with no bytes_ref', async () => {
    const slack = fakeSlack();
    const d = deps({ fetch: slack.fetch });
    const thread = await fetchSlackThread(REF, d);

    const byName = Object.fromEntries(thread.attachments.map((a) => [a.name, a]));
    const png = byName['screen-1.png'];
    expect(png?.bytes_ref).toBe(join(d.dataDir, 'attachments', RUN_ID, '1.png'));
    expect(new Uint8Array(readFileSync(png?.bytes_ref as string))).toEqual(PNG_BYTES);

    expect(byName['statement.pdf']).toEqual({ name: 'statement.pdf', mime: 'application/pdf', size: 2048, skipped: 'not_image' });
    expect(byName['huge.jpg']).toMatchObject({ skipped: 'too_large' });
    expect(byName['huge.jpg']?.bytes_ref).toBeUndefined();

    // Neither the pdf nor the over-cap jpeg was fetched.
    const fileCalls = slack.calls.filter((c) => c.url.hostname === 'files.slack.com').map((c) => c.url.pathname);
    expect(fileCalls).toEqual(['/files-pri/T0SYNTH-F0SYNTH1/screen-1.png']);

    expect(toRawThread(thread).attachments).toEqual([
      { name: 'screen-1.png', mime: 'image/png', bytes_ref: png?.bytes_ref as string },
    ]);
  });

  test('a body larger than the cap is dropped even when the listed size is small', async () => {
    const big = new Uint8Array(2048);
    const slack = fakeSlack({
      route: (url) =>
        url.pathname.endsWith('/screen-1.png')
          ? new Response(big, { status: 200, headers: { 'content-type': 'image/png' } })
          : undefined,
    });
    const d = deps({ fetch: slack.fetch });
    const thread = await fetchSlackThread(REF, d);
    const png = thread.attachments.find((a) => a.name === 'screen-1.png');
    expect(png).toMatchObject({ skipped: 'too_large' });
    expect(png?.bytes_ref).toBeUndefined();
    expect(existsSync(join(d.dataDir, 'attachments', RUN_ID, '1.png'))).toBe(false);
  });

  test('an HTML answer to a file download (missing files:read) is not saved', async () => {
    const slack = fakeSlack({
      route: (url) =>
        url.pathname.endsWith('/screen-1.png')
          ? new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
          : undefined,
    });
    const thread = await fetchSlackThread(REF, deps({ fetch: slack.fetch }));
    expect(thread.attachments.find((a) => a.name === 'screen-1.png')).toMatchObject({ skipped: 'download_failed' });
  });

  test('collects profile and bot template names once each, apart from the text', async () => {
    const slack = fakeSlack();
    const thread = await fetchSlackThread(REF, deps({ fetch: slack.fetch }));

    // The Owner mention on the parent comes first, so U0SYNTHB is looked up first.
    expect(thread.names).toEqual(['SYNTH OPS TWO', 'synth.ops.one', 'Synth Ops One', 'Synth Raiser', 'Synth Customer']);
    // U0SYNTHA wrote two messages and U0SYNTHB is both an author and the Owner mention: one lookup each.
    const lookups = slack.calls.filter((c) => c.url.pathname === '/api/users.info').map((c) => c.url.searchParams.get('user'));
    expect(lookups.sort()).toEqual(['U0SYNTHA', 'U0SYNTHB']);
    // Names are a separate field; the text is left as Slack sent it.
    expect(thread.messages[1]?.text).toBe('screenshots attached');
  });

  test('a deleted user does not stop the read', async () => {
    const slack = fakeSlack({
      route: (url) =>
        url.pathname === '/api/users.info' && url.searchParams.get('user') === 'U0SYNTHB'
          ? json({ ok: false, error: 'user_not_found' })
          : undefined,
    });
    const thread = await fetchSlackThread(REF, deps({ fetch: slack.fetch }));
    expect(thread.names).not.toContain('SYNTH OPS TWO');
    expect(thread.messages[2]?.author).toBe('U0SYNTHB');
  });

  test('the parent missing from the replies is thread_not_found', async () => {
    const slack = fakeSlack({
      route: (url) =>
        url.pathname === '/api/conversations.replies'
          ? json({ ok: true, has_more: false, messages: [PAGE2.messages[1]], response_metadata: { next_cursor: '' } })
          : undefined,
    });
    const err = await failure(fetchSlackThread(REF, deps({ fetch: slack.fetch })));
    expect(err).toBeInstanceOf(SlackFetchError);
    expect((err as SlackFetchError).code).toBe('thread_not_found');
    expect(err.message).toContain('--thread-file');
  });
});

describe('refusals and error mapping', () => {
  for (const token of ['', '   ', undefined]) {
    test(`blank token ${JSON.stringify(token)} is refused before any fetch call`, async () => {
      let calls = 0;
      const d = deps({
        token,
        fetch: async () => {
          calls++;
          return json({ ok: true });
        },
      });
      const err = await failure(fetchSlackThread(REF, d));
      expect(err).toBeInstanceOf(SlackFetchError);
      expect((err as SlackFetchError).code).toBe('no_token');
      expect(err.message).toContain('SLACK_BOT_TOKEN');
      expect(err.message).toContain('--thread-file');
      expect(calls).toBe(0);
      expect(d.audit.lines).toHaveLength(1);
      expect(d.audit.lines[0]).toMatchObject({ decision: 'deny', transport: 'real', target: 'SLACK_BOT_TOKEN', exit: 'no_token' });
    });
  }

  test('a bad channel id or ts is refused before any fetch call', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return json({ ok: true });
    };
    for (const ref of [
      { channel_id: '../x', thread_ts: REF.thread_ts },
      { channel_id: REF.channel_id, thread_ts: '1695460000' },
    ]) {
      const err = await failure(fetchSlackThread(ref, deps({ fetch })));
      expect((err as SlackFetchError).code).toBe('invalid_thread');
    }
    expect(calls).toBe(0);
  });

  for (const code of ['not_in_channel', 'thread_not_found']) {
    test(`Slack ok:false ${code} maps to SlackFetchError with the code and the hint`, async () => {
      const slack = fakeSlack({ route: () => json({ ok: false, error: code }) });
      const d = deps({ fetch: slack.fetch });
      const err = await failure(fetchSlackThread(REF, d));
      expect(err).toBeInstanceOf(SlackFetchError);
      expect((err as SlackFetchError).code).toBe(code);
      expect(err.message).toContain(code);
      expect(err.message).toContain('Use --thread-file');
      expect(d.audit.lines[0]).toMatchObject({ decision: 'allow', transport: 'real', exit: code });
    });
  }

  test('HTTP 500 maps to http_500 with the hint', async () => {
    const slack = fakeSlack({ route: () => new Response('oops', { status: 500 }) });
    const err = await failure(fetchSlackThread(REF, deps({ fetch: slack.fetch })));
    expect((err as SlackFetchError).code).toBe('http_500');
    expect((err as SlackFetchError).status).toBe(500);
    expect(err.message).toContain('--thread-file');
  });

  test('HTTP 429 maps to rate_limited and is not retried', async () => {
    const slack = fakeSlack({ route: () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }) });
    const err = await failure(fetchSlackThread(REF, deps({ fetch: slack.fetch })));
    expect((err as SlackFetchError).code).toBe('rate_limited');
    expect(err.message).toContain('--thread-file');
    expect(slack.calls).toHaveLength(1);
  });

  test('an error code that does not look like a Slack code is not echoed', async () => {
    const slack = fakeSlack({ route: () => json({ ok: false, error: `bad ${TOKEN}` }) });
    const err = await failure(fetchSlackThread(REF, deps({ fetch: slack.fetch })));
    expect((err as SlackFetchError).code).toBe('unknown_error');
  });

  test('a fetch that throws becomes network_error with a fixed message', async () => {
    const d = deps({
      fetch: async () => {
        throw new Error(`socket closed, Authorization: Bearer ${TOKEN}`);
      },
    });
    const err = await failure(fetchSlackThread(REF, d));
    expect((err as SlackFetchError).code).toBe('network_error');
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('mock mode', () => {
  test('answers from the fixture with zero fetch calls and a mock audit line', async () => {
    let calls = 0;
    const d = deps({
      mockMode: true,
      fixturesDir: REPO_FIXTURES,
      token: undefined,
      fetch: async () => {
        calls++;
        return json({ ok: true });
      },
    });
    const thread = await fetchSlackThread(REF, d);
    expect(calls).toBe(0);
    expect(thread.messages[0]).toMatchObject({ ts: REF.thread_ts, is_parent: true });
    expect(thread.messages).toHaveLength(3);
    expect(thread.names).toContain('Synth Raiser');
    expect(thread.attachments).toEqual([
      { name: 'screen-1.png', mime: 'image/png', size: 8, skipped: 'mock' },
      { name: 'statement.pdf', mime: 'application/pdf', size: 2048, skipped: 'not_image' },
    ]);
    expect(d.audit.lines).toHaveLength(1);
    expect(d.audit.lines[0]).toMatchObject({ transport: 'mock', target: 'SLACK_BOT_TOKEN', decision: 'allow', exit: 0 });
    expect(existsSync(join(d.dataDir, 'attachments'))).toBe(false);
  });

  test('a strict miss throws FixtureMissError naming the key', async () => {
    let calls = 0;
    const d = deps({
      mockMode: true,
      fixturesDir: REPO_FIXTURES,
      fetch: async () => {
        calls++;
        return json({ ok: true });
      },
    });
    const err = await failure(fetchSlackThread({ channel_id: 'C0SYNTH01', thread_ts: '1695469999.000001' }, d));
    expect(err).toBeInstanceOf(FixtureMissError);
    expect(err.message).toContain('slack_read');
    expect(err.message).toContain('"channel":"C0SYNTH01"');
    expect(err.message).toContain('"thread_ts":"1695469999.000001"');
    expect(calls).toBe(0);
    expect(d.audit.lines[0]).toMatchObject({ transport: 'mock', exit: 'fixture_miss' });
  });

  test('a non-strict miss is a SlackFetchError with the hint', async () => {
    const d = deps({ mockMode: true, strict: false, fixturesDir: REPO_FIXTURES });
    const err = await failure(fetchSlackThread({ channel_id: 'C0SYNTH01', thread_ts: '1695469999.000001' }, d));
    expect(err).toBeInstanceOf(SlackFetchError);
    expect((err as SlackFetchError).code).toBe('thread_not_found');
    expect(err.message).toContain('--thread-file');
  });
});

describe('the token never leaks', () => {
  test('not in the audit line, the result or any error', async () => {
    const texts: string[] = [];

    const ok = deps();
    const thread = await fetchSlackThread(REF, ok);
    texts.push(JSON.stringify(thread), ...ok.audit.lines.map((l) => JSON.stringify(l)));

    const routes: ((url: URL) => Response | undefined)[] = [
      () => json({ ok: false, error: 'not_in_channel' }),
      () => json({ ok: false, error: TOKEN }),
      () => new Response(TOKEN, { status: 500 }),
      () => new Response(TOKEN, { status: 429 }),
      () => new Response(`not json ${TOKEN}`, { status: 200 }),
    ];
    for (const route of routes) {
      const d = deps({ fetch: fakeSlack({ route }).fetch });
      const err = await failure(fetchSlackThread(REF, d));
      texts.push(err.message, String(err.stack), JSON.stringify(err), ...d.audit.lines.map((l) => JSON.stringify(l)));
    }
    const blank = deps({ token: ' ' });
    const err = await failure(fetchSlackThread(REF, blank));
    texts.push(err.message, ...blank.audit.lines.map((l) => JSON.stringify(l)));

    for (const t of texts) {
      expect(t).not.toContain(TOKEN);
      expect(t).not.toContain('FAKE-SEEDED');
    }
  });

  test('the Authorization header goes only to slack.com and files.slack.com', async () => {
    const slack = fakeSlack();
    await fetchSlackThread(REF, deps({ fetch: slack.fetch }));
    expect(slack.calls.length).toBeGreaterThan(0);
    for (const c of slack.calls) {
      expect(['slack.com', 'files.slack.com']).toContain(c.url.hostname);
      expect(c.url.protocol).toBe('https:');
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    }
  });
});

describe('off-host files', () => {
  test('a url_private on another host is refused and never fetched', async () => {
    const slack = fakeSlack();
    const thread = await fetchSlackThread(REF, deps({ fetch: slack.fetch }));
    expect(thread.attachments.find((a) => a.name === 'elsewhere.png')).toEqual({
      name: 'elsewhere.png',
      mime: 'image/png',
      size: 8,
      skipped: 'refused_host',
    });
    expect(slack.calls.some((c) => c.url.hostname === 'files.example.invalid')).toBe(false);
  });

  test('isSlackAuthHost accepts only https on the two Slack hosts', () => {
    expect(isSlackAuthHost('https://slack.com/api/users.info')).toBe(true);
    expect(isSlackAuthHost('https://files.slack.com/files-pri/x')).toBe(true);
    for (const url of [
      'http://files.slack.com/x',
      'https://slack.com.example.invalid/x',
      'https://evil.slack.com/x',
      'https://user:pw@files.slack.com/x',
      'https://files.slack.com:8443/x',
      'not a url',
    ]) {
      expect(isSlackAuthHost(url)).toBe(false);
    }
  });
});

describe('name helpers', () => {
  test('templateFieldValues reads labels in text and block-field form', () => {
    const values = templateFieldValues([
      '*Raised by:* Synth Raiser\n*Owner:* <@U0SYNTHB|synth>\n*Customer Name:* N/A',
      '*Customer Name:*\nSynth Customer',
      'Owner: someone@example.invalid',
      'Raised by: 12345678',
    ]);
    expect(values).toEqual([{ name: 'Synth Raiser' }, { userId: 'U0SYNTHB' }, { name: 'Synth Customer' }]);
  });

  test('dedupeNames trims, collapses spaces and keeps the first spelling', () => {
    expect(dedupeNames(['Synth  One', 'synth one', ' Synth Two ', 'x', '', 'SYNTH TWO'])).toEqual(['Synth One', 'Synth Two']);
  });
});

describe('input checks', () => {
  test('a run_id that is not a run id is refused before any I/O', async () => {
    let calls = 0;
    const d = deps({
      run_id: '../escape',
      fetch: async () => {
        calls++;
        return json({ ok: true });
      },
    });
    const err = await failure(fetchSlackThread(REF, d));
    expect((err as SlackFetchError).code).toBe('invalid_run_id');
    expect(calls).toBe(0);
    expect(d.audit.lines).toHaveLength(0);
  });

  test('a bad ref and a bad run_id together still throw SlackFetchError and write no audit line', async () => {
    let calls = 0;
    const d = deps({
      run_id: '../escape',
      fetch: async () => {
        calls++;
        return json({ ok: true });
      },
    });
    const err = await failure(fetchSlackThread({ channel_id: '../x', thread_ts: REF.thread_ts }, d));
    expect(err).toBeInstanceOf(SlackFetchError);
    expect((err as SlackFetchError).code).toBe('invalid_thread');
    expect((err as SlackFetchError).message).toContain(THREAD_FILE_HINT);
    expect(calls).toBe(0);
    expect(d.audit.lines).toHaveLength(0);
  });
});
