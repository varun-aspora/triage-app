// logs_search: one typed Quickwit query for the investigator's entity (HLD 02
// §2 and §3, D26, D44, Q27-Q29).
//
// The model gives the query as typed fields. It never sees or picks the
// transport, index or entity: the entity comes from the closure and the
// transport (qw or http) from the registry and .env. Every call goes through
// runIoTool:
//
//   budget -> scope (id-shaped terms; systemic only with count or group_by,
//   ids still checked; correlation ids seen in an earlier result, D76, D77)
//   -> gate (buildLogsQuery and resolveWindow from src/gate) -> not configured
//   -> fixture (transport-neutral key) or the Quickwit connector -> envelope
//
// This tool holds no limiter. The connector takes the entity's slot from
// quickwitSlot() for each request it sends, so the per-entity cap
// (<ENTITY>_QUICKWIT_MAX_CONCURRENCY, default 1) is enforced in one place.
//
// The window defaults to the request window, both ends are always sent, and
// it is returned with the query that was built (D76).

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import {
  logsKeyInput,
  nextOffset,
  overLimitReason,
  resolveQuickwit,
  type DistinctCount,
  type LogGroup,
  type LogHit,
  type LogsSearchData,
  type QuickwitConnector,
  type QuickwitSearchInput,
  type QuickwitTransportKind,
} from '../connectors/quickwit/client.ts';
import { ConnectorError, isConnectorError, type ConnectorContext } from '../connectors/types.ts';
import {
  buildLogsQuery,
  HIT_LIMIT,
  normalizeMessage,
  PAGE_SIZE,
  quickwitGateConfig,
  type LogsQuery,
  type QuickwitGateConfig,
} from '../gate/quickwit.ts';
import { resolveWindow } from '../gate/quickwit-window.ts';
import { observeCorrelationIds, observedCorrelationIds, type LogsMode } from '../gate/scope.ts';
import { semanticKey } from '../mock/key.ts';
import type { Entity, TimeWindow } from '../types/core.ts';
import type { ToolEnvelope } from '../types/tool-result.ts';
import { type GateDecision, runIoTool, type BackingRef, type StagingHarness } from './_lib/pipeline.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

declare module './_lib/context.ts' {
  interface ToolConnectors {
    /** Built by createQuickwitConnector(). Needed only in real mode. */
    readonly quickwit?: QuickwitConnector;
  }
}

export const LOGS_SEARCH = 'logs_search';

/** The service name on audit lines and in "not configured for <entity>:logs". */
export const LOGS_SERVICE = 'logs';

const DAY_MS = 24 * 60 * 60 * 1000;

const Text = v.pipe(v.string(), v.minLength(1), v.maxLength(512));
const FieldName = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const TextList = v.pipe(v.array(Text), v.maxLength(20));

/** One OR group: its values are ORed, the groups are ANDed with the rest. */
const AnyOfGroup = v.strictObject({
  level: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(16))), v.maxLength(20), v.description('Levels, such as ["error", "warn"].'))),
  message: v.optional(v.pipe(TextList, v.description('Message labels.'))),
  terms: v.optional(v.pipe(TextList, v.description('Terms, such as several id tokens.'))),
  service: v.optional(v.pipe(v.array(FieldName), v.maxLength(20), v.description('Registry service names.'))),
});

/** The model-facing input. No transport, index, entity or run_id (D3, D44). */
export const LogsSearchInputSchema = v.strictObject({
  service: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(64),
      v.description('Registry service name, such as harbor (the name it logs under also works). Leave it out to search every service.'),
    ),
  ),
  terms: v.optional(
    v.pipe(
      TextList,
      v.description(
        'Values that must all appear anywhere in the line, such as an id from the brief. A value with a space or a dash is sent whole in single quotes.',
      ),
    ),
  ),
  message: v.optional(v.pipe(Text, v.description('The exact log label from the code, such as "Api execution completed".'))),
  error: v.optional(v.pipe(Text, v.description('Words that must all appear in the error field (the text users quote).'))),
  fields: v.optional(
    v.pipe(
      v.record(FieldName, Text),
      v.description('Exact field filters, name to value, such as {"x-device-id": "..."}. A numeric range is written "[400 TO 599]".'),
    ),
  ),
  any_of: v.optional(
    v.pipe(
      v.array(AnyOfGroup),
      v.maxLength(5),
      v.description('OR groups: each group matches when any of its values does; every group must match.'),
    ),
  ),
  exclude: v.optional(v.pipe(TextList, v.description('Values that must not appear in the line.'))),
  contains: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.description('One word with no spaces, matched as a substring of raw_message.'))),
  level: v.optional(v.pipe(v.string(), v.maxLength(16), v.description('Log level, such as error or warn.'))),
  denoise: v.optional(
    v.pipe(
      v.picklist(['with_message', 'only']),
      v.description('SSFB only. Drops kong, kafka and "Api execution completed" lines unless they are errors. "with_message" keeps the message\'s own lines.'),
    ),
  ),
  from: v.optional(v.pipe(v.string(), v.maxLength(40), v.description('Window start: ISO date or time (UTC), or a duration ago such as 6h or 2d.'))),
  to: v.optional(v.pipe(v.string(), v.maxLength(40), v.description('Window end: ISO date or time (UTC), or a duration ago. Defaults to now.'))),
  order: v.optional(v.pipe(v.picklist(['newest', 'oldest']), v.description('Hit order. Default newest.'))),
  offset: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.description('First hit of the page, for the next page: the next_offset of the last result.')),
  ),
  max_hits: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Most hits to return. Clamped to the page size.')),
  ),
  columns: v.optional(v.pipe(v.array(FieldName), v.maxLength(10), v.description('Extra fields to show in each hit, such as status or User-Agent.'))),
  raw: v.optional(v.pipe(v.boolean(), v.description('Return whole log documents instead of the listed fields.'))),
  count: v.optional(v.pipe(v.boolean(), v.description('Return the number of matching lines only.'))),
  group_by: v.optional(
    v.pipe(
      v.array(FieldName),
      v.minLength(1),
      v.maxLength(4),
      v.description('1 to 4 fields to group by, such as ["service"] or ["message", "error"]. Returns counts per value.'),
    ),
  ),
  count_distinct: v.optional(v.pipe(FieldName, v.description('Field whose distinct values are counted, such as customer_id.'))),
  normalize: v.optional(
    v.pipe(v.boolean(), v.description('Fold messages that differ only by ids and numbers into one group.')),
  ),
  scope: v.optional(
    v.pipe(v.literal('systemic'), v.description('For counts across customers. Allowed only with count, group_by or count_distinct; ids are still checked.')),
  ),
});
export type LogsSearchInput = v.InferOutput<typeof LogsSearchInputSchema>;

/** What the model gets back in data. */
export type LogsSearchOutput = LogsSearchData & {
  /** The Quickwit query that was built for this call. */
  readonly query: string;
  /** With normalize on a hits search: the hits folded by normalised error or message. */
  readonly message_groups?: readonly LogGroup[];
};

function description(ctx: ToolContext, entity: Entity): string {
  let cfg: QuickwitGateConfig | undefined;
  try {
    cfg = quickwitGateConfig(ctx.registry, entity);
  } catch {
    // A registry that cannot answer leaves the lists out; run() reports not configured.
  }
  const { defaultLookbackDays, maxLogCallsPerRun } = ctx.config.budgets;
  const pageSize = Math.min(PAGE_SIZE, cfg?.maxHits ?? PAGE_SIZE);
  const limit = HIT_LIMIT.toLocaleString('en-US');
  const lines = [
    `Search the ${entity} service logs (Quickwit).`,
    'Give at least one of terms, fields, message, error, contains or an any_of group of messages or terms; ' +
      'service, level and exclude narrow a query but are not enough on their own. Leave service out to search every service.',
    'terms, exclude and any_of values with a space or a dash are sent whole in single quotes; a single quote inside a value is refused. ' +
      'message is the exact label from the code. error ANDs its words on the error field. contains is one word matched inside raw_message. ' +
      'fields are exact filters by name.' +
      (entity === 'ssfb' ? ' denoise drops kong, kafka and access-log noise.' : ' On this entity a UUID goes in terms, never in fields.'),
    `Each call returns one page of ${pageSize} hits, newest first (order: "oldest" to reverse), with num_hits and next_offset when more remain; ` +
      'pass offset for the next page. The tool never fetches the next page itself.',
    'Every query sends both ends of its window: without from/to it is the request window ' +
      `(${defaultLookbackDays} days before the thread's first message up to when the request came in), and the window used is returned. Times are UTC.`,
    `Over ${limit} hits the call returns early with the count and no hits: narrow the window or add a filter, or use count or group_by first. ` +
      `group_by (up to 4 fields) and count_distinct tally at most ${limit} hits. At most ${maxLogCallsPerRun} logs_search calls per run.`,
    'Id-shaped values must come from the brief or the ID chain. ' +
      'For counts across customers set scope: "systemic" together with count, group_by or count_distinct; ids are still checked.',
    'Returns hits (the listed fields plus columns, or whole documents with raw) with offset and next_offset, a count, or groups ' +
      '(key is the group_by values joined with " | ") and distinct with tally_base, plus num_hits, window, the query sent, truncated and notes. ' +
      'The full result is also written to /data/<call id>.json in the sandbox. A 0-hit result says what to try next.',
    '"Refused" means the query was not run or Quickwit rejected it: fix what the message says and retry. ' +
      '"did not answer" carries the reason: retry once or narrow the window. "not configured" means logs are not set up ' +
      `for ${entity}: record the gap and use another source.`,
  ];
  if (cfg !== undefined) {
    const services = Object.entries(cfg.services)
      .filter(([, logName]) => logName !== undefined)
      .map(([name]) => name);
    if (services.length > 0) lines.push(`Services: ${services.join(', ')}.`);
    lines.push(`Fields: ${cfg.fields.join(', ')}.`);
  }
  return lines.join(' ');
}

/** count, group_by and count_distinct are the only modes a systemic call may use. */
export function logsModeOf(input: Pick<LogsSearchInput, 'count' | 'group_by' | 'count_distinct'>): LogsMode {
  if (input.group_by !== undefined || input.count_distinct !== undefined) return 'group_by';
  if (input.count === true) return 'count';
  return 'search';
}

/** The part of the input the query builder and the connector read. */
function queryInputOf(data: LogsSearchInput): QuickwitSearchInput {
  const { normalize: _n, scope: _s, ...rest } = data;
  return rest;
}

/**
 * The next-step note on a 0-hit result, in the order the old investigations
 * followed (D76): drop service, group by service, move from earlier, drop level.
 */
export function zeroHitsNote(input: Pick<LogsSearchInput, 'service' | 'group_by' | 'level'>): string {
  const steps = [
    ...(input.service !== undefined ? ['drop the service filter'] : []),
    ...(input.group_by?.includes('service') === true ? [] : ['run group_by: ["service"] for the same terms']),
    'move from earlier',
    ...(input.level !== undefined ? ['drop level'] : []),
  ];
  return `0 hits. Try next, in this order: ${steps.join('; ')}.`;
}

/** The request window from ingress, or the lookback days up to now when the run has none. */
export function requestWindowOf(ctx: ToolContext, now: Date): TimeWindow {
  const window = ctx.deps.run.window;
  if (window !== undefined) return window;
  const days = ctx.config.budgets.defaultLookbackDays;
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to: now.toISOString() };
}

type Target =
  | { readonly configured: true; readonly transport: QuickwitTransportKind; readonly cfg: QuickwitGateConfig; readonly backing: BackingRef }
  | { readonly configured: false; readonly backing: BackingRef };

// Reads the registry only (no I/O). A blank transport, index, context or URL
// becomes a backing ref with status 'blank', and the pipeline answers
// "not configured for <entity>:logs" at its not-configured step.
function targetOf(ctx: ToolContext, entity: Entity): Target {
  const fallbackEnv = `${entity.toUpperCase()}_QUICKWIT_TRANSPORT`;
  try {
    const resolved = resolveQuickwit(ctx.registry, entity);
    const cfg = quickwitGateConfig(ctx.registry, entity);
    if (cfg === undefined) return { configured: false, backing: { envName: fallbackEnv, status: 'blank' } };
    return { configured: true, transport: resolved.transport, cfg, backing: { envName: resolved.targetEnv, status: 'ok' } };
  } catch (err) {
    if (!isConnectorError(err, 'not_configured')) throw err;
    const cap = safeQuickwitCap(ctx, entity);
    const envName = cap !== undefined && cap.status === 'disabled' && cap.envNames[0] !== undefined ? cap.envNames[0] : fallbackEnv;
    return { configured: false, backing: { envName, status: 'blank' } };
  }
}

function safeQuickwitCap(ctx: ToolContext, entity: Entity): ReturnType<ToolContext['registry']['quickwit']> | undefined {
  try {
    return ctx.registry.quickwit(entity);
  } catch {
    return undefined;
  }
}

// The connector's own mock branch is not used: runIoTool already answered
// from the fixture in mock mode, and it records in real mode. This port only
// lets the connector run its real call.
const REAL_ONLY_PORT: ConnectorContext['mock'] = Object.freeze({
  enabled: false,
  strict: true,
  lookup: () => Promise.reject(new Error('logs_search: the connector mock port is not used')),
});

function refusal(reason: string): GateDecision {
  return { ok: false, message: `Refused: ${reason}.`, reason: `logs gate: ${reason}` };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Folds groups whose keys normalise to the same text, largest first. */
export function foldGroups(groups: readonly LogGroup[]): LogGroup[] {
  const counts = new Map<string, number>();
  for (const g of groups) {
    const key = normalizeMessage(String(g.key));
    counts.set(key, (counts.get(key) ?? 0) + g.count);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function messageGroups(hits: readonly LogHit[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (const hit of hits) {
    const text = typeof hit.error === 'string' && hit.error.trim() !== '' ? hit.error : hit.message;
    groups.push({ key: typeof text === 'string' ? text : '', count: 1 });
  }
  return foldGroups(groups);
}

type Shape = {
  readonly query: LogsQuery;
  readonly window: TimeWindow;
  readonly normalize: boolean;
  /** Added to notes when the result has 0 hits. */
  readonly zeroNote: string;
};

// The same shaping for a fixture and a real result: this call's window,
// query, builder notes, hit cap, paging and the over-limit return, so a
// fixture recorded under another window or cap still answers this call
// correctly.
function shape(value: unknown, s: Shape): LogsSearchOutput {
  const src = isObject(value) ? value : {};
  const { window: _w, window_note: _n, notes: _notes, ...rest } = src;
  const absent =
    rest.service_absent === true && s.query.service !== undefined
      ? [
          `service ${s.query.service} has no lines at all in this index in ${s.window.from}..${s.window.to}: the name may be wrong ` +
            'or it logs elsewhere; run group_by: ["service"] without the service filter to see the names that do log',
        ]
      : [];
  const common = (total: number) => {
    const notes = [...s.query.notes, ...(total === 0 ? [s.zeroNote, ...absent] : [])];
    return { query: s.query.query, window: s.window, ...(notes.length > 0 ? { notes } : {}) };
  };
  const numHits = typeof rest.num_hits === 'number' ? rest.num_hits : 0;

  if (s.query.mode === 'count') {
    const count = typeof rest.count === 'number' ? rest.count : numHits;
    return { count, num_hits: typeof rest.num_hits === 'number' ? numHits : count, ...common(count), truncated: false };
  }
  const over = numHits > HIT_LIMIT ? { reason: overLimitReason(numHits, s.window, s.query.mode), truncated: true } : undefined;
  if (s.query.mode === 'histogram') {
    const raw = Array.isArray(rest.groups) ? (rest.groups as LogGroup[]) : [];
    const groups = over !== undefined ? [] : s.normalize ? foldGroups(raw) : raw;
    const distinct = over === undefined && isObject(rest.distinct) ? (rest.distinct as DistinctCount) : undefined;
    return {
      ...(s.query.groupBy !== undefined ? { groups } : {}),
      ...(distinct !== undefined ? { distinct } : {}),
      tally_base: over !== undefined ? 0 : typeof rest.tally_base === 'number' ? rest.tally_base : numHits,
      num_hits: numHits,
      ...common(Math.max(numHits, groups.length)),
      ...(over ?? { truncated: rest.truncated === true }),
    };
  }
  const offset = s.query.offset;
  if (over !== undefined) return { hits: [], offset, num_hits: numHits, ...common(numHits), ...over };
  const all = Array.isArray(rest.hits) ? (rest.hits as LogHit[]) : [];
  const hits = all.slice(0, s.query.maxHits);
  const truncated = rest.truncated === true || hits.length < all.length || numHits > hits.length;
  const total = Math.max(numHits, all.length);
  const next = nextOffset(offset, hits.length, total);
  return {
    hits,
    offset,
    ...(next !== undefined ? { next_offset: next } : {}),
    num_hits: total,
    ...common(total),
    truncated,
    ...(s.normalize ? { message_groups: messageGroups(hits) } : {}),
  };
}

function summaryOf(entity: Entity, service: string | undefined, out: LogsSearchOutput, transport: QuickwitTransportKind | undefined): string {
  const via = transport === undefined ? '' : ` via ${transport}`;
  const target = `${entity}:${service ?? 'all services'}`;
  if ('count' in out) return `logs_search ${target} count ${out.count}${via}`;
  if ('hits' in out) return `logs_search ${target} ${out.hits.length} of ${out.num_hits} hits${via}`;
  const distinct = out.distinct !== undefined ? `, ${out.distinct.count} distinct ${out.distinct.field}` : '';
  return `logs_search ${target} ${out.groups?.length ?? 0} groups${distinct} over ${out.tally_base} hits${via}`;
}

function observedScope(ctx: ToolContext): { observed?: ReadonlySet<string> } {
  const observed = observedCorrelationIds(ctx.runId);
  return observed !== undefined ? { observed } : {};
}

type RunArgs = {
  readonly data: LogsSearchInput;
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
  readonly log: Parameters<typeof runIoTool>[1]['log'];
  readonly harness?: StagingHarness;
};

async function runLogsSearch(ctx: ToolContext, entity: Entity, args: RunArgs): Promise<ToolEnvelope> {
  const { data } = args;
  const deps = ctx.deps;
  const now = deps.now();
  const requestWindow = requestWindowOf(ctx, now);
  const target = targetOf(ctx, entity);
  const queryInput = queryInputOf(data);
  const normalize = data.normalize === true;

  let query: LogsQuery | undefined;
  let window: TimeWindow | undefined;
  let transportUsed: QuickwitTransportKind | undefined;

  const gate = (): GateDecision => {
    // Not configured is answered at the next step, with its own text.
    if (!target.configured) return { ok: true };
    const q = buildLogsQuery(target.cfg, queryInput);
    if (!q.ok) return refusal(q.reason);
    const w = resolveWindow(data.from, data.to, requestWindow, now);
    if (!w.ok) return refusal(w.reason);
    query = q;
    window = w.window;
    return { ok: true };
  };

  // Called by runIoTool only after the gate passed, so these are set.
  const ready = (): { cfg: QuickwitGateConfig; query: LogsQuery; window: TimeWindow } => {
    if (!target.configured || query === undefined || window === undefined) {
      throw new Error('logs_search: fixture or real call before the gate passed');
    }
    return { cfg: target.cfg, query, window };
  };

  const shapeOf = (value: unknown): LogsSearchOutput => {
    const r = ready();
    return shape(value, { query: r.query, window: r.window, normalize, zeroNote: zeroHitsNote(data) });
  };

  return runIoTool<'logs_search', unknown>(
    {
      tool: LOGS_SEARCH,
      service: LOGS_SERVICE,
      input: data,
      backing: target.backing,
      scope: {
        ...(data.scope === 'systemic' ? { systemic: true } : {}),
        logsMode: logsModeOf(data),
        ...observedScope(ctx),
      },
      gate,
      fixture: () => {
        const r = ready();
        return {
          kind: 'logs_search',
          key: semanticKey('logs_search', logsKeyInput(r.cfg, queryInput, r.query.mode, r.query.groupBy)),
        };
      },
      real: async (signal) => {
        const connector = deps.connectors.quickwit;
        if (connector === undefined) throw new ConnectorError('not_configured', 'the run has no Quickwit connector');
        const connectorCtx: ConnectorContext = {
          signal,
          now: deps.now,
          mock: REAL_ONLY_PORT,
          runId: ctx.runId,
          redactionNames: deps.run.redactionNames,
        };
        const out = await connector.search(connectorCtx, entity, queryInput, requestWindow);
        if (out.fixture_miss === true) throw new ConnectorError('unreachable', 'the Quickwit connector returned no data');
        transportUsed = out.meta.quickwit_transport;
        return out.data;
      },
      render: (value) => {
        const out = shapeOf(value);
        // Correlation ids in these hits may be searched later in the run (D77).
        if ('hits' in out) observeCorrelationIds(ctx.runId, out.hits);
        return out;
      },
      stage: shapeOf,
      summary: (value) => summaryOf(entity, data.service, shapeOf(value), transportUsed),
    },
    {
      toolContext: ctx,
      toolCallId: args.toolCallId,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
      log: args.log,
      ...(args.harness !== undefined ? { harness: args.harness } : {}),
    },
  );
}

/** Builds the logs_search tool for an investigator's entity. */
export function logsSearchTool(ctx: ToolContext): ToolDefinition {
  const entity = ctx.entity;
  if (entity === null) throw new Error('logs_search needs an entity in the tool context');
  return defineTool({
    name: LOGS_SEARCH,
    description: description(ctx, entity),
    input: LogsSearchInputSchema,
    harness: true,
    run: async ({ data, signal, toolCallId, log, harness }): Promise<ToolEnvelope> =>
      runLogsSearch(ctx, entity, {
        data,
        toolCallId,
        ...(signal !== undefined ? { signal } : {}),
        log,
        harness,
      }),
  });
}

export const toolModule: ToolModule = {
  name: LOGS_SEARCH,
  mounts: ['investigator'],
  entities: 'all',
  // Always mounted: a blank Quickwit config answers "not configured" so the
  // investigator records the gap instead of guessing (HLD 02 §1.2).
  enabled: () => ({ on: true }),
  create: (ctx) => logsSearchTool(ctx),
};
