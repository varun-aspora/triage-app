// Time window for logs_search. Pure: `now` is passed in.
//
// Every query gets a bounded window. With no from/to it is the request
// window, which ingress anchors to the thread's first message minus
// TRIAGE_DEFAULT_LOOKBACK_DAYS. Both ends are always sent (owner, Q6): qw
// gets --from and --to in UTC, http gets start_timestamp and end_timestamp.
import type { TimeWindow } from '../types/core.ts';

export type WindowResolution =
  | { readonly ok: true; readonly window: TimeWindow; readonly defaulted: boolean }
  | { readonly ok: false; readonly reason: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNIT_MS: Readonly<Record<string, number>> = { m: MINUTE, h: HOUR, d: DAY };

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const RELATIVE = /^(\d{1,4})([mhd])$/;

/**
 * Parses an instant: an ISO date or date-time (no zone means UTC), or a
 * relative duration such as 30m, 6h or 2d meaning that long before now.
 * Returns epoch ms, or undefined when the text is not one of those.
 */
export function parseInstant(text: string, now: Date): number | undefined {
  const s = text.trim();
  const rel = RELATIVE.exec(s);
  if (rel !== null) return now.getTime() - Number(rel[1]) * (UNIT_MS[rel[2] as string] as number);
  const iso = ISO.exec(s);
  if (iso === null) return undefined;
  let full = s;
  if (!s.includes('T')) full = `${s}T00:00:00Z`;
  else if (iso[1] === undefined) full = `${s}Z`;
  const ms = Date.parse(full);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Picks the window for one logs_search call. No from/to: the request window,
 * with its end held at now. Only from: from until now. Only to: the request
 * window start until to. Refuses from >= to, a `to` after now, and text that
 * is not a date or duration. A returned window always has both ends.
 */
export function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  requestWindow: TimeWindow,
  now: Date,
): WindowResolution {
  const nowMs = now.getTime();
  const reqFrom = Date.parse(requestWindow.from);
  const reqTo = Math.min(Date.parse(requestWindow.to), nowMs);
  if (Number.isNaN(reqFrom) || Number.isNaN(reqTo)) throw new Error('resolveWindow: the request window is not a valid time window');

  if (from === undefined && to === undefined) {
    const start = Math.min(reqFrom, reqTo);
    return { ok: true, window: toWindow(start, reqTo), defaulted: true };
  }

  const fromMs = from === undefined ? reqFrom : parseInstant(from, now);
  if (fromMs === undefined) return { ok: false, reason: 'from must be an ISO date or time, or a duration like 6h or 2d' };
  const toMs = to === undefined ? nowMs : parseInstant(to, now);
  if (toMs === undefined) return { ok: false, reason: 'to must be an ISO date or time, or a duration like 6h or 2d' };

  if (toMs > nowMs) return { ok: false, reason: 'to is in the future; logs end at now' };
  if (fromMs >= toMs) return { ok: false, reason: 'from must be before to' };
  return { ok: true, window: toWindow(fromMs, toMs), defaulted: false };
}

/**
 * The window in whole epoch seconds, which is what Quickwit takes on both
 * transports: the start rounded down and the end rounded up, so the whole
 * window is covered. Quickwit reads the start as inclusive and the end as
 * exclusive.
 */
export function windowSeconds(window: TimeWindow): { readonly start: number; readonly end: number } {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new Error('windowSeconds: the window is not a valid time window');
  return { start: Math.floor(fromMs / 1000), end: Math.ceil(toMs / 1000) };
}

/** An epoch second as the RFC3339 UTC text qw --from and --to take, such as 2026-09-23T10:00:00Z. */
export function qwTime(seconds: number): string {
  return utcTime(seconds * 1000);
}

/** Epoch ms as RFC3339 UTC to the second, such as 2026-09-23T10:00:00Z. */
export function utcTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toWindow(fromMs: number, toMs: number): TimeWindow {
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}
