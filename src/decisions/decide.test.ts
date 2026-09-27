import { describe, expect, test } from 'bun:test';

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
