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
// 4. A real call is one or more transport requests (D76):
//    - count: one count;
//    - search: one page of hits. On http the page carries num_hits. On qw a
//      count runs first, because qw's JSON may not carry num_hits and qw
//      sorts newest first only, so an "oldest" page is read from the far end
//      of the newest-first order and reversed;
//    - group_by and count_distinct: a count, then pages of 250 hits projected
//      to the tally fields, tallied here. Exact, needs no fast fields, and
//      the same on Quickwit 0.8 and 0.9. http sends no projection, so a page
//      that passes the response cap is halved, down to MIN_TALLY_PAGE;
//    - after a 0-hit result with a service filter, one count of that service
//      alone in the same window, so a wrong service name is flagged.
//    Over HIT_LIMIT hits a search or tally stops after the first request and
//    returns no hits and the reason. Each request holds the entity's slot
//    from quickwitSlot() on its own, retry included, and the signal is
//    checked between requests, so a long tally does not keep other calls
//    waiting for its whole length. This is the only place the cap is held. A
//    timeout is retried once after a backoff; nothing else is retried.
//
// The data shape is the same for both transports. The transport kind goes
// only in meta, for the audit line. No run_id is sent to qw (Q29): infra's
// qw_audit and ours correlate by meta.started_at.
import type { Config } from '../../config/env.ts';
import { RegistryError, type Registry } from '../../config/registry.ts';
import { sleep } from '../../db/pg-retry.ts';
import {
  buildLogsQuery,
  escapeTerm,
  HIT_LIMIT,
  PAGE_SIZE,
  quickwitGateConfig,
  type LogsOrder,
  type LogsQuery,
  type LogsQueryInput,
  type LogsQueryMode,
  type QuickwitGateConfig,
} from '../../gate/quickwit.ts';
import { resolveWindow } from '../../gate/quickwit-window.ts';
import { quickwitSlot } from '../../gate/semaphore.ts';
import type { LogsSearchFacts } from '../../mock/key.ts';
import type { Entity, TimeWindow } from '../../types/core.ts';
import { createExecRunner, type ExecRunner } from '../exec.ts';
import { withMock } from '../mock.ts';
import {
  ConnectorError,
  isConnectorError,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_HTTP_BODY_BYTES,
  type ConnectorContext,
  type ConnectorOutcome,
} from '../types.ts';
import { httpSearch, type FetchLike } from './http-transport.ts';
import { qwSearch } from './qw-transport.ts';

export type QuickwitTransportKind = 'qw' | 'http';

export type LogHit = Readonly<Record<string, unknown>>;
export type LogGroup = { readonly key: string; readonly count: number };

export type DistinctCount = { readonly field: string; readonly count: number };

/** What one transport request hands back before the client shapes it. */
export type TransportResult =
  | { readonly kind: 'hits'; readonly hits: readonly LogHit[]; readonly num_hits: number }
  | { readonly kind: 'count'; readonly num_hits: number };

type DataCommon = {
  readonly num_hits: number;
  readonly window: TimeWindow;
  readonly truncated: boolean;
  /** Notes from the query builder, such as a clamped max_hits. */
  readonly notes?: readonly string[];
  /** Set when the call stopped early: more than HIT_LIMIT hits. */
  readonly reason?: string;
  /** Set on a 0-hit result with a service filter when that service has no lines at all in the window. */
  readonly service_absent?: boolean;
};

/** The one data shape logs_search gets, whichever transport ran. */
export type LogsSearchData =
  | (DataCommon & {
      readonly hits: readonly LogHit[];
      /** Index of the page's first hit. */
      readonly offset: number;
      /** Where the next page starts; absent on the last page. */
      readonly next_offset?: number;
    })
  | (DataCommon & { readonly count: number })
  | (DataCommon & {
      /** With group_by: one group per tuple of values, largest first. */
      readonly groups?: readonly LogGroup[];
      /** With count_distinct. */
      readonly distinct?: DistinctCount;
      /** The hits the groups and distinct count were counted over. */
      readonly tally_base: number;
    });

/** For the audit line only. Never part of data. */
export type QuickwitMeta = {
  readonly quickwit_transport: QuickwitTransportKind;
  /** When the call started. Used to line up with infra's qw_audit (Q29). */
  readonly started_at: string;
  /** Transport requests made, retries included: 0 in mock mode. */
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

/** The smallest tally page: a page over the response cap is halved down to this. */
export const MIN_TALLY_PAGE = 50;

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
export function logsKeyInput(
  cfg: QuickwitGateConfig,
  input: LogsQueryInput,
  mode: LogsSearchFacts['mode'],
  groupBy?: readonly string[],
): LogsSearchFacts {
  const terms: string[] = [...(input.terms ?? []).map((t) => t.trim())];
  if (input.message !== undefined) terms.push(`message:${input.message.trim()}`);
  if (input.error !== undefined) terms.push(`error:${input.error.trim()}`);
  for (const [name, value] of Object.entries(input.fields ?? {})) terms.push(`${name}:${value.trim()}`);
  if (input.level !== undefined) terms.push(`level:${input.level.toLowerCase()}`);
  // The D76 inputs join the key only when set, so older fixtures keep their keys.
  for (const x of input.exclude ?? []) terms.push(`exclude:${x.trim()}`);
  if (input.any_of !== undefined) terms.push(`any_of:${JSON.stringify(input.any_of)}`);
  if (input.contains !== undefined) terms.push(`contains:${input.contains.trim()}`);
  if (input.denoise !== undefined) terms.push(`denoise:${input.denoise}`);
  if (input.count_distinct !== undefined) terms.push(`count_distinct:${input.count_distinct}`);
  if (input.columns !== undefined && input.columns.length > 0) terms.push(`columns:${input.columns.join(',')}`);
  if (input.raw === true) terms.push('raw:true');
  if (input.order === 'oldest') terms.push('order:oldest');
  if (input.offset !== undefined && input.offset > 0) terms.push(`offset:${input.offset}`);
  return {
    entity: cfg.entity,
    ...(input.service !== undefined ? { service: registryServiceName(cfg, input.service) } : {}),
    terms,
    mode,
    ...(groupBy !== undefined ? { group_by: groupBy.join(',') } : {}),
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

/** Where the next page starts, or undefined on the last page. */
export function nextOffset(offset: number, returned: number, numHits: number): number | undefined {
  const next = offset + returned;
  return returned > 0 && next < numHits && next < HIT_LIMIT ? next : undefined;
}

/** The early-return reason for a query over HIT_LIMIT hits (D76). The model reads it as an ordinary result. */
export function overLimitReason(numHits: number, window: TimeWindow, mode: LogsQueryMode): string {
  const what = mode === 'histogram' ? 'group_by and count_distinct tally' : 'a search pages through';
  const next = mode === 'histogram' ? 'count gives the total with no limit' : 'or use count or group_by first';
  return (
    `${numHits.toLocaleString('en-US')} hits for this query in ${window.from}..${window.to} (UTC), over the ` +
    `${HIT_LIMIT.toLocaleString('en-US')} hits ${what}. No hits were read. Narrow the window, add an id or field filter, ${next}.`
  );
}

/** Group key for a hit without a group_by field. */
export const MISSING_VALUE = '(none)';

function valueText(value: unknown): string {
  if (value === undefined || value === null) return MISSING_VALUE;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Counts hits per tuple of field values, largest group first; ties sort by
 * key. The key is the values joined with ' | ' in field order, and a missing
 * value is MISSING_VALUE, so the counts add up to the hits tallied.
 */
export function tallyGroups(hits: readonly LogHit[], fields: readonly string[]): LogGroup[] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    const key = fields.map((f) => valueText(fieldValue(hit, f))).join(' | ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Number of distinct values of one field; hits without it are not counted. */
export function countDistinct(hits: readonly LogHit[], field: string): number {
  const seen = new Set<string>();
  for (const hit of hits) {
    const value = fieldValue(hit, field);
    if (value !== undefined && value !== null) seen.add(valueText(value));
  }
  return seen.size;
}

function timeOf(hit: LogHit): number | undefined {
  const t = hit.timestamp;
  if (typeof t === 'number') return t;
  if (typeof t !== 'string') return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Sorts a page by timestamp in the asked order when every hit has one; otherwise keeps the order given. */
export function orderHits(hits: readonly LogHit[], order: LogsOrder): LogHit[] {
  const out = [...hits];
  if (!out.every((h) => timeOf(h) !== undefined)) return out;
  const sign = order === 'oldest' ? 1 : -1;
  return out.sort((a, b) => sign * ((timeOf(a) as number) - (timeOf(b) as number)));
}

/** A whole document. Quickwit 0.8 echoes every field again under _source; the copy is dropped. */
function wholeHit(hit: LogHit): LogHit {
  const { _source: source, ...flat } = hit;
  if (Object.keys(flat).length > 0 || typeof source !== 'object' || source === null) return Object.freeze(flat);
  return Object.freeze({ ...(source as Record<string, unknown>) });
}

type PageRequest = {
  readonly offset: number;
  readonly size: number;
  readonly order: LogsOrder;
  /** Absent for whole documents. */
  readonly fields?: readonly string[];
};

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
    const w = resolveWindow(input.from, input.to, requestWindow, ctx.now());
    if (!w.ok) throw new ConnectorError('refused', w.reason);
    // Fixed when the call starts, so new lines do not move the offsets between pages.
    const window = w.window;
    const timeoutMs = config.budgets.httpTimeoutMs;
    const pageSize = Math.min(PAGE_SIZE, cfg.maxHits);

    // One transport request: a count, or one page.
    const send = (page: PageRequest | undefined, signal: AbortSignal, query: string): Promise<TransportResult> => {
      const mode: 'count' | 'search' = page === undefined ? 'count' : 'search';
      const req = { index: target.index, query, mode, maxHits: page?.size ?? 0, offset: page?.offset ?? 0, window, timeoutMs, signal };
      if (target.transport === 'qw') {
        const fields = page?.fields !== undefined ? { fields: page.fields } : {};
        return qwSearch(execRunner(), { bin: config.code.qwBin, context: target.context, ...req, ...fields });
      }
      const token = target.token !== undefined ? { token: target.token } : {};
      return httpSearch(fetchImpl, { url: target.url, auth: target.auth, ...token, ...req, order: page?.order ?? 'newest' }, target.names);
    };

    let attempts = 0;
    let startedAt: string | undefined;

    // Holds the slot for this one request only, retry included.
    const request = (page: PageRequest | undefined, signal: AbortSignal, query: string = q.query): Promise<TransportResult> => {
      signal.throwIfAborted();
      return quickwitSlot(entity, target.maxConcurrency).run(async () => {
        startedAt ??= ctx.now().toISOString();
        for (let tries = 1; ; tries++) {
          attempts += 1;
          try {
            return await send(page, signal, query);
          } catch (err) {
            if (tries === 1 && isConnectorError(err, 'timeout') && !signal.aborted) {
              await sleep(backoffMs, signal);
              continue;
            }
            throw err;
          }
        }
      }, signal);
    };
    const count = async (signal: AbortSignal, query?: string): Promise<number> => (await request(undefined, signal, query)).num_hits;
    const hitsOf = async (page: PageRequest, signal: AbortSignal): Promise<TransportResult & { kind: 'hits' }> => {
      const r = await request(page, signal);
      if (r.kind !== 'hits') throw new ConnectorError('unreachable', 'the log source answered a page request with a count');
      return r;
    };

    const common = { window, ...(q.notes.length > 0 ? { notes: q.notes } : {}) };
    const overLimit = (n: number) => ({ num_hits: n, ...common, reason: overLimitReason(n, window, q.mode), truncated: true });

    const searchPage = async (signal: AbortSignal): Promise<LogsSearchData> => {
      const projection = q.raw ? {} : { fields: q.fields };
      let numHits: number;
      let hits: readonly LogHit[];
      if (target.transport === 'http') {
        const r = await hitsOf({ offset: q.offset, size: q.maxHits, order: q.order, ...projection }, signal);
        numHits = r.num_hits;
        hits = r.hits;
      } else {
        numHits = await count(signal);
        hits = [];
        if (numHits <= HIT_LIMIT && q.offset < numHits) {
          // qw sorts newest first only: the oldest page N is the newest-first slice at the far end.
          const size = q.order === 'oldest' ? Math.min(q.maxHits, numHits - q.offset) : q.maxHits;
          const offset = q.order === 'oldest' ? numHits - q.offset - size : q.offset;
          const r = await hitsOf({ offset, size, order: 'newest', ...projection }, signal);
          hits = q.order === 'oldest' ? [...r.hits].reverse() : r.hits;
        }
      }
      if (numHits > HIT_LIMIT) return { hits: [], offset: q.offset, ...overLimit(numHits) };
      const page = orderHits(
        hits.map((h) => (q.raw ? wholeHit(h) : projectHit(h, q.fields))),
        q.order,
      );
      const next = nextOffset(q.offset, page.length, numHits);
      return {
        hits: page,
        offset: q.offset,
        ...(next !== undefined ? { next_offset: next } : {}),
        num_hits: numHits,
        ...common,
        truncated: numHits > page.length,
      };
    };

    const tally = async (signal: AbortSignal): Promise<LogsSearchData> => {
      const numHits = await count(signal);
      if (numHits > HIT_LIMIT) return { ...(q.groupBy !== undefined ? { groups: [] } : {}), tally_base: 0, ...overLimit(numHits) };
      const fields = [...new Set([...(q.groupBy ?? []), ...(q.countDistinct !== undefined ? [q.countDistinct] : [])])];
      const hits: LogHit[] = [];
      let size = pageSize;
      // Serial pages, newest first; a short page is the end even if new lines arrived.
      for (let offset = 0; offset < numHits; ) {
        let r: TransportResult & { kind: 'hits' };
        try {
          r = await hitsOf({ offset, size, order: 'newest', fields }, signal);
        } catch (err) {
          // http sends no projection, so a page of whole documents can pass the cap: halve it and try again.
          if (!isConnectorError(err, 'cap_exceeded')) throw err;
          if (size <= MIN_TALLY_PAGE) throw tallyCapError(offset, size, numHits);
          size = Math.max(MIN_TALLY_PAGE, Math.floor(size / 2));
          continue;
        }
        hits.push(...r.hits);
        if (r.hits.length < size) break;
        offset += size;
      }
      return {
        ...(q.groupBy !== undefined ? { groups: tallyGroups(hits, q.groupBy) } : {}),
        ...(q.countDistinct !== undefined ? { distinct: { field: q.countDistinct, count: countDistinct(hits, q.countDistinct) } } : {}),
        tally_base: hits.length,
        num_hits: numHits,
        ...common,
        truncated: false,
      };
    };

    const tallyCapError = (offset: number, size: number, numHits: number): ConnectorError => {
      const cap = target.transport === 'http' ? MAX_HTTP_BODY_BYTES : MAX_EXEC_OUTPUT_BYTES;
      return new ConnectorError(
        'cap_exceeded',
        `a page of ${size} hits (hits ${offset + 1} to ${Math.min(offset + size, numHits)} of ${numHits}) passed the ${cap} byte response cap ` +
          `while tallying group_by or count_distinct, even at ${MIN_TALLY_PAGE} hits a page. Narrow the window or add a filter so fewer ` +
          'hits are tallied, or use count, which reads no documents.',
      );
    };

    // After a 0-hit result with a service filter: does the service log anything in this window?
    const serviceAbsent = async (total: number, signal: AbortSignal): Promise<boolean> => {
      if (total !== 0 || q.service === undefined) return false;
      return (await count(signal, `service:${escapeTerm(q.service)}`)) === 0;
    };

    const real = async (signal: AbortSignal) => {
      let data: LogsSearchData;
      if (q.mode === 'count') {
        const n = await count(signal);
        data = { count: n, num_hits: n, ...common, truncated: false };
      } else {
        data = q.mode === 'search' ? await searchPage(signal) : await tally(signal);
      }
      if (await serviceAbsent(data.num_hits, signal)) data = { ...data, service_absent: true };
      return { data, ...(data.truncated ? { truncated: true } : {}) };
    };

    const keyInput = logsKeyInput(cfg, input, q.mode, q.groupBy);
    const outcome = await withMock(ctx, 'logs_search', keyInput, real, { target_env: target.targetEnv });

    let data = outcome.data;
    if (outcome.transport === 'mock' && data !== null && typeof data === 'object') {
      // A fixture's window is the one it was recorded with; the caller needs this call's window.
      const { window_note: _dropped, ...rest } = data as LogsSearchData & { window_note?: string };
      data = { ...rest, window } as LogsSearchData;
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
