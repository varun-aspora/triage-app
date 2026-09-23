import { beforeAll, describe, expect, test } from 'bun:test';
import { ResultUnavailableError } from '@flue/runtime';
import * as v from 'valibot';
import { configFromRecord, type Config } from '../config/env.ts';
import { createFakeModel } from '../mock/fake-model.ts';
import { type ReportDraft, ReportDraftSchema } from '../types/report.ts';
import type { RecordedFindings } from './escalation.ts';

// synthesis.ts imports models.ts, which loads config at import. Clear
// TRIAGE_HOME first so a home exported in the shell is never read.
delete process.env.TRIAGE_HOME;
const { synthesizeOnStrong, synthesisPrompt, SYNTHESIS_FAILED_GAP } = await import('./synthesis.ts');
type Harness = Parameters<typeof synthesizeOnStrong>[0];

// All values below are synthetic.
const T = '2026-09-20T10:00:00.000Z';
const fake = createFakeModel();

let config: Config;
beforeAll(() => {
  fake.install();
  config = configFromRecord({ ...fake.modelEnv, MODEL_THINKING_STRONG: 'medium' }, '/triage/home');
});

const evidenceRef = { source: 'db' as const, entity: 'atspl' as const, service: 'package', raw_ref: '/data/call-1.json' };

function draft(): ReportDraft {
  return v.parse(ReportDraftSchema, {
    request: { current_ask: 'Why was the welcome letter not delivered?', requested_by: 'ops@example.test' },
    classification: {
      proposed: {
        category: 'delivery',
        subcategory: 'welcome_letter',
        entities_likely: ['atspl'],
        current_ask: 'Why was the welcome letter not delivered?',
        money_moved: false,
        misdirected_funds: false,
        tier_proposed: 'cheap',
        confidence: 0.8,
        missing_info: [],
        images_seen: false,
      },
      tier_final: 'cheap',
      rule_fired: 'default',
    },
    id_chain: { ids: { customer_id: 'cust-test-1' }, hops: [], basic_state: [] },
    current_state: [],
    timeline: [],
    root_cause: { statement: 'Cheap guess', code_refs: [] },
    scope: { kind: 'single' },
    status: 'root_cause_confirmed',
    cx_answer: { action_owner: 'user', money_safe: 'yes', should_retry: 'yes', reply_text: 'Please retry.' },
    actions: { cx: [], eng: [], ops_bank: [] },
    suggested_fix: [],
    confidence: 'high',
    confidence_reason: 'cheap model said so',
    evidence_ladder: ['db'],
    entities_consulted: ['atspl'],
    gaps: ['atspl:package API not configured'],
    escalated: false,
    escalation_reasons: [],
    images_seen: false,
  });
}

function strongReport(): ReportDraft {
  return {
    ...draft(),
    // The strong model tries to change pinned facts; they must be restored.
    request: { current_ask: 'something else', requested_by: 'model@example.test' },
    id_chain: { ids: {}, hops: [], basic_state: [] },
    images_seen: true,
    root_cause: null,
    status: 'inconclusive',
    confidence: 'low',
    confidence_reason: 'no vendor event in the evidence',
    gaps: ['no vendor callback found', 'atspl:package API not configured'],
    escalated: false,
    escalation_reasons: [],
  };
}

const evidence: RecordedFindings[] = [
  {
    entity: 'atspl',
    findings: {
      evidence: [{ source: 'db', at: T, query_or_path: 'delivery_requests', summary: 'one request, status FAILED' }],
      timeline: [{ at: T, what: 'delivery request created', source: evidenceRef }],
      hypotheses: ['vendor rejected the address'],
      confidence: 'low',
      gaps: [],
    },
  },
];

type Call = { text: string; options: Record<string, unknown> };

function stubHarness(respond: () => Promise<unknown>): { harness: Harness; calls: Call[] } {
  const calls: Call[] = [];
  const harness = {
    prompt(text: string, options: Record<string, unknown>) {
      calls.push({ text, options });
      return respond();
    },
  } as unknown as Harness;
  return { harness, calls };
}

describe('synthesizeOnStrong', () => {
  test('passes the strong model, its thinking level and the report schema to harness.prompt', async () => {
    const { harness, calls } = stubHarness(async () => ({ data: strongReport() }));
    const controller = new AbortController();
    await synthesizeOnStrong(
      harness,
      { draft: draft(), evidence, reasons: ['low_confidence'], signal: controller.signal },
      { config },
    );

    expect(calls).toHaveLength(1);
    const { options } = calls[0]!;
    expect(options.model).toBe('faux/strong');
    expect(options.thinkingLevel).toBe('medium');
    expect(options.result).toBe(ReportDraftSchema);
    expect(options.signal).toBe(controller.signal);
  });

  test('leaves signal out when none is given', async () => {
    const { harness, calls } = stubHarness(async () => ({ data: strongReport() }));
    await synthesizeOnStrong(harness, { draft: draft(), evidence, reasons: ['low_confidence'] }, { config });
    expect(Object.hasOwn(calls[0]!.options, 'signal')).toBe(false);
  });

  test('returns the strong report with escalated=true and the reasons', async () => {
    const { harness } = stubHarness(async () => ({ data: strongReport() }));
    const reasons = ['low_confidence', 'money_moved_non_strong'];
    const out = await synthesizeOnStrong(harness, { draft: draft(), evidence, reasons }, { config });

    expect(out.escalated).toBe(true);
    expect(out.escalation_reasons).toEqual(reasons);
    expect(out.root_cause).toBeNull();
    expect(out.status).toBe('inconclusive');
    expect(out.confidence_reason).toBe('no vendor event in the evidence');
    expect(v.safeParse(ReportDraftSchema, out).success).toBe(true);
  });

  test('keeps request, classification, id chain and images_seen from the draft', async () => {
    const { harness } = stubHarness(async () => ({ data: strongReport() }));
    const d = draft();
    const out = await synthesizeOnStrong(harness, { draft: d, evidence, reasons: ['low_confidence'] }, { config });
    expect(out.request).toEqual(d.request);
    expect(out.classification).toEqual(d.classification);
    expect(out.id_chain).toEqual(d.id_chain);
    expect(out.images_seen).toBe(false);
  });

  test('keeps the draft gaps and adds the strong gaps once each', async () => {
    const { harness } = stubHarness(async () => ({ data: strongReport() }));
    const out = await synthesizeOnStrong(harness, { draft: draft(), evidence, reasons: ['x'] }, { config });
    expect(out.gaps).toEqual(['atspl:package API not configured', 'no vendor callback found']);
  });

  test('the reasons array is copied, not shared with the caller', async () => {
    const { harness } = stubHarness(async () => ({ data: strongReport() }));
    const reasons = ['low_confidence'];
    const out = await synthesizeOnStrong(harness, { draft: draft(), evidence, reasons }, { config });
    reasons.push('later');
    expect(out.escalation_reasons).toEqual(['low_confidence']);
  });

  test('ResultUnavailableError keeps the draft, adds a gap and does not throw', async () => {
    const { harness, calls } = stubHarness(async () => {
      throw new ResultUnavailableError('evidence too thin', 'partial text');
    });
    const d = draft();
    const out = await synthesizeOnStrong(harness, { draft: d, evidence, reasons: ['low_confidence'] }, { config });

    expect(calls).toHaveLength(1);
    expect(out.root_cause).toEqual(d.root_cause);
    expect(out.status).toBe(d.status);
    expect(out.confidence).toBe(d.confidence);
    expect(out.gaps[0]).toBe('atspl:package API not configured');
    expect(out.gaps).toContain(`${SYNTHESIS_FAILED_GAP} (evidence too thin)`);
    expect(out.gaps).toHaveLength(2);
    expect(out.escalated).toBe(true);
    expect(out.escalation_reasons).toEqual(['low_confidence']);
    expect(v.safeParse(ReportDraftSchema, out).success).toBe(true);
  });

  test('ResultUnavailableError with an empty reason still adds the plain gap', async () => {
    const { harness } = stubHarness(async () => {
      throw new ResultUnavailableError('  ', '');
    });
    const out = await synthesizeOnStrong(harness, { draft: draft(), evidence, reasons: ['x'] }, { config });
    expect(out.gaps).toContain(SYNTHESIS_FAILED_GAP);
  });

  test('a long give-up reason is cut in the gap', async () => {
    const { harness } = stubHarness(async () => {
      throw new ResultUnavailableError('r'.repeat(5000), '');
    });
    const out = await synthesizeOnStrong(harness, { draft: draft(), evidence, reasons: ['x'] }, { config });
    const gap = out.gaps.find((g) => g.startsWith(SYNTHESIS_FAILED_GAP))!;
    expect(gap.length).toBeLessThan(SYNTHESIS_FAILED_GAP.length + 210);
  });

  test('any other error is thrown, not hidden', async () => {
    const { harness } = stubHarness(async () => {
      throw new Error('aborted');
    });
    await expect(
      synthesizeOnStrong(harness, { draft: draft(), evidence, reasons: ['x'] }, { config }),
    ).rejects.toThrow('aborted');
  });

  test('a missing strong model is a config error and no prompt is made', async () => {
    const { harness, calls } = stubHarness(async () => ({ data: strongReport() }));
    const bare = configFromRecord({}, '/triage/home');
    await expect(
      synthesizeOnStrong(harness, { draft: draft(), evidence, reasons: ['x'] }, { config: bare }),
    ).rejects.toThrow(/MODEL_TIER_STRONG/);
    expect(calls).toHaveLength(0);
  });
});

describe('synthesisPrompt', () => {
  test('carries the reasons, the evidence and the draft', () => {
    const text = synthesisPrompt({ draft: draft(), evidence, reasons: ['low_confidence', 'conflicting_hypotheses'] });
    expect(text).toContain('low_confidence, conflicting_hypotheses');
    expect(text).toContain('vendor rejected the address');
    expect(text).toContain('Cheap guess');
    expect(text.indexOf('<evidence>')).toBeLessThan(text.indexOf('<draft>'));
  });
});
