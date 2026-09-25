import { describe, expect, test } from 'bun:test';
import type { DoctorCheck, RepoStatusRow } from '../../api/types.ts';
import { checkIds, filterChecks, groupChecks, toggle } from './doctor-model.ts';
import { syncResultTone } from '../../lib/status.ts';
import {
  countsLine,
  entitiesByRepo,
  filterRepos,
  matchesState,
  needsAttention,
  problemNames,
  shortCommit,
  triggerLabel,
} from './repos-model.ts';

const row = (repo: string, over: Partial<RepoStatusRow> = {}): RepoStatusRow => ({
  repo,
  expectedBranch: 'main',
  actualBranch: 'main',
  commit: '3f9c2e1aa',
  dirty: false,
  drift: false,
  indexed: true,
  present: true,
  ...over,
});

const clean = row('harbor');
const drifted = row('eventbus', { drift: true, actualBranch: 'feat/x' });
const dirty = row('vance-android', { dirty: true });
const missing = row('k8s-manifests', { present: false, indexed: false, commit: null, dirty: null, drift: null });
const unindexed = row('x-ray', { indexed: false });
const broken = row('engage', { problem: 'git failed' });

describe('repos model', () => {
  test('needsAttention flags drift, local changes, missing, unindexed and problems', () => {
    expect(needsAttention(clean)).toBe(false);
    for (const r of [drifted, dirty, missing, unindexed, broken]) expect(needsAttention(r)).toBe(true);
    // Unknown (null) drift or dirty on a present, indexed repo is not a problem by itself.
    expect(needsAttention(row('a', { drift: null, dirty: null }))).toBe(false);
  });

  test('matchesState', () => {
    const all = [clean, drifted, dirty, missing, unindexed, broken];
    const names = (state: Parameters<typeof matchesState>[1]) => all.filter((r) => matchesState(r, state)).map((r) => r.repo);
    expect(names('All')).toHaveLength(6);
    expect(names('drift')).toEqual(['eventbus']);
    expect(names('local changes')).toEqual(['vance-android']);
    expect(names('not cloned')).toEqual(['k8s-manifests']);
    expect(names('not indexed')).toEqual(['k8s-manifests', 'x-ray']);
    expect(names('needs attention')).toEqual(['eventbus', 'vance-android', 'k8s-manifests', 'x-ray', 'engage']);
  });

  test('entity join comes from the repos.json pins, undefined when they are missing', () => {
    expect(entitiesByRepo(undefined)).toBeUndefined();
    const map = entitiesByRepo([
      { repo: 'harbor', entities: ['ssfb'] },
      { repo: 'eventbus', entities: ['ssfb', 'atspl', 'rtl'], branch: 'main' },
    ]);
    expect(map?.get('eventbus')).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(map?.get('nope')).toBeUndefined();
  });

  test('filterRepos combines search, entity and state', () => {
    const rows = [clean, drifted, dirty, missing];
    const map = entitiesByRepo([
      { repo: 'harbor', entities: ['ssfb'] },
      { repo: 'eventbus', entities: ['ssfb', 'rtl'] },
      { repo: 'vance-android', entities: ['atspl'] },
    ]);
    const pick = (f: Partial<Parameters<typeof filterRepos>[1]>) =>
      filterRepos(rows, { q: '', entity: 'All', state: 'All', ...f }, map).map((r) => r.repo);
    expect(pick({ q: '  EVENT ' })).toEqual(['eventbus']);
    expect(pick({ entity: 'ssfb' })).toEqual(['harbor', 'eventbus']);
    // A repo with no pin matches no entity.
    expect(pick({ entity: 'rtl' })).toEqual(['eventbus']);
    expect(pick({ entity: 'ssfb', state: 'needs attention' })).toEqual(['eventbus']);
    // Without the pins the entity filter is ignored rather than hiding everything.
    expect(filterRepos(rows, { q: '', entity: 'rtl', state: 'All' }, undefined)).toHaveLength(4);
  });

  test('summary text', () => {
    expect(countsLine(27, 1, 1)).toBe('27 ok · 1 skipped · 1 failed');
    expect(problemNames({ skipped: ['vance-android'], failed: ['engage', 'x'] })).toBe('skipped: vance-android · failed: engage, x');
    expect(problemNames({ skipped: [], failed: [] })).toBe('');
    expect(triggerLabel('http')).toBe('HTTP');
    expect(triggerLabel('timer')).toBe('the timer');
  });

  test('sync result tones never use the accent and skipped is amber', () => {
    expect(syncResultTone('ok')).toEqual({ tone: 'neutral', icon: 'check' });
    expect(syncResultTone('skipped').tone).toBe('amber');
    expect(syncResultTone('failed').tone).toBe('rust');
  });

  test('shortCommit', () => {
    expect(shortCommit('3f9c2e1aa0')).toBe('3f9c2e1');
    expect(shortCommit(null)).toBeNull();
    expect(shortCommit('')).toBeNull();
  });
});

const check = (id: string, status: DoctorCheck['status'], entity?: DoctorCheck['entity']): DoctorCheck => ({
  id,
  status,
  key_names: [],
  message: '',
  ...(entity !== undefined ? { entity } : {}),
});

describe('doctor model', () => {
  const checks = [check('env', 'ok'), check('models', 'warn'), check('db', 'ok', 'ssfb'), check('db', 'fail', 'rtl'), check('quickwit', 'ok', 'rtl')];

  test('groups by entity with General first, keeping server order', () => {
    const groups = groupChecks(checks, 'entity');
    expect(groups.map((g) => g.label)).toEqual(['General', 'SSFB', 'RTL']);
    expect(groups[2]?.rows.map((c) => c.id)).toEqual(['db', 'quickwit']);
  });

  test('groups by check id', () => {
    const groups = groupChecks(checks, 'check');
    expect(groups.map((g) => g.label)).toEqual(['env', 'models', 'db', 'quickwit']);
    expect(groups[2]?.rows).toHaveLength(2);
  });

  test('checkIds and toggle', () => {
    expect(checkIds(checks)).toEqual(['env', 'models', 'db', 'quickwit']);
    expect(toggle(['env'], 'db')).toEqual(['env', 'db']);
    expect(toggle(['env', 'db'], 'env')).toEqual(['db']);
  });

  test('filterChecks by status and check id, empty lists meaning all', () => {
    expect(filterChecks(checks, { statuses: [], checks: [] })).toHaveLength(5);
    expect(filterChecks(checks, { statuses: ['warn', 'fail'], checks: [] }).map((c) => c.status)).toEqual(['warn', 'fail']);
    expect(filterChecks(checks, { statuses: ['ok'], checks: ['db'] }).map((c) => c.entity)).toEqual(['ssfb']);
    expect(filterChecks(checks, { statuses: ['skipped'], checks: [] })).toEqual([]);
  });
});
