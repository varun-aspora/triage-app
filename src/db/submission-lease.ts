// The lease of a Flue submission, for stalled detection (D71). Node only.
//
// src/db.ts hands this module the stores its adapter returns from connect(),
// so a process that runs a Flue runtime (the server, a CLI worker) can read
// its submissions' leases. This module has no side effects on import, unlike
// src/db.ts, whose default export loads the config; the ingress and HTTP code
// import it freely.
//
// Flue marks the lease method group unstable before 1.0 and its coordination
// fields as lossy, never history. The lease is read here only as a live hint
// for the display, never to decide what a run did. Only the fields stalled
// detection needs leave this module, so no Flue type leaks.

import type { AgentSubmission, AgentSubmissionStore } from '@flue/runtime/adapter';

/** Flue's submission statuses, copied so callers need no Flue import. */
export const SUBMISSION_LEASE_STATUSES = ['queued', 'running', 'terminalizing', 'settled', 'joining', 'joined'] as const;
export type SubmissionLeaseStatus = (typeof SUBMISSION_LEASE_STATUSES)[number];

export type SubmissionLease = {
  readonly status: SubmissionLeaseStatus;
  /** Epoch ms. 0 while no process has claimed the submission. */
  readonly leaseExpiresAt: number;
  readonly ownerId?: string;
  /** A joined delivery (a steer, D72): the host submission it settles with. */
  readonly joinedInto?: string;
  /** Epoch ms, once settled. */
  readonly settledAt?: number;
};

/** Reads one submission's lease. Null when the id is unknown or the read fails. */
export type SubmissionLeaseReader = (flueSubmissionId: string) => Promise<SubmissionLease | null>;

type LeaseSource = Pick<AgentSubmissionStore, 'getSubmission'>;

let connected: LeaseSource | null = null;

/** Called by src/db.ts once its adapter has connected. The latest connect wins. */
export function captureSubmissionStore(store: LeaseSource): void {
  connected = store;
}

/** Called by src/db.ts when the adapter that connected it closes. */
export function releaseSubmissionStore(store: LeaseSource): void {
  if (connected === store) connected = null;
}

/** True once a Flue adapter has connected in this process. */
export function submissionStoreConnected(): boolean {
  return connected !== null;
}

/**
 * The lease of one of this process's Flue submissions. Null, never a throw,
 * when no runtime has connected, the id is unknown, or the read fails.
 */
export const submissionLease: SubmissionLeaseReader = (flueSubmissionId) =>
  connected === null ? Promise.resolve(null) : readSubmissionLease(connected, flueSubmissionId);

/** The lease of one submission in the given store. Null for an unknown id or a failed read. */
export async function readSubmissionLease(store: LeaseSource, flueSubmissionId: string): Promise<SubmissionLease | null> {
  try {
    return leaseOf(await store.getSubmission(flueSubmissionId));
  } catch {
    return null;
  }
}

/** The fields stalled detection reads. Null for a missing row or one with a status this code does not know. */
export function leaseOf(submission: AgentSubmission | null): SubmissionLease | null {
  if (submission === null || submission === undefined) return null;
  const status = submission.status as string;
  if (!(SUBMISSION_LEASE_STATUSES as readonly string[]).includes(status)) return null;
  const expires = submission.leaseExpiresAt;
  return {
    status: status as SubmissionLeaseStatus,
    leaseExpiresAt: typeof expires === 'number' && Number.isFinite(expires) ? expires : 0,
    ...(typeof submission.ownerId === 'string' ? { ownerId: submission.ownerId } : {}),
    ...(typeof submission.joinedInto === 'string' ? { joinedInto: submission.joinedInto } : {}),
    ...(typeof submission.settledAt === 'number' && Number.isFinite(submission.settledAt) ? { settledAt: submission.settledAt } : {}),
  };
}
