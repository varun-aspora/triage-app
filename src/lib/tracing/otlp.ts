// OTLP adapter (D82): Flue's OpenTelemetry instrumentation for agent runs, and
// GenAI spans for the model calls the app makes itself, exported to any OTLP
// traces endpoint. Switching backend (Langfuse, Braintrust, Datadog...) is
// TRIAGE_OTLP_ENDPOINT and TRIAGE_OTLP_HEADERS only. A span opened inside a
// Flue tool nests under its execute_tool span.

import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { Config } from '../../config/env.ts';
import { mask, type Tracer } from './index.ts';
import { OTLP_RUN_ID_KEY } from './keys.ts';

export function installOtlp(tracing: Config['tracing']): Tracer {
  const exporter = new OTLPTraceExporter({ url: tracing.otlpEndpoint, headers: parseHeaders(tracing.otlpHeaders) });
  const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
  provider.register();
  instrument(createOpenTelemetryInstrumentation({ content: { transform: (content) => mask(content) } }));
  const tracer = trace.getTracer('triage-app');
  return {
    withModelSpan: (s, fn, result) =>
      tracer.startActiveSpan(
        `${s.op} ${s.name ?? s.model}`,
        {
          attributes: {
            'gen_ai.operation.name': s.op,
            'gen_ai.request.model': s.model,
            ...(s.name === undefined ? {} : { 'triage.decision.name': s.name }),
            ...(s.runId === undefined ? {} : { [OTLP_RUN_ID_KEY]: s.runId }),
          },
        },
        async (span) => {
          try {
            const r = await fn();
            const out = result?.(r);
            if (out?.inputTokens !== undefined) span.setAttribute('gen_ai.usage.input_tokens', out.inputTokens);
            if (out?.outputTokens !== undefined) span.setAttribute('gen_ai.usage.output_tokens', out.outputTokens);
            return r;
          } catch (err) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute('error.type', err instanceof Error ? err.name : 'Error');
            throw err;
          } finally {
            span.end();
          }
        },
      ),
    flush: () => provider.forceFlush(),
  };
}

/** 'k=v,k=v' into headers. A value may contain '=' (base64). */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}
