import { describe, expect, test } from 'bun:test';
import type { TimeWindow } from '../types/core.ts';
import { parseInstant, qwTime, resolveWindow, windowSeconds } from './quickwit-window.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Thread first message 2026-09-20T10:00Z minus 7 lookback days, received at NOW.
const REQUEST: TimeWindow = { from: '2026-09-13T10:00:00.000Z', to: '2026-09-23T11:59:00.000Z' };

function ok(from: string | undefined, to: string | undefined, req: TimeWindow = REQUEST): TimeWindow {
  const r = resolveWindow(from, to, req, NOW);
  if (!r.ok) throw new Error(`expected a window, got refusal: ${r.reason}`);
  return r.window;
}

function refused(from: string | undefined, to: string | undefined): string {
  const r = resolveWindow(from, to, REQUEST, NOW);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.window)}`);
  return r.reason;
}

describe('resolveWindow: default', () => {
  test('no from/to returns the request window', () => {
    const r = resolveWindow(undefined, undefined, REQUEST, NOW);
    expect(r).toEqual({ ok: true, window: REQUEST, defaulted: true });
  });

  test('a request window that ends after now is held at now', () => {
    const req = { from: '2026-09-20T00:00:00.000Z', to: '2026-09-24T00:00:00.000Z' };
    expect(ok(undefined, undefined, req)).toEqual({ from: req.from, to: NOW.toISOString() });
  });

  test('a request window wholly in the future still gives a bounded window', () => {
    const req = { from: '2026-09-25T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' };
    const w = ok(undefined, undefined, req);
    expect(w.from).toBe(NOW.toISOString());
    expect(w.to).toBe(NOW.toISOString());
  });
});

describe('resolveWindow: explicit', () => {
  test('both ends as ISO date-times', () => {
    expect(ok('2026-09-21T08:00:00Z', '2026-09-21T09:30:00Z')).toEqual({
      from: '2026-09-21T08:00:00.000Z',
      to: '2026-09-21T09:30:00.000Z',
    });
  });

  test('explicit windows are marked as not defaulted', () => {
    const r = resolveWindow('2026-09-21T08:00:00Z', '2026-09-21T09:00:00Z', REQUEST, NOW);
    expect(r.ok && r.defaulted).toBe(false);
  });

  test('only from runs until now', () => {
    expect(ok('2026-09-22T00:00:00Z', undefined)).toEqual({ from: '2026-09-22T00:00:00.000Z', to: NOW.toISOString() });
  });

  test('only to starts at the request window start', () => {
    expect(ok(undefined, '2026-09-21T00:00:00Z')).toEqual({ from: REQUEST.from, to: '2026-09-21T00:00:00.000Z' });
  });

  test('a date without a time is midnight UTC', () => {
    expect(ok('2026-09-20', '2026-09-21')).toEqual({ from: '2026-09-20T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' });
  });

  test('a date-time without a zone is UTC', () => {
    expect(ok('2026-09-20T10:00', '2026-09-20T11:00:00')).toEqual({
      from: '2026-09-20T10:00:00.000Z',
      to: '2026-09-20T11:00:00.000Z',
    });
  });

  test('an offset is honoured', () => {
    expect(ok('2026-09-20T15:30:00+05:30', undefined).from).toBe('2026-09-20T10:00:00.000Z');
  });

  test('relative durations count back from now', () => {
    expect(ok('2d', '6h')).toEqual({
      from: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      to: new Date(NOW.getTime() - 6 * HOUR).toISOString(),
    });
    expect(ok('30m', undefined).from).toBe('2026-09-23T11:30:00.000Z');
  });

  test('to equal to now is allowed', () => {
    expect(ok('1h', NOW.toISOString()).to).toBe(NOW.toISOString());
  });
});

describe('resolveWindow: invalid', () => {
  test('from equal to to is refused', () => {
    expect(refused('2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z')).toMatch(/before to/);
  });

  test('from after to is refused', () => {
    expect(refused('2026-09-22T00:00:00Z', '2026-09-21T00:00:00Z')).toMatch(/before to/);
  });

  test('to in the future is refused', () => {
    expect(refused('2026-09-22T00:00:00Z', '2026-09-23T12:00:01Z')).toMatch(/future/);
  });

  test('from in the future with no to is refused', () => {
    expect(refused('2026-09-24T00:00:00Z', undefined)).toMatch(/before to/);
  });

  test('only to, before the request window start, is refused', () => {
    expect(refused(undefined, '2026-09-01T00:00:00Z')).toMatch(/before to/);
  });

  const garbage = ['yesterday', '2026-13-01', '2026-09-21T25:00:00Z', '2026/09/21', '1w', '', '-2d', '2026-09-21T00:00:00+0530'];
  for (const text of garbage) {
    test(`from ${JSON.stringify(text)} is refused`, () => {
      expect(refused(text, undefined)).toMatch(/from must be/);
    });
  }

  test('an unparseable to is refused', () => {
    expect(refused('2d', 'soon')).toMatch(/to must be/);
  });

  test('a broken request window is a loud error', () => {
    expect(() => resolveWindow(undefined, undefined, { from: 'x', to: 'y' }, NOW)).toThrow();
  });
});

describe('parseInstant', () => {
  test('returns epoch ms or undefined', () => {
    expect(parseInstant('2026-09-23T00:00:00.000Z', NOW)).toBe(Date.parse('2026-09-23T00:00:00.000Z'));
    expect(parseInstant('12h', NOW)).toBe(NOW.getTime() - 12 * HOUR);
    expect(parseInstant('not a date', NOW)).toBeUndefined();
  });
});

describe('windowSeconds and qwTime', () => {
  test('the start rounds down and the end up to whole seconds, so the window is covered', () => {
    const w = { from: '2026-09-21T10:00:00.500Z', to: '2026-09-23T10:00:00.200Z' };
    expect(windowSeconds(w)).toEqual({ start: Date.parse('2026-09-21T10:00:00Z') / 1000, end: Date.parse('2026-09-23T10:00:01Z') / 1000 });
  });

  test('whole seconds stay as they are', () => {
    expect(windowSeconds(REQUEST)).toEqual({ start: Date.parse(REQUEST.from) / 1000, end: Date.parse(REQUEST.to) / 1000 });
  });

  test('qwTime is RFC3339 in UTC with no milliseconds', () => {
    expect(qwTime(Date.parse('2026-09-13T10:00:00Z') / 1000)).toBe('2026-09-13T10:00:00Z');
  });

  test('the default window keeps both ends, with no upper bound dropped', () => {
    const r = resolveWindow(undefined, undefined, REQUEST, NOW);
    if (!r.ok) throw new Error(r.reason);
    const { start, end } = windowSeconds(r.window);
    expect([qwTime(start), qwTime(end)]).toEqual(['2026-09-13T10:00:00Z', '2026-09-23T11:59:00Z']);
  });

  test('an invalid window throws', () => {
    expect(() => windowSeconds({ from: 'x', to: REQUEST.to })).toThrow(/not a valid time window/);
  });
});
