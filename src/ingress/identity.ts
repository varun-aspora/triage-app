// The ingress identity step (LLD 04 §2.2 and §3, HLD 02 §1.5, D22, D26, D69).
//
// resolveIngressIdentity(request, deps) runs after normalise and before the
// classifier. It reads the ids from the thread, puts hints.ids on top and
// hands exactly those to resolveIdChain from src/tools/_lib/identity-core.ts,
// the same code the resolve_identity tool uses. The core walks the hop table
// and runs the three fixed basic-state reads; this module builds no
// statements of its own. In mock mode the core answers every hop from
// resolve_identity fixtures through deps.mock, so nothing here changes
// between modes.
//
// Reading the ids (D69). The fields come from resources/known-ids.json
// (deps.knownIdFields).
// - The decision path runs when deps.decision.model (MODEL_DECISION) is a
//   decision spec: one decide() call with the questions from
//   ./id-decision.ts, under decide()'s own time limit and the step's signal.
//   Keys given in hints.ids are not asked, and their values are not offered
//   for other keys. Its usage goes to deps.decision.onUsage, counted the way
//   the classifier counts its decision call: once when a result came back,
//   and as failed when decide() failed after the provider was asked.
// - The label fallback (./extract-ids.ts) runs when the model is unset or not
//   a decision spec, the thread has no text, there is nothing left to ask, or
//   the decision failed (building the provider or the request included). A failure is recorded as
//   decision_error: the error's code and provider, masked, never a value.
// The result's `extraction` says which path ran, and per field the
// candidates offered, the candidates past the cap and the chosen option's
// probability. It never carries a candidate value.
//
// Failure handling follows LLD 04 §3: an unreachable database comes back
// from the core as hops and state items marked unreachable, and this step
// returns normally so the classifier can work from the thread alone. As a
// safety net, a basic-state read that has no item at all while a hop on the
// same database was unreachable is added as an unreachable item with an
// empty value. Strict fixture misses and aborts are loud and are passed on.
//
// No ids means no core call: the result is an empty chain with the gap
// 'no ids in request'. Gaps never carry id values.
import * as v from 'valibot';
import type { KnownIdField } from '../config/known-ids.ts';
import { decide, DecisionError } from '../decisions/decide.ts';
import { decisionRoute } from '../decisions/registry.ts';
import type { DecisionProvider, DecisionUsage } from '../decisions/types.ts';
import { redactModelFacing, redactPersisted } from '../gate/redact.ts';
import {
  resolveIdChain as coreResolveIdChain,
  type IdChainResult,
  type IdentityCoreDeps,
} from '../tools/_lib/identity-core.ts';
import { IDENTITY_STATEMENTS, type IdentityStatement } from '../tools/_lib/identity-statements.ts';
import type { KnownIdKey, KnownIds } from '../types/core.ts';
import { type BasicStateItem, type IdChain, IdChainSchema } from '../types/id-chain.ts';
import type { TriageRequest } from '../types/request.ts';
import { hintedIds, labelledIds, orderedTexts, withHints } from './extract-ids.ts';
import {
  buildIdDecision,
  collectCandidates,
  type FieldAnswer,
  type FieldCandidates,
  idsFromAnswers,
} from './id-decision.ts';

export const NO_IDS_GAP = 'no ids in request';

/** decision_error text is capped at this many characters. */
export const MAX_DECISION_ERROR_CHARS = 300;

export type ResolveIdChainFn = (ids: Partial<KnownIds>, deps: IdentityCoreDeps) => Promise<IdChainResult>;

/** The id decision's one model call, for the run's intake usage (D59). */
export type IdentityUsage = {
  /** The MODEL_DECISION spec. */
  readonly model: string;
  readonly failed: boolean;
  readonly input: number;
  readonly output: number;
  /** The cost the provider reported, when it is a finite number >= 0. */
  readonly reportedUsd?: number;
};

export type IdentityDecisionDeps = {
  /** MODEL_DECISION. Unset or not a decision spec: the label fallback. */
  readonly model: string | undefined;
  /** Builds the provider for the spec. Called only on the decision path; a throw is a decision failure. */
  readonly provider: (spec: string) => DecisionProvider;
  /** Hears the model call. A callback that throws is ignored. */
  readonly onUsage?: (u: IdentityUsage) => void;
  /** Default: decide()'s own limit. */
  readonly timeoutMs?: number;
};

export type IngressIdentityDeps = Omit<IdentityCoreDeps, 'run'> & {
  /** The fields of resources/known-ids.json. */
  readonly knownIdFields: readonly KnownIdField[];
  /** Left out: the label fallback. */
  readonly decision?: IdentityDecisionDeps;
  /** Ingress-collected names for the persisted redaction profile of the audit lines and the decision request (D24). */
  readonly redactionNames?: readonly string[];
  /** The core to call. Tests pass a fake; production uses resolveIdChain. */
  readonly resolveIdChain?: ResolveIdChainFn;
};

/** How the ids were read from the thread (D69). Counts, probabilities and a masked error only. */
export type IdExtraction = {
  readonly extractor: 'decision' | 'labels';
  /** Why the decision path failed, when it did. Masked; never a value. */
  readonly decision_error?: string;
  /** Candidates offered per value field that had any. */
  readonly candidates: Readonly<Partial<Record<KnownIdKey, number>>>;
  /** Candidates past the cap, per field that had any. */
  readonly dropped: Readonly<Partial<Record<KnownIdKey, number>>>;
  /** Decision path: per asked field, what happened and the chosen option's probability. */
  readonly fields: Readonly<Partial<Record<KnownIdKey, FieldAnswer>>>;
};

export type IngressIdentity = {
  readonly id_chain: IdChain;
  /** The same items as id_chain.basic_state. */
  readonly basic_state: readonly BasicStateItem[];
  /** Plain-text gaps for the report, such as an unreachable database. No id values. */
  readonly gaps: readonly string[];
  /** Left out when the step did not run. */
  readonly extraction?: IdExtraction;
};

/** Thrown when the core hands back a chain that does not match IdChainSchema. Names paths only. */
export class IngressIdentityError extends Error {
  override readonly name = 'IngressIdentityError';
}

// The three fixed basic-state reads and the items each one produces. Rhythm
// items can carry an account suffix (':NRE'), so they are matched by prefix.
const STATE_READS: readonly { readonly stmt: IdentityStatement; readonly items: readonly string[] }[] = [
  { stmt: IDENTITY_STATEMENTS.state_harbor_customer, items: ['harbor_customer_state', 'harbor_customer_sub_state'] },
  { stmt: IDENTITY_STATEMENTS.state_account_form, items: ['account_form_status_v2'] },
  { stmt: IDENTITY_STATEMENTS.state_rhythm_account, items: ['rhythm_account_status', 'rhythm_debit_allowed'] },
];

/** Resolves the request's id chain and basic state. Throws only for a strict mock miss, an abort or a malformed core result. */
export async function resolveIngressIdentity(
  request: Pick<TriageRequest, 'request_id' | 'interface' | 'messages' | 'hints'>,
  deps: IngressIdentityDeps,
): Promise<IngressIdentity> {
  deps.signal.throwIfAborted();
  const read = await readIds(request, deps);
  const ids = withHints(read.ids, request.hints);
  const extraction = read.extraction;
  const gaps: string[] = [...read.gaps];

  if (Object.keys(ids).length === 0) {
    const id_chain = v.parse(IdChainSchema, { ids: {}, hops: [], basic_state: [] });
    return Object.freeze({ id_chain, basic_state: id_chain.basic_state, gaps: Object.freeze([NO_IDS_GAP, ...gaps]), extraction });
  }

  const { resolveIdChain = coreResolveIdChain, redactionNames, knownIdFields: _fields, decision: _decision, ...rest } = deps;
  const coreDeps: IdentityCoreDeps = {
    ...rest,
    run: {
      runId: request.request_id,
      interface: request.interface,
      ...(redactionNames !== undefined ? { redactionNames } : {}),
    },
  };
  const result = await resolveIdChain({ ...ids }, coreDeps);

  const parsed = v.safeParse(IdChainSchema, result.id_chain);
  if (!parsed.success) {
    const paths = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(id_chain)'))];
    throw new IngressIdentityError(`the identity core returned an invalid id chain at: ${paths.join(', ')}`);
  }

  const chain = parsed.output;
  const basic_state = [...chain.basic_state, ...missingUnreachableState(chain, deps.now)];
  const id_chain: IdChain = { ...chain, basic_state };
  gaps.push(...unreachableGaps(id_chain));

  return Object.freeze({ id_chain, basic_state: id_chain.basic_state, gaps: Object.freeze(gaps), extraction });
}

// ---------------------------------------------------------------- reading ids

type Read = { readonly ids: Partial<KnownIds>; readonly extraction: IdExtraction; readonly gaps: readonly string[] };

/** The ids from the thread, before hints: the decision when it can run, else the labels. */
async function readIds(request: Pick<TriageRequest, 'messages' | 'hints'>, deps: IngressIdentityDeps): Promise<Read> {
  const fields = deps.knownIdFields;
  const texts = orderedTexts(request.messages);
  const hinted = hintedIds(request.hints);
  const candidates = withoutHinted(collectCandidates(fields, texts), hinted);
  const counts = {
    candidates: countsOf(candidates, (c) => c.raw.length),
    dropped: countsOf(candidates, (c) => c.dropped),
  };
  const labels = (decision_error?: string): Read => ({
    ids: labelledIds(fields, texts),
    extraction: Object.freeze({
      extractor: 'labels' as const,
      ...(decision_error === undefined ? {} : { decision_error }),
      ...counts,
      fields: {},
    }),
    gaps: [],
  });

  const spec = deps.decision?.model;
  const route = spec === undefined ? undefined : decisionRoute(spec);
  const hasText = texts.some((text) => text.trim() !== '');
  if (deps.decision === undefined || spec === undefined || route === undefined || !hasText) return labels();

  const call: DecisionCall = { sent: false, usage: undefined };
  try {
    const built = buildIdDecision({
      fields,
      candidates,
      thread: redactModelFacing(request.messages),
      provider: route.provider,
      skip: new Set(Object.keys(hinted) as KnownIdKey[]),
      ...(deps.redactionNames === undefined ? {} : { redactionNames: deps.redactionNames }),
    });
    // Nothing to ask (every field was given): no call, and the labels say what they say.
    if (built === null) return labels();
    const result = await decide(watched(deps.decision.provider(spec), call), built.request, {
      signal: deps.signal,
      ...(deps.decision.timeoutMs === undefined ? {} : { timeoutMs: deps.decision.timeoutMs }),
    });
    reportUsage(deps.decision, usageOf(spec, false, result.usage));
    const mapped = idsFromAnswers(built, result.answers);
    const gaps = built.asked.flatMap((key) => {
      const n = counts.dropped[key] ?? 0;
      return n > 0 ? [`${n} more candidate value(s) for ${key} in the thread were not offered to the id decision`] : [];
    });
    return {
      ids: mapped.ids,
      extraction: Object.freeze({ extractor: 'decision', ...counts, fields: mapped.fields }),
      gaps,
    };
  } catch (err) {
    // call.usage is read now: a result that lands after a timeout is not counted.
    if (call.sent) reportUsage(deps.decision, usageOf(spec, true, call.usage));
    if (deps.signal.aborted) throw err;
    return labels(decisionFailure(err, deps.redactionNames));
  }
}

/** Candidates without the values the caller already gave under any key. */
function withoutHinted(candidates: readonly FieldCandidates[], hinted: Partial<KnownIds>): readonly FieldCandidates[] {
  const given = new Set(Object.values(hinted).map((value) => value.toLowerCase()));
  if (given.size === 0) return candidates;
  return candidates.map((c) => ({ ...c, raw: c.raw.filter((value) => !given.has(value.toLowerCase())) }));
}

function countsOf(candidates: readonly FieldCandidates[], n: (c: FieldCandidates) => number): Partial<Record<KnownIdKey, number>> {
  const out: Partial<Record<KnownIdKey, number>> = {};
  for (const c of candidates) if (n(c) > 0) out[c.key] = n(c);
  return out;
}

type DecisionCall = { sent: boolean; usage: DecisionUsage | undefined };

// decide() drops a result whose answers fail its checks, and throws before
// asking the provider when the questions are bad or the signal is already
// aborted. Wrapping the provider tells the two apart and keeps the usage of a
// result decide() refused, as the classifier does.
function watched(inner: DecisionProvider, call: DecisionCall): DecisionProvider {
  return {
    id: inner.id,
    model: inner.model,
    async decide(request, options) {
      call.sent = true;
      const result = await inner.decide(request, options);
      call.usage = result.usage;
      return result;
    },
  };
}

function usageOf(spec: string, failed: boolean, usage: DecisionUsage | undefined): IdentityUsage {
  const cost = usage?.costUsd;
  return {
    model: spec,
    failed,
    input: tokens(usage?.inputTokens),
    output: tokens(usage?.outputTokens),
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { reportedUsd: cost } : {}),
  };
}

// A token count as a non-negative integer; anything else a provider sends counts as 0.
function tokens(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function reportUsage(decision: IdentityDecisionDeps, u: IdentityUsage): void {
  if (decision.onUsage === undefined) return;
  try {
    decision.onUsage(u);
  } catch {
    // Usage is bookkeeping; it must not change the ids.
  }
}

// A DecisionError message holds only a code, the provider and a status. Its
// detail is kept for the codes whose detail this code base writes itself
// (key names, answer paths, the time limit); a provider's own error text
// could echo the request, so it is left out. The result is masked anyway.
const LOCAL_DETAIL_CODES: ReadonlySet<string> = new Set(['config', 'invalid_response', 'timeout']);

function decisionFailure(err: unknown, names: readonly string[] | undefined): string {
  const text =
    err instanceof DecisionError
      ? err.detail !== undefined && LOCAL_DETAIL_CODES.has(err.code)
        ? `${err.message}: ${err.detail}`
        : err.message
      : `decision failed: ${err instanceof Error ? err.name : typeof err}`;
  const masked = redactPersisted(text.replace(/\s+/g, ' ').trim(), { names: names ?? [] }).value;
  return masked.length > MAX_DECISION_ERROR_CHARS ? `${masked.slice(0, MAX_DECISION_ERROR_CHARS)}...` : masked;
}

// ---------------------------------------------------------------- chain

/** entity:service of a hop or item source such as 'ssfb:harbor.customer'. */
function databaseOf(source: string): string {
  const dot = source.indexOf('.');
  return dot === -1 ? source : source.slice(0, dot);
}

function sourceOf(stmt: IdentityStatement): string {
  return `${stmt.entity}:${stmt.service}.${stmt.table}`;
}

/** Unreachable items for state reads the core left out while their database was down. */
function missingUnreachableState(chain: IdChain, now: () => Date): BasicStateItem[] {
  const down = new Set(chain.hops.filter((h) => h.status === 'unreachable').map((h) => databaseOf(h.source)));
  if (down.size === 0) return [];
  const taken_at = now().toISOString();
  const out: BasicStateItem[] = [];
  for (const { stmt, items } of STATE_READS) {
    const source = sourceOf(stmt);
    if (!down.has(databaseOf(source))) continue;
    for (const item of items) {
      const present = chain.basic_state.some((s) => s.item === item || s.item.startsWith(`${item}:`));
      if (!present) out.push({ item, value: '', taken_at, source, status: 'unreachable' });
    }
  }
  return out;
}

/** One gap per database that a hop or a state read could not reach. */
function unreachableGaps(chain: IdChain): string[] {
  const sources = [
    ...chain.hops.filter((h) => h.status === 'unreachable').map((h) => h.source),
    ...chain.basic_state.filter((s) => s.status === 'unreachable').map((s) => s.source),
  ];
  const databases = [...new Set(sources.map(databaseOf))];
  return databases.map((db) => `identity lookup unreachable: ${db}`);
}
