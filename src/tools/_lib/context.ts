// The run dependencies every tool reads inside run(). This file adds them to
// T01.6's ToolDeps with module augmentation, and createToolDeps() builds them
// once per run (the agents area calls it). Tools still get entity and run id
// from ToolContext, never from their input schema (D3).
//
// The IdChain is held here, not copied into each tool: deps.idChain() is a
// getter, so when resolve_identity (T05.5) widens the chain mid-run, later
// calls see the wider scope. widenIdChain() is the only way to change it, and
// it only ever adds ids to the scope set.

import * as v from 'valibot';
import type { EscalationStore } from '../../agents/escalation.ts';
import { escalationFor } from '../../agents/escalation.ts';
import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import type { AuditSink } from '../../gate/audit-sink.ts';
import { createJsonlAuditSink } from '../../gate/audit-sink.ts';
import { createRunBudget, type EntityLimits, getRunBudget, type RunBudget } from '../../gate/budget.ts';
import { createScopeSet, extendScopeSet, type ScopeSet } from '../../gate/scope.ts';
import { createMockLayer, type MockLayer } from '../../mock/index.ts';
import type { RunStore } from '../../runstore/types.ts';
import type { Entity, Interface, RunId, TimeWindow } from '../../types/core.ts';
import { type IdChain, IdChainSchema } from '../../types/id-chain.ts';
import type { ToolDeps } from '../types.ts';

/**
 * Real connectors (SQL, HTTP, Quickwit, CBS, ...). Empty here; each connector
 * area adds its field with
 * `declare module '<path>/src/tools/_lib/context.ts' { interface ToolConnectors { sql: SqlConnector } }`.
 * Tools reach connectors only through the real() callback they hand to runIoTool.
 */
export interface ToolConnectors {}

/** Facts about the run that audit lines and redaction need. */
export type ToolRunInfo = {
  /** Where the run came from, for the audit line. */
  readonly interface: Interface;
  /** Names collected by ingress, for the persisted profile (D24). */
  readonly redactionNames: readonly string[];
  /** The request window from ingress. logs_search uses it when the model gives no from/to. */
  readonly window?: TimeWindow;
};

declare module '../types.ts' {
  interface ToolDeps {
    readonly budget: RunBudget;
    readonly audit: AuditSink;
    /** Mock settings, fixture store and resolveIo (D19, D27). */
    readonly fixtures: MockLayer;
    readonly connectors: ToolConnectors;
    readonly runStore: RunStore;
    readonly escalation: EscalationStore;
    readonly run: ToolRunInfo;
    /** Clock for taken_at, audit ts and durations. */
    readonly now: () => Date;
    /** The run's current IdChain. A getter, so a widened chain is seen by later calls. */
    idChain(): IdChain;
  }
}

export type CreateToolDepsOptions = {
  readonly runId: RunId;
  readonly config: Config;
  readonly interface: Interface;
  /** The chain resolved by the ingress identity step. */
  readonly idChain: IdChain;
  readonly connectors: ToolConnectors;
  readonly runStore: RunStore;
  /** Used for the per-entity Quickwit hit caps of a budget built here. */
  readonly registry?: Registry;
  readonly redactionNames?: readonly string[];
  /** TriageRequest.window. Without it logs_search falls back to the lookback days up to now. */
  readonly requestWindow?: TimeWindow;
  /** Fixtures under cases/<caseId>/ are checked first (evals). */
  readonly caseId?: string;
  /**
   * Optional fields other areas declare on ToolDeps, such as finish_report's
   * initialData and usage (T06.9), set by the Triage root (T06.8). They sit on
   * the same deps object, so widenIdChain still finds it. Core fields win.
   */
  readonly extra?: Partial<ToolDeps>;
  // Overrides, mostly for tests. Each defaults to the real thing.
  readonly budget?: RunBudget;
  readonly audit?: AuditSink;
  readonly fixtures?: MockLayer;
  readonly escalation?: EscalationStore;
  readonly now?: () => Date;
};

type ChainHolder = { chain: IdChain; scope: ScopeSet };

// Keyed by the deps object, so only code holding the deps can widen the chain,
// and the chain never sits on an enumerable property a tool could overwrite.
const holders = new WeakMap<ToolDeps, ChainHolder>();

export class IdChainError extends Error {
  override readonly name = 'IdChainError';
}

function parseChain(chain: unknown): IdChain {
  const parsed = v.safeParse(IdChainSchema, chain);
  if (!parsed.success) {
    const fields = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(chain)'))];
    throw new IdChainError(`invalid IdChain (${fields.join(', ')})`);
  }
  return parsed.output;
}

function perEntityLimits(config: Config, registry: Registry | undefined): Partial<Record<Entity, EntityLimits>> {
  const out: Partial<Record<Entity, EntityLimits>> = {};
  if (registry === undefined) return out;
  for (const entity of registry.entities) {
    if (!config.entities.includes(entity)) continue;
    const qw = registry.quickwit(entity);
    if (qw.status === 'ok') out[entity] = { maxHits: qw.maxHits };
  }
  return out;
}

function budgetFor(opts: CreateToolDepsOptions): RunBudget {
  if (opts.budget !== undefined) return opts.budget;
  // The tripwire (T06.7) may have made the run's budget first; share it.
  const existing = getRunBudget(opts.runId);
  if (existing !== undefined) return existing;
  const { budgets, sql } = opts.config;
  return createRunBudget({
    runId: opts.runId,
    maxToolCalls: budgets.maxToolCallsPerRun,
    maxTasks: budgets.maxTasksPerRun,
    maxRowsPerCall: sql.maxRows,
    maxBytesPerCall: budgets.maxResponseBytesPerCall,
    maxBytesPerRun: budgets.maxBytesPerRun,
    perEntity: perEntityLimits(opts.config, opts.registry),
  });
}

/** Builds the ToolDeps for one run. Call once per run. */
export function createToolDeps(opts: CreateToolDepsOptions): ToolDeps {
  const chain = parseChain(opts.idChain);
  const holder: ChainHolder = { chain, scope: createScopeSet(chain) };

  const fixtures =
    opts.fixtures ??
    createMockLayer(opts.config, {
      home: opts.config.home,
      ...(opts.caseId !== undefined ? { caseId: opts.caseId } : {}),
    });
  const audit =
    opts.audit ?? createJsonlAuditSink({ auditLogPath: opts.config.paths.auditLog, runsDir: opts.config.paths.runsDir });

  const deps: ToolDeps = Object.freeze({
    ...opts.extra,
    budget: budgetFor(opts),
    audit,
    fixtures,
    connectors: opts.connectors,
    runStore: opts.runStore,
    escalation: opts.escalation ?? escalationFor(opts.runId),
    run: Object.freeze({
      interface: opts.interface,
      redactionNames: Object.freeze([...(opts.redactionNames ?? [])]),
      ...(opts.requestWindow !== undefined ? { window: Object.freeze({ ...opts.requestWindow }) } : {}),
    }),
    now: opts.now ?? (() => new Date()),
    idChain: () => holder.chain,
  });
  holders.set(deps, holder);
  return deps;
}

/**
 * Replaces the run's IdChain with a wider one. For resolve_identity (T05.5)
 * only; deciding which new ids may join is that tool's job. Ids already in
 * scope stay in scope even if the new chain drops them.
 */
export function widenIdChain(deps: ToolDeps, next: IdChain): IdChain {
  const holder = holders.get(deps);
  if (holder === undefined) throw new IdChainError('these deps were not built by createToolDeps');
  const chain = parseChain(next);
  holder.chain = chain;
  holder.scope = extendScopeSet(holder.scope, chain);
  return chain;
}

/**
 * The scope set for the next call. Reads deps.idChain() every time, so the
 * pipeline always sees the current chain. Deps built by createToolDeps keep
 * every id that was ever in scope; other deps (tests) derive it from the chain.
 */
export function scopeSetOf(deps: ToolDeps): ScopeSet {
  const chain = deps.idChain();
  const holder = holders.get(deps);
  if (holder !== undefined && holder.chain === chain) return holder.scope;
  return createScopeSet(chain);
}
