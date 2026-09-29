import { describe, expect, test } from 'bun:test';
import { formatLocalInput, resolveTimeExpr, toDatetimeLocal } from './time-expr.ts';

// A fixed local time, so the day rounding does not depend on when the test runs.
const NOW = new Date(2026, 8, 29, 14, 37, 21, 500).getTime();
const local = (...a: [number, number, number, number?, number?, number?]) => new Date(a[0], a[1], a[2], a[3] ?? 0, a[4] ?? 0, a[5] ?? 0).getTime();

describe('resolveTimeExpr', () => {
  test('relative expressions', () => {
    expect(resolveTimeExpr('now', NOW)).toBe(NOW);
    expect(resolveTimeExpr(' now - 1h ', NOW)).toBe(NOW - 3_600_000);
    expect(resolveTimeExpr('now-15m', NOW)).toBe(NOW - 15 * 60_000);
    expect(resolveTimeExpr('now-1d', NOW)).toBe(local(2026, 8, 28, 14, 37, 21) + 500);
    expect(resolveTimeExpr('now-1w', NOW)).toBe(local(2026, 8, 22, 14, 37, 21) + 500);
    expect(resolveTimeExpr('now-1d-2h', NOW)).toBe(local(2026, 8, 28, 12, 37, 21) + 500);
    expect(resolveTimeExpr('now+30s', NOW)).toBe(NOW + 30_000);
  });

  test('rounding to the start of a day, hour or minute', () => {
    expect(resolveTimeExpr('now/d', NOW)).toBe(local(2026, 8, 29));
    expect(resolveTimeExpr('now-1d/d', NOW)).toBe(local(2026, 8, 28));
    expect(resolveTimeExpr('now/h', NOW)).toBe(local(2026, 8, 29, 14));
    expect(resolveTimeExpr('now/m', NOW)).toBe(local(2026, 8, 29, 14, 37));
  });

  test('absolute local and zoned times', () => {
    expect(resolveTimeExpr('2026-09-24 14:00', NOW)).toBe(local(2026, 8, 24, 14, 0));
    expect(resolveTimeExpr('2026-09-24T14:00:30', NOW)).toBe(local(2026, 8, 24, 14, 0, 30));
    expect(resolveTimeExpr('2026-09-24', NOW)).toBe(local(2026, 8, 24));
    expect(resolveTimeExpr('2026-09-24T08:30:00Z', NOW)).toBe(Date.UTC(2026, 8, 24, 8, 30));
    expect(resolveTimeExpr('2026-09-24T14:00+05:30', NOW)).toBe(Date.UTC(2026, 8, 24, 8, 30));
  });

  test('empty and unreadable input', () => {
    for (const t of ['', '  ', 'yesterday', 'now-1', 'now-1y', 'now/w', '2026-02-30', '2026-09-24 25:00', '24/09/2026']) {
      expect(resolveTimeExpr(t, NOW)).toBeUndefined();
    }
  });
});

test('formatLocalInput and toDatetimeLocal', () => {
  expect(formatLocalInput(local(2026, 0, 5, 9, 3))).toBe('2026-01-05 09:03');
  expect(toDatetimeLocal(local(2026, 0, 5, 9, 3))).toBe('2026-01-05T09:03');
});
