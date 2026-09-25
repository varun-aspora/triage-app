// Pure helpers for the Doctor page.

import type { DoctorCheck } from '../../api/types.ts';
import { ENTITY_LABELS } from '../../lib/constants.ts';

export type DoctorSort = 'entity' | 'check';
export type CheckGroup = { label: string; rows: DoctorCheck[] };

/**
 * Groups rows for the table's header rows. The server already orders them;
 * a Map keeps that order and still merges a group that shows up twice.
 */
export function groupChecks(checks: readonly DoctorCheck[], sortBy: DoctorSort): CheckGroup[] {
  const groups = new Map<string, DoctorCheck[]>();
  for (const check of checks) {
    const label = sortBy === 'check' ? check.id : check.entity !== undefined ? ENTITY_LABELS[check.entity] : 'General';
    const rows = groups.get(label);
    if (rows === undefined) groups.set(label, [check]);
    else rows.push(check);
  }
  return [...groups].map(([label, rows]) => ({ label, rows }));
}

/** Distinct check ids in the order they first appear. */
export function checkIds(checks: readonly DoctorCheck[]): string[] {
  return [...new Set(checks.map((c) => c.id))];
}

export function toggle<T extends string>(list: readonly T[], id: T): T[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

export type CheckFilter = {
  /** Statuses to show; empty shows every status. */
  readonly statuses: readonly DoctorCheck['status'][];
  /** Check ids to show; empty shows every check. */
  readonly checks: readonly string[];
};

/**
 * Filters in the browser, so clicking a tile or chip never re-runs the
 * probes: GET /doctor opens SQL pools and calls Quickwit every time.
 */
export function filterChecks(checks: readonly DoctorCheck[], f: CheckFilter): DoctorCheck[] {
  return checks.filter(
    (c) => (f.statuses.length === 0 || f.statuses.includes(c.status)) && (f.checks.length === 0 || f.checks.includes(c.id)),
  );
}
