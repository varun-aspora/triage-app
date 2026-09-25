// Stable ids for the findings a person can accept or reject (feedback
// findings[], the console's Findings panel).
//
// Findings are not stored with ids. Each note_evidence call stores a whole
// new version of an entity's (or code's) findings, so an id names the
// version and the position in it:
//   <entity>.v<version>.e<n>   the nth evidence item
//   <entity>.v<version>.h<n>   the nth hypothesis
//   code.v<version>.c<n>       the nth code claim
//   root_cause                 the report's root cause
// Positions count from 1. An id keeps pointing at the same text after a
// later version is written, because older versions are kept.
//
// findingRefs lists the ids of the latest versions only, which is what the
// run store returns. An id from an older version is still a valid id; it
// just has no text here.

import { EVIDENCE_KEYS, FINDING_ID_PATTERN, type EvidenceKey, type RunRecord } from '../runstore/types.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';

export const FINDING_KINDS = ['evidence', 'hypothesis', 'code_claim', 'root_cause'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type FindingRef = {
  readonly id: string;
  readonly kind: FindingKind;
  /** The evidence key, or null for the root cause. */
  readonly key: EvidenceKey | null;
  /** The findings version, or null for the root cause. */
  readonly version: number | null;
  /** What the finding says. */
  readonly text: string;
  /** Where it came from: source and query, or repo, file and lines. */
  readonly detail?: string;
};

export const ROOT_CAUSE_ID = 'root_cause';

/**
 * The findings of the run's latest evidence versions, in registry order, then
 * the root cause. A record read back from the store is taken as it is, so a
 * missing list counts as empty.
 */
export function findingRefs(run: Pick<RunRecord, 'evidence' | 'report'>): FindingRef[] {
  const out: FindingRef[] = [];
  for (const key of EVIDENCE_KEYS) {
    const record = run.evidence?.[key];
    const findings = record?.findings as Partial<EntityFindings & CodeFindings> | undefined;
    if (record === undefined || findings === undefined || findings === null) continue;
    const base = `${key}.v${record.version}`;
    if (key === 'code' || findings.claims !== undefined) {
      (findings.claims ?? []).forEach((c, i) => {
        out.push({
          id: `${base}.c${i + 1}`,
          kind: 'code_claim',
          key,
          version: record.version,
          text: c.what_it_shows,
          detail: `${c.repo}/${c.file}:${c.lines}`,
        });
      });
      continue;
    }
    (findings.evidence ?? []).forEach((e, i) => {
      out.push({
        id: `${base}.e${i + 1}`,
        kind: 'evidence',
        key,
        version: record.version,
        text: e.summary,
        detail: (e.query_or_path ?? '').trim() === '' ? e.source : `${e.source} · ${e.query_or_path}`,
      });
    });
    (findings.hypotheses ?? []).forEach((h, i) => {
      out.push({ id: `${base}.h${i + 1}`, kind: 'hypothesis', key, version: record.version, text: h });
    });
  }
  const statement = run.report?.root_cause?.statement;
  if (statement !== undefined && statement.trim() !== '') {
    out.push({ id: ROOT_CAUSE_ID, kind: 'root_cause', key: null, version: null, text: statement });
  }
  return out;
}

export type ParsedFindingId =
  | { readonly kind: 'root_cause' }
  | { readonly kind: Exclude<FindingKind, 'root_cause'>; readonly key: EvidenceKey; readonly version: number; readonly index: number };

/** Splits a finding id, or returns null when it does not have the shape. */
export function parseFindingId(id: string): ParsedFindingId | null {
  if (!FINDING_ID_PATTERN.test(id)) return null;
  if (id === ROOT_CAUSE_ID) return { kind: 'root_cause' };
  const m = /^([a-z]+)\.v(\d+)\.([ehc])(\d+)$/.exec(id);
  if (m === null) return null;
  const kind = m[3] === 'e' ? 'evidence' : m[3] === 'h' ? 'hypothesis' : 'code_claim';
  return { kind, key: m[1] as EvidenceKey, version: Number(m[2]), index: Number(m[4]) };
}

/**
 * Why the id does not name a finding this run has, or null when it does.
 * An older version of a key counts; a version the run never wrote, or a
 * position past the end of the latest version, does not.
 */
export function findingIdProblem(id: string, run: Pick<RunRecord, 'evidence' | 'report'>, refs: readonly FindingRef[]): string | null {
  const parsed = parseFindingId(id);
  if (parsed === null) return 'is not a finding id';
  if (parsed.kind === 'root_cause') return refs.some((r) => r.id === ROOT_CAUSE_ID) ? null : 'the run has no root cause yet';
  const latest = run.evidence?.[parsed.key]?.version;
  if (latest === undefined || parsed.version > latest) return 'names findings the run does not have';
  if (parsed.version === latest && !refs.some((r) => r.id === id)) return 'names findings the run does not have';
  return null;
}
