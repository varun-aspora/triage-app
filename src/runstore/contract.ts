// The RunStore contract suite, shared by every provider (folder here, postgres
// in T09.4). It is plain data plus node:assert, so any runner can drive it:
//
//   for (const c of runStoreContract) test(`contract: ${c.name}`, () => runContractCase(c, factory));
//
// A factory builds a fresh, empty store on the given fake clock and returns a
// cleanup. Fixture values are synthetic and pass through redactPersisted like
// real callers do.

import assert from 'node:assert/strict';
import { redactPersisted, type Persisted } from '../gate/redact.ts';
import type { EntityFindings, CodeFindings } from '../types/findings.ts';
import type { InputRequest, InputResolution, InputResolutionStatus } from '../types/input-request.ts';
import type { BlockRecord, BlockResolution, BlockResolutionStatus, ConnectorFailure } from '../types/block.ts';
import type { Report } from '../types/report.ts';
import type { TriageRequest } from '../types/request.ts';
import type { UsageRow } from '../types/usage.ts';
import {
  BlockNotOpenError,
  BlockOpenError,
  InputRequestNotOpenError,
  InputRequestOpenError,
  RunNotFoundError,
  RunStoppedError,
  RunStoreError,
  RunStoreRedactionError,
  type ClassificationRecord,
  type EmbeddingInput,
  type EmbeddingKind,
  type Feedback,
  type FeedbackVerdict,
  type RunStore,
} from './types.ts';

// ------------------------------------------------------------------ harness

export type ContractClock = {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
};

export type ContractSubject = { readonly store: RunStore; cleanup(): Promise<void> };
export type ContractFactory = (clock: ContractClock) => Promise<ContractSubject>;
export type ContractCase = {
  readonly name: string;
  run(store: RunStore, clock: ContractClock): Promise<void>;
};

export const CONTRACT_EPOCH = Date.parse('2026-09-01T00:00:00.000Z');

export function makeClock(start = CONTRACT_EPOCH): ContractClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export async function runContractCase(c: ContractCase, factory: ContractFactory): Promise<void> {
  const clock = makeClock();
  const subject = await factory(clock);
  try {
    await c.run(subject.store, clock);
  } finally {
    await subject.cleanup();
  }
}

// ------------------------------------------------------------------ fixtures

// Run ids without digit runs, so the persisted profile leaves them alone.
export const RUN_A = '01JAAAAAAAAAAAAAAAAAAAAAAA';
export const RUN_B = '01JBBBBBBBBBBBBBBBBBBBBBBB';
export const RUN_C = '01JCCCCCCCCCCCCCCCCCCCCCCC';

// Synthetic values only. They are masked before any store call.
export const SYNTHETIC_PHONE = '+91 98765 43210';
export const SYNTHETIC_EMAIL = 'asha.test@example.com';
export const SYNTHETIC_DIGITS = '555123987';

const AT = '2026-09-01T10:00:00.000Z';

export function sampleRequest(runId: string, requestedBy = 'ops-reviewer'): TriageRequest {
  return {
    request_id: runId,
    interface: 'cli',
    requested_by: requestedBy,
    source: { kind: 'text' },
    messages: [
      { ts: 't1', author: 'support', text: `Customer on ${SYNTHETIC_PHONE} says the transfer is stuck`, is_parent: true },
    ],
    attachments: [],
    hints: {},
    window: { from: AT, to: AT },
    received_at: AT,
  };
}

export function sampleClassification(category: 'transfer_out' | 'onboarding' = 'transfer_out'): ClassificationRecord {
  return {
    decision: {
      proposed: {
        category,
        subcategory: 'stuck',
        entities_likely: ['ssfb'],
        money_moved: true,
        misdirected_funds: false,
        tier_proposed: 'mid',
        confidence: 0.8,
        images_seen: false,
      },
      tier_final: 'strong',
      rule_fired: 'money_moved',
    },
    id_chain: { ids: {}, hops: [], basic_state: [] },
  };
}

export function sampleFindings(summary: string): EntityFindings {
  return {
    evidence: [{ source: 'db', at: AT, query_or_path: 'harbor.account_forms', summary }],
    timeline: [],
    hypotheses: ['the payout is waiting on the bank'],
    confidence: 'medium',
    gaps: [],
  };
}

export function sampleCodeFindings(): CodeFindings {
  return {
    claims: [{ repo: 'harbor', file: 'src/payout.ts', lines: '10-20', what_it_shows: 'retry loop' }],
    confidence: 'high',
  };
}

export function sampleReport(runId: string, statement: string, status: Report['status'] = 'root_cause_confirmed'): Report {
  return {
    run_id: runId,
    env_label: 'test',
    generated_at: AT,
    request: { current_ask: 'why is the transfer stuck', requested_by: 'ops-reviewer' },
    classification: sampleClassification().decision,
    id_chain: { ids: {}, hops: [], basic_state: [] },
    current_state: [],
    timeline: [],
    root_cause: { statement, code_refs: [] },
    scope: { kind: 'single' },
    status,
    cx_answer: { action_owner: 'bank', money_safe: 'yes', should_retry: 'wait', reply_text: 'The bank is processing it.' },
    actions: { cx: [], eng: [], ops_bank: [] },
    suggested_fix: [],
    confidence: 'medium',
    confidence_reason: 'two sources agree',
    evidence_ladder: ['db'],
    entities_consulted: ['ssfb'],
    gaps: [],
    escalated: false,
    escalation_reasons: [],
    images_seen: false,
    repo_commits: [],
    cost: null,
  };
}

export function sampleInputRequest(questionId: string): InputRequest {
  return {
    question_id: questionId,
    kind: 'provide',
    question: 'Which transfer is this about: the one on 2 Sep for 5,000 or the one on 3 Sep for 12,000?',
    why: 'Two transfers match the thread and their outcomes differ.',
    options: ['2 Sep, 5,000', '3 Sep, 12,000'],
    free_text: true,
    asked_at: AT,
  };
}

export function sampleResolution(status: InputResolutionStatus, resolvedAt = AT): InputResolution {
  return { status, resolved_at: resolvedAt, resolved_by: 'ops-reviewer' };
}

export function sampleFailure(system: string, at = AT): ConnectorFailure {
  return { system, tool: 'sql_select', code: 'unreachable', at };
}

export function sampleBlock(blockId: string, systems: string[] = ['ssfb:harbor'], blockedAt = AT): BlockRecord {
  return {
    block_id: blockId,
    systems,
    failures: systems.map((system) => sampleFailure(system, blockedAt)),
    reason: 'The account form lives in harbor and harbor did not answer; nothing else shows the payout state.',
    blocked_at: blockedAt,
    submission_seq: 1,
  };
}

export function sampleBlockResolution(status: BlockResolutionStatus, resolvedAt = AT, note?: string): BlockResolution {
  return { status, resolved_at: resolvedAt, resolved_by: 'ops-reviewer', ...(note !== undefined ? { note } : {}) };
}

export function sampleFeedback(verdict: FeedbackVerdict, givenAt: string): Feedback {
  return { verdict, given_by: 'ops-reviewer', given_at: givenAt, interface: 'cli' };
}

export function sampleEmbedding(kind: EmbeddingKind, model: string, vector: number[], submissionId?: number): EmbeddingInput {
  return {
    ...(submissionId !== undefined ? { submission_id: submissionId } : {}),
    kind,
    model,
    text_sha256: 'ab'.repeat(32),
    source_text: `${kind} text`,
    vector,
  };
}

/** A model id with a dated suffix: the persisted profile would mask its digits, putUsage must not. */
export const USAGE_MODEL = 'anthropic/claude-haiku-4-5-20251001';

export function sampleUsageRow(over: Partial<UsageRow> = {}): UsageRow {
  return {
    model: USAGE_MODEL,
    agent: 'triage',
    purpose: 'agent',
    calls: 3,
    failed_calls: 1,
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 4000,
    cache_write_tokens: 500,
    usd: 0.25,
    ...over,
  };
}

const p = <T>(value: T): Persisted<T> => redactPersisted(value);

async function newRun(store: RunStore, runId: string): Promise<void> {
  await store.createRun(runId, p(sampleRequest(runId)));
}

/** A persisted value whose inner text is changed after redaction. */
function tampered<T extends object>(value: T, mutate: (inner: T) => void): Persisted<T> {
  const box = redactPersisted(value);
  mutate(box.value);
  return box;
}

async function rejectsRedaction(fn: () => Promise<unknown>, pattern: string, secret: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof RunStoreRedactionError, `expected RunStoreRedactionError, got ${String(err)}`);
    assert.ok(err.patterns.includes(pattern as never), `expected pattern ${pattern} in ${err.patterns.join(',')}`);
    assert.ok(err.message.includes(pattern));
    assert.ok(!err.message.includes(secret), 'error message carries the matched text');
    assert.ok(!JSON.stringify(err.paths).includes(secret), 'error paths carry the matched text');
    return true;
  });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ------------------------------------------------------------------ cases

export const runStoreContract: readonly ContractCase[] = [
  {
    name: 'createRun twice with same run_id is a no-op, not an error',
    async run(store, clock) {
      await store.createRun(RUN_A, p(sampleRequest(RUN_A, 'first-caller')));
      const first = await store.getRun(RUN_A);
      clock.advance(HOUR);
      await store.createRun(RUN_A, p(sampleRequest(RUN_A, 'second-caller')));
      const second = await store.getRun(RUN_A);
      assert.ok(first && second);
      assert.equal(second.request.requested_by, 'first-caller');
      assert.equal(second.created_at, first.created_at);
      assert.equal(second.phase, 'created');
      assert.equal((await store.listRuns()).length, 1);
    },
  },
  {
    name: 'stored request is the persisted-profile copy',
    async run(store) {
      await newRun(store, RUN_A);
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.run_id, RUN_A);
      assert.ok(!JSON.stringify(run).includes(SYNTHETIC_PHONE));
      assert.ok(!JSON.stringify(run).includes('98765'));
    },
  },
  {
    name: 'getRun on an unknown run is null and writes to it throw RunNotFoundError',
    async run(store) {
      assert.equal(await store.getRun(RUN_B), null);
      const notFound = (err: unknown) => err instanceof RunNotFoundError;
      await assert.rejects(() => store.setPhase(RUN_B, 'failed'), notFound);
      await assert.rejects(() => store.putEvidence(RUN_B, 'ssfb', p(sampleFindings('x'))), notFound);
      await assert.rejects(() => store.addSubmission(RUN_B, p({ kind: 'initial' as const })), notFound);
      await assert.rejects(() => store.putReport(RUN_B, 1, p(sampleReport(RUN_B, 'x')), p('# x')), notFound);
      await assert.rejects(() => store.putClassification(RUN_B, p(sampleClassification())), notFound);
      await assert.rejects(() => store.putFeedback(RUN_B, p(sampleFeedback('correct', AT))), notFound);
      await assert.rejects(() => store.putEmbedding(RUN_B, p(sampleEmbedding('case', 'm/x', [1, 0]))), notFound);
      await assert.rejects(() => store.putUsage(RUN_B, 1, [sampleUsageRow()], true), notFound);
      await assert.rejects(() => store.putUsage(RUN_B, 1, [sampleUsageRow()], false), notFound);
      assert.equal(await store.getRun(RUN_B), null);
    },
  },
  {
    name: 'invalid run ids are refused before any path is built',
    async run(store) {
      for (const bad of ['../escape', 'a/b', '', 'x'.repeat(65), 'has space']) {
        await assert.rejects(() => store.getRun(bad), (err: unknown) => err instanceof RunStoreError);
        await assert.rejects(() => store.createRun(bad, p(sampleRequest(RUN_A))), (err: unknown) => err instanceof RunStoreError);
      }
    },
  },
  {
    name: 'setPhase records the phase, reason and worker pid',
    async run(store, clock) {
      await newRun(store, RUN_A);
      clock.advance(1000);
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4242 });
      await store.setPhase(RUN_A, 'failed', { reason: 'AgentRunError' });
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.phase, 'failed');
      assert.equal(run.phase_reason, 'AgentRunError');
      assert.equal(run.worker_pid, 4242);
      assert.ok(Date.parse(run.updated_at) > Date.parse(run.created_at));
      await assert.rejects(() => store.setPhase(RUN_A, 'nonsense' as never), (err: unknown) => err instanceof RunStoreError);
      // null clears the pid (D71: a dispatch from a process that is not a worker); setPhaseIf the same.
      await store.setPhase(RUN_A, 'dispatched', { worker_pid: null });
      assert.equal((await store.getRun(RUN_A))?.worker_pid, undefined);
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4343 });
      assert.equal(await store.setPhaseIf(RUN_A, ['investigating'], 'dispatched', { worker_pid: null }), true);
      assert.equal((await store.getRun(RUN_A))?.worker_pid, undefined);
    },
  },
  {
    name: 'setPhaseIf writes only from a listed phase, and reports whether it wrote',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4242, reason: 'x' });
      clock.advance(1000);
      assert.equal(await store.setPhaseIf(RUN_A, ['dispatched', 'investigating'], 'failed', { reason: 'AgentRunError' }), true);
      let run = await store.getRun(RUN_A);
      assert.equal(run?.phase, 'failed');
      assert.equal(run?.phase_reason, 'AgentRunError');
      assert.equal(run?.worker_pid, 4242);
      assert.equal(run?.updated_at, new Date(clock.now()).toISOString());

      // Not a listed phase: nothing is written, updated_at included.
      clock.advance(1000);
      assert.equal(await store.setPhaseIf(RUN_A, ['investigating'], 'completed'), false);
      run = await store.getRun(RUN_A);
      assert.equal(run?.phase, 'failed');
      assert.equal(run?.phase_reason, 'AgentRunError');
      assert.equal(run?.updated_at, new Date(clock.now() - 1000).toISOString());

      // A write with no reason clears it, and a new pid replaces the old one, as setPhase does.
      assert.equal(await store.setPhaseIf(RUN_A, ['completed', 'failed'], 'investigating', { worker_pid: 5151 }), true);
      run = await store.getRun(RUN_A);
      assert.equal(run?.phase, 'investigating');
      assert.equal(run?.phase_reason, undefined);
      assert.equal(run?.worker_pid, 5151);

      // A parked run is left alone unless its phase is listed.
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      assert.equal(await store.setPhaseIf(RUN_A, ['dispatched'], 'investigating'), false);
      assert.equal((await store.getRun(RUN_A))?.phase, 'needs_input');
      assert.equal((await store.getRun(RUN_A))?.input_request?.question_id, 'q1');

      // resume is not read: a stopped run is written only when 'stopped' is listed.
      await newRun(store, RUN_B);
      await store.setPhase(RUN_B, 'investigating');
      await store.markStopped(RUN_B, 'cancelled', p(sampleResolution('cancelled')));
      assert.equal(await store.setPhaseIf(RUN_B, ['investigating', 'completed'], 'dispatched', { resume: true }), false);
      assert.equal((await store.getRun(RUN_B))?.phase, 'stopped');
      assert.equal(await store.setPhaseIf(RUN_B, ['stopped'], 'dispatched'), true);
      assert.equal((await store.getRun(RUN_B))?.phase, 'dispatched');

      const storeError = (err: unknown) => err instanceof RunStoreError && !(err instanceof RunNotFoundError);
      await assert.rejects(() => store.setPhaseIf(RUN_A, [], 'completed'), storeError);
      await assert.rejects(() => store.setPhaseIf(RUN_A, ['nonsense' as never], 'completed'), storeError);
      await assert.rejects(() => store.setPhaseIf(RUN_A, ['investigating'], 'nonsense' as never), storeError);
      await assert.rejects(() => store.setPhaseIf(RUN_C, ['investigating'], 'completed'), (err: unknown) => err instanceof RunNotFoundError);
    },
  },
  {
    name: 'setPhaseIf is a compare-and-set: of two racing writes from one phase, one wins',
    async run(store) {
      await newRun(store, RUN_A);
      await store.setPhase(RUN_A, 'investigating');
      const results = await Promise.all([
        store.setPhaseIf(RUN_A, ['investigating'], 'completed'),
        store.setPhaseIf(RUN_A, ['investigating'], 'failed', { reason: 'AgentRunError' }),
      ]);
      assert.deepEqual([...results].sort(), [false, true]);
      const run = await store.getRun(RUN_A);
      assert.equal(run?.phase, results[0] ? 'completed' : 'failed');
    },
  },
  {
    name: 'putInputRequest opens one question and moves the run to needs_input; a second one is refused',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4242, reason: 'x' });
      clock.advance(HOUR);
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.phase, 'needs_input');
      assert.equal(run.phase_reason, undefined);
      assert.equal(run.worker_pid, 4242);
      assert.deepEqual(run.input_request, sampleInputRequest('q1'));
      assert.deepEqual(run.input_history, []);
      assert.equal(run.updated_at, new Date(clock.now()).toISOString());
      await assert.rejects(
        () => store.putInputRequest(RUN_A, p(sampleInputRequest('q2'))),
        (err: unknown) => err instanceof InputRequestOpenError && err.questionId === 'q1',
      );
      await assert.rejects(
        () => store.putInputRequest(RUN_B, p(sampleInputRequest('q1'))),
        (err: unknown) => err instanceof RunNotFoundError,
      );
      // A run that has not asked anything has no open question and no history.
      await newRun(store, RUN_C);
      const fresh = await store.getRun(RUN_C);
      assert.equal(fresh?.input_request, null);
      assert.deepEqual(fresh?.input_history, []);
    },
  },
  {
    name: 'markStopped stops an unfinished run, and a stopped run stays stopped until a resume',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4242 });
      clock.advance(HOUR);
      assert.equal(await store.markStopped(RUN_A, 'cancelled', p(sampleResolution('cancelled'))), 'investigating');
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.phase, 'stopped');
      assert.equal(run.phase_reason, 'cancelled');
      assert.equal(run.worker_pid, 4242);
      assert.equal(run.updated_at, new Date(clock.now()).toISOString());
      // The pipeline's later writes are refused and change nothing.
      assert.equal(await store.setPhase(RUN_A, 'completed'), false);
      assert.equal(await store.setPhase(RUN_A, 'failed', { reason: 'AgentRunError' }), false);
      const still = await store.getRun(RUN_A);
      assert.equal(still?.phase, 'stopped');
      assert.equal(still?.phase_reason, 'cancelled');
      await assert.rejects(() => store.putInputRequest(RUN_A, p(sampleInputRequest('q1'))), (err: unknown) => err instanceof RunStoppedError);
      // A follow-up resumes it.
      assert.equal(await store.setPhase(RUN_A, 'dispatched', { resume: true }), true);
      assert.equal((await store.getRun(RUN_A))?.phase, 'dispatched');
      assert.equal(await store.setPhase(RUN_A, 'completed'), true);
    },
  },
  {
    name: 'markStopped closes an open question, leaves a finished run alone and refuses a missing run',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      clock.advance(HOUR);
      const at = new Date(clock.now()).toISOString();
      assert.equal(await store.markStopped(RUN_A, 'cancelled', p(sampleResolution('cancelled', at))), 'needs_input');
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.phase, 'stopped');
      assert.equal(run.input_request, null);
      assert.deepEqual(run.input_history, [{ ...sampleInputRequest('q1'), ...sampleResolution('cancelled', at) }]);
      // Already stopped, completed or failed: nothing is written.
      assert.equal(await store.markStopped(RUN_A, 'again', p(sampleResolution('cancelled'))), null);
      assert.equal((await store.getRun(RUN_A))?.phase_reason, 'cancelled');
      await newRun(store, RUN_B);
      await store.setPhase(RUN_B, 'completed');
      const before = await store.getRun(RUN_B);
      clock.advance(HOUR);
      assert.equal(await store.markStopped(RUN_B, 'cancelled', p(sampleResolution('cancelled'))), null);
      const after = await store.getRun(RUN_B);
      assert.equal(after?.phase, 'completed');
      assert.equal(after?.updated_at, before?.updated_at);
      await assert.rejects(
        () => store.markStopped(RUN_C, 'cancelled', p(sampleResolution('cancelled'))),
        (err: unknown) => err instanceof RunNotFoundError,
      );
    },
  },
  {
    name: 'resolveInputRequest closes the open question into the history and leaves the phase alone',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      const notOpen = (err: unknown) => err instanceof InputRequestNotOpenError;
      await assert.rejects(() => store.resolveInputRequest(RUN_A, 'q2', p(sampleResolution('answered'))), notOpen);
      await store.setPhase(RUN_A, 'dispatched', { worker_pid: 99 });
      clock.advance(HOUR);
      const at = new Date(clock.now()).toISOString();
      await store.resolveInputRequest(RUN_A, 'q1', p(sampleResolution('answered', at)));
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.input_request, null);
      assert.equal(run.phase, 'dispatched');
      assert.equal(run.worker_pid, 99);
      assert.deepEqual(run.input_history, [{ ...sampleInputRequest('q1'), ...sampleResolution('answered', at) }]);
      await assert.rejects(() => store.resolveInputRequest(RUN_A, 'q1', p(sampleResolution('skipped'))), notOpen);
      // The next question keeps the history.
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q2')));
      await store.resolveInputRequest(RUN_A, 'q2', p(sampleResolution('skipped')));
      const again = await store.getRun(RUN_A);
      assert.equal(again?.input_request, null);
      assert.deepEqual(
        again?.input_history.map((r) => [r.question_id, r.status]),
        [
          ['q1', 'answered'],
          ['q2', 'skipped'],
        ],
      );
      await assert.rejects(() => store.resolveInputRequest(RUN_B, 'q1', p(sampleResolution('answered'))), (err: unknown) => err instanceof RunNotFoundError);
      await assert.rejects(() => store.resolveInputRequest(RUN_A, 'not an id', p(sampleResolution('answered'))), (err: unknown) => err instanceof RunStoreError);
    },
  },
  {
    name: 'putBlock parks the run in phase blocked with the open block; a second putBlock throws BlockOpenError',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4242, reason: 'x' });
      clock.advance(HOUR);
      await store.putBlock(RUN_A, p(sampleBlock('b1')));
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.phase, 'blocked');
      assert.equal(run.phase_reason, undefined);
      assert.equal(run.worker_pid, 4242);
      assert.deepEqual(run.block, sampleBlock('b1'));
      assert.deepEqual(run.block_history, []);
      assert.equal(run.input_request, null);
      assert.equal(run.updated_at, new Date(clock.now()).toISOString());
      await assert.rejects(
        () => store.putBlock(RUN_A, p(sampleBlock('b2'))),
        (err: unknown) => err instanceof BlockOpenError && err.runId === RUN_A && err.blockId === 'b1',
      );
      assert.equal((await store.getRun(RUN_A))?.block?.block_id, 'b1');
      await assert.rejects(() => store.putBlock(RUN_B, p(sampleBlock('b1'))), (err: unknown) => err instanceof RunNotFoundError);
      // The list shows the phase; the summary has no block field.
      const [summary] = await store.listRuns({ phase: 'blocked' });
      assert.equal(summary?.run_id, RUN_A);
      assert.ok(!('block' in (summary ?? {})));
      // A run that never blocked has no open block and no history.
      await newRun(store, RUN_C);
      const fresh = await store.getRun(RUN_C);
      assert.equal(fresh?.block, null);
      assert.deepEqual(fresh?.block_history, []);
    },
  },
  {
    name: 'putBlock is refused while a question is open and on a stopped run',
    async run(store) {
      await newRun(store, RUN_A);
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      await assert.rejects(
        () => store.putBlock(RUN_A, p(sampleBlock('b1'))),
        (err: unknown) => err instanceof InputRequestOpenError && err.questionId === 'q1',
      );
      const run = await store.getRun(RUN_A);
      assert.equal(run?.phase, 'needs_input');
      assert.equal(run?.block, null);
      await newRun(store, RUN_B);
      await store.markStopped(RUN_B, 'cancelled', p(sampleResolution('cancelled')));
      await assert.rejects(() => store.putBlock(RUN_B, p(sampleBlock('b1'))), (err: unknown) => err instanceof RunStoppedError);
      assert.equal((await store.getRun(RUN_B))?.phase, 'stopped');
      assert.equal((await store.getRun(RUN_B))?.block, null);
    },
  },
  {
    name: 'resolveBlock moves the open block into the history and leaves the phase alone; the wrong id throws BlockNotOpenError',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.putBlock(RUN_A, p(sampleBlock('b1')));
      const notOpen = (err: unknown) => err instanceof BlockNotOpenError;
      await assert.rejects(() => store.resolveBlock(RUN_A, 'b2', p(sampleBlockResolution('resumed'))), notOpen);
      // The caller moves the phase itself; the open block survives a phase write.
      await store.setPhase(RUN_A, 'dispatched', { worker_pid: 99 });
      clock.advance(HOUR);
      const at = new Date(clock.now()).toISOString();
      await store.resolveBlock(RUN_A, 'b1', p(sampleBlockResolution('resumed', at, 'harbor is back')));
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.block, null);
      assert.equal(run.phase, 'dispatched');
      assert.equal(run.worker_pid, 99);
      assert.equal(run.updated_at, at);
      assert.deepEqual(run.block_history, [{ ...sampleBlock('b1'), ...sampleBlockResolution('resumed', at, 'harbor is back') }]);
      await assert.rejects(() => store.resolveBlock(RUN_A, 'b1', p(sampleBlockResolution('resumed'))), notOpen);
      // The next block keeps the history, and a question can open again after a resume.
      await store.putBlock(RUN_A, p(sampleBlock('b2', ['ssfb:harbor', 'global:codegraph'])));
      await store.resolveBlock(RUN_A, 'b2', p(sampleBlockResolution('resumed')));
      const again = await store.getRun(RUN_A);
      assert.equal(again?.block, null);
      assert.deepEqual(
        again?.block_history.map((b) => [b.block_id, b.status, b.systems.length, b.note]),
        [
          ['b1', 'resumed', 1, 'harbor is back'],
          ['b2', 'resumed', 2, undefined],
        ],
      );
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      assert.equal((await store.getRun(RUN_A))?.block_history.length, 2);
      await assert.rejects(
        () => store.resolveBlock(RUN_B, 'b1', p(sampleBlockResolution('resumed'))),
        (err: unknown) => err instanceof RunNotFoundError,
      );
      await assert.rejects(
        () => store.resolveBlock(RUN_A, 'not an id', p(sampleBlockResolution('resumed'))),
        (err: unknown) => err instanceof RunStoreError,
      );
    },
  },
  {
    name: 'markStopped on a blocked run closes the block as cancelled',
    async run(store, clock) {
      await newRun(store, RUN_A);
      await store.putBlock(RUN_A, p(sampleBlock('b1')));
      clock.advance(HOUR);
      const at = new Date(clock.now()).toISOString();
      assert.equal(await store.markStopped(RUN_A, 'cancelled', p(sampleResolution('cancelled', at))), 'blocked');
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.phase, 'stopped');
      assert.equal(run.phase_reason, 'cancelled');
      assert.equal(run.block, null);
      assert.deepEqual(run.block_history, [
        { ...sampleBlock('b1'), status: 'cancelled', resolved_at: at, resolved_by: 'ops-reviewer' },
      ]);
      assert.deepEqual(run.input_history, []);
      await assert.rejects(
        () => store.resolveBlock(RUN_A, 'b1', p(sampleBlockResolution('resumed'))),
        (err: unknown) => err instanceof BlockNotOpenError,
      );
      // A follow-up on the stopped run starts with no open block and keeps the history.
      assert.equal(await store.setPhase(RUN_A, 'dispatched', { resume: true }), true);
      const resumed = await store.getRun(RUN_A);
      assert.equal(resumed?.block, null);
      assert.equal(resumed?.block_history.length, 1);
    },
  },
  {
    name: 'a resume submission keeps the block id and the note',
    async run(store) {
      await newRun(store, RUN_A);
      const seq = await store.addSubmission(RUN_A, p({ kind: 'resume' as const, block_id: 'b1', note: 'harbor is back' }));
      assert.equal(seq, 1);
      const bare = await store.addSubmission(RUN_A, p({ kind: 'resume' as const }));
      assert.equal(bare, 2);
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.submissions[0]?.kind, 'resume');
      assert.equal(run.submissions[0]?.block_id, 'b1');
      assert.equal(run.submissions[0]?.note, 'harbor is back');
      assert.equal(run.submissions[0]?.question_id, undefined);
      assert.equal(run.submissions[0]?.report, null);
      assert.equal(run.submissions[1]?.kind, 'resume');
      assert.equal(run.submissions[1]?.block_id, undefined);
      assert.equal(run.submissions[1]?.note, undefined);
      await assert.rejects(
        () => store.addSubmission(RUN_A, p({ kind: 'resume' as const, block_id: 'not an id' })),
        (err: unknown) => err instanceof RunStoreError,
      );
      assert.equal((await store.listRuns())[0]?.submissions, 2);
    },
  },
  {
    name: 'an answer submission keeps the question id and the answer text',
    async run(store) {
      await newRun(store, RUN_A);
      const seq = await store.addSubmission(RUN_A, p({ kind: 'answer' as const, question_id: 'q1', answer: 'the second transfer' }));
      assert.equal(seq, 1);
      const skipped = await store.addSubmission(RUN_A, p({ kind: 'answer' as const, question_id: 'q2' }));
      assert.equal(skipped, 2);
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.submissions[0]?.kind, 'answer');
      assert.equal(run.submissions[0]?.question_id, 'q1');
      assert.equal(run.submissions[0]?.answer, 'the second transfer');
      assert.equal(run.submissions[1]?.question_id, 'q2');
      assert.equal(run.submissions[1]?.answer, undefined);
      assert.equal(run.submissions[0]?.report, null);
    },
  },
  {
    name: 'setSubmissionFlueId records the Flue id on one submission and leaves updated_at alone (D71)',
    async run(store, clock) {
      await newRun(store, RUN_A);
      const s1 = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      const s2 = await store.addSubmission(RUN_A, p({ kind: 'steer' as const, note: 'check the payout too' }));
      const before = (await store.getRun(RUN_A))?.updated_at;
      assert.equal((await store.getRun(RUN_A))?.submissions[0]?.flue_submission_id, undefined);

      clock.advance(5_000);
      // A ULID holds digit runs the persisted profile would mask; the id is kept as sent.
      await store.setSubmissionFlueId(RUN_A, s1, 'sub_01K5ZQ3123456789ABCDEFGHJK');
      await store.setSubmissionFlueId(RUN_A, s2, 'sub_ik_0123456789abcdef0123456789abcdef');
      let run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.updated_at, before);
      assert.equal(run.submissions[0]?.flue_submission_id, 'sub_01K5ZQ3123456789ABCDEFGHJK');
      assert.equal(run.submissions[1]?.kind, 'steer');
      assert.equal(run.submissions[1]?.note, 'check the payout too');
      assert.equal(run.submissions[1]?.flue_submission_id, 'sub_ik_0123456789abcdef0123456789abcdef');

      // A second call replaces the id and touches no other field.
      await store.setSubmissionFlueId(RUN_A, s1, 'sub-retry');
      run = await store.getRun(RUN_A);
      assert.equal(run?.submissions[0]?.flue_submission_id, 'sub-retry');
      assert.equal(run?.submissions[0]?.kind, 'initial');
      assert.equal(run?.submissions[0]?.report, null);

      const storeError = (err: unknown) => err instanceof RunStoreError && !(err instanceof RunNotFoundError);
      await assert.rejects(() => store.setSubmissionFlueId(RUN_A, 9, 'sub_x'), storeError);
      await assert.rejects(() => store.setSubmissionFlueId(RUN_A, 0, 'sub_x'), storeError);
      await assert.rejects(() => store.setSubmissionFlueId(RUN_A, s1, 'not an id'), storeError);
      await assert.rejects(() => store.setSubmissionFlueId(RUN_A, s1, ''), storeError);
      await assert.rejects(() => store.setSubmissionFlueId(RUN_B, 1, 'sub_x'), (err: unknown) => err instanceof RunNotFoundError);
      assert.equal((await store.getRun(RUN_A))?.submissions[0]?.flue_submission_id, 'sub-retry');
    },
  },
  {
    name: 'putClassification stores the decision and id chain',
    async run(store) {
      await newRun(store, RUN_A);
      await store.putClassification(RUN_A, p(sampleClassification()));
      const run = await store.getRun(RUN_A);
      assert.equal(run?.classification?.decision.tier_final, 'strong');
      assert.deepEqual(run?.classification?.id_chain, { ids: {}, hops: [], basic_state: [] });
    },
  },
  {
    name: 'putEvidence returns incrementing versions per key; getRun returns latest',
    async run(store) {
      await newRun(store, RUN_A);
      assert.equal(await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('first look'))), 1);
      assert.equal(await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('second look'))), 2);
      assert.equal(await store.putEvidence(RUN_A, 'code', p(sampleCodeFindings())), 1);
      assert.equal(await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('third look'))), 3);
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.evidence.ssfb?.version, 3);
      assert.deepEqual(run.evidence.ssfb?.findings, sampleFindings('third look'));
      assert.equal(run.evidence.code?.version, 1);
      assert.deepEqual(run.evidence.code?.findings, sampleCodeFindings());
      assert.equal(run.evidence.atspl, undefined);
      await assert.rejects(
        () => store.putEvidence(RUN_A, 'shivalik' as never, p(sampleFindings('x'))),
        (err: unknown) => err instanceof RunStoreError,
      );
    },
  },
  {
    name: 'concurrent putEvidence on one key gives distinct versions',
    async run(store) {
      await newRun(store, RUN_A);
      const versions = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => store.putEvidence(RUN_A, 'atspl', p(sampleFindings(`look ${n}`)))),
      );
      assert.deepEqual([...versions].sort(), [1, 2, 3, 4, 5]);
      assert.equal((await store.getRun(RUN_A))?.evidence.atspl?.version, 5);
    },
  },
  {
    name: 'putReport for submission 1 and 2 both retrievable',
    async run(store) {
      await newRun(store, RUN_A);
      const s1 = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      const s2 = await store.addSubmission(RUN_A, p({ kind: 'ask' as const, question: 'was the refund sent?' }));
      assert.deepEqual([s1, s2], [1, 2]);
      await store.putReport(RUN_A, s1, p(sampleReport(RUN_A, 'first answer')), p('# first'));
      await store.putReport(RUN_A, s2, p(sampleReport(RUN_A, 'second answer', 'resolved')), p('# second'));
      let run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.equal(run.submissions.length, 2);
      assert.equal(run.submissions[0]?.report?.root_cause?.statement, 'first answer');
      assert.equal(run.submissions[0]?.report_md, '# first');
      assert.equal(run.submissions[1]?.kind, 'ask');
      assert.equal(run.submissions[1]?.question, 'was the refund sent?');
      assert.equal(run.submissions[1]?.report?.root_cause?.statement, 'second answer');
      assert.equal(run.report?.root_cause?.statement, 'second answer');
      assert.equal(run.report_md, '# second');

      // Rewriting the older submission's report leaves the run's report on the latest.
      await store.putReport(RUN_A, s1, p(sampleReport(RUN_A, 'first answer, retried')), p('# first again'));
      run = await store.getRun(RUN_A);
      assert.equal(run?.submissions[0]?.report?.root_cause?.statement, 'first answer, retried');
      assert.equal(run?.report?.root_cause?.statement, 'second answer');

      await assert.rejects(
        () => store.putReport(RUN_A, 9, p(sampleReport(RUN_A, 'nowhere')), p('# none')),
        (err: unknown) => err instanceof RunStoreError,
      );
    },
  },
  {
    name: 'a submission without a report is listed with report null',
    async run(store) {
      await newRun(store, RUN_A);
      await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      const run = await store.getRun(RUN_A);
      assert.equal(run?.submissions.length, 1);
      assert.equal(run?.submissions[0]?.report, null);
      assert.equal(run?.report, null);
      assert.equal(run?.report_md, null);
    },
  },
  {
    name: 'putFeedback twice, latest verdict wins, both lines kept',
    async run(store) {
      await newRun(store, RUN_A);
      await store.putFeedback(RUN_A, p(sampleFeedback('wrong', '2026-09-02T10:00:00.000Z')));
      await store.putFeedback(RUN_A, p({ ...sampleFeedback('partial', '2026-09-01T09:00:00.000Z'), faster_path: 'check the payout table first' }));
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.deepEqual(run.feedback.map((f) => f.verdict), ['wrong', 'partial']);
      assert.equal(run.feedback_latest?.verdict, 'partial');
      assert.equal(run.feedback_latest?.faster_path, 'check the payout table first');
      const [summary] = await store.listRuns();
      assert.equal(summary?.feedback_verdict, 'partial');
    },
  },
  {
    name: 'claimIdempotencyKey same key within TTL -> same run_id; after TTL (fake clock) -> new run_id',
    async run(store, clock) {
      const ttl = 10 * 60_000;
      assert.equal(await store.claimIdempotencyKey('slack:thread-1', RUN_A, ttl), RUN_A);
      clock.advance(ttl - 1);
      assert.equal(await store.claimIdempotencyKey('slack:thread-1', RUN_B, ttl), RUN_A);
      assert.equal(await store.claimIdempotencyKey('slack:thread-2', RUN_B, ttl), RUN_B);
      clock.advance(2);
      assert.equal(await store.claimIdempotencyKey('slack:thread-1', RUN_C, ttl), RUN_C);
      assert.equal(await store.claimIdempotencyKey('slack:thread-1', RUN_A, ttl), RUN_C);
    },
  },
  {
    name: 'clearExpiredIdempotencyKeys removes only expired claims',
    async run(store, clock) {
      await store.claimIdempotencyKey('old', RUN_A, 1000);
      clock.advance(500);
      await store.claimIdempotencyKey('new', RUN_B, 10_000);
      clock.advance(600);
      assert.equal(await store.clearExpiredIdempotencyKeys(), 1);
      assert.equal(await store.claimIdempotencyKey('new', RUN_C, 10_000), RUN_B);
      assert.equal(await store.claimIdempotencyKey('old', RUN_C, 10_000), RUN_C);
    },
  },
  {
    name: 'claimIdempotencyKey refuses a bad ttl, key or run id',
    async run(store) {
      const refused = (err: unknown) => err instanceof RunStoreError;
      await assert.rejects(() => store.claimIdempotencyKey('k', RUN_A, 0), refused);
      await assert.rejects(() => store.claimIdempotencyKey('k', RUN_A, Number.NaN), refused);
      await assert.rejects(() => store.claimIdempotencyKey('', RUN_A, 1000), refused);
      await assert.rejects(() => store.claimIdempotencyKey('k', '../x', 1000), refused);
    },
  },
  {
    name: 'findSimilar orders by cosine, filters by model and kind, excludes self run',
    async run(store) {
      for (const id of [RUN_A, RUN_B, RUN_C]) await newRun(store, id);
      const model = 'ollama/nomic-embed-text';
      await store.putEmbedding(RUN_A, p(sampleEmbedding('case', model, [1, 0, 0])));
      await store.putEmbedding(RUN_B, p(sampleEmbedding('case', model, [0.9, 0.1, 0])));
      await store.putEmbedding(RUN_C, p(sampleEmbedding('case', model, [0, 1, 0])));
      await store.putEmbedding(RUN_C, p(sampleEmbedding('request', model, [0.99, 0.01, 0], 1)));
      await store.putEmbedding(RUN_B, p(sampleEmbedding('case', 'openai/other-model', [1, 0, 0])));

      const all = await store.findSimilar({ vector: [1, 0, 0], model });
      assert.deepEqual(
        all.map((h) => [h.run_id, h.kind]),
        [
          [RUN_A, 'case'],
          [RUN_C, 'request'],
          [RUN_B, 'case'],
          [RUN_C, 'case'],
        ],
      );
      assert.ok(Math.abs((all[0]?.similarity ?? 0) - 1) < 1e-9);
      assert.ok(all.every((h) => h.model === model));
      for (let i = 1; i < all.length; i++) assert.ok((all[i - 1]?.similarity ?? 0) >= (all[i]?.similarity ?? 0));
      assert.equal(all.find((h) => h.kind === 'request')?.submission_id, 1);

      const cases = await store.findSimilar({ vector: [1, 0, 0], model, kinds: ['case'], excludeRunId: RUN_A });
      assert.deepEqual(cases.map((h) => h.run_id), [RUN_B, RUN_C]);

      const top = await store.findSimilar({ vector: [1, 0, 0], model, limit: 1, excludeRunId: RUN_A });
      assert.deepEqual(top.map((h) => [h.run_id, h.kind]), [[RUN_C, 'request']]);

      const other = await store.findSimilar({ vector: [1, 0, 0], model: 'openai/other-model' });
      assert.deepEqual(other.map((h) => h.run_id), [RUN_B]);
    },
  },
  {
    name: 'findSimilar with no embeddings returns []',
    async run(store) {
      assert.deepEqual(await store.findSimilar({ vector: [1, 0], model: 'ollama/x' }), []);
      await newRun(store, RUN_A);
      assert.deepEqual(await store.findSimilar({ vector: [1, 0], model: 'ollama/x' }), []);
    },
  },
  {
    name: 'putEmbedding replaces the row with the same kind, model and submission',
    async run(store) {
      await newRun(store, RUN_A);
      const model = 'ollama/x';
      await store.putEmbedding(RUN_A, p(sampleEmbedding('case', model, [1, 0])));
      await store.putEmbedding(RUN_A, p(sampleEmbedding('case', model, [0, 1])));
      await store.putEmbedding(RUN_A, p(sampleEmbedding('request', model, [1, 1], 1)));
      const run = await store.getRun(RUN_A);
      assert.equal(run?.embeddings.length, 2);
      assert.deepEqual(
        run?.embeddings.map((e) => [e.kind, e.dims]).sort(),
        [
          ['case', 2],
          ['request', 2],
        ],
      );
      const hits = await store.findSimilar({ vector: [0, 1], model, kinds: ['case'] });
      assert.ok(Math.abs((hits[0]?.similarity ?? 0) - 1) < 1e-9);
      await assert.rejects(
        () => store.putEmbedding(RUN_A, p(sampleEmbedding('case', model, []))),
        (err: unknown) => err instanceof RunStoreError,
      );
      await assert.rejects(
        () => store.putEmbedding(RUN_A, p({ ...sampleEmbedding('case', model, [1]), kind: 'root_cause' as never })),
        (err: unknown) => err instanceof RunStoreError,
      );
    },
  },
  {
    name: 'deleteRun removes everything for that run and getRun returns null',
    async run(store) {
      await newRun(store, RUN_A);
      await newRun(store, RUN_B);
      const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      await store.putClassification(RUN_A, p(sampleClassification()));
      await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('look')));
      await store.putReport(RUN_A, seq, p(sampleReport(RUN_A, 'answer')), p('# answer'));
      await store.putFeedback(RUN_A, p(sampleFeedback('correct', AT)));
      await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/x', [1, 0])));
      await store.putUsage(RUN_A, 0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify' })], true);
      await store.putUsage(RUN_A, seq, [sampleUsageRow()], true);
      await store.claimIdempotencyKey('key-a', RUN_A, DAY);

      assert.equal(await store.deleteRun(RUN_A), true);
      assert.equal(await store.getRun(RUN_A), null);
      assert.deepEqual((await store.listRuns()).map((r) => r.run_id), [RUN_B]);
      assert.deepEqual(await store.findSimilar({ vector: [1, 0], model: 'ollama/x' }), []);
      // The claim went with the run, so the key is free again.
      assert.equal(await store.claimIdempotencyKey('key-a', RUN_C, DAY), RUN_C);
      assert.equal(await store.deleteRun(RUN_A), false);
      assert.ok(await store.getRun(RUN_B));
      // The usage went too: a new run under the same id starts with none.
      await newRun(store, RUN_A);
      assert.deepEqual((await store.getRun(RUN_A))?.usage, []);
      assert.equal((await store.listRuns()).find((r) => r.run_id === RUN_A)?.tokens_total, undefined);
    },
  },
  {
    // No foreign keys cascade (D60): deleteRun clears each kind of row itself.
    name: 'deleteRun clears every kind of row, in every embedding model, and leaves other runs alone',
    async run(store) {
      const fill = async (id: string): Promise<number> => {
        await newRun(store, id);
        const seq = await store.addSubmission(id, p({ kind: 'initial' as const }));
        await store.putEvidence(id, 'ssfb', p(sampleFindings('look')));
        await store.putEvidence(id, 'code', p(sampleCodeFindings()));
        await store.putReport(id, seq, p(sampleReport(id, 'answer')), p('# answer'));
        await store.putFeedback(id, p(sampleFeedback('correct', AT)));
        await store.putEmbedding(id, p(sampleEmbedding('case', 'ollama/x', [1, 0])));
        await store.putEmbedding(id, p(sampleEmbedding('request', 'ollama/x', [1, 0], seq)));
        await store.putEmbedding(id, p(sampleEmbedding('case', 'openai/y', [0, 1, 0])));
        await store.putUsage(id, 0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify' })], true);
        await store.putUsage(id, seq, [sampleUsageRow()], false);
        return seq;
      };
      await fill(RUN_A);
      await fill(RUN_B);
      const kept = await store.getRun(RUN_B);

      assert.equal(await store.deleteRun(RUN_A), true);

      // A new run under the same id sees none of the old rows.
      await newRun(store, RUN_A);
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.deepEqual(run.submissions, []);
      assert.deepEqual(run.evidence, {});
      assert.equal(run.report, null);
      assert.equal(run.report_md, null);
      assert.deepEqual(run.feedback, []);
      assert.equal(run.feedback_latest, null);
      assert.deepEqual(run.embeddings, []);
      assert.deepEqual(run.usage, []);
      const summary = (await store.listRuns()).find((r) => r.run_id === RUN_A);
      assert.equal(summary?.submissions, 0);
      assert.equal(summary?.feedback_verdict, undefined);
      assert.equal(summary?.usd_total, undefined);
      // Both models' rows went, not only the first model's.
      const similar = async (model: string, vector: number[]) =>
        (await store.findSimilar({ vector, model })).map((h) => h.run_id);
      assert.deepEqual(await similar('ollama/x', [1, 0]), [RUN_B, RUN_B]);
      assert.deepEqual(await similar('openai/y', [0, 1, 0]), [RUN_B]);
      // The old submission is gone, so its report cannot be written again.
      await assert.rejects(
        () => store.putReport(RUN_A, 1, p(sampleReport(RUN_A, 'late')), p('# late')),
        (err: unknown) => err instanceof RunStoreError && !(err instanceof RunNotFoundError),
      );
      // The evidence versions start again from 1.
      assert.equal(await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('again'))), 1);

      assert.deepEqual(await store.getRun(RUN_B), kept);
    },
  },
  {
    name: 'every write on a deleted run throws RunNotFoundError and stores nothing',
    async run(store) {
      await newRun(store, RUN_A);
      const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/x', [1, 0])));
      assert.equal(await store.deleteRun(RUN_A), true);

      const notFound = (err: unknown) => err instanceof RunNotFoundError;
      await assert.rejects(() => store.addSubmission(RUN_A, p({ kind: 'initial' as const })), notFound);
      await assert.rejects(() => store.putReport(RUN_A, seq, p(sampleReport(RUN_A, 'x')), p('# x')), notFound);
      await assert.rejects(() => store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('x'))), notFound);
      await assert.rejects(() => store.putFeedback(RUN_A, p(sampleFeedback('correct', AT))), notFound);
      await assert.rejects(() => store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/x', [1, 0]))), notFound);
      await assert.rejects(() => store.putUsage(RUN_A, seq, [sampleUsageRow()], true), notFound);
      await assert.rejects(() => store.putClassification(RUN_A, p(sampleClassification())), notFound);
      await assert.rejects(() => store.setPhase(RUN_A, 'failed'), notFound);
      await assert.rejects(() => store.setSubmissionFlueId(RUN_A, seq, 'sub_x'), notFound);

      assert.equal(await store.getRun(RUN_A), null);
      assert.deepEqual(await store.findSimilar({ vector: [1, 0], model: 'ollama/x' }), []);
      // Nothing written by the refused calls turns up under a new run with the same id.
      await newRun(store, RUN_A);
      const run = await store.getRun(RUN_A);
      assert.deepEqual(run?.submissions, []);
      assert.deepEqual(run?.evidence, {});
      assert.deepEqual(run?.feedback, []);
      assert.deepEqual(run?.embeddings, []);
      assert.deepEqual(run?.usage, []);
    },
  },
  {
    name: 'listExpired(before) returns runs created before the cutoff only',
    async run(store, clock) {
      await newRun(store, RUN_A);
      clock.advance(10 * DAY);
      await newRun(store, RUN_B);
      const cutoff = new Date(clock.now());
      clock.advance(DAY);
      await newRun(store, RUN_C);
      assert.deepEqual(await store.listExpired(cutoff), [RUN_A]);
      assert.deepEqual(await store.listExpired(new Date(clock.now() + 1)), [RUN_A, RUN_B, RUN_C]);
      assert.deepEqual(await store.listExpired(new Date(CONTRACT_EPOCH)), []);
    },
  },
  {
    name: 'listRuns lists newest first with summary fields and filters',
    async run(store, clock) {
      await newRun(store, RUN_A);
      clock.advance(HOUR);
      await newRun(store, RUN_B);
      const seq = await store.addSubmission(RUN_B, p({ kind: 'initial' as const }));
      await store.putClassification(RUN_B, p(sampleClassification('onboarding')));
      await store.putReport(RUN_B, seq, p(sampleReport(RUN_B, 'answer', 'pending_bank')), p('# answer'));
      await store.setPhase(RUN_B, 'completed');

      const runs = await store.listRuns();
      assert.deepEqual(runs.map((r) => r.run_id), [RUN_B, RUN_A]);
      assert.deepEqual(
        { ...runs[0], created_at: undefined, updated_at: undefined },
        {
          run_id: RUN_B,
          created_at: undefined,
          updated_at: undefined,
          phase: 'completed',
          category: 'onboarding',
          tier_final: 'strong',
          report_status: 'pending_bank',
          submissions: 1,
        },
      );
      assert.equal(runs[1]?.submissions, 0);
      assert.deepEqual((await store.listRuns({ limit: 1 })).map((r) => r.run_id), [RUN_B]);
      assert.deepEqual((await store.listRuns({ phase: 'created' })).map((r) => r.run_id), [RUN_A]);
      assert.deepEqual((await store.listRuns({ category: 'onboarding' })).map((r) => r.run_id), [RUN_B]);
      assert.deepEqual(
        (await store.listRuns({ since: new Date(CONTRACT_EPOCH + 1) })).map((r) => r.run_id),
        [RUN_B],
      );
    },
  },
  {
    name: 'listRuns gives a working run the stalled check inputs: the latest non-steer and steer Flue ids and the pid (D71)',
    async run(store, clock) {
      await newRun(store, RUN_A);
      const s1 = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      await store.setSubmissionFlueId(RUN_A, s1, 'sub_host_one');
      await store.setPhase(RUN_A, 'investigating', { worker_pid: 4242 });
      let row = (await store.listRuns()).find((r) => r.run_id === RUN_A);
      assert.equal(row?.flue_submission_id, 'sub_host_one');
      assert.equal(row?.steer_flue_submission_id, undefined);
      assert.equal(row?.worker_pid, 4242);
      assert.equal(row?.stalled, undefined);

      // A steer with a Flue id after the host is given too; one without an id (a failed dispatch) is not.
      const s2 = await store.addSubmission(RUN_A, p({ kind: 'steer' as const, note: 'check the payout' }));
      await store.setSubmissionFlueId(RUN_A, s2, 'sub_steer_two');
      await store.addSubmission(RUN_A, p({ kind: 'steer' as const, note: 'and the ledger' }));
      row = (await store.listRuns()).find((r) => r.run_id === RUN_A);
      assert.equal(row?.flue_submission_id, 'sub_host_one');
      assert.equal(row?.steer_flue_submission_id, 'sub_steer_two');

      // A later non-steer submission without its receipt yet: no head id, and the older steer no longer counts.
      await store.addSubmission(RUN_A, p({ kind: 'resume' as const }));
      row = (await store.listRuns()).find((r) => r.run_id === RUN_A);
      assert.equal(row?.flue_submission_id, undefined);
      assert.equal(row?.steer_flue_submission_id, undefined);
      assert.equal(row?.worker_pid, 4242);
      assert.equal(row?.submissions, 4);

      // Any other phase: none of them.
      clock.advance(1000);
      await store.setPhase(RUN_A, 'completed');
      row = (await store.listRuns()).find((r) => r.run_id === RUN_A);
      assert.equal(row?.flue_submission_id, undefined);
      assert.equal(row?.steer_flue_submission_id, undefined);
      assert.equal(row?.worker_pid, undefined);
      assert.equal(row?.phase, 'completed');
    },
  },
  {
    name: 'every write re-runs the persisted-profile check and names patterns only; putUsage is checked by its schema',
    async run(store) {
      await newRun(store, RUN_A);
      const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));

      await rejectsRedaction(
        () =>
          store.createRun(
            RUN_B,
            tampered(sampleRequest(RUN_B), (r) => {
              r.messages[0]!.text = `call ${SYNTHETIC_PHONE}`;
            }),
          ),
        'phone',
        SYNTHETIC_PHONE,
      );
      assert.equal(await store.getRun(RUN_B), null);

      await rejectsRedaction(
        () =>
          store.putEvidence(
            RUN_A,
            'ssfb',
            tampered(sampleFindings('ok'), (f) => {
              f.evidence[0]!.summary = `mail from ${SYNTHETIC_EMAIL}`;
            }),
          ),
        'email',
        SYNTHETIC_EMAIL,
      );
      await rejectsRedaction(
        () =>
          store.putInputRequest(
            RUN_A,
            tampered(sampleInputRequest('q1'), (r) => {
              r.question = `is it the number ending ${SYNTHETIC_PHONE}?`;
            }),
          ),
        'phone',
        SYNTHETIC_PHONE,
      );
      assert.equal((await store.getRun(RUN_A))?.input_request, null);
      await store.putInputRequest(RUN_A, p(sampleInputRequest('q1')));
      await rejectsRedaction(
        () =>
          store.resolveInputRequest(
            RUN_A,
            'q1',
            tampered(sampleResolution('answered'), (r) => {
              r.resolved_by = SYNTHETIC_EMAIL;
            }),
          ),
        'email',
        SYNTHETIC_EMAIL,
      );
      assert.equal((await store.getRun(RUN_A))?.input_request?.question_id, 'q1');
      await store.resolveInputRequest(RUN_A, 'q1', p(sampleResolution('skipped')));
      await rejectsRedaction(
        () =>
          store.putBlock(
            RUN_A,
            tampered(sampleBlock('b1'), (b) => {
              b.reason = `harbor holds the form for ${SYNTHETIC_EMAIL}`;
            }),
          ),
        'email',
        SYNTHETIC_EMAIL,
      );
      assert.equal((await store.getRun(RUN_A))?.block, null);
      await store.putBlock(RUN_A, p(sampleBlock('b1')));
      await rejectsRedaction(
        () =>
          store.resolveBlock(
            RUN_A,
            'b1',
            tampered(sampleBlockResolution('resumed'), (r) => {
              r.note = `fixed for ${SYNTHETIC_PHONE}`;
            }),
          ),
        'phone',
        SYNTHETIC_PHONE,
      );
      assert.equal((await store.getRun(RUN_A))?.block?.block_id, 'b1');
      await store.resolveBlock(RUN_A, 'b1', p(sampleBlockResolution('resumed')));
      await rejectsRedaction(
        () =>
          store.addSubmission(
            RUN_A,
            tampered({ kind: 'resume' as 'resume' | 'initial', note: 'ok' }, (s) => {
              s.note = `call ${SYNTHETIC_PHONE}`;
            }),
          ),
        'phone',
        SYNTHETIC_PHONE,
      );
      await store.setPhase(RUN_A, 'created');
      await rejectsRedaction(
        () =>
          store.putReport(
            RUN_A,
            seq,
            tampered(sampleReport(RUN_A, 'ok'), (r) => {
              r.cx_answer.reply_text = `account ${SYNTHETIC_DIGITS}`;
            }),
            p('# ok'),
          ),
        'digits6',
        SYNTHETIC_DIGITS,
      );
      await rejectsRedaction(
        () =>
          store.putFeedback(
            RUN_A,
            tampered(sampleFeedback('wrong', AT), (f) => {
              f.actual_root_cause = `phone was ${SYNTHETIC_PHONE}`;
            }),
          ),
        'phone',
        SYNTHETIC_PHONE,
      );
      await rejectsRedaction(
        () =>
          store.putClassification(
            RUN_A,
            tampered(sampleClassification(), (c) => {
              c.decision.proposed.subcategory = `ask ${SYNTHETIC_EMAIL}`;
            }),
          ),
        'email',
        SYNTHETIC_EMAIL,
      );
      await rejectsRedaction(
        () =>
          store.addSubmission(
            RUN_A,
            tampered({ kind: 'ask' as 'ask' | 'initial', question: 'ok' }, (s) => {
              s.question = `is ${SYNTHETIC_DIGITS} paid`;
            }),
          ),
        'digits6',
        SYNTHETIC_DIGITS,
      );
      await rejectsRedaction(
        () =>
          store.putEmbedding(
            RUN_A,
            tampered(sampleEmbedding('case', 'ollama/x', [1, 0]), (e) => {
              e.source_text = `case for ${SYNTHETIC_PHONE}`;
            }),
          ),
        'phone',
        SYNTHETIC_PHONE,
      );
      await rejectsRedaction(() => store.setPhase(RUN_A, 'failed', { reason: `failed for ${SYNTHETIC_EMAIL}` }), 'email', SYNTHETIC_EMAIL);
      // putUsage takes no Persisted box (D59): UsageRowSchema allows only a
      // model spec, an agent name, a fixed purpose and numbers, so neither a
      // masked id nor free text gets through.
      for (const bad of [{ model: 'anthropic/claude-haiku-4-5-****1001' }, { agent: SYNTHETIC_EMAIL }]) {
        await assert.rejects(
          () => store.putUsage(RUN_A, seq, [sampleUsageRow(bad)], true),
          (err: unknown) => {
            assert.ok(err instanceof RunStoreError && !(err instanceof RunStoreRedactionError));
            assert.ok(!err.message.includes(SYNTHETIC_EMAIL) && !err.message.includes('****'));
            return true;
          },
        );
      }

      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.deepEqual(run.evidence, {});
      assert.equal(run.submissions.length, 1);
      assert.equal(run.submissions[0]?.report, null);
      assert.deepEqual(run.feedback, []);
      assert.equal(run.classification, null);
      assert.deepEqual(run.embeddings, []);
      assert.deepEqual(run.usage, []);
      assert.equal(run.phase, 'created');
      for (const secret of [SYNTHETIC_PHONE, SYNTHETIC_EMAIL, SYNTHETIC_DIGITS]) {
        assert.ok(!JSON.stringify(run).includes(secret));
      }
    },
  },
  {
    name: 'putUsage replaces the rows of one seq, and the same write twice leaves one set',
    async run(store, clock) {
      await newRun(store, RUN_A);
      const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
      const rows = [
        sampleUsageRow({ agent: 'synthesis', model: 'openai/gpt-5.1', usd: null }),
        sampleUsageRow(),
        sampleUsageRow({ purpose: 'compaction', calls: 1, failed_calls: 0 }),
      ];
      clock.advance(HOUR);
      await store.putUsage(RUN_A, seq, rows, true);
      await store.putUsage(RUN_A, seq, rows, true);
      const at = new Date(clock.now()).toISOString();
      const run = await store.getRun(RUN_A);
      assert.ok(run);
      // Rows come back ordered by model, agent and purpose, with the model id's digits intact.
      assert.deepEqual(run.usage, [
        {
          seq,
          rows: [
            sampleUsageRow(),
            sampleUsageRow({ purpose: 'compaction', calls: 1, failed_calls: 0 }),
            sampleUsageRow({ agent: 'synthesis', model: 'openai/gpt-5.1', usd: null }),
          ],
          updated_at: at,
          final: true,
        },
      ]);
      // A later snapshot replaces the set; it is never added to.
      clock.advance(1000);
      await store.putUsage(RUN_A, seq, [sampleUsageRow({ calls: 5 })], true);
      const again = await store.getRun(RUN_A);
      assert.deepEqual(again?.usage.map((u) => [u.seq, u.rows.map((r) => r.calls), u.updated_at]), [
        [seq, [5], new Date(clock.now()).toISOString()],
      ]);
      // A final write with no rows clears the seq.
      await store.putUsage(RUN_A, seq, [], true);
      assert.deepEqual((await store.getRun(RUN_A))?.usage, []);
    },
  },
  {
    name: 'putUsage accepts seq 0 for intake, orders getRun().usage by seq and refuses a bad seq',
    async run(store) {
      await newRun(store, RUN_A);
      assert.deepEqual((await store.getRun(RUN_A))?.usage, []);
      await store.putUsage(RUN_A, 2, [sampleUsageRow({ calls: 2 })], true);
      await store.putUsage(RUN_A, 0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify', calls: 1 })], true);
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ calls: 7 })], false);
      const run = await store.getRun(RUN_A);
      assert.deepEqual(
        run?.usage.map((u) => [u.seq, u.final, u.rows[0]?.agent, u.rows[0]?.calls]),
        [
          [0, true, 'classifier', 1],
          [1, false, 'triage', 7],
          [2, true, 'triage', 2],
        ],
      );
      for (const bad of [-1, 1.5, Number.NaN]) {
        await assert.rejects(() => store.putUsage(RUN_A, bad, [sampleUsageRow()], true), (err: unknown) => err instanceof RunStoreError);
      }
      assert.equal((await store.getRun(RUN_A))?.usage.length, 3);
    },
  },
  {
    name: 'putUsage refuses a masked or invalid model, a bad agent, an unknown purpose and bad counts before any write',
    async run(store) {
      await newRun(store, RUN_A);
      await store.putUsage(RUN_A, 1, [sampleUsageRow()], true);
      const before = await store.getRun(RUN_A);
      const bad: Partial<Record<keyof UsageRow, unknown>>[] = [
        { model: 'anthropic/claude-haiku-4-5-****1001' },
        { model: 'no-provider' },
        { model: 'Anthropic/claude' },
        { model: 'anthropic/claude haiku' },
        { agent: 'Triage' },
        { agent: 'investigate ssfb' },
        { agent: '' },
        { purpose: 'report' },
        { calls: -1 },
        { input_tokens: 1.5 },
        { output_tokens: Number.NaN },
        { cache_read_tokens: 2_147_483_648 },
        { usd: -0.01 },
        { usd: Number.POSITIVE_INFINITY },
        { usd: '0.25' },
      ];
      for (const over of bad) {
        const row = { ...sampleUsageRow(), ...over } as UsageRow;
        // Put a good row first: nothing of the call may be written.
        await assert.rejects(
          () => store.putUsage(RUN_A, 1, [sampleUsageRow({ agent: 'synthesis' }), row], true),
          (err: unknown) => {
            assert.ok(err instanceof RunStoreError, `expected RunStoreError for ${JSON.stringify(Object.keys(over))}`);
            assert.ok(!err.message.includes('****'), 'error message carries the value');
            return true;
          },
        );
      }
      const refused = (err: unknown) => err instanceof RunStoreError;
      // One model, agent and purpose appears once per seq.
      await assert.rejects(() => store.putUsage(RUN_A, 1, [sampleUsageRow(), sampleUsageRow()], true), refused);
      await assert.rejects(() => store.putUsage(RUN_A, 1, [sampleUsageRow()], 'yes' as never), refused);
      assert.deepEqual((await store.getRun(RUN_A))?.usage, before?.usage);
    },
  },
  {
    name: 'a non-final putUsage never replaces final rows; a final write replaces them',
    async run(store, clock) {
      await newRun(store, RUN_A);
      // Live snapshots replace each other.
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ calls: 1 })], false);
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ calls: 2 })], false);
      let usage = (await store.getRun(RUN_A))?.usage;
      assert.deepEqual(usage?.map((u) => [u.final, u.rows[0]?.calls]), [[false, 2]]);
      // The settle write replaces the snapshot.
      clock.advance(1000);
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ calls: 3 })], true);
      const settled = new Date(clock.now()).toISOString();
      // A live flush that lands after it changes nothing, not even updated_at.
      clock.advance(1000);
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ calls: 4 })], false);
      await store.putUsage(RUN_A, 1, [], false);
      usage = (await store.getRun(RUN_A))?.usage;
      assert.deepEqual(usage?.map((u) => [u.final, u.rows[0]?.calls, u.updated_at]), [[true, 3, settled]]);
      // A second final write (after embedAfterSettle) replaces it.
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ calls: 5 }), sampleUsageRow({ agent: 'embedder', purpose: 'embed' })], true);
      usage = (await store.getRun(RUN_A))?.usage;
      assert.deepEqual(usage?.map((u) => [u.final, u.rows.map((r) => r.agent)]), [[true, ['embedder', 'triage']]]);
      // The rule is per seq: another seq still takes a live snapshot.
      await store.putUsage(RUN_A, 2, [sampleUsageRow()], false);
      assert.deepEqual((await store.getRun(RUN_A))?.usage.map((u) => [u.seq, u.final]), [
        [1, true],
        [2, false],
      ]);
    },
  },
  {
    name: 'listRuns sums usage into usd_total and tokens_total, and leaves them out without rows',
    async run(store, clock) {
      await newRun(store, RUN_A);
      clock.advance(HOUR);
      await newRun(store, RUN_B);
      clock.advance(HOUR);
      await newRun(store, RUN_C);
      await store.putUsage(RUN_A, 0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify', usd: 0.125 })], true);
      await store.putUsage(RUN_A, 1, [sampleUsageRow(), sampleUsageRow({ model: 'openai/gpt-5.1', usd: null })], false);
      // Priced at nothing: the tokens count, usd_total does not appear.
      await store.putUsage(RUN_B, 1, [sampleUsageRow({ usd: null })], true);
      const runs = await store.listRuns();
      const a = runs.find((r) => r.run_id === RUN_A);
      const b = runs.find((r) => r.run_id === RUN_B);
      const c = runs.find((r) => r.run_id === RUN_C);
      const perRow = 1200 + 300 + 4000 + 500;
      assert.equal(a?.usd_total, 0.375);
      assert.equal(a?.tokens_total, 3 * perRow);
      assert.equal(typeof a?.tokens_total, 'number');
      assert.ok(b && !('usd_total' in b));
      assert.equal(b?.tokens_total, perRow);
      assert.ok(c && !('usd_total' in c) && !('tokens_total' in c));
    },
  },
  {
    name: 'listRuns sets usd_partial only when priced and unpriced rows are mixed',
    async run(store, clock) {
      await newRun(store, RUN_A);
      clock.advance(HOUR);
      await newRun(store, RUN_B);
      clock.advance(HOUR);
      await newRun(store, RUN_C);
      // Mixed across seqs: the priced intake and an unpriced submission row.
      await store.putUsage(RUN_A, 0, [sampleUsageRow({ agent: 'classifier', purpose: 'classify', usd: 0.125 })], true);
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ usd: null })], true);
      // Every row priced, one of them at $0.
      await store.putUsage(RUN_B, 1, [sampleUsageRow({ usd: 0.25 }), sampleUsageRow({ model: 'ollama/qwen3:8b', usd: 0 })], true);
      // Nothing priced: no total, so nothing to call partial.
      await store.putUsage(RUN_C, 1, [sampleUsageRow({ usd: null })], true);
      const runs = await store.listRuns();
      const a = runs.find((r) => r.run_id === RUN_A);
      const b = runs.find((r) => r.run_id === RUN_B);
      const c = runs.find((r) => r.run_id === RUN_C);
      assert.equal(a?.usd_total, 0.125);
      assert.equal(a?.usd_partial, true);
      assert.equal(b?.usd_total, 0.25);
      assert.ok(b && !('usd_partial' in b));
      assert.ok(c && !('usd_total' in c) && !('usd_partial' in c));
      // A final write that prices the missing row clears the mark.
      await store.putUsage(RUN_A, 1, [sampleUsageRow({ usd: 0.5 })], true);
      const after = (await store.listRuns()).find((r) => r.run_id === RUN_A);
      assert.equal(after?.usd_total, 0.625);
      assert.ok(after && !('usd_partial' in after));
    },
  },
  {
    name: 'putUsage does not change updated_at or the order of the runs list',
    async run(store, clock) {
      await newRun(store, RUN_A);
      clock.advance(HOUR);
      await newRun(store, RUN_B);
      const before = await store.getRun(RUN_A);
      const order = (await store.listRuns()).map((r) => r.run_id);
      clock.advance(HOUR);
      await store.putUsage(RUN_A, 1, [sampleUsageRow()], false);
      await store.putUsage(RUN_A, 1, [sampleUsageRow()], true);
      const after = await store.getRun(RUN_A);
      assert.equal(after?.updated_at, before?.updated_at);
      assert.equal(after?.phase, before?.phase);
      assert.equal(after?.usage[0]?.updated_at, new Date(clock.now()).toISOString());
      const list = await store.listRuns();
      assert.deepEqual(list.map((r) => r.run_id), order);
      assert.equal(list.find((r) => r.run_id === RUN_A)?.updated_at, before?.updated_at);
    },
  },
  {
    name: 'a value that is not a Persisted box is refused at runtime',
    async run(store) {
      const raw = sampleRequest(RUN_A) as unknown as Persisted<TriageRequest>;
      await assert.rejects(() => store.createRun(RUN_A, raw), (err: unknown) => err instanceof RunStoreError);
      assert.equal(await store.getRun(RUN_A), null);
      await newRun(store, RUN_A);
      const findings = sampleFindings('look') as unknown as Persisted<EntityFindings>;
      await assert.rejects(() => store.putEvidence(RUN_A, 'ssfb', findings), (err: unknown) => err instanceof RunStoreError);
    },
  },
];
