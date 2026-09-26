// IdChain: the ids resolved deterministically before the classifier, the hops
// that produced them and the basic state read alongside (LLD 04 §2.2).
import * as v from 'valibot';
import { KnownIdKeySchema, KnownIdsSchema, NonEmptyStringSchema, TakenAtSchema } from './core.ts';

export const HOP_STATUSES = ['resolved', 'not_found', 'unreachable', 'unverified', 'skipped'] as const;
export const HopStatusSchema = v.picklist(HOP_STATUSES);
export type HopStatus = v.InferOutput<typeof HopStatusSchema>;

export const IdHopSchema = v.object({
  // The KnownIds key the hop started from.
  from: KnownIdKeySchema,
  // The KnownIds key it produced; absent when nothing resolved or the hop
  // only read state.
  to: v.optional(KnownIdKeySchema),
  // Where the hop read from, for example 'ssfb:harbor.account_forms'.
  source: NonEmptyStringSchema,
  status: HopStatusSchema,
  taken_at: TakenAtSchema,
});
export type IdHop = v.InferOutput<typeof IdHopSchema>;

export const BASIC_STATE_STATUSES = ['read', 'not_found', 'unreachable'] as const;
export const BasicStateStatusSchema = v.picklist(BASIC_STATE_STATUSES);
export type BasicStateStatus = v.InferOutput<typeof BasicStateStatusSchema>;

export const BasicStateItemSchema = v.object({
  item: NonEmptyStringSchema,
  value: v.string(),
  taken_at: TakenAtSchema,
  source: NonEmptyStringSchema,
  // Lets an unreachable read be recorded as an item with an empty value.
  status: v.optional(BasicStateStatusSchema),
});
export type BasicStateItem = v.InferOutput<typeof BasicStateItemSchema>;

// Id keys removed by D69. A run stored before then can still hold hops from
// or to them; only these names are dropped, so a hop naming any other
// unknown key still fails.
const REMOVED_ID_KEYS: ReadonlySet<unknown> = new Set([
  'horus_customer_id',
  'user_id',
  'old_user_id',
  'form_id',
  'alphadesk_user_id',
  'device_id',
  'phone',
  'utr',
]);

function namesRemovedKey(hop: unknown): boolean {
  if (hop === null || typeof hop !== 'object') return false;
  const { from, to } = hop as { from?: unknown; to?: unknown };
  return REMOVED_ID_KEYS.has(from) || REMOVED_ID_KEYS.has(to);
}

/**
 * The hops of a chain. Hops from or to a removed id key are dropped before
 * the rest are checked, so a stored run from before D69 still parses; ids
 * under removed keys are already dropped by KnownIdsSchema, which keeps only
 * the keys it lists.
 */
export const IdHopsSchema = v.pipe(
  v.array(v.unknown()),
  v.transform((hops) => hops.filter((hop) => !namesRemovedKey(hop))),
  v.array(IdHopSchema),
);

export const IdChainSchema = v.object({
  ids: KnownIdsSchema,
  hops: IdHopsSchema,
  basic_state: v.array(BasicStateItemSchema),
});
export type IdChain = v.InferOutput<typeof IdChainSchema>;
