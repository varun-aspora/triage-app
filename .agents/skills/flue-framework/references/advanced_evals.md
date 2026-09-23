---
title: Evals
source: https://flueframework.com/docs/guide/evals/
nav_section: Advanced
---

# Evals

## What it is

An eval is an automated test that runs an agent against a **live model** and asserts on its observable behavior: the reply text, the tools it called, the structured data it emitted. Unit tests cover the code you wrote (a tool's `run` function is a plain function); evals cover the model's contribution — whether the agent picks the right tool, follows instructions, and answers correctly.

Flue has no dedicated eval framework. An eval is a [Vitest](https://vitest.dev) test that drives an agent through the same public surfaces any other caller uses: the in-process `init()` handle, or the HTTP conversation surface via `@flue/sdk`. The `vitest-evals` integration layers harnesses, judges, and CI reporting on top.

Two properties shape how they're written:

- **Nondeterministic.** Same input can produce different wording, different tool order, occasionally a different outcome. Assert on the behavioral contract — required tool calls, key facts, shape of structured data — not exact output strings.
- **They spend real tokens and real time.** Every case runs one or more live model turns. Evals live in their own suite with their own config, credentials, timeouts, and run cadence.

## API surface

Nothing is exported specifically for evals. The page uses existing public APIs:

| Symbol | Package | Role in an eval |
| --- | --- | --- |
| `start(options): Promise<Flue>` | `@flue/runtime/node` | Boots the runtime inside the test process. `flue.stop()` shuts it down. |
| `init(agent, options?): AgentInstanceHandle` | `@flue/runtime` | Addresses a conversation. No `id` → fresh unique instance. |
| `handle.dispatch(message): Promise<DispatchReceipt>` | `@flue/runtime` | Fire-and-forget send; resolves at admission. |
| `handle.read(receipt, { onEvent, signal }): Promise<AgentReply>` | `@flue/runtime` | Awaits settlement. Rejects with `AgentRunError` on `failed`/`aborted`. |
| `createFlueClient({ url, token?, headers? })` | `@flue/sdk` | HTTP conversation client; URL = mount URL + conversation id. |
| `conversation.send({ message })` / `.wait(admission)` / `.history()` | `@flue/sdk` | Admit, await completion, read finished messages. |
| `describeEval(name, { harness, judgeHarness? }, (it) => …)` | `vitest-evals` | Binds a harness to a suite; each case gets `run(...)`. |
| `toolCalls(result)` | `vitest-evals` | Tool calls from a normalized result; `.name` per call. |
| `toSatisfyJudge(judge, { expected, threshold })` | `vitest-evals` | Expect matcher for judge scoring. |
| `FactualityJudge()`, `ToolCallJudge()`, `StructuredOutputJudge()` | `vitest-evals` | Built-in rubrics. |
| `createJudge(...)` | `vitest-evals` | Custom judges, deterministic or LLM-backed. |
| `createFlueAgentHarness({ agentUrl })` | generated `src/evals/harness.ts` | Blueprint-generated harness driving `@flue/sdk`. |

Assertion targets on `AgentReply`:

- `reply.text` — final assistant text.
- `reply.data` — named `useDataWriter` parts, keyed by part name, each an array of writes in order. The place to assert on structured results.

`read()`'s `onEvent` receives every conversation chunk as it is recorded; `tool-input` chunks carry `toolName` and `input`.

### File conventions

- Eval files: `src/evals/**/*.eval.ts`, named for the capability or scenario — `service-health.eval.ts`, `refund-policy.eval.ts` — **not** one file per agent.
- Dedicated Vitest config: `vitest.evals.config.ts`.
- Blueprint-generated harness: `src/evals/harness.ts`.
- CLI: `flue add tooling vitest-evals`.
- Env vars used in the docs: `FLUE_AGENT_URL` (evals guide, full mount URL), `FLUE_BASE_URL` (blueprint-generated setup, base URL).

## Setting up the suite

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/evals/**/*.eval.ts'],
    testTimeout: 60_000,
  },
});
```

`60_000` replaces Vitest's 5-second default, which a single live model turn can exceed.

```json
{
  "scripts": {
    "evals": "vitest run --config vitest.evals.config.ts"
  }
}
```

## Pattern: in-process eval with `start()` + `init()`

Most direct way — boots the runtime in the test process, no server, no build.

```ts
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { afterAll, expect, it } from 'vitest';
import { ServiceStatus } from '../agents/service-status.ts';

const flue = await start({ agents: [ServiceStatus] });
afterAll(() => flue.stop());

it('checks live service status before answering', async () => {
  const toolsCalled: string[] = [];

  // No id: init() mints a fresh conversation for this case.
  const agent = init(ServiceStatus);
  const receipt = await agent.dispatch('Is the checkout service currently operational?');
  const reply = await agent.read(receipt, {
    onEvent: (chunk) => {
      if (chunk.type === 'tool-input') toolsCalled.push(chunk.toolName);
    },
  });

  expect(reply.text).toContain('operational');
  expect(toolsCalled).toContain('get_service_status');
});
```

- **Fresh conversation per case.** `init(agent)` with no `id` addresses a new, uniquely named conversation, so cases stay independent.
- **Multi-turn memory cases** reuse one handle and send several `dispatch(...)`/`read(...)` pairs through it.
- Hooks, durability, and sandboxes behave exactly as in a server — `start()` is the same assembly without an HTTP surface.

## Pattern: eval over HTTP with `@flue/sdk`

Exercises the agent **plus** `app.ts` routing and middleware — the same boundary a deployed app serves. A fresh conversation is a fresh id appended to the mount URL.

```ts
import { createFlueClient } from '@flue/sdk';
import { expect, it } from 'vitest';

// The agent's mount URL from app.ts; point FLUE_AGENT_URL at a deployment.
const mountUrl = process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:5173/agents/service-status';

it('checks live service status before answering', async () => {
  const conversation = createFlueClient({
    url: `${mountUrl}/eval-${crypto.randomUUID()}`,
  });

  const admission = await conversation.send({
    message: { kind: 'user', body: 'Is the checkout service currently operational?' },
  });
  await conversation.wait(admission);

  const { messages } = await conversation.history();
  const reply = messages.findLast((message) => message.role === 'assistant');
  const text =
    reply?.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('') ?? '';

  expect(text).toContain('operational');
});
```

Prompts are fire-and-forget over HTTP: `send()` admits, `wait()` awaits completion, `history()` returns the finished conversation including assistant reply and tool-call parts. When the route is protected, pass `token` or `headers` to `createFlueClient(...)`.

## Pattern: vitest-evals harness

```sh
flue add tooling vitest-evals
```

The blueprint installs test deps, creates the eval config and scripts, generates `src/evals/harness.ts` (one conversation per case through `@flue/sdk`, converting reply + tool calls + usage into the normalized `vitest-evals` result), and writes a starter case.

```ts
import { expect } from 'vitest';
import { describeEval, toolCalls } from 'vitest-evals';
import { createFlueAgentHarness } from './harness.ts';

const harness = createFlueAgentHarness({
  agentUrl: process.env.FLUE_AGENT_URL ?? 'http://127.0.0.1:5173/agents/service-status',
});

describeEval('service status agent', { harness }, (it) => {
  it('checks live service status before answering', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    expect(result.output).toContain('operational');
    expect(toolCalls(result).map((call) => call.name)).toContain('get_service_status');
  });
});
```

The generated harness gives each case a fresh conversation id, captures the prompt's event sequence using its server-provided offset and submission ID, and records response text, model usage, costs, and tool calls.

## Pattern: judges for semantic behavior

Deterministic assertions cover exact contracts (required tools, prohibited tools, structured output, stable content). For factual consistency, tone, or policy adherence, use judges — scorers that grade a result and fail the case below a threshold. LLM-backed judges run on a separate **judge harness** with its own model connection.

```ts
import { expect } from 'vitest';
import { describeEval, FactualityJudge } from 'vitest-evals';

describeEval('service status agent', { harness, judgeHarness }, (it) => {
  it('reports status consistent with the reference answer', async ({ run }) => {
    const result = await run('Is the checkout service currently operational?');

    await expect(result).toSatisfyJudge(FactualityJudge(), {
      expected: 'The checkout service is currently operational.',
      threshold: 0.6,
    });
  });
});
```

Prefer deterministic assertions first; add a judge only where the behavior cannot be checked exactly.

## Recommended use cases

- Verifying the agent calls a required tool before answering (`get_service_status` before claiming a service is up).
- Verifying a policy is followed — e.g. a refund-policy agent refuses out-of-window refunds.
- Asserting on structured output written via `useDataWriter`, read back from `reply.data`.
- Regression-gating a prompt or model change: run the suite on merge or on a schedule.
- Evaluating conversation memory across turns (reuse one `init()` handle, several dispatch/read pairs).
- Evaluating the deployed boundary including auth middleware — point the HTTP suite at a preview deployment.

## When to use / when not to use

**Use an eval when** the thing under test depends on the model: tool selection, instruction adherence, answer correctness, tone, policy.

**Do not use an eval when**:

- You are testing a tool's `run` function. That is a plain function — unit-test it directly with `bun test`/Vitest, no model involved. See [Tools](https://flueframework.com/docs/guide/tools/).
- You want production visibility into what an agent did. That is [Observability](https://flueframework.com/docs/guide/observability/) / tracing, not an eval. Braintrust traces do **not** replace eval cases, assertions, judges, or CI gates.
- The check is exact and mechanical. Use a deterministic `expect(...)`, not a judge.

**Choosing a surface:**

- **In-process (`start()` + `init()`)** — exercises the agent itself: instructions, model, hooks, tools. Needs provider credentials in the test environment. No server needed.
- **HTTP (`@flue/sdk`)** — exercises the agent *plus* `app.ts` routing and middleware. Needs a running dev server or a deployment.

Both are public APIs, so they also serve as the integration point for other eval libraries and hosted platforms such as [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/) — drive the agent the same way, hand the result to your own scoring pipeline.

## Gotchas and constraints

- **One runtime per process.** Call `start()` once per test file and stop it when the file finishes. Vitest's default isolation gives each test file its own worker, which keeps files from colliding.
- **Credentials come from the test process environment** for in-process evals (see [Models — Provider credentials](https://flueframework.com/docs/guide/models/#provider-credentials)). For HTTP evals, the *server* process needs them.
- **Build-resolved imports break in-process evals.** The eval imports the agent module directly, so the module must load under plain Vitest. An agent that depends on build-resolved imports — such as a [SKILL.md import](https://flueframework.com/docs/guide/skills/#import-and-mount-a-skill) — needs the Flue build and should be evaluated over HTTP instead.
- **`start()` is `@flue/runtime/node`.** In-process evals are a Node-side surface; HTTP evals are how you reach a Cloudflare deployment.
- **The eval process does not start the application.** For HTTP suites, run `vite dev` (or the built server) in another terminal, or point the URL at a deployment.
- **Failed/aborted runs reject.** `read()` rejects with `AgentRunError` (`outcome: 'failed' | 'aborted'`), which fails the test.
- **Default Vitest timeout is too short.** A single live model turn can exceed 5s; set `testTimeout`.
- **Reports contain sensitive data.** `vitest-results.json` can contain prompts, outputs, tool arguments and results, errors, and application metadata. Review retention and access requirements before uploading.
- **The blueprint does not mount an agent.** Confirm `app.ts` mounts it with `createAgentRouter(...)` and that its auth middleware is appropriate before evaluating over HTTP.
- **Never commit provider or application credentials.**

## Running locally and in CI

```sh
pnpm run evals
```

HTTP suites need a reachable target:

```sh
FLUE_AGENT_URL=https://preview.example.com/agents/service-status pnpm run evals
```

In CI an eval suite is an ordinary Vitest run — it exits non-zero on failure, so it gates a pipeline like any other test job. Keep it as a **separate job** from unit tests: live-model runs are slower, spend tokens, and can fail without a code change, so they warrant their own cadence (on merge, on a schedule, or on demand). Credentials come from CI secrets; for HTTP suites, either build and start the app inside the job or target a preview [deployment](https://flueframework.com/docs/guide/deploy/).

Reporting: the blueprint adds an `evals:json` script writing `vitest-results.json`.

```sh
pnpm exec vitest-evals serve vitest-results.json
```

Publish from CI with the `getsentry/vitest-evals` GitHub Action.

## Related

- [Vitest Evals (ecosystem)](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/) — blueprint, generated harness, report commands.
- [Agents — standalone scripts](https://flueframework.com/docs/guide/building-agents/#standalone-scripts) — `start()`.
- [Agent API — `init()`](https://flueframework.com/docs/reference/agent-api/#init) — full handle contract, `AgentReply`, `AgentRunError`.
- [Agent SDK — flue client](https://flueframework.com/docs/sdk/flue-client/) — `send()`, `wait()`, `history()`.
- [Observability](https://flueframework.com/docs/guide/observability/) — `submissionId` and conversation id connect a failing case to the execution that produced it.
- [Routing — protecting your agents](https://flueframework.com/docs/guide/routing/#protecting-your-agents)
- [Tools](https://flueframework.com/docs/guide/tools/) — unit-testable `run` functions.
- [Deploy](https://flueframework.com/docs/guide/deploy/)
- [vitest-evals upstream docs](https://vitest-evals.sentry.dev/docs)
- [examples/vitest-evals](https://github.com/withastro/flue/tree/main/examples/vitest-evals)
