// Turns caller input into a prepared submission (LLD 04 §2.1, §3).
//
// prepareRequest(input, deps) mints the run id, resolves the input kind and
// calls buildTriageRequest:
// - slack: the permalink is parsed, then fetchSlackThread reads the whole
//   thread (bot token, attachments, ingress names) under the new run id;
// - thread_file: the file is read and parsed as JSON here, and
//   buildTriageRequest checks it against ThreadFileSchema;
// - text and json pass straight through.
// input.context, when given, is appended to the thread for every kind.
//
// Every failure surfaces here, before anything is stored or dispatched: a
// SlackFetchError (with the --thread-file hint), a SlackPermalinkError, an
// IngressInputError naming the bad field, or NoEnabledEntityError. Errors
// never quote message text or id values.
//
// The result carries the raw request, which lives in memory only, and the
// names collected for the persisted redaction profile. The names ride next to
// the request, never inside it, so the run store never receives them.
import { readFile as fsReadFile } from 'node:fs/promises';
import type { Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import { createJsonlAuditSink } from '../gate/audit-sink.ts';
import { createMockLayer } from '../mock/index.ts';
import type { Interface, RunId } from '../types/core.ts';
import type { TriageRequest } from '../types/request.ts';
import {
  buildTriageRequest,
  CONTEXT_AUTHOR,
  IngressInputError,
  normaliseOptions,
  type InputHints,
  type NormaliseOptions,
  type TriageInput,
} from './normalise.ts';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  dedupeNames,
  fetchSlackThread,
  SlackFetchError,
  templateFieldValues,
  toRawThread,
  type FetchLike,
  type SlackFetchDeps,
  type SlackThread,
  type SlackThreadRef,
} from './slack.ts';
import { parseSlackPermalink } from './slack-url.ts';
import { newRunId } from './ulid.ts';

/** A thread file larger than this is refused before parsing. */
export const MAX_THREAD_FILE_BYTES = 5 * 1024 * 1024;

type PrepareCommon = {
  readonly interface: Interface;
  /** Required, except that a json body may carry its own requested_by. */
  readonly requested_by?: string;
  readonly hints?: InputHints;
  /** Extra caller text appended after the thread; see buildTriageRequest. */
  readonly context?: string;
};

export type PrepareInput =
  | (PrepareCommon & { readonly kind: 'text'; readonly text: string })
  | (PrepareCommon & { readonly kind: 'thread_file'; readonly path: string })
  | (PrepareCommon & { readonly kind: 'json'; readonly body: unknown })
  | (PrepareCommon & { readonly kind: 'slack'; readonly url: string });

/** The Slack read deps without the per-run fields prepareRequest fills in. */
export type SlackPrepareDeps = Omit<SlackFetchDeps, 'run_id' | 'interface' | 'signal'>;

export type FetchThreadFn = (ref: SlackThreadRef, deps: SlackFetchDeps) => Promise<SlackThread>;

export type PrepareDeps = {
  /** Clock, lookback days and enabled entities. newId is ignored: the run id comes from deps.newId. */
  readonly normalise: Omit<NormaliseOptions, 'newId'>;
  /** Mints the run id. Defaults to a ULID. */
  readonly newId?: () => RunId;
  /** Reads a thread file as UTF-8. Defaults to node:fs. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Needed for slack input only. */
  readonly slack?: SlackPrepareDeps;
  /** Defaults to fetchSlackThread. */
  readonly fetchThread?: FetchThreadFn;
  readonly signal?: AbortSignal;
};

/** What runSubmission takes. Also the submit worker payload minus its kind. */
export type PreparedSubmission = {
  readonly run_id: RunId;
  /** The raw request. In memory only; the store gets the persisted-profile copy. */
  readonly request: TriageRequest;
  /** Names collected by ingress for the persisted profile. Never stored. */
  readonly redaction_names: readonly string[];
};

export async function prepareRequest(input: PrepareInput, deps: PrepareDeps): Promise<PreparedSubmission> {
  deps.signal?.throwIfAborted();
  const runId = (deps.newId ?? newRunId)();
  const opts: NormaliseOptions = { ...deps.normalise, newId: () => runId };
  const common = {
    interface: input.interface,
    ...(input.requested_by !== undefined ? { requested_by: input.requested_by } : {}),
    ...(input.hints !== undefined ? { hints: input.hints } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  };

  if (input.kind === 'slack') {
    // Parse first, so a bad link fails before any read.
    const link = parseSlackPermalink(input.url);
    if (deps.slack === undefined) throw new SlackFetchError('not_configured', 'the Slack reader is not set up here');
    const fetchThread = deps.fetchThread ?? fetchSlackThread;
    const thread = await fetchThread(
      { channel_id: link.channel_id, thread_ts: link.thread_ts },
      {
        ...deps.slack,
        run_id: runId,
        interface: input.interface,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      },
    );
    const request = buildTriageRequest({ ...common, kind: 'slack', url: input.url, thread: toRawThread(thread) }, opts);
    return prepared(runId, request, thread.names);
  }

  let normalised: TriageInput;
  switch (input.kind) {
    case 'text':
      normalised = { ...common, kind: 'text', text: input.text };
      break;
    case 'thread_file':
      normalised = { ...common, kind: 'thread_file', file: await readThreadFile(input.path, deps) };
      break;
    case 'json':
      normalised = { ...common, kind: 'json', body: input.body };
      break;
    default: {
      const unknownKind: never = input;
      void unknownKind;
      throw new IngressInputError('kind', 'is not one of text, thread_file, json, slack');
    }
  }
  const request = buildTriageRequest(normalised, opts);
  return prepared(runId, request, collectNames(request));
}

/** Deps built from the loaded config and registry: real clock, mock layer, JSONL audit, global fetch. */
export function prepareDeps(
  config: Config,
  registry: Pick<Registry, 'enabledEntities' | 'resolveEntity'>,
  overrides: Partial<PrepareDeps> & { readonly fetch?: FetchLike } = {},
): PrepareDeps {
  const { fetch: fetchOverride, ...rest } = overrides;
  const { newId: _unused, ...normalise } = normaliseOptions(config, registry);
  const mock = createMockLayer(config, { home: config.home });
  const slack: SlackPrepareDeps = {
    token: config.slack.botToken,
    fetch: fetchOverride ?? ((url, init) => fetch(url, init)),
    mock: { settings: mock.settings, resolveIo: mock.resolveIo },
    audit: createJsonlAuditSink({ auditLogPath: config.paths.auditLog, runsDir: config.paths.runsDir }),
    maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    dataDir: config.paths.dataDir,
  };
  return { normalise, slack, ...rest };
}

// ------------------------------------------------------------------ helpers

function prepared(runId: RunId, request: TriageRequest, names: readonly string[]): PreparedSubmission {
  return Object.freeze({ run_id: runId, request, redaction_names: Object.freeze(dedupeNames(names)) });
}

async function readThreadFile(path: string, deps: PrepareDeps): Promise<unknown> {
  if (typeof path !== 'string' || path.trim() === '') throw new IngressInputError('--thread-file', 'is empty');
  const read = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const suffix = typeof code === 'string' && /^E[A-Z]+$/.test(code) ? ` (${code})` : '';
    throw new IngressInputError('--thread-file', `could not be read${suffix}`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_THREAD_FILE_BYTES) {
    throw new IngressInputError('--thread-file', `is larger than ${MAX_THREAD_FILE_BYTES} bytes`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IngressInputError('--thread-file', 'is not valid JSON');
  }
}

// Slack user ids and emails are not names; emails are masked by their own pattern.
const NOT_A_NAME = /^[UW][A-Z0-9]{2,20}$|@/;

/**
 * Names for the persisted profile when the thread did not come from Slack:
 * the message authors plus the Raised by, Owner and Customer Name template
 * values. Mentions of Slack user ids cannot be resolved here and are skipped.
 */
function collectNames(request: TriageRequest): string[] {
  const names: string[] = [];
  for (const m of request.messages) {
    const author = m.author.trim();
    if (author !== '' && author !== CONTEXT_AUTHOR && !NOT_A_NAME.test(author)) names.push(author);
  }
  for (const value of templateFieldValues(request.messages.map((m) => m.text))) {
    if (value.name !== undefined) names.push(value.name);
  }
  return names;
}
