// IdChain: the ids resolved deterministically before the classifier, the hops
// that produced them, the basic state read alongside (LLD 04 §2.2) and the
// leads: seeds from the requester's text (D96) and ids derived from tied
// results (D97).
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

// A lead is an id-shaped value the run may use that no known id key took.
// A seed comes from the requester's text (D96); a derived lead from a result
// fetched by an id already in scope (D97). The four kinds match the scope
// rule's id shapes (src/gate/id-patterns.ts).
export const LEAD_KINDS = ['uuid', 'digits', 'phone', 'email'] as const;
export const LeadKindSchema = v.picklist(LEAD_KINDS);
export type LeadKind = v.InferOutput<typeof LeadKindSchema>;

// Where it came from: the thread, an ask_requester answer, hints.ids, or a
// tool result (derived).
export const LEAD_SOURCES = ['thread', 'answer', 'hint', 'derived'] as const;
export const LeadSourceSchema = v.picklist(LEAD_SOURCES);
export type LeadSource = v.InferOutput<typeof LeadSourceSchema>;

export const LEAD_STATUSES = ['seed', 'derived'] as const;
export const LeadStatusSchema = v.picklist(LEAD_STATUSES);
export type LeadStatus = v.InferOutput<typeof LeadStatusSchema>;

export const LEAD_LABEL_MAX = 60;

export const LeadSchema = v.object({
  // Lowercase UUID or email, bare digits, or '+' and the digits of a phone.
  value: NonEmptyStringSchema,
  kind: LeadKindSchema,
  source: LeadSourceSchema,
  // The text before the value on its line, such as 'Alphadesk user ID'. One line.
  label: v.optional(v.pipe(v.string(), v.maxLength(LEAD_LABEL_MAX), v.regex(/^[^\r\n]*$/))),
  // Where it was found: the message index as given and the character offset in its text.
  at: v.optional(
    v.object({
      message: v.pipe(v.number(), v.integer(), v.minValue(0)),
      offset: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  ),
  // The known id key that holds the same value, when one does.
  key: v.optional(KnownIdKeySchema),
  // Both are in scope as soon as they are in the chain: a seed from the
  // requester's text, a derived lead from a tied result.
  status: LeadStatusSchema,
  // Derived leads only (D97). Steps from a chain id or seed, which are depth 0.
  depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  // The masked in-scope id that tied the call (maskId), never the raw value.
  parent: v.optional(NonEmptyStringSchema),
  // The call whose result showed it: the bare tool name, its tool call id and
  // the result field the value was in.
  via: v.optional(v.object({ tool: NonEmptyStringSchema, tool_call_id: NonEmptyStringSchema, field: v.string() })),
});
export type Lead = v.InferOutput<typeof LeadSchema>;

export const IdChainSchema = v.object({
  ids: KnownIdsSchema,
  hops: IdHopsSchema,
  basic_state: v.array(BasicStateItemSchema),
  // Optional, so chains stored before D96 still parse.
  leads: v.optional(v.array(LeadSchema)),
});
export type IdChain = v.InferOutput<typeof IdChainSchema>;
