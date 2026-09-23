import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { Entity, Tier } from '../types/core.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';
import {
  computeEscalation,
  ESCALATION_REASONS,
  EscalationSchema,
  escalationFor,
  type RecordedFindings,
  releaseEscalation,
} from './escalation.ts';

// All values below are synthetic.
const T = '2026-09-20T10:00:00.000Z';

function findings(over: Partial<EntityFindings> = {}): EntityFindings {
  return {
    evidence: [{ source: 'db', at: T, query_or_path: 'transfers by id', summary: 'one row, status PENDING' }],
    timeline: [],
    hypotheses: ['transfer is stuck in this service'],
    confidence: 'high',
    gaps: [],
    ...over,
  };
}

function entity(e: Entity, over: Partial<EntityFindings> = {}): RecordedFindings {
  return { entity: e, findings: findings(over) };
}

function code(confidence: CodeFindings['confidence']): RecordedFindings {
  return {
    entity: 'code',
    findings: {
      claims: [{ repo: 'transfer-service', file: 'src/a.ts', lines: '1-5', what_it_shows: 'no retry' }],
      confidence,
    },
  };
}

function run(
  list: readonly RecordedFindings[],
  opts: { moneyMoved?: boolean; tier?: Tier; exhausted?: boolean } = {},
) {
  return computeEscalation({
    findings: list,
    classification: { money_moved: opts.moneyMoved ?? false },
    tierFinal: opts.tier ?? 'cheap',
    budgetExhausted: opts.exhausted ?? false,
  });
}

describe('computeEscalation: nothing fires', () => {
  test('no findings, no money, budget left', () => {
    expect(run([])).toEqual({ triggered: false, reasons: [] });
  });

  test('one high-confidence entity that blames itself', () => {
    expect(run([entity('ssfb')])).toEqual({ triggered: false, reasons: [] });
  });

  test('the result matches EscalationSchema', () => {
    expect(v.safeParse(EscalationSchema, run([entity('ssfb', { confidence: 'low' })])).success).toBe(true);
  });
});

describe('computeEscalation: each trigger alone', () => {
  test('low_confidence: one entity at low confidence', () => {
    expect(run([entity('atspl', { confidence: 'low' })])).toEqual({ triggered: true, reasons: ['low_confidence'] });
  });

  test('low_confidence fires even when another entity is high', () => {
    const r = run([entity('ssfb', { suggested_next_entity: 'atspl' }), entity('atspl', { confidence: 'low' })]);
    expect(r.reasons).toEqual(['low_confidence']);
  });

  test('a low-confidence code finding is not an EntityFindings and does not fire low_confidence', () => {
    expect(run([entity('ssfb'), code('low')]).triggered).toBe(false);
  });

  test('conflicting_hypotheses: two entities at high confidence each blaming themselves', () => {
    expect(run([entity('ssfb'), entity('atspl')])).toEqual({ triggered: true, reasons: ['conflicting_hypotheses'] });
  });

  test('conflicting_hypotheses: two entities at medium confidence each blaming themselves', () => {
    const r = run([entity('ssfb', { confidence: 'medium' }), entity('atspl', { confidence: 'medium' })], {
      exhausted: false,
    });
    expect(r).toEqual({ triggered: true, reasons: ['conflicting_hypotheses'] });
  });

  test('an entity that names itself as suggested_next_entity still blames itself', () => {
    const r = run([entity('ssfb', { suggested_next_entity: 'ssfb' }), entity('rtl')]);
    expect(r.reasons).toEqual(['conflicting_hypotheses']);
  });

  test('money_moved_non_strong: money moved on a cheap run', () => {
    expect(run([], { moneyMoved: true, tier: 'cheap' })).toEqual({
      triggered: true,
      reasons: ['money_moved_non_strong'],
    });
  });

  test('money_moved_non_strong: money moved on a mid run', () => {
    expect(run([], { moneyMoved: true, tier: 'mid' }).reasons).toEqual(['money_moved_non_strong']);
  });

  test('budget_exhausted_no_root_cause: exhausted with only medium findings', () => {
    const r = run([entity('ssfb', { confidence: 'medium' })], { exhausted: true });
    expect(r).toEqual({ triggered: true, reasons: ['budget_exhausted_no_root_cause'] });
  });

  test('budget_exhausted_no_root_cause: exhausted with no findings at all', () => {
    expect(run([], { exhausted: true }).reasons).toEqual(['budget_exhausted_no_root_cause']);
  });
});

describe('computeEscalation: exemptions', () => {
  test('money moved on a strong run does not fire money_moved_non_strong', () => {
    expect(run([], { moneyMoved: true, tier: 'strong' })).toEqual({ triggered: false, reasons: [] });
  });

  test('no money moved on a cheap run does not fire', () => {
    expect(run([], { moneyMoved: false, tier: 'cheap' }).triggered).toBe(false);
  });

  test('budget exhausted with a high-confidence entity finding does not fire', () => {
    expect(run([entity('ssfb', { confidence: 'high' })], { exhausted: true })).toEqual({
      triggered: false,
      reasons: [],
    });
  });

  test('budget exhausted with a high-confidence code finding does not fire', () => {
    const r = run([entity('ssfb', { confidence: 'medium' }), code('high')], { exhausted: true });
    expect(r.triggered).toBe(false);
  });

  test('one entity blaming the other via suggested_next_entity is not a conflict', () => {
    const r = run([
      entity('ssfb', { confidence: 'medium', suggested_next_entity: 'atspl' }),
      entity('atspl', { confidence: 'medium' }),
    ]);
    expect(r).toEqual({ triggered: false, reasons: [] });
  });

  test('both pointing at a third entity is not a conflict', () => {
    const r = run([entity('ssfb', { suggested_next_entity: 'rtl' }), entity('atspl', { suggested_next_entity: 'rtl' })]);
    expect(r.triggered).toBe(false);
  });

  test('an entity with no hypotheses does not count as blaming itself', () => {
    expect(run([entity('ssfb'), entity('atspl', { hypotheses: [] })]).triggered).toBe(false);
  });

  test('a low-confidence self-blame does not count toward a conflict', () => {
    const r = run([entity('ssfb'), entity('atspl', { confidence: 'low' })]);
    expect(r.reasons).toEqual(['low_confidence']);
  });

  test('two records from the same entity are not a conflict', () => {
    expect(run([entity('ssfb'), entity('ssfb', { confidence: 'medium' })]).triggered).toBe(false);
  });
});

describe('computeEscalation: combinations', () => {
  test('all four fire together, in a fixed order', () => {
    const r = run(
      [
        entity('ssfb', { confidence: 'medium' }),
        entity('atspl', { confidence: 'medium' }),
        entity('rtl', { confidence: 'low' }),
      ],
      { moneyMoved: true, tier: 'cheap', exhausted: true },
    );
    expect(r).toEqual({ triggered: true, reasons: [...ESCALATION_REASONS] });
  });

  test('low confidence and money moved', () => {
    const r = run([entity('atspl', { confidence: 'low' })], { moneyMoved: true, tier: 'mid' });
    expect(r.reasons).toEqual(['low_confidence', 'money_moved_non_strong']);
  });

  test('conflict and budget exhausted before a root cause', () => {
    const r = run([entity('ssfb', { confidence: 'medium' }), entity('rtl', { confidence: 'medium' })], {
      exhausted: true,
    });
    expect(r.reasons).toEqual(['conflicting_hypotheses', 'budget_exhausted_no_root_cause']);
  });

  test('on a strong run, the other triggers still fire', () => {
    const r = run([entity('ssfb', { confidence: 'low' })], { moneyMoved: true, tier: 'strong', exhausted: true });
    expect(r.reasons).toEqual(['low_confidence', 'budget_exhausted_no_root_cause']);
  });
});

describe('escalationFor', () => {
  const used: string[] = [];
  const store = (runId: string) => {
    used.push(runId);
    return escalationFor(runId);
  };

  afterEach(() => {
    for (const id of used.splice(0)) releaseEscalation(id);
  });

  test('a new store is empty and not triggered', () => {
    expect(store('run-empty').snapshot()).toEqual({
      triggered: false,
      reasons: [],
      findings: [],
      budgetExhausted: false,
    });
  });

  test('the same run id returns the same store', () => {
    expect(store('run-same')).toBe(store('run-same'));
  });

  test('record() collects findings and a low finding shows up as a trigger', () => {
    const s = store('run-low');
    s.record(entity('atspl', { confidence: 'low' }));
    const snap = s.snapshot();
    expect(snap.findings).toHaveLength(1);
    expect(snap.findings[0]?.entity).toBe('atspl');
    expect(snap.reasons).toEqual(['low_confidence']);
    expect(snap.triggered).toBe(true);
  });

  test('markBudgetExhausted() is sticky and fires with no high finding', () => {
    const s = store('run-budget');
    s.markBudgetExhausted();
    s.markBudgetExhausted();
    const snap = s.snapshot();
    expect(snap.budgetExhausted).toBe(true);
    expect(snap.reasons).toEqual(['budget_exhausted_no_root_cause']);
  });

  test('snapshot() leaves out money_moved_non_strong without the run context', () => {
    const s = store('run-money');
    expect(s.snapshot().triggered).toBe(false);
    expect(s.snapshot({ classification: { money_moved: true }, tierFinal: 'cheap' }).reasons).toEqual([
      'money_moved_non_strong',
    ]);
    expect(s.snapshot({ classification: { money_moved: true }, tierFinal: 'strong' }).triggered).toBe(false);
  });

  test('runA and runB do not share state', () => {
    const a = store('run-a');
    const b = store('run-b');
    a.record(entity('ssfb', { confidence: 'low' }));
    a.markBudgetExhausted();
    b.record(entity('rtl', { confidence: 'high' }));

    const snapA = a.snapshot();
    const snapB = b.snapshot();
    expect(snapA.findings.map((f) => f.entity)).toEqual(['ssfb']);
    expect(snapA.budgetExhausted).toBe(true);
    expect(snapB.findings.map((f) => f.entity)).toEqual(['rtl']);
    expect(snapB.budgetExhausted).toBe(false);
    expect(snapB.triggered).toBe(false);
  });

  test('changing a recorded value or a snapshot does not change the store', () => {
    const s = store('run-copy');
    const rec = entity('ssfb', { confidence: 'high' });
    s.record(rec);
    (rec.findings as { confidence: string }).confidence = 'low';
    const snap = s.snapshot();
    expect(snap.findings[0]?.findings.confidence).toBe('high');
    (snap.findings as RecordedFindings[]).push(entity('rtl'));
    expect(s.snapshot().findings).toHaveLength(1);
  });

  test('releaseEscalation() drops the store and a later call starts fresh', () => {
    const s = store('run-release');
    s.record(entity('ssfb', { confidence: 'low' }));
    expect(releaseEscalation('run-release')).toBe(true);
    expect(releaseEscalation('run-release')).toBe(false);
    expect(store('run-release').snapshot().findings).toEqual([]);
  });

  test('an invalid run id is refused', () => {
    expect(() => escalationFor('../etc')).toThrow();
    expect(() => escalationFor('')).toThrow();
  });
});
