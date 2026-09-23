// Prior-case retrieval for the Triage orchestrator's initial data (D43).
//
// Off by default (TRIAGE_PRIOR_CASES=false). When on, the current run's
// request text is embedded and compared with the case and request embeddings
// of earlier runs. The hits become a structured projection with no ids and
// no free text.
//
// This is for the orchestrator only. The classifier must never see prior
// cases: it may run on OpenRouter, which D41 approved for this request's
// redacted thread only, and its confidence drives the tier rules, so prior
// cases would change the tier through the back door. A test checks that
// nothing under src/classify imports this module.
//
// Retrieval is derived and optional, so nothing here may block a run: every
// store or embedder failure comes back as [] plus a fixed gap string, and
// priorCasesFor never throws.

import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import { requestText } from '../embed/case-text.ts';
import type { Embedder } from '../embed/index.ts';
import { CategorySchema } from '../types/classification.ts';
import { ReportStatusSchema, type RunId } from '../types/core.ts';
import type { RunRecord, RunStore, SimilarHit } from './types.ts';

/** At most this many prior cases go into the initial data. D43 added no env key for it. */
export const PRIOR_CASES_TOP_K = 3;
/** Cosine similarity floor. D43 added no env key for it. */
export const PRIOR_CASES_MIN_SIMILARITY = 0.75;

export const PRIOR_CASES_UNAVAILABLE = 'prior cases unavailable';
export const PRIOR_CASES_NO_EMBEDDER = 'prior cases skipped: embeddings disabled';

// Embedding rows asked of the store. Each run can have two rows (case and
// request) and some runs are dropped for a 'wrong' verdict, so this is
// larger than the top k.
const CANDIDATE_ROWS = 24;

const DAY_MS = 86_400_000;

// Short label shapes. A value that does not fit is left out of the projection.
const LABEL = /^[A-Za-z][A-Za-z0-9_ .-]{0,63}$/;
const PATTERN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LabelSchema = v.pipe(v.string(), v.regex(LABEL));

/** One earlier case as the orchestrator sees it. strictObject, so an extra field is refused. */
export const PriorCaseSchema = v.strictObject({
  category: CategorySchema,
  subcategory: v.optional(LabelSchema),
  report_status: v.optional(ReportStatusSchema),
  matched_pattern_id: v.optional(v.pipe(v.string(), v.regex(PATTERN_ID), v.maxLength(64))),
  escalated: v.optional(v.boolean()),
  feedback_verdict: v.optional(v.picklist(['correct', 'partial', 'pending'])),
  age_days: v.pipe(v.number(), v.integer(), v.minValue(0)),
  similarity: v.pipe(v.number(), v.minValue(PRIOR_CASES_MIN_SIMILARITY), v.maxValue(1)),
});
export type PriorCase = v.InferOutput<typeof PriorCaseSchema>;

export type PriorCasesConfig = { readonly runs: Pick<Config['runs'], 'priorCases'> };

export type PriorCasesOptions = {
  readonly signal?: AbortSignal;
  /** Clock for age_days; defaults to Date.now. */
  readonly now?: () => number;
};

export type PriorCasesResult = {
  readonly cases: readonly PriorCase[];
  readonly gaps: readonly string[];
};

/**
 * Up to PRIOR_CASES_TOP_K earlier cases similar to runId, most similar
 * first. With the flag off or no embedder it returns [] and does not read
 * the store. The current run and runs whose latest feedback is 'wrong' are
 * left out.
 */
export async function priorCasesFor(
  config: PriorCasesConfig,
  store: RunStore,
  embedder: Embedder | null,
  runId: RunId,
  options: PriorCasesOptions = {},
): Promise<PriorCasesResult> {
  if (!config.runs.priorCases) return { cases: [], gaps: [] };
  if (embedder === null) return { cases: [], gaps: [PRIOR_CASES_NO_EMBEDDER] };
  try {
    return { cases: await retrieve(store, embedder, runId, options), gaps: [] };
  } catch {
    // The error itself is not recorded: its message could carry store or
    // request text, and the gap reaches the report.
    return { cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] };
  }
}

async function retrieve(
  store: RunStore,
  embedder: Embedder,
  runId: RunId,
  options: PriorCasesOptions,
): Promise<PriorCase[]> {
  const current = await store.getRun(runId);
  if (current === null) throw new Error('current run not found');
  const text = requestText(current);
  if (text.value === '') return [];

  const opts = options.signal !== undefined ? { signal: options.signal } : {};
  const vectors = await embedder.embed([text], opts);
  const vector = vectors[0];
  if (vectors.length !== 1 || vector === undefined) throw new Error('embedder returned the wrong number of vectors');

  const hits = await store.findSimilar({
    vector,
    model: embedder.model,
    kinds: ['case', 'request'],
    excludeRunId: runId,
    limit: CANDIDATE_ROWS,
  });

  const now = (options.now ?? Date.now)();
  const cases: PriorCase[] = [];
  for (const hit of bestPerRun(hits, runId)) {
    if (cases.length >= PRIOR_CASES_TOP_K) break;
    options.signal?.throwIfAborted();
    const run = await store.getRun(hit.run_id);
    if (run === null || run.feedback_latest?.verdict === 'wrong') continue;
    const projected = project(run, hit.similarity, now);
    if (projected !== null) cases.push(projected);
  }
  return cases;
}

/** One hit per run (its best row), at or above the floor, most similar first. */
function bestPerRun(hits: readonly SimilarHit[], self: RunId): SimilarHit[] {
  const best = new Map<RunId, SimilarHit>();
  for (const hit of hits) {
    if (hit.run_id === self || !(hit.similarity >= PRIOR_CASES_MIN_SIMILARITY)) continue;
    const seen = best.get(hit.run_id);
    if (seen === undefined || hit.similarity > seen.similarity) best.set(hit.run_id, hit);
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}

/** The structured projection, or null when the run has no category or the result fails the checks. */
function project(run: RunRecord, similarity: number, now: number): PriorCase | null {
  const report = run.report;
  const proposed = report?.classification.proposed ?? run.classification?.decision.proposed;
  if (proposed === undefined) return null;

  const pattern = report?.root_cause?.matched_pattern_id ?? proposed.matched_pattern_id;
  const verdict = run.feedback_latest?.verdict;
  const created = Date.parse(run.created_at);
  const candidate: Record<string, unknown> = {
    category: proposed.category,
    age_days: Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / DAY_MS)) : 0,
    similarity: Math.min(1, similarity),
  };
  if (proposed.subcategory !== '' && LABEL.test(proposed.subcategory)) candidate.subcategory = proposed.subcategory;
  if (report !== null) {
    candidate.report_status = report.status;
    candidate.escalated = report.escalated;
  }
  if (pattern !== undefined && PATTERN_ID.test(pattern)) candidate.matched_pattern_id = pattern;
  if (verdict !== undefined) candidate.feedback_verdict = verdict;

  const parsed = v.safeParse(PriorCaseSchema, candidate);
  if (!parsed.success || !scrubbed(parsed.output)) return null;
  return parsed.output;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIGIT_RUN = /\d{6,}/;
// Ten or more digits with optional spaces, dots, dashes or a leading plus.
const PHONE = /\+?\d(?:[\s.-]?\d){9,}/;

/** The last check: no string in the projection may look like an id or a phone number. */
function scrubbed(value: PriorCase): boolean {
  return Object.values(value).every(
    (field) => typeof field !== 'string' || !(UUID.test(field) || DIGIT_RUN.test(field) || PHONE.test(field)),
  );
}
