// Pure helpers for the Repos page, kept out of the component so they can be
// tested without a DOM.

import type { Entity, RepoPinRow, RepoStatusRow, SyncState } from '../../api/types.ts';

export const REPO_STATES = ['All', 'needs attention', 'drift', 'local changes', 'not cloned', 'not indexed'] as const;
export type RepoState = (typeof REPO_STATES)[number];

export type RepoFilter = { q: string; entity: Entity | 'All'; state: RepoState };

/** Anything an operator may want to look at before trusting the code tools. */
export function needsAttention(row: RepoStatusRow): boolean {
  return row.drift === true || row.dirty === true || !row.present || !row.indexed || row.problem !== undefined;
}

export function matchesState(row: RepoStatusRow, state: RepoState): boolean {
  switch (state) {
    case 'All':
      return true;
    case 'needs attention':
      return needsAttention(row);
    case 'drift':
      return row.drift === true;
    case 'local changes':
      return row.dirty === true;
    case 'not cloned':
      return !row.present;
    case 'not indexed':
      return !row.indexed;
  }
}

/**
 * GET /repos rows carry no entities, so they come from the repos.json pins in
 * GET /services. undefined when that call failed; the page then shows '—'.
 */
export function entitiesByRepo(pins: readonly RepoPinRow[] | undefined): ReadonlyMap<string, readonly Entity[]> | undefined {
  if (pins === undefined) return undefined;
  return new Map(pins.map((p) => [p.repo, p.entities]));
}

export function filterRepos(
  rows: readonly RepoStatusRow[],
  filter: RepoFilter,
  entities: ReadonlyMap<string, readonly Entity[]> | undefined,
): RepoStatusRow[] {
  const q = filter.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (q !== '' && !row.repo.toLowerCase().includes(q)) return false;
    // Without the pins there is nothing to filter on, so the entity filter is ignored.
    if (filter.entity !== 'All' && entities !== undefined && !(entities.get(row.repo) ?? []).includes(filter.entity)) return false;
    return matchesState(row, filter.state);
  });
}

const TRIGGERS: Record<SyncState['trigger'], string> = { timer: 'the timer', run: 'a run', cli: 'the CLI', http: 'HTTP' };

export function triggerLabel(trigger: SyncState['trigger']): string {
  return TRIGGERS[trigger] ?? trigger;
}

export function countsLine(ok: number, skipped: number, failed: number): string {
  return `${ok} ok · ${skipped} skipped · ${failed} failed`;
}

/** The names behind the skipped and failed counts, for the Result card. Empty when all went well. */
export function problemNames(last: Pick<SyncState, 'skipped' | 'failed'>): string {
  const parts: string[] = [];
  if (last.skipped.length > 0) parts.push(`skipped: ${last.skipped.join(', ')}`);
  if (last.failed.length > 0) parts.push(`failed: ${last.failed.join(', ')}`);
  return parts.join(' · ');
}

export function shortCommit(commit: string | null): string | null {
  return commit === null || commit === '' ? null : commit.slice(0, 7);
}
