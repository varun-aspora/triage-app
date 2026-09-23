---
title: Braintrust
source: https://flueframework.com/docs/ecosystem/tooling/braintrust/
source_command: bunx flue docs read ecosystem/tooling/braintrust
flue_version: 2.0.8
section: ecosystem/tooling
---

# Braintrust

## Purpose and selection

The Braintrust integration traces Flue agent operations, model turns, tools,
delegated tasks, and context compactions. Select it when Braintrust should receive
content-bearing execution traces and nested spans from either Node.js or
Cloudflare.

The generated manual observer is the portable path for a project that may target
either runtime. Braintrust also provides a Node import hook for Node-only
auto-instrumentation, but that is not what the blueprint generates.

Use eval tooling, not Braintrust traces alone, when the requirement is assertions,
judges, or CI gates.

## Prerequisites and environment

| Variable | Requirement and purpose |
| --- | --- |
| `BRAINTRUST_API_KEY` | Required for trace export; authenticates Braintrust. |
| `BRAINTRUST_PROJECT_NAME` | Optional destination project; defaults to `Flue`. |

- Keep `BRAINTRUST_API_KEY` out of source control.
- On Cloudflare, store the key as a Worker secret, not a Wrangler `vars` value.
- Without the API key, the generated integration neither initializes nor subscribes.
- The application continues to run without trace export when the key is absent.

## How to

### 1. Apply the blueprint

Run the documented blueprint through Bun:

```sh
bunx flue add tooling braintrust
```

The blueprint creates a source-root `braintrust.ts` and imports it once from
`app.ts`. It installs Braintrust 3.17.

### 2. Configure export

Set `BRAINTRUST_API_KEY` in the deployment secret store. Optionally set
`BRAINTRUST_PROJECT_NAME`; otherwise traces go to a project named `Flue`.

### 3. Review the generated bridge

The generated module follows this shape:

```ts
import { observe } from '@flue/runtime';
import { braintrustFlueObserver, initLogger } from 'braintrust';

if (process.env.BRAINTRUST_API_KEY) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
    apiKey: process.env.BRAINTRUST_API_KEY,
  });

  observe((event, ctx) => {
    const compatible = compatibleEvent(event);
    if (compatible) braintrustFlueObserver(compatible, ctx);
  });
}
```

`compatibleEvent(...)` is generated but omitted from the documentation example.
It translates current Flue tool and recovery events for the installed Braintrust
version. Do not replace it with an invented implementation.

### 4. Apply a content policy

When content needs redaction, configure Braintrust's
`setMaskingFunction(...)` before initialization. Test the masker against
representative prompts, reasoning, tool data, errors, secrets, and personal data.

### 5. Verify end to end

Run an agent against a non-production Braintrust project and force at least one
model turn and one tool call. Confirm:

- the expected nested trace hierarchy;
- closed tool spans;
- usage data;
- Flue correlation fields;
- final-span delivery under a deployed Cloudflare isolate, when applicable.

## Current APIs and configuration

### Flue registration

```ts
import { observe } from '@flue/runtime';

const unsubscribe = observe((event, ctx) => {
  // The blueprint adapts the event before calling Braintrust.
});
```

The blueprint registers Braintrust's public `braintrustFlueObserver` through
Flue's `observe(...)` runtime event stream.

### Braintrust initialization

```ts
initLogger({
  projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
  apiKey: process.env.BRAINTRUST_API_KEY,
});
```

### Trace projection

| Flue activity | Braintrust span |
| --- | --- |
| Prompt, skill, or compaction operation | `flue.<kind>` task span |
| Model turn | `llm:<model>` span |
| Tool call | Nested `tool:<name>` span |
| Delegated task | Nested task span |
| Context compaction | Nested compaction span |

Model spans can include input, output, errors, usage metrics, token usage, and
estimated cost where available. Traces retain agent instance, session, operation,
and optional `submissionId` correlation.

### Runtime support

The same generated source runs on Node.js and Cloudflare through Braintrust's
`workerd` export. No separate Cloudflare package or Durable Object wrapper is
required.

## Recommended patterns

- Import the generated module once from `app.ts`.
- Leave the API-key guard in place so missing configuration disables export cleanly.
- Use a non-production Braintrust project for integration verification.
- Correlate traces with `submissionId` when it is present.
- Test masking with realistic content, not only simple strings.
- Verify Cloudflare delivery in a deployed Worker, not only in local development.
- Review the compatibility bridge before changing the Braintrust dependency.
- Treat instrumented environments as a cost decision: gate the `observe(...)`
  registration to staging/production (or behind your own agent/conversation
  filter) rather than tracing every environment at full volume, since Braintrust
  bills by logged trace volume and every model turn, tool span, and compaction
  is a write once the observer is installed.

## Avoid

- Do not commit `BRAINTRUST_API_KEY`.
- Do not put the API key in Cloudflare Wrangler `vars`.
- Do not remove `compatibleEvent(...)` without checking Braintrust compatibility.
- Do not assume the observer exports only metadata; it is content-bearing.
- Do not treat traces as eval cases, assertions, judges, or CI gates.
- Do not assume Cloudflare final-span delivery is guaranteed.
- Do not instrument a high-traffic agent at full volume without checking your
  Braintrust plan's ingestion limits first — a token-heavy agent (long
  transcripts, many tool calls) multiplies span count per conversation.

## Gotchas

### Privacy and content

The observer can export model messages and output, reasoning, system prompts,
tool definitions and values, task prompts and results, errors, and correlation
metadata. Review retention, access, privacy, and compliance before production use.

### Lifecycle and delivery

On Cloudflare, each generated agent Durable Object exports its own activity.
Braintrust flushes asynchronously, but Flue observers cannot attach the final
upload to the Durable Object execution lifetime. Export is best-effort and can
lose final spans when an isolate becomes idle immediately after work completes.
Node uses Braintrust's process-exit flush fallback.

### Version compatibility

Braintrust 3.17 expects the previous `tool_call` name for terminal tool events.
The generated bridge translates those events. Re-check that translation before
upgrading Braintrust.

### Sampling and eval stability

The Flue 2.0.8 bundled page documents no Braintrust sampling environment variable
or sampling configuration. Do not invent one in Flue configuration. Because there
is no built-in knob, cost control is an application-side decision: install the
observer only where you need trace-level detail, or filter events yourself
before calling `braintrustFlueObserver` (for example, skip routine turns and
only forward a sampled subset of conversations). Tracing also does not make
nondeterministic model behavior into a stable eval; use an eval harness with
explicit cases and assertions for regression decisions.

## Related

- [Observability](https://flueframework.com/docs/guide/observability/)
- [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
- [Sentry](https://flueframework.com/docs/ecosystem/tooling/sentry/)
- [Vitest Evals](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)
- `advanced_observability.md`
- `advanced_evals.md`
