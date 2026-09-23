---
title: Workflows
source: https://flueframework.com/docs/guide/workflows/
bundled_docs:
  - guide/workflows
  - guide/durability
  - reference/agent-api
  - cli/run
  - sdk/create-flue-client
  - sdk/flue-client
version: 2.0.8
reviewed: 2026-09-17
---

# Workflows

## What and when

A Flue workflow is ordinary program code that drives agents. It is a pattern, not a separate Flue runtime feature. Choose by where the agent runs and whether surrounding orchestration must survive interruption:

| Approach | Use when |
| --- | --- |
| `bunx flue run` | One local prompt/reply in a terminal or CI step. |
| `start()` plus `init()` | A local Node process owns the agent and needs loops or structured control flow. |
| `@flue/sdk` | Code addresses a deployed, mounted conversation over HTTP. |
| Durable workflow engine | Multiple steps, waits, and side effects must resume after process failure. |

Flue makes each admitted submission durable. It does not checkpoint arbitrary code before or after that submission. A durable workflow engine owns the outer control flow.

## Current API

### CLI

```text
flue run <path> --message <text> [--name <agent>] [--id <id>]
  [--data <json>] [--uid <uid> | --new] [--env <path>] [--json]
```

The CLI loads only the selected module and imports, never `app.ts`. It writes progress to stderr and the final reply or JSON envelope to stdout. Exit codes are `0` completed, `1` failed/setup error, and `130` aborted. `--new` is create-only for the conversation id; it is not arbitrary delivery idempotency.

### Local runtime and handle

```ts
import { init, type DispatchReceipt } from '@flue/runtime';
import { start } from '@flue/runtime/node';

interface StartOptions {
  agents: readonly (Agent | { agent: Agent; name?: string })[];
  db?: PersistenceAdapter;
  env?: Record<string, string | undefined>;
  providers?: readonly Provider[];
}

const handle = init(Agent, { id?: string, uid?: string | null });
const receipt = await handle.dispatch({
  message,
  initialData?,
  idempotencyKey?,
});
const reply = await handle.read(receipt, { signal?, onEvent? });
```

`init()` performs no I/O. `dispatch()` resolves at admission. `read()` waits for settlement and returns `{ text, data, metadata?, uid?, submissionId }`; it rejects with `AgentRunError` on failed or aborted settlement. A read can reattach later using a receipt or bare submission id.

### Hosted SDK

```ts
const conversation = createFlueClient({ url, token?, headers?, fetch? });
const admission = await conversation.send({ message, initialData?, uid?, signal? });
const reply = await conversation.read(admission);
```

The hosted SDK mirrors admission and settlement, but `FlueClient.send()`'s typed `AgentPromptOptions` do not expose `idempotencyKey` in 2.0.8 — that's an SDK-surface gap, not a wire-protocol one: the direct HTTP prompt body it posts to *does* accept a top-level `idempotencyKey` sibling (parsed and enforced identically to server-side `dispatch()`), so a caller who needs it over HTTP can post the raw body instead of going through the typed client. See `introduction_changelog.md` for the confirmed contract.

## How to

### One-shot CI job

```yaml
steps:
  - uses: oven-sh/setup-bun@v2
  - run: bun install --frozen-lockfile
  - run: >
      bunx flue run src/agents/triage.ts
      --message "Triage issue #${{ github.event.issue.number }}."
      --id "issue-${{ github.event.issue.number }}"
      --new --json > triage.json
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Use `--new` only when an existing conversation should fail admission. If a retried job should continue the existing conversation, omit it. The default `flue run` cache persists conversations under `node_modules/.cache/flue/run.db`; a configured `db.ts` replaces that default.

### Local scripted workflow

```ts
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Reporter } from '../src/agents/reporter.ts';

await using flue = await start({
  agents: [Reporter],
  db: sqlite('./data/nightly.db'),
});

const reporter = init(Reporter, { id: 'nightly-2026-09-17' });
const receipt = await reporter.dispatch({
  message: 'Produce the nightly report.',
  idempotencyKey: 'nightly-report:2026-09-17',
});
const reply = await reporter.read(receipt);
console.log(reply.text);
```

The stable key makes a retried delivery converge on the original submission. It is scoped to this agent and conversation id and must be at most 256 characters.

### Drive a deployed agent

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: `https://example.com/agents/release-auditor/release-${version}`,
  token: process.env.FLUE_TOKEN,
});

const admission = await conversation.send({
  message: { kind: 'user', body: `Audit release ${version}.` },
});
persistAdmission(admission);
const reply = await conversation.read(admission);
```

Persist the admission before depending on the reply. A replacement process can call `read(admission)` or `read(submissionId)`; if already settled it resolves immediately.

### Durable outer workflow

Checkpoint dispatch and read in separate workflow steps. Also give the server-side dispatch a deterministic idempotency key so the crash window between admission and receipt checkpointing cannot create a second submission:

```ts
type Params = { runId: string; date: string };

export class NightlyReview extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const findings = await step.do('collect findings', () =>
      collectFindings(event.payload.date),
    );

    const reviewer = init(Reviewer, { id: `nightly-${event.payload.date}` });
    const receipt = await step.do('dispatch review', () =>
      reviewer.dispatch({
        message: `Review these findings:\n${findings}`,
        idempotencyKey: `workflow:${event.payload.runId}:review`,
      }),
    );

    const review = await step.do('read review', async () => {
      const reply = await reviewer.read(receipt);
      return { text: reply.text, data: reply.data };
    });

    await step.do('file report', () => fileReport(event.payload.runId, review));
  }
}
```

Export a Cloudflare Workflow class as a named export from `src/cloudflare.ts` and declare its binding in `wrangler.jsonc`. The same split applies to Inngest `step.run` and Temporal activities.

When the workflow is a separate service, `@flue/sdk`'s typed `send()` has no `idempotencyKey` option, so it cannot pass one directly. If duplicate admission over HTTP is unacceptable, either post the direct prompt body yourself with a top-level `idempotencyKey` (the wire protocol accepts it even though the SDK's types don't), or expose a narrow authenticated application endpoint that accepts a logical delivery id and performs server-side `dispatch(..., { idempotencyKey })` — the latter is still preferable when you also want to restrict the caller to one action.

## Recommended patterns

- Persist or checkpoint the receipt immediately after admission.
- Use one deterministic `idempotencyKey` per logical server-side delivery, not per retry attempt.
- Key external effects on stable workflow ids, `submissionId`, `toolCallId`, or provider idempotency fields.
- Separate dispatch and read into different durable steps.
- Store a shared deadline in workflow state; separate step timeouts otherwise multiply the end-to-end bound.
- Pass a durable `db` to `start()` when a later process must reattach.
- Use the SDK only across a deployment boundary; call `init()` directly inside the same configured Flue runtime.

## Avoid

- Do not treat `dispatch()` or `send()` resolution as completion.
- Do not keep the only receipt in process memory.
- Do not use a fresh idempotency key on each retry.
- Do not assume `--new` returns a previous result; it rejects when the deterministic conversation already exists.
- Do not cancel a local `read()` and assume agent work stopped; call `abort()` for a durable abort.
- Do not call `read()` from a tool on a submission dispatched to the same currently running agent; that deadlocks at the turn boundary.

## Gotchas

- Delivery deduplication prevents a duplicate submission. The accepted submission still processes at least once, so external effects need their own idempotency.
- Reusing an idempotency key with a different payload rejects with `submission_conflict`; a failed keyed submission remains failed on replay.
- `start()` supports one runtime per process and does not discover `app.ts` or `db.ts`.
- Node reattachment across process exit requires a durable adapter. Cloudflare stores receipts and settlement in Durable Object SQLite.
- `flue run` sends a `kind: 'user'` message only; use programmatic dispatch for signals.
- `flue run` is Node-local; modules importing `cloudflare:*` require Cloudflare Vite dev instead.
- An outer workflow's final side effect needs the workflow engine's durability or its own idempotency; Flue does not checkpoint code after `read()`.

## Related

- [Durability](https://flueframework.com/docs/guide/durability/)
- [Agent API](https://flueframework.com/docs/reference/agent-api/)
- [FlueClient](https://flueframework.com/docs/sdk/flue-client/)
- [flue run](https://flueframework.com/docs/cli/run/)
- [Schedules](https://flueframework.com/docs/guide/schedules/)
- [Deploy](https://flueframework.com/docs/guide/deploy/)
