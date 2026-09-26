// Agent contract: the Flue submission id that stalled detection reads (D71).
// The run goes through the ingress pipeline (runSubmission from
// src/ingress/submit.ts) on the real Flue runtime, with the fake model.
//
// - Once the dispatch receipt arrives, the run store's submission holds
//   Flue's submission id: the same id the step log's 'dispatch' line names.
// - loadStalled reads the lease of exactly that id. A finished run reads
//   nothing; the same run shown as still investigating, with its submission
//   settled more than the grace ago, is stalled no_owner.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SubmissionLease } from '../../../src/db/submission-lease.ts';
import { loadStalled } from '../../../src/ingress/stalled.ts';
import type { SubmissionDeps } from '../../../src/ingress/submit.ts';
import { createFakeModel, finish, text } from '../../../src/mock/fake-model.ts';
import { flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../../../src/runlog/event-log.ts';
import { readRunEvents } from '../../../src/runlog/read.ts';
import type { Classification } from '../../../src/types/classification.ts';
import type { IdChain } from '../../../src/types/id-chain.ts';
import { STALLED_LEASE_GRACE_MS } from '../../../src/types/stalled.ts';
import { bootTriage, type Booted, contractHome, nextRunId, reportDraft, scriptAgents, triageInit } from './harness.ts';

type SubmitModule = typeof import('../../../src/ingress/submit.ts');

const fake = createFakeModel();
const home = contractHome(fake);
let b: Booted;
let submit: SubmitModule;
let deps: SubmissionDeps;

const CHAIN: IdChain = { ids: { customer_id: 'cust-contract-1' }, hops: [], basic_state: [] };
const CLASSIFICATION: Classification = {
  category: 'transfer_out',
  subcategory: 'transfer not received',
  entities_likely: ['ssfb'],
  money_moved: false,
  misdirected_funds: false,
  tier_proposed: 'mid',
  confidence: 0.9,
  images_seen: false,
};

beforeAll(async () => {
  installRunEventLog({ runsDir: home.config.paths.runsDir });
  b = await bootTriage(fake, home);
  submit = await import('../../../src/ingress/submit.ts');
  deps = {
    ...submit.submissionDeps({ runtime: b.plan.triageRuntime() }),
    identity: async () => ({ id_chain: CHAIN, basic_state: [], gaps: [] }),
    classify: async () => CLASSIFICATION,
    patterns: async () => [],
    embedRun: async () => ({ written: [], unchanged: [], empty: [], gaps: [] }),
  };
});

afterAll(async () => {
  await b?.flue.stop();
  uninstallRunEventLog();
  home.dispose();
});

describe('the Flue submission id on a run store submission (D71)', () => {
  test("runSubmission records the dispatch receipt's id, and loadStalled reads its lease", async () => {
    const id = nextRunId('stalled_flue_id');
    scriptAgents(fake, { triage: [finish(reportDraft(triageInit(id))), text('report written')] });

    const result = await submit.runSubmission({ run_id: id, request: triageInit(id).request, redaction_names: [] }, deps);

    expect(fake.failures()).toEqual([]);
    expect(result).toMatchObject({ run_id: id, status: 'completed', submission_seq: 1 });
    const run = await b.store.getRun(id);
    const flueId = run?.submissions[0]?.flue_submission_id;
    expect(flueId).toBe(result.submission_id);
    expect(flueId).toMatch(/^sub_/);

    await flushRunEventLog();
    const page = await readRunEvents(home.config.paths.runsDir, id, { limit: 5000 });
    const dispatch = page.events.find((e) => e.source === 'pipeline' && e.type === 'dispatch');
    expect((dispatch?.data as { submission_id?: unknown } | undefined)?.submission_id).toBe(flueId);

    if (run === null) throw new Error('run not stored');
    const asked: string[] = [];
    const settledAt = Date.parse(run.updated_at);
    const lease = async (flueSubmissionId: string): Promise<SubmissionLease | null> => {
      asked.push(flueSubmissionId);
      return { status: 'settled', leaseExpiresAt: settledAt, settledAt };
    };
    const now = () => settledAt + STALLED_LEASE_GRACE_MS + 1;

    // A finished run reads no lease.
    expect(await loadStalled(run, { stalledAfterMs: 600_000, lease, now })).toBeNull();
    expect(asked).toEqual([]);
    // The same run as the bug left it: still investigating after Flue settled it.
    const stuck = await loadStalled({ ...run, phase: 'investigating' }, { stalledAfterMs: 600_000, lease, now });
    expect(stuck).toEqual({ reason: 'no_owner', since: new Date(settledAt).toISOString() });
    expect(asked).toEqual([flueId]);
  });
});
