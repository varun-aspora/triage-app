import { describe, expect, test } from 'bun:test';
import type { AgentSubmission } from '@flue/runtime/adapter';
import {
  captureSubmissionStore,
  leaseOf,
  readSubmissionLease,
  releaseSubmissionStore,
  submissionLease,
  submissionStoreConnected,
} from './submission-lease.ts';

function submission(over: Partial<AgentSubmission> = {}): AgentSubmission {
  return {
    sequence: 1,
    submissionId: 'sub_one',
    sessionKey: 'k',
    kind: 'dispatch',
    input: {} as AgentSubmission['input'],
    status: 'running',
    acceptedAt: 1,
    canonicalReadyAt: 1,
    attemptCount: 1,
    maxAttempts: 2,
    timeoutAt: 0,
    ownerId: 'owner-1',
    leaseExpiresAt: 30_000,
    ...over,
  };
}

describe('leaseOf', () => {
  test('keeps only the lease fields', () => {
    expect(leaseOf(submission())).toEqual({ status: 'running', leaseExpiresAt: 30_000, ownerId: 'owner-1' });
    expect(leaseOf(submission({ status: 'joined', joinedInto: 'sub_host', ownerId: undefined }))).toEqual({
      status: 'joined',
      leaseExpiresAt: 30_000,
      joinedInto: 'sub_host',
    });
    expect(leaseOf(submission({ status: 'settled', settledAt: 50_000 }))).toMatchObject({ status: 'settled', settledAt: 50_000 });
  });

  test('is null for a missing row or an unknown status', () => {
    expect(leaseOf(null)).toBeNull();
    expect(leaseOf(submission({ status: 'paused' as never }))).toBeNull();
  });
});

describe('submissionLease', () => {
  test('is null until a store is captured, and again once it is released', async () => {
    const store = { getSubmission: async (id: string) => (id === 'sub_one' ? submission() : null) };
    expect(submissionStoreConnected()).toBe(false);
    expect(await submissionLease('sub_one')).toBeNull();
    captureSubmissionStore(store);
    try {
      expect(submissionStoreConnected()).toBe(true);
      expect((await submissionLease('sub_one'))?.status).toBe('running');
      expect(await submissionLease('sub_other')).toBeNull();
      // Releasing a store that is not the captured one changes nothing.
      releaseSubmissionStore({ getSubmission: async () => null });
      expect(submissionStoreConnected()).toBe(true);
    } finally {
      releaseSubmissionStore(store);
    }
    expect(submissionStoreConnected()).toBe(false);
    expect(await submissionLease('sub_one')).toBeNull();
  });

  test('a failed read is null, not a throw', async () => {
    const store = {
      getSubmission: async (): Promise<AgentSubmission | null> => {
        throw new Error('connection lost');
      },
    };
    expect(await readSubmissionLease(store, 'sub_one')).toBeNull();
  });
});
