import { describe, expect, test } from 'bun:test';
import type { RunSummary } from '../../runstore/types.ts';
import {
  DEFAULT_LIST_LIMIT,
  filterRuns,
  formatCursor,
  MAX_LIST_LIMIT,
  needsRouteFilter,
  parseListQuery,
  statusOfPhase,
  storeQuery,
  type ListQuery,
} from './run-list.ts';

const T1 = '2026-09-24T10:00:00.000Z';
const T2 = '2026-09-24T09:00:00.000Z';

function row(run_id: string, created_at: string, over: Partial<RunSummary> = {}): RunSummary {
  return { run_id, created_at, updated_at: created_at, phase: 'completed', submissions: 1, ...over };
}

function parsed(query: Record<string, string>): ListQuery {
  const r = parseListQuery(query);
  if (!r.ok) throw new Error(`expected ok, got field ${r.field}`);
  return r.value;
}

function failedField(query: Record<string, string>): string {
  const r = parseListQuery(query);
  if (r.ok) throw new Error('expected a failure');
  return r.field;
}

describe('parseListQuery', () => {
  test('no parameters -> the default limit and nothing else', () => {
    expect(parsed({})).toEqual({ limit: DEFAULT_LIST_LIMIT });
  });

  test('every parameter parses when valid', () => {
    const q = parsed({
      status: 'running',
      phase: 'investigating',
      category: 'transfer_out',
      feedback: 'none',
      since: '2026-09-01T00:00:00.000Z',
      cursor: `${T1},01J8Z3K4M5N6P7Q8R9S0T1V2W3`,
      limit: '10',
    });
    expect(q.status).toBe('running');
    expect(q.phase).toBe('investigating');
    expect(q.category).toBe('transfer_out');
    expect(q.feedback).toBe('none');
    expect(q.since?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(q.cursor).toEqual({ created_at: T1, run_id: '01J8Z3K4M5N6P7Q8R9S0T1V2W3' });
    expect(q.limit).toBe(10);
  });

  test('each feedback verdict is accepted', () => {
    for (const f of ['correct', 'partial', 'wrong', 'pending', 'none']) expect(parsed({ feedback: f }).feedback as string).toBe(f);
  });

  test.each([
    ['status', { status: 'done' }],
    ['phase', { phase: 'sleeping' }],
    ['category', { category: 'not_a_category' }],
    ['feedback', { feedback: 'maybe' }],
    ['since', { since: 'yesterday' }],
    ['since', { since: '2026-13-45T00:00:00Z' }],
    ['cursor', { cursor: 'nocomma' }],
    ['cursor', { cursor: `not-a-time,01J8Z3K4M5N6P7Q8R9S0T1V2W3` }],
    ['cursor', { cursor: `${T1},bad id!` }],
    ['cursor', { cursor: `${T1},` }],
    ['limit', { limit: '0' }],
    ['limit', { limit: String(MAX_LIST_LIMIT + 1) }],
    ['limit', { limit: '-1' }],
    ['limit', { limit: '2.5' }],
    ['limit', { limit: 'ten' }],
  ] as const)('a bad %s -> that field', (field, query) => {
    expect(failedField(query)).toBe(field);
  });

  test('limit bounds 1 and 200 are accepted', () => {
    expect(parsed({ limit: '1' }).limit).toBe(1);
    expect(parsed({ limit: String(MAX_LIST_LIMIT) }).limit).toBe(MAX_LIST_LIMIT);
  });

  test('status and phase must agree', () => {
    expect(failedField({ status: 'running', phase: 'completed' })).toBe('phase');
    expect(failedField({ status: 'completed', phase: 'failed' })).toBe('phase');
    expect(failedField({ status: 'failed', phase: 'created' })).toBe('phase');
    expect(parsed({ status: 'failed', phase: 'failed' }).phase).toBe('failed');
    expect(parsed({ status: 'running', phase: 'created' }).phase).toBe('created');
  });

  test('a blank parameter counts as absent', () => {
    expect(parsed({ status: '', limit: '' })).toEqual({ limit: DEFAULT_LIST_LIMIT });
  });

  test('the failure reason never repeats the value sent', () => {
    const r = parseListQuery({ category: 'secret-9876543210' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('9876543210');
  });
});

describe('statusOfPhase', () => {
  test('non-terminal phases are running', () => {
    expect(statusOfPhase('created')).toBe('running');
    expect(statusOfPhase('investigating')).toBe('running');
    expect(statusOfPhase('completed')).toBe('completed');
    expect(statusOfPhase('failed')).toBe('failed');
  });
});

describe('storeQuery', () => {
  test('passes limit + 1 only when nothing is filtered in the route', () => {
    const since = new Date(T2);
    expect(storeQuery(parsed({ phase: 'completed', category: 'transfer_out', limit: '5', since: T2 }))).toEqual({
      phase: 'completed',
      category: 'transfer_out',
      since,
      limit: 6,
    });
    const filtered: Record<string, string>[] = [{ status: 'running' }, { feedback: 'none' }, { cursor: `${T1},A` }];
    for (const q of filtered) {
      expect(needsRouteFilter(parsed(q))).toBe(true);
      expect('limit' in storeQuery(parsed(q))).toBe(false);
    }
  });
});

describe('filterRuns', () => {
  // Store order: created_at desc, run_id desc. Three rows share T1.
  const rows = [
    row('C', T1, { phase: 'investigating' }),
    row('B', T1, { feedback_verdict: 'correct' }),
    row('A', T1, { phase: 'failed' }),
    row('Z', T2),
  ];

  test('status running keeps non-terminal phases only', () => {
    expect(filterRuns(rows, parsed({ status: 'running' })).runs.map((r) => r.run_id)).toEqual(['C']);
    expect(filterRuns(rows, parsed({ status: 'failed' })).runs.map((r) => r.run_id)).toEqual(['A']);
    expect(filterRuns(rows, parsed({ status: 'completed' })).runs.map((r) => r.run_id)).toEqual(['B', 'Z']);
  });

  test('feedback none keeps runs without a verdict', () => {
    expect(filterRuns(rows, parsed({ feedback: 'none' })).runs.map((r) => r.run_id)).toEqual(['C', 'A', 'Z']);
    expect(filterRuns(rows, parsed({ feedback: 'correct' })).runs.map((r) => r.run_id)).toEqual(['B']);
  });

  test('paging walks rows with equal created_at without repeats or gaps', () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: Record<string, string> = { limit: '2' };
      if (cursor !== null) q.cursor = cursor;
      const page = filterRuns(rows, parsed(q));
      seen.push(...page.runs.map((r) => r.run_id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(['C', 'B', 'A', 'Z']);
    expect(pages).toBe(2);
  });

  test('next_cursor names the last row returned, and is null on the last page', () => {
    const first = filterRuns(rows, parsed({ limit: '3' }));
    expect(first.next_cursor).toBe(formatCursor(rows[2] as RunSummary));
    const last = filterRuns(rows, parsed({ limit: '4' }));
    expect(last.next_cursor).toBeNull();
  });

  test('a cursor whose run is gone still pages by value', () => {
    const page = filterRuns(rows, parsed({ cursor: `${T1},BB` }));
    expect(page.runs.map((r) => r.run_id)).toEqual(['B', 'A', 'Z']);
  });

  test('the limit cuts the page', () => {
    expect(filterRuns(rows, parsed({ limit: '1' })).runs).toHaveLength(1);
  });
});
