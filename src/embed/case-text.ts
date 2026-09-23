// The two texts a run is embedded under (D43, P2 3.4): the case card and the
// request.
//
// Both are built from run store records only. The store holds
// persisted-profile text, so nothing here sees the raw thread or the Flue
// stream. The result goes through redactPersisted once more, which is
// idempotent on masked text and gives the Persisted<string> the embedder
// requires.
//
// The case card never reads id_chain, hops or basic state: ids do not belong
// in a vector that is meant to find similar cases.

import { redactPersisted, type Persisted } from '../gate/redact.ts';
import type { RunRecord } from '../runstore/types.ts';

/** How many of the newest non-parent messages go into the request text. */
export const REQUEST_LATEST_MESSAGES = 3;
/** Per-line cap, in characters. */
export const LINE_CAP = 1000;
/** Whole-text cap, in characters. */
export const TEXT_CAP = 4000;

export type CaseCardSource = Pick<RunRecord, 'classification' | 'report'>;
export type RequestSource = Pick<RunRecord, 'request' | 'submissions'>;

/**
 * category, subcategory, current_ask, root_cause.statement, status and
 * matched_pattern_id as short labelled lines. The run's report (the latest
 * submission that has one) wins; the stored classification fills in when
 * there is no report yet. Missing fields are left out, so a run with nothing
 * to say gives an empty text.
 */
export function caseCardText(run: CaseCardSource): Persisted<string> {
  const report = run.report;
  const proposed = report?.classification.proposed ?? run.classification?.decision.proposed;
  const lines: string[] = [];
  push(lines, 'category', proposed?.category);
  push(lines, 'subcategory', proposed?.subcategory);
  push(lines, 'current_ask', report?.request.current_ask ?? proposed?.current_ask);
  push(lines, 'root_cause', report?.root_cause?.statement);
  push(lines, 'status', report?.status);
  push(lines, 'matched_pattern_id', report?.root_cause?.matched_pattern_id ?? proposed?.matched_pattern_id);
  return finish(lines);
}

/**
 * The parent message, then the newest REQUEST_LATEST_MESSAGES other
 * messages, oldest first. When the latest submission is a `triage ask`, its
 * question is added last, since it is the current ask of that submission.
 * Authors are left out.
 */
export function requestText(run: RequestSource): Persisted<string> {
  const messages = run.request.messages;
  const parentIndex = messages.findIndex((m) => m.is_parent);
  const pi = parentIndex >= 0 ? parentIndex : 0;
  const lines: string[] = [];
  push(lines, 'parent', messages[pi]?.text);
  const rest = messages.filter((_, i) => i !== pi).slice(-REQUEST_LATEST_MESSAGES);
  for (const m of rest) push(lines, 'message', m.text);
  const latest = run.submissions.at(-1);
  if (latest?.kind === 'ask') push(lines, 'ask', latest.question);
  return finish(lines);
}

function push(lines: string[], label: string, value: string | undefined): void {
  if (value === undefined) return;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat === '') return;
  lines.push(`${label}: ${flat.length > LINE_CAP ? flat.slice(0, LINE_CAP) : flat}`);
}

function finish(lines: readonly string[]): Persisted<string> {
  const text = lines.join('\n');
  return redactPersisted(text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text);
}
