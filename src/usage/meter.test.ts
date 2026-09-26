import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import type { StartOptions } from '@flue/runtime/node';
import * as v from 'valibot';
import { bootRuntime, resetRuntimeForTests } from '../ingress/runtime.ts';
import { UsageRowSchema } from '../types/usage.ts';
import {
  droppedUsageEvents,
  dropIntake,
  dropSubmission,
  installUsageMeter,
  recordUsage,
  resetUsageMeterForTests,
  runUsageInMemory,
  snapshotIntake,
  snapshotSubmission,
  takeUnassigned,
  usageMeterInstalled,
  usageVersion,
} from './meter.ts';
import { priceUsage } from './price.ts';

const RUN = 'run_meter_1';
const OTHER = 'run_meter_2';
const SUB = 'sub_01AAAAAAAAAAAAAAAAAAAAAAAA';
const SUB2 = 'sub_01BBBBBBBBBBBBBBBBBBBBBBBB';
const HAIKU = 'anthropic/claude-haiku-4-5-20251001';

type Subscriber = (o: FlueObservation, ctx: FlueEventContext) => void;

// Another test file's bootRuntime() may have installed the meter on Flue's own observe().
beforeEach(() => resetUsageMeterForTests());
afterEach(() => {
  resetUsageMeterForTests();
  resetRuntimeForTests();
});

function setup(): { emit: (event: Record<string, unknown>, ctxId?: string) => void; subscribers: Subscriber[] } {
  const subscribers: Subscriber[] = [];
  installUsageMeter({
    observe: (s) => {
      subscribers.push(s);
      return () => subscribers.splice(subscribers.indexOf(s), 1);
    },
  });
  const emit = (event: Record<string, unknown>, ctxId = RUN) => {
    for (const s of subscribers) s({ v: 3, eventIndex: 0, timestamp: '2026-09-26T10:00:00.000Z', ...event } as never, { id: ctxId } as never);
  };
  return { emit, subscribers };
}

type TurnOptions = {
  readonly model?: string;
  readonly usage?: Record<string, unknown>;
  readonly purpose?: string;
  readonly isError?: boolean;
  readonly envelope?: Record<string, unknown>;
};

/** A turn event on the root session of RUN/SUB, as Flue delivers it. */
function turn(o: TurnOptions = {}): Record<string, unknown> {
  const [providerId, requestedModel] = (o.model ?? 'faux/cheap').split(/\/(.*)/s);
  return {
    type: 'turn',
    instanceId: RUN,
    submissionId: SUB,
    agentName: 'triage',
    harness: 'default',
    session: 'default',
    operationId: 'op_root',
    turnId: 'turn_1',
    purpose: o.purpose ?? 'agent',
    durationMs: 5,
    request: { providerId, providerName: providerId, requestedModel, api: 'faux' },
    response: { usage: o.usage ?? { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: {} } },
    isError: o.isError ?? false,
    ...o.envelope,
  };
}

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 99 },
});

const opStart = (operationId: string, extra: Record<string, unknown> = {}) => ({
  type: 'operation_start',
  instanceId: RUN,
  submissionId: SUB,
  session: 'default',
  harness: 'default',
  operationId,
  operationKind: 'prompt',
  ...extra,
});
const opEnd = (operationId: string, extra: Record<string, unknown> = {}) => ({
  type: 'operation',
  instanceId: RUN,
  submissionId: SUB,
  session: 'default',
  operationId,
  operationKind: 'prompt',
  durationMs: 1,
  isError: false,
  usage: usage(1000, 1000),
  ...extra,
});

describe('turns', () => {
  test('input, output and cache tokens are counted per model, agent and purpose', () => {
    const { emit } = setup();
    emit(turn({ usage: usage(100, 20, 300, 40) }));
    emit(turn({ usage: usage(5, 1, 7, 0) }));
    expect(snapshotSubmission(RUN, SUB)).toEqual([
      {
        model: 'faux/cheap',
        agent: 'triage',
        purpose: 'agent',
        calls: 2,
        failed_calls: 0,
        input_tokens: 105,
        output_tokens: 21,
        cache_read_tokens: 307,
        cache_write_tokens: 40,
        usd: 0,
      },
    ]);
  });

  test('a failed turn counts as a call and a failed call, and its tokens count', () => {
    const { emit } = setup();
    emit(turn({ usage: usage(10, 0), isError: true }));
    emit(turn({ usage: usage(10, 5) }));
    const [row] = snapshotSubmission(RUN, SUB);
    expect([row?.calls, row?.failed_calls, row?.input_tokens, row?.output_tokens]).toEqual([2, 1, 20, 5]);
  });

  test('a failed turn with no usage still counts as a failed call', () => {
    const { emit } = setup();
    emit({ ...turn({ isError: true }), response: { error: { message: 'boom' } } });
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.calls, r.failed_calls, r.input_tokens])).toEqual([[1, 1, 0]]);
  });

  test('compaction and compaction_prefix turns get their own row', () => {
    const { emit } = setup();
    emit(turn({ usage: usage(10, 1) }));
    emit(turn({ purpose: 'compaction', usage: usage(50, 5) }));
    emit(turn({ purpose: 'compaction_prefix', usage: usage(30, 3) }));
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.agent, r.purpose, r.calls, r.input_tokens])).toEqual([
      ['triage', 'agent', 1, 10],
      ['triage', 'compaction', 2, 80],
    ]);
  });

  test('the usage on compaction and operation events is not added again', () => {
    const { emit } = setup();
    emit(opStart('op_root'));
    emit(turn({ usage: usage(10, 1) }));
    emit({ type: 'compaction', instanceId: RUN, submissionId: SUB, messagesBefore: 9, messagesAfter: 2, durationMs: 1, isError: false, usage: usage(500, 50) });
    emit(opEnd('op_root'));
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.calls, r.input_tokens, r.output_tokens])).toEqual([[1, 10, 1]]);
  });

  test('a delegate turn is charged to the agent its task_start named', () => {
    const { emit } = setup();
    emit({ type: 'task_start', instanceId: RUN, submissionId: SUB, taskId: 'task_1', prompt: 'brief', agent: 'investigate_ssfb' });
    emit({ type: 'task_start', instanceId: RUN, submissionId: SUB, taskId: 'task_2', prompt: 'brief' });
    emit(turn({ envelope: { taskId: 'task_1', session: 'task:default:task_1', operationId: 'op_t1' } }));
    emit(turn({ envelope: { taskId: 'task_2', session: 'task:default:task_2', operationId: 'op_t2' } }));
    emit(turn({ envelope: { taskId: 'task_unseen', operationId: 'op_t3' } }));
    emit(turn());
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.agent, r.calls])).toEqual([
      ['investigate_ssfb', 1],
      ['task', 2],
      ['triage', 1],
    ]);
  });

  test('a delegate name the row schema refuses is charged to task', () => {
    const { emit } = setup();
    emit({ type: 'task_start', instanceId: RUN, submissionId: SUB, taskId: 'task_1', prompt: 'brief', agent: 'Investigate-SSFB' });
    emit(turn({ envelope: { taskId: 'task_1' } }));
    expect(snapshotSubmission(RUN, SUB).map((r) => r.agent)).toEqual(['task']);
  });

  test('a prompt operation that starts inside the open root operation is the synthesis', () => {
    const { emit } = setup();
    emit(opStart('op_root'));
    emit(turn({ usage: usage(10, 1) }));
    emit(opStart('op_synth'));
    emit(turn({ model: 'faux/strong', usage: usage(70, 7), envelope: { operationId: 'op_synth' } }));
    emit(opEnd('op_synth'));
    emit(turn({ usage: usage(20, 2) }));
    emit(opEnd('op_root'));
    // A later root operation, after the first one ended, is the root again.
    emit(opStart('op_next'));
    emit(turn({ model: 'faux/strong', usage: usage(1, 1), envelope: { operationId: 'op_next' } }));
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.model, r.agent, r.calls, r.input_tokens])).toEqual([
      ['faux/cheap', 'triage', 2, 30],
      ['faux/strong', 'synthesis', 1, 70],
      ['faux/strong', 'triage', 1, 1],
    ]);
  });

  test('an operation of another submission or a task is not taken for the synthesis', () => {
    const { emit } = setup();
    emit(opStart('op_root'));
    emit(opStart('op_other', { submissionId: SUB2 }));
    emit(opStart('op_task', { taskId: 'task_1', session: 'task:default:task_1' }));
    emit(opStart('op_skill', { operationKind: 'skill' }));
    emit(turn({ envelope: { submissionId: SUB2, operationId: 'op_other' } }));
    emit(turn({ envelope: { operationId: 'op_skill' } }));
    expect(snapshotSubmission(RUN, SUB2).map((r) => r.agent)).toEqual(['triage']);
    expect(snapshotSubmission(RUN, SUB).map((r) => r.agent)).toEqual(['triage']);
  });

  test('submission_settled forgets the submission operations a lost end event left open', () => {
    const { emit } = setup();
    emit(opStart('op_root'));
    emit({ type: 'submission_settled', instanceId: RUN, submissionId: SUB, outcome: 'completed' });
    emit(opStart('op_again'));
    emit(turn({ envelope: { operationId: 'op_again' } }));
    expect(snapshotSubmission(RUN, SUB).map((r) => r.agent)).toEqual(['triage']);
  });

  test('two submissions of one run, interleaved, stay apart', () => {
    const { emit } = setup();
    emit(turn({ usage: usage(1, 1) }));
    emit(turn({ usage: usage(2, 2), envelope: { submissionId: SUB2 } }));
    emit(turn({ usage: usage(4, 4) }));
    emit(turn({ usage: usage(8, 8), envelope: { submissionId: SUB2 } }));
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.calls, r.input_tokens])).toEqual([[2, 5]]);
    expect(snapshotSubmission(RUN, SUB2).map((r) => [r.calls, r.input_tokens])).toEqual([[2, 10]]);
    expect(runUsageInMemory(RUN).map((r) => [r.calls, r.input_tokens])).toEqual([[4, 15]]);
  });

  test('the run id is the instance id, else the context id; runs stay apart', () => {
    const { emit } = setup();
    emit(turn({ envelope: { instanceId: OTHER } }));
    emit(turn({ envelope: { instanceId: undefined } }), OTHER);
    emit(turn());
    expect(snapshotSubmission(OTHER, SUB).map((r) => r.calls)).toEqual([2]);
    expect(snapshotSubmission(RUN, SUB).map((r) => r.calls)).toEqual([1]);
  });

  test('a turn without a submissionId goes to the unassigned bucket, which takeUnassigned empties', () => {
    const { emit } = setup();
    emit(turn({ envelope: { submissionId: undefined } }));
    emit(turn());
    expect(snapshotSubmission(RUN, SUB).map((r) => r.calls)).toEqual([1]);
    expect(runUsageInMemory(RUN).map((r) => r.calls)).toEqual([2]);
    expect(takeUnassigned(RUN).map((r) => r.calls)).toEqual([1]);
    expect(takeUnassigned(RUN)).toEqual([]);
    expect(runUsageInMemory(RUN).map((r) => r.calls)).toEqual([1]);
  });

  test('a real model is priced at capture; the provider cost is not used', () => {
    const { emit } = setup();
    const tokens = usage(1000, 200, 3000, 400);
    emit(turn({ model: HAIKU, usage: tokens }));
    const expected = priceUsage(HAIKU, tokens, 'agent');
    expect(expected).toBeGreaterThan(0);
    expect(snapshotSubmission(RUN, SUB)[0]?.usd).toBeCloseTo(expected as number, 12);
  });

  test('a model with no known price gives usd null for its row', () => {
    const { emit } = setup();
    emit(turn({ model: 'openai/not-a-real-model-xyz', usage: usage(10, 1) }));
    emit(turn({ usage: usage(10, 1) }));
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.model, r.usd])).toEqual([
      ['faux/cheap', 0],
      ['openai/not-a-real-model-xyz', null],
    ]);
  });

  test('rows pass UsageRowSchema and are frozen copies', () => {
    const { emit } = setup();
    emit(turn({ usage: usage(10.4, 1) }));
    const rows = snapshotSubmission(RUN, SUB);
    expect(rows.every((r) => v.is(UsageRowSchema, r))).toBe(true);
    expect(rows[0]?.input_tokens).toBe(10);
    expect(Object.isFrozen(rows[0])).toBe(true);
    emit(turn());
    expect(rows[0]?.calls).toBe(1);
  });
});

describe('malformed events', () => {
  test('a malformed event does not throw, and what cannot be counted is dropped and counted', () => {
    const { emit, subscribers } = setup();
    const before = droppedUsageEvents();
    expect(() => emit(turn({ usage: { input: Number.NaN, output: -3, cacheRead: 'x', cacheWrite: Infinity } }))).not.toThrow();
    expect(() => emit({ type: 'turn', instanceId: RUN, submissionId: SUB })).not.toThrow();
    expect(() => emit({ ...turn(), request: { providerId: 'Bad Provider', requestedModel: 'm' } })).not.toThrow();
    expect(() => emit(turn({ envelope: { instanceId: 'not a run id!' } }), 'also bad!')).not.toThrow();
    expect(() => emit({ type: 'task_start', instanceId: RUN })).not.toThrow();
    expect(() => emit({ type: 'operation_start', instanceId: RUN })).not.toThrow();
    expect(() => emit({ type: 'turn', instanceId: RUN, submissionId: SUB, request: null, response: 'x' })).not.toThrow();
    // The first turn is counted with zero tokens; the next four have no usable model or run id.
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.calls, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens])).toEqual([
      [1, 0, 0, 0, 0],
    ]);
    expect(droppedUsageEvents() - before).toBe(4);
    expect(() => subscribers[0]?.(null as never, null as never)).not.toThrow();
    expect(droppedUsageEvents() - before).toBe(5);
  });

  test('events the meter does not use are ignored', () => {
    const { emit } = setup();
    for (const type of ['text_delta', 'tool_start', 'tool', 'message_end', 'agent_end', 'idle', 'log', 'turn_request']) {
      emit({ type, instanceId: RUN, submissionId: SUB, usage: usage(1, 1) });
    }
    expect(runUsageInMemory(RUN)).toEqual([]);
  });
});

describe('recordUsage', () => {
  const classifier = {
    model: 'faux/classifier',
    agent: 'classifier',
    purpose: 'classify',
    isError: false,
    input: 40,
    output: 8,
    cacheRead: 0,
    cacheWrite: 0,
  } as const;

  test('intake records are kept apart from the submissions and priced by spec', () => {
    setup();
    recordUsage(RUN, 'intake', classifier);
    recordUsage(RUN, 'intake', { ...classifier, isError: true });
    expect(snapshotIntake(RUN)).toEqual([
      {
        model: 'faux/classifier',
        agent: 'classifier',
        purpose: 'classify',
        calls: 2,
        failed_calls: 1,
        input_tokens: 80,
        output_tokens: 16,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: 0,
      },
    ]);
    expect(snapshotSubmission(RUN, SUB)).toEqual([]);
  });

  test('a submission bucket takes records next to its turns', () => {
    const { emit } = setup();
    emit(turn());
    recordUsage(RUN, { submissionId: SUB }, { ...classifier, model: 'ollama/nomic-embed-text', agent: 'embedder', purpose: 'embed', output: 0 });
    expect(snapshotSubmission(RUN, SUB).map((r) => [r.model, r.agent, r.purpose, r.usd])).toEqual([
      ['faux/cheap', 'triage', 'agent', 0],
      ['ollama/nomic-embed-text', 'embedder', 'embed', 0],
    ]);
  });

  test('a preset usd is used as given; null keeps it unpriced; omitted prices by spec', () => {
    setup();
    const decision = { ...classifier, model: 'typesafe/jev-1.13' };
    recordUsage(RUN, 'intake', { ...decision, usd: 0.25 });
    recordUsage(RUN, 'intake', { ...decision, usd: 0.5 });
    expect(snapshotIntake(RUN)[0]?.usd).toBe(0.75);
    recordUsage(RUN, 'intake', { ...decision, usd: null });
    expect(snapshotIntake(RUN)[0]?.usd).toBeNull();
    dropIntake(RUN);
    recordUsage(RUN, 'intake', decision);
    expect(snapshotIntake(RUN)[0]?.usd).toBeNull();
    dropIntake(RUN);
    recordUsage(RUN, 'intake', { ...decision, usd: Number.NaN });
    expect(snapshotIntake(RUN)[0]?.usd).toBeNull();
  });

  test('cacheWrite1h reaches the pricer', () => {
    setup();
    const tokens = { input: 100, output: 10, cacheRead: 0, cacheWrite: 1000 };
    recordUsage(RUN, 'intake', { ...classifier, ...tokens, model: HAIKU, cacheWrite1h: 1000 });
    const long = priceUsage(HAIKU, { ...tokens, cacheWrite1h: 1000 });
    const short = priceUsage(HAIKU, tokens);
    expect(long).not.toBe(short);
    expect(snapshotIntake(RUN)[0]?.usd).toBeCloseTo(long as number, 12);
    expect(snapshotIntake(RUN)[0]?.cache_write_tokens).toBe(1000);
  });

  test('a record the row schema would refuse is dropped and counted, never thrown', () => {
    setup();
    const before = droppedUsageEvents();
    expect(() => recordUsage(RUN, 'intake', { ...classifier, model: 'anthropic/claude-****1001' })).not.toThrow();
    expect(() => recordUsage(RUN, 'intake', { ...classifier, agent: 'ops@example.test' })).not.toThrow();
    expect(() => recordUsage(RUN, 'intake', { ...classifier, purpose: 'other' as never })).not.toThrow();
    expect(() => recordUsage('bad run id!', 'intake', classifier)).not.toThrow();
    expect(() => recordUsage(RUN, { submissionId: '' }, classifier)).not.toThrow();
    expect(() => recordUsage(RUN, 'intake', null as never)).not.toThrow();
    expect(droppedUsageEvents() - before).toBe(6);
    expect(runUsageInMemory(RUN)).toEqual([]);
  });
});

describe('versions, drops and memory', () => {
  test('usageVersion moves on every change and not otherwise', () => {
    const { emit } = setup();
    expect(usageVersion(RUN, SUB)).toBe(0);
    emit(turn());
    const first = usageVersion(RUN, SUB);
    expect(first).toBeGreaterThan(0);
    snapshotSubmission(RUN, SUB);
    emit(turn({ envelope: { submissionId: SUB2 } }));
    recordUsage(RUN, 'intake', { model: 'faux/classifier', agent: 'classifier', purpose: 'classify', isError: false, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    expect(usageVersion(RUN, SUB)).toBe(first);
    emit(turn());
    expect(usageVersion(RUN, SUB)).toBeGreaterThan(first);
  });

  test('a submission counted again after a drop never repeats an earlier version', () => {
    const { emit } = setup();
    emit(turn());
    const before = usageVersion(RUN, SUB);
    dropSubmission(RUN, SUB);
    expect(usageVersion(RUN, SUB)).toBe(0);
    emit(turn());
    expect(usageVersion(RUN, SUB)).toBeGreaterThan(before);
  });

  test('dropSubmission and dropIntake forget only their own rows', () => {
    const { emit } = setup();
    emit(turn());
    emit(turn({ envelope: { submissionId: SUB2 } }));
    recordUsage(RUN, 'intake', { model: 'faux/classifier', agent: 'classifier', purpose: 'classify', isError: false, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
    dropSubmission(RUN, SUB);
    expect(snapshotSubmission(RUN, SUB)).toEqual([]);
    expect(snapshotSubmission(RUN, SUB2)).toHaveLength(1);
    expect(snapshotIntake(RUN)).toHaveLength(1);
    dropIntake(RUN);
    expect(snapshotIntake(RUN)).toEqual([]);
    expect(runUsageInMemory(RUN).map((r) => r.agent)).toEqual(['triage']);
    dropSubmission(RUN, SUB2);
    expect(runUsageInMemory(RUN)).toEqual([]);
    // Unknown runs and submissions are fine.
    dropSubmission(OTHER, SUB);
    dropIntake(OTHER);
    expect(takeUnassigned(OTHER)).toEqual([]);
  });

  test('runUsageInMemory sums the intake, every submission and the unassigned turns', () => {
    const { emit } = setup();
    emit(turn({ usage: usage(1, 0) }));
    emit(turn({ usage: usage(2, 0), envelope: { submissionId: SUB2 } }));
    emit(turn({ usage: usage(4, 0), envelope: { submissionId: undefined } }));
    recordUsage(RUN, 'intake', { model: 'faux/cheap', agent: 'triage', purpose: 'agent', isError: true, input: 8, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(runUsageInMemory(RUN).map((r) => [r.calls, r.failed_calls, r.input_tokens, r.usd])).toEqual([[4, 1, 15, 0]]);
  });
});

describe('install', () => {
  test('installUsageMeter twice subscribes once', () => {
    const subscribers: Subscriber[] = [];
    const observe = (s: Subscriber) => {
      subscribers.push(s);
      return () => subscribers.splice(subscribers.indexOf(s), 1);
    };
    expect(usageMeterInstalled()).toBe(false);
    installUsageMeter({ observe });
    installUsageMeter({ observe });
    expect(subscribers).toHaveLength(1);
    expect(usageMeterInstalled()).toBe(true);
    resetUsageMeterForTests();
    expect(subscribers).toHaveLength(0);
    expect(usageMeterInstalled()).toBe(false);
  });

  const DB = { kind: 'fake-adapter' } as unknown as NonNullable<StartOptions['db']>;
  const boot = (usageMeter?: boolean) =>
    bootRuntime({
      start: async () => ({ stop: async () => {}, [Symbol.asyncDispose]: async () => {} }) as never,
      db: () => DB,
      eventLog: false,
      ensureModels: async () => {},
      ...(usageMeter === undefined ? {} : { usageMeter }),
    });

  test('bootRuntime installs the meter before start() by default', async () => {
    await boot();
    expect(usageMeterInstalled()).toBe(true);
  });

  test('bootRuntime with usageMeter: false leaves it off', async () => {
    await boot(false);
    expect(usageMeterInstalled()).toBe(false);
  });
});
