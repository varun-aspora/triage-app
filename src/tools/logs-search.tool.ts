// logs_search: one typed Quickwit query for the investigator's entity (HLD 02
// §2 and §3, D26, D44, Q27-Q29).
//
// The model gives the query as typed fields. It never sees or picks the
// transport, index or entity: the entity comes from the closure and the
// transport (qw or http) from the registry and .env. Every call goes through
// runIoTool:
//
//   budget -> scope (id-shaped terms; systemic only with count or group_by)
//   -> gate (buildLogsQuery and resolveWindow from src/gate) -> not configured
//   -> fixture (transport-neutral key) or the Quickwit connector -> envelope
//
// This tool holds no limiter. The connector takes the entity's slot from
// quickwitSlot() for the whole real call, so the per-entity cap
// (<ENTITY>_QUICKWIT_MAX_CONCURRENCY, default 1) is enforced in one place.
//
// The window defaults to the request window and is always returned. When the
// entity uses the qw transport and the window ends before now, the output
// says the upper bound was dropped (Q28), without naming the transport.

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import {
  logsKeyInput,
  resolveQuickwit,
  START_ONLY_WINDOW_NOTE,
  type LogGroup,
  type LogHit,
  type LogsSearchData,
  type QuickwitConnector,
  type QuickwitSearchInput,
  type QuickwitTransportKind,
} from '../connectors/quickwit/client.ts';
import { ConnectorError, isConnectorError, type ConnectorContext } from '../connectors/types.ts';
import { buildLogsQuery, normalizeMessage, quickwitGateConfig, type LogsQuery, type QuickwitGateConfig } from '../gate/quickwit.ts';
import { resolveWindow, toSince } from '../gate/quickwit-window.ts';
import type { LogsMode } from '../gate/scope.ts';
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

/** The model-facing input. No transport, index, entity or run_id (D3, D44). */
export const LogsSearchInputSchema = v.strictObject({
  service: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.description('Registry service name, such as harbor. The name the service logs under also works.'),
  ),
  message: v.optional(v.pipe(Text, v.description('Phrase to match in the message field.'))),
  error: v.optional(v.pipe(Text, v.description('Words that must all appear in the error field.'))),
  terms: v.optional(
    v.pipe(v.array(Text), v.maxLength(20), v.description('Bare terms, such as an id from the brief. All must match.')),
  ),
  fields: v.optional(
    v.pipe(
      v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(64)), Text),
      v.description('Exact field filters, name to value. Names must be in the entity field list.'),
    ),
  ),
  from: v.optional(v.pipe(v.string(), v.maxLength(40), v.description('Window start: ISO date or time, or a duration such as 6h or 2d.'))),
  to: v.optional(v.pipe(v.string(), v.maxLength(40), v.description('Window end: ISO date or time, or a duration. Defaults to now.'))),
  level: v.optional(v.pipe(v.string(), v.maxLength(16), v.description('Log level, such as error or warn.'))),
  max_hits: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Most hits to return. Clamped to the entity cap.')),
  ),
  group_by: v.optional(v.pipe(v.string(), v.maxLength(64), v.description('Field to group by. Returns counts per value.'))),
  normalize: v.optional(
    v.pipe(v.boolean(), v.description('Fold messages that differ only by ids and numbers into one group.')),
  ),
  count: v.optional(v.pipe(v.boolean(), v.description('Return the number of matching lines only.'))),
  scope: v.optional(
    v.pipe(v.literal('systemic'), v.description('For counts across customers. Allowed only with count or group_by.')),
  ),
});
export type LogsSearchInput = v.InferOutput<typeof LogsSearchInputSchema>;

/** What the model gets back in data. */
export type LogsSearchOutput = LogsSearchData & {
  /** With normalize on a hits search: the hits folded by normalised error or message. */
  readonly message_groups?: readonly LogGroup[];
};

function description(ctx: ToolContext, entity: Entity): string {
  const lines = [
    `Search the ${entity} service logs (Quickwit). Give service plus at least one of message, error, terms or fields; ` +
      'service alone is refused.',
    'Every query has a time window: without from/to it is the request window, and the window used is returned.',
    'Id-shaped terms must come from the brief or the ID chain. For counts across customers set scope: "systemic" ' +
      'together with count or group_by.',
    'Returns hits (only listed fields), a count, or groups with counts, plus num_hits, window, truncated and taken_at. ' +
      'The full result is also written to /data/<call id>.json in the sandbox.',
    '"Refused" means the query was not run or Quickwit rejected it: fix what the message says and retry. ' +
      '"did not answer" carries the reason: retry once or narrow the window. "not configured" means logs are not set up ' +
      `for ${entity}: record the gap and use another source.`,
  ];
  try {
    const cfg = quickwitGateConfig(ctx.registry, entity);
    if (cfg !== undefined) {
      const services = Object.entries(cfg.services)
        .filter(([, logName]) => logName !== undefined)
        .map(([name]) => name);
      if (services.length > 0) lines.push(`Services: ${services.join(', ')}.`);
      lines.push(`Fields: ${cfg.fields.join(', ')}. At most ${cfg.maxHits} hits per call.`);
    }
  } catch {
    // A registry that cannot answer leaves the lists out; run() reports not configured.
  }
  return lines.join(' ');
}

/** count and group_by are the only modes a systemic call may use. */
export function logsModeOf(input: Pick<LogsSearchInput, 'count' | 'group_by'>): LogsMode {
  if (input.group_by !== undefined) return 'group_by';
  if (input.count === true) return 'count';
  return 'search';
}

/** The part of the input the query builder and the connector read. */
function queryInputOf(data: LogsSearchInput): QuickwitSearchInput {
  return {
    service: data.service,
    ...(data.message !== undefined ? { message: data.message } : {}),
    ...(data.error !== undefined ? { error: data.error } : {}),
    ...(data.terms !== undefined ? { terms: data.terms } : {}),
    ...(data.fields !== undefined ? { fields: data.fields } : {}),
    ...(data.level !== undefined ? { level: data.level } : {}),
    ...(data.max_hits !== undefined ? { max_hits: data.max_hits } : {}),
    ...(data.group_by !== undefined ? { group_by: data.group_by } : {}),
    ...(data.count !== undefined ? { count: data.count } : {}),
    ...(data.from !== undefined ? { from: data.from } : {}),
    ...(data.to !== undefined ? { to: data.to } : {}),
  };
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
  readonly windowNote?: string;
  readonly normalize: boolean;
};

// The same shaping for a fixture and a real result: this call's window, note,
// builder notes and hit cap, so a fixture recorded under another window or cap
// still answers this call correctly.
function shape(value: unknown, s: Shape): LogsSearchOutput {
  const src = isObject(value) ? value : {};
  const { window: _w, window_note: _n, notes: _notes, ...rest } = src;
  const common = {
    window: s.window,
    ...(s.windowNote !== undefined ? { window_note: s.windowNote } : {}),
    ...(s.query.notes.length > 0 ? { notes: [...s.query.notes] } : {}),
  };
  const numHits = typeof rest.num_hits === 'number' ? rest.num_hits : 0;

  if (s.query.mode === 'count') {
    const count = typeof rest.count === 'number' ? rest.count : numHits;
    return { count, num_hits: typeof rest.num_hits === 'number' ? numHits : count, ...common, truncated: false };
  }
  if (s.query.mode === 'histogram') {
    const raw = Array.isArray(rest.groups) ? (rest.groups as LogGroup[]) : [];
    const groups = s.normalize ? foldGroups(raw) : raw;
    return { groups, num_hits: numHits, ...common, truncated: rest.truncated === true };
  }
  const all = Array.isArray(rest.hits) ? (rest.hits as LogHit[]) : [];
  const hits = all.slice(0, s.query.maxHits);
  const truncated = rest.truncated === true || hits.length < all.length || numHits > hits.length;
  return {
    hits,
    num_hits: Math.max(numHits, all.length),
    ...common,
    truncated,
    ...(s.normalize ? { message_groups: messageGroups(hits) } : {}),
  };
}

function summaryOf(entity: Entity, service: string, out: LogsSearchOutput, transport: QuickwitTransportKind | undefined): string {
  const via = transport === undefined ? '' : ` via ${transport}`;
  if ('count' in out) return `logs_search ${entity}:${service} count ${out.count}${via}`;
  if ('groups' in out) return `logs_search ${entity}:${service} ${out.groups.length} groups${via}`;
  return `logs_search ${entity}:${service} ${out.hits.length} of ${out.num_hits} hits${via}`;
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
  let windowNote: string | undefined;
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
    if (target.transport === 'qw' && toSince(w.window, now).window_note !== undefined) windowNote = START_ONLY_WINDOW_NOTE;
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
    return shape(value, { query: r.query, window: r.window, ...(windowNote !== undefined ? { windowNote } : {}), normalize });
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
      render: shapeOf,
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
