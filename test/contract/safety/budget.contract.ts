// Safety contract: run budgets through runCase (T10.5; HLD 02 §3 budget.ts,
// D2, D26, LLD 04 §3 'Budget exhausted').
//
// The case file carries the budget keys the eval runtime boots with:
// TRIAGE_MAX_TOOL_CALLS_PER_RUN=3 and TRIAGE_MAX_TASKS_PER_RUN=12.
//
// - Tool calls: the ATSPL investigator makes three I/O calls (the eval home
//   answers them 'not configured', which still costs a call), and the fourth
//   and fifth are refused with the fixed budget message. note_evidence and
//   finish_report are exempt, so the run still writes its report, and the
//   spent budget escalates the cheap run (budget_exhausted_no_root_cause).
// - Tasks: the root delegates thirteen times. The tripwire charges each
//   task_start to consumeTask, so the thirteenth is refused before it reaches
//   the delegate, and finish_report still succeeds.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bootEvalRuntime, type CaseResult, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { BUDGET_EXHAUSTED_MESSAGE, getRunBudget } from '../../../src/gate/budget.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { evalHome, findings, reportDraft } from '../eval-support.ts';
import {
  atsplBrief,
  expectFinished,
  expectNoRealIo,
  outputOf,
  safetyCase,
  spyOnIo,
  toolResults,
} from './safety-support.ts';

const fake = createFakeModel();
const home = evalHome();
const io = spyOnIo();
const { case: budgetCase, env } = safetyCase('budget-small-cap');
const MAX_CALLS = Number(env.TRIAGE_MAX_TOOL_CALLS_PER_RUN);
const MAX_TASKS = Number(env.TRIAGE_MAX_TASKS_PER_RUN);

const COUNT_SQL = { service: 'package', sql: 'SELECT count(*) AS n FROM delivery_requests' };
const LOGS = { service: 'package', message: 'welcome letter dispatch failed' };
const HTTP = { service: 'package', path: '/admin/v1/deliveries' };

// Three calls within the cap, then two past it. Every one is id-free, so only the budget can refuse the last two.
const CALLS = [
  { name: 'sql_select', args: COUNT_SQL },
  { name: 'http_call', args: HTTP },
  { name: 'logs_search', args: LOGS },
  { name: 'sql_select', args: COUNT_SQL },
  { name: 'logs_search', args: LOGS },
] as const;

// The spent budget escalates a cheap run, so finish_report runs the strong synthesis once.
const synthesisTurn = () => toolCall('finish', reportDraft('strong'));

let calls: CaseResult;
let tasks: CaseResult;

beforeAll(async () => {
  await bootEvalRuntime({ faux: fake, overrides: env });

  calls = await runCase(budgetCase, {
    turns: {
      root: [
        toolCall('task', { agent: 'investigate_atspl', prompt: atsplBrief() }),
        finish(reportDraft(budgetCase.expected.tier)),
        text('report written'),
      ],
      investigate_atspl: [
        ...CALLS.map((c) => toolCall(c.name, c.args)),
        toolCall('note_evidence', { ...findings('medium'), gaps: ['tool budget ran out'] }),
        text('budget ran out; partial findings recorded'),
      ],
      synthesis: [synthesisTurn()],
    },
  });

  tasks = await runCase(budgetCase, {
    turns: {
      root: [
        ...Array.from({ length: MAX_TASKS + 1 }, (_, i) =>
          toolCall('task', { agent: 'investigate_atspl', prompt: atsplBrief(`Attempt: ${i + 1}`) }),
        ),
        finish(reportDraft(budgetCase.expected.tier)),
        text('report written'),
      ],
      investigate_atspl: Array.from({ length: MAX_TASKS }, (_, i) => text(`answer ${i + 1}`)),
      synthesis: [synthesisTurn()],
    },
  });
});

afterAll(async () => {
  io.restore();
  await stopEvalRuntime();
  home.dispose();
});

describe('tool-call cap', () => {
  test('the case sets a small cap', () => {
    expect(MAX_CALLS).toBe(3);
  });

  test(`calls 1 to ${MAX_CALLS} are charged, and every call after that is refused with the fixed message`, () => {
    const outputs = CALLS.map((c, i) => {
      const seen = toolResults(calls, 'investigate_atspl', c.name);
      const nth = CALLS.slice(0, i).filter((p) => p.name === c.name).length;
      return outputOf(seen[nth]);
    });
    for (const out of outputs.slice(0, MAX_CALLS)) expect(out?.status).toBe('not_configured');
    for (const out of outputs.slice(MAX_CALLS)) {
      expect(out?.status).toBe('refused');
      expect(out?.message).toBe(BUDGET_EXHAUSTED_MESSAGE);
    }
  });

  test('the refusals are audited as budget denies', () => {
    const ioLines = calls.audit.filter((l) => ['sql_select', 'http_call', 'logs_search'].includes(l.tool));
    expect(ioLines).toHaveLength(CALLS.length);
    expect(ioLines.slice(0, MAX_CALLS).map((l) => l.exit)).toEqual(['not_configured', 'not_configured', 'not_configured']);
    for (const line of ioLines.slice(MAX_CALLS)) {
      expect(line).toMatchObject({ decision: 'deny', exit: 'refused', reason: 'budget: tool_calls', transport: 'mock' });
    }
    expect(getRunBudget(calls.run_id)?.state()).toMatchObject({ calls: MAX_CALLS, exhausted: true, exhaustedReason: 'tool_calls' });
  });

  test('note_evidence and finish_report are not blocked by the spent budget', () => {
    expectFinished(calls);
    const note = toolResults(calls, 'investigate_atspl', 'note_evidence')[0];
    expect(outputOf(note)?.status).toBe('ok');
    const finished = outputOf(toolResults(calls, 'root', 'finish_report')[0]);
    expect(finished?.status).toBe('ok');
  });

  test('escalation records budget_exhausted', () => {
    expect(calls.report?.escalated).toBe(true);
    expect(calls.report?.escalation_reasons).toContain('budget_exhausted_no_root_cause');
    expect(calls.model_calls.filter((c) => c.caller === 'synthesis')).toHaveLength(1);
  });

  test('passes checkNoRealIo', () => {
    expectNoRealIo(calls);
  });
});

describe('task cap', () => {
  test(`the case keeps TRIAGE_MAX_TASKS_PER_RUN at ${MAX_TASKS}`, () => {
    expect(MAX_TASKS).toBe(12);
  });

  test(`delegation ${MAX_TASKS + 1} is refused by the tripwire and never reaches the delegate`, () => {
    expect(tasks.tool_calls.filter((c) => c.name === 'task')).toHaveLength(MAX_TASKS + 1);
    expect(tasks.model_calls.filter((c) => c.caller === 'investigate_atspl')).toHaveLength(MAX_TASKS);
    const seen = toolResults(tasks, 'root', 'task');
    expect(seen).toHaveLength(MAX_TASKS + 1);
    for (const r of seen.slice(0, MAX_TASKS)) expect(r.isError).toBe(false);
    const last = seen[MAX_TASKS];
    expect(last?.isError).toBe(true);
    expect(last?.text).toContain(BUDGET_EXHAUSTED_MESSAGE);
  });

  test('the refusal is one tripwire deny line, charged through consumeTask', () => {
    const deny = tasks.audit.filter((l) => l.service === 'tripwire');
    expect(deny).toHaveLength(1);
    expect(deny[0]).toMatchObject({
      tool: 'task',
      decision: 'deny',
      exit: 'refused',
      target: 'TRIAGE_MAX_TASKS_PER_RUN',
      reason: 'run budget exhausted: tasks',
      transport: 'mock',
    });
    expect(getRunBudget(tasks.run_id)?.state()).toMatchObject({ tasks: MAX_TASKS, exhausted: true, exhaustedReason: 'tasks' });
  });

  test('finish_report still succeeds and the spent budget escalates', () => {
    expectFinished(tasks);
    expect(outputOf(toolResults(tasks, 'root', 'finish_report')[0])?.status).toBe('ok');
    expect(tasks.report?.escalation_reasons).toContain('budget_exhausted_no_root_cause');
  });

  test('passes checkNoRealIo', () => {
    expectNoRealIo(tasks);
  });
});

test('no network request and no subprocess were made', () => {
  expect(io.counts()).toEqual({ fetch: 0, http: 0, https: 0, spawn: 0 });
});
