// The scout (plan 15 P4): locate on the intake's ids before the first
// dispatch, so the root starts from where the user's data is rather than
// from the classifier's guess.
//
// runScout takes the chain ids, then the seed leads, that are one whole id
// (at most MAX_SCOUT_VALUES), and runs runLocate on each across every enabled
// entity, one after another, with the ToolContext of an agent named 'scout'.
// Everything locate does applies: scope, the run's probe budget (the agent's
// later locate calls take from what is left), one audit line per value,
// counts only. The run's tool-call budget is not charged: it caps the model's
// calls, and the scout is not one. Its repeat cache holds each result, so the
// agent's locate on the same value and entities costs no probe.
//
// Each value becomes one line for the run section, "<masked> -> <ranked
// places>", with the value masked by maskId and the whole line through the
// persisted profile, because it rides in initialData and Flue state. A value
// locate refuses gets a "not located" line; one that throws also becomes a
// gap. Only an abort stops the scout; the caller turns any other throw into
// a gap.

import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import type { AuditSink } from '../../gate/audit-sink.ts';
import type { RunBudget } from '../../gate/budget.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { maskId } from '../../gate/scope.ts';
import type { MockLayer } from '../../mock/index.ts';
import type { RunStore } from '../../runstore/types.ts';
import { type Interface, KNOWN_ID_KEYS, type RunId, type TimeWindow } from '../../types/core.ts';
import type { IdChain } from '../../types/id-chain.ts';
import type { ToolEnvelope } from '../../types/tool-result.ts';
import { locateProbesUsed, runLocate } from '../locate.tool.ts';
import type { ToolContext } from '../types.ts';
import { createToolDeps, type ToolConnectors } from './context.ts';
import { type ValueKind, valueKind } from './schema-catalogue.ts';

/** The agent name on the scout's audit lines and repeat-cache entries. */
export const SCOUT_AGENT = 'scout';

/** Most values the scout locates. */
export const MAX_SCOUT_VALUES = 5;

/** Most ranked places a value's line shows, besides each entity's "nothing" line; the rest are counted. */
export const MAX_SCOUT_PLACES = 5;

// A message from a refusal is cut to this, so a line stays readable.
const MESSAGE_MAX_CHARS = 160;

/** What runScout needs from the runtime. TriageRuntime has all of it. */
export type ScoutEnv = {
  readonly config: Config;
  readonly registry: Registry;
  readonly connectors: ToolConnectors;
  readonly runStore: RunStore;
  readonly audit?: AuditSink;
  /** The mock layer the intake uses. Left out: one is built from the config. */
  readonly fixtures?: MockLayer;
  readonly caseId?: string;
  readonly now?: () => Date;
};

export type ScoutInput = {
  readonly runId: RunId;
  readonly idChain: IdChain;
  readonly interface: Interface;
  readonly window: TimeWindow;
  readonly redactionNames: readonly string[];
  readonly signal: AbortSignal;
};

/** One located value, for the run log. The value is masked. */
export type ScoutValue = {
  readonly value: string;
  readonly kind: ValueKind;
  readonly status: 'ok' | 'refused' | 'failed';
  readonly hits: number;
};

export type ScoutResult = {
  /** One line per value, masked, for the run section. */
  readonly lines: readonly string[];
  /** Gap messages, for preflight_warnings. */
  readonly gaps: readonly string[];
  readonly values: readonly ScoutValue[];
  /** Probes the scout took from the run's budget. */
  readonly probes: number;
};

/**
 * The values the scout locates: the chain ids in key order, then the seed
 * leads, each one whole id, without repeats, at most MAX_SCOUT_VALUES.
 */
export function scoutValues(chain: IdChain): { readonly value: string; readonly kind: ValueKind }[] {
  const candidates = [
    ...KNOWN_ID_KEYS.map((key) => chain.ids[key]),
    ...(chain.leads ?? []).filter((lead) => lead.status === 'seed').map((lead) => lead.value),
  ];
  const seen = new Set<string>();
  const out: { value: string; kind: ValueKind }[] = [];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value === undefined || value === '') continue;
    const kind = valueKind(value);
    const key = value.toLowerCase();
    if (kind === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push({ value, kind });
    if (out.length === MAX_SCOUT_VALUES) break;
  }
  return out;
}

export async function runScout(env: ScoutEnv, input: ScoutInput): Promise<ScoutResult> {
  const values = scoutValues(input.idChain);
  if (values.length === 0) return { lines: [], gaps: [], values: [], probes: 0 };
  const opts = {
    runId: input.runId,
    config: env.config,
    registry: env.registry,
    interface: input.interface,
    idChain: input.idChain,
    connectors: env.connectors,
    runStore: env.runStore,
    redactionNames: input.redactionNames,
    requestWindow: input.window,
    ...(env.audit !== undefined ? { audit: env.audit } : {}),
    ...(env.fixtures !== undefined ? { fixtures: env.fixtures } : {}),
    ...(env.caseId !== undefined ? { caseId: env.caseId } : {}),
    ...(env.now !== undefined ? { now: env.now } : {}),
  };
  // The first build finds or makes the run's budget; the scout's own deps
  // share it, its fixtures and audit sink, with tool calls left uncharged.
  const run = createToolDeps(opts);
  const deps = createToolDeps({ ...opts, fixtures: run.fixtures, audit: run.audit, budget: uncharged(run.budget) });
  const ctx: ToolContext = { runId: input.runId, entity: null, agent: SCOUT_AGENT, config: env.config, registry: env.registry, deps };
  const before = locateProbesUsed(input.runId);
  const lines: string[] = [];
  const gaps: string[] = [];
  const out: ScoutValue[] = [];
  const mask = (text: string): string => redactPersisted(text, { names: input.redactionNames }).value;

  for (const [i, { value, kind }] of values.entries()) {
    const masked = maskId({ kind, normalised: value.toLowerCase() });
    let envelope: ToolEnvelope;
    try {
      envelope = await runLocate(ctx, { value }, { toolCallId: `scout-${i + 1}`, log: { warn: () => {} }, signal: input.signal });
    } catch (err) {
      if (input.signal.aborted) throw err;
      const name = err instanceof Error ? err.name : 'Error';
      lines.push(mask(`${masked} -> not located (locate failed: ${name})`));
      gaps.push(mask(`scout: locate failed for ${masked} (${name}); where it lives was not checked before the run`));
      out.push({ value: masked, kind, status: 'failed', hits: 0 });
      continue;
    }
    const line = lineOf(masked, envelope);
    lines.push(mask(line.text));
    out.push({ value: masked, kind, status: line.status, hits: line.hits });
  }
  return { lines, gaps, values: out, probes: Math.max(0, locateProbesUsed(input.runId) - before) };
}

function uncharged(budget: RunBudget): RunBudget {
  return {
    runId: budget.runId,
    consumeToolCall: () => ({ ok: true }),
    consumeTask: () => budget.consumeTask(),
    clampRows: (n) => budget.clampRows(n),
    clampHits: (entity, n) => budget.clampHits(entity, n),
    accountBytes: (n) => budget.accountBytes(n),
    state: () => budget.state(),
  };
}

// "<entity>: nothing (...)" from renderLocate: an entity where every probed place was 0.
const NOTHING_LINE = /^[a-z]+: nothing \(/;

function lineOf(masked: string, envelope: ToolEnvelope): { text: string; status: ScoutValue['status']; hits: number } {
  const { output } = envelope;
  if (output.status !== 'ok') {
    const message = (output.message ?? output.status).replace(/\s+/g, ' ').trim();
    const cut = message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}…` : message;
    return { text: `${masked} -> not located: ${cut}`, status: 'refused', hits: 0 };
  }
  const data = output.data as { ranked?: unknown; hits?: unknown } | undefined;
  const hits = typeof data?.hits === 'number' ? data.hits : 0;
  // Over the result cap, the data is a preview without the ranked list.
  if (!Array.isArray(data?.ranked)) return { text: `${masked} -> ${hits} hit(s); the places were too many to show`, status: 'ok', hits };
  const ranked = data.ranked.filter((r): r is string => typeof r === 'string');
  if (ranked.length === 0) return { text: `${masked} -> no place could be counted`, status: 'ok', hits };
  // Hits come first. An entity's "nothing" line says where not to brief, so
  // it stays when the hits fill the cap.
  const shown = [...ranked.slice(0, MAX_SCOUT_PLACES), ...ranked.slice(MAX_SCOUT_PLACES).filter((r) => NOTHING_LINE.test(r))];
  const more = ranked.length > shown.length ? `; +${ranked.length - shown.length} more` : '';
  return { text: `${masked} -> ${shown.join('; ')}${more}`, status: 'ok', hits };
}
