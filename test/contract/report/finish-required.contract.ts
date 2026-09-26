// Report-path contract: a run must end in finish_report (T10.6; HLD 02
// §1.1, LLD 04 §2.9, §3; D23).
//
// The scripted root investigates, records evidence through a delegate and
// then stops without calling finish_report. The Triage agent appends one
// triage.finish_required signal; the second stop fails the submission. The
// evidence the delegate wrote stays in the run folder, and no report is
// written. A finish_report that was refused does not count as the finish.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkNoRealIo } from '../../../src/evals/audit-gates.ts';
import { bootEvalRuntime, type CaseResult, evalRuntime, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { brief, evalHome, reportDraft } from '../eval-support.ts';
import { evidenceFiles, findingsFixture, leaks, reportCase, reportFiles, signalsIn, toolResultIn } from './report-support.ts';

const fake = createFakeModel();
const home = evalHome();

beforeAll(async () => {
  await bootEvalRuntime({ faux: fake });
});

afterAll(async () => {
  await stopEvalRuntime();
  home.dispose();
});

function runsDir(): string {
  const dir = evalRuntime()?.config.paths.runsDir;
  if (dir === undefined) throw new Error('the eval runtime is not booted');
  return dir;
}

function rootCalls(result: CaseResult) {
  return result.model_calls.filter((c) => c.caller === 'root');
}

describe('finish_report missing twice', () => {
  let result: CaseResult;

  beforeAll(async () => {
    result = await runCase(reportCase('cheap'), {
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), text('I am done'), text('still done')],
        investigate_ssfb: [toolCall('note_evidence', findingsFixture('medium')), text('recorded')],
      },
    });
  });

  test('the submission fails after exactly one finish_required signal', async () => {
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^AgentRunError: /);
    const calls = rootCalls(result);
    expect(calls).toHaveLength(3);
    // No signal before the first stop, one after it, and no second one before the fail.
    expect(calls.map(signalsIn)).toEqual([0, 0, 1]);
    expect(result.turns_left).toMatchObject({ root: 0, investigate_ssfb: 0 });
    expect(result.faux_failures).toEqual([]);
    expect(result.tool_calls.map((c) => c.name)).not.toContain('finish_report');

    const run = await evalRuntime()?.store.getRun(result.run_id);
    expect(run?.phase).toBe('failed');
    expect(run?.report).toBeNull();
  });

  test('the evidence folder is intact and no report.json exists', async () => {
    const files = evidenceFiles(runsDir(), result.run_id);
    expect(files).toContain('ssfb.json');
    for (const file of files) {
      // Every kept file still parses.
      expect(() => JSON.parse(readFileSync(join(runsDir(), result.run_id, 'evidence', file), 'utf8'))).not.toThrow();
    }
    const latest = JSON.parse(readFileSync(join(runsDir(), result.run_id, 'evidence', 'ssfb.json'), 'utf8'));
    expect(latest).toMatchObject({ confidence: 'medium', hypotheses: ['the contract case has no fault'] });
    const run = await evalRuntime()?.store.getRun(result.run_id);
    expect(run?.evidence.ssfb?.findings).toMatchObject({ confidence: 'medium' });
    expect(reportFiles(runsDir(), result.run_id)).toEqual([]);
    expect(result.report).toBeNull();
  });

  test('every audit line is mock', () => {
    expect(result.audit.map((l) => l.tool)).toContain('note_evidence');
    expect(checkNoRealIo(result.audit)).toEqual({ ok: true, offending: [] });
  });
});

describe('deny path: a refused finish_report is not a finish', () => {
  test('refused, then two stops: one signal, then the submission fails', async () => {
    const tier = reportCase('cheap').expected.tier;
    const cx = reportDraft(tier).cx_answer as Record<string, unknown>;
    const leaky = reportDraft(tier, { cx_answer: { ...cx, reply_text: leaks().phone.reply_text } });

    const result = await runCase(reportCase('cheap'), {
      turns: { root: [finish(leaky), text('I am done'), text('still done')] },
    });

    expect(result.status).toBe('failed');
    const calls = rootCalls(result);
    expect(calls).toHaveLength(3);
    expect(toolResultIn(calls[1], 'finish_report')?.text).toContain('"status":"refused"');
    expect(calls.map(signalsIn)).toEqual([0, 0, 1]);
    expect(reportFiles(runsDir(), result.run_id)).toEqual([]);
    expect(checkNoRealIo(result.audit).ok).toBe(true);
  });

  test('control: a stop, the signal, then finish_report completes the submission', async () => {
    const c = reportCase('cheap');
    const result = await runCase(c, {
      turns: { root: [text('I am done'), finish(reportDraft(c.expected.tier)), text('report written')] },
    });

    expect(result.status).toBe('completed');
    expect(rootCalls(result).map(signalsIn)).toEqual([0, 1, 1]);
    expect(reportFiles(runsDir(), result.run_id)).toEqual(['report.json', 'submissions/1/report.json']);
    expect(checkNoRealIo(result.audit).ok).toBe(true);
  });
});
