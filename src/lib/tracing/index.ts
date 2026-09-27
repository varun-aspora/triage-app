// Tracing (D82). One entry point for the app, one adapter per backend.
//
// TRIAGE_TRACING picks the adapter:
//   - off: nothing is installed; withModelSpan just runs the call.
//   - otlp: Flue's OpenTelemetry instrumentation plus OTel spans, exported to
//     any OTLP backend (Langfuse, Braintrust, Datadog...). See ./otlp.ts.
//   - braintrust: Braintrust's own Flue instrumentation and SDK spans, for its
//     native view. See ./braintrust.ts.
//
// Flue traces what it runs (agent operations, model turns, tools). The model
// calls the app makes itself (decide(), the embedder, the classifier's
// completion path) wrap themselves in withModelSpan, so every call is traced
// wherever it is made. Inside a Flue tool the span nests under the tool.
//
// Content leaves the process only after redactPersisted. Adapters are loaded
// with import(), so a process with tracing off never loads a vendor SDK.
// Tracing never fails the call it wraps, a command or shutdown.

import type { Config } from '../../config/env.ts';
import { redactPersisted } from '../../gate/redact.ts';

export type ModelSpan = {
  readonly op: 'decide' | 'embeddings' | 'chat';
  readonly model: string;
  /** Which decision this is, e.g. 'classify' or 'identity'. */
  readonly name?: string;
  readonly input?: unknown;
};

export type ModelSpanResult = { readonly output?: unknown; readonly inputTokens?: number; readonly outputTokens?: number };

export type Tracer = {
  withModelSpan<T>(span: ModelSpan, fn: () => Promise<T>, result?: (r: T) => ModelSpanResult): Promise<T>;
  flush(): Promise<void>;
};

let active: Tracer | undefined;

/** Masks a value the way every stored copy of a run is masked. */
export const mask = (value: unknown): unknown => redactPersisted(value).value;

export async function installTracing(tracing: Config['tracing']): Promise<void> {
  if (active !== undefined || tracing.mode === 'off') return;
  try {
    active =
      tracing.mode === 'otlp'
        ? (await import('./otlp.ts')).installOtlp(tracing)
        : (await import('./braintrust.ts')).installBraintrust(tracing);
  } catch {
    // A backend that fails to start leaves the app untraced, not down.
    active = undefined;
  }
}

export function withModelSpan<T>(span: ModelSpan, fn: () => Promise<T>, result?: (r: T) => ModelSpanResult): Promise<T> {
  if (active === undefined) return fn();
  const safe = { ...span, ...(span.input === undefined ? {} : { input: mask(span.input) }) };
  const safeResult = result && ((r: T) => {
    const out = result(r);
    return out.output === undefined ? out : { ...out, output: mask(out.output) };
  });
  return active.withModelSpan(safe, fn, safeResult);
}

/** Sends what is queued, waiting at most timeoutMs. Never throws. */
export async function flushTracing(timeoutMs = 3000): Promise<void> {
  if (active === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([active.flush().catch(() => undefined), limit]);
  clearTimeout(timer);
}

/** Tests install a stand-in tracer, or undefined to turn tracing off again. */
export function setTracerForTests(tracer: Tracer | undefined): void {
  active = tracer;
}
