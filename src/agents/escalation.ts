// Deterministic escalation triggers (HLD 02 §4.3, LLD 04 §2.8, D23).
//
// computeEscalation() is pure: it takes the findings collected so far, the
// classification, the final tier and whether the run budget ran out, and
// returns { triggered, reasons }. finish_report calls it to decide whether to
// run the strong-model synthesis pass.
//
// escalationFor(runId) is a per-run store held in this module's closure.
// note_evidence runs inside delegates, which cannot use usePersistentState, so
// it records findings here and the Triage root mirrors snapshot() into its
// persistent state. Stores for different run ids never share state.
import * as v from 'valibot';
import type { Classification } from '../types/classification.ts';
import { type Entity, type RunId, RunIdSchema, type Tier } from '../types/core.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';

export const ESCALATION_REASONS = [
  'low_confidence',
  'conflicting_hypotheses',
  'money_moved_non_strong',
  'budget_exhausted_no_root_cause',
] as const;
export const EscalationReasonSchema = v.picklist(ESCALATION_REASONS);
export type EscalationReason = v.InferOutput<typeof EscalationReasonSchema>;

export const EscalationSchema = v.object({
  triggered: v.boolean(),
  reasons: v.array(EscalationReasonSchema),
});
export type Escalation = v.InferOutput<typeof EscalationSchema>;

/** One note_evidence call: an entity investigator's findings or the code walker's. */
export type RecordedFindings =
  | { readonly entity: Entity; readonly findings: EntityFindings }
  | { readonly entity: 'code'; readonly findings: CodeFindings };

export interface EscalationInput {
  readonly findings: readonly RecordedFindings[];
  readonly classification: Pick<Classification, 'money_moved'>;
  readonly tierFinal: Tier;
  readonly budgetExhausted: boolean;
}

type EntityRecord = Extract<RecordedFindings, { readonly entity: Entity }>;

function isEntityRecord(r: RecordedFindings): r is EntityRecord {
  return r.entity !== 'code';
}

// An entity blames itself when it has at least one hypothesis at medium or
// high confidence and does not point at another entity.
function blamesItself(r: EntityRecord): boolean {
  const f = r.findings;
  if (f.confidence === 'low' || f.hypotheses.length === 0) return false;
  return f.suggested_next_entity === undefined || f.suggested_next_entity === r.entity;
}

/** Which triggers fire. Reasons come back in ESCALATION_REASONS order. */
export function computeEscalation(input: EscalationInput): Escalation {
  const entityRecords = input.findings.filter(isEntityRecord);
  const fired = new Set<EscalationReason>();

  if (entityRecords.some((r) => r.findings.confidence === 'low')) fired.add('low_confidence');

  const selfBlaming = new Set(entityRecords.filter(blamesItself).map((r) => r.entity));
  if (selfBlaming.size >= 2) fired.add('conflicting_hypotheses');

  if (input.classification.money_moved && input.tierFinal !== 'strong') fired.add('money_moved_non_strong');

  const hasHigh = input.findings.some((r) => r.findings.confidence === 'high');
  if (input.budgetExhausted && !hasHigh) fired.add('budget_exhausted_no_root_cause');

  const reasons = ESCALATION_REASONS.filter((r) => fired.has(r));
  return { triggered: reasons.length > 0, reasons };
}

/** The run facts the store does not hold itself. */
export interface EscalationRunContext {
  readonly classification: Pick<Classification, 'money_moved'>;
  readonly tierFinal: Tier;
}

export interface EscalationSnapshot extends Escalation {
  readonly findings: readonly RecordedFindings[];
  readonly budgetExhausted: boolean;
}

export interface EscalationStore {
  readonly runId: RunId;
  /** Appends one note_evidence result. The value is copied. */
  record(findings: RecordedFindings): void;
  /** Sticky: once marked, the run stays exhausted. */
  markBudgetExhausted(): void;
  /**
   * The findings so far and the triggers they fire. Without the run context,
   * money_moved_non_strong cannot be judged and is left out.
   */
  snapshot(run?: EscalationRunContext): EscalationSnapshot;
}

interface StoreState {
  findings: RecordedFindings[];
  budgetExhausted: boolean;
}

const stores = new Map<RunId, EscalationStore>();

function makeStore(runId: RunId): EscalationStore {
  const state: StoreState = { findings: [], budgetExhausted: false };
  return {
    runId,
    record(findings) {
      state.findings.push(structuredClone(findings));
    },
    markBudgetExhausted() {
      state.budgetExhausted = true;
    },
    snapshot(run) {
      const findings = structuredClone(state.findings);
      const escalation = computeEscalation({
        findings,
        classification: run?.classification ?? { money_moved: false },
        tierFinal: run?.tierFinal ?? 'strong',
        budgetExhausted: state.budgetExhausted,
      });
      return { ...escalation, findings, budgetExhausted: state.budgetExhausted };
    },
  };
}

/** The escalation store for a run, created on first use. */
export function escalationFor(runId: RunId): EscalationStore {
  const id = v.parse(RunIdSchema, runId);
  let store = stores.get(id);
  if (store === undefined) {
    store = makeStore(id);
    stores.set(id, store);
  }
  return store;
}

/** Drops a run's store when the run settles. Returns true when one existed. */
export function releaseEscalation(runId: RunId): boolean {
  return stores.delete(runId);
}
