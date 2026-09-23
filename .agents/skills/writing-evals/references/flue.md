# Evals in Flue

Read this when the agent under test is a Flue agent. Verify against the
installed version — this describes the surface documented in September 2026,
and `flue docs search evals` prints the bundled docs for the version you have.

Flue ships no eval framework. An eval is a Vitest test that drives the agent
through a public surface and asserts on the result. What Flue gives you is two
surfaces and a blueprint that wires one of them to `vitest-evals`.

## Suite setup

Evals get their own Vitest config. Live-model runs need different file
discovery, a much longer timeout, and different credentials than unit tests,
and keeping them separate means `pnpm test` stays fast and free.

```ts title="vitest.evals.config.ts"
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/evals/**/*.eval.ts'],
    reporters: ['default', 'vitest-evals/reporter'],
    testTimeout: 60_000,
  },
});
```

The `60_000` replaces Vitest's 5-second default, which a single model turn
beats regularly.

```json title="package.json"
{
  "scripts": {
    "evals": "vitest run --config vitest.evals.config.ts",
    "evals:json": "vitest run --config vitest.evals.config.ts --reporter=vitest-evals/reporter --reporter=json --outputFile.json=vitest-results.json"
  }
}
```

Name eval files for the capability or scenario they cover —
`refund-policy.eval.ts`, `service-health.eval.ts` — not one file per agent.
Scenarios are how you will think about coverage; agents are not.

To run each case several times for pass@k / pass^k, use Vitest's `repeats`
(config or `--repeats`). Budget for it: `repeats: 3` triples the bill.

## Choosing a surface

| | In-process | HTTP |
| --- | --- | --- |
| Entry | `start()` from `@flue/runtime/node`, then `init()` | `createFlueClient` from `@flue/sdk` |
| Covers | Instructions, model, hooks, tools, sandboxes, durability | All of that plus `app.ts` routes and middleware |
| Needs | Provider credentials in the test process | A running `vite dev` or a deployment |
| Structured data | `reply.data` directly | Only what your harness extracts |
| Fails on | Build-resolved imports, e.g. a mounted `SKILL.md` | — |

In-process is the faster loop and the better debugger. HTTP is what the
blueprint uses and what you want for anything that ships, because it exercises
the same boundary a real caller hits — including your auth middleware.

## In-process evals

```ts title="src/evals/service-health.eval.ts"
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

What each piece buys you:

- **`init(agent)` with no `id`** addresses a brand-new conversation, which is
  how cases stay isolated. A case that deliberately evaluates memory reuses one
  handle across several `dispatch`/`read` pairs.
- **`reply.text`** is the final assistant text. **`reply.data`** carries named
  `useDataWriter` parts, typed `Record<string, unknown[]>` — assert on this
  rather than parsing prose whenever the agent emits structured results.
- **`onEvent`** receives every conversation chunk; `tool-input` chunks carry
  `toolName` and `input`, so argument assertions come from here too.
- A failed or aborted run rejects `read()` with `AgentRunError`, which fails
  the test on its own. You do not need a try/catch to notice a crash.

Three constraints:

1. **One Flue runtime per process.** Call `start()` once per test file and stop
   it in `afterAll`. Vitest's default per-file worker isolation keeps files
   from colliding; do not turn it off for this suite.
2. **Credentials come from the test process environment**, not from a server.
3. **The eval imports the agent module directly**, so it must load under plain
   Vitest. An agent that depends on build-resolved imports — a `SKILL.md`
   import is the usual one — needs the Flue build and has to be evaluated over
   HTTP instead. If a module that works in `vite dev` throws in the eval, this
   is why.

## HTTP evals

```ts title="src/evals/service-health.eval.ts"
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

Four things to get right:

- **Prompts are fire-and-forget.** `send()` only admits the message. You must
  `wait()` before `history()`, or you will read an empty conversation and
  assert against `''`. This is the most common way an HTTP eval fails
  confusingly.
- **The URL is the mount path from `app.ts`**, where
  `app.route('/agents/<name>', createAgentRouter(<AgentFn>))` puts it — not the
  agent's name, and not a guess at the port. Vite defaults to 5173 unless
  `vite.config.ts` says otherwise.
- **A fresh conversation is a fresh id appended to the mount URL.** Reuse an id
  only for a case that is about memory.
- **The eval run does not start your application.** Run `vite dev` in another
  terminal, or set `FLUE_AGENT_URL` to a deployment. Protected routes take
  `token` or `headers` on `createFlueClient(...)`.

## The vitest-evals harness

```sh
flue add tooling vitest-evals
```

This is a blueprint — it fetches an implementation guide for a coding agent to
follow rather than dropping a fixed file. It installs `@flue/sdk`, `vitest`,
and `vitest-evals` as dev dependencies, adds the config and scripts above, and
generates `src/evals/harness.ts`.

Do **not** install a `@vitest-evals/harness-*` package alongside it. Those
adapters wrap model runtimes (AI SDK, OpenAI Agents, Pi); the Flue harness
evaluates your deployed application over HTTP, which is a different thing.

The generated harness wraps `createHarness<string, string>` and, per `run(...)`:

- opens a conversation at `<agentUrl>/eval-<uuid>`,
- `send()` → `wait()` → `history()`,
- returns the last assistant message's text as `output`,
- flattens history into `vitest-evals` transcript events — a `message` event
  per turn, and a `tool_call` / `tool_result` pair for every `dynamic-tool`
  part,
- reports `usage` (tokens, cost, provider, model) if the agent published it.

That last point is the one that surprises people. See the gotchas below.

Cases then read as ordinary Vitest with a `run` fixture:

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
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });
});
```

Table-driven cases use Vitest's ordinary `it.for`, with the prompt in `input`
and expected values in the row that owns them:

```ts
describeEval('refund agent', { harness }, (it) => {
  it.for([
    { name: 'approves refundable invoice', input: 'Refund invoice inv_123',
      status: 'approved', tools: ['lookupInvoice', 'createRefund'] },
    { name: 'denies non-refundable invoice', input: 'Refund invoice inv_404',
      status: 'denied', tools: ['lookupInvoice'] },
  ])('$name', async (row, { run }) => {
    const result = await run(row.input);
    expect(toolCalls(result).map((c) => c.name)).toEqual(row.tools);
  });
});
```

Useful helpers from `vitest-evals`: `toolCalls(result)`, `assistantMessages`,
`userMessages`, `toolMessages`, `messagesByRole`, and `setArtifact(name, value)`
inside a custom harness for debug data that belongs in the report but not in
the output contract.

## Judges

Deterministic assertions first. Reach for a judge only where the behaviour is
genuinely semantic — factual consistency, tone, policy adherence.

`ToolCallJudge()` and `StructuredOutputJudge()` are deterministic despite the
name: expected tool names, order, argument constraints, and JSON output fields.
`FactualityJudge()` is model-backed and needs a judge harness.

```ts
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

The **judge harness is a separate model connection** from the agent under
evaluation. Keep it that way: it stops the agent grading itself, and the
reporter then accounts application tokens and judge tokens separately, so you
can see what the grading costs.

Custom judges are a name plus an `assess(ctx)` returning `{ score, metadata }`.
`ctx` gives you `input`, `output`, `session`, `toolCalls`, `run`, and
`runJudge` when a judge harness is configured. Put the rubric, the parsing, and
the threshold inside the judge and the provider call in the judge harness:

```ts
const RubricJudge = createJudge({
  name: 'RubricJudge',
  judgeHarness,
  async assess(ctx) {
    if (!ctx.runJudge) throw new Error('RubricJudge requires a judge harness.');
    const verdict = await ctx.runJudge({
      prompt: formatRubricPrompt(ctx),
      responseFormat: { type: 'json' },
    });
    return parseVerdict(verdict);
  },
});
```

Suite-level `judges: [...]` with `judgeThreshold` grades every case;
`toSatisfyJudge` grades one. `judgeThreshold: null` records the score without
failing the case — useful while you are still calibrating a new rubric.

## Gotchas

**Usage data does not exist unless the agent publishes it.** The harness reads
tokens, cost, and model off the reply's *agent-authored* message metadata. If
the agent has no `useResponseFinish` producer, `result.usage` is empty and the
cost column in your report is blank. Add it to any agent you intend to
evaluate:

```ts
const MODEL = 'anthropic/claude-haiku-4-5';
useModel(MODEL);
useResponseFinish(({ response }) => ({ usage: response.usage, model: MODEL }));
```

**A subagent's tool calls never reach the transcript.** Only the child's final
message comes back through `task`; intermediate reasoning, tool calls, and file
reads stay in the child's frame. So `toolCalls(result)` on a parent shows
`task` and nothing underneath it. To assert on a delegate's behaviour, mount it
as its own agent and give it its own eval suite. Evaluate the parent on whether
it delegated at all, how many times, and whether it synthesised correctly.

**`reply.data` is in-process only by default.** `useDataWriter` parts are on
`reply.data` from `init().read()`, but the generated HTTP harness only extracts
text and tool parts. If your contract is structured output, extend the harness
to pull the data parts into `output` — then `StructuredOutputJudge` and
`toMatchObject` work on a real object instead of a string you regexed.

**Harness tools (`useTool({ harness: true })`) have no separate entry point.**
Evaluate them through the conversation: send the message that triggers the
tool, then assert on the tool call and the final reply. Do not invent a direct
invocation path — it would not test the thing that breaks, which is the model
deciding to call it.

**One runtime per process** applies to in-process suites only. If two eval
files both call `start()` and you have disabled Vitest's file isolation, they
will fight.

## Tool replay

`vitest-evals` can record and replay *tool* responses while keeping model calls
live. That is the right split: external APIs stop costing money and stop being
flaky, and the eval stays sensitive to prompt and model changes, which is the
whole point.

Modes via `VITEST_EVALS_REPLAY_MODE`: `auto` (use a recording, record if
missing), `record` (always live, overwrite), `off`, `strict` (fail if no
recording). Configure per tool in the harness, with `key` reducing the cache
key to the arguments that matter and `sanitize` stripping secrets before the
fixture is committed:

```ts
toolReplay: {
  lookupInvoice: {
    version: 'v1',
    key: (args) => ({ invoiceId: args.invoiceId }),
    sanitize: (rec) => ({ ...rec, output: { status: rec.output.status } }),
  },
}
```

Review fixture diffs in the same PR as the change that caused them. A silently
re-recorded fixture is how an eval stops testing anything.

## Reporting and CI

`pnpm run evals:json` writes `vitest-results.json`. Inspect it locally with
`pnpm exec vitest-evals serve vitest-results.json` — a report UI for
transcripts, tool calls, scores, and separate application / judge token and
cost totals. This is the transcript-reading tool; use it.

In CI, an eval suite is an ordinary Vitest run that exits non-zero on failure,
so it gates like any other job. Keep it as a **separate job from unit tests**:
live-model runs are slow, cost money, and can fail without a code change, so
they want their own cadence — on merge, on a schedule, or on demand. Gate PRs
on the regression suite; run the capability suite on a schedule.

```yaml
- name: Run evals
  run: |
    pnpm exec vitest run --config vitest.evals.config.ts \
      --reporter=vitest-evals/reporter \
      --reporter=json \
      --outputFile.json=vitest-results.json

- uses: getsentry/vitest-evals@v0
  if: always()
  with:
    results: vitest-results.json
    publish-check: true
    min-pass-rate: 0.8
```

`min-pass-rate` and `min-score-average` are the aggregate floors — the right
gate for a nondeterministic suite, where insisting on 100% just teaches people
to rerun the job. Check Runs need `checks: write`.

Provider credentials for the agent belong to the server process; auth
credentials for a protected route belong to the SDK client. Neither gets
committed. And reports contain prompts, outputs, tool arguments, tool results,
and errors — check your data-retention rules before uploading them as CI
artifacts.

Sources: [Flue — evals](https://flueframework.com/docs/guide/evals/),
[Flue — vitest-evals integration](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/),
[Flue — agent API reference](https://flueframework.com/docs/reference/agent-api/),
[flue `examples/vitest-evals`](https://github.com/withastro/flue/tree/main/examples/vitest-evals),
[vitest-evals docs](https://vitest-evals.sentry.dev/docs/)
