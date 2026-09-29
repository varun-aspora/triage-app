// Time expressions for the new run form's window: an absolute local time
// ('2026-09-24 14:00', '2026-09-24'), an ISO time with a zone, or a relative
// one in Grafana's shape ('now', 'now-1h', 'now-1d/d', 'now/d').
//
// They are resolved against the time the form is submitted, so a form left
// open does not send a stale window. Day rounding uses the viewer's time
// zone, the same zone the absolute times are read in.

import { pad } from '../../lib/format.ts';

const RELATIVE = /^now((?:[+-]\d+[smhdw])*)(?:\/([mhd]))?$/;
const OFFSET = /([+-])(\d+)([smhdw])/g;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
// An ISO time that names its zone; Date.parse reads those the same everywhere.
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Epoch ms for the expression at now, or undefined when it is empty or does not parse. */
export function resolveTimeExpr(text: string, now: number): number | undefined {
  const raw = text.trim();
  if (raw === '') return undefined;
  const rel = RELATIVE.exec(raw.replace(/\s+/g, ''));
  if (rel !== null) return relative(rel[1] ?? '', rel[2], now);
  const local = LOCAL.exec(raw);
  if (local !== null) return localTime(local);
  if (ZONED.test(raw)) {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function relative(offsets: string, round: string | undefined, now: number): number {
  const d = new Date(now);
  for (const [, sign, n, unit] of offsets.matchAll(OFFSET)) {
    const k = (sign === '-' ? -1 : 1) * Number(n);
    // Days and weeks move the calendar date, so a DST change keeps the wall-clock time.
    if (unit === 'd') d.setDate(d.getDate() + k);
    else if (unit === 'w') d.setDate(d.getDate() + 7 * k);
    else d.setTime(d.getTime() + k * UNIT_MS[unit as keyof typeof UNIT_MS]);
  }
  if (round === 'd') d.setHours(0, 0, 0, 0);
  else if (round === 'h') d.setMinutes(0, 0, 0);
  else if (round === 'm') d.setSeconds(0, 0);
  return d.getTime();
}

function localTime(m: RegExpExecArray): number | undefined {
  const [y, mo, day, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const d = new Date(y, mo - 1, day, h, mi, s);
  // new Date rolls 2026-02-30 over to March; refuse it instead.
  const same =
    d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day && d.getHours() === h && d.getMinutes() === mi;
  return same ? d.getTime() : undefined;
}

/** The value a datetime-local input takes, in the viewer's time zone: '2026-09-24T14:05'. */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Quick ranges above the window fields. Each ends now. */
export const RANGE_PRESETS: readonly { readonly label: string; readonly from: string; readonly to: string }[] = [
  { label: 'Last 15m', from: 'now-15m', to: 'now' },
  { label: 'Last 1h', from: 'now-1h', to: 'now' },
  { label: 'Last 6h', from: 'now-6h', to: 'now' },
  { label: 'Last 24h', from: 'now-24h', to: 'now' },
  { label: 'Last 7d', from: 'now-7d', to: 'now' },
  { label: 'Today', from: 'now/d', to: 'now' },
];
