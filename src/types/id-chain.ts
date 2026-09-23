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

export const IdChainSchema = v.object({
  ids: KnownIdsSchema,
  hops: v.array(IdHopSchema),
  basic_state: v.array(BasicStateItemSchema),
});
export type IdChain = v.InferOutput<typeof IdChainSchema>;
