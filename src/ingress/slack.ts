// Reads a whole Slack thread with the bot token (LLD 04 §2.1, §3; D19, D24, D27).
//
// fetchSlackThread({channel_id, thread_ts}, deps) returns the messages (parent
// first), the files attached to them and the names ingress collected for the
// persisted redaction profile. Names are returned next to the text, never
// merged into it.
//
// What it does, in order:
// 1. Checks the input, and in real mode that SLACK_BOT_TOKEN is set, before
//    any fetch call.
// 2. Reads through resolveIo (kind 'slack_read', key {channel, thread_ts}).
//    Mock mode answers from the fixture and never calls fetch; a strict miss
//    throws FixtureMissError. Real mode calls conversations.replies with
//    cursor pagination and users.info once per author.
// 3. In real mode only, downloads png, jpeg, gif and webp files up to
//    maxAttachmentBytes into <dataDir>/attachments/<run_id>/ and returns
//    their paths as bytes_ref. Other files are listed with no bytes_ref.
// 4. Writes one audit line for the read (target SLACK_BOT_TOKEN).
//
// The Authorization header is added in one place, and only for https
// requests to slack.com and files.slack.com. The token never goes into an
// error message, an audit line or the returned object. Slack error codes are
// passed on only when they look like Slack error codes.
//
// 429 is not retried in v1: the caller gets a SlackFetchError and can pass
// --thread-file instead.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { makeAuditLine } from '../gate/audit.ts';
import type { AuditSink } from '../gate/audit-sink.ts';
import type { ResolveIo } from '../mock/resolve.ts';
import type { MockSettings } from '../mock/settings.ts';
import { RunIdSchema, type Interface } from '../types/core.ts';
import type { Attachment } from '../types/request.ts';
import type { RawThread, ThreadFileMessage } from './normalise.ts';

// ------------------------------------------------------------------ errors

export const THREAD_FILE_HINT = 'Use --thread-file with the thread messages instead.';

/** Any failure to read the thread. The message always carries the --thread-file hint. */
export class SlackFetchError extends Error {
  override readonly name = 'SlackFetchError';
  /** A Slack error code (not_in_channel), rate_limited, http_<status>, no_token and so on. */
  readonly code: string;
  readonly status?: number;

  constructor(code: string, detail: string, status?: number) {
    super(`Slack thread read failed (${code}): ${detail}. ${THREAD_FILE_HINT}`);
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ------------------------------------------------------------------- types

export const SLACK_API_BASE = 'https://slack.com/api/';
export const SLACK_AUTH_HOSTS: ReadonlySet<string> = new Set(['slack.com', 'files.slack.com']);
export const IMAGE_MIMES: Readonly<Record<string, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});
export const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Stops a cursor loop that never ends. 50 pages of 200 is far past any real thread. */
export const MAX_PAGES = 50;
export const PAGE_LIMIT = 200;

export const AUDIT_TOOL = 'slack_read';
export const AUDIT_TARGET = 'SLACK_BOT_TOKEN';

/** The Slack names that hold people's names in the "New CX Issue Raised" bot template (HLD 02 §3). */
export const TEMPLATE_NAME_FIELDS: readonly string[] = Object.freeze(['raised by', 'owner', 'customer name']);

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type SkipReason = 'not_image' | 'too_large' | 'refused_host' | 'download_failed' | 'mock';

/** One file on a thread message. bytes_ref is set only for a downloaded image. */
export type SlackAttachment = {
  readonly name: string;
  readonly mime: string;
  readonly size?: number;
  readonly bytes_ref?: string;
  readonly skipped?: SkipReason;
};

export type SlackThread = {
  readonly messages: readonly ThreadFileMessage[];
  readonly attachments: readonly SlackAttachment[];
  /** Slack profile names of every author plus the bot template names, de-duplicated. */
  readonly names: readonly string[];
};

export type SlackThreadRef = { readonly channel_id: string; readonly thread_ts: string };

export type SlackFetchDeps = {
  /** config.slack.botToken. Blank or missing is refused in real mode. */
  readonly token: string | undefined;
  /** Always injected; never the global fetch by default. */
  readonly fetch: FetchLike;
  /** The mock layer: resolveIo decides fixture vs real, settings.mockMode is checked for the token. */
  readonly mock: { readonly settings: Pick<MockSettings, 'mockMode'>; readonly resolveIo: ResolveIo };
  readonly audit: AuditSink;
  readonly maxAttachmentBytes: number;
  /** config.paths.dataDir. Images go to <dataDir>/attachments/<run_id>/. */
  readonly dataDir: string;
  readonly run_id: string;
  readonly interface: Interface;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
};

// What the read returns before attachments are handled. This is the fixture
// result for kind 'slack_read': no URLs, no token, no local paths.
const FileMetaSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  mime: v.pipe(v.string(), v.minLength(1)),
  size: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
export const SlackReadRecordSchema = v.object({
  messages: v.pipe(
    v.array(
      v.object({
        ts: v.pipe(v.string(), v.minLength(1)),
        author: v.string(),
        text: v.string(),
        is_parent: v.optional(v.boolean()),
      }),
    ),
    v.minLength(1),
  ),
  files: v.array(FileMetaSchema),
  names: v.array(v.string()),
});
export type SlackReadRecord = v.InferOutput<typeof SlackReadRecordSchema>;
type FileMeta = v.InferOutput<typeof FileMetaSchema>;

// ------------------------------------------------------------------- entry

const CHANNEL_ID = /^[CGD][A-Z0-9]{2,20}$/;
const THREAD_TS = /^\d{9,11}\.\d{6}$/;
const USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const SLACK_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export async function fetchSlackThread(ref: SlackThreadRef, deps: SlackFetchDeps): Promise<SlackThread> {
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal ?? new AbortController().signal;
  const started = now();
  const channel = typeof ref.channel_id === 'string' ? ref.channel_id.trim() : '';
  const thread_ts = typeof ref.thread_ts === 'string' ? ref.thread_ts.trim() : '';
  const mockMode = deps.mock.settings.mockMode;

  const audit = (fields: { decision: 'allow' | 'deny'; transport: 'real' | 'mock'; exit: number | string; summary: string; reason?: string }) =>
    deps.audit.write(
      makeAuditLine({
        run_id: deps.run_id,
        ts: now().toISOString(),
        interface: deps.interface,
        entity: null,
        tool: AUDIT_TOOL,
        target: AUDIT_TARGET,
        duration_ms: Math.max(0, now().getTime() - started.getTime()),
        ...fields,
      }),
    );
  const transport = mockMode ? 'mock' : 'real';

  // Refusals before any I/O. Each still gets its audit line.
  const refusal = refuse(channel, thread_ts, deps, mockMode);
  if (refusal !== null) {
    // A bad run_id cannot be written to the audit log (it is a path segment
    // there). Check the run_id itself, since another refusal may fire first.
    if (v.is(RunIdSchema, deps.run_id)) audit({ decision: 'deny', transport, exit: refusal.code, summary: `${AUDIT_TOOL}: refused`, reason: refusal.message });
    throw refusal;
  }

  const token = (deps.token ?? '').trim();
  // Filled by the real read only, so no URL lands in a recorded fixture.
  const urls: (string | undefined)[] = [];
  let record: SlackReadRecord;
  let fixtureMiss = false;
  try {
    const outcome = await deps.mock.resolveIo({
      kind: 'slack_read',
      entity: 'global',
      key: { channel, thread_ts },
      signal,
      run_id: deps.run_id,
      real: (s) => readThread({ channel, thread_ts, token, fetch: deps.fetch, signal: s, urls }),
    });
    if (outcome.fixture_miss) {
      fixtureMiss = true;
      throw new SlackFetchError('thread_not_found', 'no fixture for this thread (non-strict mock miss)');
    }
    record = outcome.transport === 'mock' ? parseFixtureRecord(outcome.value) : (outcome.value as SlackReadRecord);
  } catch (err) {
    const exit = err instanceof SlackFetchError ? err.code : isFixtureMiss(err) ? 'fixture_miss' : 'error';
    audit({ decision: 'allow', transport, exit, summary: `${AUDIT_TOOL} ${channel}: failed${fixtureMiss ? ' (fixture miss)' : ''}` });
    if (err instanceof SlackFetchError || isFixtureMiss(err) || signal.aborted) throw err;
    // Anything else (a bug, an abort) is wrapped with a fixed message so
    // nothing from the cause, which might echo a header, is repeated.
    throw new SlackFetchError('error', 'unexpected failure while reading the thread');
  }

  const messages = parentFirst(record.messages, thread_ts);
  if (messages === null) {
    audit({ decision: 'allow', transport, exit: 'thread_not_found', summary: `${AUDIT_TOOL} ${channel}: failed` });
    throw new SlackFetchError('thread_not_found', 'the parent message is not in the thread');
  }
  const attachments = await handleFiles(record.files, urls, { ...deps, token, signal, mockMode });
  const thread: SlackThread = Object.freeze({
    messages: Object.freeze(messages.map((m) => Object.freeze(m))),
    attachments: Object.freeze(attachments),
    names: Object.freeze(dedupeNames(record.names)),
  });
  const downloaded = attachments.filter((a) => a.bytes_ref !== undefined).length;
  audit({
    decision: 'allow',
    transport,
    exit: 0,
    summary: `${AUDIT_TOOL} ${channel}: ${thread.messages.length} messages, ${attachments.length} files, ${downloaded} downloaded, ${thread.names.length} names`,
  });
  return thread;
}

/** The thread in the shape buildTriageRequest takes: only downloaded images become attachments. */
export function toRawThread(thread: SlackThread): RawThread {
  const attachments: Attachment[] = [];
  for (const a of thread.attachments) {
    if (a.bytes_ref !== undefined) attachments.push({ name: a.name, mime: a.mime, bytes_ref: a.bytes_ref });
  }
  return { messages: thread.messages, attachments };
}

function refuse(channel: string, thread_ts: string, deps: SlackFetchDeps, mockMode: boolean): SlackFetchError | null {
  if (!CHANNEL_ID.test(channel)) return new SlackFetchError('invalid_thread', 'channel_id is not a Slack channel id');
  if (!THREAD_TS.test(thread_ts)) return new SlackFetchError('invalid_thread', 'thread_ts is not a Slack ts');
  if (!v.is(RunIdSchema, deps.run_id)) return new SlackFetchError('invalid_run_id', 'run_id is not a run id');
  if (!Number.isInteger(deps.maxAttachmentBytes) || deps.maxAttachmentBytes < 0) {
    return new SlackFetchError('invalid_config', 'maxAttachmentBytes must be a whole number of bytes');
  }
  if (!mockMode && (typeof deps.token !== 'string' || deps.token.trim() === '')) {
    return new SlackFetchError('no_token', 'SLACK_BOT_TOKEN is blank');
  }
  return null;
}

// Sorted by ts with the parent moved to the front and is_parent set from
// thread_ts, for fixtures as well as live reads. null when there is no parent.
function parentFirst(messages: readonly ThreadFileMessage[], thread_ts: string): ThreadFileMessage[] | null {
  const sorted = [...messages].sort((a, b) => compareTs(a.ts, b.ts));
  const parent = sorted.find((m) => m.ts === thread_ts);
  if (parent === undefined) return null;
  return [parent, ...sorted.filter((m) => m !== parent)].map((m) => ({ ...m, is_parent: m === parent }));
}

function isFixtureMiss(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'FixtureMissError';
}

function parseFixtureRecord(value: unknown): SlackReadRecord {
  const parsed = v.safeParse(SlackReadRecordSchema, value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))].slice(0, 5).join(', ');
    throw new SlackFetchError('bad_fixture', `the slack_read fixture fails its schema at ${fields}`);
  }
  return parsed.output;
}

// ------------------------------------------------------------ HTTP helpers

type ReadContext = {
  readonly channel: string;
  readonly thread_ts: string;
  readonly token: string;
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  readonly urls: (string | undefined)[];
};

/** True for https URLs on slack.com or files.slack.com with no credentials or port. */
export function isSlackAuthHost(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && SLACK_AUTH_HOSTS.has(u.hostname) && u.username === '' && u.password === '' && u.port === '';
}

// The only place the token is attached to a request.
async function authorizedFetch(
  url: string,
  token: string,
  fetchFn: FetchLike,
  signal: AbortSignal,
): Promise<Response> {
  if (!isSlackAuthHost(url)) throw new SlackFetchError('refused_host', 'the URL is not on slack.com or files.slack.com');
  return fetchFn(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    // A redirect could carry the header to another host, so none is followed.
    redirect: 'error',
    signal,
  });
}

async function callApi(method: string, params: Record<string, string>, ctx: ReadContext): Promise<Record<string, unknown>> {
  const url = `${SLACK_API_BASE}${method}?${new URLSearchParams(params).toString()}`;
  let res: Response;
  try {
    res = await authorizedFetch(url, ctx.token, ctx.fetch, ctx.signal);
  } catch (err) {
    if (err instanceof SlackFetchError) throw err;
    ctx.signal.throwIfAborted();
    throw new SlackFetchError('network_error', `${method} could not be reached`);
  }
  if (res.status === 429) throw new SlackFetchError('rate_limited', `${method} answered HTTP 429 (not retried)`, 429);
  if (!res.ok) throw new SlackFetchError(`http_${res.status}`, `${method} answered HTTP ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SlackFetchError('bad_response', `${method} did not return JSON`, res.status);
  }
  if (body === null || typeof body !== 'object') throw new SlackFetchError('bad_response', `${method} did not return an object`);
  const obj = body as Record<string, unknown>;
  if (obj.ok !== true) {
    const code = typeof obj.error === 'string' && SLACK_ERROR_CODE.test(obj.error) ? obj.error : 'unknown_error';
    throw new SlackFetchError(code, `${method} returned ok:false`);
  }
  return obj;
}

// ------------------------------------------------------------- real read

type SlackFile = { name?: unknown; title?: unknown; mimetype?: unknown; size?: unknown; url_private?: unknown };
type SlackMessage = {
  ts?: unknown;
  user?: unknown;
  bot_id?: unknown;
  username?: unknown;
  bot_profile?: { name?: unknown };
  text?: unknown;
  blocks?: unknown;
  attachments?: unknown;
  files?: unknown;
};

async function readThread(ctx: ReadContext): Promise<SlackReadRecord> {
  const raw: SlackMessage[] = [];
  let cursor = '';
  const seenCursors = new Set<string>();
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new SlackFetchError('too_many_pages', `the thread has more than ${MAX_PAGES} pages`);
    const params: Record<string, string> = { channel: ctx.channel, ts: ctx.thread_ts, limit: String(PAGE_LIMIT) };
    if (cursor !== '') params.cursor = cursor;
    const body = await callApi('conversations.replies', params, ctx);
    if (Array.isArray(body.messages)) raw.push(...(body.messages as SlackMessage[]));
    const next = (body.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    cursor = typeof next === 'string' ? next : '';
    if (cursor === '' || body.has_more === false) break;
    if (seenCursors.has(cursor)) throw new SlackFetchError('bad_response', 'conversations.replies repeated a cursor');
    seenCursors.add(cursor);
  }

  const messages = orderMessages(raw);
  if (!messages.some((m) => str(m.ts) === ctx.thread_ts)) {
    throw new SlackFetchError('thread_not_found', 'the parent message is not in the thread');
  }

  // Authors, plus users mentioned in the template name fields.
  const userIds: string[] = [];
  const templateNames: string[] = [];
  for (const m of messages) {
    const user = str(m.user);
    if (USER_ID.test(user)) userIds.push(user);
    for (const found of templateFieldValues(messageTexts(m))) {
      if (found.userId !== undefined) userIds.push(found.userId);
      else templateNames.push(found.name);
    }
  }
  const profiles = new Map<string, readonly string[]>();
  for (const id of [...new Set(userIds)]) profiles.set(id, await userNames(id, ctx));

  const out: ThreadFileMessage[] = [];
  const files: FileMeta[] = [];
  for (const m of messages) {
    const ts = str(m.ts);
    out.push({ ts, author: authorOf(m, profiles), text: renderText(m), is_parent: ts === ctx.thread_ts });
    for (const f of Array.isArray(m.files) ? (m.files as SlackFile[]) : []) {
      const meta: FileMeta = {
        name: str(f.name) || str(f.title) || `file-${files.length + 1}`,
        mime: str(f.mimetype).toLowerCase() || 'application/octet-stream',
      };
      if (typeof f.size === 'number' && Number.isInteger(f.size) && f.size >= 0) meta.size = f.size;
      files.push(meta);
      ctx.urls.push(typeof f.url_private === 'string' ? f.url_private : undefined);
    }
  }
  const names = [...[...profiles.values()].flat(), ...templateNames];
  return { messages: out, files, names: dedupeNames(names) };
}

async function userNames(id: string, ctx: ReadContext): Promise<readonly string[]> {
  let body: Record<string, unknown>;
  try {
    body = await callApi('users.info', { user: id }, ctx);
  } catch (err) {
    // A deleted or hidden user should not stop the read; other failures do.
    if (err instanceof SlackFetchError && (err.code === 'user_not_found' || err.code === 'user_not_visible')) return [];
    throw err;
  }
  const user = (body.user ?? {}) as { real_name?: unknown; profile?: Record<string, unknown> };
  const p = user.profile ?? {};
  return [p.display_name, p.real_name, user.real_name, p.display_name_normalized, p.real_name_normalized]
    .map(str)
    .filter((n) => n !== '');
}

function authorOf(m: SlackMessage, profiles: ReadonlyMap<string, readonly string[]>): string {
  const user = str(m.user);
  const names = profiles.get(user);
  if (names !== undefined && names.length > 0) return names[0] as string;
  if (user !== '') return user;
  return str(m.bot_profile?.name) || str(m.username) || str(m.bot_id);
}

function orderMessages(raw: readonly SlackMessage[]): SlackMessage[] {
  const byTs = new Map<string, SlackMessage>();
  for (const m of raw) {
    const ts = str(m.ts);
    if (THREAD_TS.test(ts) && !byTs.has(ts)) byTs.set(ts, m);
  }
  return [...byTs.values()].sort((a, b) => compareTs(str(a.ts), str(b.ts)));
}

function compareTs(a: string, b: string): number {
  const [as = '0', af = '0'] = a.split('.');
  const [bs = '0', bf = '0'] = b.split('.');
  return Number(as) - Number(bs) || Number(af) - Number(bf);
}

// ------------------------------------------------------ text and names

type Block = { text?: { text?: unknown }; fields?: { text?: unknown }[]; elements?: unknown };
type LegacyAttachment = { text?: unknown; fallback?: unknown; fields?: { title?: unknown; value?: unknown }[] };

/** Every piece of text on a message: text, section blocks and legacy attachment fields. */
function messageTexts(m: SlackMessage): string[] {
  const out: string[] = [];
  const text = str(m.text);
  if (text !== '') out.push(text);
  for (const b of Array.isArray(m.blocks) ? (m.blocks as Block[]) : []) {
    const t = str(b?.text?.text);
    if (t !== '') out.push(t);
    for (const f of Array.isArray(b?.fields) ? b.fields : []) {
      const ft = str(f?.text);
      if (ft !== '') out.push(ft);
    }
  }
  for (const a of Array.isArray(m.attachments) ? (m.attachments as LegacyAttachment[]) : []) {
    const t = str(a?.text);
    if (t !== '') out.push(t);
    for (const f of Array.isArray(a?.fields) ? a.fields : []) {
      const title = str(f?.title);
      const value = str(f?.value);
      if (title !== '' || value !== '') out.push(`${title}: ${value}`);
    }
  }
  return out;
}

// The model reads message.text; bot posts that only carry blocks fall back to them.
function renderText(m: SlackMessage): string {
  const text = str(m.text);
  if (text.trim() !== '') return text;
  return messageTexts(m).join('\n');
}

type TemplateValue = { readonly name: string; readonly userId?: undefined } | { readonly userId: string; readonly name?: undefined };

const FIELD_RE = new RegExp(
  `(?:^|\\n)[ \\t>]*(${TEMPLATE_NAME_FIELDS.map((f) => f.replace(/ /g, '\\s+')).join('|')})[ \\t]*:[ \\t]*(?:\\n[ \\t>]*)?([^\\n]*)`,
  'gi',
);
const MENTION_RE = /^<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>$/;
const EMPTY_VALUES = new Set(['', '-', 'na', 'n/a', 'none', 'null', 'nil', 'unknown']);

/** Values of the name-bearing bot template fields ("*Raised by:* Name", "Owner: <@U1>"). */
export function templateFieldValues(texts: readonly string[]): TemplateValue[] {
  const out: TemplateValue[] = [];
  for (const text of texts) {
    // Bold and italic markers sit around labels and values; drop them first.
    const plain = text.replace(/[*_]/g, '');
    for (const match of plain.matchAll(FIELD_RE)) {
      const value = (match[2] ?? '').trim();
      const mention = MENTION_RE.exec(value);
      if (mention !== null) {
        out.push({ userId: mention[1] as string });
        continue;
      }
      if (EMPTY_VALUES.has(value.toLowerCase()) || value.length > 80) continue;
      // A link, an email or an id is not a name.
      if (/[<>@]|\d{3,}/.test(value)) continue;
      out.push({ name: value });
    }
  }
  return out;
}

/** Trims, collapses spaces, drops one-letter names and removes case-insensitive duplicates, keeping first-seen order. */
export function dedupeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = str(raw).replace(/\s+/g, ' ').trim();
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ------------------------------------------------------------ attachments

type FileDeps = SlackFetchDeps & { readonly token: string; readonly signal: AbortSignal; readonly mockMode: boolean };

async function handleFiles(
  files: readonly FileMeta[],
  urls: readonly (string | undefined)[],
  deps: FileDeps,
): Promise<SlackAttachment[]> {
  const out: SlackAttachment[] = [];
  const dir = resolve(deps.dataDir, 'attachments', deps.run_id);
  for (const [i, f] of files.entries()) {
    const base = { name: f.name, mime: f.mime, ...(f.size !== undefined ? { size: f.size } : {}) };
    const ext = IMAGE_MIMES[f.mime];
    if (ext === undefined) {
      out.push({ ...base, skipped: 'not_image' });
      continue;
    }
    if (f.size !== undefined && f.size > deps.maxAttachmentBytes) {
      out.push({ ...base, skipped: 'too_large' });
      continue;
    }
    if (deps.mockMode) {
      out.push({ ...base, skipped: 'mock' });
      continue;
    }
    const url = urls[i];
    if (url === undefined || !isSlackAuthHost(url)) {
      out.push({ ...base, skipped: 'refused_host' });
      continue;
    }
    const got = await download(url, f.mime, deps);
    if (got.skipped !== undefined) {
      out.push({ ...base, skipped: got.skipped });
      continue;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Named by position and type, never by the Slack file name.
    const path = join(dir, `${i + 1}.${ext}`);
    writeFileSync(path, got.bytes, { mode: 0o600 });
    out.push({ ...base, size: got.bytes.byteLength, bytes_ref: path });
  }
  return out;
}

async function download(
  url: string,
  mime: string,
  deps: FileDeps,
): Promise<{ bytes: Uint8Array; skipped?: undefined } | { skipped: SkipReason }> {
  let res: Response;
  try {
    res = await authorizedFetch(url, deps.token, deps.fetch, deps.signal);
  } catch {
    deps.signal.throwIfAborted();
    return { skipped: 'download_failed' };
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  // Slack answers a missing files:read scope with an HTML page and status 200.
  if (!res.ok || type !== mime) {
    await res.body?.cancel().catch(() => undefined);
    return { skipped: 'download_failed' };
  }
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > deps.maxAttachmentBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { skipped: 'too_large' };
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return { skipped: 'download_failed' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > deps.maxAttachmentBytes) {
        await reader.cancel().catch(() => undefined);
        return { skipped: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    deps.signal.throwIfAborted();
    return { skipped: 'download_failed' };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes };
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}
