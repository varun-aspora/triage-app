import { describe, expect, test } from 'bun:test';
import { CROCKFORD, ULID_RE, createRunIdGenerator, newRunId } from './ulid.ts';
import { RunIdSchema } from '../types/core.ts';
import * as v from 'valibot';

function decodeTime(id: string): number {
  let n = 0;
  for (const ch of id.slice(0, 10)) n = n * 32 + CROCKFORD.indexOf(ch);
  return n;
}

describe('newRunId', () => {
  test('26 chars, Crockford base32 only, and a valid run id', () => {
    for (let i = 0; i < 200; i++) {
      const id = newRunId();
      expect(id).toHaveLength(26);
      expect(id).toMatch(ULID_RE);
      expect(id).not.toMatch(/[ILOU]/);
      expect(v.is(RunIdSchema, id)).toBe(true);
    }
  });

  test('monotonic within one ms', () => {
    const gen = createRunIdGenerator({ now: () => 1_695_460_000_123 });
    const ids = Array.from({ length: 1000 }, () => gen());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(decodeTime(ids[0] as string)).toBe(1_695_460_000_123);
  });

  test('sorts by time across milliseconds, even with random bytes that go down', () => {
    let t = 1_695_460_000_000;
    let r = 255;
    const gen = createRunIdGenerator({ now: () => t, random: (n) => new Uint8Array(n).fill(r) });
    const a = gen();
    t += 1;
    r = 0;
    const b = gen();
    expect(a < b).toBe(true);
    expect(decodeTime(b)).toBe(t);
  });

  test('stays ordered when the clock steps back', () => {
    let t = 1_695_460_000_500;
    const gen = createRunIdGenerator({ now: () => t });
    const a = gen();
    t -= 100;
    const b = gen();
    expect(a < b).toBe(true);
  });

  test('borrows the next ms when the random part is spent', () => {
    const gen = createRunIdGenerator({ now: () => 1000, random: (n) => new Uint8Array(n).fill(255) });
    const a = gen();
    const b = gen();
    expect(a.slice(10)).toBe('Z'.repeat(16));
    expect(a < b).toBe(true);
    expect(decodeTime(b)).toBe(1001);
  });

  test('encodes a known value', () => {
    const gen = createRunIdGenerator({ now: () => 0, random: (n) => new Uint8Array(n) });
    expect(gen()).toBe('0'.repeat(26));
  });

  test('refuses a clock outside the ULID range', () => {
    expect(() => createRunIdGenerator({ now: () => -1 })()).toThrow(RangeError);
    expect(() => createRunIdGenerator({ now: () => 2 ** 48 })()).toThrow(RangeError);
  });
});
