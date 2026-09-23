// The report writer finish_report calls (T06.9; HLD 02 §2 and §6, LLD 04
// §2.9 and §3, D24, D35, D43).
//
// Order:
//   1. Fill the harness fields: run_id from the caller, env_label from config
//      (display text only, D4) and generated_at from the injected clock. Any
//      value the draft carried for them is replaced.
//   2. Validate with ReportSchema. A failure returns the issues and writes
//      nothing.
//   3. Run the persisted-profile egress check (checkEgress) over every text
//      field, suggested_fix commands and cx_answer.reply_text included, with
//      the names ingress collected, and over the rendered Markdown. A miss
//      returns the pattern names and JSON paths only, never the matched text,
//      and writes nothing. run_id and env_label are left out of this check
//      (see below) but still pass through the persisted profile on write.
//      Numbers are left out of the Markdown check too, as checkEgress leaves
//      them out of the JSON check: a count such as scope.affected_count is not
//      personal data and the model has no masked form to give for it.
//   4. Render report.md and store report.json and report.md through
//      RunStore.putReport as persisted-profile values.
//
// Refusals are returned, never thrown, so finish_report can hand them to the
// model as a retry message (refusalMessage below). Store failures throw.
//
// This module renders and stores text. It never runs a suggested_fix: there
// is no process, shell or database client anywhere under src/report
// (no-exec.test.ts checks that).

import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import { checkEgress, redactPersisted, type PatternName } from '../gate/redact.ts';
import { PATTERN_NAMES } from '../gate/redact-patterns.ts';
import { RunNotFoundError, RunStoreError, type RunStore } from '../runstore/types.ts';
import type { RunId } from '../types/core.ts';
import type { RepoCommit, ReportCost } from '../types/report.ts';
import { renderReportMarkdown } from './markdown.ts';
import { ReportSchema, type Report, type ReportDraft } from './schema.ts';

/**
 * What finish_report passes in: the model's draft plus repo_commits and cost,
 * which the tool fills itself before calling.
 */
export type WriteReportDraft = ReportDraft & {
  readonly repo_commits: RepoCommit[];
  readonly cost: ReportCost | null;
};

export type WriteReportArgs = {
  readonly runId: RunId;
  readonly draft: WriteReportDraft;
  /** Names collected by ingress (initialData.redaction_names). */
  readonly ingressNames: readonly string[];
  readonly store: Pick<RunStore, 'getRun' | 'putReport'>;
  readonly config: Pick<Config, 'display'>;
  /** The submission the report answers. Defaults to the run's latest submission. */
  readonly submissionId?: number;
  /** The clock for generated_at. */
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
};

/**
 * Where the files went, relative to the run store root (TRIAGE_RUNS_DIR for
 * the folder provider). The postgres provider keeps the same two documents
 * per submission in its tables; the paths name them the same way.
 */
export type ReportPaths = {
  readonly submissionId: number;
  readonly json: string;
  readonly md: string;
};

/** One schema problem. Neither field quotes the value that failed. */
export type ReportIssue = {
  readonly path: string;
  readonly message: string;
};

export type WriteReportResult =
  | { readonly ok: true; readonly paths: ReportPaths; readonly report: Report }
  | { readonly ok: false; readonly reason: 'schema'; readonly issues: ReportIssue[] }
  | {
      readonly ok: false;
      readonly reason: 'unmasked';
      readonly patterns: PatternName[];
      /** JSON paths of the fields that still hold unmasked data. */
      readonly fields: string[];
    };

export type WriteReportRefusal = Exclude<WriteReportResult, { ok: true }>;

const MAX_ISSUES = 20;
const MAX_MESSAGE_LENGTH = 300;

export async function writeReport(args: WriteReportArgs): Promise<WriteReportResult> {
  const { runId, draft, store, config } = args;
  const names = args.ingressNames;
  const now = args.now ?? (() => new Date());

  // 1. Harness fields. env_label is copied for display and nothing reads it.
  const candidate = {
    ...draft,
    run_id: runId,
    env_label: config.display.envLabel ?? '',
    generated_at: now().toISOString(),
  };

  // 2. Schema.
  const parsed = v.safeParse(ReportSchema, candidate);
  if (!parsed.success) {
    return { ok: false, reason: 'schema', issues: parsed.issues.slice(0, MAX_ISSUES).map((i) => toIssue(i, names)) };
  }
  const report = parsed.output;

  // 3. Egress check over what the model wrote. run_id and env_label are
  //    blanked for the check: the harness and config set them, so the model
  //    could not fix a refusal there, and a ULID can hold a run of six digits
  //    that digits6 flags although it is not personal data. The stored copy
  //    still goes through the persisted profile below.
  const modelText = { ...report, run_id: '', env_label: '' };
  const jsonCheck = checkEgress(modelText, { names });
  const mdCheck = checkEgress(renderReportMarkdown(zeroNumbers(modelText)), { names });
  if (!jsonCheck.ok || !mdCheck.ok) {
    const found = new Set<PatternName>([...(jsonCheck.ok ? [] : jsonCheck.unmasked), ...(mdCheck.ok ? [] : mdCheck.unmasked)]);
    const fields = jsonCheck.ok ? ['report.md'] : [...jsonCheck.paths];
    return { ok: false, reason: 'unmasked', patterns: PATTERN_NAMES.filter((p) => found.has(p)), fields };
  }
  const md = renderReportMarkdown(report);

  // 4. Store. Nothing above touched the store, so a refusal writes nothing.
  args.signal?.throwIfAborted();
  const submissionId = args.submissionId ?? (await latestSubmission(store, runId));
  args.signal?.throwIfAborted();
  await store.putReport(runId, submissionId, redactPersisted(report, { names }), redactPersisted(md, { names }));

  const dir = `${runId}/submissions/${submissionId}`;
  return { ok: true, paths: { submissionId, json: `${dir}/report.json`, md: `${dir}/report.md` }, report };
}

// A copy with every number set to 0, for the Markdown check only. The
// renderer has no branch on a number's value, so this changes no text other
// than the numbers themselves.
function zeroNumbers<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, x: unknown) => (typeof x === 'number' ? 0 : x)) as T;
}

async function latestSubmission(store: Pick<RunStore, 'getRun'>, runId: RunId): Promise<number> {
  const run = await store.getRun(runId);
  if (run === null) throw new RunNotFoundError(runId);
  const last = run.submissions.at(-1);
  if (last === undefined) throw new RunStoreError('run has no submission to attach the report to');
  return last.seq;
}

// ------------------------------------------------------------------ issues

type AnyIssue = v.BaseIssue<unknown>;

function toIssue(issue: AnyIssue, names: readonly string[]): ReportIssue {
  return { path: issuePath(issue, names), message: issueMessage(issue, names) };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function issuePath(issue: AnyIssue, names: readonly string[]): string {
  let out = '$';
  for (const item of issue.path ?? []) {
    const key: unknown = item.key;
    if (typeof key === 'number') out += `[${key}]`;
    else if (typeof key !== 'string') out += '[?]';
    // A record key (a model name under cost.models) could itself be data.
    else if (!checkEgress(key, { names }).ok) out += '[*]';
    else out += IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  return out;
}

// Valibot's default messages end with `... but received <value>` or
// `: Received <value>`. That tail is dropped, and what is left (custom
// messages can name a suggested_fix title) goes through the persisted
// profile, so the message never carries the offending value.
function issueMessage(issue: AnyIssue, names: readonly string[]): string {
  let message = issue.message;
  const tail = `eceived ${issue.received}`;
  if (message.endsWith(tail)) {
    message = message.slice(0, -tail.length).replace(/(?: but r|: R|R)$/, '');
  }
  message = redactPersisted(message, { names }).value.trim();
  if (message === '') message = `invalid ${issue.type}`;
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : message;
}

// ------------------------------------------------------------------ refusal text

/**
 * The retry message finish_report returns to the model for a refusal. It
 * lists pattern names, JSON paths and schema messages only.
 */
export function refusalMessage(refusal: WriteReportRefusal): string {
  if (refusal.reason === 'schema') {
    const lines = refusal.issues.map((i) => `- ${i.path}: ${i.message}`);
    return [
      'The report was not written because the draft does not match the report schema.',
      'Fix these fields and call finish_report again:',
      ...lines,
    ].join('\n');
  }
  return [
    `The report was not written because it still holds unmasked data: ${refusal.patterns.join(', ')}.`,
    `Fields: ${refusal.fields.join(', ')}.`,
    'Mask or remove those values (keep at most the last four digits of a number, behind ****),',
    'drop names, phone numbers and email addresses from free text, and call finish_report again.',
  ].join('\n');
}
