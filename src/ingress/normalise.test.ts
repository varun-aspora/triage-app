import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { configFromRecord } from '../config/env.ts';
import { loadRegistry } from '../config/registry.ts';
import type { Entity } from '../types/core.ts';
import {
  CONTEXT_AUTHOR,
  IngressInputError,
  MAX_CONTEXT_CHARS,
  NoEnabledEntityError,
  ThreadFileSchema,
  buildTriageRequest,
  normaliseOptions,
  parseIdsFlag,
  type NormaliseOptions,
  type TriageInput,
} from './normalise.ts';
import { SlackPermalinkError } from './slack-url.ts';
import * as v from 'valibot';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY = 86_400_000;

// Parent at 2026-09-20T10:00:00Z, one reply an hour later. Synthetic text only.
const PARENT_TS = String(Date.parse('2026-09-20T10:00:00.000Z') / 1000) + '.000100';
const REPLY_TS = String(Date.parse('2026-09-20T11:00:00.000Z') / 1000) + '.000200';

function messages() {
  return [
    { ts: REPLY_TS, author: 'U2', text: 'any update?' },
    { ts: PARENT_TS, author: 'U1', text: 'user stuck on account opening' },
  ];
}

const aliases: Record<string, Entity> = { ssfb: 'ssfb', atspl: 'atspl', rtl: 'rtl', shivalik: 'ssfb' };

function opts(over: Partial<NormaliseOptions> = {}): NormaliseOptions {
  let n = 0;
  return {
    now: NOW,
    newId: () => `01TESTRUN${String(++n).padStart(17, '0')}`,
    lookbackDays: 7,
    enabledEntities: ['ssfb', 'atspl', 'rtl'],
    resolveEntity: (name) => aliases[name],
    ...over,
  };
}

function inputError(fn: () => unknown): IngressInputError {
  try {
    fn();
  } catch (err) {
    if (err instanceof IngressInputError) return err;
    throw err;
  }
  throw new Error('expected an IngressInputError');
}

function build(input: TriageInput, o: NormaliseOptions = opts()) {
  return buildTriageRequest(input, o);
}

describe('buildTriageRequest: thread file and json', () => {
  test('the thread-file and JSON forms give equal requests, apart from request_id, source.kind and received_at', () => {
    const doc = { messages: messages(), ids: { account_form_id: 'F-1' }, entities: ['ssfb'], tier: 'mid' };
    const a = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops@example.test', file: structuredClone(doc) });
    const b = build(
      { kind: 'json', interface: 'cli', body: { ...structuredClone(doc), requested_by: 'ops@example.test' } },
      opts({ newId: () => '01TESTRUNJSON0000000000000' }),
    );
    expect(a.source.kind).toBe('thread_file');
    expect(b.source.kind).toBe('json');
    expect(a.request_id).not.toBe(b.request_id);
    const strip = (r: typeof a) => ({ ...r, request_id: '', source: null, received_at: '' });
    expect(strip(b)).toEqual(strip(a));
    expect(a.hints).toEqual({ entities: ['ssfb'], ids: { account_form_id: 'F-1' }, tier: 'mid' });
  });

  test('messages are sorted by ts and the earliest becomes the parent when none is marked', () => {
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: messages() } });
    expect(r.messages.map((m) => m.ts)).toEqual([PARENT_TS, REPLY_TS]);
    expect(r.messages.map((m) => m.is_parent)).toEqual([true, false]);
  });

  test('an explicit is_parent is kept, even when it is not the earliest', () => {
    const m = messages();
    (m[0] as { is_parent?: boolean }).is_parent = true;
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: m } });
    expect(r.messages.filter((x) => x.is_parent).map((x) => x.ts)).toEqual([REPLY_TS]);
  });

  test('more than one parent is refused', () => {
    const m = messages().map((x) => ({ ...x, is_parent: true }));
    const err = inputError(() => build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: m } }));
    expect(err.key).toBe('messages');
  });

  test('ISO timestamps are accepted and sorted with Slack ones', () => {
    const m = [
      { ts: '2026-09-20T12:00:00Z', author: 'U3', text: 'c' },
      { ts: PARENT_TS, author: 'U1', text: 'a' },
    ];
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: m } });
    expect(r.messages.map((x) => x.author)).toEqual(['U1', 'U3']);
  });

  test('bad thread files are refused without echoing their content', () => {
    const empty = inputError(() => build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: [] } }));
    expect(empty.key).toContain('messages');
    const badTs = inputError(() =>
      build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: [{ ts: 'yesterday', author: 'U1', text: 'secret-text' }] } }),
    );
    expect(badTs.key).toBe('messages[0].ts');
    expect(badTs.message).not.toContain('yesterday');
    const wrongType = inputError(() =>
      build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: [{ ts: PARENT_TS, author: 'U1', text: 42 }] } }),
    );
    expect(wrongType.key).toBe('thread_file.messages.0.text');
    expect(wrongType.message).not.toContain('42');
    expect(() => build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: 'not json' })).toThrow(IngressInputError);
  });

  test('a json body without requested_by and no caller value is refused', () => {
    expect(inputError(() => build({ kind: 'json', interface: 'http', body: { messages: messages() } })).key).toBe('requested_by');
  });

  test('ThreadFileSchema accepts the documented shape', () => {
    expect(v.is(ThreadFileSchema, { messages: [{ ts: PARENT_TS, author: 'U1', text: 'x', is_parent: true }], tier: 'cheap' })).toBe(true);
    expect(v.is(ThreadFileSchema, { messages: [{ ts: PARENT_TS, author: 'U1' }] })).toBe(false);
  });
});

describe('buildTriageRequest: text and slack', () => {
  test('--text becomes one parent message with source.kind text', () => {
    const r = build({ kind: 'text', interface: 'cli', requested_by: 'ops@example.test', text: 'form stuck in review' });
    expect(r.source).toEqual({ kind: 'text' });
    expect(r.messages).toEqual([{ ts: `${NOW.getTime() / 1000}.000000`, author: 'ops@example.test', text: 'form stuck in review', is_parent: true }]);
    expect(r.window).toEqual({ from: new Date(NOW.getTime() - 7 * DAY).toISOString(), to: NOW.toISOString() });
    expect(r.received_at).toBe(NOW.toISOString());
    expect(r.request_id).toBe('01TESTRUN00000000000000001');
    expect(r.attachments).toEqual([]);
    expect(r.hints).toEqual({});
  });

  test('empty --text is refused', () => {
    expect(inputError(() => build({ kind: 'text', interface: 'cli', requested_by: 'ops', text: '   ' })).key).toBe('--text');
  });

  test('a slack input carries the permalink source and the fetched attachments', () => {
    const r = build({
      kind: 'slack',
      interface: 'slack',
      requested_by: 'U1',
      url: 'https://acme.slack.com/archives/C0123ABCD/p1695460999000111?thread_ts=1695460000.123456',
      thread: { messages: messages(), attachments: [{ name: 'shot.png', mime: 'image/png', bytes_ref: 'att/1' }] },
    });
    expect(r.source).toEqual({
      kind: 'slack',
      channel_id: 'C0123ABCD',
      thread_ts: '1695460000.123456',
      permalink: 'https://acme.slack.com/archives/C0123ABCD/p1695460000123456',
    });
    expect(r.attachments).toEqual([{ name: 'shot.png', mime: 'image/png', bytes_ref: 'att/1' }]);
  });

  test('a bad slack url is refused', () => {
    expect(() =>
      build({ kind: 'slack', interface: 'slack', requested_by: 'U1', url: 'https://example.com/x', thread: { messages: messages() } }),
    ).toThrow(SlackPermalinkError);
  });
});

describe('buildTriageRequest: context', () => {
  const SLACK_URL = 'https://acme.slack.com/archives/C0123ABCD/p1695460999000111?thread_ts=1695460000.123456';

  test('context is appended after the slack thread as a non-parent message', () => {
    const r = build({
      kind: 'slack',
      interface: 'http',
      requested_by: 'ops',
      url: SLACK_URL,
      thread: { messages: messages() },
      context: '  already checked the KYC status  ',
    });
    expect(r.messages).toHaveLength(3);
    expect(r.messages[2]).toEqual({ ts: '1790164800.000000', author: CONTEXT_AUTHOR, text: 'already checked the KYC status', is_parent: false });
    expect(r.messages[0]?.is_parent).toBe(true);
  });

  test('context works with pasted json messages too', () => {
    const r = build({ kind: 'json', interface: 'http', requested_by: 'ops', body: { messages: messages() }, context: 'see ticket AS-1' });
    expect(r.messages.map((m) => m.author)).toEqual(['U1', 'U2', CONTEXT_AUTHOR]);
  });

  test('context sorts after a thread that ends later than now', () => {
    const late = String(NOW.getTime() / 1000 + 60) + '.000000';
    const r = build({
      kind: 'json',
      interface: 'http',
      requested_by: 'ops',
      body: { messages: [{ ts: late, author: 'U1', text: 'x' }] },
      context: 'note',
    });
    expect(r.messages[1]?.ts).toBe(String(NOW.getTime() / 1000 + 60) + '.000001');
  });

  test('blank context adds nothing', () => {
    const r = build({ kind: 'json', interface: 'http', requested_by: 'ops', body: { messages: messages() }, context: '   ' });
    expect(r.messages).toHaveLength(2);
  });

  test('oversized context is refused by key', () => {
    const big = 'x'.repeat(MAX_CONTEXT_CHARS + 1);
    expect(inputError(() => build({ kind: 'json', interface: 'http', requested_by: 'ops', body: { messages: messages() }, context: big })).key).toBe(
      'context',
    );
  });
});

describe('buildTriageRequest: window', () => {
  const file = { messages: messages() };

  test('defaults to the first message ts minus the lookback days, up to now', () => {
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file }, opts({ lookbackDays: 3 }));
    const first = Date.parse('2026-09-20T10:00:00.000Z');
    expect(r.window).toEqual({ from: new Date(first - 3 * DAY).toISOString(), to: NOW.toISOString() });
    expect(r.hints.time_window).toBeUndefined();
  });

  test('an explicit time_window replaces the default', () => {
    const tw = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file, hints: { time_window: tw } });
    expect(r.window).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' });
    expect(r.hints.time_window).toEqual(r.window);
  });

  test('a json body time_window is used, and a caller hint wins over it', () => {
    const body = { messages: messages(), requested_by: 'ops', time_window: { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' } };
    expect(build({ kind: 'json', interface: 'http', body }).window.from).toBe('2026-09-01T00:00:00.000Z');
    const hinted = build({
      kind: 'json',
      interface: 'http',
      body,
      hints: { time_window: { from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' } },
    });
    expect(hinted.window.from).toBe('2026-08-01T00:00:00.000Z');
  });

  test('a from later than to is refused', () => {
    const tw = { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' };
    const err = inputError(() => build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file, hints: { time_window: tw } }));
    expect(err.key).toBe('time_window');
  });

  test('a time_window that is not ISO is refused', () => {
    const tw = { from: 'last week', to: '2026-09-01T00:00:00Z' };
    expect(inputError(() => build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file, hints: { time_window: tw } })).key).toBe(
      'time_window.from',
    );
  });

  test('a message ts after now does not produce an inverted window', () => {
    const future = String(NOW.getTime() / 1000 + 30 * 86_400) + '.000000';
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: [{ ts: future, author: 'U1', text: 'x' }] } });
    expect(Date.parse(r.window.from)).toBeLessThanOrEqual(Date.parse(r.window.to));
  });
});

describe('buildTriageRequest: entity hints', () => {
  const file = { messages: messages() };

  test('hints outside TRIAGE_ENTITIES are dropped, never added', () => {
    const r = build(
      { kind: 'thread_file', interface: 'cli', requested_by: 'ops', file, hints: { entities: ['rtl', 'atspl', 'nope'] } },
      opts({ enabledEntities: ['ssfb', 'atspl'] }),
    );
    expect(r.hints.entities).toEqual(['atspl']);
  });

  test('no hints means no narrowing', () => {
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file, hints: { entities: [] } }, opts({ enabledEntities: ['ssfb'] }));
    expect(r.hints.entities).toBeUndefined();
  });

  test('the alias shivalik resolves to ssfb through the registry', () => {
    const record = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));
    const config = configFromRecord({ ...record, TRIAGE_ENTITIES: 'ssfb,atspl' }, '/triage/home');
    const registry = loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
    const o = normaliseOptions(config, registry, { now: NOW, newId: () => '01TESTRUN00000000000000009' });
    expect(o.lookbackDays).toBe(config.budgets.defaultLookbackDays);
    expect(o.enabledEntities).toEqual(['ssfb', 'atspl']);
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { ...file, entities: ['Shivalik', 'rtl'] } }, o);
    expect(r.hints.entities).toEqual(['ssfb']);
  });

  test('an empty intersection is a named error listing the enabled entities', () => {
    let caught: unknown;
    try {
      build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file, hints: { entities: ['rtl'] } }, opts({ enabledEntities: ['ssfb', 'atspl'] }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoEnabledEntityError);
    const err = caught as NoEnabledEntityError;
    expect(err.name).toBe('NoEnabledEntityError');
    expect(err.enabled).toEqual(['ssfb', 'atspl']);
    expect(err.message).toContain('ssfb, atspl');
  });

  test('caller hints win over the thread file for entities, tier and ids', () => {
    const r = build({
      kind: 'thread_file',
      interface: 'cli',
      requested_by: 'ops',
      file: { ...file, entities: ['ssfb'], tier: 'cheap', ids: { account_form_id: 'F-1', aspora_user_id: 'U-1' } },
      hints: { entities: ['atspl'], tier: 'strong', ids: { account_form_id: 'F-2' } },
    });
    expect(r.hints).toEqual({ entities: ['atspl'], tier: 'strong', ids: { account_form_id: 'F-2', aspora_user_id: 'U-1' } });
  });

  test('an unknown id key in a thread file is refused by name', () => {
    const err = inputError(() =>
      build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { ...file, ids: { pan_number: 'X' } } }),
    );
    expect(err.key).toBe('ids.pan_number');
    expect(err.message).not.toContain('X ');
  });
});

describe('buildTriageRequest: copies', () => {
  test('the result shares nothing with caller-mutable input', () => {
    const m = messages();
    const entities = ['ssfb', 'atspl'];
    const ids = { account_form_id: 'F-1' };
    const attachments = [{ name: 'a.png', mime: 'image/png', bytes_ref: 'att/1' }];
    const tw = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
    const r = build({ kind: 'thread_file', interface: 'cli', requested_by: 'ops', file: { messages: m }, attachments, hints: { entities, ids, time_window: tw } });
    const before = structuredClone(r);

    m.push({ ts: REPLY_TS, author: 'U9', text: 'late' });
    (m[1] as { text: string }).text = 'changed';
    entities.push('rtl');
    entities[0] = 'rtl';
    (ids as Record<string, string>).account_form_id = 'F-9';
    attachments.push({ name: 'b', mime: 'x', bytes_ref: 'y' });
    (attachments[0] as { name: string }).name = 'changed';
    tw.from = '2020-01-01T00:00:00Z';

    expect(r).toEqual(before);
    expect(r.messages).not.toBe(m as unknown);
    expect(r.hints.entities).not.toBe(entities as unknown);
  });
});

describe('parseIdsFlag', () => {
  test('parses known keys and trims', () => {
    expect(parseIdsFlag(['account_form_id=F-1', ' aspora_user_id = U-1 ', 'country=a=b'])).toEqual({ account_form_id: 'F-1', aspora_user_id: 'U-1', country: 'a=b' });
    expect(parseIdsFlag([])).toEqual({});
  });

  test('an unknown key is a usage error naming the key', () => {
    const err = inputError(() => parseIdsFlag(['account_form_id=F-1', 'pan=ABCDE1234F']));
    expect(err.key).toBe('--ids pan');
    expect(err.message).toContain('pan');
    expect(err.message).not.toContain('ABCDE1234F');
  });

  test("a missing '=' is a usage error naming the key", () => {
    const err = inputError(() => parseIdsFlag(['account_form_id']));
    expect(err.key).toBe('--ids account_form_id');
    expect(err.reason).toContain("'='");
  });

  test("a value-looking entry without '=' is named by position, not echoed", () => {
    const err = inputError(() => parseIdsFlag(['account_form_id=F-1', '9876-5432']));
    expect(err.key).toBe('--ids entry 2');
    expect(err.message).not.toContain('9876');
  });

  test('empty values and repeated keys are refused', () => {
    expect(inputError(() => parseIdsFlag(['account_form_id='])).reason).toContain('empty');
    expect(inputError(() => parseIdsFlag(['account_form_id=1', 'account_form_id=2'])).reason).toContain('more than once');
  });
});

describe('purity', () => {
  test('normalise.ts has no file system, fetch or process.env use', () => {
    const text = readFileSync(fileURLToPath(new URL('./normalise.ts', import.meta.url)), 'utf8');
    expect(text).not.toMatch(/\bfs\b/);
    expect(text).not.toMatch(/node:fs/);
    expect(text).not.toMatch(/\bfetch\b/);
    expect(text).not.toMatch(/process\.env/);
    expect(text).not.toMatch(/\bBun\./);
    expect(text).not.toMatch(/from 'bun:/);
  });
});
