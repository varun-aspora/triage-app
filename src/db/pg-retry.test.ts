import { describe, expect, test } from 'bun:test';
import { errorCode, isConnectionLoss, mayRetry, NO_RETRY, retryDelayMs, sleep } from './pg-retry.ts';

const withCode = (code: string, message = 'x'): Error => Object.assign(new Error(message), { code });

describe('isConnectionLoss', () => {
  test('network codes, connection SQLSTATEs and pg connection messages qualify', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN']) {
      expect(isConnectionLoss(withCode(code))).toBe(true);
    }
    for (const code of ['08000', '08003', '08006', '08001', '08004', '57P01', '57P02', '57P03', '53300']) {
      expect(isConnectionLoss(withCode(code))).toBe(true);
    }
    expect(isConnectionLoss(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isConnectionLoss(new Error('Connection terminated'))).toBe(true);
    expect(isConnectionLoss(new Error('Client has encountered a connection error and is not queryable'))).toBe(true);
    expect(isConnectionLoss(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  test('query errors, server-side timeouts, refused logins, aborts and non-errors do not', () => {
    for (const code of ['42703', '57014', '55P03', '25006', '28P01', '28000', '3D000', '22023', '57000']) {
      expect(isConnectionLoss(withCode(code))).toBe(false);
    }
    expect(isConnectionLoss(new Error('boom'))).toBe(false);
    expect(isConnectionLoss(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isConnectionLoss(null)).toBe(false);
    expect(isConnectionLoss('Connection terminated')).toBe(false);
  });

  test('errorCode reads a string code only', () => {
    expect(errorCode(withCode('08006'))).toBe('08006');
    expect(errorCode(new Error('x'))).toBe('');
    expect(errorCode(Object.assign(new Error('x'), { code: 7 }))).toBe('');
    expect(errorCode(undefined)).toBe('');
  });
});

describe('policy', () => {
  const policy = { attempts: 4, delayMs: 250, maxDelayMs: 1500 };

  test('the wait doubles from delayMs up to maxDelayMs; random() = 1 gives the ceiling, 0 the half', () => {
    const max = (n: number): number => retryDelayMs(policy, n, () => 1);
    const min = (n: number): number => retryDelayMs(policy, n, () => 0);
    expect([1, 2, 3, 4, 5].map(max)).toEqual([250, 500, 1000, 1500, 1500]);
    expect([1, 2, 3, 4, 5].map(min)).toEqual([125, 250, 500, 750, 750]);
    expect(max(0)).toBe(250);
  });

  test('with jitter every wait lands in the upper half of the range, and never above the cap', () => {
    for (let n = 1; n <= 8; n++) {
      for (let i = 0; i < 50; i++) {
        const ms = retryDelayMs(policy, n);
        const ceiling = Math.min(1500, 250 * 2 ** (n - 1));
        expect(ms).toBeGreaterThanOrEqual(ceiling / 2);
        expect(ms).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  test('mayRetry counts attempts, and NO_RETRY allows one with no wait', () => {
    expect([1, 2, 3, 4].map((n) => mayRetry(policy, n))).toEqual([true, true, true, false]);
    expect(mayRetry(NO_RETRY, 1)).toBe(false);
    expect(retryDelayMs(NO_RETRY, 1)).toBe(0);
    expect(retryDelayMs({ attempts: 3, delayMs: 0, maxDelayMs: 5000 }, 3)).toBe(0);
  });
});

describe('sleep', () => {
  test('resolves after the wait and rejects with the reason on abort', async () => {
    await sleep(1);
    const controller = new AbortController();
    const waiting = sleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    const already = new AbortController();
    already.abort(new Error('gone'));
    await expect(sleep(1, already.signal)).rejects.toThrow('gone');
  });
});
