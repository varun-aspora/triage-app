// The Quickwit connector behind logs_search (D44, A3). One entry point,
// search(ctx, entity, input, requestWindow), whichever transport the entity
// uses:
//
// 1. The transport comes from registry.quickwit(entity) and .env. A blank
//    transport, a blank index, qw without a context or http without a URL
//    (or bearer without a token) is not_configured.
// 2. The query and window are built by src/gate/quickwit.ts and
//    src/gate/quickwit-window.ts. Their refusals become ConnectorError
//    refused.
// 3. Mock mode answers from the fixture store with a transport-neutral key,
//    so the qw and http configs of one entity share fixtures. Nothing is
//    run and nothing is fetched.
// 4. A real call holds the entity's slot from quickwitSlot() for the whole
//    call, retry included. This is the only place the cap is held. A timeout
//    is retried once after a backoff; nothing else is retried.
//
// The data shape is the same for both transports. The transport kind goes
// only in meta, for the audit line. No run_id is sent to qw (Q29): infra's
// qw_audit and ours correlate by meta.started_at.
import type { Config } from '../../config/env.ts';
import { RegistryError, type Registry } from '../../config/registry.ts';
import { buildLogsQuery, quickwitGateConfig, type LogsQueryInput, type QuickwitGateConfig } from '../../gate/quickwit.ts';
import { resolveWindow, toSince } from '../../gate/quickwit-window.ts';
import { quickwitSlot } from '../../gate/semaphore.ts';
import type { LogsSearchFacts } from '../../mock/key.ts';
import type { Entity, TimeWindow } from '../../types/core.ts';
import { createExecRunner, type ExecRunner } from '../exec.ts';
import { withMock } from '../mock.ts';
import { ConnectorError, isConnectorError, type ConnectorContext, type ConnectorOutcome } from '../types.ts';
import { httpSearch, type FetchLike } from './http-transport.ts';
import { qwSearch } from './qw-transport.ts';

export type QuickwitTransportKind = 'qw' | 'http';

export type LogHit = Readonly<Record<string, unknown>>;
export type LogGroup = { readonly key: string; readonly count: number };

/** What a transport hands back before the client shapes it. */
export type TransportResult =
  | { readonly kind: 'hits'; readonly hits: readonly LogHit[]; readonly num_hits: number }
  | { readonly kind: 'count'; readonly num_hits: number }
  | { readonly kind: 'groups'; readonly groups: readonly LogGroup[]; readonly num_hits: number; readonly truncated: boolean };

type DataCommon = {
  readonly num_hits: number;
  readonly window: TimeWindow;
  /** Set when the window could not be applied as asked (qw has --since only, Q28). */
  readonly window_note?: string;
  readonly truncated: boolean;
  /** Notes from the query builder, such as a clamped max_hits. */
  readonly notes?: readonly string[];
};

/** The one data shape logs_search gets, whichever transport ran. */
export type LogsSearchData =
  | (DataCommon & { readonly hits: readonly LogHit[] })
  | (DataCommon & { readonly count: number })
  | (DataCommon & { readonly groups: readonly LogGroup[] });

/** For the audit line only. Never part of data. */
export type QuickwitMeta = {
  readonly quickwit_transport: QuickwitTransportKind;
  /** When the call started. Used to line up with infra's qw_audit (Q29). */
  readonly started_at: string;
  /** Transport attempts made: 0 in mock mode, 2 after a retried timeout. */
  readonly attempts: number;
};

export type QuickwitSearchOutcome = ConnectorOutcome<LogsSearchData> & { readonly meta: QuickwitMeta };

export type QuickwitSearchInput = LogsQueryInput & { readonly from?: string; readonly to?: string };

export type QuickwitConnectorDeps = {
  readonly registry: Registry;
  readonly config: Config;
  /** Defaults to the real exec runner. Tests pass the fake from exec-fake.ts. */
  readonly exec?: ExecRunner;
  /** Defaults to globalThis.fetch, looked up at call time. */
  readonly fetchImpl?: FetchLike;
  /** Wait before the one retry after a timeout. Defaults to RETRY_BACKOFF_MS. */
  readonly backoffMs?: number;
};

export type QuickwitConnector = {
  search(ctx: ConnectorContext, entity: Entity, input: QuickwitSearchInput, requestWindow: TimeWindow): Promise<QuickwitSearchOutcome>;
};

export const RETRY_BACKOFF_MS = 500;

/**
 * window_note when the entity's log source takes a start time only (Q28).
 * It says what happened without naming the transport, which stays out of data.
 */
export const START_ONLY_WINDOW_NOTE = 'upper bound dropped: this log source takes a start time only, so results run up to now';

type Resolved =
  | { readonly transport: 'qw'; readonly index: string; readonly maxConcurrency: number; readonly context: string; readonly targetEnv: string }
  | {
      readonly transport: 'http';
      readonly index: string;
      readonly maxConcurrency: number;
      readonly url: string;
      readonly auth: 'none' | 'bearer';
      readonly token?: string;
      readonly targetEnv: string;
      readonly names: { readonly url: string; readonly auth: string; readonly token?: string };
    };

function notConfigured(entity: Entity, reason: string): ConnectorError {
  return new ConnectorError('not_configured', `not configured for ${entity}:logs (${reason})`);
}

/** Reads the entity's transport from the registry, or throws not_configured. */
export function resolveQuickwit(registry: Registry, entity: Entity): Resolved {
  let cap: ReturnType<Registry['quickwit']>;
  let spec: ReturnType<Registry['spec']>['quickwit'];
  try {
    cap = registry.quickwit(entity);
    spec = registry.spec(entity).quickwit;
  } catch (err) {
    if (err instanceof RegistryError) throw notConfigured(entity, err.keys.join(', '));
    throw err;
  }
  if (cap.status !== 'ok') throw notConfigured(entity, cap.reason);
  if (cap.index.trim() === '') throw notConfigured(entity, `${spec.index} is blank`);
  if (cap.transport === 'qw') {
    const contextEnv = spec.qw?.context ?? spec.transport;
    if (cap.context.trim() === '') throw notConfigured(entity, `${contextEnv} is blank`);
    return { transport: 'qw', index: cap.index, maxConcurrency: cap.maxConcurrency, context: cap.context.trim(), targetEnv: contextEnv };
  }
  const h = spec.http;
  if (h === undefined) throw notConfigured(entity, 'the registry has no quickwit.http block');
  const url = cap.url;
  if (url.trim() === '') throw notConfigured(entity, `${h.url} is blank`);
  const token = cap.token;
  if (cap.auth === 'bearer' && (token === undefined || token.trim() === '')) {
    throw notConfigured(entity, `${h.token ?? 'the token key'} is blank and ${h.auth} is bearer`);
  }
  return {
    transport: 'http',
    index: cap.index,
    maxConcurrency: cap.maxConcurrency,
    url: url.trim(),
    auth: cap.auth,
    ...(cap.auth === 'bearer' && token !== undefined ? { token } : {}),
    targetEnv: h.url,
    names: { url: h.url, auth: h.auth, ...(h.token !== undefined ? { token: h.token } : {}) },
  };
}

/**
 * The fixture key facts for a call. It holds what the call is about and
 * nothing about how it is sent: no transport, index, URL or context.
 */
export function logsKeyInput(cfg: QuickwitGateConfig, input: LogsQueryInput, mode: LogsSearchFacts['mode'], groupBy?: string): LogsSearchFacts {
  const terms: string[] = [...(input.terms ?? []).map((t) => t.trim())];
  if (input.message !== undefined) terms.push(`message:${input.message.trim()}`);
  if (input.error !== undefined) terms.push(`error:${input.error.trim()}`);
  for (const [name, value] of Object.entries(input.fields ?? {})) terms.push(`${name}:${value.trim()}`);
  if (input.level !== undefined) terms.push(`level:${input.level.toLowerCase()}`);
  return {
    entity: cfg.entity,
    service: registryServiceName(cfg, input.service),
    terms,
    mode,
    ...(groupBy !== undefined ? { group_by: groupBy } : {}),
  };
}

// The model may pass the name a service logs under; the key always uses the registry name.
function registryServiceName(cfg: QuickwitGateConfig, name: string): string {
  if (Object.hasOwn(cfg.services, name)) return name;
  const found = Object.entries(cfg.services).find(([, logName]) => logName === name);
  return found === undefined ? name : found[0];
}

function fieldValue(hit: LogHit, field: string): unknown {
  if (Object.hasOwn(hit, field)) return hit[field];
  if (!field.includes('.')) return undefined;
  let cur: unknown = hit;
  for (const part of field.split('.')) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Keeps only the allowlisted fields, in allowlist order, so both transports give the same hit. */
export function projectHit(hit: LogHit, fields: readonly string[]): LogHit {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const value = fieldValue(hit, f);
    if (value !== undefined) out[f] = value;
  }
  return Object.freeze(out);
}

function shapeData(
  result: TransportResult,
  fields: readonly string[],
  window: TimeWindow,
  windowNote: string | undefined,
  notes: readonly string[],
): LogsSearchData {
  const common = {
    num_hits: result.num_hits,
    window,
    ...(windowNote !== undefined ? { window_note: windowNote } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
  if (result.kind === 'count') return { count: result.num_hits, ...common, truncated: false };
  if (result.kind === 'groups') return { groups: result.groups, ...common, truncated: result.truncated };
  const hits = result.hits.map((h) => projectHit(h, fields));
  return { hits, ...common, truncated: result.num_hits > hits.length };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal.throwIfAborted();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createQuickwitConnector(deps: QuickwitConnectorDeps): QuickwitConnector {
  const { registry, config } = deps;
  const backoffMs = deps.backoffMs ?? RETRY_BACKOFF_MS;
  let exec = deps.exec;
  const execRunner = (): ExecRunner => (exec ??= createExecRunner());
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function search(
    ctx: ConnectorContext,
    entity: Entity,
    input: QuickwitSearchInput,
    requestWindow: TimeWindow,
  ): Promise<QuickwitSearchOutcome> {
    ctx.signal.throwIfAborted();
    const target = resolveQuickwit(registry, entity);
    const cfg = quickwitGateConfig(registry, entity);
    if (cfg === undefined) throw notConfigured(entity, 'quickwit is disabled');

    const q = buildLogsQuery(cfg, input);
    if (!q.ok) throw new ConnectorError('refused', q.reason);
    const now = ctx.now();
    const w = resolveWindow(input.from, input.to, requestWindow, now);
    if (!w.ok) throw new ConnectorError('refused', w.reason);
    const window = w.window;
    const since = target.transport === 'qw' ? toSince(window, now) : undefined;
    const windowNote = since?.window_note !== undefined ? START_ONLY_WINDOW_NOTE : undefined;
    const timeoutMs = config.budgets.httpTimeoutMs;

    const runOnce = (signal: AbortSignal): Promise<TransportResult> => {
      if (target.transport === 'qw') {
        return qwSearch(execRunner(), {
          bin: config.code.qwBin,
          context: target.context,
          index: target.index,
          query: q.query,
          mode: q.mode,
          fields: q.fields,
          maxHits: q.maxHits,
          ...(q.groupBy !== undefined ? { groupBy: q.groupBy } : {}),
          since: (since as { since: string }).since,
          timeoutMs,
          signal,
        });
      }
      return httpSearch(
        fetchImpl,
        {
          url: target.url,
          auth: target.auth,
          ...(target.token !== undefined ? { token: target.token } : {}),
          index: target.index,
          query: q.query,
          mode: q.mode,
          maxHits: q.maxHits,
          ...(q.groupBy !== undefined ? { groupBy: q.groupBy } : {}),
          window,
          timeoutMs,
          signal,
        },
        target.names,
      );
    };

    let attempts = 0;
    let startedAt: string | undefined;
    const real = (signal: AbortSignal) =>
      quickwitSlot(entity, target.maxConcurrency).run(async () => {
        startedAt = ctx.now().toISOString();
        for (;;) {
          attempts += 1;
          try {
            const result = await runOnce(signal);
            const data = shapeData(result, q.fields, window, windowNote, q.notes);
            return { data, ...(data.truncated ? { truncated: true } : {}) };
          } catch (err) {
            if (attempts === 1 && isConnectorError(err, 'timeout') && !signal.aborted) {
              await sleep(backoffMs, signal);
              continue;
            }
            throw err;
          }
        }
      }, signal);

    const keyInput = logsKeyInput(cfg, input, q.mode, q.groupBy);
    const outcome = await withMock(ctx, 'logs_search', keyInput, real, { target_env: target.targetEnv });

    let data = outcome.data;
    if (outcome.transport === 'mock' && data !== null && typeof data === 'object') {
      // A fixture's window is the one it was recorded with; the caller needs this call's window.
      const { window_note: _dropped, ...rest } = data as LogsSearchData & { window_note?: string };
      data = { ...rest, window, ...(windowNote !== undefined ? { window_note: windowNote } : {}) } as LogsSearchData;
    }
    const meta: QuickwitMeta = Object.freeze({
      quickwit_transport: target.transport,
      started_at: startedAt ?? outcome.taken_at,
      attempts,
    });
    return Object.freeze({ ...outcome, data, meta }) as QuickwitSearchOutcome;
  }

  return Object.freeze({ search });
}
