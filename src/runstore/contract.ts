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
import type { Report } from '../types/report.ts';
import type { TriageRequest } from '../types/request.ts';
import {
  InputRequestNotOpenError,
  InputRequestOpenError,
  RunNotFoundError,
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
        current_ask: 'why is the transfer stuck',
        money_moved: true,
        misdirected_funds: false,
        tier_proposed: 'mid',
        confidence: 0.8,
        missing_info: [],
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
      await assert.rejects(() => store.putClassification(RUN_B, p(sampleClassification())), notFound);
      await assert.rejects(() => store.putFeedback(RUN_B, p(sampleFeedback('correct', AT))), notFound);
      await assert.rejects(() => store.putEmbedding(RUN_B, p(sampleEmbedding('case', 'm/x', [1, 0]))), notFound);
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
      await store.claimIdempotencyKey('key-a', RUN_A, DAY);

      assert.equal(await store.deleteRun(RUN_A), true);
      assert.equal(await store.getRun(RUN_A), null);
      assert.deepEqual((await store.listRuns()).map((r) => r.run_id), [RUN_B]);
      assert.deepEqual(await store.findSimilar({ vector: [1, 0], model: 'ollama/x' }), []);
      // The claim went with the run, so the key is free again.
      assert.equal(await store.claimIdempotencyKey('key-a', RUN_C, DAY), RUN_C);
      assert.equal(await store.deleteRun(RUN_A), false);
      assert.ok(await store.getRun(RUN_B));
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
    name: 'every write re-runs the persisted-profile check and names patterns only',
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
              c.decision.proposed.current_ask = `ask ${SYNTHETIC_EMAIL}`;
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

      const run = await store.getRun(RUN_A);
      assert.ok(run);
      assert.deepEqual(run.evidence, {});
      assert.equal(run.submissions.length, 1);
      assert.equal(run.submissions[0]?.report, null);
      assert.deepEqual(run.feedback, []);
      assert.equal(run.classification, null);
      assert.deepEqual(run.embeddings, []);
      assert.equal(run.phase, 'created');
      for (const secret of [SYNTHETIC_PHONE, SYNTHETIC_EMAIL, SYNTHETIC_DIGITS]) {
        assert.ok(!JSON.stringify(run).includes(secret));
      }
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
