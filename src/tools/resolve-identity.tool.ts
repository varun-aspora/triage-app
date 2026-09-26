// resolve_identity: re-runs the deterministic ID chain mid-run when a new id
// turns up (HLD 02 §1.1, §1.5 and the §2 tool table; LLD 04 §2.2; D22, D26, D69).
//
// Mounted on Triage only. The input is { ids, entity_hint? }: no SQL, path,
// query, entity or run id. Every read is one of the fixed statements in
// identity-statements.ts, run by resolveIdChain() from identity-core.ts, the
// same code the ingress identity step uses.
//
// Order: signal -> budget (one tool call) -> at least one id -> one
// resolveIdChain() per model-supplied id -> scope decision -> widen the run
// IdChain -> model-facing redaction -> envelope. A hop that failed comes back
// as unreachable, and the result's errors list says why (the connector's
// text, scrubbed and capped) with a hint for what to try instead.
//
// The core does the mock branch (per-hop 'resolve_identity' fixtures, a strict
// miss throws) and writes one audit line per fixed statement with the DSN's env
// var name as target. runIoTool is not used because it assumes one backing env
// var and one fixture per call, and this tool reads up to five databases.
//
// Scope rule: each model-supplied id is resolved on its own, so every other id
// in its result came from a hop. The result joins the run IdChain only when the
// id is already in scope, or when a hop produced an id that is in scope (or in
// a result that already joined). An id that resolves with no such link comes
// back 'unverified', does not widen scope and has its derived ids withheld.
//
// The description of each id key comes from resources/known-ids.json (D69),
// read when the tool is created, so the model sees the same text the ingress
// decision questions are built from.

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { knownIdFieldsFor } from '../config/known-ids.ts';
import type { SqlConnector } from '../connectors/sql/pg-client.ts';
import { mockPortFromFixtures } from '../connectors/mock.ts';
import { safeErrorText, stripAddresses } from '../connectors/error-text.ts';
import { ConnectorError } from '../connectors/types.ts';
import { makeAuditLine } from '../gate/audit.ts';
import { extractIdShaped } from '../gate/id-patterns.ts';
import { redactModelFacing } from '../gate/redact.ts';
import { extendScopeSet, inScope, type ScopeSet } from '../gate/scope.ts';
import type { AuditDecision } from '../types/audit.ts';
import { ENTITIES, KNOWN_ID_KEYS, type KnownIdKey, type KnownIds } from '../types/core.ts';
import type { BasicStateItem, IdChain, IdHop } from '../types/id-chain.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import { scopeSetOf, widenIdChain } from './_lib/context.ts';
import { IDENTITY_TOOL, type IdChainResult, type IdentityCoreDeps, resolveIdChain } from './_lib/identity-core.ts';
import { IDENTITY_STATEMENTS } from './_lib/identity-statements.ts';
import type { ToolContext, ToolDeps, ToolModule } from './types.ts';

declare module './_lib/context.ts' {
  interface ToolConnectors {
    /** Postgres for sql_select and resolve_identity. Missing means real reads are unreachable. */
    readonly sql?: SqlConnector;
  }
}

export const RESOLVE_IDENTITY = IDENTITY_TOOL;

/** The audit target for lines this file writes itself: harbor, where most hops run. */
const FALLBACK_TARGET = 'SSFB_HARBOR_DB_URL';

const ID_MAX_CHARS = 128;

// ------------------------------------------------------------ input schema

/**
 * Each key's description from resources/known-ids.json (the home's, else the
 * shipped copy, as the ingress identity step reads it). Throws RegistryError
 * when the file is bad.
 */
function keyHints(ctx: Pick<ToolContext, 'config'>): Readonly<Record<KnownIdKey, string>> {
  const hints = {} as Record<KnownIdKey, string>;
  for (const field of knownIdFieldsFor(ctx.config)) hints[field.key] = field.description;
  return Object.freeze(hints);
}

const IdValueSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(ID_MAX_CHARS),
  v.regex(/^[A-Za-z0-9+@._:-]+$/, 'an id is letters, digits and + @ . _ : - only'),
);

function idField(hint: string) {
  return v.optional(v.pipe(IdValueSchema, v.description(hint)));
}

function inputSchema(hints: Readonly<Record<KnownIdKey, string>>) {
  const idEntries = {} as Record<KnownIdKey, ReturnType<typeof idField>>;
  for (const key of KNOWN_ID_KEYS) idEntries[key] = idField(hints[key]);
  return v.object({
    // Strict: an unknown key inside ids (sql, path, query, ...) is refused.
    ids: v.pipe(v.strictObject(idEntries), v.description('The ids to resolve, by kind. At least one.')),
    entity_hint: v.optional(
      v.pipe(
        v.picklist(ENTITIES),
        v.description('Which entity you think the ids belong to. Recorded only; the hop table decides what is read.'),
      ),
    ),
  });
}

/** Builds the input schema for this context, with key descriptions from resources/known-ids.json. */
export function resolveIdentityInputSchema(ctx: Pick<ToolContext, 'config'>) {
  return inputSchema(keyHints(ctx));
}
export type ResolveIdentityInput = v.InferOutput<ReturnType<typeof inputSchema>>;

const description =
  'Resolve ids that surfaced mid-run (for example a form id in a log line) through the fixed ID-chain lookups ' +
  'and add them to the run ID chain, so later investigator calls may use them. You pass ids only; the lookups ' +
  'are fixed. Each id comes back with a status: in_chain (already known, re-resolved), linked (a lookup tied ' +
  'it to the run customer, so it and the ids it led to were added), unverified (it resolved but nothing ties ' +
  'it to the run customer; it was NOT added and other tools will refuse it), not_found, or unreachable (a ' +
  'database did not answer; errors says why). Returns the updated id_chain with per-hop status and taken_at, ' +
  'and errors when a lookup failed: look those ids up with sql_select or logs_search, or record the gap.';

// ------------------------------------------------------------ results

export const SEED_STATUSES = ['in_chain', 'linked', 'unverified', 'not_found', 'unreachable'] as const;
export type SeedStatus = (typeof SEED_STATUSES)[number];

export type SeedResult = {
  readonly key: KnownIdKey;
  readonly status: SeedStatus;
  /** Keys newly written into id_chain.ids. */
  readonly added: readonly KnownIdKey[];
  /** Keys whose value joined scope while id_chain.ids already held another value for that key. */
  readonly in_scope_only: readonly KnownIdKey[];
  /** The hops run for this id. Hops name keys, never values. */
  readonly hops: readonly IdHop[];
};

type Seed = { readonly key: KnownIdKey; readonly value: string; readonly result: IdChainResult };

const JOINS: ReadonlySet<SeedStatus> = new Set(['in_chain', 'linked']);

// ------------------------------------------------------------ helpers

function seedsOf(ids: ResolveIdentityInput['ids']): { key: KnownIdKey; value: string }[] {
  const out: { key: KnownIdKey; value: string }[] = [];
  for (const key of KNOWN_ID_KEYS) {
    const value = ids[key];
    if (typeof value === 'string' && value !== '') out.push({ key, value });
  }
  return out;
}

/** Ids a seed may contribute: all of its result except those an unverified hop produced. */
function joinable(seed: Seed): [KnownIdKey, string][] {
  const fromUnverified = new Set(
    seed.result.id_chain.hops.filter((h) => h.status === 'unverified' && h.to !== undefined).map((h) => h.to),
  );
  const out: [KnownIdKey, string][] = [];
  for (const [key, value] of Object.entries(seed.result.id_chain.ids) as [KnownIdKey, string | undefined][]) {
    if (value === undefined) continue;
    if (key !== seed.key && fromUnverified.has(key)) continue;
    out.push([key, value]);
  }
  return out;
}

class ScopeView {
  private scope: ScopeSet;
  private readonly exact: Set<string>;

  constructor(scope: ScopeSet, chain: IdChain) {
    this.scope = scope;
    this.exact = new Set(Object.values(chain.ids).filter((x): x is string => typeof x === 'string'));
  }

  has(value: string): boolean {
    if (this.exact.has(value)) return true;
    const shaped = extractIdShaped(value);
    return shaped.length > 0 && shaped.every((id) => inScope(this.scope, id));
  }

  add(pairs: readonly [KnownIdKey, string][]): void {
    for (const [key, value] of pairs) {
      this.exact.add(value);
      this.scope = extendScopeSet(this.scope, { ids: { [key]: value }, hops: [], basic_state: [] });
    }
  }
}

/** Decides each seed's status. Repeats until stable, so a link through another joined seed counts. */
function decide(seeds: readonly Seed[], view: ScopeView): SeedStatus[] {
  const status: (SeedStatus | undefined)[] = seeds.map(() => undefined);
  let changed = true;
  while (changed) {
    changed = false;
    seeds.forEach((seed, i) => {
      if (status[i] !== undefined) return;
      const pairs = joinable(seed);
      let found: SeedStatus | undefined;
      if (view.has(seed.value)) found = 'in_chain';
      else if (pairs.some(([key, value]) => key !== seed.key && view.has(value))) found = 'linked';
      if (found === undefined) return;
      status[i] = found;
      view.add(pairs);
      changed = true;
    });
  }
  return seeds.map((seed, i) => status[i] ?? leftOut(seed.result.id_chain.hops));
}

function leftOut(hops: readonly IdHop[]): SeedStatus {
  if (hops.some((h) => h.status === 'resolved' || h.status === 'unverified')) return 'unverified';
  if (hops.some((h) => h.status === 'unreachable')) return 'unreachable';
  return 'not_found';
}

/** Newer reads replace older items of the same name, unless the newer one could not be read. */
function mergeState(base: readonly BasicStateItem[], next: readonly BasicStateItem[]): BasicStateItem[] {
  const out = [...base];
  for (const item of next) {
    const i = out.findIndex((o) => o.item === item.item);
    if (i < 0) out.push(item);
    else if (item.status !== 'unreachable' || out[i]?.status === 'unreachable') out[i] = item;
  }
  return out;
}

type Merge = { chain: IdChain; results: SeedResult[]; scopeOnly: Partial<KnownIds>[] };

function merge(current: IdChain, seeds: readonly Seed[], statuses: readonly SeedStatus[]): Merge {
  const ids: { -readonly [K in KnownIdKey]?: string } = { ...current.ids };
  let hops = [...current.hops];
  let state = [...current.basic_state];
  const scopeOnly: Partial<KnownIds>[] = [];
  const results = seeds.map((seed, i): SeedResult => {
    const status = statuses[i] as SeedStatus;
    const added: KnownIdKey[] = [];
    const extra: KnownIdKey[] = [];
    if (JOINS.has(status)) {
      for (const [key, value] of joinable(seed)) {
        if (ids[key] === undefined) {
          ids[key] = value;
          added.push(key);
        } else if (ids[key] !== value) {
          scopeOnly.push({ [key]: value });
          extra.push(key);
        }
      }
      hops = [...hops, ...seed.result.id_chain.hops];
      state = mergeState(state, seed.result.id_chain.basic_state);
    }
    return { key: seed.key, status, added, in_scope_only: extra, hops: seed.result.id_chain.hops };
  });
  return { chain: { ids, hops, basic_state: state }, results, scopeOnly };
}

/**
 * Writes the merged chain. KnownIds holds one value per key, so an id whose key
 * is already taken is put in scope by a first widen with it in place, then the
 * chain is set back to the merged one. Scope keeps every id it has seen.
 */
function widen(deps: ToolDeps, m: Merge): IdChain {
  for (const extra of m.scopeOnly) widenIdChain(deps, { ...m.chain, ids: { ...m.chain.ids, ...extra } });
  return widenIdChain(deps, m.chain);
}

function auditTarget(ctx: ToolContext): string {
  const harbor = IDENTITY_STATEMENTS.customer_id;
  try {
    return ctx.registry.service(harbor.entity, harbor.service).db ?? FALLBACK_TARGET;
  } catch {
    return FALLBACK_TARGET;
  }
}

function missingSql(): Pick<SqlConnector, 'runSelect'> {
  return {
    runSelect: () => Promise.reject(new ConnectorError('not_configured', 'no sql connector for this run')),
  };
}

// ------------------------------------------------------------ the call

type RunInput = { readonly data: ResolveIdentityInput; readonly signal?: AbortSignal };

async function runResolveIdentity(ctx: ToolContext, flue: RunInput): Promise<ToolEnvelope> {
  const signal = flue.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  const deps = ctx.deps;
  const now = deps.now;
  const started = now().getTime();
  const mockMode = deps.fixtures.settings.mockMode;
  const target = auditTarget(ctx);
  const audit = (decision: AuditDecision, exit: string, summary: string, reason?: string, mock = mockMode): void => {
    deps.audit.write(
      makeAuditLine(
        {
          run_id: ctx.runId,
          ts: now().toISOString(),
          interface: deps.run.interface,
          entity: null,
          tool: RESOLVE_IDENTITY,
          decision,
          ...(reason !== undefined ? { reason } : {}),
          service: IDENTITY_STATEMENTS.customer_id.service,
          target,
          transport: mock ? 'mock' : 'real',
          summary,
          duration_ms: Math.max(0, now().getTime() - started),
          exit,
        },
        { names: deps.run.redactionNames },
      ),
    );
  };

  const budget = deps.budget.consumeToolCall(RESOLVE_IDENTITY);
  if (!budget.ok) {
    if (budget.reason !== 'entity_calls') deps.escalation.markBudgetExhausted();
    audit('deny', 'refused', `${RESOLVE_IDENTITY}: budget`, `budget: ${budget.reason}`);
    return refused(budget.message, now);
  }

  const wanted = seedsOf(flue.data.ids);
  if (wanted.length === 0) {
    audit('deny', 'refused', `${RESOLVE_IDENTITY}: no ids`, 'input: no ids');
    return refused('Refused: send at least one id in ids.', now);
  }

  const core: IdentityCoreDeps = {
    sql: deps.connectors.sql ?? missingSql(),
    mock: mockPortFromFixtures(deps.fixtures),
    audit: deps.audit,
    now,
    signal,
    entities: ctx.registry,
    run: { runId: ctx.runId, interface: deps.run.interface, redactionNames: deps.run.redactionNames },
    sqlTimeouts: { statementTimeoutMs: ctx.config.sql.statementTimeoutMs, lockTimeoutMs: ctx.config.sql.lockTimeoutMs },
  };

  const seeds: Seed[] = [];
  for (const { key, value } of wanted) {
    try {
      seeds.push({ key, value, result: await resolveIdChain({ [key]: value }, core) });
    } catch (err) {
      if (!signal.aborted && err instanceof ConnectorError && err.code === 'strict_miss') {
        audit('allow', 'fixture_miss', `${RESOLVE_IDENTITY} ${key}: strict fixture miss`, undefined, true);
      }
      throw err;
    }
  }

  const current = deps.idChain();
  const statuses = decide(seeds, new ScopeView(scopeSetOf(deps), current));
  const merged = merge(current, seeds, statuses);
  const joined = merged.results.some((r) => JOINS.has(r.status));
  const chain = joined ? widen(deps, merged) : current;

  const left = merged.results.filter((r) => !JOINS.has(r.status));
  if (left.length > 0) {
    const list = left.map((r) => `${r.key} ${r.status}`).join(', ');
    audit('deny', 'refused', `${RESOLVE_IDENTITY}: ${left.length} id(s) not added`, `scope: not added to the ID chain (${list})`);
  }

  const errors = hopErrors(seeds);
  const data = {
    results: merged.results,
    id_chain: chain,
    ...(errors.length > 0 ? { errors, errors_hint: HOP_ERRORS_HINT } : {}),
    ...(flue.data.entity_hint !== undefined ? { entity_hint: flue.data.entity_hint } : {}),
  };
  return ok(JSON.parse(JSON.stringify(redactModelFacing(data))) as unknown, now);
}

// ------------------------------------------------------------ hop errors

const HOP_ERRORS_HINT =
  'These statements failed, so the ids they would have given are missing. Look the ids up with sql_select or logs_search on the ' +
  'same service, or retry resolve_identity later; record the gap if nothing else answers.';

/**
 * Why hops failed, one entry per hop and reason across all seeds. The text
 * is the connector's (DSN parts already scrubbed), scrubbed again and capped
 * here; the model-facing redaction runs over the whole result after.
 */
function hopErrors(seeds: readonly Seed[]): { hop: string; source: string; code: string; error: string }[] {
  const out = new Map<string, { hop: string; source: string; code: string; error: string }>();
  for (const seed of seeds) {
    for (const e of seed.result.errors ?? []) {
      const error = safeErrorText(stripAddresses(e.error));
      const key = `${e.hop}\u0000${e.code}\u0000${error}`;
      if (!out.has(key)) out.set(key, { hop: e.hop, source: e.source, code: e.code, error });
    }
  }
  return [...out.values()];
}

// ------------------------------------------------------------ the module

function create(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: RESOLVE_IDENTITY,
    description,
    input: resolveIdentityInputSchema(ctx),
    run: async ({ data, signal }): Promise<ToolEnvelope> =>
      runResolveIdentity(ctx, { data, ...(signal !== undefined ? { signal } : {}) }),
  });
}

const HOP_ENTITIES = [...new Set(Object.values(IDENTITY_STATEMENTS).map((s) => s.entity))];

export const toolModule: ToolModule = {
  name: RESOLVE_IDENTITY,
  mounts: ['triage'],
  entities: 'all',
  enabled(ctx) {
    if (HOP_ENTITIES.some((e) => ctx.registry.isEnabled(e))) return { on: true };
    return { on: false, reason: `none of ${HOP_ENTITIES.join(', ')} is in TRIAGE_ENTITIES` };
  },
  create,
};
