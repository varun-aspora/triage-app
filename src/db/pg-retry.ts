// The retry policy for the two Postgres paths (D57): the shared runner
// (Flue persistence and the run store) and the SQL connector. A call that
// fails because the connection was lost, refused or reset is repeated, up
// to the configured number of attempts, after a wait that grows from
// delayMs, doubling each retry up to maxDelayMs, with jitter: the wait is
// drawn from the upper half of that range, so retries neither collapse to
// zero nor line up across callers.
//
// Only connection-class failures qualify: a query error, a timeout the
// server enforced, a refused login or an abort is never repeated.
//
// Pure: no I/O, no logging. The callers decide what a repeat may touch (a
// write whose connection dropped mid-statement is not repeated, since it
// may have landed) and how to wait.

/** Attempts per call (1 = no retry), the first wait, and the cap on any wait; the wait doubles each retry. */
export type RetryPolicy = {
  readonly attempts: number;
  readonly delayMs: number;
  readonly maxDelayMs: number;
};

export const NO_RETRY: RetryPolicy = Object.freeze({ attempts: 1, delayMs: 0, maxDelayMs: 0 });

/** Network-level codes from node:net and node:dns. */
export const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
]);

// Postgres SQLSTATEs for a connection that is gone or cannot be made: class
// 08 (connection exception), 57P01 admin shutdown, 57P02 crash shutdown,
// 57P03 cannot connect now, 53300 too many connections.
const CONNECTION_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123]|53300)$/;

// pg's own words: a socket that closed under a query, a client pg then
// refuses to use, and pg-pool's connect timeout.
const CONNECTION_MESSAGE = /^(Connection terminated|Client has encountered a connection error|timeout exceeded when trying to connect)/;

/** The code on a pg or network error, or '' when it has none. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** True when the failure is the connection itself, so the same call may succeed on a fresh one. */
export function isConnectionLoss(err: unknown): boolean {
  const code = errorCode(err);
  if (NETWORK_CODES.has(code) || CONNECTION_SQLSTATE.test(code)) return true;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && CONNECTION_MESSAGE.test(message);
}

/** A number in [0, 1). Math.random in production; tests pass a constant. */
export type Random = () => number;

/**
 * The wait before retry number `retry` (1 for the first retry): delayMs
 * doubled per retry, capped at maxDelayMs, then a point in the upper half
 * of that range. With random() = 1 it is the capped exponential itself.
 */
export function retryDelayMs(policy: RetryPolicy, retry: number, random: Random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.delayMs * 2 ** Math.max(0, retry - 1));
  if (ceiling <= 0) return 0;
  const half = ceiling / 2;
  return Math.round(half + Math.min(1, Math.max(0, random())) * half);
}

/** True when a failed attempt number `attempt` (1-based) may be followed by another. */
export function mayRetry(policy: RetryPolicy, attempt: number): boolean {
  return attempt < policy.attempts;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Resolves after ms. Rejects with the signal's reason as soon as it aborts, and at once when it already has. */
export const sleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
