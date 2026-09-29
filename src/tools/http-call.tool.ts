// http_call: one request to an entity's admin API (HLD 02 §2 http_call row,
// §3 http.ts, §4.4; D8, D26, D31, D40).
//
// The model gives a service name and a path relative to that service's base
// URL, never a URL. Entity and run id come from the closure (D3), and there is
// no headers field: registry auth and x-customer-id (from the IdChain) are
// added by the HTTP connector only.
//
// Every call goes through runIoTool, so the order is fixed: budget, scope
// (ids in path segments, query and body must be in the IdChain), then the
// gate below, then the not-configured check, then the fixture or the
// connector. The gate:
//   1. refuses a service that is not an API service of the entity;
//   2. refuses a body on GET or HEAD;
//   3. joins the base path prefix and the model's path and runs buildUrl,
//      which refuses '..', '//', encoded separators, control bytes, schemes
//      and anything that leaves the base origin or prefix;
//   4. runs evaluateRule from <entity>.api.rules.json on the built pathname
//      relative to the service base (the form the rule templates and the
//      knowledge notes use, HLD §4.4). A template that starts with the base
//      path refuses every call to that service, so a rule written for the
//      full pathname cannot silently miss. The shipped files are empty, so
//      GET and HEAD pass and every other method is blocked with rule_index
//      'default';
//   5. checks the IdChain customer id can go into a header.
// When the base URL is blank, steps 3 and 4 run against a placeholder base so
// a bad path or method is still refused, and the call then answers
// 'not configured for <entity>:<service>'.
//
// finacle on SSFB (D111) goes to the CBS connector instead of the HTTP one:
// GET only (the owner allows the gateway for reads only), the cbs path check
// (letters, digits and / _ . -, no query, no '..'), then decideHttp with
// service finacle against a placeholder origin, since the rules match on the
// path alone and the connector resolves it against SSFB_CBS_GATEWAY_URL
// itself. No customer header is sent. When SSFB_CBS_VIA_KUBECTL_ENABLED is
// not true the call answers not configured with that reason. Mock mode
// answers from the 'cbs_call' fixture kind, a name kept so fixtures recorded
// before the route moved still resolve. Any other service with transport
// 'cbs' has no route.
//
// In real mode the service picklist leaves out services whose base URL or
// auth token is blank, and an entity with none gets no http_call (D75). The
// not-configured answer stays as the second check.
//
// The fixture key is entity, service, method, the relative path and the
// query. The model sees status, the body cut to a size cap, rule_index and
// taken_at; the full body is staged to /data/<toolCallId>.json.

import { Buffer } from 'node:buffer';
import type { FlueLogger } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { ApiCapability, AuthCapability, ServiceSpec } from '../config/registry.ts';
import { CBS_ENTITY, CBS_KEYS, CBS_OFF_REASON, type CbsConnector, createCbsConnector } from '../connectors/cbs/client.ts';
import type { HttpCallData, HttpConnector } from '../connectors/http/client.ts';
import type { MockPort } from '../connectors/mock.ts';
import { ConnectorError, type ConnectorContext } from '../connectors/types.ts';
import {
  buildHeaders,
  buildUrl,
  CALLABLE_METHODS,
  CBS_SERVICE,
  type CallableMethod,
  decideHttp,
  type HttpAllowed,
  MAX_PATH_LENGTH,
  MAX_QUERY_PARAMS,
  type QueryInput,
} from '../gate/http.ts';
import { loadRulesFile, rulesFileName } from '../gate/rules-file.ts';
import { type ApiRule, evaluateRule } from '../gate/rules.ts';
import { type HttpCallFacts, semanticKey } from '../mock/key.ts';
import type { Entity } from '../types/core.ts';
import type { ToolEnvelope } from '../types/tool-result.ts';
import { outcomeData, realConnectorContext } from './_lib/connector-context.ts';
import { type BackingRef, type GateDecision, runIoTool, type StagingHarness } from './_lib/pipeline.ts';
import type { Mount, ToolContext, ToolDeps, ToolModule } from './types.ts';

declare module './_lib/context.ts' {
  interface ToolConnectors {
    /** Admin HTTP for http_call. Missing means http_call answers not configured in real mode. */
    readonly http?: HttpConnector;
    /** The CBS connector for http_call's finacle route. When missing, one is built per run from the registry and config. */
    readonly cbs?: CbsConnector;
  }
}

export const HTTP_CALL_TOOL = 'http_call';

/** Most characters of response body the model sees per call. The full body is staged. */
export const HTTP_BODY_MAX_CHARS = 16_000;

/** Vets the path and method when the service base URL is blank, and for finacle, whose rules match the path alone. Never called. */
const PLACEHOLDER_BASE = 'http://base-not-configured.invalid';

const NO_BODY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

// ------------------------------------------------------------ services

/** The entity's services that list an API env name, finacle included. */
export function apiServices(ctx: Pick<ToolContext, 'registry' | 'entity'>): readonly string[] {
  const entity = ctx.entity;
  if (entity === null || !ctx.registry.isEnabled(entity)) return [];
  const out: string[] = [];
  for (const name of ctx.registry.services(entity)) {
    if (ctx.registry.service(entity, name).api !== undefined) out.push(name);
  }
  return Object.freeze(out.sort());
}

type ServiceFacts = {
  readonly spec: ServiceSpec;
  readonly api: ApiCapability | undefined;
  readonly auth: AuthCapability | undefined;
  /** The registry's CBS flag for the entity. Only read for a cbs transport service. */
  readonly cbsOn: boolean;
};

function serviceFacts(ctx: Pick<ToolContext, 'registry'>, entity: Entity, service: string): ServiceFacts | undefined {
  try {
    const api = ctx.registry.serviceApi(entity, service);
    return {
      spec: ctx.registry.service(entity, service),
      api,
      auth: ctx.registry.serviceAuth(entity, service),
      cbsOn: api?.transport === 'cbs' && ctx.registry.cbsEnabled(entity),
    };
  } catch {
    return undefined;
  }
}

/** The env var behind the call. In real mode a blank auth token also means not configured. */
function backingFor(mockMode: boolean, entity: Entity, service: string, facts: ServiceFacts | undefined): BackingRef {
  const api = facts?.api;
  if (api === undefined) {
    const name = /^[a-z][a-z0-9_]*$/.test(service) ? `${entity}_${service}_API_URL` : `${entity}_API_URL`;
    return { envName: name.toUpperCase(), status: 'missing' };
  }
  if (api.transport === 'cbs') {
    if (facts?.cbsOn !== true) return { envName: CBS_KEYS.flag, status: 'disabled', reason: CBS_OFF_REASON };
    // Mock mode reads no gateway env, so a blank gateway URL does not matter there.
    return { envName: api.envName, status: mockMode ? 'ok' : api.status };
  }
  if (api.status !== 'ok') return { envName: api.envName, status: api.status };
  const auth = facts?.auth;
  if (auth !== undefined && auth.status !== 'ok' && !mockMode) {
    return { envName: auth.envName, status: auth.status };
  }
  return { envName: api.envName, status: 'ok' };
}

/**
 * The API services the model is offered (D75). In real mode a service whose
 * base URL or auth token is blank is left out, since every call to it answers
 * not configured. Mock mode offers every API service: test and eval homes keep
 * every URL blank, and a call there still answers not configured.
 */
export function offeredServices(ctx: Pick<ToolContext, 'registry' | 'entity' | 'config'>): readonly string[] {
  const all = apiServices(ctx);
  const entity = ctx.entity;
  if (entity === null || ctx.config.mock.enabled) return all;
  return Object.freeze(all.filter((s) => backingFor(false, entity, s, serviceFacts(ctx, entity, s)).status === 'ok'));
}

/** Every API service of the entity, and the ones the model is offered. */
type ServiceLists = { readonly known: readonly string[]; readonly offered: readonly string[] };

// ------------------------------------------------------------ rules

// Loaded once per run (keyed by the run's deps), so a rules file edited while
// a run is going does not change the policy half-way.
const runRules = new WeakMap<ToolDeps, Map<Entity, readonly ApiRule[] | null>>();

function rulesFor(ctx: ToolContext, entity: Entity): readonly ApiRule[] | null {
  let byEntity = runRules.get(ctx.deps);
  if (byEntity === undefined) {
    byEntity = new Map();
    runRules.set(ctx.deps, byEntity);
  }
  if (byEntity.has(entity)) return byEntity.get(entity) ?? null;
  let rules: readonly ApiRule[] | null;
  try {
    rules = loadRulesFile(ctx.config.home, entity, ctx.registry.services(entity)).rules;
  } catch {
    // Fail closed: a missing or broken rules file refuses every call.
    rules = null;
  }
  byEntity.set(entity, rules);
  return rules;
}

// ------------------------------------------------------------ gate

export type HttpCallInput = {
  readonly service: string;
  readonly path: string;
  readonly method?: CallableMethod;
  readonly query?: QueryInput;
  readonly body?: unknown;
};

/** What the gate hands to fixture() and real() once every check passed. */
type CallPlan = {
  /** 'cbs' for finacle on SSFB: the CBS connector and the 'cbs_call' fixture kind. */
  readonly route: 'http' | 'cbs';
  readonly method: CallableMethod;
  /** The built pathname relative to the service base, for rules, fixtures and audit. */
  readonly relPath: string;
  readonly decision: HttpAllowed;
  readonly customerId?: string;
};

function deny(message: string, reason: string, rule?: { rule_index: number | 'default'; action: 'block' }): GateDecision {
  return rule === undefined ? { ok: false, message, reason } : { ok: false, message, reason, ...rule };
}

function basePrefix(base: string): string {
  try {
    return new URL(base).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function startsWithPrefix(template: string, prefix: string): boolean {
  return template === prefix || template.startsWith(`${prefix}/`);
}

type GateResult = { readonly gate: GateDecision; readonly plan?: CallPlan };

function decideCall(
  ctx: ToolContext,
  entity: Entity,
  services: ServiceLists,
  facts: ServiceFacts | undefined,
  input: HttpCallInput,
): GateResult {
  const { service } = input;
  const where = `${entity}:${service}`;

  if (!services.known.includes(service) || facts === undefined || facts.api === undefined) {
    return {
      gate: deny(
        `Refused: ${entity} has no HTTP API named that. Use one of: ${services.offered.join(', ')}.`,
        'bad_service: not an API service of the entity',
      ),
    };
  }
  const cbs = facts.api.transport === 'cbs';
  if (cbs && (entity !== CBS_ENTITY || service !== CBS_SERVICE)) {
    return {
      gate: deny(
        `Refused: ${where} is a CBS service, and only ${CBS_SERVICE} on ${CBS_ENTITY} reaches the CBS gateway. Record the gap.`,
        'bad_service: cbs transport without a route',
      ),
    };
  }

  const method = input.method ?? 'GET';
  if (!(CALLABLE_METHODS as readonly string[]).includes(method)) {
    return { gate: deny(`Refused: method must be one of ${CALLABLE_METHODS.join(', ')}.`, 'bad_method') };
  }
  if (input.body !== undefined && NO_BODY_METHODS.has(method)) {
    return { gate: deny(`Refused: ${method} takes no body. Drop body, or pass values in query.`, 'bad_body: body on GET or HEAD') };
  }
  if (cbs) return decideCbs(ctx, entity, input, method);

  const path = input.path;
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return {
      gate: deny(
        "Refused: path must start with '/' and be relative to the service base, such as /admin/v1/x. Never pass a URL.",
        'bad_path',
      ),
    };
  }

  const rules = rulesFor(ctx, entity);
  if (rules === null) {
    return {
      gate: deny(
        `Refused: resources/${rulesFileName(entity)} could not be loaded, so no HTTP call is allowed for ${entity}. Record the gap.`,
        'rules_file: failed to load',
      ),
    };
  }

  const base = facts.api.status === 'ok' ? facts.api.value : PLACEHOLDER_BASE;
  const prefix = basePrefix(base);
  const joined = path === '/' ? prefix || '/' : `${prefix}${path}`;
  const built = buildUrl(base, joined, input.query);
  if (!built.ok) return { gate: deny(`Refused: ${built.message}.`, `${built.code}`) };

  // Templates are relative to the service base. A template that starts with
  // the base path (say /harbor/admin/... for a base ending in /harbor) was
  // written for the full pathname and would never match here, so a block rule
  // in it would silently fall through to the GET default. Refuse instead.
  if (prefix !== '' && rules.some((r) => (r.service === service || r.service === '*') && startsWithPrefix(r.api, prefix))) {
    return {
      gate: deny(
        `Refused: resources/${rulesFileName(entity)} has a ${service} rule that includes the service base path ${prefix}. ` +
          'Rule templates are relative to the service base. No HTTP call is allowed until it is fixed. Record the gap.',
        'rules_file: template includes the base path',
      ),
    };
  }

  const rel = built.pathname.slice(prefix.length);
  const relPath = rel === '' ? '/' : rel;
  const rule = evaluateRule(rules, { service, method, pathname: relPath });
  if (rule.action !== 'allow') {
    const by = rule.rule_index === 'default' ? 'by default (only GET and HEAD are allowed)' : `by rule ${rule.rule_index}`;
    const why = rule.reason === undefined ? '' : `: ${rule.reason}`;
    return {
      gate: deny(
        `Refused: ${method} on this ${where} path is blocked ${by}${why}. If a write is needed, recommend it in the report instead.`,
        `blocked_by_rule ${rule.rule_index}`,
        { rule_index: rule.rule_index, action: 'block' },
      ),
    };
  }

  const customerId = ctx.deps.idChain().ids.customer_id;
  const headers = buildHeaders({
    ...(facts.spec.customer_header !== undefined ? { customerHeader: facts.spec.customer_header } : {}),
    idChain: { ids: customerId !== undefined ? { customer_id: customerId } : {} },
  });
  if (!headers.ok) return { gate: deny(`Refused: ${headers.message}.`, headers.code) };

  const decision: HttpAllowed = {
    ok: true,
    url: built.url,
    pathname: built.pathname,
    method: method as CallableMethod,
    rule_index: rule.rule_index,
    action: 'allow',
    ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
  };
  return {
    gate: { ok: true, rule_index: rule.rule_index, action: 'allow' },
    plan: {
      route: 'http',
      method: method as CallableMethod,
      relPath,
      decision,
      ...(customerId !== undefined ? { customerId } : {}),
    },
  };
}

/** The finacle route: GET only, then decideHttp with service finacle (D111). */
function decideCbs(ctx: ToolContext, entity: Entity, input: HttpCallInput, method: string): GateResult {
  if (method !== 'GET') {
    return {
      gate: deny(
        `Refused: ${CBS_SERVICE} takes GET only; the CBS gateway is read-only for triage. If a write is needed, recommend it in the report instead.`,
        'cbs_get_only',
      ),
    };
  }
  const rules = rulesFor(ctx, entity);
  if (rules === null) {
    return {
      gate: deny(
        `Refused: resources/${rulesFileName(entity)} could not be loaded, so no ${CBS_SERVICE} call is allowed. Record the gap.`,
        'rules_file: failed to load',
      ),
    };
  }
  const path = typeof input.path === 'string' ? input.path : '';
  const decided = decideHttp({
    service: CBS_SERVICE,
    method,
    path,
    ...(input.query !== undefined ? { query: input.query } : {}),
    base: PLACEHOLDER_BASE,
    rules,
  });
  if (!decided.ok) {
    const rule = decided.rule_index !== undefined ? { rule_index: decided.rule_index, action: 'block' as const } : undefined;
    return { gate: deny(`Refused: ${decided.message}.`, decided.code, rule) };
  }
  // The connector requires the decided pathname to equal the path it sends.
  if (decided.pathname !== path) {
    return { gate: deny("Refused: a finacle path must be in plain form (no '.' segments).", 'bad_cbs_path') };
  }
  return {
    gate: { ok: true, rule_index: decided.rule_index, action: 'allow' },
    plan: { route: 'cbs', method: decided.method, relPath: path, decision: decided },
  };
}

// ------------------------------------------------------------ result

const NOT_STUCK_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

const HttpCallDataSchema = v.object({
  status: v.pipe(v.number(), v.integer()),
  body: v.optional(v.unknown(), null),
  truncated: v.optional(v.boolean(), false),
});

type CappedBody = { readonly body: unknown; readonly truncated: boolean; readonly body_bytes: number };

/** Cuts the body to cap characters of its text form. A cut body is returned as text. */
export function capBody(body: unknown, cap: number): CappedBody {
  const text = typeof body === 'string' ? body : (JSON.stringify(body ?? null) ?? 'null');
  const body_bytes = Buffer.byteLength(text, 'utf8');
  if (text.length <= cap) return { body: body ?? null, truncated: false, body_bytes };
  return { body: text.slice(0, cap), truncated: true, body_bytes };
}

function bodyCap(ctx: ToolContext): number {
  return Math.max(1, Math.min(HTTP_BODY_MAX_CHARS, ctx.config.budgets.maxResponseBytesPerCall));
}

// withMock inside the connector would look up fixtures a second time; the
// pipeline's resolveIo already did that and records real results, so the
// connector gets a port that always goes straight to the real call.
const REAL_ONLY_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: false,
  lookup: () => Promise.reject(new Error('http_call: fixture lookups happen in the tool pipeline')),
});

// One CBS connector per run when the deps do not carry one.
const builtCbs = new WeakMap<ToolDeps, CbsConnector>();

function cbsConnectorFor(ctx: ToolContext): CbsConnector {
  const given = ctx.deps.connectors.cbs;
  if (given !== undefined) return given;
  let built = builtCbs.get(ctx.deps);
  if (built === undefined) {
    built = createCbsConnector({ registry: ctx.registry, config: ctx.config });
    builtCbs.set(ctx.deps, built);
  }
  return built;
}

// ------------------------------------------------------------ the call

/** Fixture key facts: entity, service, method, the path relative to the base, and the query. */
function keyFacts(entity: Entity, service: string, plan: CallPlan, input: HttpCallInput): HttpCallFacts {
  return {
    entity,
    service,
    method: plan.method,
    path: plan.relPath,
    ...(input.query !== undefined ? { query: input.query } : {}),
  };
}

type HttpRunInput = {
  readonly data: HttpCallInput;
  readonly signal?: AbortSignal;
  readonly toolCallId: string;
  readonly log: FlueLogger;
  readonly harness?: StagingHarness;
};

async function runHttpCall(ctx: ToolContext, services: ServiceLists, flue: HttpRunInput): Promise<ToolEnvelope> {
  const entity = ctx.entity;
  const deps = ctx.deps;
  const input = flue.data;
  const service = typeof input.service === 'string' ? input.service : '';
  // Only a listed service name goes into audit lines and messages. A known
  // service that is not offered still gets its not-configured answer.
  const serviceName = services.known.includes(service) ? service : 'unknown';
  if (entity === null) throw new Error('http_call needs an entity in the tool context');
  const facts = serviceName === 'unknown' ? undefined : serviceFacts(ctx, entity, serviceName);

  let plan: CallPlan | undefined;
  const planned = (): CallPlan => {
    if (plan === undefined) throw new Error('http_call: the gate did not pass');
    return plan;
  };

  return runIoTool<'http_call' | 'cbs_call', HttpCallData>(
    {
      tool: HTTP_CALL_TOOL,
      service: serviceName,
      input,
      backing: backingFor(deps.fixtures.settings.mockMode, entity, serviceName, facts),
      scope: {},
      gate: () => {
        const result = decideCall(ctx, entity, services, facts, input);
        plan = result.plan;
        return result.gate;
      },
      fixture: () => {
        const p = planned();
        if (p.route === 'cbs') {
          return { kind: 'cbs_call', key: semanticKey('cbs_call', { entity, method: p.method, path: p.relPath }) };
        }
        return { kind: 'http_call', key: semanticKey('http_call', keyFacts(entity, serviceName, p, input)) };
      },
      // GET and HEAD only; any other method runs every time (D79).
      repeat: () => NO_BODY_METHODS.has(input.method ?? 'GET') && input,
      real: async (signal) => {
        const p = planned();
        if (p.route === 'cbs') {
          const out = await cbsConnectorFor(ctx).call(realConnectorContext(ctx, signal), {
            path: p.relPath,
            method: p.method,
            decision: p.decision,
            keyInput: { entity, service: CBS_SERVICE, method: p.method, path: p.relPath },
          });
          const res = outcomeData(out);
          return { status: res.status, body: res.body, truncated: false, rule_index: p.decision.rule_index };
        }
        const connector = deps.connectors.http;
        if (connector === undefined) throw new ConnectorError('not_configured', 'no HTTP connector for this run');
        const connectorCtx: ConnectorContext = {
          signal,
          now: deps.now,
          mock: REAL_ONLY_PORT,
          runId: ctx.runId,
          redactionNames: deps.run.redactionNames,
        };
        const outcome = await connector.send(connectorCtx, {
          entity,
          service: serviceName,
          method: p.method,
          url: p.decision.url,
          decision: p.decision,
          ...(p.customerId !== undefined ? { customerId: p.customerId } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          keyInput: keyFacts(entity, serviceName, p, input),
        });
        if (outcome.fixture_miss === true) throw new ConnectorError('unreachable', 'the HTTP connector returned no data');
        return outcome.data;
      },
      render: (value) => {
        const p = planned();
        const parsed = v.safeParse(HttpCallDataSchema, value);
        if (!parsed.success) throw new Error('http_call: the http_call answer has the wrong shape');
        const capped = capBody(parsed.output.body, bodyCap(ctx));
        return {
          service: serviceName,
          method: p.method,
          path: p.relPath,
          status: parsed.output.status,
          body: capped.body,
          truncated: capped.truncated || parsed.output.truncated,
          body_bytes: capped.body_bytes,
          rule_index: p.decision.rule_index,
        };
      },
      stage: (value) => value,
      // A client error is a variation that did not work: found nothing, for the stuck count (P6).
      // Auth and throttling are not the model's query, so they do not count.
      empty: (value) => v.is(HttpCallDataSchema, value) && value.status >= 400 && value.status < 500 && !NOT_STUCK_STATUSES.has(value.status),
      summary: (value) => {
        const p = planned();
        const status = v.is(HttpCallDataSchema, value) ? String(value.status) : 'unknown';
        return `${HTTP_CALL_TOOL} ${entity}:${serviceName} ${p.method} ${p.relPath} -> ${status}`;
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

const ScalarSchema = v.union([v.string(), v.number(), v.boolean()]);

const SERVICE_TEXT = 'The entity service whose admin API to call.';
const FINACLE_NOTE =
  "finacle is the bank's Finacle CBS gateway, for balances, holds and account state the admin APIs do not show: " +
  'GET only, no query, and a path of letters, digits and / _ . - such as /misc/api/crm/savingaccount/<account_number>';

// Described only when the gateway is on; in mock mode finacle is still offered and answers not configured.
const finacleDescribed = (ctx: ToolContext, offered: readonly string[]): boolean =>
  offered.includes(CBS_SERVICE) && ctx.entity === CBS_ENTITY && ctx.registry.cbsEnabled(CBS_ENTITY);

function inputSchema(services: readonly string[], finacle: boolean) {
  const serviceSchema =
    services.length > 0
      ? v.picklist(services as [string, ...string[]])
      : v.pipe(v.string(), v.minLength(1));
  return v.strictObject({
    service: v.pipe(
      serviceSchema,
      v.description(finacle ? `${SERVICE_TEXT} ${FINACLE_NOTE}.` : SERVICE_TEXT),
    ),
    path: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_PATH_LENGTH),
      v.description(
        "Path relative to the service base URL, starting with '/', such as /admin/v1/customers/<customer_id>. " +
          "Never a URL. No '..', '//', '?' or '#'; put query parameters in query.",
      ),
    ),
    method: v.pipe(
      v.optional(v.picklist(CALLABLE_METHODS), 'GET'),
      v.description('HTTP method. GET by default. Only GET and HEAD are allowed unless the rules file allows more.'),
    ),
    query: v.pipe(
      v.optional(
        v.pipe(
          v.record(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.\-[\]]+$/)), v.union([ScalarSchema, v.array(ScalarSchema)])),
          v.check((q) => Object.keys(q).length <= MAX_QUERY_PARAMS, `at most ${MAX_QUERY_PARAMS} query parameters`),
        ),
      ),
      v.description('Query parameters as key to value. Values are encoded for you.'),
    ),
    body: v.pipe(
      v.optional(v.record(v.string(), v.unknown())),
      v.description('JSON object body. Only for methods a rule allows; never on GET or HEAD.'),
    ),
  });
}

const DESCRIPTION =
  "Calls the entity's admin API for one service and returns status, the body cut to a size cap, " +
  "rule_index and taken_at. Give a path relative to the service, never a URL. GET and HEAD work; other methods " +
  'are refused unless the rules file allows them. Ids in the path, query or body must be in the ID chain. ' +
  'Auth and the customer header are added for you. The full body is also written to /data/<call id>.json.';

export const toolModule: ToolModule = Object.freeze({
  name: HTTP_CALL_TOOL,
  mounts: Object.freeze(['investigator', 'agent'] as const),
  entities: 'all' as const,
  perEntity: true as const,
  enabled(ctx: ToolContext) {
    if (ctx.entity === null) return { on: false, reason: 'http_call needs an entity' } as const;
    if (offeredServices(ctx).length === 0) {
      return { on: false, reason: `${ctx.entity} has no HTTP API service configured` } as const;
    }
    return { on: true } as const;
  },
  create(ctx: ToolContext, mount: Mount): ToolDefinition {
    const services: ServiceLists = { known: apiServices(ctx), offered: offeredServices(ctx) };
    // The agent mount merges every entity's service input into one (D110), so there the finacle note goes in entityLine.
    const finacle = mount !== 'agent' && finacleDescribed(ctx, services.offered);
    return defineTool({
      name: HTTP_CALL_TOOL,
      description: DESCRIPTION,
      input: inputSchema(services.offered, finacle),
      harness: true,
      run: async ({ data, signal, toolCallId, log, harness }): Promise<ToolEnvelope> =>
        runHttpCall(ctx, services, {
          data: data as HttpCallInput,
          toolCallId,
          log,
          ...(harness !== undefined ? { harness } : {}),
          ...(signal !== undefined ? { signal } : {}),
        }),
    });
  },
  entityLine(ctx: ToolContext): string {
    const offered = offeredServices(ctx);
    const line = `services ${offered.join(', ')}`;
    return finacleDescribed(ctx, offered) ? `${line}; ${FINACLE_NOTE}` : line;
  },
});
