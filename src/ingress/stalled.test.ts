import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import type { SubmissionLease } from '../db/submission-lease.ts';
import { EVENTS_FILE } from '../runlog/event-log.ts';
import { RUN_PHASES, type RunPhase, type Submission } from '../runstore/types.ts';
import { STALLED_LEASE_GRACE_MS, StalledSchema } from '../types/stalled.ts';
import {
  currentFlueSubmissionId,
  currentLease,
  latestSteerFlueSubmissionId,
  loadStalled,
  loadStalledSubject,
  stalledOf,
  stalledSubjectOf,
  type StalledInput,
  type StalledRun,
} from './stalled.ts';

const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const AFTER = 600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function input(over: Partial<StalledInput> = {}): StalledInput {
  return { phase: 'investigating', now: NOW, stalledAfterMs: AFTER, lastEventAt: NOW - 1000, lease: null, ...over };
}

const running = (leaseExpiresAt: number): SubmissionLease => ({ status: 'running', leaseExpiresAt, ownerId: 'o1' });

describe('stalledOf', () => {
  test('a working run with a live lease and a recent event is not stalled', () => {
    expect(stalledOf(input({ lease: running(NOW + 20_000) }))).toBeNull();
    expect(stalledOf(input())).toBeNull();
  });

  test('only dispatched and investigating can be stalled', () => {
    const dead = { lease: running(NOW - 10 * STALLED_LEASE_GRACE_MS), lastEventAt: NOW - 10 * AFTER, workerPid: 42, isAlive: () => false };
    for (const phase of RUN_PHASES) {
      const got = stalledOf(input({ phase, ...dead }));
      if (phase === 'dispatched' || phase === 'investigating') expect(got?.reason).toBe('no_owner');
      else expect(got).toBeNull();
    }
  });

  test('no_owner once the lease expired more than the grace ago, not at the grace itself', () => {
    const expired = NOW - STALLED_LEASE_GRACE_MS;
    expect(stalledOf(input({ lease: running(expired) }))).toBeNull();
    expect(stalledOf(input({ lease: running(expired - 1) }))).toEqual({ reason: 'no_owner', since: iso(expired - 1) });
    expect(stalledOf(input({ lease: { status: 'terminalizing', leaseExpiresAt: expired - 1 } }))?.reason).toBe('no_owner');
  });

  test('a settled submission counts from its settle time', () => {
    const settled = (settledAt: number): SubmissionLease => ({ status: 'settled', leaseExpiresAt: NOW - 3_600_000, settledAt });
    expect(stalledOf(input({ lease: settled(NOW - 1000) }))).toBeNull();
    expect(stalledOf(input({ lease: settled(NOW - STALLED_LEASE_GRACE_MS - 1) }))).toEqual({
      reason: 'no_owner',
      since: iso(NOW - STALLED_LEASE_GRACE_MS - 1),
    });
    // Aborted before it was claimed: no settle time and no lease.
    expect(stalledOf(input({ lease: { status: 'settled', leaseExpiresAt: 0 } }))).toBeNull();
  });

  test('a queued, joining or never-claimed submission has no owner to lose', () => {
    for (const status of ['queued', 'joining', 'joined'] as const) {
      expect(stalledOf(input({ lease: { status, leaseExpiresAt: 1 } }))).toBeNull();
    }
    expect(stalledOf(input({ lease: running(0) }))).toBeNull();
  });

  test('no_owner when the recorded worker pid is dead, since the last event', () => {
    expect(stalledOf(input({ workerPid: 42, isAlive: () => true }))).toBeNull();
    expect(stalledOf(input({ workerPid: 42, isAlive: () => false }))).toEqual({ reason: 'no_owner', since: iso(NOW - 1000) });
    expect(stalledOf(input({ workerPid: 42, isAlive: () => false, lastEventAt: null, updatedAt: NOW - 5000 }))).toEqual({
      reason: 'no_owner',
      since: iso(NOW - 5000),
    });
    // Without a pid check the pid is not read.
    expect(stalledOf(input({ workerPid: 42 }))).toBeNull();
  });

  test('a live lease wins over a dead worker pid', () => {
    // A run a CLI worker started, later driven over HTTP: the old pid is dead, the server holds the lease.
    const dead = { workerPid: 42, isAlive: () => false };
    expect(stalledOf(input({ ...dead, lease: running(NOW + 20_000) }))).toBeNull();
    // A queued submission has lease info and no owner to lose yet: the pid is not read either.
    expect(stalledOf(input({ ...dead, lease: { status: 'queued', leaseExpiresAt: 0 } }))).toBeNull();
    // A lease that expired within the grace is lost too: the dead pid confirms it, from the expiry.
    expect(stalledOf(input({ ...dead, lease: running(NOW - 5000) }))).toEqual({ reason: 'no_owner', since: iso(NOW - 5000) });
    // A settled submission lost its owner at the settle.
    const settled: SubmissionLease = { status: 'settled', leaseExpiresAt: NOW - 9000, settledAt: NOW - 2000 };
    expect(stalledOf(input({ ...dead, lease: settled }))).toEqual({ reason: 'no_owner', since: iso(NOW - 2000) });
    // With no lease to read, the pid alone decides, as before.
    expect(stalledOf(input({ ...dead, lease: null }))?.reason).toBe('no_owner');
  });

  test('no_progress once the log has been quiet for the threshold', () => {
    expect(stalledOf(input({ lastEventAt: NOW - AFTER + 1 }))).toBeNull();
    expect(stalledOf(input({ lastEventAt: NOW - AFTER }))).toEqual({ reason: 'no_progress', since: iso(NOW - AFTER) });
    expect(stalledOf(input({ lastEventAt: null }))).toBeNull();
    // A live lease does not hide a quiet log.
    expect(stalledOf(input({ lease: running(NOW + 20_000), lastEventAt: NOW - AFTER - 1 }))?.reason).toBe('no_progress');
  });

  test('no_owner wins over no_progress', () => {
    const quiet = NOW - 2 * AFTER;
    const lostAt = NOW - STALLED_LEASE_GRACE_MS - 1;
    expect(stalledOf(input({ lastEventAt: quiet, lease: running(lostAt) }))).toEqual({ reason: 'no_owner', since: iso(lostAt) });
    expect(stalledOf(input({ lastEventAt: quiet, workerPid: 7, isAlive: () => false }))).toEqual({ reason: 'no_owner', since: iso(quiet) });
  });

  test('the result matches StalledSchema', () => {
    const got = stalledOf(input({ lastEventAt: NOW - AFTER }));
    expect(v.is(StalledSchema, got)).toBe(true);
  });
});

// ------------------------------------------------------------------ loader

function submission(seq: number, flue_submission_id?: string, kind?: Submission['kind']): Submission {
  return {
    kind: kind ?? (seq === 1 ? 'initial' : 'steer'),
    seq,
    created_at: iso(NOW - 60_000),
    ...(flue_submission_id !== undefined ? { flue_submission_id } : {}),
    report: null,
    report_md: null,
  };
}

function run(phase: RunPhase, submissions: Submission[], over: Partial<StalledRun> = {}): StalledRun {
  return { run_id: RUN, phase, submissions, updated_at: iso(NOW - 120_000), ...over };
}

function leases(map: Record<string, SubmissionLease>): { read: (id: string) => Promise<SubmissionLease | null>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: async (id) => {
      asked.push(id);
      return map[id] ?? null;
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadStalled', () => {
  test('reads nothing for a run that is not working', async () => {
    const l = leases({});
    let logReads = 0;
    const lastEventAt = async () => {
      logReads++;
      return 0;
    };
    for (const phase of ['completed', 'failed', 'stopped', 'blocked', 'needs_input', 'created'] as const) {
      expect(await loadStalled(run(phase, [submission(1, 'sub_a')]), { stalledAfterMs: AFTER, lease: l.read, lastEventAt, now: () => NOW })).toBeNull();
    }
    expect(l.asked).toEqual([]);
    expect(logReads).toBe(0);
  });

  test("reads the latest submission's lease", async () => {
    const l = leases({ sub_a: running(NOW + 10_000), sub_b: running(NOW - 2 * STALLED_LEASE_GRACE_MS) });
    const got = await loadStalled(run('investigating', [submission(1, 'sub_a'), submission(2, 'sub_b')]), {
      stalledAfterMs: AFTER,
      lease: l.read,
      lastEventAt: async () => NOW,
      now: () => NOW,
    });
    expect(got).toEqual({ reason: 'no_owner', since: iso(NOW - 2 * STALLED_LEASE_GRACE_MS) });
    expect(l.asked).toEqual(['sub_b']);
  });

  test('a joined steer counts its host lease', async () => {
    const l = leases({
      sub_steer: { status: 'joined', leaseExpiresAt: 0, joinedInto: 'sub_host' },
      sub_host: running(NOW - 2 * STALLED_LEASE_GRACE_MS),
    });
    const got = await loadStalled(run('investigating', [submission(1, 'sub_host'), submission(2, 'sub_steer')]), {
      stalledAfterMs: AFTER,
      lease: l.read,
      lastEventAt: async () => NOW,
      now: () => NOW,
    });
    expect(got?.reason).toBe('no_owner');
    expect(l.asked).toEqual(['sub_steer', 'sub_host']);
  });

  test('a failed steer has no Flue id: the host lease counts', async () => {
    const l = leases({ sub_a: running(NOW - 2 * STALLED_LEASE_GRACE_MS) });
    const r = run('investigating', [submission(1, 'sub_a'), submission(2)]);
    expect(currentFlueSubmissionId(r)).toBe('sub_a');
    expect(latestSteerFlueSubmissionId(r)).toBeUndefined();
    const got = await loadStalled(r, { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, now: () => NOW });
    expect(got?.reason).toBe('no_owner');
    expect(l.asked).toEqual(['sub_a']);
  });

  test('a queued steer has no lease of its own: the host lease counts', async () => {
    const l = leases({ sub_steer: { status: 'queued', leaseExpiresAt: 0 }, sub_host: running(NOW - 2 * STALLED_LEASE_GRACE_MS) });
    const r = run('investigating', [submission(1, 'sub_host'), submission(2, 'sub_steer')]);
    expect((await loadStalled(r, { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, now: () => NOW }))?.reason).toBe(
      'no_owner',
    );
    expect(l.asked).toEqual(['sub_steer', 'sub_host']);
    // And a live host is not stalled, whatever the queued steer says.
    const live = leases({ sub_steer: { status: 'queued', leaseExpiresAt: 0 }, sub_host: running(NOW + 20_000) });
    expect(await loadStalled(r, { stalledAfterMs: AFTER, lease: live.read, lastEventAt: async () => NOW, now: () => NOW })).toBeNull();
  });

  test('a steer that runs as its own response counts its own lease, not the settled host', async () => {
    const hostSettled: SubmissionLease = { status: 'settled', leaseExpiresAt: 0, settledAt: NOW - 10 * STALLED_LEASE_GRACE_MS };
    const l = leases({ sub_host: hostSettled, sub_steer: running(NOW + 20_000) });
    const r = run('investigating', [submission(1, 'sub_host'), submission(2, 'sub_steer')]);
    expect(await loadStalled(r, { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, now: () => NOW })).toBeNull();
    expect(l.asked).toEqual(['sub_steer']);
  });

  test('a steer before the latest non-steer submission is not read', async () => {
    const l = leases({ sub_steer: running(NOW + 20_000), sub_ask: running(NOW - 2 * STALLED_LEASE_GRACE_MS) });
    const r = run('investigating', [submission(1, 'sub_host'), submission(2, 'sub_steer'), submission(3, 'sub_ask', 'ask')]);
    expect(stalledSubjectOf(r)).toMatchObject({ flue_submission_id: 'sub_ask' });
    expect(stalledSubjectOf(r).steer_flue_submission_id).toBeUndefined();
    expect((await loadStalled(r, { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, now: () => NOW }))?.reason).toBe(
      'no_owner',
    );
    expect(l.asked).toEqual(['sub_ask']);
  });

  test('a run with no Flue id yet reads no lease', async () => {
    const l = leases({});
    const r = run('dispatched', [submission(1)]);
    expect(currentFlueSubmissionId(r)).toBeUndefined();
    expect(await currentLease(stalledSubjectOf(r), l.read)).toBeNull();
    expect(await loadStalled(r, { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, now: () => NOW })).toBeNull();
    expect(l.asked).toEqual([]);
  });

  test('a CLI-started run driven over HTTP: the live lease wins over the dead pid', async () => {
    const l = leases({ sub_ask: running(NOW + 20_000) });
    const r = run('investigating', [submission(1, 'sub_first'), submission(2, 'sub_ask', 'ask')], { worker_pid: 4242 });
    const deps = { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, isAlive: () => false, now: () => NOW };
    expect(await loadStalled(r, deps)).toBeNull();
    // Without a lease to read, the dead pid still flags it.
    expect((await loadStalled(r, { ...deps, lease: async () => null }))?.reason).toBe('no_owner');
  });

  test('loadStalledSubject takes a run list row as it is', async () => {
    const l = leases({ sub_host: running(NOW - 2 * STALLED_LEASE_GRACE_MS) });
    const row = { run_id: RUN, phase: 'investigating' as const, updated_at: iso(NOW), flue_submission_id: 'sub_host', submissions: 1 };
    const got = await loadStalledSubject(row, { stalledAfterMs: AFTER, lease: l.read, lastEventAt: async () => NOW, now: () => NOW });
    expect(got?.reason).toBe('no_owner');
    expect(await loadStalledSubject({ ...row, phase: 'completed' }, { stalledAfterMs: AFTER, lease: l.read, now: () => NOW })).toBeNull();
    expect(l.asked).toEqual(['sub_host']);
  });

  test('reads the last event from events.jsonl under runsDir', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'triage-stalled-'));
    dirs.push(runsDir);
    mkdirSync(join(runsDir, RUN), { recursive: true });
    const quiet = NOW - AFTER - 5000;
    writeFileSync(join(runsDir, RUN, EVENTS_FILE), `${JSON.stringify({ ts: iso(quiet), source: 'pipeline', type: 'phase', data: {} })}\n`);
    const got = await loadStalled(run('investigating', [submission(1)]), { stalledAfterMs: AFTER, runsDir, lease: async () => null, now: () => NOW });
    expect(got).toEqual({ reason: 'no_progress', since: iso(quiet) });
  });

  test('checks the worker pid when given a check', async () => {
    const r = run('investigating', [submission(1)], { worker_pid: 4242 });
    const base = { stalledAfterMs: AFTER, lease: async () => null, lastEventAt: async () => NOW - 3000, now: () => NOW };
    expect(await loadStalled(r, base)).toBeNull();
    expect(await loadStalled(r, { ...base, isAlive: () => false })).toEqual({ reason: 'no_owner', since: iso(NOW - 3000) });
    expect(await loadStalled(r, { ...base, isAlive: () => true })).toBeNull();
  });

  test('a failed read counts as unknown and never throws', async () => {
    const fail = async (): Promise<never> => {
      throw new Error('store down');
    };
    const r = run('investigating', [submission(1, 'sub_a')], { worker_pid: 1 });
    const got = await loadStalled(r, {
      stalledAfterMs: AFTER,
      lease: fail,
      lastEventAt: fail,
      isAlive: () => {
        throw new Error('no permission');
      },
      now: () => NOW,
    });
    expect(got).toBeNull();
  });

  test('without a runtime, a runs dir or a check, a working run is not stalled', async () => {
    expect(await loadStalled(run('investigating', [submission(1, 'sub_a')]), { stalledAfterMs: AFTER, now: () => NOW })).toBeNull();
  });
});
