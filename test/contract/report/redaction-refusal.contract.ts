// Report-path contract: the egress check refuses an unmasked report (T10.6;
// HLD 02 §6, LLD 04 §2.9, §3; D24, D35).
//
// The scripted root first calls finish_report with a draft that still holds
// synthetic personal data, then, after the refusal, calls it again with the
// clean draft. The refusal must name the pattern and never the value, and no
// report.json may exist until the passing call. The check on the run folder
// happens inside the root's retry turn, which is the moment between the
// refusal and the retry.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkNoRealIo } from '../../../src/evals/audit-gates.ts';
import { bootEvalRuntime, type CaseResult, evalRuntime, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { newRunId } from '../../../src/ingress/ulid.ts';
import { createFakeModel, finish, text } from '../../../src/mock/fake-model.ts';
import { evalHome, reportDraft } from '../eval-support.ts';
import { leaks, reportCase, reportFiles, toolResultIn } from './report-support.ts';

const fake = createFakeModel();
const home = evalHome();
const LEAKS = leaks();

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

type Scenario = {
  readonly leaky: Record<string, unknown>;
  readonly clean: Record<string, unknown>;
};

type Outcome = {
  readonly result: CaseResult;
  /** report.json files that existed when the root got the refusal back. */
  readonly filesAtRetry: readonly string[];
};

/** Runs refuse-then-retry on the cheap case and records the run folder at the retry turn. */
async function refuseThenRetry(s: Scenario): Promise<Outcome> {
  const runId = newRunId();
  let filesAtRetry: string[] | undefined;
  const retry = (): AssistantMessage => {
    filesAtRetry = reportFiles(runsDir(), runId);
    return finish(s.clean);
  };
  const result = await runCase(reportCase('cheap'), {
    runId,
    turns: { root: [finish(s.leaky), retry, text('report written')] },
  });
  if (filesAtRetry === undefined) throw new Error('the root never reached its retry turn');
  return { result, filesAtRetry };
}

/** The finish_report result the root saw after its first call. */
function refusalText(result: CaseResult): string {
  const roots = result.model_calls.filter((c) => c.caller === 'root');
  const refusal = toolResultIn(roots[1], 'finish_report');
  expect(refusal?.isError).toBe(false);
  expect(refusal?.text).toContain('"status":"refused"');
  return refusal?.text ?? '';
}

function expectWrittenOnRetry(o: Outcome): void {
  const { result } = o;
  expect(result.status).toBe('completed');
  expect(result.faux_failures).toEqual([]);
  expect(result.turns_left).toMatchObject({ root: 0 });
  // Nothing was written by the refused call.
  expect(o.filesAtRetry).toEqual([]);
  // The passing call wrote both copies.
  expect(reportFiles(runsDir(), result.run_id)).toEqual(['report.json', 'submissions/1/report.json']);
  expect(result.tool_calls.filter((c) => c.name === 'finish_report')).toHaveLength(2);
  expect(checkNoRealIo(result.audit)).toEqual({ ok: true, offending: [] });
}

/** The value appears nowhere the run wrote down: report, audit lines, refusal. */
function expectValueAbsent(result: CaseResult, values: readonly string[]): void {
  const report = readFileSync(join(runsDir(), result.run_id, 'report.json'), 'utf8');
  const audit = JSON.stringify(result.audit);
  const refusal = refusalText(result);
  for (const value of values) {
    expect(report).not.toContain(value);
    expect(audit).not.toContain(value);
    expect(refusal).not.toContain(value);
  }
}

function finishAudit(result: CaseResult) {
  return result.audit.filter((l) => l.tool === 'finish_report');
}

describe('an unmasked value in the draft', () => {
  test('a phone in cx_answer.reply_text: refused with "phone", nothing written, the retry passes', async () => {
    const tier = reportCase('cheap').expected.tier;
    const clean = reportDraft(tier);
    const cx = clean.cx_answer as Record<string, unknown>;
    const leaky = reportDraft(tier, { cx_answer: { ...cx, reply_text: LEAKS.phone.reply_text } });

    const o = await refuseThenRetry({ leaky, clean });

    expectWrittenOnRetry(o);
    const refusal = refusalText(o.result);
    expect(refusal).toContain(`unmasked data: ${LEAKS.phone.pattern}.`);
    expect(refusal).toContain('cx_answer.reply_text');
    expectValueAbsent(o.result, [LEAKS.phone.value, '98765', '43210']);
    expect(finishAudit(o.result).map((l) => [l.decision, l.exit])).toEqual([
      ['deny', 'refused'],
      ['allow', 'ok'],
    ]);
    expect(finishAudit(o.result)[0]?.reason).toBe(`unmasked: ${LEAKS.phone.pattern}`);
    expect(o.result.report?.cx_answer.reply_text).toBe(cx.reply_text);
  });

  test('a base64-encoded email in suggested_fix.command: refused with "email", the retry passes', async () => {
    const tier = reportCase('cheap').expected.tier;
    const clean = reportDraft(tier);
    const fixes = clean.suggested_fix as Record<string, unknown>[];
    const leaky = reportDraft(tier, {
      suggested_fix: [{ ...fixes[0], command: LEAKS.base64_email.command }, ...fixes.slice(1)],
    });

    const o = await refuseThenRetry({ leaky, clean });

    expectWrittenOnRetry(o);
    const refusal = refusalText(o.result);
    expect(refusal).toContain(`unmasked data: ${LEAKS.base64_email.pattern}.`);
    expect(refusal).toContain('suggested_fix');
    expectValueAbsent(o.result, [LEAKS.base64_email.value, LEAKS.base64_email.decoded]);
    expect(finishAudit(o.result)[0]).toMatchObject({ decision: 'deny', reason: `unmasked: ${LEAKS.base64_email.pattern}` });
    expect(o.result.report?.suggested_fix[0]?.command).toBe(fixes[0]?.command);
  });
});

describe('deny path: a leak that is never fixed', () => {
  test('the same leak twice is refused twice and no report.json is ever written', async () => {
    const tier = reportCase('cheap').expected.tier;
    const cx = reportDraft(tier).cx_answer as Record<string, unknown>;
    const leaky = reportDraft(tier, { cx_answer: { ...cx, reply_text: LEAKS.phone.reply_text } });
    const runId = newRunId();

    const result = await runCase(reportCase('cheap'), {
      runId,
      turns: { root: [finish(leaky), finish(leaky), text('I am done'), text('still done')] },
    });

    expect(result.status).toBe('failed');
    expect(result.report).toBeNull();
    expect(reportFiles(runsDir(), runId)).toEqual([]);
    expect(finishAudit(result).map((l) => l.decision)).toEqual(['deny', 'deny']);
    expect(JSON.stringify(result.audit)).not.toContain('98765');
    expect(checkNoRealIo(result.audit).ok).toBe(true);
  });
});
