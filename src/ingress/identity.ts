// The ingress identity step (LLD 04 §2.2 and §3, HLD 02 §1.5, D22, D26).
//
// resolveIngressIdentity(request, deps) runs after normalise and before the
// classifier. It extracts the ids from the request (extract-ids.ts) and hands
// exactly those to resolveIdChain from src/tools/_lib/identity-core.ts, the
// same code the resolve_identity tool uses. The core walks the hop table and
// runs the three fixed basic-state reads; this module builds no statements of
// its own. In mock mode the core answers every hop from resolve_identity
// fixtures through deps.mock, so nothing here changes between modes.
//
// Failure handling follows LLD 04 §3: an unreachable database comes back
// from the core as hops and state items marked unreachable, and this step
// returns normally so the classifier can work from the thread alone. As a
// safety net, a basic-state read that has no item at all while a hop on the
// same database was unreachable is added as an unreachable item with an
// empty value. Strict fixture misses and aborts are loud and are passed on.
//
// No ids in the request means no core call: the result is an empty chain
// with the gap 'no ids in request'. Gaps never carry id values.
import * as v from 'valibot';
import {
  resolveIdChain as coreResolveIdChain,
  type IdChainResult,
  type IdentityCoreDeps,
} from '../tools/_lib/identity-core.ts';
import { IDENTITY_STATEMENTS, type IdentityStatement } from '../tools/_lib/identity-statements.ts';
import type { KnownIds } from '../types/core.ts';
import { type BasicStateItem, type IdChain, IdChainSchema } from '../types/id-chain.ts';
import type { TriageRequest } from '../types/request.ts';
import { extractIds } from './extract-ids.ts';

export const NO_IDS_GAP = 'no ids in request';

export type ResolveIdChainFn = (ids: Partial<KnownIds>, deps: IdentityCoreDeps) => Promise<IdChainResult>;

export type IngressIdentityDeps = Omit<IdentityCoreDeps, 'run'> & {
  /** Ingress-collected names for the persisted redaction profile of the audit lines (D24). */
  readonly redactionNames?: readonly string[];
  /** The core to call. Tests pass a fake; production uses resolveIdChain. */
  readonly resolveIdChain?: ResolveIdChainFn;
};

export type IngressIdentity = {
  readonly id_chain: IdChain;
  /** The same items as id_chain.basic_state. */
  readonly basic_state: readonly BasicStateItem[];
  /** Plain-text gaps for the report, such as an unreachable database. No id values. */
  readonly gaps: readonly string[];
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
  const { ids, unplaced } = extractIds(request);
  const gaps: string[] = [];
  if (unplaced > 0) gaps.push(`${unplaced} more UUID(s) in the thread were not added to the id chain`);

  if (Object.keys(ids).length === 0) {
    const id_chain = v.parse(IdChainSchema, { ids: {}, hops: [], basic_state: [] });
    return Object.freeze({ id_chain, basic_state: id_chain.basic_state, gaps: Object.freeze([NO_IDS_GAP, ...gaps]) });
  }

  const { resolveIdChain = coreResolveIdChain, redactionNames, ...rest } = deps;
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

  return Object.freeze({ id_chain, basic_state: id_chain.basic_state, gaps: Object.freeze(gaps) });
}

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
