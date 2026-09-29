import { afterEach, describe, expect, test } from 'bun:test';
import type { FlueEvent } from '@flue/runtime';
import { recorder } from '../../../test/support/fake-tracer.ts';
import { adjust, nameRoot } from './braintrust.ts';
import { labelTrace, setTracerForTests } from './index.ts';

const base = { v: 3, eventIndex: 1, timestamp: '2026-09-27T08:00:10.000Z' } as const;

describe('adjust', () => {
  test('turn and operation prompt tokens include cache reads and writes, on a copy', () => {
    const usage = {
      input: 100,
      output: 50,
      cacheRead: 700,
      cacheWrite: 200,
      totalTokens: 1050,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    };
    const turn = {
      ...base,
      type: 'turn',
      turnId: 'turn_1',
      purpose: 'agent',
      durationMs: 900,
      request: {},
      response: { usage },
      isError: false,
    } as unknown as FlueEvent;

    const out = adjust(turn);
    expect(out.type === 'turn' && out.response.usage).toEqual({ ...usage, input: 1000 });
    expect(usage.input).toBe(100);

    const op: FlueEvent = {
      ...base,
      type: 'operation',
      operationId: 'op_1',
      operationKind: 'prompt',
      durationMs: 900,
      isError: false,
      usage,
    };
    const opOut = adjust(op);
    expect(opOut.type === 'operation' && opOut.usage).toEqual({ ...usage, input: 1000 });
    expect(usage.input).toBe(100);
  });

  test('a tool ends at its start plus its duration, not at the batch time', () => {
    const tool: FlueEvent = {
      ...base,
      type: 'tool',
      toolName: 'sql_select',
      toolCallId: 'call_1',
      isError: false,
      durationMs: 10,
    };
    expect(adjust(tool, '2026-09-27T08:00:01.500Z').timestamp).toBe('2026-09-27T08:00:01.510Z');
    expect(tool.timestamp).toBe(base.timestamp);
    expect(adjust(tool)).toBe(tool);
  });
});

describe('nameRoot (D100)', () => {
  afterEach(() => setTracerForTests(undefined));
  const RUN = '01JRUNAAAAAAAAAAAAAAAAAAAA';
  const prompt = { type: 'agent', operationId: 'op_1', operationKind: 'prompt' } as const;

  test('renames a root agent span only', async () => {
    setTracerForTests(recorder().tracer);
    await labelTrace(RUN, 'answer', async () => ({ category: 'onboarding', subcategory: 'sim_binding' }));
    const names: unknown[] = [];
    const span = (parents: string[]) => ({ spanParents: parents, setAttributes: (a: { name?: string }) => void names.push(a.name) });

    nameRoot(prompt, { instanceId: RUN }, span([]));
    nameRoot(prompt, { instanceId: RUN }, span(['parent']));
    nameRoot({ type: 'tool', toolCallId: 'c', toolName: 't' }, { instanceId: RUN }, span([]));
    nameRoot(prompt, {}, span([]));
    nameRoot(prompt, { instanceId: '01JUNLABELLEDAAAAAAAAAAAAA' }, span([]));
    expect(names).toEqual([
      `onboarding:sim_binding · answer · ${RUN} · flue.prompt`,
      '01JUNLABELLEDAAAAAAAAAAAAA · flue.prompt',
    ]);
  });
});
