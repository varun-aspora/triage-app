---
title: Vitest Evals
source: https://flueframework.com/docs/ecosystem/tooling/vitest-evals/
source_command: bunx flue docs read ecosystem/tooling/vitest-evals
flue_version: 2.0.8
section: ecosystem/tooling
---

# Vitest Evals

## Purpose and selection

The `vitest-evals` blueprint adds repeatable agent evals to a Flue project. It
uses Vitest harnesses, judges, normalized reports, and CI reporting while driving
the same public HTTP boundary as a deployed application.

Select it when evals should run as a test suite with assertions or judges. Select
Jetty when a separately deployed grading runbook and comparable persisted
trajectories are the intended result. Braintrust tracing can run independently,
but traces do not replace eval cases, assertions, judges, or CI gates.

## Prerequisites and environment

- The Flue application must mount the evaluated agent in `app.ts` with
  `createAgentRouter(...)`.
- The running server needs the application's normal model-provider credentials.
- `FLUE_BASE_URL` optionally points the generated harness at a deployment.
- A protected target needs a token or request headers configured in the SDK client.
- Provider and application credentials must not be committed.

The blueprint installs the test dependencies and creates a dedicated eval
configuration. It does not mount an agent automatically.

## How to

### 1. Apply the blueprint

```sh
bunx flue add tooling vitest-evals
```

The blueprint guides the coding agent through:

- installing test dependencies;
- creating a dedicated eval configuration;
- adapting the public Flue SDK to a `vitest-evals` harness;
- writing a starter case for behavior already defined by the application.

### 2. Confirm routing and authentication

Check that `app.ts` mounts the intended agent with `createAgentRouter(...)`.
Review authentication middleware before sending eval traffic over HTTP. Configure
the generated `@flue/sdk` client with the needed token or headers for a protected
target.

### 3. Start the application

In one terminal:

```sh
bunx vite dev
```

Wait until the server is ready. The eval process does not start or mount the
application for you.

### 4. Run the eval suite

In another terminal:

```sh
bun run evals
```

To evaluate a deployment:

```sh
FLUE_BASE_URL=https://preview.example.com bun run evals
```

### 5. Inspect reports

The blueprint adds compact terminal output, detailed tool and usage output, and a
JSON artifact. Open `vitest-results.json` locally with:

```sh
bunx vitest-evals serve vitest-results.json
```

The same artifact can be published with the `getsentry/vitest-evals` GitHub
Action after its content has been approved for upload.

## Current APIs and configuration

### Public boundary

The generated harness uses:

```ts
createFlueClient({ url });
```

from `@flue/sdk`. It does not import Flue runtime internals.

### Per-case behavior

For each eval case, the generated harness:

- creates a fresh conversation id;
- prompts the mounted agent conversation through `@flue/sdk`;
- captures the prompt event sequence using its server-provided offset;
- scopes capture to the submission ID;
- records response text;
- records model usage and costs;
- records tool calls in the normalized eval result.

### Base URL

`FLUE_BASE_URL` selects a local server or deployed application. The value is a
base URL, not the full per-conversation URL; the generated harness creates fresh
conversation identities.

### Blueprint command

```sh
bunx flue add tooling vitest-evals
```

### Reports

The JSON report can contain prompts, outputs, tool arguments and results, errors,
and application metadata. The bundled page names `vitest-results.json` in the
local report command.

### Braintrust boundary

`vitest-evals` has no Braintrust reporter. Flue's Braintrust integration can trace
application execution independently, but that trace stream is not an eval report.

## Recommended patterns

- Write the starter case around behavior the application already defines.
- Give every case a fresh conversation, as the generated harness does.
- Keep eval configuration separate from ordinary unit-test configuration.
- Exercise the public HTTP route to include routing and authentication behavior.
- Point `FLUE_BASE_URL` at a preview deployment for deployed-boundary checks.
- Inspect tool calls, usage, and cost as well as response text.
- Prefer deterministic assertions where behavior can be checked exactly.
- Review JSON report content before CI publication.
- Budget judge-model spend separately from agent-model spend: an LLM-backed
  judge (`FactualityJudge`, a custom `createJudge`) is a second live model call
  per case, on its own judge harness, in addition to the agent-under-test's own
  turns — pick a cheaper/faster judge model where rubric quality allows it.

## Avoid

- Do not assume the blueprint mounts an agent.
- Do not run HTTP evals before the local server is ready.
- Do not bypass target authentication unintentionally.
- Do not reuse a conversation across independent cases.
- Do not commit model-provider or application credentials.
- Do not upload `vitest-results.json` without privacy review.
- Do not substitute Braintrust traces for assertions or judges.
- Do not treat model-based grading as deterministic.
- Do not gate every merge on a judge-heavy suite without weighing its cost and
  latency — reserve deterministic assertions and cheap judges for merge-time
  gating, and run expensive judge-graded suites on a schedule or on demand.

## Gotchas

### Privacy and content

Reports may contain prompts, model outputs, tool arguments, tool results, errors,
and application metadata. Review retention, access, privacy, and compliance
requirements before publishing an artifact or evaluating production content.

### Lifecycle

The server and eval runner are separate processes in the documented workflow.
Start the application first, keep its provider credentials in the server
environment, then run evals. For a deployment, only the eval runner is local.

### Sampling

The bundled page documents no eval sampling configuration. Each selected eval
case drives the agent. Tracing sample rates in Sentry or another observability
provider do not define which eval cases run.

### Eval stability

Fresh conversation ids prevent state leakage between independent cases. The
server-provided offset and submission ID constrain event capture to the prompt
being evaluated. Use deterministic assertions for exact behavior and judges only
where semantic grading is required; live-model results can still vary.

### Judge-model cost

A judge is not free scoring — it is another billed inference call, run through
the judge harness, for every case that uses one. A suite with many judge-graded
cases can roughly double (or more) the token spend and wall-clock time of a
purely deterministic suite, and that cost compounds with CI frequency. Reserve
judges for behavior that cannot be checked with a plain `expect(...)`, and treat
the judge harness's model choice as an independent cost/quality tradeoff from
the model under test.

## Related

- [Evals](https://flueframework.com/docs/guide/evals/)
- [Agent SDK](https://flueframework.com/docs/sdk/overview/)
- [vitest-evals documentation](https://vitest-evals.sentry.dev/docs)
- [vitest-evals example](https://github.com/withastro/flue/tree/main/examples/vitest-evals)
- [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
- [Jetty](https://flueframework.com/docs/ecosystem/tooling/jetty/)
- `advanced_evals.md`
