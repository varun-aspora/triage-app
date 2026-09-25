import { describe, expect, test } from 'bun:test';
import { formatDateTime, formatDuration, formatRelative, formatTokens, shortRunId } from './format.ts';

describe('format', () => {
  test('formatDateTime uses local time and drops the current year', () => {
    const d = new Date(2026, 8, 25, 17, 42);
    expect(formatDateTime(d.toISOString(), new Date(2026, 0, 1))).toBe('25 Sep, 17:42');
    expect(formatDateTime(d.toISOString(), new Date(2027, 0, 1))).toBe('25 Sep 2026, 17:42');
    expect(formatDateTime('nope')).toBe('nope');
  });

  test('formatRelative', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(formatRelative('2026-09-25T11:59:48Z', now)).toBe('12s ago');
    expect(formatRelative('2026-09-25T11:55:00Z', now)).toBe('5m ago');
    expect(formatRelative('2026-09-25T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelative('2026-09-23T12:00:00Z', now)).toBe('2d ago');
    expect(formatRelative('2026-09-25T12:05:00Z', now)).toBe('in 5m');
  });

  test('shortRunId', () => {
    expect(shortRunId('01K62ZQ8M4ABCDEFGHJKMNDEJF')).toBe('01K62ZQ8M4…DEJF');
    expect(shortRunId('run_1')).toBe('run_1');
  });

  test('formatDuration and formatTokens', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});
