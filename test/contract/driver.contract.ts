// Eval driver contract (T10.4; D42, D43; P1 §3.2, §3.6).
//
// bootEvalRuntime refuses a home that is not an eval home before it starts
// anything, a second boot reuses the running Flue, and runCase takes one
// synthetic case through runSubmission to a written report with the fake
// model, strict mock mode and no network.

import type { Flue, StartOptions } from '@flue/runtime/node';
import { start as flueStart } from '@flue/runtime/node';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkNoRealIo } from '../../src/evals/audit-gates.ts';
import { loadCases } from '../../src/evals/case-schema.ts';
import {
  bootEvalRuntime,
  evalRuntime,
  EvalRuntimeNotBootedError,
  runCase,
  stopEvalRuntime,
} from '../../src/evals/driver.ts';
import { EvalHomeError } from '../../src/evals/home.ts';
import { createFakeModel, type FakeModel, finish, text, toolCall } from '../../src/mock/fake-model.ts';
import { flushRunEventLog } from '../../src/runlog/event-log.ts';
import { readRunEvents } from '../../src/runlog/read.ts';
import { ReportSchema } from '../../src/types/report.ts';
import { REPO_ROOT } from '../support/home.ts';
import { brief, evalHome, findings, reportDraft } from './eval-support.ts';

// Counts what boot does, so a refusal can be shown to start and install nothing.
const counts = { installs: 0, starts: 0 };
const startOptions: StartOptions[] = [];
const base = createFakeModel();
const fake: FakeModel = {
  ...base,
  install() {
    counts.installs += 1;
    base.install();
  },
};
const startSpy = (options: StartOptions): Promise<Flue> => {
  counts.starts += 1;
  startOptions.push(options);
  return flueStart(options);
};
const home = evalHome();

afterAll(async () => {
  await stopEvalRuntime();
  home.dispose();
});

describe('before boot', () => {
  test('runCase refuses to run without a booted runtime', async () => {
    const [loaded] = await loadCases(join(REPO_ROOT, 'evals/cases'));
    await expect(runCase(loaded!.case)).rejects.toBeInstanceOf(EvalRuntimeNotBootedError);
  });

  test('a credential in the home makes boot refuse, and no Flue runtime is started', async () => {
    const refused = bootEvalRuntime({ faux: fake, overrides: { SSFB_HARBOR_DB_URL: 'set-in-contract-test' }, start: startSpy });
    await expect(refused).rejects.toBeInstanceOf(EvalHomeError);
    await expect(refused).rejects.toThrow(/SSFB_HARBOR_DB_URL/);
    await expect(refused).rejects.not.toThrow(/set-in-contract-test/);
    expect(counts).toEqual({ installs: 0, starts: 0 });
    expect(evalRuntime()).toBeUndefined();
  });

  test('a non-virtual sandbox makes boot refuse too', async () => {
    const refused = bootEvalRuntime({ faux: fake, overrides: { TRIAGE_SANDBOX_PROVIDER: 'e2b' }, start: startSpy });
    await expect(refused).rejects.toBeInstanceOf(EvalHomeError);
    expect(counts).toEqual({ installs: 0, starts: 0 });
  });
});

describe('boot', () => {
  test('a second boot reuses the running Flue instead of throwing', async () => {
    const first = await bootEvalRuntime({ faux: fake, start: startSpy });
    const second = await bootEvalRuntime({ faux: fake, start: startSpy });
    expect(second.flue).toBe(first.flue);
    expect(counts.starts).toBe(1);
    // Flue was started with no env, so no provider key is read from the shell.
    expect(startOptions[0]?.env).toEqual({});
    expect(counts.installs).toBe(2);
    // The eval flags and fake models are in force.
    expect(second.config.mock).toMatchObject({ enabled: true, strict: true, record: false });
    expect(second.config.models.tierMid).toBe('faux/mid');
  });

  test('a later boot with a bad home still refuses while Flue is running', async () => {
    const refused = bootEvalRuntime({ faux: fake, overrides: { SLACK_BOT_TOKEN: 'set-in-contract-test' } });
    await expect(refused).rejects.toBeInstanceOf(EvalHomeError);
    expect(counts).toEqual({ installs: 2, starts: 1 });
    // The runtime from the good boot is still the one in use.
    expect(evalRuntime()?.config.mock.enabled).toBe(true);
  });
});

describe('runCase', () => {
  let result: Awaited<ReturnType<typeof runCase>>;

  beforeAll(async () => {
    await bootEvalRuntime({ faux: fake, start: startSpy });
    const cases = await loadCases(join(REPO_ROOT, 'evals/cases'));
    const loaded = cases.find((c) => c.case.id === 'syn-strong-category');
    if (loaded === undefined) throw new Error('syn-strong-category is missing');
    const c = loaded.case;
    result = await runCase(c, {
      caseDir: loaded.dir,
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(reportDraft(c.expected.tier)), text('report written')],
        investigate_ssfb: [toolCall('note_evidence', findings('medium')), text('recorded')],
      },
    });
  });

  test('returns the documented shape', () => {
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['run_id', 'report', 'tool_calls', 'audit', 'fixture_misses', 'cost_usd', 'wall_ms']),
    );
    expect(result.status).toBe('completed');
    expect(typeof result.run_id).toBe('string');
    expect(result.wall_ms).toBeGreaterThanOrEqual(0);
  });

  test('the report validates, and the stored classification is the policy result', async () => {
    expect(v.is(ReportSchema, result.report)).toBe(true);
    expect(result.report?.run_id).toBe(result.run_id);
    const run = await evalRuntime()?.store.getRun(result.run_id);
    expect(run?.classification?.decision).toMatchObject({ tier_final: 'strong', rule_fired: 'rule_2_high_risk_category' });
    expect(run?.phase).toBe('completed');
  });

  test('tool calls come from the root stream', () => {
    expect(result.tool_calls.map((c) => c.name)).toEqual(['task', 'finish_report']);
    expect(result.tool_calls[0]?.input).toMatchObject({ agent: 'investigate_ssfb' });
  });

  test('every audit line is mock, with no fixture misses and no spend', () => {
    expect(result.audit.length).toBeGreaterThan(0);
    expect(result.audit.every((l) => l.run_id === result.run_id)).toBe(true);
    expect(result.audit.map((l) => l.tool)).toContain('note_evidence');
    expect(checkNoRealIo(result.audit)).toEqual({ ok: true, offending: [] });
    expect(result.fixture_misses).toBe(0);
    expect(result.cost_usd).toBe(0);
  });

  test('the run event log has the pipeline steps and the Flue events of the root and the delegate', async () => {
    await flushRunEventLog();
    const runsDir = evalRuntime()?.config.paths.runsDir;
    if (runsDir === undefined) throw new Error('no eval runtime');
    const page = await readRunEvents(runsDir, result.run_id, { limit: 5000 });
    const seen = new Set(page.events.map((e) => `${e.source}:${e.type}`));
    for (const t of ['run_created', 'phase', 'identity', 'classifier', 'classification', 'dispatch', 'settled']) expect(seen).toContain(`pipeline:${t}`);
    for (const t of ['submission_running', 'turn_request', 'turn', 'message_end', 'tool_start', 'tool', 'task_start', 'task', 'submission_settled']) {
      expect(seen).toContain(`flue:${t}`);
    }
    // Deltas are dropped.
    expect([...seen].some((t) => t.endsWith('_delta'))).toBe(false);
    // The delegate's tool call is there with its name and result.
    const notes = page.events.filter((e) => e.type === 'tool' && (e.data as { toolName?: string }).toolName === 'note_evidence');
    expect(notes.length).toBeGreaterThan(0);
    // The system prompt is written in full once per session, not on every turn.
    const prompts = page.events.filter((e) => e.type === 'turn_request' && (e.data as any).request?.input?.systemPrompt !== undefined);
    const turns = page.events.filter((e) => e.type === 'turn_request');
    expect(prompts.length).toBeLessThan(turns.length);
    const settled = page.events.find((e) => e.type === 'settled');
    expect(settled?.data).toMatchObject({ status: 'completed' });
  });

  test('the classifier, the root and the delegate all drew from the script', () => {
    const callers = result.model_calls.map((c) => c.caller);
    expect(callers[0]).toBe('classifier');
    expect(callers.filter((c) => c === 'root')).toHaveLength(3);
    expect(callers.filter((c) => c === 'investigate_ssfb')).toHaveLength(2);
    expect(result.turns_left).toEqual({ classifier: 0, root: 0, investigate_ssfb: 0 });
    expect(result.faux_failures).toEqual([]);
    expect(fake.failures()).toEqual([]);
  });
});

describe('runCase with the identity step on fixtures', () => {
  test('a strict miss in the identity step is counted, and the run goes on without a chain', async () => {
    await bootEvalRuntime({ faux: fake, start: startSpy });
    const cases = await loadCases(join(REPO_ROOT, 'evals/cases'));
    const loaded = cases.find((c) => c.case.id === 'syn-strong-category');
    if (loaded === undefined) throw new Error('syn-strong-category is missing');

    // No resolve_identity fixture exists for this case, and the root has no turns.
    const result = await runCase(loaded.case, { identity: 'fixtures', turns: { root: [] } });

    expect(result.fixture_misses).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.report).toBeNull();
    expect(checkNoRealIo(result.audit).ok).toBe(true);
    const run = await evalRuntime()?.store.getRun(result.run_id);
    expect(run?.classification?.id_chain.ids).toEqual({});
    expect(run?.classification?.preflight_warnings?.map((w) => w.step)).toContain('identity');
  });
});

describe('runCase with a run id that holds six digits in a row', () => {
  test('the report comes back with the real run id and validates, although the stored copy masks it', async () => {
    await bootEvalRuntime({ faux: fake, start: startSpy });
    const cases = await loadCases(join(REPO_ROOT, 'evals/cases'));
    const loaded = cases.find((c) => c.case.id === 'syn-strong-category');
    if (loaded === undefined) throw new Error('syn-strong-category is missing');
    const c = loaded.case;

    // Synthetic ULID. The persisted profile masks '386475' (digits6) in the stored report.json.
    const runId = '01M386475GGQXX3EXBJPNGKW78';
    const result = await runCase(c, {
      caseDir: loaded.dir,
      runId,
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(reportDraft(c.expected.tier)), text('report written')],
        investigate_ssfb: [toolCall('note_evidence', findings('medium')), text('recorded')],
      },
    });

    expect(result.status).toBe('completed');
    const stored = await evalRuntime()?.store.getRun(runId);
    expect(stored?.report?.run_id).not.toBe(runId);
    expect(result.report?.run_id).toBe(runId);
    expect(v.is(ReportSchema, result.report)).toBe(true);
  });
});
