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

export function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
