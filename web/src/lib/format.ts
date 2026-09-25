const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number): string => String(n).padStart(2, '0');

function parse(iso: string): Date | undefined {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** '25 Sep, 17:42' in the viewer's local time. Adds the year when it is not the current one. */
export function formatDateTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (d === undefined) return iso;
  const year = d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** '12s ago', '5m ago', '3h ago', '2d ago'; 'in 5m' for a future time. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const d = parse(iso);
  if (d === undefined) return iso;
  const diff = now - d.getTime();
  const abs = Math.abs(diff);
  let text: string;
  if (abs < 60_000) text = `${Math.max(0, Math.round(abs / 1000))}s`;
  else if (abs < 3_600_000) text = `${Math.round(abs / 60_000)}m`;
  else if (abs < 86_400_000) text = `${Math.round(abs / 3_600_000)}h`;
  else text = `${Math.round(abs / 86_400_000)}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** '01K62ZQ8M4…DEJF'. Short ids are returned as they are. */
export function shortRunId(runId: string): string {
  return runId.length <= 16 ? runId : `${runId.slice(0, 10)}…${runId.slice(-4)}`;
}

/** '850ms', '12s', '3m 20s', '1h 5m'. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** '950', '12.4k', '1.2M'. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(x: number): string {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
}
