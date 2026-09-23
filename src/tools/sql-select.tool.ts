// sql_select: one read-only SELECT against one of the investigator's service
// databases (HLD 02 §2 and §3; LLD 04 §2.6; D3, D7, D26, D33).
//
// Input is { service, sql, params?, scope? }. service is a picklist of the
// closure entity's services that have a database in the registry; entity and
// run id come from the closure and never from the input (D3).
//
// Every call goes through runIoTool, so the order is fixed:
//   budget -> scope (bound params and literals must be in the IdChain, or
//   scope 'systemic' with an aggregate-only select list) -> SQL gate
//   (validateSelect, $n count, wrapWithCap, buildReadOnlyTxn) -> not
//   configured (blank <ENTITY>_<SERVICE>_DB_URL) -> fixture or the SQL
//   connector -> audit (target is the env var name) -> stage the full rows to
//   /data -> model-facing redaction -> envelope.
//
// The row cap is TRIAGE_SQL_MAX_ROWS (through the run budget). The wrapped
// query asks for one row more than the cap, so a cut result is reported as
// truncated. Fixture rows beyond the cap are cut the same way.

import type { FlueLogger } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { SqlConnector } from '../connectors/sql/pg-client.ts';
import type { MockPort } from '../connectors/mock.ts';
import { ConnectorError, type ConnectorContext } from '../connectors/types.ts';
import { MAX_SQL_LENGTH, type SqlCheck, type SqlRefusalCode, validateSelect } from '../gate/sql.ts';
import { buildReadOnlyTxn, wrapWithCap } from '../gate/sql-txn.ts';
import { semanticKey } from '../mock/key.ts';
import type { Entity } from '../types/core.ts';
import type { ToolEnvelope } from '../types/tool-result.ts';
import { type BackingRef, type GateDecision, runIoTool, type StagingHarness } from './_lib/pipeline.ts';
import type { ToolContext, ToolModule } from './types.ts';

declare module './_lib/context.ts' {
  interface ToolConnectors {
    /** Postgres for sql_select. Missing means real calls answer not configured. */
    readonly sql?: SqlConnector;
  }
}

export const SQL_SELECT = 'sql_select';

const MAX_PARAMS = 50;
const PARAM_MAX_CHARS = 1_000;

const WRITE_ADVICE = 'If a write is needed, recommend it under actions in the report instead.';

// Codes that mean "this is not a single SELECT". They all get the same
// opening so the model reads one clear rule.
const NOT_A_SELECT: Readonly<Partial<Record<SqlRefusalCode, string>>> = Object.freeze({
  NOT_SELECT: 'INSERT, UPDATE, DELETE, MERGE and other writes never run.',
  MULTI_STATEMENT: 'Send exactly one statement, with at most one trailing semicolon.',
  UTILITY: 'SET, RESET, SHOW, EXPLAIN, COPY, DDL and other utility statements are refused.',
  DATA_MODIFYING_CTE: 'INSERT, UPDATE, DELETE and MERGE are refused inside WITH as well.',
  INTO: 'SELECT ... INTO creates a table; drop the INTO clause.',
});

const description = (maxRows: number): string =>
  "Run one read-only SELECT against one of this entity's service databases. " +
  'Send exactly one SELECT (WITH ... SELECT is fine); writes, SET/RESET/SHOW and more than one statement are ' +
  `refused. Put every value in params and refer to it as $1, $2, ... in order; never write ids into the SQL text. ` +
  'Ids must come from the brief or the ID chain. For counts across customers set scope to "systemic" and select ' +
  'only aggregates (count, sum, avg, min/max of non-id columns, grouped by non-id columns). ' +
  `At most ${maxRows} rows come back; truncated is true when there were more, and the full result is ` +
  'in staged_file in the sandbox. Returns rows, row_count, truncated and taken_at. ' +
  '"Refused: ..." means the gate stopped the call: read the reason, fix the query and try again, or record the gap. ' +
  '"not configured for <entity>:<service>" means that database is not set up here: record it as a gap and use ' +
  `another source. ${WRITE_ADVICE}`;

// ------------------------------------------------------------ services

/** The closure entity's services that have a database in the registry, sorted. */
export function sqlServices(ctx: Pick<ToolContext, 'registry'>, entity: Entity): readonly string[] {
  const out = ctx.registry.services(entity).filter((s) => ctx.registry.service(entity, s).db !== undefined);
  return Object.freeze([...out].sort());
}

// ------------------------------------------------------------ input schema

const ParamSchema = v.union([
  v.pipe(v.string(), v.maxLength(PARAM_MAX_CHARS)),
  v.pipe(v.number(), v.finite()),
  v.boolean(),
  v.null(),
]);

function inputSchema(services: readonly string[]) {
  return v.object({
    service: v.pipe(v.picklist(services), v.description("The service whose database to query. One of this entity's DB services.")),
    sql: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_SQL_LENGTH),
      v.description('One SELECT. Values go in params as $1, $2, ...; no ids written into the text.'),
    ),
    params: v.optional(
      v.pipe(v.array(ParamSchema), v.maxLength(MAX_PARAMS), v.description('Bind values for $1..$n, in order.')),
    ),
    scope: v.optional(
      v.pipe(
        v.literal('systemic'),
        v.description('Set only for counts across customers. The select list must then be aggregate-only.'),
      ),
    ),
  });
}

type SqlSelectInput = v.InferOutput<ReturnType<typeof inputSchema>>;
type Param = v.InferOutput<typeof ParamSchema>;

// ------------------------------------------------------------ result shape

// What the fixture holds and what real() returns: the SqlRows of the
// connector, and truncated when the connector's byte cap cut it.
const AnswerSchema = v.object({
  rows: v.array(v.record(v.string(), v.unknown())),
  columns: v.optional(v.array(v.string())),
  truncated: v.optional(v.boolean()),
});
type Answer = v.InferOutput<typeof AnswerSchema>;

function parseAnswer(value: unknown): Answer {
  const parsed = v.safeParse(AnswerSchema, value);
  if (!parsed.success) throw new Error('sql_select: the sql_select answer has the wrong shape (expected { rows: [...] })');
  return parsed.output;
}

// ------------------------------------------------------------ gate

type Plan = { readonly statements: readonly string[]; readonly params: readonly Param[] };

/** The model-facing text for a refused parse. */
export function sqlRefusalMessage(check: Extract<SqlCheck, { ok: false }>): string {
  const detail = NOT_A_SELECT[check.code];
  if (detail !== undefined) return `Refused: only SELECT is allowed. ${detail} ${WRITE_ADVICE}`;
  return check.message;
}

function gateFor(
  config: ToolContext['config'],
  sql: string,
  check: SqlCheck,
  params: readonly Param[],
  cap: number,
  onPlan: (plan: Plan) => void,
): GateDecision {
  if (!check.ok) return { ok: false, message: sqlRefusalMessage(check), reason: `sql: ${check.code}` };
  if (params.length !== check.paramCount) {
    return {
      ok: false,
      message:
        `Refused: the query uses ${check.paramCount} parameter(s) ($1..$${check.paramCount}) but ${params.length} ` +
        'value(s) were sent in params. Send one value per $n.',
      reason: `sql: ${check.paramCount} placeholders, ${params.length} params`,
    };
  }
  try {
    const wrapped = wrapWithCap(sql, check.paramCount);
    const statements = buildReadOnlyTxn(
      { statementTimeoutMs: config.sql.statementTimeoutMs, lockTimeoutMs: config.sql.lockTimeoutMs },
      wrapped.sql,
    );
    // One more row than the cap, so a cut result can be told apart.
    onPlan({ statements, params: [...params, cap + 1] });
    return { ok: true };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'error';
    return {
      ok: false,
      message: 'Refused: the query could not be wrapped for a read-only run. Send one plain SELECT.',
      reason: `sql: wrap failed (${name})`,
    };
  }
}

// ------------------------------------------------------------ backing

function backingFor(ctx: ToolContext, entity: Entity, service: string): BackingRef {
  const envName = ctx.registry.service(entity, service).db ?? `${entity.toUpperCase()}_${service.toUpperCase()}_DB_URL`;
  try {
    const cap = ctx.registry.serviceDb(entity, service);
    return cap === undefined ? { envName, status: 'blank' } : { envName: cap.envName, status: cap.status };
  } catch {
    // The entity is not enabled here. RegistryError names keys only.
    return { envName, status: 'disabled' };
  }
}

// The pipeline already answered from fixtures in mock mode, so the connector
// runs with mock off. Recording is the pipeline's job too, so there is none here.
const REAL_ONLY_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: true,
  lookup: () => Promise.reject(new Error('sql_select: fixture lookup happens in the tool pipeline')),
});

// ------------------------------------------------------------ the call

type RunInput = {
  readonly data: SqlSelectInput;
  readonly signal?: AbortSignal;
  readonly toolCallId: string;
  readonly log: FlueLogger;
  readonly harness?: StagingHarness;
};

async function runSqlSelect(ctx: ToolContext, entity: Entity, services: readonly string[], flue: RunInput): Promise<ToolEnvelope> {
  const { data } = flue;
  const deps = ctx.deps;
  // Flue parses the input first; this keeps the picklist check in our hands.
  const service = services.includes(data.service) ? data.service : 'unknown';
  const params: readonly Param[] = data.params ?? [];
  const systemic = data.scope === 'systemic';
  const check = validateSelect(data.sql);
  const cap = deps.budget.clampRows(ctx.config.sql.maxRows);
  const where = `${entity}:${service}`;
  let plan: Plan | undefined;

  return runIoTool<'sql_select', Answer>(
    {
      tool: SQL_SELECT,
      service,
      input: data,
      backing:
        service === 'unknown' ? { envName: 'TRIAGE_ENTITIES', status: 'disabled' } : backingFor(ctx, entity, service),
      scope: { systemic, sqlAggregateOnly: check.ok && check.aggregateOnly },
      gate: () => {
        if (service === 'unknown') {
          return {
            ok: false,
            message: `Refused: service is not one of this entity's DB services (${services.join(', ')}).`,
            reason: 'sql: unknown service',
          };
        }
        return gateFor(ctx.config, data.sql, check, params, cap, (p) => {
          plan = p;
        });
      },
      fixture: () => ({
        kind: 'sql_select',
        key: semanticKey('sql_select', { entity, service, tables: check.ok ? check.tables : [], params: [...params] }),
      }),
      real: async (signal) => {
        const connector = deps.connectors.sql;
        if (connector === undefined) throw new ConnectorError('not_configured', 'no sql connector for this run');
        if (plan === undefined || !check.ok) throw new ConnectorError('refused', 'sql_select ran without a checked plan');
        const connectorCtx: ConnectorContext = {
          signal,
          now: deps.now,
          mock: REAL_ONLY_PORT,
          runId: ctx.runId,
          redactionNames: deps.run.redactionNames,
        };
        const outcome = await connector.runSelect(connectorCtx, {
          entity,
          service,
          plan: plan.statements,
          params: plan.params,
          keyInput: { entity, service, tables: check.tables, params: [...params] },
        });
        if (outcome.fixture_miss === true) throw new ConnectorError('refused', 'sql connector answered from fixtures in real mode');
        if (outcome.role_warning !== undefined) flue.log.warn(`${SQL_SELECT} ${where}: the database role can write`);
        return {
          rows: [...outcome.data.rows],
          columns: [...outcome.data.columns],
          ...(outcome.truncated === true ? { truncated: true } : {}),
        };
      },
      render: (value) => {
        const answer = parseAnswer(value);
        const rows = answer.rows.slice(0, cap);
        return {
          service,
          ...(answer.columns !== undefined ? { columns: answer.columns } : {}),
          rows,
          row_count: rows.length,
          truncated: answer.truncated === true || answer.rows.length > cap,
        };
      },
      stage: (value) => {
        const answer = parseAnswer(value);
        return { service, ...(answer.columns !== undefined ? { columns: answer.columns } : {}), rows: answer.rows };
      },
      summary: (value) => {
        const rows = parseAnswer(value).rows.length;
        const tables = check.ok ? check.tables.join(',') : '';
        return `${SQL_SELECT} ${where} tables=${tables} rows=${Math.min(rows, cap)}${systemic ? ' systemic' : ''}`;
      },
    },
    {
      toolContext: ctx,
      toolCallId: flue.toolCallId,
      log: flue.log,
      ...(flue.signal !== undefined ? { signal: flue.signal } : {}),
      ...(flue.harness !== undefined ? { harness: flue.harness } : {}),
    },
  );
}

// ------------------------------------------------------------ the module

function entityOf(ctx: ToolContext): Entity {
  if (ctx.entity === null) throw new Error('sql_select needs an entity in the tool context');
  return ctx.entity;
}

function create(ctx: ToolContext): ToolDefinition {
  const entity = entityOf(ctx);
  const services = sqlServices(ctx, entity);
  return defineTool({
    name: SQL_SELECT,
    description: description(ctx.config.sql.maxRows),
    input: inputSchema(services),
    harness: true,
    run: async ({ data, signal, toolCallId, log, harness }): Promise<ToolEnvelope> =>
      runSqlSelect(ctx, entity, services, {
        data,
        toolCallId,
        log,
        harness,
        ...(signal !== undefined ? { signal } : {}),
      }),
  });
}

export const toolModule: ToolModule = {
  name: SQL_SELECT,
  mounts: ['investigator'],
  entities: 'all',
  enabled(ctx) {
    if (ctx.entity === null) return { on: false, reason: 'sql_select needs an entity' };
    if (!ctx.registry.isEnabled(ctx.entity)) return { on: false, reason: `${ctx.entity} is not in TRIAGE_ENTITIES` };
    if (sqlServices(ctx, ctx.entity).length === 0) return { on: false, reason: `${ctx.entity} has no DB services in the registry` };
    return { on: true };
  },
  create,
};
