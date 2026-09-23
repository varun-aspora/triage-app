---
title: Sentry
source: https://flueframework.com/docs/ecosystem/tooling/sentry/
source_command: bunx flue docs read ecosystem/tooling/sentry
flue_version: 2.0.8
section: ecosystem/tooling
---

# Sentry

## Purpose and selection

The Sentry blueprint sends three Flue signals that share one trace per
conversation: terminal failures as issues, every `log.*` call as Sentry Logs,
and optional OpenTelemetry GenAI traces for agent, model, and tool activity.

Select Sentry when operational errors, logs, and sampled AI traces should live in
one Sentry project. Select the direct OpenTelemetry adapter when the application
must own a different SDK/exporter backend. Use eval tooling for assertions and
regression gates; Sentry traces do not replace eval cases.

## Prerequisites and environment

| Variable | Requirement and purpose |
| --- | --- |
| `SENTRY_DSN` | Required for delivery; identifies the project and permits submission. |
| `SENTRY_ENVIRONMENT` | Optional deployment environment. |
| `SENTRY_RELEASE` | Optional deployed release. |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional `0` to `1`; default `0`. |
| `SENTRY_AI_RECORD_INPUTS` | Optional `true`; includes input-side AI content in spans. |
| `SENTRY_AI_RECORD_OUTPUTS` | Optional `true`; includes output-side AI content in spans. |

Only `SENTRY_DSN` is required to deliver events. A DSN permits event submission
but does not grant read access to project data. Keep it in deployment
configuration or a secret binding so it can be rotated and abuse mitigated.

## How to

### 1. Apply the blueprint

```sh
bunx flue add tooling sentry
```

The blueprint creates a source-root `sentry.ts`, imports it once from `app.ts`,
installs `@sentry/node` or `@sentry/cloudflare` for the target, and installs
`@flue/opentelemetry`.

### 2. Configure delivery and sampling

Set `SENTRY_DSN`. Leave `SENTRY_TRACES_SAMPLE_RATE=0` to send errors and logs
without AI traces, or set a value above zero to emit the Flue span hierarchy.
The generated code clamps the configured trace sample rate to `0` through `1`.

Leave both AI record flags off unless input or output content is approved for
Sentry storage.

### 3. Keep the target-specific initialization

On Node.js, generated application source calls `Sentry.init(...)` at module scope.
On Cloudflare, it does not call `Sentry.init()`. Instead it wraps each generated
agent Durable Object with `instrumentDurableObjectWithSentry(...)`, allowing the
SDK to initialize from the current binding environment once per isolate.

### 4. Verify end to end

Against a non-production project, set `SENTRY_TRACES_SAMPLE_RATE=1` in the
application environment. Prompt a tool-using agent and confirm one trace containing `invoke_agent`, `chat`,
and `execute_tool` spans plus Sentry Logs. Trigger one terminal failure and
confirm exactly one issue with the original error and throw-site stack.

Also confirm:

- expected `flue.*` correlation fields;
- no model content while record flags are off;
- Cloudflare delivery from a wrapped agent, if applicable;
- successful application startup without a configured DSN.

## Current APIs and configuration

### Node initialization shape

```ts
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  tracesSampleRate,
  traceLifecycle: 'stream',
  streamGenAiSpans: true,
  enableLogs: true,
  integrations: (defaults) =>
    defaults.filter((i) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(i.name)),
});

if (tracesSampleRate > 0) {
  instrument(createOpenTelemetryInstrumentation({ content: contentPolicy() }));
}
```

`traceLifecycle: 'stream'` delivers GenAI children that outlive their parent.
Sentry's own AI provider integrations are suppressed so model calls are not
double-counted.

### Event bridge shape

```ts
instrument({
  key: Symbol.for('flue.sentry.bridge'),
  observe(event) {
    if (event.type === 'operation' && event.isError) {
      captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event));
      if (event.submissionId) capturedFailedSubmissions.add(event.submissionId);
      return;
    }
    if (event.type === 'submission_settled') {
      // Capture only failures not already captured from their operation.
    }
    if (event.type === 'log') {
      Sentry.logger[event.level](event.message, logAttributes(event));
    }
  },
  interceptor: (_operation, _ctx, next) => next(),
  async dispose() {
    await Sentry.flush(2000);
  },
});
```

The symbolic key lets development reloads replace the bridge rather than stack
duplicate registrations.

### Signal behavior

| Signal | Generated behavior |
| --- | --- |
| Issues | Failed terminal operations and uncaptured failed settlements, once per failure. |
| Logs | Every `log.info`, `log.warn`, and `log.error` at its own level. |
| Traces | Flue OTel hierarchy when trace sample rate is above zero. |

Recoverable error logs are logs, not issues. Captures include `flue.*` tags for
agent instance, agent name, conversation, session, operation, and submission.

With record flags off, spans retain timing, token usage, model identifiers, and
correlation ids but omit message and tool content. Enabling a direction routes
its content through a scrubbing transform with a 16 KiB per-attribute budget.

### Target packages

- Node.js uses `@sentry/node` and module-scoped `Sentry.init(...)`.
- Cloudflare uses `@sentry/cloudflare` and a wrapped generated Durable Object.
- Never use `@sentry/node` on Cloudflare.

## Recommended patterns

- Start with trace sampling at zero and both content flags off.
- Make sampling and content recording separate data-handling decisions.
- Treat `SENTRY_AI_RECORD_INPUTS`/`SENTRY_AI_RECORD_OUTPUTS` as a data
  classification decision, not a debugging convenience — agent transcripts can
  carry customer names, account identifiers, and other PII the model saw or
  produced, so redact it in the scrubbing transform before enabling either flag
  rather than relying on the 16 KiB per-attribute budget to limit exposure.
- Keep the generated duplicate-failure suppression.
- Preserve the symbolic instrumentation key for development reloads.
- Verify exactly one issue per terminal failure.
- Verify Cloudflare behavior in deployed workerd.
- Add separate request middleware when outer Worker or authored Hono tracing is needed.

## Avoid

- Do not use `@sentry/node` on Cloudflare.
- Do not initialize the Cloudflare SDK like the Node SDK.
- Do not enable input or output recording without explicit approval.
- Do not re-enable Sentry AI provider integrations and double-count model calls.
- Do not convert every error log into an issue.
- Do not assume the Durable Object wrapper covers the outer Worker or Hono app.
- Do not rely on shutdown flush as an absolute delivery guarantee.

## Gotchas

### Privacy and content

The record flags govern model and tool content in trace spans. Input recording
includes prompts, instructions, tool definitions, and arguments. Output recording
includes model output, tool results, exception messages, and stacks. Terminal
issues still capture the original error and throw-site stack; logs are also sent.
Review all three signal types, not only trace content flags.

### Sampling

At the default `SENTRY_TRACES_SAMPLE_RATE=0`, Sentry sends errors and logs only.
A value above zero adds AI traces. Sampling does not enable content; the input and
output flags remain independent and default off.

### Lifecycle and target boundaries

Node module initialization is enough for bridge captures and Flue spans. Full
Sentry HTTP or database auto-instrumentation requires Sentry preload setup before
application imports and must be verified against the built server.

On Node, SIGINT/SIGTERM listeners call `Sentry.flush(...)` without owning process
exit. Traces and issues sent during the run are safe, but very recently buffered
logs can be cut short. On Cloudflare, wrapping applies to generated agent Durable
Objects, not the outer Worker or an authored Hono application.

### Eval stability

Sentry supplies telemetry, not a stable grading contract. Sampled traces can be
absent by design and must not be used as the sole pass/fail source for evals.

## Related

- [Observability](https://flueframework.com/docs/guide/observability/)
- [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
- [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
- [Vitest Evals](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)
- `advanced_observability.md`
- `advanced_evals.md`
