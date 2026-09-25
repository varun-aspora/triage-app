import { afterEach, describe, expect, test } from 'bun:test';

import { choice, decide, DecisionError, score, yesNo } from '../decide.ts';
import { typesafeProvider } from './typesafe.ts';

type Sent = { url: string; headers: Record<string, string>; body: unknown };

// A fetch that records what was sent and replies with the scripted responses in order.
function fakeFetch(...replies: { status: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: input,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)] as { status: number; body: unknown };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, sent };
}

const questions = {
  category: choice('Which category?', { payments: 'transfers and debits', other: null }),
  money_moved: yesNo('Has money left the account?', { yes: 'debited', no: 'not debited' }),
  urgency: score('How urgent?', ['no money at risk', 'delayed but traceable', 'debited and not delivered']),
};

// The shape OpenRouter returned for a live synthetic call on 2026-09-26.
const OK_BODY = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    category: { type: 'choice', choice: 'payments', probabilities: { payments: 1, other: 0 }, confidence: 1 },
    money_moved: { type: 'noul', noul: 0.92 },
    urgency: { type: 'score', score: 1.92, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: { 0: 0, 1: 0.08, 2: 0.92 }, confidence: 0.88 },
    unasked: { type: 'noul', noul: 0.5 },
  },
  usage: { input_tokens: 465, output_tokens: 81, cost: 1.953e-5 },
  id: 'gen-dec-synthetic',
  provider: 'TypeSafe',
};

const ENV_NAMES = ['TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_LOG_LEVEL', 'TYPESAFE_API_KEY'];
afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

async function decisionError(p: Promise<unknown>): Promise<DecisionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DecisionError) return err;
    throw err;
  }
  throw new Error('expected a DecisionError');
}

describe('typesafeProvider request', () => {
  test('OpenRouter route: /api/v1/systemone, bearer key, pinned model, mapped questions', async () => {
    const f = fakeFetch({ status: 200, body: OK_BODY });
    const p = typesafeProvider({ id: 'openrouter', apiKey: 'fake-or-key', model: 'typesafe/jev-1.13', fetch: f.fetch });
    await decide(p, { state: { thread: ['synthetic'] }, questions });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(f.sent[0]?.headers.authorization).toBe('Bearer fake-or-key');
    expect(f.sent[0]?.body).toEqual({
      model: 'typesafe/jev-1.13',
      state: { thread: ['synthetic'] },
      questions: {
        category: { type: 'choice', instructions: 'Which category?', criteria: { payments: 'transfers and debits', other: null } },
        money_moved: { type: 'noul', instructions: 'Has money left the account?', criteria: { true: 'debited', false: 'not debited' } },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['no money at risk', 'delayed but traceable', 'debited and not delivered'] },
      },
    });
  });

  test('direct route goes to api.typesafe.ai', async () => {
    const f = fakeFetch({ status: 200, body: OK_BODY });
    await decide(typesafeProvider({ id: 'typesafe', apiKey: 'fake-ts-key', model: 'jev-1.13', fetch: f.fetch }), { state: 's', questions });
    expect(f.sent[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((f.sent[0]?.body as { model: string }).model).toBe('jev-1.13');
  });

  test("the SDK's TYPESAFE_* environment variables do not override what is passed in code", async () => {
    process.env.TYPESAFE_BASE_URL = 'https://elsewhere.invalid';
    process.env.TYPESAFE_DEFAULT_MODEL = 'jev-latest';
    process.env.TYPESAFE_LOG_LEVEL = 'debug';
    const f = fakeFetch({ status: 200, body: OK_BODY });
    const logged: unknown[] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => logged.push(args);
    try {
      await decide(typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'typesafe/jev-1.13', fetch: f.fetch }), { state: 'synthetic', questions });
    } finally {
      console.debug = original;
    }
    expect(f.sent[0]?.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect((f.sent[0]?.body as { model: string }).model).toBe('typesafe/jev-1.13');
    expect(logged).toEqual([]);
  });

  test('a blank key is refused when the provider is built', () => {
    expect(() => typesafeProvider({ id: 'typesafe', apiKey: ' ', model: 'jev-1.13' })).toThrow(DecisionError);
  });
});

describe('typesafeProvider response', () => {
  test('maps answers, drops unasked ones, and keeps usage and cost', async () => {
    const f = fakeFetch({ status: 200, body: OK_BODY });
    const r = await decide(typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'typesafe/jev-1.13', fetch: f.fetch }), { state: 's', questions });
    expect(r.answers).toEqual({
      category: { kind: 'choice', choice: 'payments', probabilities: { payments: 1, other: 0 }, confidence: 1 },
      money_moved: { kind: 'yes_no', yes: 0.92 },
      urgency: { kind: 'score', score: 1.92, probabilities: [0, 0.08, 0.92], confidence: 0.88 },
    });
    expect(r.model).toBe('typesafe/jev-1.13-20260917');
    expect(r.usage).toEqual({ inputTokens: 465, outputTokens: 81, costUsd: 1.953e-5 });
  });

  test('optional probabilities and confidence may be absent', async () => {
    const body = {
      model: 'm',
      answers: { category: { type: 'choice', choice: 'other' }, money_moved: { type: 'noul', noul: 0.1 }, urgency: { type: 'score', score: 0 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const f = fakeFetch({ status: 200, body });
    const r = await decide(typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'm', fetch: f.fetch }), { state: 's', questions });
    expect(r.answers.category).toEqual({ kind: 'choice', choice: 'other' });
    expect(r.usage.costUsd).toBeUndefined();
  });

  test('an unexpected shape is invalid_response naming paths only', async () => {
    const f = fakeFetch({ status: 200, body: { model: 'm', answers: { category: { type: 'noul', noul: 'high' } } } });
    const err = await decisionError(decide(typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'm', fetch: f.fetch }), { state: 's', questions }));
    expect(err.code).toBe('invalid_response');
    expect(err.detail).toContain('answers.category');
  });
});

describe('typesafeProvider errors', () => {
  const provider = (f: ReturnType<typeof fakeFetch>) =>
    typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'typesafe/jev-1.13', fetch: f.fetch, maxRetries: 0 });

  test.each([
    [401, 'auth'],
    [402, 'auth'],
    [403, 'auth'],
    [400, 'bad_request'],
    [404, 'bad_request'],
    [413, 'bad_request'],
    [422, 'bad_request'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [529, 'unavailable'],
  ])('HTTP %i -> %s, with status and the provider message as detail', async (status, code) => {
    const f = fakeFetch({ status, body: { error: { message: `synthetic ${status} message`, code: status } } });
    const err = await decisionError(decide(provider(f), { state: 's', questions }));
    expect(err.code).toBe(code as never);
    expect(err.status).toBe(status);
    expect(err.detail).toBe(`synthetic ${status} message`);
    expect(err.message).toBe(`decision ${code} from openrouter (HTTP ${status})`);
  });

  test('the SDK retries a 529 and then succeeds', async () => {
    const f = fakeFetch({ status: 529, body: { error: { message: 'overloaded' } } }, { status: 200, body: OK_BODY });
    const p = typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'typesafe/jev-1.13', fetch: f.fetch, maxRetries: 1 });
    const r = await decide(p, { state: 's', questions });
    expect(f.sent).toHaveLength(2);
    expect(r.answers.category.choice).toBe('payments');
  });

  test('a network failure is unavailable', async () => {
    const fetch = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    const p = typesafeProvider({ id: 'openrouter', apiKey: 'k', model: 'm', fetch, maxRetries: 0 });
    expect((await decisionError(decide(p, { state: 's', questions }))).code).toBe('unavailable');
  });
});
