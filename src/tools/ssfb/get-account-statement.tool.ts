// get_account_statement: the rhythm admin statement for one account (D29,
// HLD 02 §2). A port of list_transactions.sh as a typed tool.
//
// - The endpoint is fixed in code: GET <rhythm base>/admin/v1/accounts/
//   :account_id/transactions with page, limit, start_date and end_date. The
//   model gives an account id, an optional date window and an optional page;
//   it cannot give a path, a service, SQL or an entity.
// - The account id, and the customer id sent as x-customer-id (taken from the
//   IdChain, never from the model), must be in the run's ID chain.
// - The URL goes through decideHttp (URL builder plus api.rules.json) and the
//   admin HTTP connector, like http_call. With no page, pages 1.. are walked
//   until a short page, a "no more" marker or STATEMENT_MAX_PAGES.
// - The response shape is probed as the script did (a bare array, or the
//   array under transactions, data, items or results, one level deep) and
//   every leg is normalised to one shape.
// - A blank SSFB_RHYTHM_API_URL answers 'not configured for ssfb:rhythm'.
// - The full normalised list is staged to /data/<call id>.json; the model gets
//   the first STATEMENT_MODEL_ROWS transactions.
//
// The statement fetch and the shared SSFB helpers are exported for
// detect_silent_reversals, which reads the same statement.

import type { FlueLogger } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { HttpConnector } from '../../connectors/http/client.ts';
import type { MockPort } from '../../connectors/mock.ts';
import type { SqlConnector } from '../../connectors/sql/pg-client.ts';
import { ConnectorError, type ConnectorContext } from '../../connectors/types.ts';
import { decideHttp, type HttpDecision } from '../../gate/http.ts';
import { loadRulesFile } from '../../gate/rules-file.ts';
import type { ApiRule } from '../../gate/rules.ts';
import { semanticKey } from '../../mock/key.ts';
import type { ToolEnvelope } from '../../types/tool-result.ts';
import { type BackingRef, type GateDecision, runIoTool, type StagingHarness } from '../_lib/pipeline.ts';
import { findStatementItems, normaliseLeg, type StatementTransaction } from '../_lib/reversal-join.ts';
import type { Mount, ToolContext, ToolDeps, ToolModule } from '../types.ts';

declare module '../_lib/context.ts' {
  interface ToolConnectors {
    /** Admin HTTP connector (T04.3). Missing means HTTP tools answer not configured in real mode. */
    readonly http?: HttpConnector;
    /** Postgres connector (T04.2). Missing means SQL tools answer not configured in real mode. */
    readonly sql?: SqlConnector;
  }
}

// ------------------------------------------------------------ constants

export const SSFB = 'ssfb' as const;
export const RHYTHM = 'rhythm';
export const SSFB_MOUNTS: readonly Mount[] = Object.freeze(['investigator']);

/** Legs per page when the model does not choose (the script's detect default). */
export const STATEMENT_PAGE_SIZE = 100;
/** Most pages one call walks. */
export const STATEMENT_MAX_PAGES = 5;
/** Highest page the model may ask for. */
export const STATEMENT_MAX_PAGE = 1000;
/** Transactions the model sees; the rest are in the staged file. */
export const STATEMENT_MODEL_ROWS = 50;

// ------------------------------------------------------------ input pieces

const ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** An id token that lands in a URL path: letters, digits, '_' and '-'. */
export const IdTokenSchema = v.pipe(v.string(), v.trim(), v.regex(ID_TOKEN, 'must be an id token (letters, digits, _ and -)'));

/** A calendar date, YYYY-MM-DD. */
export const DateSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  v.check(isRealDate, 'must be a real calendar date'),
);

export const GetAccountStatementInputSchema = v.strictObject({
  account_id: v.pipe(
    IdTokenSchema,
    v.description(
      'Rhythm account id (customer_account_mappings.account_id), not the CBS account number. Must be in the ID chain.',
    ),
  ),
  from: v.optional(v.pipe(DateSchema, v.description('Start date, YYYY-MM-DD (start_date).'))),
  to: v.optional(v.pipe(DateSchema, v.description('End date, YYYY-MM-DD (end_date).'))),
  page: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(STATEMENT_MAX_PAGE),
      v.description(`One page only. Leave out to read pages 1 to ${STATEMENT_MAX_PAGES}.`),
    ),
  ),
});
export type GetAccountStatementInput = v.InferOutput<typeof GetAccountStatementInputSchema>;

// ------------------------------------------------------------ shared SSFB helpers

/** The rhythm API env var and whether it is set. Only the name ever leaves here. */
export function rhythmApiBacking(ctx: ToolContext): BackingRef {
  const cap = ctx.registry.serviceApi(SSFB, RHYTHM);
  if (cap === undefined) return { envName: 'SSFB_RHYTHM_API_URL', status: 'blank' };
  return { envName: cap.envName, status: cap.status };
}

/** The rhythm DB env var and whether it is set. */
export function rhythmDbBacking(ctx: ToolContext): BackingRef {
  const cap = ctx.registry.serviceDb(SSFB, RHYTHM);
  if (cap === undefined) return { envName: 'SSFB_RHYTHM_DB_URL', status: 'blank' };
  return { envName: cap.envName, status: cap.status };
}

/** The rhythm API base URL, or undefined when it is blank. Read inside run() only. */
export function rhythmApiBase(ctx: ToolContext): string | undefined {
  const cap = ctx.registry.serviceApi(SSFB, RHYTHM);
  return cap !== undefined && cap.status === 'ok' ? cap.value : undefined;
}

/**
 * True when value is one of the ids in the run's IdChain. The pipeline's
 * scope step only checks id-shaped values (UUIDs, long digit runs, ...); this
 * exact check also covers an id token of another shape.
 */
export function inIdChain(deps: ToolDeps, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (wanted === '') return false;
  return Object.values(deps.idChain().ids).some((id) => typeof id === 'string' && id.trim().toLowerCase() === wanted);
}

export function outOfChain(field: string): GateDecision {
  return {
    ok: false,
    message: `Refused: ${field} is not in the ID chain for this run. Use only ids from the brief or the ID chain.`,
    reason: `scope: ${field} not in the id chain`,
  };
}

export type RulesResult = { readonly ok: true; readonly rules: readonly ApiRule[] } | { readonly ok: false; readonly gate: GateDecision };

/** resources/ssfb.api.rules.json, read per call so an edit applies to the next call. */
export function ssfbRules(ctx: ToolContext): RulesResult {
  try {
    return { ok: true, rules: loadRulesFile(ctx.config.home, SSFB, ctx.registry.services(SSFB)).rules };
  } catch {
    return {
      ok: false,
      gate: {
        ok: false,
        message: 'Refused: the SSFB API rules file could not be loaded. Record the gap; the doctor names the problem.',
        reason: 'rules file for ssfb did not load',
      },
    };
  }
}

// The connectors answer real calls only: runIoTool has already resolved mock
// mode through the tool's own fixture, and it records the tool-level result.
const REAL_ONLY_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: false,
  async lookup(): Promise<never> {
    throw new ConnectorError('refused', 'the SSFB statement tools look fixtures up at the tool level');
  },
});

export function connectorContext(ctx: ToolContext, signal: AbortSignal): ConnectorContext {
  const deps = ctx.deps;
  return {
    signal,
    now: deps.now,
    mock: REAL_ONLY_PORT,
    runId: ctx.runId,
    redactionNames: deps.run.redactionNames,
  };
}

// ------------------------------------------------------------ statement fetch

export type StatementQuery = {
  readonly accountId: string;
  readonly from?: string;
  readonly to?: string;
  readonly page: number;
  readonly limit: number;
};

/** The fixed path under the rhythm base path. */
export function statementPath(base: string, accountId: string): string {
  const prefix = new URL(base).pathname.replace(/\/+$/, '');
  return `${prefix}/admin/v1/accounts/${accountId}/transactions`;
}

/** decideHttp for one statement page: the URL builder and api.rules.json. */
export function decideStatement(base: string, rules: readonly ApiRule[], q: StatementQuery): HttpDecision {
  let path: string;
  try {
    path = statementPath(base, q.accountId);
  } catch {
    return { ok: false, code: 'bad_base', message: 'the rhythm base URL could not be parsed' };
  }
  return decideHttp({
    tool: 'http_call',
    service: RHYTHM,
    method: 'GET',
    path,
    query: {
      page: q.page,
      limit: q.limit,
      ...(q.from !== undefined ? { start_date: q.from } : {}),
      ...(q.to !== undefined ? { end_date: q.to } : {}),
    },
    base,
    rules,
  });
}

/** The gate for the first page, as a pipeline GateDecision. */
export function statementGate(decision: HttpDecision): GateDecision {
  if (decision.ok) return { ok: true, rule_index: decision.rule_index, action: 'allow' };
  return {
    ok: false,
    message: `Refused: the statement request was refused (${decision.code}). Record the gap.`,
    reason: `http gate: ${decision.code}`,
    ...(decision.rule_index !== undefined ? { rule_index: decision.rule_index, action: 'block' as const } : {}),
  };
}

const StatementPageSchema = v.object({
  page: v.pipe(v.number(), v.integer(), v.minValue(1)),
  status: v.pipe(v.number(), v.integer()),
  body: v.unknown(),
  truncated: v.optional(v.boolean(), false),
});
export type StatementPage = v.InferOutput<typeof StatementPageSchema>;

/** The raw pages of one statement read. This is what fixtures hold. */
export const StatementFetchSchema = v.object({
  limit: v.pipe(v.number(), v.integer(), v.minValue(1)),
  pages: v.array(StatementPageSchema),
  /** True when the walk stopped at STATEMENT_MAX_PAGES with a full last page. */
  more_available: v.optional(v.boolean(), false),
});
export type StatementFetch = v.InferOutput<typeof StatementFetchSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a page body says there is no next page: has_more false, a null
 * next, or a page number at total_pages, at the top level or under
 * pagination or meta. undefined when the body says nothing.
 */
export function noMorePages(body: unknown, page: number): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const places = [body, body['pagination'], body['meta']].filter(isRecord);
  for (const p of places) {
    const hasMore = p['has_more'] ?? p['hasMore'];
    if (typeof hasMore === 'boolean') return !hasMore;
    const total = p['total_pages'] ?? p['totalPages'];
    if (typeof total === 'number' && Number.isFinite(total)) return page >= total;
    if ('next' in p && p['next'] === null) return true;
    if ('next_page' in p && p['next_page'] === null) return true;
  }
  return undefined;
}

export type FetchStatementArgs = {
  readonly ctx: ToolContext;
  readonly http: HttpConnector;
  readonly base: string;
  readonly rules: readonly ApiRule[];
  readonly accountId: string;
  /** Sent as x-customer-id. From the IdChain or a chain-checked input. */
  readonly customerId?: string;
  readonly from?: string;
  readonly to?: string;
  /** One page only; walk pages 1.. when undefined. */
  readonly page?: number;
  readonly limit: number;
  readonly signal: AbortSignal;
};

function statusError(status: number): boolean {
  return status < 200 || status >= 300;
}

/** Reads the statement through the admin HTTP connector, page by page. Real mode only. */
export async function fetchStatement(args: FetchStatementArgs): Promise<StatementFetch> {
  const pages: StatementPage[] = [];
  const single = args.page !== undefined;
  const first = args.page ?? 1;
  const last = single ? first : first + STATEMENT_MAX_PAGES - 1;
  let more = false;

  for (let page = first; page <= last; page++) {
    args.signal.throwIfAborted();
    const q: StatementQuery = {
      accountId: args.accountId,
      page,
      limit: args.limit,
      ...(args.from !== undefined ? { from: args.from } : {}),
      ...(args.to !== undefined ? { to: args.to } : {}),
    };
    const decision = decideStatement(args.base, args.rules, q);
    if (!decision.ok) throw new ConnectorError('refused', `ssfb:rhythm statement page refused (${decision.code})`);
    const query = { page: String(page), limit: String(args.limit), ...(q.from !== undefined ? { start_date: q.from } : {}), ...(q.to !== undefined ? { end_date: q.to } : {}) };
    const outcome = await args.http.send(connectorContext(args.ctx, args.signal), {
      entity: SSFB,
      service: RHYTHM,
      method: 'GET',
      url: decision.url,
      decision,
      ...(args.customerId !== undefined ? { customerId: args.customerId } : {}),
      keyInput: { entity: SSFB, service: RHYTHM, method: 'GET', path: decision.pathname, query },
    });
    if (outcome.fixture_miss === true) throw new ConnectorError('refused', 'the statement connector answered from fixtures');
    const { status, body, truncated } = outcome.data;
    pages.push({ page, status, body, truncated });

    if (single || statusError(status) || truncated) break;
    const found = findStatementItems(body);
    if (!found.ok || found.items.length < args.limit) break;
    if (noMorePages(body, page) === true) break;
    if (page === last) more = true;
  }
  return { limit: args.limit, pages, more_available: more };
}

// ------------------------------------------------------------ reading a fetch

export type StatementRead = {
  readonly transactions: readonly StatementTransaction[];
  /** The raw legs, in order, for the reversal join. */
  readonly legs: readonly unknown[];
  readonly pages_fetched: number;
  readonly more_available: boolean;
  /** Where the array was found on the first page that had one. */
  readonly shape: string | null;
  /** Set when a page could not be used. The legs read before it are kept. */
  readonly error: string | null;
  readonly truncated: boolean;
};

/** Parses a fetch (real or fixture) into normalised transactions. Throws on a malformed fixture. */
export function readStatement(value: unknown, tool: string): StatementRead {
  const parsed = v.safeParse(StatementFetchSchema, value);
  if (!parsed.success) throw new Error(`${tool}: the statement answer has the wrong shape`);
  const fetch = parsed.output;
  const legs: unknown[] = [];
  let shape: string | null = null;
  let error: string | null = null;
  let truncated = false;
  for (const page of fetch.pages) {
    if (statusError(page.status)) {
      error = `rhythm answered HTTP ${page.status} on page ${page.page}`;
      break;
    }
    if (page.truncated) {
      error = `page ${page.page} was cut at the size cap and could not be parsed`;
      truncated = true;
      break;
    }
    const found = findStatementItems(page.body);
    if (!found.ok) {
      error =
        found.reason === 'not_json'
          ? `page ${page.page} was not JSON`
          : `page ${page.page} has no transactions array (top-level keys: ${found.top_level_keys.join(', ') || 'none'})`;
      break;
    }
    shape ??= found.shape;
    legs.push(...found.items);
  }
  return {
    transactions: legs.map(normaliseLeg),
    legs,
    pages_fetched: fetch.pages.length,
    more_available: fetch.more_available,
    shape,
    error,
    truncated,
  };
}

// ------------------------------------------------------------ the tool

export const GET_ACCOUNT_STATEMENT = 'get_account_statement';

type StatementAnswer = StatementFetch & { readonly taken_at?: string };

type RunInput = {
  readonly data: unknown;
  readonly signal?: AbortSignal;
  readonly toolCallId: string;
  readonly log: FlueLogger;
  readonly harness?: StagingHarness;
};

function takenAt(value: unknown, deps: ToolDeps): string {
  const t = isRecord(value) ? value['taken_at'] : undefined;
  return typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? t : deps.now().toISOString();
}

async function runStatement(ctx: ToolContext, flue: RunInput): Promise<ToolEnvelope> {
  const deps = ctx.deps;
  const parsed = v.safeParse(GetAccountStatementInputSchema, flue.data);
  const input: Partial<GetAccountStatementInput> = parsed.success ? parsed.output : {};
  const accountId = input.account_id ?? '';
  const customerId = deps.idChain().ids.customer_id;
  const backing = rhythmApiBacking(ctx);

  return runIoTool<'get_account_statement', StatementAnswer>(
    {
      tool: GET_ACCOUNT_STATEMENT,
      service: RHYTHM,
      input: flue.data,
      entity: SSFB,
      backing,
      scope: {},
      gate: () => {
        if (!parsed.success) {
          return { ok: false, message: 'Refused: the input does not match the schema.', reason: 'input failed the schema' };
        }
        if (!inIdChain(deps, accountId)) return outOfChain('account_id');
        if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
          return { ok: false, message: 'Refused: from is after to.', reason: 'date window reversed' };
        }
        const base = rhythmApiBase(ctx);
        // A blank base is answered by the not-configured step that follows.
        if (base === undefined) return { ok: true };
        const rules = ssfbRules(ctx);
        if (!rules.ok) return rules.gate;
        return statementGate(
          decideStatement(base, rules.rules, {
            accountId,
            page: input.page ?? 1,
            limit: STATEMENT_PAGE_SIZE,
            ...(input.from !== undefined ? { from: input.from } : {}),
            ...(input.to !== undefined ? { to: input.to } : {}),
          }),
        );
      },
      fixture: () => ({
        kind: 'get_account_statement',
        entity: SSFB,
        key: semanticKey('get_account_statement', {
          entity: SSFB,
          account_id: accountId,
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
        }),
      }),
      real: async (signal) => {
        const http = deps.connectors.http;
        if (http === undefined) throw new ConnectorError('not_configured', 'no http connector for this run');
        const base = rhythmApiBase(ctx);
        if (base === undefined) throw new ConnectorError('not_configured', `ssfb:rhythm: ${backing.envName} is blank`);
        const rules = ssfbRules(ctx);
        if (!rules.ok) throw new ConnectorError('refused', 'ssfb rules file did not load');
        const taken_at = deps.now().toISOString();
        const fetched = await fetchStatement({
          ctx,
          http,
          base,
          rules: rules.rules,
          accountId,
          ...(customerId !== undefined ? { customerId } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}),
          limit: STATEMENT_PAGE_SIZE,
          signal,
        });
        return { ...fetched, taken_at };
      },
      render: (value) => {
        const read = readStatement(value, GET_ACCOUNT_STATEMENT);
        const shown = read.transactions.slice(0, STATEMENT_MODEL_ROWS);
        return {
          account_id: accountId,
          from: input.from ?? null,
          to: input.to ?? null,
          page: input.page ?? null,
          taken_at: takenAt(value, deps),
          pages_fetched: read.pages_fetched,
          more_available: read.more_available,
          shape: read.shape,
          ...(read.error !== null ? { error: read.error } : {}),
          transaction_count: read.transactions.length,
          transactions: shown,
          transactions_truncated: shown.length < read.transactions.length,
        };
      },
      stage: (value) => {
        const read = readStatement(value, GET_ACCOUNT_STATEMENT);
        return { account_id: accountId, taken_at: takenAt(value, deps), transactions: read.transactions };
      },
      summary: (value) => {
        const read = readStatement(value, GET_ACCOUNT_STATEMENT);
        return `${GET_ACCOUNT_STATEMENT} ssfb:rhythm pages=${read.pages_fetched} legs=${read.transactions.length}`;
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

export const toolModule: ToolModule = Object.freeze({
  name: GET_ACCOUNT_STATEMENT,
  mounts: SSFB_MOUNTS,
  entities: [SSFB],
  enabled: () => ({ on: true }) as const,
  create(ctx: ToolContext): ToolDefinition {
    return defineTool({
      name: GET_ACCOUNT_STATEMENT,
      description:
        'Read the rhythm (SSFB) account statement for one rhythm account id: created_at, type, amount, status, ' +
        'reversal flag, txn_ref_id, UTR (bank_identifier) and narration per leg. The endpoint is fixed; ' +
        'give only the account id, an optional date window and an optional page. The full list is staged to /data.',
      input: GetAccountStatementInputSchema,
      harness: true,
      run: async ({ data, signal, toolCallId, log, harness }): Promise<ToolEnvelope> =>
        runStatement(ctx, {
          data,
          toolCallId,
          log,
          ...(signal !== undefined ? { signal } : {}),
          ...(harness !== undefined ? { harness: harness as unknown as StagingHarness } : {}),
        }),
    });
  },
});
