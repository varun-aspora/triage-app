// locate: where does this value live? (plan 15 P3, D98)
//
// One value in, counts out, never rows. For each entity searched:
// - logs: one Quickwit count of the bare value grouped by service, over the
//   run's request window, through the same connector path and fixture key as
//   logs_search with terms [value] and group_by ["service"];
// - databases: for each service database, the key-like columns whose type
//   fits the value (schema-catalogue.ts), indexed first and capped per
//   database, each probed with SELECT count(*) ... WHERE "column" = $1 in the
//   read-only transaction, with TRIAGE_LOCATE_TIMEOUT_MS as its statement
//   timeout. Tables in the entity's locate.exclude_tables and the service's
//   scope_exempt_tables, and services in locate.exclude_services, are skipped.
//
// Order: signal -> repeat -> budget (one tool call) -> scope (the value must
// be in the ID chain: a chain id, a seed or a derived lead) -> gate (one whole
// id-shaped value) -> catalogues -> probes within the run's probe budget ->
// one audit line with the probe count -> stage -> model-facing redaction ->
// result cap -> envelope. The steps and helpers are the pipeline's
// (pipeline.ts). runIoTool itself is not used because it resolves one fixture
// on one backing per call, and locate reads a catalogue and many counts per
// database. Each read resolves on its own: mock mode answers it from its
// fixture (a miss is an empty catalogue or no hits; strict mode throws, as
// other tools do), real mode runs it.
//
// A probe that times out or fails is reported for that place and the call
// goes on. A database that stops answering has its remaining probes skipped
// and given back. The probe budget is per run
// (TRIAGE_LOCATE_MAX_PROBES_PER_RUN) and shared with every caller of
// runLocate, the scout included; places past it are listed as not probed.
// locate never adds leads: it returns counts only. The model's calls add to
// the stuck count (P6) like the pipeline's: a refusal or no hit anywhere adds
// to it, a hit resets it, a result with failed places leaves it. A result
// with failed places is not kept for a repeat either.
//
// Mounted on 'investigator' (its own entity, fixed by the closure) and
// 'agent' (every enabled entity, or the ones in the entities input; the
// worker gets it from there).

import type { FlueLogger } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { logsKeyInput, resolveQuickwit, type LogGroup, type QuickwitConnector } from '../connectors/quickwit/client.ts';
import type { SqlConnector } from '../connectors/sql/pg-client.ts';
import { errorText, excerpt, scrubSecrets, stripAddresses } from '../connectors/error-text.ts';
import { ConnectorError, isConnectorError } from '../connectors/types.ts';
import { makeAuditLine } from '../gate/audit.ts';
import { isExhausted } from '../gate/budget.ts';
import { buildLogsQuery, HIT_LIMIT, quickwitGateConfig, type LogsQuery, type LogsQueryInput, type QuickwitGateConfig } from '../gate/quickwit.ts';
import { redactForModel } from '../gate/redact.ts';
import { checkScope, maskId } from '../gate/scope.ts';
import { classifySqlState, isSqlState } from '../gate/sql-errors.ts';
import { buildReadOnlyTxn, type TxnTimeouts } from '../gate/sql-txn.ts';
import { FixtureMissError } from '../mock/errors.ts';
import { keyString, semanticKey, type SqlSelectFacts } from '../mock/key.ts';
import type { FixtureKind, SemanticKey } from '../mock/types.ts';
import { findRepeat, rememberRepeat } from '../runlog/actions.ts';
import type { AuditDecision, AuditTransport } from '../types/audit.ts';
import { ENTITIES, type Entity, type TimeWindow } from '../types/core.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import { outcomeData, realConnectorContext } from './_lib/connector-context.ts';
import { scopeSetOf } from './_lib/context.ts';
import { countStuck, fitModelResult, stageRows, type StagingHarness, type StuckOutcome } from './_lib/pipeline.ts';
import {
  type Candidates,
  CATALOGUE_SQL,
  CATALOGUE_TABLES,
  type Catalogue,
  type CatalogueColumn,
  cachedCatalogue,
  candidateColumns,
  countOf,
  countSql,
  parseCatalogue,
  probeTable,
  releaseCatalogues,
  rememberCatalogue,
  type ValueKind,
  valueKind,
} from './_lib/schema-catalogue.ts';
import { requestWindowOf } from './logs-search.tool.ts';
import type { Mount, ToolContext, ToolModule } from './types.ts';

declare module './_lib/context.ts' {
  interface ToolConnectors {
    readonly sql?: SqlConnector;
    readonly quickwit?: QuickwitConnector;
  }
}

export const LOCATE = 'locate';

const VALUE_MAX_CHARS = 320;

// The audit target: the call spans the entities TRIAGE_ENTITIES enables, not one connection.
const AUDIT_TARGET = 'TRIAGE_ENTITIES';

// On top of the statement timeout, for a connection that hangs or keeps
// retrying: the probe gives up after this much longer and reports a timeout.
const DEADLINE_SLACK_MS = 2_000;

// ------------------------------------------------------------ probe budget

const probesByRun = new Map<string, number>();

/** Probes the run has used so far, across every locate call. */
export function locateProbesUsed(runId: string): number {
  return probesByRun.get(runId) ?? 0;
}

/** Takes up to `wanted` probes from the run's budget and returns how many it got. */
function takeProbes(runId: string, wanted: number, max: number): number {
  const used = locateProbesUsed(runId);
  const got = Math.max(0, Math.min(wanted, max - used));
  probesByRun.set(runId, used + got);
  return got;
}

function giveBackProbes(runId: string, n: number): void {
  if (n > 0) probesByRun.set(runId, Math.max(0, locateProbesUsed(runId) - n));
}

/** Drops a settled run's probe count and catalogues. Returns false when there was neither. */
export function releaseLocateState(runId: string): boolean {
  const probes = probesByRun.delete(runId);
  return releaseCatalogues(runId) || probes;
}

// ------------------------------------------------------------ input

const ValueSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(VALUE_MAX_CHARS),
  v.description('One id from the brief or the ID chain: a UUID, an email, a +phone or 9 or more digits. Nothing else in the string.'),
);

function inputSchema(entities: readonly Entity[] | null) {
  if (entities === null) return v.strictObject({ value: ValueSchema });
  return v.strictObject({
    value: ValueSchema,
    entities: v.optional(
      v.pipe(
        v.array(v.picklist(entities)),
        v.minLength(1),
        v.description(`Only these entities (${entities.join(', ')}). Leave it out to search every one.`),
      ),
    ),
  });
}

export type LocateInput = { readonly value: string; readonly entities?: readonly Entity[] };

const description = (config: ToolContext['config'], pickEntities: boolean): string => {
  const { maxProbesPerRun, maxColumnsPerDb, timeoutMs } = config.discovery.locate;
  return (
    'Find where a value lives. Counts only, never rows. Give one id from the brief or the ID chain ' +
    '(a UUID, an email, a +phone or 9 or more digits). ' +
    (pickEntities ? 'It searches every entity, or only those in entities. ' : "It searches this entity's logs and databases. ") +
    'Logs: the hits for the bare value in the request window, grouped by service. ' +
    'Databases: every service database column whose type fits the value and whose name looks like a key ' +
    `(*_id, *_ref, *_reference, external_*, *_number, email, phone*, mobile*, id), indexed columns first, at most ${maxColumnsPerDb} per database, ` +
    `each counted with a ${timeoutMs} ms timeout. ` +
    'Returns ranked: hits first, largest first, such as "rtl logs verification-service 3328" or ' +
    '"rtl db workflow public.workflow_executions.reference_id 2"; then "<entity>: nothing (...)" for an entity with no hit; ' +
    'then the places that failed, were skipped or were not probed. ' +
    `Each count uses one probe from a budget of ${maxProbesPerRun} per run; once it is spent, work from the counts you have. ` +
    'A timeout, a skipped table or a place not probed says nothing about whether the value is there; do not read it as zero. ' +
    'Follow a hit with sql_select or logs_search on that place. locate adds no ids to the chain. ' +
    '"Refused: ..." names what to fix. The full result is in staged_file.'
  );
};

// ------------------------------------------------------------ places

export type PlaceStatus = 'hit' | 'zero' | 'failed' | 'not_probed' | 'skipped' | 'not_configured';

/** One place locate looked at, or would have. The staged file lists every one. */
export type LocatePlace = {
  readonly entity: Entity;
  readonly source: 'logs' | 'db';
  /** db: the registry service. logs: the service the lines log under, when split by service. */
  readonly service?: string;
  /** db: schema.table.column. */
  readonly column?: string;
  readonly indexed?: boolean;
  readonly status: PlaceStatus;
  readonly count?: number;
  readonly reason?: string;
};

/** What each database contributed, for the staged file and the "nothing" lines. */
type DbSummary = {
  readonly entity: Entity;
  readonly service: string;
  readonly columns: number;
  readonly candidates: number;
  readonly indexed: number;
  readonly excluded: number;
  readonly over_cap: number;
  readonly catalogue_truncated?: boolean;
};

export type LocateResult = {
  readonly value_kind: ValueKind;
  readonly entities: readonly Entity[];
  readonly window: TimeWindow;
  readonly probes: number;
  readonly probes_left: number;
  readonly places: readonly LocatePlace[];
  readonly databases: readonly DbSummary[];
  readonly notes: readonly string[];
};

// ------------------------------------------------------------ targets

type DbTarget = {
  readonly entity: Entity;
  readonly service: string;
  readonly envName: string;
  readonly off?: { readonly status: 'skipped' | 'not_configured'; readonly reason: string };
  readonly exempt: readonly string[];
  readonly encrypted: boolean;
};

type LogsTarget = {
  readonly entity: Entity;
  readonly off?: { readonly status: 'not_configured' | 'failed'; readonly reason: string };
  readonly cfg?: QuickwitGateConfig;
  readonly query?: LogsQuery;
};

function dbTargets(ctx: ToolContext, entity: Entity): DbTarget[] {
  const spec = ctx.registry.spec(entity);
  const excluded = spec.locate?.exclude_services ?? [];
  const out: DbTarget[] = [];
  for (const service of [...ctx.registry.services(entity)].sort()) {
    const s = ctx.registry.service(entity, service);
    if (s.db === undefined) continue;
    const base = { entity, service, envName: s.db, exempt: s.scope_exempt_tables ?? [], encrypted: s.field_encryption !== undefined };
    if (excluded.includes(service)) {
      out.push({ ...base, off: { status: 'skipped', reason: 'excluded by the locate config' } });
      continue;
    }
    const cap = ctx.registry.serviceDb(entity, service);
    out.push(cap === undefined || cap.status !== 'ok' ? { ...base, off: { status: 'not_configured', reason: `${base.envName} is blank` } } : base);
  }
  return out;
}

function logsTarget(ctx: ToolContext, entity: Entity, input: LogsQueryInput): LogsTarget {
  try {
    resolveQuickwit(ctx.registry, entity);
  } catch (err) {
    if (isConnectorError(err, 'not_configured')) return { entity, off: { status: 'not_configured', reason: 'logs are not set up' } };
    throw err;
  }
  const cfg = quickwitGateConfig(ctx.registry, entity);
  if (cfg === undefined) return { entity, off: { status: 'not_configured', reason: 'logs are not set up' } };
  const query = buildLogsQuery(cfg, input);
  if (!query.ok) return { entity, off: { status: 'failed', reason: query.reason } };
  return { entity, cfg, query };
}

// ------------------------------------------------------------ probes

type Probe =
  | { readonly kind: 'logs'; readonly entity: Entity; readonly target: string; readonly logs: Required<Pick<LogsTarget, 'cfg' | 'query'>> }
  | { readonly kind: 'db'; readonly entity: Entity; readonly target: string; readonly service: string; readonly column: CatalogueColumn };

type ProbeOutcome =
  | { readonly status: 'count'; readonly count: number }
  | { readonly status: 'logs'; readonly numHits: number; readonly groups: readonly LogGroup[]; readonly overLimit: boolean }
  | { readonly status: 'failed' | 'not_probed' | 'not_configured'; readonly reason: string; readonly down?: true };

const LogsAnswerSchema = v.looseObject({
  num_hits: v.number(),
  groups: v.optional(v.array(v.looseObject({ key: v.string(), count: v.number() }))),
  reason: v.optional(v.string()),
});

const SqlAnswerSchema = v.looseObject({ rows: v.array(v.unknown()), truncated: v.optional(v.boolean()) });

/** Errors that mean the database or index is not answering at all, so its other probes are skipped. */
const DOWN_CODES: ReadonlySet<string> = new Set(['unreachable', 'not_configured', 'readonly_role_required']);

/** A connector error's own text is cut to this many characters in a place's reason. */
const DETAIL_CHARS = 160;

// A SQL error gives its SQLSTATE name only: Postgres server text can quote
// stored values of other rows. Any other connector error gives its message,
// which the connector built without secrets, scrubbed again as the pipeline
// does, so the model sees why a place failed.
function failure(err: unknown, where: string, timeoutMs?: number): { reason: string; code: string } {
  const sqlstate = (err as { sqlstate?: unknown } | null)?.sqlstate;
  const code = isConnectorError(err) ? err.code : 'error';
  if (sqlstate === '57014' || code === 'timeout') {
    return { reason: timeoutMs === undefined ? 'timed out' : `timed out after ${timeoutMs} ms`, code: 'timeout' };
  }
  if (isSqlState(sqlstate)) return { reason: `failed (SQLSTATE ${sqlstate}, ${classifySqlState(sqlstate).description})`, code };
  if (!isConnectorError(err)) return { reason: `failed (${code})`, code };
  let text = errorText(err);
  if (text.startsWith(`${where}: `)) text = text.slice(where.length + 2);
  const detail = excerpt(stripAddresses(scrubSecrets(text)), DETAIL_CHARS);
  return { reason: detail === '' ? `failed (${code})` : `failed (${code}: ${detail})`, code };
}

// ------------------------------------------------------------ the call

type RunArgs = {
  readonly toolCallId: string;
  readonly log: Pick<FlueLogger, 'warn'>;
  readonly signal?: AbortSignal;
  readonly harness?: StagingHarness;
};

/** The entities a call searches: the closure's own, or the input's (deduplicated, enabled only), or every enabled one. */
function entitiesOf(ctx: ToolContext, input: LocateInput): Entity[] {
  if (ctx.entity !== null) return [ctx.entity];
  const enabled = ctx.registry.enabledEntities();
  if (input.entities === undefined) return [...enabled];
  return enabled.filter((e) => input.entities?.includes(e));
}

/**
 * One locate call through the pipeline steps. Exported so the scout can
 * locate a seed the same way, from the same probe budget and repeat cache.
 * It does not add to the stuck count (P6): the scout's calls are not the
 * model's. Throws only for an aborted signal and a strict mock miss.
 */
export async function runLocate(ctx: ToolContext, input: LocateInput, args: RunArgs): Promise<ToolEnvelope> {
  return locate(ctx, input, args, () => {});
}

// The hits a locate envelope reports, for the stuck count of a reused result.
function hitsOf(envelope: ToolEnvelope): number | undefined {
  const hits = (envelope.output.data as { hits?: unknown } | undefined)?.hits;
  return typeof hits === 'number' ? hits : undefined;
}

async function locate(ctx: ToolContext, input: LocateInput, args: RunArgs, mark: (outcome: StuckOutcome) => void): Promise<ToolEnvelope> {
  args.signal?.throwIfAborted();
  const deps = ctx.deps;
  const now = deps.now;
  const started = now().getTime();
  const config = ctx.config;
  const value = input.value.trim();
  const entities = entitiesOf(ctx, input);
  const mockMode = deps.fixtures.settings.mockMode;
  const noIo: AuditTransport = mockMode ? 'mock' : 'real';
  const shape = valueKind(value);
  const masked = shape === undefined ? 'value' : maskId({ kind: shape, normalised: value.toLowerCase() });

  const audit = (decision: AuditDecision, exit: string, transport: AuditTransport, extra: { reason?: string; summary?: string; count?: number } = {}): void => {
    deps.audit.write(
      makeAuditLine(
        {
          run_id: ctx.runId,
          ts: now().toISOString(),
          interface: deps.run.interface,
          entity: ctx.entity,
          tool: LOCATE,
          decision,
          ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
          target: AUDIT_TARGET,
          transport,
          summary: extra.summary ?? `${LOCATE} ${masked} in ${entities.join(',') || 'no entity'}`,
          duration_ms: Math.max(0, now().getTime() - started),
          exit,
          ...(extra.count !== undefined ? { count: extra.count } : {}),
        },
        { names: deps.run.redactionNames },
      ),
    );
  };
  const refuse = (text: string): ToolEnvelope => refused(redactForModel(text, config), now);

  // Repeat: the same value over the same entities earlier in the run costs no probes.
  const repeatKey = keyString({ tool: LOCATE, where: ctx.entity ?? 'global', facts: { value, entities } });
  if (!deps.budget.state().exhausted) {
    const earlier = findRepeat(ctx.runId, repeatKey, now());
    if (earlier !== undefined) {
      audit('allow', 'reused', noIo, { summary: `${LOCATE} ${masked}: result reused`, count: 0 });
      const hits = hitsOf(earlier);
      mark(hits === undefined ? 'other' : hits > 0 ? 'found' : 'empty');
      return earlier;
    }
  }

  const budget = deps.budget.consumeToolCall(LOCATE, ctx.entity ?? undefined, { dataTool: true });
  if (!budget.ok) {
    if (isExhausted(budget.reason)) deps.escalation.markBudgetExhausted();
    audit('deny', 'refused', noIo, { reason: `budget: ${budget.reason}` });
    return refuse(budget.message);
  }

  const scope = checkScope({ tool: LOCATE, params: { value }, scopeSet: scopeSetOf(deps), maxLeadDepth: config.budgets.maxLeadDepth });
  if (!scope.ok) {
    audit('deny', 'refused', noIo, { reason: scope.reason });
    mark('refused');
    return refuse(`Refused: ${scope.reason}. locate takes only an id from the brief or the ID chain.`);
  }

  const kind = shape;
  if (kind === undefined) {
    audit('deny', 'refused', noIo, { reason: 'locate: not one whole id' });
    mark('refused');
    return refuse(
      'Refused: value must be exactly one id (a UUID, an email, a +phone or 9 or more digits) with nothing around it. ' +
        'For free text, use logs_search.',
    );
  }
  if (entities.length === 0) {
    audit('deny', 'refused', noIo, { reason: 'locate: no enabled entity' });
    mark('refused');
    return refuse(`Refused: none of the entities asked for is enabled here (${ctx.registry.enabledEntities().join(', ')}).`);
  }

  const window = requestWindowOf(ctx, now());
  const signal = args.signal ?? new AbortController().signal;
  let transport: AuditTransport = noIo;
  let strictMiss: unknown;

  // One read, mock or real. A strict miss is kept and thrown once every read has stopped.
  const resolve = async <K extends FixtureKind, T>(
    kind: K,
    entity: Entity,
    key: SemanticKey<K>,
    real: (signal: AbortSignal) => Promise<T>,
    deadlineMs?: number,
  ): Promise<T | null> => {
    const own = deadlineMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(deadlineMs + DEADLINE_SLACK_MS)]);
    try {
      const outcome = await deps.fixtures.resolveIo({ kind, entity, key, real, signal: own, run_id: ctx.runId, redaction_names: deps.run.redactionNames });
      if (outcome.transport === 'real') transport = 'real';
      return outcome.fixture_miss ? null : outcome.value;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof FixtureMissError || (isConnectorError(err) && err.code === 'strict_miss')) {
        strictMiss ??= err;
        throw err;
      }
      // Our own deadline fired: the connector reports it as a cancel.
      if (own.aborted) throw new ConnectorError('timeout', 'the probe passed its deadline');
      throw err;
    }
  };

  const sqlConnector = (): SqlConnector => {
    const sql = deps.connectors.sql;
    if (sql === undefined) throw new ConnectorError('not_configured', 'no sql connector for this run');
    return sql;
  };
  const { statementTimeoutMs, lockTimeoutMs } = config.sql;
  const probeMs = Math.min(config.discovery.locate.timeoutMs, statementTimeoutMs);
  const catalogueTimeouts: TxnTimeouts = { statementTimeoutMs, lockTimeoutMs };
  const probeTimeouts: TxnTimeouts = { statementTimeoutMs: probeMs, lockTimeoutMs: Math.min(lockTimeoutMs, probeMs) };

  // One read-only select, mock or real, as { rows } like a sql_select fixture.
  const select = (
    facts: SqlSelectFacts,
    sql: string,
    timeouts: TxnTimeouts,
  ): Promise<unknown> =>
    resolve('sql_select', facts.entity, semanticKey('sql_select', facts), async (s) => {
      const out = outcomeData(
        await sqlConnector().runSelect(realConnectorContext(ctx, s), {
          entity: facts.entity,
          service: facts.service,
          plan: buildReadOnlyTxn(timeouts, sql),
          params: facts.params,
          keyInput: facts,
        }),
      );
      return { rows: [...(out?.rows ?? [])] };
    }, timeouts.statementTimeoutMs);

  // --- catalogues, one per database, cached for the run
  const catalogueOf = async (t: DbTarget): Promise<Catalogue | Pick<LocatePlace, 'status' | 'reason'>> => {
    const cached = cachedCatalogue(ctx.runId, t.entity, t.service);
    if (cached !== undefined) return cached;
    const facts = { entity: t.entity, service: t.service, tables: [...CATALOGUE_TABLES], params: [] };
    try {
      const answer = await select(facts, CATALOGUE_SQL, catalogueTimeouts);
      const parsed = answer === null ? undefined : v.safeParse(SqlAnswerSchema, answer);
      if (parsed !== undefined && !parsed.success) return { status: 'failed', reason: 'catalogue failed (the answer has the wrong shape)' };
      const catalogue = parseCatalogue(parsed?.output.rows ?? [], parsed?.output.truncated === true);
      rememberCatalogue(ctx.runId, t.entity, t.service, catalogue);
      return catalogue;
    } catch (err) {
      if (signal.aborted || strictMiss !== undefined) throw err;
      const { reason, code } = failure(err, `${t.entity}:${t.service}`, statementTimeoutMs);
      return code === 'not_configured' ? { status: 'not_configured', reason: 'not configured' } : { status: 'failed', reason: `catalogue ${reason}` };
    }
  };

  const logsInput: LogsQueryInput = { terms: [value], group_by: ['service'] };
  const perEntity = entities.map((entity) => ({
    entity,
    logs: logsTarget(ctx, entity, logsInput),
    dbs: dbTargets(ctx, entity),
  }));
  // With the probe budget already spent, nothing is read, not even a catalogue.
  const { maxProbesPerRun } = config.discovery.locate;
  const spent = locateProbesUsed(ctx.runId) >= maxProbesPerRun;
  const liveDbs = spent ? [] : perEntity.flatMap((e) => e.dbs.filter((d) => d.off === undefined));
  const catalogues = await Promise.allSettled(liveDbs.map(catalogueOf));
  if (strictMiss !== undefined) {
    audit('allow', 'fixture_miss', 'mock', { summary: `${LOCATE} ${masked}: strict fixture miss`, count: 0 });
    throw strictMiss;
  }
  const rejected = catalogues.find((c) => c.status === 'rejected');
  if (rejected !== undefined) {
    audit('allow', 'aborted', transport, { count: 0 });
    throw (rejected as PromiseRejectedResult).reason;
  }

  const places: LocatePlace[] = [];
  const databases: DbSummary[] = [];
  const notes: string[] = [];
  const indexedByDb: Probe[][] = [];
  const otherByDb: Probe[][] = [];
  const logsProbes: Probe[] = [];

  for (const e of perEntity) {
    if (e.logs.off !== undefined) places.push({ entity: e.entity, source: 'logs', status: e.logs.off.status, reason: e.logs.off.reason });
    else if (spent) places.push({ entity: e.entity, source: 'logs', status: 'not_probed', reason: 'probe budget' });
    else if (e.logs.cfg !== undefined && e.logs.query !== undefined) {
      logsProbes.push({ kind: 'logs', entity: e.entity, target: `${e.entity}:logs`, logs: { cfg: e.logs.cfg, query: e.logs.query } });
    }
    for (const t of e.dbs) {
      if (t.off !== undefined) places.push({ entity: t.entity, source: 'db', service: t.service, status: t.off.status, reason: t.off.reason });
      else if (spent) places.push({ entity: t.entity, source: 'db', service: t.service, status: 'not_probed', reason: 'probe budget' });
    }
  }
  liveDbs.forEach((t, i) => {
    const got = (catalogues[i] as PromiseFulfilledResult<Awaited<ReturnType<typeof catalogueOf>>>).value;
    if (!('columns' in got)) {
      places.push({ entity: t.entity, source: 'db', service: t.service, ...got });
      return;
    }
    const spec = ctx.registry.spec(t.entity);
    const found: Candidates = candidateColumns(got, value, kind, {
      excludeTables: spec.locate?.exclude_tables ?? [],
      exemptTables: t.exempt,
      maxColumns: config.discovery.locate.maxColumnsPerDb,
    });
    databases.push({
      entity: t.entity,
      service: t.service,
      columns: got.columns.length,
      candidates: found.columns.length,
      indexed: found.columns.filter((c) => c.indexed).length,
      excluded: found.excluded,
      over_cap: found.overCap,
      ...(got.truncated ? { catalogue_truncated: true } : {}),
    });
    if (t.encrypted && (kind === 'phone' || kind === 'email')) {
      notes.push(`${t.entity} ${t.service} stores some phone and email fields encrypted; a 0 there can mean the stored form differs (see encrypt_lookup_value).`);
    }
    const probe = (column: CatalogueColumn): Probe => ({ kind: 'db', entity: t.entity, target: `${t.entity}:${t.service}`, service: t.service, column });
    indexedByDb.push(found.columns.filter((c) => c.indexed).map(probe));
    otherByDb.push(found.columns.filter((c) => !c.indexed).map(probe));
  });

  // Logs first (one probe covers a whole entity), then indexed columns, then
  // the rest, each tier taken a column per database in turn, so a tight
  // budget still reaches every database.
  const plan = [...logsProbes, ...roundRobin(indexedByDb), ...roundRobin(otherByDb)];
  const granted = takeProbes(ctx.runId, plan.length, maxProbesPerRun);
  const outcomes = new Map<Probe, ProbeOutcome>();
  for (const probe of plan.slice(granted)) outcomes.set(probe, { status: 'not_probed', reason: 'probe budget' });

  const runProbe = async (probe: Probe): Promise<ProbeOutcome> => {
    try {
      if (probe.kind === 'logs') {
        const { cfg, query } = probe.logs;
        const key = semanticKey('logs_search', logsKeyInput(cfg, logsInput, query.mode, query.groupBy));
        const answer = await resolve('logs_search', probe.entity, key, async (s) => {
          const connector = deps.connectors.quickwit;
          if (connector === undefined) throw new ConnectorError('not_configured', 'the run has no Quickwit connector');
          return outcomeData(await connector.search(realConnectorContext(ctx, s), probe.entity, logsInput, window));
        });
        if (answer === null) return { status: 'logs', numHits: 0, groups: [], overLimit: false };
        const parsed = v.safeParse(LogsAnswerSchema, answer);
        if (!parsed.success) return { status: 'failed', reason: 'failed (the logs answer has the wrong shape)' };
        const overLimit = parsed.output.num_hits > HIT_LIMIT || parsed.output.reason !== undefined;
        return { status: 'logs', numHits: parsed.output.num_hits, groups: overLimit ? [] : (parsed.output.groups ?? []), overLimit };
      }
      const { column } = probe;
      const facts = { entity: probe.entity, service: probe.service, tables: [probeTable(column)], params: [value] };
      const answer = await select(facts, countSql(column), probeTimeouts);
      if (answer === null) return { status: 'count', count: 0 };
      const parsed = v.safeParse(SqlAnswerSchema, answer);
      const count = parsed.success ? countOf(parsed.output.rows) : undefined;
      return count === undefined ? { status: 'failed', reason: 'failed (the count has the wrong shape)' } : { status: 'count', count };
    } catch (err) {
      if (signal.aborted || strictMiss !== undefined) throw err;
      const { reason, code } = failure(err, probe.kind === 'db' ? probe.target : `${probe.entity}:logs`, probe.kind === 'db' ? probeMs : undefined);
      if (code === 'not_configured') return { status: 'not_configured', reason: 'not configured', down: true };
      args.log.warn(`${LOCATE} ${probe.target} probe failed (${code})`);
      return DOWN_CODES.has(code) ? { status: 'failed', reason, down: true } : { status: 'failed', reason };
    }
  };

  // Targets run side by side; the probes of one target run one at a time, so
  // no database gets more than one of our counts at once.
  const byTarget = new Map<string, Probe[]>();
  for (const probe of plan.slice(0, granted)) {
    const list = byTarget.get(probe.target);
    if (list === undefined) byTarget.set(probe.target, [probe]);
    else list.push(probe);
  }
  // Only probes that were sent are paid for; the rest of the grant goes back,
  // including what a throw (abort, strict miss) left unrun.
  let used = 0;
  const runs = await Promise.allSettled(
    [...byTarget.values()].map(async (probes) => {
      let down = false;
      for (const probe of probes) {
        if (down || strictMiss !== undefined) {
          outcomes.set(probe, { status: 'not_probed', reason: 'its database did not answer' });
          continue;
        }
        used += 1;
        const outcome = await runProbe(probe);
        outcomes.set(probe, outcome);
        // Nothing was sent.
        if (outcome.status === 'not_configured') used -= 1;
        if ('down' in outcome) down = true;
      }
    }),
  );
  giveBackProbes(ctx.runId, granted - used);
  if (strictMiss !== undefined) {
    audit('allow', 'fixture_miss', 'mock', { summary: `${LOCATE} ${masked}: strict fixture miss`, count: used });
    throw strictMiss;
  }
  const failedRun = runs.find((r) => r.status === 'rejected');
  if (failedRun !== undefined) {
    audit('allow', 'aborted', transport, { count: used });
    throw (failedRun as PromiseRejectedResult).reason;
  }

  for (const probe of plan) places.push(...placesOf(probe, outcomes.get(probe) as ProbeOutcome));

  const result: LocateResult = {
    value_kind: kind,
    entities,
    window,
    probes: used,
    probes_left: Math.max(0, maxProbesPerRun - locateProbesUsed(ctx.runId)),
    places,
    databases,
    notes,
  };
  const hits = places.filter((p) => p.status === 'hit').length;
  const failed = places.filter((p) => p.status === 'failed').length;
  const notProbed = places.filter((p) => p.status === 'not_probed').length;
  audit('allow', 'ok', transport, {
    summary: `${LOCATE} ${masked} in ${entities.join(',')} probes=${used} hits=${hits} failed=${failed} not_probed=${notProbed}`,
    count: used,
  });

  const staged = await stageRows(args.harness, args.toolCallId, result, config, { names: deps.run.redactionNames, log: args.log });
  const rendered = renderLocate(result, config.discovery.locate.maxColumnsPerDb);
  const safe = redactForModel(staged.staged ? { ...rendered, staged_file: staged.path } : rendered, config);
  const capped = await fitModelResult(safe, {
    cap: config.budgets.maxModelBytesPerCall,
    ...(staged.staged ? { stagedFile: staged.path } : { notStaged: staged.reason }),
  });
  const envelope = ok(capped, now);
  // A failed place or a database that stopped answering may answer next time.
  const transient = places.some((p) => p.status === 'failed' || (p.status === 'not_probed' && p.reason !== 'probe budget'));
  mark(hits > 0 ? 'found' : transient ? 'other' : 'empty');
  if (!transient) rememberRepeat(ctx.runId, repeatKey, envelope, ctx.agent ?? 'an earlier call', now().toISOString());
  return envelope;
}

/** The first item of each list, then the second of each, and so on. */
function roundRobin<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i] as T);
  return out;
}

function placesOf(probe: Probe, outcome: ProbeOutcome): LocatePlace[] {
  if (probe.kind === 'logs') {
    const base = { entity: probe.entity, source: 'logs' as const };
    if (outcome.status === 'count') return [{ ...base, status: 'failed', reason: 'failed (unexpected answer)' }];
    if (outcome.status !== 'logs') return [{ ...base, status: outcome.status, reason: outcome.reason }];
    if (outcome.numHits === 0) return [{ ...base, status: 'zero', count: 0 }];
    if (outcome.overLimit || outcome.groups.length === 0) {
      const reason = outcome.overLimit ? `over ${HIT_LIMIT} hits, not split by service` : 'not split by service';
      return [{ ...base, status: 'hit', count: outcome.numHits, reason }];
    }
    return outcome.groups.filter((g) => g.count > 0).map((g) => ({ ...base, service: g.key, status: 'hit' as const, count: g.count }));
  }
  const base = { entity: probe.entity, source: 'db' as const, service: probe.service, column: probeTable(probe.column), indexed: probe.column.indexed };
  if (outcome.status === 'count') return [{ ...base, status: outcome.count > 0 ? 'hit' : 'zero', count: outcome.count }];
  if (outcome.status === 'logs') return [{ ...base, status: 'failed', reason: 'failed (unexpected answer)' }];
  return [{ ...base, status: outcome.status, reason: outcome.reason }];
}

// ------------------------------------------------------------ what the model sees

const columns = (n: number): string => `${n} ${n === 1 ? 'column' : 'columns'}`;

/**
 * The ranked lines: hits largest first, then an entity with no hit, then
 * failures, skipped places and places not probed, grouped per database.
 * Pure; exported for the scout's run section.
 */
export function renderLocate(result: LocateResult, maxColumnsPerDb: number): {
  readonly value_kind: ValueKind;
  readonly ranked: readonly string[];
  readonly hits: number;
  readonly probes: number;
  readonly probes_left: number;
  readonly window: TimeWindow;
  readonly notes?: readonly string[];
} {
  const hits = result.places.filter((p) => p.status === 'hit').sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const lines = hits.map((p) =>
    p.source === 'logs'
      ? `${p.entity} logs ${p.service ?? ''}${p.service !== undefined ? ' ' : ''}${p.count}${p.reason !== undefined ? ` (${p.reason})` : ''}`
      : `${p.entity} db ${p.service} ${p.column} ${p.count}`,
  );

  for (const entity of result.entities) {
    const mine = result.places.filter((p) => p.entity === entity);
    if (mine.some((p) => p.status === 'hit')) continue;
    const logsZero = mine.some((p) => p.source === 'logs' && p.status === 'zero');
    const zeros = mine.filter((p) => p.source === 'db' && p.status === 'zero');
    if (!logsZero && zeros.length === 0) continue;
    const parts = [...(logsZero ? ['logs 0'] : []), columns(zeros.length), `${zeros.filter((p) => p.indexed === true).length} indexed`];
    lines.push(`${entity}: nothing (${parts.join(', ')})`);
  }

  // Everything else, short: a failed column on its own line, the columns a
  // database did not probe as one line, and blank databases as one line per entity.
  const notProbed = new Map<string, number>();
  const blank = new Map<Entity, string[]>();
  for (const p of result.places) {
    if (p.status === 'hit' || p.status === 'zero') continue;
    const where = p.source === 'logs' ? `${p.entity} logs` : `${p.entity} db ${p.service}`;
    if (p.source === 'db' && p.column === undefined && p.status === 'not_configured') {
      blank.set(p.entity, [...(blank.get(p.entity) ?? []), p.service ?? '']);
    } else if (p.column !== undefined && p.status === 'not_probed') {
      const key = `${where}: %n not probed (${p.reason ?? 'not probed'})`;
      notProbed.set(key, (notProbed.get(key) ?? 0) + 1);
    } else {
      const text =
        p.status === 'not_configured' ? 'not configured' : p.status === 'not_probed' ? `not probed (${p.reason ?? 'probe budget'})` : (p.reason ?? p.status);
      lines.push(`${where}${p.column !== undefined ? ` ${p.column}` : ''}: ${text}`);
    }
  }
  for (const [key, n] of notProbed) lines.push(key.replace('%n', columns(n)));
  for (const [entity, services] of blank) lines.push(`${entity} db not configured: ${services.join(', ')}`);
  for (const db of result.databases) {
    if (db.over_cap > 0) lines.push(`${db.entity} db ${db.service}: ${columns(db.over_cap)} past the cap of ${maxColumnsPerDb}, not probed`);
    if (db.excluded > 0) lines.push(`${db.entity} db ${db.service}: ${columns(db.excluded)} skipped (excluded or config tables)`);
    if (db.catalogue_truncated === true) lines.push(`${db.entity} db ${db.service}: the column list was cut, so some columns were not seen`);
  }

  return {
    value_kind: result.value_kind,
    ranked: lines,
    hits: hits.length,
    probes: result.probes,
    probes_left: result.probes_left,
    window: result.window,
    ...(result.notes.length > 0 ? { notes: result.notes } : {}),
  };
}

// ------------------------------------------------------------ the module

function create(ctx: ToolContext, mount: Mount): ToolDefinition {
  const shared = mount === 'agent';
  const enabled = ctx.registry.enabledEntities();
  const picklist = shared ? (enabled.length > 0 ? enabled : ENTITIES) : null;
  return defineTool({
    name: LOCATE,
    description: description(ctx.config, shared),
    input: inputSchema(picklist),
    harness: true,
    run: async ({ data, signal, toolCallId, log, harness }): Promise<ToolEnvelope> => {
      let outcome: StuckOutcome = 'other';
      const envelope = await locate(ctx, data as LocateInput, { toolCallId, log, harness, ...(signal !== undefined ? { signal } : {}) }, (o) => {
        outcome = o;
      });
      return countStuck(ctx, LOCATE, envelope, outcome);
    },
  });
}

export const toolModule: ToolModule = {
  name: LOCATE,
  mounts: ['investigator', 'agent'],
  entities: 'all',
  enabled(ctx, mount) {
    if (mount === 'agent') return ctx.registry.enabledEntities().length > 0 ? { on: true } : { on: false, reason: 'no entity is enabled' };
    if (ctx.entity === null) return { on: false, reason: 'locate needs an entity' };
    if (!ctx.registry.isEnabled(ctx.entity)) return { on: false, reason: `${ctx.entity} is not in TRIAGE_ENTITIES` };
    return { on: true };
  },
  create,
};
