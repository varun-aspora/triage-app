// Braintrust adapter (D82): Braintrust's own Flue instrumentation for agent
// runs, and SDK spans for the model calls the app makes itself. A span opened
// inside a Flue tool nests under that tool's span in Braintrust.

import { type FlueEvent, instrument, type PromptUsage } from '@flue/runtime';
import { braintrustFlueInstrumentation, flush, initLogger, setMaskingFunction, startSpan, withCurrent } from 'braintrust';
import type { Config } from '../../config/env.ts';
import { mask, maskedMessage, type Tracer } from './index.ts';
import { BRAINTRUST_RUN_ID_KEY } from './keys.ts';

export function installBraintrust(tracing: Config['tracing']): Tracer {
  setMaskingFunction(mask);
  initLogger({ projectName: tracing.braintrustProject, apiKey: tracing.braintrustApiKey });
  const inner = braintrustFlueInstrumentation();
  const toolStarts = new Map<string, string>();
  instrument({
    ...inner,
    observe: (e, ctx) => {
      let startedAt: string | undefined;
      if (e.type === 'tool_start') toolStarts.set(e.toolCallId, e.timestamp);
      if (e.type === 'tool') {
        startedAt = toolStarts.get(e.toolCallId);
        toolStarts.delete(e.toolCallId);
      }
      return inner.observe(adjust(e, startedAt), ctx);
    },
  });
  return {
    // startSpan rather than traced(): traced() logs the raw error, stack
    // included, and Braintrust does not mask the error field (D82).
    withModelSpan: async (s, fn, result) => {
      const span = startSpan({ name: `${s.op} ${s.name ?? s.model}`, type: 'llm' });
      span.log({
        input: s.input,
        metadata: {
          model: s.model,
          ...(s.name === undefined ? {} : { decision: s.name }),
          ...(s.runId === undefined ? {} : { [BRAINTRUST_RUN_ID_KEY]: s.runId }),
        },
      });
      try {
        const r = await withCurrent(span, fn);
        const out = result?.(r);
        if (out !== undefined) {
          span.log({
            output: out.output,
            metrics: {
              ...(out.inputTokens === undefined ? {} : { prompt_tokens: out.inputTokens }),
              ...(out.outputTokens === undefined ? {} : { completion_tokens: out.outputTokens }),
              ...(out.costUsd === undefined ? {} : { estimated_cost: out.costUsd }),
            },
          });
        }
        return r;
      } catch (err) {
        span.log({ error: maskedMessage(err) });
        throw err;
      } finally {
        span.end();
      }
    },
    flush: () => flush(),
  };
}

// Two fixes to what Braintrust's Flue bridge logs, until they land upstream (D82).
// The bridge sends uncached input as prompt_tokens, so the cache rate shows
// above 100%. It reads usage from turn events and, for turns still open when
// their operation ends, from the operation event, so both are fixed. A tool that
// ends in a batch gets the batch's event time as its end.
// Depends on Flue's internal event shapes; recheck on a Flue or braintrust upgrade.
export function adjust(e: FlueEvent, toolStartedAt?: string): FlueEvent {
  if (e.type === 'turn' && e.response.usage !== undefined) {
    return { ...e, response: { ...e.response, usage: fixUsage(e.response.usage) } };
  }
  if (e.type === 'operation' && e.usage !== undefined) return { ...e, usage: fixUsage(e.usage) };
  if (e.type === 'tool' && toolStartedAt !== undefined) {
    const end = Date.parse(toolStartedAt) + e.durationMs;
    if (Number.isFinite(end)) return { ...e, timestamp: new Date(end).toISOString() };
  }
  return e;
}

function fixUsage(u: PromptUsage): PromptUsage {
  return { ...u, input: u.input + u.cacheRead + u.cacheWrite };
}
