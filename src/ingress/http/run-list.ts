// GET /triage query parsing and the filters the run store cannot apply.
//
// The store filters by since, phase and category and orders newest first
// (created_at desc, run_id desc). Status, feedback and the paging cursor are
// applied here, over the rows the store returned. Pure: no I/O.
//
// Errors name the query parameter only, never the value sent.

import * as v from 'valibot';
import { CATEGORIES, type Category } from '../../types/classification.ts';
import { RunIdSchema, TakenAtSchema, type RunId } from '../../types/core.ts';
import {
  FEEDBACK_VERDICTS,
  isTerminalPhase,
  RUN_PHASES,
  type FeedbackVerdict,
  type RunPhase,
  type RunQuery,
  type RunSummary,
} from '../../runstore/types.ts';

export const RUN_STATUSES = ['running', 'completed', 'failed', 'stopped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 'none' matches runs nobody has given feedback on yet. */
export const FEEDBACK_FILTERS = [...FEEDBACK_VERDICTS, 'none'] as const;
export type FeedbackFilter = FeedbackVerdict | 'none';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export type RunCursor = { readonly created_at: string; readonly run_id: RunId };

export type ListQuery = {
  readonly status?: RunStatus;
  readonly phase?: RunPhase;
  readonly category?: Category;
  readonly feedback?: FeedbackFilter;
  readonly since?: Date;
  readonly cursor?: RunCursor;
  readonly limit: number;
};

export type ListQueryResult =
  | { readonly ok: true; readonly value: ListQuery }
  | { readonly ok: false; readonly field: string; readonly reason: string };

export type RunPage = { readonly runs: RunSummary[]; readonly next_cursor: string | null };

const StatusSchema = v.picklist(RUN_STATUSES);
const PhaseSchema = v.picklist(RUN_PHASES);
const CategoryQuerySchema = v.picklist(CATEGORIES);
const FeedbackFilterSchema = v.picklist(FEEDBACK_FILTERS);

/** running covers every phase that is not terminal. */
export function statusOfPhase(phase: RunPhase): RunStatus {
  if (!isTerminalPhase(phase)) return 'running';
  return phase === 'completed' || phase === 'stopped' ? phase : 'failed';
}

export function parseListQuery(query: Readonly<Record<string, string | undefined>>): ListQueryResult {
  // A blank parameter (?status=) is read as absent, so a form can send an
  // empty "any" choice without tripping a 400.
  const get = (name: string): string | undefined => {
    const raw = query[name];
    return raw === undefined || raw === '' ? undefined : raw;
  };
  const fail = (field: string, reason: string): ListQueryResult => ({ ok: false, field, reason });

  const out: {
    status?: RunStatus;
    phase?: RunPhase;
    category?: Category;
    feedback?: FeedbackFilter;
    since?: Date;
    cursor?: RunCursor;
    limit: number;
  } = { limit: DEFAULT_LIST_LIMIT };

  const status = get('status');
  if (status !== undefined) {
    if (!v.is(StatusSchema, status)) return fail('status', `must be one of ${RUN_STATUSES.join(', ')}`);
    out.status = status;
  }

  const phase = get('phase');
  if (phase !== undefined) {
    if (!v.is(PhaseSchema, phase)) return fail('phase', 'is not a run phase');
    if (out.status !== undefined && statusOfPhase(phase) !== out.status) return fail('phase', 'does not match status');
    out.phase = phase;
  }

  const category = get('category');
  if (category !== undefined) {
    if (!v.is(CategoryQuerySchema, category)) return fail('category', 'is not a category');
    out.category = category;
  }

  const feedback = get('feedback');
  if (feedback !== undefined) {
    if (!v.is(FeedbackFilterSchema, feedback)) return fail('feedback', `must be one of ${FEEDBACK_FILTERS.join(', ')}`);
    out.feedback = feedback;
  }

  const since = get('since');
  if (since !== undefined) {
    const at = v.is(TakenAtSchema, since) ? new Date(since) : null;
    if (at === null || !Number.isFinite(at.getTime())) return fail('since', 'must be an ISO timestamp');
    out.since = at;
  }

  const cursor = get('cursor');
  if (cursor !== undefined) {
    const parsed = parseCursor(cursor);
    if (parsed === null) return fail('cursor', 'is not a cursor from next_cursor');
    out.cursor = parsed;
  }

  const limit = get('limit');
  if (limit !== undefined) {
    const n = /^\d{1,4}$/.test(limit) ? Number(limit) : Number.NaN;
    if (!(n >= 1 && n <= MAX_LIST_LIMIT)) return fail('limit', `must be a whole number from 1 to ${MAX_LIST_LIMIT}`);
    out.limit = n;
  }

  return { ok: true, value: out };
}

export function formatCursor(row: Pick<RunSummary, 'created_at' | 'run_id'>): string {
  return `${row.created_at},${row.run_id}`;
}

function parseCursor(raw: string): RunCursor | null {
  // Neither an ISO timestamp nor a run id can hold a comma, so the first one splits them.
  const at = raw.indexOf(',');
  if (at < 0) return null;
  const created_at = raw.slice(0, at);
  const run_id = raw.slice(at + 1);
  if (!v.is(TakenAtSchema, created_at) || !Number.isFinite(Date.parse(created_at))) return null;
  if (!v.is(RunIdSchema, run_id)) return null;
  return { created_at, run_id };
}

/** True when some filter runs here, so the store must return every matching row. */
export function needsRouteFilter(q: ListQuery): boolean {
  return q.status !== undefined || q.feedback !== undefined || q.cursor !== undefined;
}

/**
 * What to ask the store for. The extra row tells whether another page exists.
 * With a route-side filter the store gets no limit, because it cannot know how
 * many rows the filter will drop.
 */
export function storeQuery(q: ListQuery): RunQuery {
  return {
    ...(q.since !== undefined ? { since: q.since } : {}),
    ...(q.phase !== undefined ? { phase: q.phase } : {}),
    ...(q.category !== undefined ? { category: q.category } : {}),
    ...(needsRouteFilter(q) ? {} : { limit: q.limit + 1 }),
  };
}

/** Applies status, feedback and the cursor to rows in store order, then cuts one page. */
export function filterRuns(rows: readonly RunSummary[], q: ListQuery): RunPage {
  const kept = rows.filter((row) => {
    if (q.status !== undefined && statusOfPhase(row.phase) !== q.status) return false;
    if (q.feedback !== undefined) {
      const verdict = row.feedback_verdict ?? 'none';
      if (verdict !== q.feedback) return false;
    }
    if (q.cursor !== undefined && !isAfter(row, q.cursor)) return false;
    return true;
  });
  const runs = kept.slice(0, q.limit);
  const last = runs.at(-1);
  return { runs, next_cursor: kept.length > q.limit && last !== undefined ? formatCursor(last) : null };
}

/**
 * Strictly later in the stores' order: created_at desc, then run_id desc.
 * Comparing by value rather than by position keeps paging right when the
 * cursor's own run has been deleted. run_id uses localeCompare like the folder
 * store; for ULIDs (digits and upper-case letters) it agrees with Postgres.
 */
function isAfter(row: Pick<RunSummary, 'created_at' | 'run_id'>, cursor: RunCursor): boolean {
  const t = Date.parse(row.created_at);
  const c = Date.parse(cursor.created_at);
  if (t !== c) return t < c;
  return row.run_id.localeCompare(cursor.run_id) < 0;
}
