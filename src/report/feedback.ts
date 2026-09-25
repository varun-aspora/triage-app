// Feedback capture (D29, D42, LLD 04 §2.10, P4 "one append-only source").
//
// recordFeedback is the only feedback recorder. `triage feedback` calls it
// with interface 'cli' and the HTTP feedback route (T07.7) with 'http'.
//
// A verdict can be given at any point of a run, not only after the report:
// accept (correct) or reject (wrong), with optional notes and a verdict per
// finding (src/report/finding-refs.ts). Each record carries the phase the run
// was in, its latest submission and the submission whose report was judged,
// so learning can tell an early reject from a verdict on a finished report.
// stopRun (src/ingress/stop.ts) records a Cancel through here too.
//
// What it does, in order:
//   1. Validates the input and the run id. A bad verdict or a bad run id
//      throws FeedbackError before anything is read or written.
//   2. Loads the run from the store. An unknown run, or a finding id the run
//      does not have, is refused and nothing is written.
//   3. Redacts the whole record (free text included) with the persisted
//      profile, so phone and account numbers are masked before any write.
//   4. When the run has a report: renders feedback.md from every record,
//      latest wins, in the eval front-matter the old capture hook wrote,
//      minus the service fields (D42).
//   5. Appends the record through RunStore.putFeedback, with that feedback.md.
//   6. When the run has a report: writes an eval draft (feedback.md plus a
//      copy of report.json) to <TRIAGE_HOME>/evals/_unreviewed/<run_id>/.
//      Nothing here writes to evals/cases; promotion is `triage fixtures
//      review` (D42). A verdict given before the report has no draft.
//
// The store's feedback.jsonl (or feedback rows) is the source of truth, and
// feedback.md is only a rendering of it. Errors carry field names and fixed
// reasons, never the text the caller sent.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { stringify as stringifyYaml } from 'yaml';
import { redactPersisted } from '../gate/redact.ts';
import { logRunEvent } from '../runlog/event-log.ts';
import {
  EVIDENCE_KEYS,
  FEEDBACK_VERDICTS,
  FINDING_VERDICTS,
  FeedbackVerdictSchema,
  FindingVerdictSchema,
  type Feedback,
  type FindingFeedback,
  type RunPhase,
  type RunRecord,
  type RunStore,
} from '../runstore/types.ts';
import type { Report } from '../types/report.ts';
import { findingIdProblem, findingRefs } from './finding-refs.ts';
import { evalDraftDir, isRunId, writeFileAtomic } from './run-folder.ts';

// ------------------------------------------------------------------ input

export const FEEDBACK_INTERFACES = ['cli', 'http'] as const;

/** Longest free-text field accepted, in characters. */
export const MAX_FEEDBACK_TEXT = 4000;
const MAX_GIVEN_BY = 200;
/** Most queries listed under investigation.queries. */
const MAX_QUERIES = 20;
/** Most findings one verdict can mark. */
export const MAX_FINDING_VERDICTS = 200;

// Blank free text counts as not given.
const FreeTextSchema = v.optional(
  v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(MAX_FEEDBACK_TEXT),
    v.transform((s) => (s === '' ? undefined : s)),
  ),
);

export const FindingFeedbackInputSchema = v.object({
  id: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(64)),
  verdict: FindingVerdictSchema,
  note: FreeTextSchema,
});

export const FeedbackInputSchema = v.object({
  verdict: FeedbackVerdictSchema,
  actual_root_cause: FreeTextSchema,
  faster_path: FreeTextSchema,
  notes: FreeTextSchema,
  findings: v.optional(v.pipe(v.array(FindingFeedbackInputSchema), v.maxLength(MAX_FINDING_VERDICTS))),
  given_by: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_GIVEN_BY)),
  interface: v.picklist(FEEDBACK_INTERFACES),
  /** Only stopRun sets it. */
  cancelled: v.optional(v.literal(true)),
});
export type FeedbackInput = v.InferInput<typeof FeedbackInputSchema>;

export type FeedbackDeps = {
  readonly store: RunStore;
  /** TRIAGE_HOME (config.home), absolute. The eval draft goes under it. */
  readonly home: string;
  /** Defaults to the system clock. */
  readonly now?: () => Date;
};

export type FeedbackOptions = {
  /** The phase to record instead of the run's current one (stopRun passes the phase before the stop). */
  readonly phase?: RunPhase;
};

export type FeedbackErrorCode = 'invalid_input' | 'invalid_run_id' | 'run_not_found';

export class FeedbackError extends Error {
  override readonly name = 'FeedbackError';
  readonly code: FeedbackErrorCode;
  /** Field names that failed validation, for invalid_input. */
  readonly fields: readonly string[];
  constructor(code: FeedbackErrorCode, message: string, fields: readonly string[] = []) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}

export type FeedbackResult = {
  readonly run_id: string;
  /** The record as stored, after redaction. */
  readonly record: Feedback;
  /** How many feedback records the run has now. */
  readonly count: number;
  /** Null when the run has no report yet, so there is no eval draft. */
  readonly draft_dir: string | null;
  readonly draft_files: { readonly feedback_md: string; readonly report_json: string } | null;
};

export const DRAFT_FEEDBACK_FILE = 'feedback.md';
export const DRAFT_REPORT_FILE = 'report.json';

// ------------------------------------------------------------------ record

export async function recordFeedback(
  runId: string,
  input: FeedbackInput,
  deps: FeedbackDeps,
  options: FeedbackOptions = {},
): Promise<FeedbackResult> {
  const parsed = parseFeedbackInput(input);
  if (!isRunId(runId)) throw new FeedbackError('invalid_run_id', 'run_id must be a 26-character uppercase ULID');

  const run = await deps.store.getRun(runId);
  if (run === null) throw new FeedbackError('run_not_found', `no run ${runId} in the run store`);
  const findings = checkFindings(run, parsed.findings ?? []);

  const seqs = run.submissions.map((s) => s.seq);
  const reportSeq = run.submissions.filter((s) => s.report !== null).at(-1)?.seq;
  const now = deps.now ?? (() => new Date());
  const raw: Feedback = {
    verdict: parsed.verdict,
    ...(parsed.actual_root_cause !== undefined ? { actual_root_cause: parsed.actual_root_cause } : {}),
    ...(parsed.faster_path !== undefined ? { faster_path: parsed.faster_path } : {}),
    ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
    given_by: parsed.given_by,
    given_at: now().toISOString(),
    interface: parsed.interface,
    phase: options.phase ?? run.phase,
    ...(seqs.length > 0 ? { submission_seq: Math.max(...seqs) } : {}),
    ...(reportSeq !== undefined ? { report_seq: reportSeq } : {}),
    ...(parsed.cancelled === true ? { cancelled: true as const } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
  const record = redactPersisted(raw);
  const records = [...run.feedback, record.value];
  logRunEvent(runId, 'feedback', record.value);

  if (run.report === null) {
    await deps.store.putFeedback(runId, record);
    return { run_id: runId, record: record.value, count: records.length, draft_dir: null, draft_files: null };
  }

  const md = redactPersisted(renderFeedbackMd(runId, run, records));
  await deps.store.putFeedback(runId, record, md);

  const dir = evalDraftDir(deps.home, runId);
  await mkdir(dir, { recursive: true });
  const feedbackPath = join(dir, DRAFT_FEEDBACK_FILE);
  const reportPath = join(dir, DRAFT_REPORT_FILE);
  // The stored report is persisted-profile already; redacting again is a no-op
  // that keeps the draft clean even if the store returned something else.
  await writeFileAtomic(reportPath, `${JSON.stringify(redactPersisted(run.report).value, null, 2)}\n`);
  await writeFileAtomic(feedbackPath, md.value);

  return {
    run_id: runId,
    record: record.value,
    count: records.length,
    draft_dir: dir,
    draft_files: { feedback_md: feedbackPath, report_json: reportPath },
  };
}

// Each id must name a finding the run has, at most once. The finding's text is copied in when known.
function checkFindings(run: RunRecord, input: readonly v.InferOutput<typeof FindingFeedbackInputSchema>[]): FindingFeedback[] {
  const refs = findingRefs(run);
  const seen = new Set<string>();
  return input.map((f, i) => {
    const problem = seen.has(f.id) ? 'appears twice' : findingIdProblem(f.id, run, refs);
    if (problem !== null) throw new FeedbackError('invalid_input', `invalid feedback: findings.${i}.id ${problem}`, [`findings.${i}.id`]);
    seen.add(f.id);
    const text = refs.find((r) => r.id === f.id)?.text;
    return {
      id: f.id,
      verdict: f.verdict,
      ...(f.note !== undefined ? { note: f.note } : {}),
      ...(text !== undefined ? { text } : {}),
    };
  });
}

/** Validates feedback input. Throws FeedbackError naming the fields, never their values. */
export function parseFeedbackInput(input: unknown): v.InferOutput<typeof FeedbackInputSchema> {
  const result = v.safeParse(FeedbackInputSchema, input);
  if (result.success) return result.output;
  const fields = [...new Set(result.issues.map((i) => v.getDotPath(i) ?? '(input)'))];
  const reasons = fields.map((f) => `${f} ${fieldReason(f)}`);
  throw new FeedbackError('invalid_input', `invalid feedback: ${reasons.join('; ')}`, fields);
}

function fieldReason(field: string): string {
  switch (field) {
    case 'verdict':
      return `must be one of ${FEEDBACK_VERDICTS.join(', ')}`;
    case 'interface':
      return `must be one of ${FEEDBACK_INTERFACES.join(', ')}`;
    case 'given_by':
      return `must be a non-empty string of at most ${MAX_GIVEN_BY} characters`;
    case 'actual_root_cause':
    case 'faster_path':
    case 'notes':
      return `must be a string of at most ${MAX_FEEDBACK_TEXT} characters`;
    case 'findings':
      return `must be a list of at most ${MAX_FINDING_VERDICTS} findings`;
    default:
      if (/^findings\.\d+\.verdict$/.test(field)) return `must be one of ${FINDING_VERDICTS.join(', ')}`;
      if (/^findings\.\d+\.note$/.test(field)) return `must be a string of at most ${MAX_FEEDBACK_TEXT} characters`;
      return 'is invalid';
  }
}

// ------------------------------------------------------------------ render

/**
 * The eval front-matter, in the shape the old capture hook wrote:
 * id, type, input {problem, identifiers, ref}, investigation {root_cause,
 * queries}, ground_truth {verdict, actual_root_cause, faster_path},
 * captured_at. The service fields are gone (D42). Empty optional fields are
 * left out, as the hook did.
 */
export type FeedbackFrontMatter = {
  id: string;
  type: 'resolved' | 'pending';
  input: { problem: string; identifiers: Record<string, string>; ref: string };
  investigation: { root_cause: string; queries: string[] };
  ground_truth: {
    verdict: Feedback['verdict'];
    actual_root_cause?: string;
    faster_path?: string;
    notes?: string;
    findings?: FindingFeedback[];
  };
  captured_at: string;
};

export function buildFrontMatter(runId: string, report: Report, run: Pick<RunRecord, 'evidence'>, latest: Feedback): FeedbackFrontMatter {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(report.id_chain.ids)) {
    if (typeof value === 'string' && value !== '') ids[key] = value;
  }
  return {
    id: runId,
    type: latest.verdict === 'pending' ? 'pending' : 'resolved',
    input: {
      problem: oneLine(report.request.current_ask) || 'none',
      identifiers: ids,
      ref: report.request.permalink ?? 'none',
    },
    investigation: {
      root_cause: report.root_cause?.statement ?? 'inconclusive',
      queries: queriesOf(run),
    },
    ground_truth: {
      verdict: latest.verdict,
      ...(latest.actual_root_cause !== undefined ? { actual_root_cause: latest.actual_root_cause } : {}),
      ...(latest.faster_path !== undefined ? { faster_path: latest.faster_path } : {}),
      ...(latest.notes !== undefined ? { notes: latest.notes } : {}),
      ...(latest.findings !== undefined ? { findings: latest.findings } : {}),
    },
    captured_at: latest.given_at,
  };
}

/**
 * feedback.md from every record, oldest first; the last one wins. The
 * front-matter is followed by a short history of verdicts (time, interface,
 * verdict). The result still needs redactPersisted before it is stored.
 */
export function renderFeedbackMd(runId: string, run: Pick<RunRecord, 'report' | 'evidence'>, records: readonly Feedback[]): string {
  const latest = records.at(-1);
  if (latest === undefined) throw new FeedbackError('invalid_input', 'no feedback records to render');
  if (run.report === null) throw new FeedbackError('invalid_input', `run ${runId} has no report yet`);
  // Masked here too, so the YAML is built from persisted-profile values.
  const front = redactPersisted(buildFrontMatter(runId, run.report, run, latest)).value;
  const yaml = stringifyYaml(front, { lineWidth: 0 });
  const history = records.map(
    (r, i) =>
      `${i + 1}. ${r.given_at} via ${r.interface}: ${r.verdict}${r.cancelled === true ? ' (cancelled the run)' : ''}${i === records.length - 1 ? ' (latest)' : ''}`,
  );
  return ['---', yaml.trimEnd(), '---', '', '## Feedback history', '', ...history, ''].join('\n');
}

// query_or_path of every evidence item, per entity in registry order, without repeats.
function queriesOf(run: Pick<RunRecord, 'evidence'>): string[] {
  const out: string[] = [];
  for (const key of EVIDENCE_KEYS) {
    const findings = run.evidence[key]?.findings;
    if (findings === undefined || !('evidence' in findings)) continue;
    for (const item of findings.evidence) {
      const q = oneLine(item.query_or_path);
      if (q !== '' && !out.includes(q)) out.push(q);
      if (out.length >= MAX_QUERIES) return out;
    }
  }
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
