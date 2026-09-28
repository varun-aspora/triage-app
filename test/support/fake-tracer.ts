// A fake Tracer for tests: runs each call and records its span, and the
// result summary when the caller passes one.

import type { ModelSpan, ModelSpanResult, Tracer } from '../../src/lib/tracing/index.ts';

export type RecordedSpan = { readonly span: ModelSpan; readonly result?: ModelSpanResult };

export function recorder(flush: () => Promise<void> = async () => {}): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
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
