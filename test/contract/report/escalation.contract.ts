// Report-path contract: escalation to the strong synthesis (T10.6; HLD 02
// §4.3, LLD 04 §2.8; D23).
//
// Each case runs through runCase (the real submission pipeline) with the
// fake model and strict mock mode:
// - a cheap run where the investigator's note_evidence says confidence low;
// - a cheap run where ssfb and rtl each blame themselves;
// - a strong run with money_moved, which must not escalate on that trigger.
// When escalation fires on a non-strong run, finish_report runs one
// harness.prompt() on MODEL_TIER_STRONG (faux/strong here). The synthesis
// turn is drawn from its own faux queue, so the test can see it was used.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkNoRealIo } from '../../../src/evals/audit-gates.ts';
import { bootEvalRuntime, type CaseResult, evalRuntime, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { brief, evalHome, reportDraft } from '../eval-support.ts';
import { findingsFixture, reportCase, toolResultIn } from './report-support.ts';

const fake = createFakeModel();
const home = evalHome();
const STRONG_REASON = 'rebuilt by the strong synthesis from the escalated evidence';

beforeAll(async () => {
  await bootEvalRuntime({ faux: fake });
});

afterAll(async () => {
  await stopEvalRuntime();
  home.dispose();
});

/** The synthesis turn: the strong model returns the draft with its own confidence reason. */
function strongTurn(draft: Record<string, unknown>) {
  return toolCall('finish', { ...draft, confidence: 'low', confidence_reason: STRONG_REASON });
}

function expectStrongSynthesis(result: CaseResult): void {
  const synthesis = result.model_calls.filter((c) => c.caller === 'synthesis');
  expect(synthesis).toHaveLength(1);
  expect(synthesis[0]?.model).toBe('strong');
  expect(evalRuntime()?.config.models.tierStrong).toBe('faux/strong');
  // The run itself stays cheap; only the synthesis call is strong.
  expect(result.model_calls.filter((c) => c.caller === 'root').every((c) => c.model === 'cheap')).toBe(true);
  // The synthesis runs inside finish_report, after the delegates recorded their findings.
  const callers = result.model_calls.map((c) => c.caller);
  const lastDelegate = Math.max(...callers.map((c, i) => (c.startsWith('investigate_') ? i : -1)));
  expect(callers.indexOf('synthesis')).toBeGreaterThan(lastDelegate);
  expect(result.turns_left).toMatchObject({ synthesis: 0 });
}

function expectClean(result: CaseResult): void {
  expect(result.status).toBe('completed');
  expect(result.faux_failures).toEqual([]);
  expect(result.fixture_misses).toBe(0);
  expect(checkNoRealIo(result.audit)).toEqual({ ok: true, offending: [] });
}

describe('escalation on a cheap run', () => {
  test('low confidence: the strong synthesis turn is used and the report is escalated with low_confidence', async () => {
    const c = reportCase('cheap');
    const draft = reportDraft(c.expected.tier);
    const result = await runCase(c, {
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(draft), text('report written')],
        investigate_ssfb: [toolCall('note_evidence', findingsFixture('low')), text('recorded, low confidence')],
        synthesis: [strongTurn(draft)],
      },
    });

    expectClean(result);
    expectStrongSynthesis(result);
    expect(result.report).toMatchObject({
      escalated: true,
      escalation_reasons: ['low_confidence'],
      confidence_reason: STRONG_REASON,
    });
    // The pinned facts come from the draft, not the synthesis.
    expect(result.report?.classification.tier_final).toBe('cheap');
    // The tool told the root it was escalated.
    const written = toolResultIn(result.model_calls.filter((c) => c.caller === 'root').at(-1), 'finish_report');
    expect(written?.text).toContain('"escalated":true');
    expect(written?.text).toContain('low_confidence');
  });

  test('conflicting hypotheses across ssfb and rtl: the strong synthesis turn is used', async () => {
    const c = reportCase('cheap');
    const draft = reportDraft(c.expected.tier);
    const result = await runCase(c, {
      turns: {
        root: [
          toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }),
          toolCall('task', { agent: 'investigate_rtl', prompt: brief('rtl') }),
          finish(draft),
          text('report written'),
        ],
        investigate_ssfb: [toolCall('note_evidence', findingsFixture('ssfb_blames_itself')), text('recorded')],
        investigate_rtl: [toolCall('note_evidence', findingsFixture('rtl_blames_itself')), text('recorded')],
        synthesis: [strongTurn(draft)],
      },
    });

    expectClean(result);
    expectStrongSynthesis(result);
    expect(result.report).toMatchObject({ escalated: true, escalation_reasons: ['conflicting_hypotheses'] });
    // The synthesis was given both entities' findings and the reason.
    const prompt = result.model_calls.find((c) => c.caller === 'synthesis')?.userTexts.join('\n') ?? '';
    expect(prompt).toContain('Escalation reasons: conflicting_hypotheses.');
    expect(prompt).toContain('ssfb onboarding job is stuck in a retry loop');
    expect(prompt).toContain('rtl kyc callback timed out');
  });

  test('control: agreeing medium findings on a cheap run do not escalate', async () => {
    const c = reportCase('cheap');
    const result = await runCase(c, {
      turns: {
        root: [
          toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }),
          finish(reportDraft(c.expected.tier)),
          text('report written'),
        ],
        investigate_ssfb: [toolCall('note_evidence', findingsFixture('medium')), text('recorded')],
      },
    });

    expectClean(result);
    expect(result.model_calls.some((c) => c.caller === 'synthesis' || c.model === 'strong')).toBe(false);
    expect(result.report).toMatchObject({ escalated: false, escalation_reasons: [] });
  });
});

describe('a strong run with money_moved', () => {
  test('does not escalate on money_moved and never calls the synthesis', async () => {
    const c = reportCase('strong-money-moved');
    const result = await runCase(c, {
      turns: {
        root: [
          toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }),
          finish(reportDraft(c.expected.tier)),
          text('report written'),
        ],
        investigate_ssfb: [toolCall('note_evidence', findingsFixture('medium')), text('recorded')],
      },
    });

    expectClean(result);
    const run = await evalRuntime()?.store.getRun(result.run_id);
    expect(run?.classification?.decision).toMatchObject({ tier_final: 'strong', proposed: { money_moved: true } });
    // The whole run is on the strong tier, and no synthesis call was made.
    expect(result.model_calls.filter((c) => c.caller === 'root').every((c) => c.model === 'strong')).toBe(true);
    expect(result.model_calls.some((c) => c.caller === 'synthesis')).toBe(false);
    expect(result.report).toMatchObject({ escalated: false, escalation_reasons: [] });
    expect(result.report?.escalation_reasons).not.toContain('money_moved_non_strong');
  });
});
