// Stalled detection (D71): a run whose phase says it is working (dispatched
// or investigating) but that nobody is working on. It is a display state
// only. The phase and the API status stay as they are; the run view, the run
// list, `triage status` and the resume path (D72) read it.
//
// A run is stalled when either:
//   - no_owner: the lease of the run's current Flue submission expired more
//     than STALLED_LEASE_GRACE_MS ago (two of Flue's recovery scans), or the
//     submission settled that long ago and the phase never followed; or the
//     worker pid recorded on the run (CLI runs only) is no longer alive;
//   - no_progress: the run's event log has had no line for
//     TRIAGE_STALLED_AFTER_MS.
// no_owner wins when both hold. `since` is when the signal started: the lease
// expiry or the settle time, or the last event's time.
//
// The worker pid counts only when there is no lease to read, or the lease has
// lost its owner too. Only the CLI writes it, with each dispatch of its
// worker; a dispatch from the server clears it, so the pid on a run belongs
// to its head submission. It stays through phase writes that give none, so
// a steer or a settle from another process keeps it; a live lease wins over
// it all the same.
//
// The current submission is found from two Flue ids (StalledSubject): the
// latest submission that is not a steer (the head), and the latest steer
// after it that has a Flue id. A steer (D72) whose lease says it joined a
// live response (joinedInto) counts its host's lease. A steer that runs, or
// ran, as its own response (it missed the live one) counts its own lease. A
// queued steer, or one with no lease to read, falls back to the head's. A
// failed steer has no Flue id and is never read. A queued head has no lease
// yet, so only no_progress can flag it. At most two lease reads per run in
// the usual case: the steer's and its host's, or the head's alone.
//
// stalledOf is pure. loadStalled gathers its inputs for a run record, and
// loadStalledSubject for a run list row, which carries the same inputs
// (RunSummary from listRuns): the lease through src/db/submission-lease.ts
// (null in a process with no Flue runtime, unless the caller passes a
// reader), the last event time through the tail of events.jsonl, and the
// worker pid. A read that fails counts as unknown, so neither ever throws.

import { KEYS } from '../config/keys.ts';
import { submissionLease, type SubmissionLease, type SubmissionLeaseReader } from '../db/submission-lease.ts';
import { lastRunEventAt } from '../runlog/read.ts';
import { WORKING_PHASES, type RunPhase, type RunRecord } from '../runstore/types.ts';
import type { RunId } from '../types/core.ts';
import { STALLED_LEASE_GRACE_MS, type Stalled } from '../types/stalled.ts';

/** TRIAGE_STALLED_AFTER_MS's default, for a caller that has no config. */
export const DEFAULT_STALLED_AFTER_MS: number = Number(KEYS.find((k) => k.name === 'TRIAGE_STALLED_AFTER_MS')?.default ?? 600_000);

/** The phases in which a run can be stalled: the ones where a process should be working on it. */
export const STALLABLE_PHASES: readonly RunPhase[] = WORKING_PHASES;

export type StalledInput = {
  readonly phase: RunPhase;
  /** Epoch ms. */
  readonly now: number;
  /** TRIAGE_STALLED_AFTER_MS. */
  readonly stalledAfterMs: number;
  /** The run's last event line, epoch ms. Null when there is none or it could not be read. */
  readonly lastEventAt: number | null;
  /** The lease of the run's current Flue submission. Null when it is unknown. */
  readonly lease: SubmissionLease | null;
  /** The worker pid recorded on the run (CLI runs). Read only when lease is null or has lost its owner. */
  readonly workerPid?: number;
  /** True when a process with this pid exists. Left out: the pid is not checked. */
  readonly isAlive?: (pid: number) => boolean;
  /** The run's updated_at, epoch ms: since for a dead worker when the log has no line. */
  readonly updatedAt?: number;
};

/** The stalled signal for a run, or null when it is not stalled. Pure. */
export function stalledOf(input: StalledInput): Stalled | null {
  if (!STALLABLE_PHASES.includes(input.phase)) return null;

  const ownerLostAt = input.lease === null ? null : ownerLostAtOf(input.lease);
  if (ownerLostAt !== null && input.now - ownerLostAt > STALLED_LEASE_GRACE_MS) {
    return { reason: 'no_owner', since: iso(ownerLostAt) };
  }

  // A live lease wins over a dead pid: the pid may be an earlier CLI worker's.
  const leaseLost = ownerLostAt !== null && ownerLostAt <= input.now;
  const pidCounts = input.lease === null || leaseLost;
  if (pidCounts && input.workerPid !== undefined && input.isAlive !== undefined && !input.isAlive(input.workerPid)) {
    // When the worker died is not known; the lease expiry, else its last line, is the best guess.
    const since = leaseLost ? ownerLostAt : (input.lastEventAt ?? input.updatedAt ?? input.now);
    return { reason: 'no_owner', since: iso(since) };
  }

  if (input.lastEventAt !== null && input.now - input.lastEventAt >= input.stalledAfterMs) {
    return { reason: 'no_progress', since: iso(input.lastEventAt) };
  }
  return null;
}

/**
 * When the submission lost its owner, or null while it has one or never had
 * one. running and terminalizing hold a lease until it expires; a settled
 * submission has no owner from the moment it settled.
 */
function ownerLostAtOf(lease: SubmissionLease): number | null {
  switch (lease.status) {
    case 'running':
    case 'terminalizing':
      return lease.leaseExpiresAt > 0 ? lease.leaseExpiresAt : null;
    case 'settled':
      return lease.settledAt ?? (lease.leaseExpiresAt > 0 ? lease.leaseExpiresAt : null);
    default:
      return null;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ------------------------------------------------------------------ loader

export type StalledRun = Pick<RunRecord, 'run_id' | 'phase' | 'submissions' | 'worker_pid' | 'updated_at'>;

/**
 * What the loader needs about a run. A listRuns row (RunSummary) has these
 * fields on a working row; stalledSubjectOf builds them from a run record.
 */
export type StalledSubject = {
  readonly run_id: RunId;
  readonly phase: RunPhase;
  readonly updated_at: string;
  readonly worker_pid?: number;
  /** Flue's id for the latest submission that is not a steer. */
  readonly flue_submission_id?: string;
  /** Flue's id for the latest steer after that one that has an id. */
  readonly steer_flue_submission_id?: string;
};

export type StalledDeps = {
  /** TRIAGE_STALLED_AFTER_MS. */
  readonly stalledAfterMs: number;
  /** TRIAGE_RUNS_DIR, where events.jsonl is. Left out, with no lastEventAt: no_progress is never flagged. */
  readonly runsDir?: string;
  /** Defaults to the lease of this process's Flue runtime (submissionLease). */
  readonly lease?: SubmissionLeaseReader;
  /** Defaults to the tail of the run's events.jsonl under runsDir. */
  readonly lastEventAt?: (runId: RunId) => Promise<number | null>;
  /** Checks the run's worker pid. Left out: the pid is not checked. */
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => number;
};

/** Flue's id for the run's latest submission that is not a steer, once its dispatch receipt was recorded. */
export function currentFlueSubmissionId(run: Pick<RunRecord, 'submissions'>): string | undefined {
  return latestHead(run)?.flue_submission_id;
}

/** Flue's id for the latest steer after the latest non-steer submission that has one. */
export function latestSteerFlueSubmissionId(run: Pick<RunRecord, 'submissions'>): string | undefined {
  const headSeq = latestHead(run)?.seq ?? 0;
  for (let i = run.submissions.length - 1; i >= 0; i--) {
    const sub = run.submissions[i];
    if (sub === undefined || sub.seq <= headSeq) break;
    if (sub.kind === 'steer' && sub.flue_submission_id !== undefined) return sub.flue_submission_id;
  }
  return undefined;
}

function latestHead(run: Pick<RunRecord, 'submissions'>): RunRecord['submissions'][number] | undefined {
  for (let i = run.submissions.length - 1; i >= 0; i--) {
    const sub = run.submissions[i];
    if (sub !== undefined && sub.kind !== 'steer') return sub;
  }
  return undefined;
}

/** The loader's inputs from a run record. */
export function stalledSubjectOf(run: StalledRun): StalledSubject {
  const head = currentFlueSubmissionId(run);
  const steer = latestSteerFlueSubmissionId(run);
  return {
    run_id: run.run_id,
    phase: run.phase,
    updated_at: run.updated_at,
    ...(run.worker_pid !== undefined ? { worker_pid: run.worker_pid } : {}),
    ...(head !== undefined ? { flue_submission_id: head } : {}),
    ...(steer !== undefined ? { steer_flue_submission_id: steer } : {}),
  };
}

/** True when the subject has a Flue id to read a lease for. */
export function hasFlueSubmission(subject: StalledSubject): boolean {
  return subject.flue_submission_id !== undefined || subject.steer_flue_submission_id !== undefined;
}

/** The stalled signal for a stored run. Reads nothing for a run that is not dispatched or investigating. Never throws. */
export function loadStalled(run: StalledRun, deps: StalledDeps): Promise<Stalled | null> {
  if (!STALLABLE_PHASES.includes(run.phase)) return Promise.resolve(null);
  return loadStalledSubject(stalledSubjectOf(run), deps);
}

/** The same for a run list row, or any subject. Reads nothing for a run that is not working. Never throws. */
export async function loadStalledSubject(subject: StalledSubject, deps: StalledDeps): Promise<Stalled | null> {
  if (!STALLABLE_PHASES.includes(subject.phase)) return null;
  const [current, lastEventAt] = await Promise.all([
    currentLease(subject, deps.lease ?? submissionLease),
    lastEventOf(subject.run_id, deps),
  ]);
  const updatedAt = Date.parse(subject.updated_at);
  return stalledOf({
    phase: subject.phase,
    now: (deps.now ?? Date.now)(),
    stalledAfterMs: deps.stalledAfterMs,
    lastEventAt,
    lease: current?.lease ?? null,
    ...(subject.worker_pid !== undefined ? { workerPid: subject.worker_pid } : {}),
    ...(deps.isAlive !== undefined ? { isAlive: safeAlive(deps.isAlive) } : {}),
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  });
}

/** The Flue submission whose lease counts for the run, and that lease. */
export type CurrentLease = { readonly flueSubmissionId: string; readonly lease: SubmissionLease | null };

/**
 * The run's current Flue submission and its lease: a steer's own when it
 * runs or ran as its own response, its host's when it joined one, else the
 * head's (one join hop followed). Null when there is no id to read. Never
 * throws; a failed read is a null lease.
 */
export async function currentLease(subject: StalledSubject, read: SubmissionLeaseReader): Promise<CurrentLease | null> {
  const steerId = subject.steer_flue_submission_id;
  if (steerId !== undefined) {
    const steer = await readQuietly(read, steerId);
    if (steer !== null && steer.joinedInto !== undefined) {
      return { flueSubmissionId: steer.joinedInto, lease: await readQuietly(read, steer.joinedInto) };
    }
    if (steer !== null && steer.status !== 'queued') return { flueSubmissionId: steerId, lease: steer };
  }
  const headId = subject.flue_submission_id;
  if (headId === undefined) return null;
  const head = await readQuietly(read, headId);
  if (head !== null && (head.status === 'joining' || head.status === 'joined') && head.joinedInto !== undefined) {
    return { flueSubmissionId: head.joinedInto, lease: await readQuietly(read, head.joinedInto) };
  }
  return { flueSubmissionId: headId, lease: head };
}

async function readQuietly(read: SubmissionLeaseReader, flueId: string): Promise<SubmissionLease | null> {
  try {
    return await read(flueId);
  } catch {
    return null;
  }
}

async function lastEventOf(runId: RunId, deps: StalledDeps): Promise<number | null> {
  try {
    if (deps.lastEventAt !== undefined) return await deps.lastEventAt(runId);
    if (deps.runsDir === undefined) return null;
    return await lastRunEventAt(deps.runsDir, runId);
  } catch {
    return null;
  }
}

/** A pid check that throws counts as alive: nothing is flagged on a check that did not run. */
function safeAlive(isAlive: (pid: number) => boolean): (pid: number) => boolean {
  return (pid) => {
    try {
      return isAlive(pid);
    } catch {
      return true;
    }
  };
}

/** The same pid check, asked at most once per pid: for one answer that reads the pid in two places. */
export function oncePerPid(isAlive: (pid: number) => boolean): (pid: number) => boolean {
  const seen = new Map<number, boolean>();
  return (pid) => {
    const known = seen.get(pid);
    if (known !== undefined) return known;
    const alive = isAlive(pid);
    seen.set(pid, alive);
    return alive;
  };
}
