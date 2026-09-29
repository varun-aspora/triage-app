import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { recorder } from '../../../test/support/fake-tracer.ts';
import { flushTracing, installTracing, labelTrace, setTracerForTests, traceLabel, withModelSpan, withRunId } from './index.ts';

afterEach(() => setTracerForTests(undefined));

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

describe('labelTrace (D100)', () => {
  const RUN = '01JRUNAAAAAAAAAAAAAAAAAAAA';

  test('the latest label wins, and the subcategory is masked', async () => {
    setTracerForTests(recorder().tracer);
    await labelTrace(RUN, 'initial', async () => ({ category: 'onboarding', subcategory: 'sim_binding' }));
    await labelTrace(RUN, 'answer', async () => ({ category: 'onboarding', subcategory: 'sim_binding' }));
    expect(traceLabel(RUN)).toEqual({ topic: 'onboarding:sim_binding', kind: 'answer' });
    await labelTrace(RUN, 'ask', async () => ({ category: 'auth', subcategory: 'otp to 9876543210' }));
    expect(traceLabel(RUN)?.topic).not.toContain('9876543210');
  });

  test('no subcategory or a failed load leaves that part out', async () => {
    setTracerForTests(recorder().tracer);
    await labelTrace(RUN, 'resume', async () => ({ category: 'unknown', subcategory: '' }));
    expect(traceLabel(RUN)).toEqual({ topic: 'unknown', kind: 'resume' });
    await labelTrace(RUN, 'steer', () => Promise.reject(new Error('store down')));
    expect(traceLabel(RUN)).toEqual({ topic: '', kind: 'steer' });
  });

  test('tracing off loads nothing and keeps nothing', async () => {
    let loads = 0;
    await labelTrace(RUN, 'initial', async () => {
      loads += 1;
      return undefined;
    });
    expect(loads).toBe(0);
    expect(traceLabel(RUN)).toBeUndefined();
  });
});
