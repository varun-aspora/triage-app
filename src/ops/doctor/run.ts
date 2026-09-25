// Runs doctor checks and renders the result.
//
// Each check runs on its own: a throw becomes one fail row with the check id,
// and the other checks still run. The message of a thrown error is shown only
// for ConfigError and RegistryError, whose text names keys by design. Any
// other error shows its class name only, since its message could hold a DSN
// or a response body.

import { ConfigError } from '../../config/errors.ts';
import { RegistryError } from '../../config/registry.ts';
import { ENTITIES } from '../../types/core.ts';
import {
  DOCTOR_STATUSES,
  type CheckFn,
  type CheckInput,
  type DoctorCheck,
  type DoctorContext,
  type DoctorReport,
  type DoctorStatus,
  type NamedCheck,
} from './types.ts';

export const DOCTOR_SORTS = ['entity', 'check'] as const;
export type DoctorSort = (typeof DOCTOR_SORTS)[number];

export type RunDoctorOptions = {
  /** 'entity' (the default) or 'check'; see DoctorReport.checks. */
  readonly sortBy?: DoctorSort;
  /** Run only the checks with these ids. Every check runs when left out. */
  readonly only?: readonly string[];
};

export async function runDoctor(checks: readonly CheckInput[], ctx: DoctorContext, options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const all = flatten(checks);
  const named = options.only === undefined ? all : all.filter((c) => options.only?.includes(c.id));
  const results = await Promise.all(named.map((check) => runOne(check, ctx)));
  const rows = results.flat();
  const sorted = options.sortBy === 'check' ? sortByCheck(rows) : sortByEntity(rows);
  const frozen = Object.freeze(sorted);
  return Object.freeze({ checks: frozen, counts: countRows(frozen) });
}

// Both sorts are stable, so rows keep the order they came in within each group.

// Rows with no entity first, then ENTITIES order.
function sortByEntity(rows: DoctorCheck[]): DoctorCheck[] {
  const rank = (c: DoctorCheck): number => (c.entity === undefined ? -1 : ENTITIES.indexOf(c.entity));
  return rows.sort((a, b) => rank(a) - rank(b));
}

// Rows grouped by check id, the groups in the order their first row came in.
function sortByCheck(rows: DoctorCheck[]): DoctorCheck[] {
  const first = new Map<string, number>();
  rows.forEach((c, i) => {
    if (!first.has(c.id)) first.set(c.id, i);
  });
  const rank = (c: DoctorCheck): number => first.get(c.id) as number;
  return rows.sort((a, b) => rank(a) - rank(b));
}

/** The ids of the checks, in run order, once each. */
export function doctorCheckIds(checks: readonly CheckInput[]): string[] {
  return [...new Set(flatten(checks).map((c) => c.id))];
}

/** 1 when any row is fail, else 0. */
export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.checks.some((c) => c.status === 'fail') ? 1 : 0;
}

const COLUMNS = ['check', 'entity', 'status', 'detail'] as const;

/** A plain text table with fixed columns, then one summary line. */
export function renderDoctorTable(report: DoctorReport): string {
  const cells = report.checks.map((c) => [c.id, c.entity ?? '-', c.status, c.message]);
  const widths = COLUMNS.slice(0, 3).map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] as string).length)));
  const line = (r: readonly string[]): string =>
    r
      .map((cell, i) => (i < 3 ? cell.padEnd(widths[i] as number) : cell))
      .join('  ')
      .trimEnd();
  const out = [line(COLUMNS), ...cells.map(line)];
  out.push('', DOCTOR_STATUSES.map((s) => `${report.counts[s]} ${s}`).join(', '));
  return `${out.join('\n')}\n`;
}

/** Fixed text for an error thrown by a check or a probe. Never the message of an unknown error. */
export function describeError(err: unknown): string {
  if (err instanceof ConfigError || err instanceof RegistryError) return err.message;
  if (err instanceof Error) return `threw ${err.name}`;
  return 'threw a non-error value';
}

function flatten(checks: readonly CheckInput[]): NamedCheck[] {
  const out: NamedCheck[] = [];
  const add = (c: CheckFn | NamedCheck): void => {
    out.push(typeof c === 'function' ? { id: c.name || 'check', run: c } : c);
  };
  for (const entry of checks) {
    if (Array.isArray(entry)) entry.forEach(add);
    else add(entry as CheckFn | NamedCheck);
  }
  return out;
}

async function runOne(check: NamedCheck, ctx: DoctorContext): Promise<DoctorCheck[]> {
  try {
    const rows = await check.run(ctx);
    return rows.map((r) => Object.freeze({ ...r, key_names: Object.freeze([...r.key_names]) }));
  } catch (err) {
    return [Object.freeze({ id: check.id, status: 'fail', key_names: Object.freeze(keysOf(err)), message: describeError(err) })];
  }
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// Env key names only; RegistryError also uses file names as keys.
function keysOf(err: unknown): string[] {
  if (err instanceof ConfigError || err instanceof RegistryError) return err.keys.filter((k) => ENV_NAME.test(k));
  return [];
}

function countRows(rows: readonly DoctorCheck[]): Readonly<Record<DoctorStatus, number>> {
  const counts = Object.fromEntries(DOCTOR_STATUSES.map((s) => [s, 0])) as Record<DoctorStatus, number>;
  for (const r of rows) counts[r.status] += 1;
  return Object.freeze(counts);
}
