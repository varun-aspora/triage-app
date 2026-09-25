// Turns caller input into a TriageRequest (LLD 04 §2.1). Pure: the caller
// passes the clock, the id source, the lookback days and the enabled entities,
// so this module never reads files, the network or the environment.
//
// Four kinds of input:
// - text: one free-text message, which becomes the thread parent.
// - thread_file: a JSON document a coding agent wrote with its own Slack tool.
// - json: an HTTP body with the same messages[] shape.
// - slack: a permalink plus the thread another module already fetched.
//
// Any kind may also carry context: free text from the caller that is not in
// the thread. It is appended as one last message under CONTEXT_AUTHOR, so
// every reader of the thread sees it without a separate field.
//
// Error messages name keys and positions only. Message text and id values are
// customer data and never go into an error.
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import {
  KNOWN_ID_KEYS,
  KnownIdsSchema,
  NonEmptyStringSchema,
  TakenAtSchema,
  TierSchema,
  type Entity,
  type Interface,
  type KnownIdKey,
  type KnownIds,
  type Tier,
  type TimeWindow,
} from '../types/core.ts';
import {
  AttachmentSchema,
  TriageRequestSchema,
  type Attachment,
  type RequestHints,
  type RequestSource,
  type ThreadMessage,
  type TriageRequest,
} from '../types/request.ts';
import { parseSlackPermalink } from './slack-url.ts';
import { newRunId } from './ulid.ts';

// ------------------------------------------------------------------ errors

/** Bad caller input: a usage error on the CLI, a 400 over HTTP. */
export class IngressInputError extends Error {
  override readonly name = 'IngressInputError';
  readonly key: string;
  readonly reason: string;

  constructor(key: string, reason: string) {
    super(`${key} ${reason}`);
    this.key = key;
    this.reason = reason;
  }
}

/** The entity hints left nothing once narrowed to TRIAGE_ENTITIES. */
export class NoEnabledEntityError extends Error {
  override readonly name = 'NoEnabledEntityError';
  readonly enabled: readonly Entity[];

  constructor(enabled: readonly Entity[]) {
    const list = enabled.length > 0 ? enabled.join(', ') : 'none';
    super(`none of the requested entities is enabled; TRIAGE_ENTITIES enables: ${list}`);
    this.enabled = Object.freeze([...enabled]);
  }
}

// ----------------------------------------------------------------- schemas

export const ThreadFileMessageSchema = v.object({
  ts: NonEmptyStringSchema,
  author: v.string(),
  text: v.string(),
  is_parent: v.optional(v.boolean()),
});
export type ThreadFileMessage = v.InferOutput<typeof ThreadFileMessageSchema>;

/** The --thread-file document. Entities may use aliases such as 'shivalik'. */
export const ThreadFileSchema = v.object({
  messages: v.pipe(v.array(ThreadFileMessageSchema), v.minLength(1, 'must hold at least one message')),
  ids: v.optional(v.record(v.string(), v.string())),
  entities: v.optional(v.array(v.string())),
  tier: v.optional(TierSchema),
});
export type ThreadFile = v.InferOutput<typeof ThreadFileSchema>;

/** The HTTP body with messages[]: the thread-file fields plus who asked and a window. */
export const RequestBodySchema = v.object({
  ...ThreadFileSchema.entries,
  requested_by: v.optional(NonEmptyStringSchema),
  time_window: v.optional(v.object({ from: v.string(), to: v.string() })),
});
export type RequestBody = v.InferOutput<typeof RequestBodySchema>;

/** A thread as another module fetched it, before normalisation. */
export type RawThread = {
  readonly messages: readonly ThreadFileMessage[];
  readonly attachments?: readonly Attachment[];
};

// ------------------------------------------------------------------- input

/** Hints from CLI flags or the HTTP body. Flags win over the thread file. */
export type InputHints = {
  readonly entities?: readonly string[];
  readonly ids?: Partial<KnownIds>;
  readonly tier?: Tier;
  readonly time_window?: { readonly from: string; readonly to: string };
};

/** The author of the appended context message. Not a person, so never a redaction name. */
export const CONTEXT_AUTHOR = 'added context';

/** Caller context longer than this is refused. */
export const MAX_CONTEXT_CHARS = 20_000;

type CommonInput = {
  readonly interface: Interface;
  /** Required, except that a json body may carry its own requested_by. */
  readonly requested_by?: string;
  readonly hints?: InputHints;
  /** Extra text from the caller, appended after the thread. Blank means none. */
  readonly context?: string;
  readonly attachments?: readonly Attachment[];
};

export type TriageInput =
  | (CommonInput & { readonly kind: 'text'; readonly text: string })
  | (CommonInput & { readonly kind: 'thread_file'; readonly file: unknown })
  | (CommonInput & { readonly kind: 'json'; readonly body: unknown })
  | (CommonInput & { readonly kind: 'slack'; readonly url: string; readonly thread: RawThread });

export type NormaliseOptions = {
  readonly now: Date;
  readonly newId: () => string;
  /** TRIAGE_DEFAULT_LOOKBACK_DAYS. */
  readonly lookbackDays: number;
  /** TRIAGE_ENTITIES as the registry resolved it. */
  readonly enabledEntities: readonly Entity[];
  /** Resolves ids and aliases ('shivalik' -> 'ssfb'). Pass registry.resolveEntity. */
  readonly resolveEntity: (name: string) => Entity | undefined;
};

/** Options from the loaded config and registry, with the real clock and ULIDs by default. */
export function normaliseOptions(
  config: Pick<Config, 'budgets'>,
  registry: Pick<Registry, 'enabledEntities' | 'resolveEntity'>,
  overrides: Partial<Pick<NormaliseOptions, 'now' | 'newId'>> = {},
): NormaliseOptions {
  return {
    now: overrides.now ?? new Date(),
    newId: overrides.newId ?? newRunId,
    lookbackDays: config.budgets.defaultLookbackDays,
    enabledEntities: registry.enabledEntities(),
    resolveEntity: (name) => registry.resolveEntity(name),
  };
}

// ------------------------------------------------------------- --ids flag

const KNOWN_ID_KEY_SET: ReadonlySet<string> = new Set(KNOWN_ID_KEYS);
const KEY_LIKE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isKnownIdKey(key: string): key is KnownIdKey {
  return KNOWN_ID_KEY_SET.has(key);
}

/** Parses repeated --ids k=v pairs. Only KnownIds keys are accepted. */
export function parseIdsFlag(pairs: readonly string[]): Partial<KnownIds> {
  const out: Partial<Record<KnownIdKey, string>> = {};
  pairs.forEach((pair, i) => {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      // Name the text only when it looks like a key; otherwise it may be an id value.
      const trimmed = pair.trim();
      const label = KEY_LIKE_RE.test(trimmed) ? trimmed : `entry ${i + 1}`;
      throw new IngressInputError(`--ids ${label}`, "is missing '=' (expected key=value)");
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!isKnownIdKey(key)) {
      const label = KEY_LIKE_RE.test(key) ? key : `entry ${i + 1}`;
      throw new IngressInputError(`--ids ${label}`, `is not a known id key (known: ${KNOWN_ID_KEYS.join(', ')})`);
    }
    if (value === '') throw new IngressInputError(`--ids ${key}`, 'has an empty value');
    if (out[key] !== undefined) throw new IngressInputError(`--ids ${key}`, 'is given more than once');
    out[key] = value;
  });
  return out;
}

// ------------------------------------------------------------- timestamps

const SLACK_TS_RE = /^(\d{1,14})(?:\.(\d{1,6}))?$/;

/** Microseconds since the epoch, from a Slack ts or an ISO timestamp. */
function tsToMicros(ts: string, key: string): bigint {
  const m = SLACK_TS_RE.exec(ts);
  if (m !== null) {
    const frac = (m[2] ?? '').padEnd(6, '0');
    return BigInt(m[1] as string) * 1_000_000n + BigInt(frac);
  }
  if (v.is(TakenAtSchema, ts)) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms)) return BigInt(ms) * 1000n;
  }
  throw new IngressInputError(key, 'is not a Slack ts or an ISO timestamp');
}

/** A Date as a Slack-style ts, seconds with 6 decimal places. */
function dateToSlackTs(d: Date): string {
  const ms = d.getTime();
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

/**
 * The caller's context as a reply after the last thread message. Its ts is
 * now, or just after the last message if the thread ends later than now.
 */
function contextMessage(text: string | undefined, messages: readonly ThreadMessage[], opts: NormaliseOptions): ThreadMessage | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  if (text.length > MAX_CONTEXT_CHARS) throw new IngressInputError('context', `is longer than ${MAX_CONTEXT_CHARS} characters`);
  const last = messages[messages.length - 1] as ThreadMessage;
  const afterLast = tsToMicros(last.ts, 'messages.ts') + 1n;
  const nowMicros = BigInt(opts.now.getTime()) * 1000n;
  const micros = nowMicros > afterLast ? nowMicros : afterLast;
  const ts = `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
  return { ts, author: CONTEXT_AUTHOR, text: text.trim(), is_parent: false };
}

function isoOf(value: string, key: string): string {
  if (!v.is(TakenAtSchema, value) || !Number.isFinite(Date.parse(value))) {
    throw new IngressInputError(key, 'is not an ISO timestamp');
  }
  return new Date(Date.parse(value)).toISOString();
}

// --------------------------------------------------------------- building

function parseOrThrow<S extends v.GenericSchema>(schema: S, value: unknown, root: string): v.InferOutput<S> {
  const r = v.safeParse(schema, value);
  if (r.success) return r.output;
  // Report where the problem is, not what was received.
  const paths = [...new Set(r.issues.map((i) => v.getDotPath(i) ?? ''))];
  const where = paths.map((p) => (p === '' ? root : `${root}.${p}`)).join(', ');
  throw new IngressInputError(where, 'is invalid');
}

function normaliseMessages(raw: readonly ThreadFileMessage[]): ThreadMessage[] {
  if (raw.length === 0) throw new IngressInputError('messages', 'must hold at least one message');
  const keyed = raw.map((m, i) => ({
    micros: tsToMicros(m.ts.trim(), `messages[${i}].ts`),
    msg: { ts: m.ts.trim(), author: m.author, text: m.text, is_parent: m.is_parent === true },
  }));
  // Array.prototype.sort is stable, so equal ts keep their input order.
  keyed.sort((a, b) => (a.micros < b.micros ? -1 : a.micros > b.micros ? 1 : 0));
  const messages = keyed.map((k) => k.msg);
  const parents = messages.filter((m) => m.is_parent).length;
  if (parents > 1) throw new IngressInputError('messages', 'mark more than one message as is_parent');
  if (parents === 0) (messages[0] as ThreadMessage).is_parent = true;
  return messages;
}

function firstMessageMs(messages: readonly ThreadMessage[]): number {
  const first = messages[0] as ThreadMessage;
  return Number(tsToMicros(first.ts, 'messages[0].ts') / 1000n);
}

function buildWindow(
  messages: readonly ThreadMessage[],
  override: InputHints['time_window'],
  opts: NormaliseOptions,
): TimeWindow {
  if (override !== undefined) {
    const from = isoOf(override.from, 'time_window.from');
    const to = isoOf(override.to, 'time_window.to');
    if (Date.parse(from) > Date.parse(to)) throw new IngressInputError('time_window', 'has from later than to');
    return { from, to };
  }
  if (!Number.isInteger(opts.lookbackDays) || opts.lookbackDays < 1) {
    throw new IngressInputError('TRIAGE_DEFAULT_LOOKBACK_DAYS', 'must be a positive integer');
  }
  const nowMs = opts.now.getTime();
  const fromMs = Math.min(firstMessageMs(messages) - opts.lookbackDays * 86_400_000, nowMs);
  return { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() };
}

function narrowEntities(hints: readonly string[] | undefined, opts: NormaliseOptions): Entity[] | undefined {
  if (hints === undefined || hints.length === 0) return undefined;
  const wanted = new Set<Entity>();
  for (const name of hints) {
    const e = opts.resolveEntity(name.trim().toLowerCase());
    if (e !== undefined) wanted.add(e);
  }
  // Keep TRIAGE_ENTITIES order; hints can only remove entities, never add them.
  const kept = opts.enabledEntities.filter((e) => wanted.has(e));
  if (kept.length === 0) throw new NoEnabledEntityError(opts.enabledEntities);
  return kept;
}

function mergeIds(fromFile: Record<string, string> | undefined, fromFlags: Partial<KnownIds> | undefined): KnownIds | undefined {
  const merged: Record<string, string> = {};
  for (const [source, ids] of [['ids', fromFile], ['hints.ids', fromFlags]] as const) {
    if (ids === undefined) continue;
    for (const [key, value] of Object.entries(ids)) {
      if (!isKnownIdKey(key)) {
        const label = KEY_LIKE_RE.test(key) ? key : 'a key';
        throw new IngressInputError(`${source}.${label}`, 'is not a known id key');
      }
      if (typeof value !== 'string') throw new IngressInputError(`${source}.${key}`, 'must be a string');
      merged[key] = value;
    }
  }
  if (Object.keys(merged).length === 0) return undefined;
  return parseOrThrow(KnownIdsSchema, merged, 'ids');
}

type Extracted = {
  source: RequestSource;
  raw: readonly ThreadFileMessage[];
  attachments: readonly Attachment[];
  requestedBy?: string;
  file: Pick<ThreadFile, 'ids' | 'entities' | 'tier'>;
  timeWindow?: InputHints['time_window'];
};

function extract(input: TriageInput, opts: NormaliseOptions): Extracted {
  const attachments = input.attachments ?? [];
  switch (input.kind) {
    case 'text': {
      if (typeof input.text !== 'string' || input.text.trim() === '') throw new IngressInputError('--text', 'is empty');
      const raw = [{ ts: dateToSlackTs(opts.now), author: input.requested_by ?? '', text: input.text, is_parent: true }];
      return { source: { kind: 'text' }, raw, attachments, file: {} };
    }
    case 'thread_file': {
      const file = parseOrThrow(ThreadFileSchema, input.file, 'thread_file');
      return { source: { kind: 'thread_file' }, raw: file.messages, attachments, file };
    }
    case 'json': {
      const body = parseOrThrow(RequestBodySchema, input.body, 'body');
      return {
        source: { kind: 'json' },
        raw: body.messages,
        attachments,
        file: body,
        ...(body.requested_by !== undefined ? { requestedBy: body.requested_by } : {}),
        ...(body.time_window !== undefined ? { timeWindow: body.time_window } : {}),
      };
    }
    case 'slack': {
      const link = parseSlackPermalink(input.url);
      const thread = parseOrThrow(
        v.object({ messages: ThreadFileSchema.entries.messages, attachments: v.optional(v.array(AttachmentSchema)) }),
        input.thread,
        'thread',
      );
      return {
        source: { kind: 'slack', channel_id: link.channel_id, thread_ts: link.thread_ts, permalink: link.permalink },
        raw: thread.messages,
        attachments: [...(thread.attachments ?? []), ...attachments],
        file: {},
      };
    }
    default: {
      const unknownKind: never = input;
      void unknownKind;
      throw new IngressInputError('kind', 'is not one of text, thread_file, json, slack');
    }
  }
}

/**
 * Builds the TriageRequest. The result is a fresh object tree: it shares no
 * arrays or objects with the input, so later changes by the caller do not
 * reach it.
 */
export function buildTriageRequest(input: TriageInput, opts: NormaliseOptions): TriageRequest {
  const x = extract(input, opts);
  const flags = input.hints ?? {};

  const requestedBy = (input.requested_by ?? x.requestedBy ?? '').trim();
  if (requestedBy === '') throw new IngressInputError('requested_by', 'is required');

  const messages = normaliseMessages(x.raw);
  const context = contextMessage(input.context, messages, opts);
  if (context !== undefined) messages.push(context);
  const timeWindow = flags.time_window ?? x.timeWindow;
  const window = buildWindow(messages, timeWindow, opts);

  const hints: RequestHints = {};
  const entities = narrowEntities(flags.entities ?? x.file.entities, opts);
  if (entities !== undefined) hints.entities = entities;
  const ids = mergeIds(x.file.ids, flags.ids);
  if (ids !== undefined) hints.ids = ids;
  const tier = flags.tier ?? x.file.tier;
  if (tier !== undefined) hints.tier = tier;
  if (timeWindow !== undefined) hints.time_window = { ...window };

  const draft = {
    request_id: opts.newId(),
    interface: input.interface,
    requested_by: requestedBy,
    source: { ...x.source },
    messages: messages.map((m) => ({ ...m })),
    attachments: x.attachments.map((a) => ({ name: a.name, mime: a.mime, bytes_ref: a.bytes_ref })),
    hints,
    window: { ...window },
    received_at: opts.now.toISOString(),
  };
  // A final parse checks the whole shape; valibot returns new objects, which
  // also makes the result independent of the input.
  return parseOrThrow(TriageRequestSchema, draft, 'request');
}
