---
title: OpenTelemetry
source: https://flueframework.com/docs/ecosystem/tooling/opentelemetry/
source_command: bunx flue docs read ecosystem/tooling/opentelemetry
flue_version: 2.0.8
section: ecosystem/tooling
---

# OpenTelemetry

## Purpose and selection

`@flue/opentelemetry` projects live Flue runtime observations into standard
OpenTelemetry GenAI spans and metrics. Select it when the application already
owns, or will explicitly configure, an OpenTelemetry SDK and exporter.

The adapter does not configure an SDK, exporter, sampling, credentials, or
deployment-specific flushing. Those remain application responsibilities.
The package implements Development GenAI conventions pinned at commit
`4c8addb53718b544134be47e256237026fe88875`. Its Flue-to-GenAI projection
revision is `5`; its Flue extension revision is `4`.

## Prerequisites and environment

Install the adapter and API alongside an SDK and exporter compatible with the
deployment target:

```sh
bun add @flue/opentelemetry @opentelemetry/api
```

The bundled page defines no adapter-specific environment variables. Exporter
credentials, endpoint variables, and sampling controls come from the SDK and
exporter selected by the application, not from `@flue/opentelemetry`.

## How to

### 1. Install the adapter

```sh
bun add @flue/opentelemetry @opentelemetry/api
```

There is no documented `flue add tooling opentelemetry` blueprint.

### 2. Configure the OpenTelemetry SDK and exporter

Configure those components before registering Flue instrumentation. The bundled
page intentionally does not prescribe a specific SDK or exporter.

### 3. Register one instrumentation instance

```ts
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';

const instrumentation = createOpenTelemetryInstrumentation();
const disposeInstrumentation = instrument(instrumentation);
```

Pass configured tracer, meter, or structural Logger instances when the
application owns them.

### 4. Set the content policy before export

Content is enabled by default. Disable it completely:

```ts
const instrumentation = createOpenTelemetryInstrumentation({ content: false });
```

Or transform content in code:

```ts
const instrumentation = createOpenTelemetryInstrumentation({
  content: {
    transform(content, scope) {
      if (scope.contentType === 'exception_stacktrace') return undefined;
      return redactSecrets(content);
    },
  },
});
```

Returning `undefined` omits that content. A throwing transform emits a `[flue]`
failure sentinel instead of the unredacted value.

### 5. Dispose and flush at the owning lifecycle

Generated Node applications automatically dispose instrumentation registrations
created while evaluating `app.ts` after admissions and active work drain. When
registering outside that lifecycle, call:

```ts
await disposeInstrumentation();
```

Then separately flush or shut down the application-owned SDK and exporter.

### 6. Verify

Use an in-memory exporter in tests. Verify hierarchy, span names, kinds, status,
attributes, metrics, and the content policy. Hosted rendering is backend-specific;
standards-correct OpenTelemetry output is the portable contract.

## Current APIs and configuration

### Registration

```ts
const instrumentation = createOpenTelemetryInstrumentation();
const disposeInstrumentation = instrument(instrumentation);
```

The bundled page shows `content: false` and a `content.transform(...)` policy. It
also names the exported `truncateContent(content, { maxBytes })` helper for
application-level byte limits.

### Trace model

| Flue activity | Span name or behavior |
| --- | --- |
| Prompt or skill operation | `invoke_agent <agent>` |
| Delegated task | One task-owned `invoke_agent <agent>` |
| Provider inference | `chat <requested-model>` client span |
| GenAI tool execution | `execute_tool <name>` |
| Caller shell execution | `flue.operation shell` |
| Context compaction | `flue.compaction` with child chat spans |

Provider chat spans cover provider inference only. Local tools are sibling spans
under the agent invocation and correlate with model output through
`gen_ai.tool.call.id`.

`gen_ai.conversation.id` identifies one persisted Flue session. It is not a
submission, dispatch, operation, trace, session name, or provider-affinity key.
Fields with no exact standard equivalent remain documented `flue.*` attributes.

### Content budget

After transformation, Flue enforces a 56 KiB per-span content budget in-band.
Messages, system instructions, tool definitions and payloads, exception messages,
and stack traces share the pool. A reserve leaves room for response content.

Payloads remain valid JSON. Oldest messages drop first behind a `role: "flue"`
sentinel; oversized strings end with a `[flue:truncated, ...]` suffix. There are
no side-channel truncation marker attributes; search payload content for
`[flue]`.

Object-shaped tool arguments and results use `gen_ai.tool.call.*`; other shapes
use `flue.tool.call.arguments` or `flue.tool.call.result` under the same policy.

### Metrics and logs

The adapter emits client-operation, token-usage, agent-invocation, and
tool-duration histograms. Metric dimensions exclude execution IDs. Input token
totals include cache-read and cache-creation input tokens.

Logs require explicit Logger injection. Failed inference emits the standard
`gen_ai.client.operation.exception` event at WARN/13. Error type is always
recorded. Exception message and stack trace follow the content gate. Missing
Logger injection does not affect traces or metrics.

### Propagation and recovery

Flue validates and persists `traceparent` and optional `tracestate` at direct-agent
admission. Baggage is not persisted. Durable processing activates the extracted
admission context. `dispatch(...)` does not currently propagate trace context.

Recovery does not replay provider or tool execution. Stored stream chunks create
no chat spans or usage observations; synthetic interrupted-tool repairs create no
`execute_tool` spans.

### Explicitly unsupported operations

Flue does not invent spans for agent creation, planning, embeddings, retrieval,
memory operations, remote agent clients, or evaluations.

## Recommended patterns

- Configure SDK, exporter, credentials, and sampling before Flue instrumentation.
- Register exactly one instrumentation instance.
- Default to `content: false` unless the backend is cleared for conversation data.
- Test transforms against prompts, tools, errors, stacks, and oversized payloads.
- Control metric cardinality in application-owned agent, tool, provider, and model names.
- Use an in-memory exporter for contract tests.
- Flush the SDK only after disposing externally owned Flue instrumentation.

## Avoid

- Do not assume the adapter configures an SDK, exporter, sampler, or credentials.
- Do not call `instrument(...)` casually; it is explicit consent to default content export.
- Do not derive streaming latency from semantic deltas or recovered chunks.
- Do not treat `gen_ai.conversation.id` as a submission or trace id.
- Do not expect baggage or `dispatch(...)` context propagation.
- Do not invent spans for unsupported operation boundaries.
- Do not update convention or projection revisions without compatibility review.

## Gotchas

### Privacy and content

Default spans can include model messages, reasoning, system instructions, tool
definitions, arguments and results, exception messages, and stack traces. Review
backend retention and access before registration. The explicit `instrument(...)`
call is Flue's consent boundary, unlike the wider convention's env-var opt-in.

### Lifecycle

Disposing Flue registration and flushing the SDK/exporter are separate actions.
Generated Node app lifecycle manages only registrations created while evaluating
`app.ts`; externally registered instrumentation remains application-owned.

### Sampling

The adapter supplies no sampling setting. Configure sampling in the application-owned
OpenTelemetry SDK. Do not add a fictional Flue sampling environment variable.

### Eval and streaming stability

Evaluations intentionally produce no invented spans. Pi does not expose
authoritative raw provider stream-item timing, so Flue omits time-to-first-chunk
and time-per-output-chunk metrics instead of emitting unstable approximations.

## Related

- [Observability](https://flueframework.com/docs/guide/observability/)
- [Cloudflare tracing adapter](https://flueframework.com/docs/guide/cloudflare-target/#createcloudflaretracing)
- [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
- [Sentry](https://flueframework.com/docs/ecosystem/tooling/sentry/)
- `advanced_observability.md`
