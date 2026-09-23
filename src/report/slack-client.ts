// The Slack client used by `triage post` (D13, D19, D41). Two calls only:
// users.lookupByEmail for the reviewer tag, and chat.postMessage for the
// thread reply. No agent tool imports this file; slack-post.test.ts checks.
//
// Real client: fetch is injected, the bot token comes from config and is
// added in one place, only for https requests to slack.com. A blank token is
// reported by ready() before any call, and the methods refuse again before
// fetch is touched. The token never goes into an error or a return value.
//
// Mock client (TRIAGE_MOCK_MODE=true, the default): lookups answer from the
// fixture store through resolveIo (kind 'slack_user'; a strict miss is an
// error) and posts are pushed to an in-memory sink. It has no fetch at all,
// so a mock run cannot reach Slack.
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import { createMockLayer, type MockLayer } from '../mock/index.ts';
import type { AuditTransport } from '../types/audit.ts';

export const SLACK_API_BASE = 'https://slack.com/api/';
export const TOKEN_KEY = 'SLACK_BOT_TOKEN';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Any Slack client failure. The message names keys and Slack error codes, never values. */
export class SlackClientError extends Error {
  override readonly name = 'SlackClientError';
  /** no_token, fixture_miss, bad_fixture, rate_limited, http_<status>, a Slack error code and so on. */
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`Slack ${code}: ${detail}`);
    this.code = code;
  }
}

export type SlackUser = { readonly id: string; readonly active: boolean };
export type PostedReply = { readonly channel: string; readonly ts: string };
export type ClientReady = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string };

export interface SlackClient {
  readonly transport: AuditTransport;
  /** Checked before any lookup or post. Never makes a call. */
  ready(): ClientReady;
  /** null when Slack has no user with that email. */
  lookupUserByEmail(email: string, signal: AbortSignal): Promise<SlackUser | null>;
  postThreadReply(channel: string, thread_ts: string, text: string, signal: AbortSignal): Promise<PostedReply>;
}

// ------------------------------------------------------------------ real

const SLACK_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const NO_TOKEN = `${TOKEN_KEY} is blank; set it in TRIAGE_HOME/.env to post in real mode`;

export type RealSlackClientOptions = {
  /** config.slack.botToken. */
  readonly token: string | undefined;
  readonly fetch: FetchLike;
};

export function createRealSlackClient(options: RealSlackClientOptions): SlackClient {
  const token = (options.token ?? '').trim();
  const ready = (): ClientReady =>
    token === '' ? { ok: false, code: 'no_token', reason: NO_TOKEN } : { ok: true };
  const call = (method: string, init: { query?: Record<string, string>; body?: unknown }, signal: AbortSignal) => {
    if (token === '') throw new SlackClientError('no_token', NO_TOKEN);
    return callApi(method, token, options.fetch, init, signal);
  };

  return Object.freeze({
    transport: 'real' as const,
    ready,
    async lookupUserByEmail(email: string, signal: AbortSignal): Promise<SlackUser | null> {
      let body: Record<string, unknown>;
      try {
        body = await call('users.lookupByEmail', { query: { email: email.trim() } }, signal);
      } catch (err) {
        if (err instanceof SlackClientError && err.code === 'users_not_found') return null;
        throw err;
      }
      const user = body.user as { id?: unknown; deleted?: unknown } | undefined;
      if (user === undefined || typeof user.id !== 'string' || user.id === '') {
        throw new SlackClientError('bad_response', 'users.lookupByEmail returned no user id');
      }
      return { id: user.id, active: user.deleted !== true };
    },
    async postThreadReply(channel: string, thread_ts: string, text: string, signal: AbortSignal): Promise<PostedReply> {
      const body = await call(
        'chat.postMessage',
        { body: { channel, thread_ts, text, unfurl_links: false, unfurl_media: false } },
        signal,
      );
      const ts = typeof body.ts === 'string' ? body.ts : '';
      const posted = typeof body.channel === 'string' && body.channel !== '' ? body.channel : channel;
      return { channel: posted, ts };
    },
  });
}

// The only place the token is attached to a request.
async function callApi(
  method: string,
  token: string,
  fetchFn: FetchLike,
  init: { query?: Record<string, string>; body?: unknown },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const query = init.query !== undefined ? `?${new URLSearchParams(init.query).toString()}` : '';
  const url = `${SLACK_API_BASE}${method}${query}`;
  const request: RequestInit =
    init.body !== undefined
      ? {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(init.body),
        }
      : { method: 'GET', headers: { Authorization: `Bearer ${token}` } };
  let res: Response;
  try {
    // A redirect could carry the header to another host, so none is followed.
    res = await fetchFn(url, { ...request, redirect: 'error', signal });
  } catch {
    signal.throwIfAborted();
    throw new SlackClientError('network_error', `${method} could not be reached`);
  }
  if (res.status === 429) throw new SlackClientError('rate_limited', `${method} answered HTTP 429 (not retried)`);
  if (!res.ok) throw new SlackClientError(`http_${res.status}`, `${method} answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SlackClientError('bad_response', `${method} did not return JSON`);
  }
  if (body === null || typeof body !== 'object') throw new SlackClientError('bad_response', `${method} did not return an object`);
  const obj = body as Record<string, unknown>;
  if (obj.ok !== true) {
    const code = typeof obj.error === 'string' && SLACK_ERROR_CODE.test(obj.error) ? obj.error : 'unknown_error';
    throw new SlackClientError(code, `${method} returned ok:false`);
  }
  return obj;
}

// ------------------------------------------------------------------ mock

export type SentPost = { readonly channel: string; readonly thread_ts: string; readonly text: string };

/** Where the mock client puts posts. Nothing leaves the process. */
export type SlackPostSink = {
  readonly posts: readonly SentPost[];
  push(post: SentPost): void;
};

export function createMemorySlackSink(): SlackPostSink {
  const posts: SentPost[] = [];
  return {
    posts,
    push(post) {
      posts.push(Object.freeze({ ...post }));
    },
  };
}

// What a slack_user fixture holds: the user, or null when Slack has no user
// with that email.
export const SlackUserFixtureSchema = v.nullable(
  v.object({ id: v.pipe(v.string(), v.minLength(1)), active: v.boolean() }),
);

export type RecordingSlackClientOptions = {
  readonly resolveIo: MockLayer['resolveIo'];
  readonly sink: SlackPostSink;
};

export function createRecordingSlackClient(options: RecordingSlackClientOptions): SlackClient {
  let seq = 0;
  return Object.freeze({
    transport: 'mock' as const,
    ready: (): ClientReady => ({ ok: true }),
    async lookupUserByEmail(email: string, signal: AbortSignal): Promise<SlackUser | null> {
      let outcome;
      try {
        outcome = await options.resolveIo({
          kind: 'slack_user',
          entity: 'global',
          key: { email: email.trim().toLowerCase() },
          signal,
          // resolveIo never calls real() in mock mode. This throws in case it does.
          real: async () => {
            throw new SlackClientError('mock_only', 'the mock Slack client has no real transport');
          },
        });
      } catch (err) {
        // The miss message would carry the email in its key string, so it is
        // replaced with one that names the key and the fixture file only.
        if ((err as { name?: unknown } | null)?.name === 'FixtureMissError') {
          const hash = String((err as { hash?: unknown }).hash ?? '');
          throw new SlackClientError(
            'fixture_miss',
            'no slack_user fixture for the SLACK_REVIEWER_EMAIL value (strict mock)' +
              (/^[0-9a-f]{16}$/.test(hash) ? `; expected fixtures/shared/slack_user/global/${hash}.json` : ''),
          );
        }
        throw err;
      }
      if (outcome.transport !== 'mock') throw new SlackClientError('mock_only', 'the mock Slack client got a real outcome');
      if (outcome.fixture_miss) return null;
      const parsed = v.safeParse(SlackUserFixtureSchema, outcome.value);
      if (!parsed.success) throw new SlackClientError('bad_fixture', 'the slack_user fixture result must be {id, active} or null');
      return parsed.output;
    },
    async postThreadReply(channel: string, thread_ts: string, text: string, signal: AbortSignal): Promise<PostedReply> {
      signal.throwIfAborted();
      options.sink.push({ channel, thread_ts, text });
      seq += 1;
      return { channel, ts: `mock.${String(seq).padStart(6, '0')}` };
    },
  });
}

// ------------------------------------------------------------------ factory

export type SlackClientConfig = Pick<Config, 'home' | 'mock' | 'slack'> & { readonly paths: Pick<Config['paths'], 'fixturesDir'> };

export type SlackClientDeps = {
  /** Used only in real mode. */
  readonly fetch?: FetchLike;
  /** Replaces the mock layer built from config (tests). */
  readonly resolveIo?: MockLayer['resolveIo'];
  /** Where mock posts go. Defaults to a new memory sink. */
  readonly sink?: SlackPostSink;
};

/**
 * The client for this config: the recording client in mock mode, the real
 * one otherwise. In real mode fetch must be passed; nothing here falls back
 * to the global fetch.
 */
export function createSlackClient(config: SlackClientConfig, deps: SlackClientDeps = {}): SlackClient {
  if (config.mock.enabled) {
    const resolveIo = deps.resolveIo ?? createMockLayer(config, { home: config.home }).resolveIo;
    return createRecordingSlackClient({ resolveIo, sink: deps.sink ?? createMemorySlackSink() });
  }
  const fetchFn = deps.fetch;
  if (fetchFn === undefined) throw new SlackClientError('no_fetch', 'the real Slack client needs an injected fetch');
  return createRealSlackClient({ token: config.slack.botToken, fetch: fetchFn });
}
