// prepareRequest: input kinds, the Slack path, thread-file errors, and that a
// failure here stops the pipeline before anything is stored or dispatched.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditLine } from '../types/audit.ts';
import { IngressInputError, NoEnabledEntityError } from './normalise.ts';
import { prepareRequest, type PrepareDeps, type SlackPrepareDeps } from './prepare.ts';
import { SlackFetchError, THREAD_FILE_HINT, type SlackThread } from './slack.ts';
import { SlackPermalinkError } from './slack-url.ts';
import { runSubmission, type SubmissionDeps } from './submit.ts';

const RUN_ID = '01JPREPAREAAAAAAAAAAAAAAAA';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const URL_OK = 'https://acme.slack.com/archives/C0SYNTH01/p1695460000123456';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'triage-prepare-'));
  dirs.push(d);
  return d;
}

type Spies = { fetch: number; resolveIo: number; audit: AuditLine[] };

function slackDeps(spies: Spies, over: Partial<SlackPrepareDeps> = {}): SlackPrepareDeps {
  return {
    token: '',
    fetch: async () => {
      spies.fetch += 1;
      throw new Error('fetch must not be called');
    },
    mock: {
      settings: { mockMode: false },
      resolveIo: async () => {
        spies.resolveIo += 1;
        throw new Error('resolveIo must not be called');
      },
    },
    audit: { write: (line) => spies.audit.push(line) },
    maxAttachmentBytes: 1024,
    dataDir: tempDir(),
    ...over,
  };
}

function deps(over: Partial<PrepareDeps> = {}): PrepareDeps {
  return {
    normalise: {
      now: NOW,
      lookbackDays: 7,
      enabledEntities: ['ssfb', 'atspl'],
      resolveEntity: (n) => (n === 'shivalik' || n === 'ssfb' ? 'ssfb' : n === 'atspl' ? 'atspl' : undefined),
    },
    newId: () => RUN_ID,
    ...over,
  };
}

/** Deps whose every method records a call. Nothing may be touched when prepare fails. */
function untouchedSubmissionDeps(touched: string[]): SubmissionDeps {
  const record =
    (name: string) =>
    (..._args: unknown[]): never => {
      touched.push(name);
      throw new Error(`${name} must not be called`);
    };
  const store = new Proxy({}, { get: (_t, prop) => record(`store.${String(prop)}`) });
  return {
    config: { mock: { enabled: true }, runs: { priorCases: false }, budgets: { runTimeoutMs: 1, runMaxAttempts: 1 } },
    store: store as SubmissionDeps['store'],
    dispatcher: { init: record('dispatcher.init') },
    agent: (() => '') as unknown as SubmissionDeps['agent'],
    embedder: null,
    preflight: record('preflight'),
    identity: record('identity'),
    classify: record('classify'),
    tierAcceptsImages: () => false,
    priorCases: record('priorCases'),
    readAttachment: record('readAttachment'),
  };
}

describe('slack input', () => {
  test('a blank Slack token fails with the --thread-file hint; nothing is fetched, stored or dispatched', async () => {
    const spies: Spies = { fetch: 0, resolveIo: 0, audit: [] };
    const touched: string[] = [];
    const run = prepareRequest(
      { kind: 'slack', url: URL_OK, interface: 'cli', requested_by: 'ops@example.com' },
      deps({ slack: slackDeps(spies) }),
    ).then((p) => runSubmission(p, untouchedSubmissionDeps(touched)));

    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackFetchError);
    expect((err as SlackFetchError).code).toBe('no_token');
    expect((err as Error).message).toContain(THREAD_FILE_HINT);
    expect(spies.fetch).toBe(0);
    expect(spies.resolveIo).toBe(0);
    expect(touched).toEqual([]);
    // The refusal is audited under the new run id, naming the key and never a value.
    expect(spies.audit).toHaveLength(1);
    expect(spies.audit[0]?.run_id).toBe(RUN_ID);
    expect(spies.audit[0]?.decision).toBe('deny');
  });

  test('a bad permalink fails before any read', async () => {
    const spies: Spies = { fetch: 0, resolveIo: 0, audit: [] };
    await expect(
      prepareRequest({ kind: 'slack', url: 'https://example.com/x', interface: 'cli', requested_by: 'ops' }, deps({ slack: slackDeps(spies) })),
    ).rejects.toBeInstanceOf(SlackPermalinkError);
    expect(spies.fetch + spies.resolveIo + spies.audit.length).toBe(0);
  });

  test('slack input without Slack deps is a SlackFetchError with the hint', async () => {
    const err = await prepareRequest({ kind: 'slack', url: URL_OK, interface: 'cli', requested_by: 'ops' }, deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackFetchError);
    expect((err as Error).message).toContain(THREAD_FILE_HINT);
  });

  test('a fetched thread becomes the request, with the run id, images and names', async () => {
    const seen: { run_id?: string; channel?: string } = {};
    const thread: SlackThread = {
      messages: [
        { ts: '1695460000.123456', author: 'Ravi Kumar', text: 'Card not delivered', is_parent: true },
        { ts: '1695460100.000001', author: 'Ops Bot', text: 'Looking' },
      ],
      attachments: [
        { name: 'shot.png', mime: 'image/png', bytes_ref: '/synthetic/1.png' },
        { name: 'log.txt', mime: 'text/plain', skipped: 'not_image' },
      ],
      names: ['Ravi Kumar', 'Ops Bot'],
    };
    const p = await prepareRequest(
      { kind: 'slack', url: URL_OK, interface: 'cli', requested_by: 'ops@example.com' },
      deps({
        slack: slackDeps({ fetch: 0, resolveIo: 0, audit: [] }),
        fetchThread: async (ref, d) => {
          seen.run_id = d.run_id;
          seen.channel = ref.channel_id;
          return thread;
        },
      }),
    );
    expect(seen).toEqual({ run_id: RUN_ID, channel: 'C0SYNTH01' });
    expect(p.run_id).toBe(RUN_ID);
    expect(p.request.request_id).toBe(RUN_ID);
    expect(p.request.source).toMatchObject({ kind: 'slack', channel_id: 'C0SYNTH01', thread_ts: '1695460000.123456' });
    expect(p.request.attachments).toEqual([{ name: 'shot.png', mime: 'image/png', bytes_ref: '/synthetic/1.png' }]);
    expect(p.redaction_names).toEqual(['Ravi Kumar', 'Ops Bot']);
    // The names ride next to the request, not inside it.
    expect(Object.keys(p.request)).not.toContain('redaction_names');
  });
});

describe('thread_file input', () => {
  const file = (content: string) => deps({ readFile: async () => content });

  test('a thread file that fails the schema is a usage error naming the field', async () => {
    const bad = JSON.stringify({ messages: [{ ts: '1695460000.123456', author: 'a' }] });
    const err = await prepareRequest({ kind: 'thread_file', path: '/synthetic/thread.json', interface: 'cli', requested_by: 'ops' }, file(bad)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IngressInputError);
    expect((err as IngressInputError).key).toContain('thread_file.messages.0.text');
  });

  test('an empty messages array names messages', async () => {
    const err = await prepareRequest(
      { kind: 'thread_file', path: '/synthetic/thread.json', interface: 'cli', requested_by: 'ops' },
      file(JSON.stringify({ messages: [] })),
    ).catch((e: unknown) => e);
    expect((err as IngressInputError).key).toContain('thread_file.messages');
  });

  test('invalid JSON is a usage error that does not echo the content', async () => {
    const err = await prepareRequest(
      { kind: 'thread_file', path: '/synthetic/thread.json', interface: 'cli', requested_by: 'ops' },
      file('{"messages": [ customer 9876543210'),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngressInputError);
    expect((err as Error).message).toBe('--thread-file is not valid JSON');
  });

  test('an unreadable file is a usage error with the error code only', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file, open /secret/path'), { code: 'ENOENT' });
    const err = await prepareRequest(
      { kind: 'thread_file', path: '/secret/path', interface: 'cli', requested_by: 'ops' },
      deps({
        readFile: async () => {
          throw enoent;
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngressInputError);
    expect((err as Error).message).toBe('--thread-file could not be read (ENOENT)');
  });

  test('a real file on disk is read and normalised, with authors and template names collected', async () => {
    const dir = tempDir();
    const path = join(dir, 'thread.json');
    writeFileSync(
      path,
      JSON.stringify({
        messages: [
          { ts: '1695460000.123456', author: 'Meera Nair', text: '*Customer Name:* Kiran Rao\nNo welcome letter' },
          { ts: '1695460100.000001', author: 'U0SYNTH01', text: 'checking' },
        ],
        entities: ['shivalik'],
      }),
    );
    const p = await prepareRequest({ kind: 'thread_file', path, interface: 'claude-code', requested_by: 'ops@example.com' }, deps());
    expect(p.request.source).toEqual({ kind: 'thread_file' });
    expect(p.request.hints.entities).toEqual(['ssfb']);
    expect(p.request.messages[0]?.is_parent).toBe(true);
    expect(p.redaction_names).toEqual(['Meera Nair', 'Kiran Rao']);
  });

  test('entity hints outside TRIAGE_ENTITIES fail here', async () => {
    const content = JSON.stringify({ messages: [{ ts: '1695460000.123456', author: 'a', text: 't' }], entities: ['rtl'] });
    await expect(
      prepareRequest({ kind: 'thread_file', path: '/synthetic/t.json', interface: 'cli', requested_by: 'ops' }, file(content)),
    ).rejects.toBeInstanceOf(NoEnabledEntityError);
  });
});

describe('text and json input', () => {
  test('text passes straight through', async () => {
    const p = await prepareRequest({ kind: 'text', text: 'transfer stuck since Monday', interface: 'cli', requested_by: 'ops@example.com' }, deps());
    expect(p.run_id).toBe(RUN_ID);
    expect(p.request.messages).toHaveLength(1);
    expect(p.request.messages[0]?.text).toBe('transfer stuck since Monday');
    // An email author is not a name; the email pattern masks it anyway.
    expect(p.redaction_names).toEqual([]);
  });

  test('blank text is a usage error', async () => {
    await expect(prepareRequest({ kind: 'text', text: '  ', interface: 'cli', requested_by: 'ops' }, deps())).rejects.toBeInstanceOf(
      IngressInputError,
    );
  });

  test('a json body passes straight through and may carry requested_by', async () => {
    const p = await prepareRequest(
      {
        kind: 'json',
        interface: 'http',
        body: { requested_by: 'U0SYNTH02', messages: [{ ts: '1695460000.123456', author: 'Tara Singh', text: 'card blocked' }] },
      },
      deps(),
    );
    expect(p.request.requested_by).toBe('U0SYNTH02');
    expect(p.request.source).toEqual({ kind: 'json' });
    expect(p.redaction_names).toEqual(['Tara Singh']);
  });

  test('an aborted signal stops before anything else', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    let minted = 0;
    await expect(
      prepareRequest(
        { kind: 'text', text: 'x', interface: 'cli', requested_by: 'ops' },
        deps({
          signal: ctrl.signal,
          newId: () => {
            minted += 1;
            return RUN_ID;
          },
        }),
      ),
    ).rejects.toThrow('stop');
    expect(minted).toBe(0);
  });
});
