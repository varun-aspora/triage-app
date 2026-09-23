// Run ids are ULIDs: 48 bits of millisecond time and 80 random bits, written
// as 26 Crockford base32 characters, so they sort by creation time. Built on
// node:crypto to avoid a dependency. Ids made in the same millisecond (or
// after the clock steps back) increment the random part, so they still sort
// in creation order.
import { randomBytes } from 'node:crypto';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const TIME_MAX = 2 ** 48 - 1;
const RANDOM_MAX = (1n << 80n) - 1n;

export type RunIdSource = {
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  /** Returns n random bytes. */
  readonly random?: (n: number) => Uint8Array;
};

function encode(value: bigint, length: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

function toBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** Makes a ULID generator with its own monotonic state. */
export function createRunIdGenerator(source: RunIdSource = {}): () => string {
  const now = source.now ?? Date.now;
  const random = source.random ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let lastRandom = 0n;

  return () => {
    let time = Math.floor(now());
    if (!Number.isSafeInteger(time) || time < 0 || time > TIME_MAX) throw new RangeError('clock value is outside the ULID time range');
    if (time <= lastTime) {
      time = lastTime;
      if (lastRandom === RANDOM_MAX) {
        // The random part is spent for this millisecond; borrow the next one.
        time += 1;
        lastRandom = 0n;
      } else {
        lastRandom += 1n;
      }
    } else {
      lastRandom = toBigInt(random(10)) & RANDOM_MAX;
    }
    lastTime = time;
    return encode(BigInt(time), 10) + encode(lastRandom, 16);
  };
}

const defaultGenerator = createRunIdGenerator();

/** A new run id (ULID). Also the Flue conversation id. */
export function newRunId(): string {
  return defaultGenerator();
}
