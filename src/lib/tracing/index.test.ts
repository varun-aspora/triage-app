import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { flushTracing, installTracing, setTracerForTests, withModelSpan, withRunId, type ModelSpan, type ModelSpanResult, type Tracer } from './index.ts';

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

describe('installTracing', () => {
  test('a backend that fails to start writes one line', async () => {
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // installOtlp reads the endpoint before anything else, so this throws
      // before any exporter or provider exists.
      await installTracing({
        mode: 'otlp',
        braintrustProject: 'p',
        get otlpEndpoint(): string {
          throw new Error('bad endpoint');
        },
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toBe('tracing: otlp failed to start, running untraced (bad endpoint)\n');
    } finally {
      write.mockRestore();
    }
  });
});

describe('withRunId', () => {
  test('a span inside carries the run id; one outside carries none', async () => {
    const { tracer, spans } = recorder();
    setTracerForTests(tracer);
    await withRunId('01JRUNAAAAAAAAAAAAAAAAAAAA', () => withModelSpan({ op: 'decide', model: 'm' }, async () => 1));
    await withModelSpan({ op: 'decide', model: 'm' }, async () => 2);
    expect(spans[0]?.span.runId).toBe('01JRUNAAAAAAAAAAAAAAAAAAAA');
    expect(spans[1]?.span).not.toHaveProperty('runId');
  });

  test('two concurrent runs keep their own id across awaits and timers', async () => {
    const { tracer, spans } = recorder();
    setTracerForTests(tracer);
    const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const run = (runId: string, first: number, second: number) =>
      withRunId(runId, async () => {
        await tick(first);
        await withModelSpan({ op: 'decide', model: 'm', name: `${runId}-a` }, async () => tick(1));
        await tick(second);
        await withModelSpan({ op: 'embeddings', model: 'e', name: `${runId}-b` }, async () => 0);
      });
    await Promise.all([run('run-a', 1, 8), run('run-b', 4, 1)]);
    expect(spans).toHaveLength(4);
    for (const { span } of spans) expect(span.name?.startsWith(`${span.runId}-`)).toBe(true);
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
