import { afterEach, describe, expect, test } from 'bun:test';
import {
  BUDGET_EXHAUSTED_MESSAGE,
  BudgetConfigError,
  type RunBudgetLimits,
  createRunBudget,
  getRunBudget,
  releaseRunBudget,
} from './budget.ts';

const created: string[] = [];

function limits(overrides: Partial<RunBudgetLimits> = {}): RunBudgetLimits {
  const runId = overrides.runId ?? `run-${created.length}-${Math.random().toString(36).slice(2, 8)}`;
  created.push(runId);
  return {
    runId,
    maxToolCalls: 120,
    maxTasks: 12,
    maxRowsPerCall: 200,
    maxBytesPerCall: 1_000,
    maxBytesPerRun: 2_500,
    perEntity: { ssfb: { maxHits: 100 }, atspl: { maxCalls: 3, maxHits: 50 } },
    ...overrides,
  };
}

const refusal = { ok: false, message: BUDGET_EXHAUSTED_MESSAGE };

afterEach(() => {
  for (const id of created.splice(0)) releaseRunBudget(id);
});

describe('tool call cap', () => {
  test('deny: 121st tool call with cap 120 refused; exhausted stays true', () => {
    const b = createRunBudget(limits());
    for (let i = 0; i < 120; i++) expect(b.consumeToolCall('sql_select', 'ssfb')).toEqual({ ok: true });
    expect(b.state().exhausted).toBe(false);

    expect(b.consumeToolCall('sql_select', 'ssfb')).toMatchObject({ ...refusal, reason: 'tool_calls' });
    expect(b.state()).toMatchObject({ calls: 120, exhausted: true, exhaustedReason: 'tool_calls' });

    // Sticky: every later non-exempt call and task is refused too.
    expect(b.consumeToolCall('logs_search', 'atspl')).toMatchObject(refusal);
    expect(b.consumeTask()).toMatchObject(refusal);
    expect(b.accountBytes(10)).toMatchObject(refusal);
    expect(b.state().exhausted).toBe(true);
    expect(b.state().calls).toBe(120);
  });

  test('allow: finish_report and note_evidence after exhaustion', () => {
    const b = createRunBudget(limits({ maxToolCalls: 1 }));
    b.consumeToolCall('sql_select', 'ssfb');
    expect(b.consumeToolCall('sql_select', 'ssfb').ok).toBe(false);
    expect(b.consumeToolCall('finish_report')).toEqual({ ok: true });
    expect(b.consumeToolCall('note_evidence', 'ssfb')).toEqual({ ok: true });
    expect(b.consumeToolCall('note_evidence')).toEqual({ ok: true });
    // Exempt calls are not counted and do not clear exhaustion.
    expect(b.state()).toMatchObject({ calls: 1, exhausted: true });
  });

  test('exempt tools do not use up the budget before exhaustion', () => {
    const b = createRunBudget(limits({ maxToolCalls: 1 }));
    b.consumeToolCall('note_evidence');
    expect(b.consumeToolCall('sql_select')).toEqual({ ok: true });
  });

  test('deny: per-entity maxCalls reached for atspl while ssfb still allowed', () => {
    const b = createRunBudget(limits());
    for (let i = 0; i < 3; i++) expect(b.consumeToolCall('logs_search', 'atspl').ok).toBe(true);
    expect(b.consumeToolCall('logs_search', 'atspl')).toMatchObject({ ...refusal, reason: 'entity_calls' });
    expect(b.consumeToolCall('logs_search', 'ssfb')).toEqual({ ok: true });
    // Calls without an entity (code tools) are not held back either.
    expect(b.consumeToolCall('code_search')).toEqual({ ok: true });
    // An entity cap does not exhaust the run, and a refused call is not counted.
    expect(b.state()).toMatchObject({ calls: 5, exhausted: false, entityCalls: { atspl: 3, ssfb: 1 } });
  });

  test('deny: unknown entity throws', () => {
    const b = createRunBudget(limits());
    expect(() => b.consumeToolCall('sql_select', 'shivalik' as never)).toThrow(RangeError);
  });
});

describe('task cap', () => {
  test('deny: 13th task with cap 12 refused', () => {
    const b = createRunBudget(limits());
    for (let i = 0; i < 12; i++) expect(b.consumeTask()).toEqual({ ok: true });
    expect(b.consumeTask()).toMatchObject({ ...refusal, reason: 'tasks' });
    expect(b.state()).toMatchObject({ tasks: 12, exhausted: true, exhaustedReason: 'tasks' });
    // Sticky across kinds: tool calls are refused as well, finish_report is not.
    expect(b.consumeToolCall('sql_select', 'ssfb').ok).toBe(false);
    expect(b.consumeToolCall('finish_report').ok).toBe(true);
  });
});

describe('bytes', () => {
  test('deny: accountBytes past maxBytesPerRun refused; single response over maxBytesPerCall flagged for truncation', () => {
    const b = createRunBudget(limits());
    expect(b.accountBytes(400)).toEqual({ ok: true, truncate: false, keepBytes: 400 });
    // Over the per-call cap: flagged, and only the kept part counts toward the run.
    expect(b.accountBytes(5_000)).toEqual({ ok: true, truncate: true, keepBytes: 1_000 });
    expect(b.state().bytes).toBe(1_400);
    expect(b.accountBytes(1_000)).toEqual({ ok: true, truncate: false, keepBytes: 1_000 });
    expect(b.accountBytes(101)).toMatchObject({ ...refusal, reason: 'bytes' });
    expect(b.state()).toMatchObject({ bytes: 2_400, exhausted: true, exhaustedReason: 'bytes' });
    expect(b.accountBytes(1)).toMatchObject(refusal);
    expect(b.consumeToolCall('sql_select').ok).toBe(false);
  });

  test('deny: negative or NaN byte count throws', () => {
    const b = createRunBudget(limits());
    expect(() => b.accountBytes(-1)).toThrow(RangeError);
    expect(() => b.accountBytes(Number.NaN)).toThrow(RangeError);
  });
});

describe('clamps', () => {
  test('clampRows never returns more than the cap', () => {
    const b = createRunBudget(limits());
    expect(b.clampRows(10)).toBe(10);
    expect(b.clampRows(200)).toBe(200);
    expect(b.clampRows(201)).toBe(200);
    expect(b.clampRows(Number.MAX_SAFE_INTEGER)).toBe(200);
    expect(b.clampRows()).toBe(200);
    expect(b.clampRows(0)).toBe(0);
    expect(() => b.clampRows(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => b.clampRows(-5)).toThrow(RangeError);
  });

  test('clampHits uses the entity cap and never exceeds it', () => {
    const b = createRunBudget(limits());
    expect(b.clampHits('ssfb', 500)).toBe(100);
    expect(b.clampHits('atspl', 500)).toBe(50);
    expect(b.clampHits('atspl', 20)).toBe(20);
    expect(b.clampHits('ssfb')).toBe(100);
    expect(() => b.clampHits('ssfb', Number.NaN)).toThrow(RangeError);
  });

  test('deny: clampHits for an entity with no configured cap throws', () => {
    const b = createRunBudget(limits());
    expect(() => b.clampHits('rtl', 10)).toThrow(BudgetConfigError);
  });
});

describe('registry', () => {
  test('isolation: run A exhausted, run B unaffected', () => {
    const a = createRunBudget(limits({ runId: 'run-a', maxToolCalls: 2, maxTasks: 1 }));
    const b = createRunBudget(limits({ runId: 'run-b', maxToolCalls: 2, maxTasks: 1 }));
    a.consumeToolCall('sql_select', 'atspl');
    a.consumeToolCall('sql_select', 'atspl');
    expect(a.consumeToolCall('sql_select', 'atspl').ok).toBe(false);
    expect(a.state().exhausted).toBe(true);

    expect(b.state()).toMatchObject({ calls: 0, tasks: 0, bytes: 0, exhausted: false, entityCalls: {} });
    expect(b.consumeToolCall('sql_select', 'atspl')).toEqual({ ok: true });
    expect(b.consumeTask()).toEqual({ ok: true });

    expect(getRunBudget('run-a')).toBe(a);
    expect(getRunBudget('run-b')).toBe(b);
  });

  test('getRunBudget is undefined for an unknown or released run', () => {
    const b = createRunBudget(limits({ runId: 'run-release' }));
    expect(getRunBudget('run-release')).toBe(b);
    expect(releaseRunBudget('run-release')).toBe(true);
    expect(getRunBudget('run-release')).toBeUndefined();
    expect(releaseRunBudget('run-release')).toBe(false);
    expect(getRunBudget('never-created')).toBeUndefined();
  });

  test('deny: a second budget for the same run_id throws and keeps the first', () => {
    const first = createRunBudget(limits({ runId: 'run-dup' }));
    first.consumeTask();
    expect(() => createRunBudget(limits({ runId: 'run-dup' }))).toThrow(BudgetConfigError);
    expect(getRunBudget('run-dup')?.state().tasks).toBe(1);
  });
});

describe('construction', () => {
  test('construction with maxToolCalls 0 or NaN throws', () => {
    expect(() => createRunBudget(limits({ maxToolCalls: 0 }))).toThrow(BudgetConfigError);
    expect(() => createRunBudget(limits({ maxToolCalls: Number.NaN }))).toThrow(BudgetConfigError);
  });

  const bad = [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY];
  const fields = ['maxToolCalls', 'maxTasks', 'maxRowsPerCall', 'maxBytesPerCall', 'maxBytesPerRun'] as const;
  for (const field of fields) {
    test(`invalid ${field} throws`, () => {
      for (const value of bad) {
        expect(() => createRunBudget(limits({ [field]: value }))).toThrow(BudgetConfigError);
      }
    });
  }

  test('invalid per-entity limits throw', () => {
    for (const value of bad) {
      expect(() => createRunBudget(limits({ perEntity: { ssfb: { maxHits: value } } }))).toThrow(BudgetConfigError);
      expect(() => createRunBudget(limits({ perEntity: { ssfb: { maxHits: 10, maxCalls: value } } }))).toThrow(
        BudgetConfigError,
      );
    }
    expect(() => createRunBudget(limits({ perEntity: { shivalik: { maxHits: 10 } } as never }))).toThrow(
      BudgetConfigError,
    );
  });

  test('invalid runId throws', () => {
    expect(() => createRunBudget(limits({ runId: '../escape' }))).toThrow(BudgetConfigError);
    expect(() => createRunBudget(limits({ runId: '' }))).toThrow(BudgetConfigError);
  });

  test('a failed construction does not register the run', () => {
    expect(() => createRunBudget(limits({ runId: 'run-bad', maxTasks: 0 }))).toThrow(BudgetConfigError);
    expect(getRunBudget('run-bad')).toBeUndefined();
  });
});
