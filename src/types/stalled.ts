// Stalled (D71): a run whose phase says it is still working (dispatched or
// investigating) but that nobody is working on. It is a display state only:
// the phase and the API status stay as they are. Resume on a stalled run
// cancels the current Flue submission, records the run as stopped with
// reason 'stalled', and resumes it (D72).
import * as v from 'valibot';
import { TakenAtSchema } from './core.ts';

export const STALLED_REASONS = [
  // No process holds the run's Flue submission: its lease expired more than
  // STALLED_LEASE_GRACE_MS ago, or (CLI runs) the recorded worker pid is dead.
  'no_owner',
  // The run's event log has had no line for TRIAGE_STALLED_AFTER_MS.
  'no_progress',
] as const;
export const StalledReasonSchema = v.picklist(STALLED_REASONS);
export type StalledReason = v.InferOutput<typeof StalledReasonSchema>;

/** How long a lease may stay expired before the run counts as no_owner (two Flue scan rounds). */
export const STALLED_LEASE_GRACE_MS = 60_000;

export const StalledSchema = v.object({
  reason: StalledReasonSchema,
  /** When the signal started: the lease expiry, or the last event's time. */
  since: TakenAtSchema,
});
export type Stalled = v.InferOutput<typeof StalledSchema>;
