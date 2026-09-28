import { afterEach, describe, expect, test } from 'bun:test';
import { flushTracing, installTracing, setTracerForTests, withModelSpan, type ModelSpan, type ModelSpanResult, type Tracer } from './index.ts';

afterEach(() => setTracerForTests(undefined));

function recorder(flush: () => Promise<void> = async () => {}): { tracer: Tracer; spans: Array<{ span: ModelSpan; result?: ModelSpanResult }> } {
  const spans: Array<{ span: ModelSpan; result?: ModelSpanResult }> = [];
  return {
    spans,
    tracer: {
      withModelSpan: async (span, fn, result) => {
        const r = await fn();
        spans.push({ span, ...(result === undefined ? {} : { result: result(r) }) });
        return r;
      },
      flush,
    },
  };
}

describe('withModelSpan', () => {
  test('off: runs the call and records nothing', async () => {
    await installTracing({ mode: 'off', braintrustProject: 'p' });
    expect(await withModelSpan({ op: 'decide', model: 'm' }, async () => 42)).toBe(42);
  });

  test('on: masks input and output before the adapter sees them', async () => {
    const { tracer, spans } = recorder();
    setTracerForTests(tracer);
    const r = await withModelSpan(
      { op: 'decide', model: 'typesafe/jev', name: 'identity', input: { text: 'mail me at jo@example.com' } },
      async () => ({ answer: 'call 9876543210' }),
      (x) => ({ output: x, inputTokens: 3 }),
    );
    expect(r).toEqual({ answer: 'call 9876543210' });
    expect(JSON.stringify(spans)).not.toContain('jo@example.com');
    expect(JSON.stringify(spans)).not.toContain('9876543210');
    expect(spans[0]?.span).toMatchObject({ op: 'decide', model: 'typesafe/jev', name: 'identity' });
    expect(spans[0]?.result?.inputTokens).toBe(3);
  });

  test('a failing call rejects unchanged', async () => {
    setTracerForTests(recorder().tracer);
    const boom = new Error('boom');
    await expect(withModelSpan({ op: 'chat', model: 'm' }, async () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe('flushTracing', () => {
  test('returns within the limit when the backend hangs, and never throws', async () => {
    setTracerForTests(recorder(() => new Promise<void>(() => {})).tracer);
    const started = performance.now();
    await flushTracing(20);
    expect(performance.now() - started).toBeLessThan(1000);
    setTracerForTests(recorder(() => Promise.reject(new Error('down'))).tracer);
    await expect(flushTracing(20)).resolves.toBeUndefined();
  });
});
