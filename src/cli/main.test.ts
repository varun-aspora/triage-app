// main() ends every CLI process the same way: it waits for the queued
// Braintrust spans (D82), then ends the shared pg pools (D68), whatever the
// command returned or threw. Stand-ins only; no pool or Braintrust call.

import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { EXIT } from './output.ts';
import { main, tracesStillSending } from './main.ts';
import type { CliContext } from './types.ts';

function context(): CliContext {
  return {
    config: () => {
      throw new Error('no config in this test');
    },
    io: {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  } as unknown as CliContext;
}

describe('main', () => {
  test('flushes traces, then ends the pools, after the command', async () => {
    const order: string[] = [];
    const code = await main(['--help'], context(), {
      flushTraces: async () => void order.push('flush'),
      closePools: async () => void order.push('pools'),
    });
    expect(code).toBe(EXIT.OK);
    expect(order).toEqual(['flush', 'pools']);
  });

  test('a failing command still flushes and ends the pools', async () => {
    const order: string[] = [];
    const code = await main(['--json', 'no-such-command'], context(), {
      flushTraces: async () => void order.push('flush'),
      closePools: async () => void order.push('pools'),
    });
    expect(code).not.toBe(EXIT.OK);
    expect(order).toEqual(['flush', 'pools']);
  });

  test('a flush that throws does not stop the pools from ending or change the exit code', async () => {
    const order: string[] = [];
    const code = await main(['--help'], context(), {
      flushTraces: async () => {
        throw new Error('flush failed');
      },
      closePools: async () => void order.push('pools'),
    });
    expect(code).toBe(EXIT.OK);
    expect(order).toEqual(['pools']);
  });

  test('with tracing off the default flush returns at once', async () => {
    const order: string[] = [];
    const started = Date.now();
    await main(['--help'], context(), { closePools: async () => void order.push('pools') });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(order).toEqual(['pools']);
  });
});

describe('tracesStillSending', () => {
  test('is true only after a flush that timed out, so the shim exits the process itself', async () => {
    await main(['--help'], context(), { flushTraces: async () => 'timeout', closePools: async () => undefined });
    expect(tracesStillSending()).toBe(true);
    await main(['--help'], context(), { flushTraces: async () => 'done', closePools: async () => undefined });
    expect(tracesStillSending()).toBe(false);
    await main(['--help'], context(), { flushTraces: async () => 'failed', closePools: async () => undefined });
    expect(tracesStillSending()).toBe(false);
    await main(['--help'], context(), {
      flushTraces: async () => {
        throw new Error('flush failed');
      },
      closePools: async () => undefined,
    });
    expect(tracesStillSending()).toBe(false);
  });
});
