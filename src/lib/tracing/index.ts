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
//
// Ingress and embedRun wrap each run in withRunId (D91), so every span they
// open carries the run id under the key Flue's own spans use for their
// instance id, and one filter joins the Flue traces with the app's.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config } from '../../config/env.ts';
import { redactPersisted } from '../../gate/redact.ts';

export type ModelSpan = {
  readonly op: 'decide' | 'embeddings' | 'chat';
  readonly model: string;
  /** Which decision this is, e.g. 'classify' or 'identity'. */
  readonly name?: string;
  readonly input?: unknown;
  /** Set from withRunId; callers leave it out. */
  readonly runId?: string;
};

export type ModelSpanResult = {
  readonly output?: unknown;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Provider-reported cost in USD, when it reports one. */
  readonly costUsd?: number;
};

export type Tracer = {
  withModelSpan<T>(span: ModelSpan, fn: () => Promise<T>, result?: (r: T) => ModelSpanResult): Promise<T>;
  flush(): Promise<void>;
};

let active: Tracer | undefined;

const runScope = new AsyncLocalStorage<string>();

/** Runs fn with runId attached to every model span opened inside it. */
export function withRunId<T>(runId: string, fn: () => T): T {
  // installTracing runs at startup, before any run, so with tracing off the
  // scope is skipped and ALS context tracking never turns on.
  return active === undefined ? fn() : runScope.run(runId, fn);
}

/** Masks a value the way every stored copy of a run is masked. */
export const mask = (value: unknown): unknown => redactPersisted(value).value;

/** The only error text tracing lets out: the masked message, never the stack. */
export const maskedMessage = (err: unknown): string => String(mask(err instanceof Error ? err.message : String(err)));

export async function installTracing(tracing: Config['tracing']): Promise<void> {
  if (active !== undefined || tracing.mode === 'off') return;
  try {
    active =
      tracing.mode === 'otlp'
        ? (await import('./otlp.ts')).installOtlp(tracing)
        : (await import('./braintrust.ts')).installBraintrust(tracing);
  } catch (err) {
    // A backend that fails to start leaves the app untraced, not down.
    active = undefined;
    process.stderr.write(`tracing: ${tracing.mode} failed to start, running untraced (${maskedMessage(err)})\n`);
  }
}

export function withModelSpan<T>(span: ModelSpan, fn: () => Promise<T>, result?: (r: T) => ModelSpanResult): Promise<T> {
  if (active === undefined) return fn();
  const runId = runScope.getStore();
  const safe = {
    ...span,
    ...(span.input === undefined ? {} : { input: mask(span.input) }),
    ...(runId === undefined ? {} : { runId }),
  };
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
