// The partial report of a timed-out response (D88), built from the saved
// findings only. Ingress adds the cost and merges the gaps with reportTail,
// then writes it through writeReport, as finish_report does for a full report.

import type { RecordedFindings } from '../agents/escalation.ts';
import type { RunRecord } from '../runstore/types.ts';
import type { Entity } from '../types/core.ts';
import { EVIDENCE_LADDER_STEPS, type EvidenceLadderStep } from '../types/findings.ts';
import type { ReportDraft } from '../types/report.ts';
import { codeClaimDetail } from './finding-refs.ts';

function timeoutGap(elapsedMs: number, saved: number): string {
  const what = saved === 0 ? 'no findings were saved before it' : `this report holds the ${saved} saved ${saved === 1 ? 'finding' : 'findings'} only`;
  return `the run timed out after ${Math.round(elapsedMs / 1000)} s, before the root wrote its report; ${what}`;
}

/**
 * Nothing is confirmed, so root_cause is null and the status is inconclusive.
 * Hypotheses, code claims and the delegates' own gaps go into gaps after the
 * timeout gap, since the report has no field for unconfirmed work. Null when
 * the run has no classification.
 */
export function partialReportDraft(run: RunRecord, findings: readonly RecordedFindings[], elapsedMs: number): ReportDraft | null {
  const cls = run.classification;
  if (cls === null) return null;
  const steps = new Set<EvidenceLadderStep>();
  const timeline: ReportDraft['timeline'] = [];
  const entities: Entity[] = [];
  const unconfirmed: string[] = [];
  for (const r of findings) {
    if (r.entity === 'code') {
      steps.add('code');
      for (const c of r.findings.claims) unconfirmed.push(`code claim, not confirmed: ${codeClaimDetail(c)}: ${c.what_it_shows}`);
      continue;
    }
    entities.push(r.entity);
    for (const e of r.findings.evidence) steps.add(e.source);
    for (const t of r.findings.timeline) timeline.push({ ...t, entity: r.entity });
    for (const h of r.findings.hypotheses) unconfirmed.push(`${r.entity} hypothesis, not confirmed: ${h}`);
    for (const g of r.findings.gaps) unconfirmed.push(`${r.entity}: ${g}`);
  }
  const source = run.request.source;
  return {
    request: {
      ...(source.kind === 'slack' ? { permalink: source.permalink } : {}),
      current_ask: '',
      requested_by: run.request.requested_by,
    },
    classification: cls.decision,
    id_chain: cls.id_chain,
    current_state: [],
    timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)),
    root_cause: null,
    scope: { kind: 'unknown' },
    status: 'inconclusive',
    cx_answer: { action_owner: 'unknown', money_safe: 'unknown', should_retry: 'wait', reply_text: '' },
    actions: { cx: [], eng: [], ops_bank: [] },
    suggested_fix: [],
    confidence: 'low',
    confidence_reason: 'the run timed out before the investigation finished',
    evidence_ladder: EVIDENCE_LADDER_STEPS.filter((s) => steps.has(s)),
    entities_consulted: entities,
    gaps: [timeoutGap(elapsedMs, findings.length), ...unconfirmed],
    escalated: false,
    escalation_reasons: [],
    images_seen: cls.decision.proposed.images_seen && cls.decision.images_dropped !== true,
  };
}
