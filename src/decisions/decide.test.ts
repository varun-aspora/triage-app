import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as bt from 'braintrust';

import { checkEgress } from '../gate/redact.ts';
import { installBraintrust, uninstallBraintrust } from '../tracing/braintrust.ts';
import { choice, decide, DecisionError, score, yesNo } from './decide.ts';
import { fakeDecisionProvider } from './fake.ts';
import type { DecisionProvider } from './types.ts';

const questions = {
  category: choice('Which category?', { payments: 'transfers and debits', cards: 'card issues', other: null }),
  money_moved: yesNo('Has money left the account?'),
  urgency: score('How urgent?', ['no money at risk', 'money debited and not delivered']),
};

const good = fakeDecisionProvider(() => ({
  category: { kind: 'choice', choice: 'payments', probabilities: { payments: 0.9, cards: 0.05, other: 0.05 }, confidence: 0.85 },
  money_moved: { kind: 'yes_no', yes: 0.92 },
  urgency: { kind: 'score', score: 0.9, probabilities: [0.1, 0.9], confidence: 0.8 },
}));

async function decisionError(p: Promise<unknown>): Promise<DecisionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DecisionError) return err;
    throw err;
  }
  throw new Error('expected a DecisionError');
}

describe('decide', () => {
  test('returns typed answers and passes the request through', async () => {
    const r = await decide(good, { state: { thread: ['synthetic text'] }, questions });
    const picked: 'payments' | 'cards' | 'other' = r.answers.category.choice;
    expect(picked).toBe('payments');
    expect(r.answers.money_moved.yes).toBe(0.92);
    expect(r.answers.urgency.probabilities).toEqual([0.1, 0.9]);
    expect(good.requests[0]?.state).toEqual({ thread: ['synthetic text'] });
  });

  test('refuses an empty question set and a one-option choice before calling', async () => {
    const p = fakeDecisionProvider(() => ({}));
    expect((await decisionError(decide(p, { state: '', questions: {} }))).code).toBe('bad_request');
    expect((await decisionError(decide(p, { state: '', questions: { a: choice('x', { only: null }) } }))).code).toBe('bad_request');
    expect(p.requests).toHaveLength(0);
  });

  test.each([
    ['a missing answer', { money_moved: { kind: 'yes_no', yes: 0.5 } }],
    ['the wrong kind', { category: { kind: 'yes_no', yes: 0.5 } }],
    ['a choice outside the options', { category: { kind: 'choice', choice: 'loans' } }],
    ['a yes/no probability above 1', { category: { kind: 'choice', choice: 'cards' }, money_moved: { kind: 'yes_no', yes: 1.4 } }],
  ])('rejects %s as invalid_response', async (_, answers) => {
    const p = fakeDecisionProvider(() => ({ urgency: { kind: 'score', score: 0 }, ...answers }) as never);
    const err = await decisionError(decide(p, { state: '', questions }));
    expect(err.code).toBe('invalid_response');
  });

  test('a score beyond the last level is invalid', async () => {
    const p = fakeDecisionProvider(() => ({ s: { kind: 'score', score: 2.5 } }));
    const err = await decisionError(decide(p, { state: '', questions: { s: score('x', ['a', 'b']) } }));
    expect(err.code).toBe('invalid_response');
  });

  test('times out a provider that never answers, and aborts its signal', async () => {
    let seen: AbortSignal | undefined;
    const slow: DecisionProvider = {
      id: 'slow',
      model: 'slow/m',
      decide: (_req, { signal }) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    };
    const err = await decisionError(decide(slow, { state: '', questions }, { timeoutMs: 20 }));
    expect(err.code).toBe('timeout');
    expect(err.provider).toBe('slow');
    expect(seen?.aborted).toBe(true);
  });

  test('the caller signal aborts the call', async () => {
    const ctrl = new AbortController();
    const hang: DecisionProvider = { id: 'hang', model: 'h/m', decide: () => new Promise(() => undefined) };
    const p = decide(hang, { state: '', questions }, { signal: ctrl.signal, timeoutMs: 5_000 });
    ctrl.abort();
    expect((await decisionError(p)).code).toBe('aborted');
    expect((await decisionError(decide(hang, { state: '', questions }, { signal: ctrl.signal }))).code).toBe('aborted');
  });

  test('a non-DecisionError from a provider becomes code provider, with no message text', async () => {
    const p = fakeDecisionProvider(() => {
      throw new TypeError('secret thread text');
    });
    const err = await decisionError(decide(p, { state: '', questions }));
    expect(err.code).toBe('provider');
    expect(err.message).not.toContain('secret');
    expect(err.detail).toBe('TypeError');
  });
});

// ---------------------------------------------------------------- tracing (D82)

// Braintrust's in-memory background logger: nothing leaves the process. The
// name, email and account below are synthetic.
describe('decide tracing', () => {
  const T = bt._exportsForTestingOnly;
  const NAME = 'Asha Testuser';
  const EMAIL = 'asha.testuser@example.com';
  const ACCOUNT = '001234567890';
  // A run id with a 6+ digit run, which the persisted profile would mask.
  const RUN = '01M3EN7034701234ABCDEFGHJK';
  const STATE = { thread: [`${NAME} (${EMAIL}) says account ${ACCOUNT} was debited twice`] };

  type Row = Record<string, any>;
  let memory: ReturnType<typeof T.useTestBackgroundLogger>;

  const priced: DecisionProvider = {
    id: 'typesafe',
    model: 'typesafe/jev-1.13',
    decide: async () => ({
      answers: {
        category: { kind: 'choice', choice: 'payments' },
        money_moved: { kind: 'yes_no', yes: 0.9 },
        urgency: { kind: 'score', score: 1 },
      },
      model: 'jev-1.13-20260901',
      usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.0004 },
    }),
  };

  async function tracingOn(content: 'metadata' | 'redacted' = 'metadata'): Promise<void> {
    await installBraintrust(
      { tracing: { enabled: true, apiKey: 'test-braintrust-key', projectName: 'triage-app', content } },
      { load: async () => bt, instrument: () => async () => undefined, names: () => [NAME], projectId: 'test-project-id' },
    );
  }

  const rows = async (): Promise<Row[]> => (await memory.drain()) as Row[];

  beforeAll(async () => {
    await T.simulateLoginForTests();
  });
  beforeEach(() => {
    memory = T.useTestBackgroundLogger();
  });
  afterEach(async () => {
    await uninstallBraintrust();
    T.clearTestBackgroundLogger();
  });
  afterAll(() => {
    T.simulateLogoutForTests();
  });

  test('with tracing off the result is the same and nothing is recorded', async () => {
    const r = await decide(priced, { state: STATE, questions }, { trace: { runId: RUN, purpose: 'classify' } });
    expect(r.answers.category.choice).toBe('payments');
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 8, costUsd: 0.0004 });
    expect(await rows()).toEqual([]);
  });

  test("one llm span with run id, purpose, usage and the provider's cost; 'metadata' mode sends no content", async () => {
    await tracingOn();
    const r = await decide(priced, { state: STATE, questions }, { trace: { runId: RUN, purpose: 'classify' } });
    expect(r.answers.category.choice).toBe('payments');
    const all = await rows();
    expect(all).toHaveLength(1);
    const row = all[0] as Row;
    expect(row.span_attributes).toMatchObject({ name: 'decision:typesafe/jev-1.13', type: 'llm' });
    expect(row.metadata).toMatchObject({
      kind: 'decision',
      model: 'typesafe/jev-1.13',
      run_id: RUN,
      purpose: 'classify',
      provider: 'typesafe',
      questions: 3,
      response_model: 'jev-1.13-20260901',
    });
    expect(row.metrics).toMatchObject({ prompt_tokens: 120, completion_tokens: 8, tokens: 128, estimated_cost: 0.0004 });
    const json = JSON.stringify(row);
    for (const marker of [NAME, EMAIL, ACCOUNT, 'debited', 'payments']) expect(json).not.toContain(marker);
  });

  test("'redacted' mode sends the state and answers redacted with the run names", async () => {
    await tracingOn('redacted');
    await decide(priced, { state: STATE, questions }, { trace: { runId: RUN } });
    const row = (await rows())[0] as Row;
    expect(JSON.stringify(row.input)).toContain('was debited twice');
    expect(row.output.category.choice).toBe('payments');
    const { run_id: _run, model: _model, response_model: _response, ...rest } = row.metadata;
    expect(checkEgress({ input: row.input, output: row.output, metadata: rest }, { names: [NAME] })).toEqual({ ok: true });
  });

  test("'redacted' mode masks trace.names without a run id, and sends only sizes with neither", async () => {
    await installBraintrust(
      { tracing: { enabled: true, apiKey: 'test-braintrust-key', projectName: 'triage-app', content: 'redacted' } },
      { load: async () => bt, instrument: () => async () => undefined, names: () => [], projectId: 'test-project-id' },
    );
    await decide(priced, { state: STATE, questions }, { trace: { purpose: 'identity', names: [NAME] } });
    await decide(priced, { state: STATE, questions });
    const [named, bare] = (await rows()) as [Row, Row];
    expect(JSON.stringify(named.input)).toContain('was debited twice');
    expect(JSON.stringify(named.input)).not.toContain('Asha');
    expect(bare.input).toEqual({ omitted: 'object', keys: 1 });
  });

  test('an invalid answer is a failed span, and decide still throws its DecisionError', async () => {
    await tracingOn();
    const p = fakeDecisionProvider(() => ({ category: { kind: 'choice', choice: 'loans' } }) as never);
    const err = await decisionError(decide(p, { state: '', questions }));
    expect(err.code).toBe('invalid_response');
    const row = (await rows())[0] as Row;
    expect(row.span_attributes.name).toBe('decision:fake/decider');
    expect(row.error).toBe('DecisionError');
    expect(row.metadata.is_error).toBe(true);
    expect(row.metadata.run_id).toBeUndefined();
  });

  test('a call that is never sent has no span', async () => {
    await tracingOn();
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await decisionError(decide(priced, { state: '', questions }, { signal: ctrl.signal }))).code).toBe('aborted');
    expect((await decisionError(decide(priced, { state: '', questions: {} }))).code).toBe('bad_request');
    expect(await rows()).toEqual([]);
  });
});
