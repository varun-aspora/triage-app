// Braintrust adapter (D82): Braintrust's own Flue instrumentation for agent
// runs, and SDK spans for the model calls the app makes itself. A span opened
// inside a Flue tool nests under that tool's span in Braintrust.

import { instrument } from '@flue/runtime';
import { braintrustFlueInstrumentation, flush, initLogger, setMaskingFunction, traced } from 'braintrust';
import type { Config } from '../../config/env.ts';
import { mask, type Tracer } from './index.ts';

export function installBraintrust(tracing: Config['tracing']): Tracer {
  setMaskingFunction(mask);
  initLogger({ projectName: tracing.braintrustProject, apiKey: tracing.braintrustApiKey });
  instrument(braintrustFlueInstrumentation());
  return {
    withModelSpan: (s, fn, result) =>
      traced(
        async (span) => {
          span.log({ input: s.input, metadata: { model: s.model, ...(s.name === undefined ? {} : { decision: s.name }) } });
          const r = await fn();
          const out = result?.(r);
          if (out !== undefined) {
            span.log({
              output: out.output,
              metrics: {
                ...(out.inputTokens === undefined ? {} : { prompt_tokens: out.inputTokens }),
                ...(out.outputTokens === undefined ? {} : { completion_tokens: out.outputTokens }),
              },
            });
          }
          return r;
        },
        { name: `${s.op} ${s.model}`, type: 'llm' },
      ),
    flush: () => flush(),
  };
}
