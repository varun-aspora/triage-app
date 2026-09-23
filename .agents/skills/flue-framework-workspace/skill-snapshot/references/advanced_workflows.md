---
title: Workflows
source: https://flueframework.com/docs/guide/workflows/
section: advanced
---

# Workflows

## What it is

In Flue, a "workflow" is any script or program that runs an agent — not a framework feature, just the name for driving agents from code instead of from a deployed chat surface. It covers one-shot CLI runs and CI jobs, standalone Node scripts, HTTP calls to a deployed agent via the Agent SDK, and hosted durable workflow engines (Cloudflare Workflows, Inngest, Temporal). Flue has no special integration with any durable engine: you write the workflow on your platform and call Flue from it like any other service.

## Choosing an approach

| Approach | When to use it |
| --- | --- |
| `flue run` | Initialize and prompt a local agent from the terminal. Best for CI workflows. |
| The Flue JS API (`start()` + `init()`) | Initialize and control a local agent from Node.js. Best for local scripting, cron jobs. |
| The Flue Agent SDK (`@flue/sdk`) | Initialize and control a hosted agent over HTTP. Best for talking/listening to deployed production agents. |
| Durable workflows | Control a hosted agent from a hosted runtime with durability guarantees. Best for multi-step orchestration and products that must survive interruption. |

These are not mutually exclusive — a durable workflow uses the same `start()`/`init()` API as a standalone script, and a CI job wraps the same `flue run` you'd type in a terminal.

## API surface

### `flue run` (CLI)

```bash
flue run <path> --message <text> [--name <agent>] [--id <id>] [--data <json>] [--uid <uid> | --new] [--env <path>] [--json]
```

- Loads the agent module in the local process, submits one message, prints the final reply to stdout, exits when the run settles. Exit code reports success (`0` completed, `1` failed/setup error, `130` aborted).
- Everything except the reply streams to stderr, so stdout stays pipeable.
- `--json` swaps the plain reply for a result envelope: `{ id, agent, submissionId, outcome, message, uid }`; on failure/abort it carries `error` instead of `message`.
- Conversations persist between invocations in the project's configured database, so reusing an `--id` continues one conversation across runs.
- `--new` plus a deterministic `--id` makes conversation creation exactly-once, so a retried job cannot double-create the conversation.

### Flue JS API (`@flue/runtime`, `@flue/runtime/node`)

```ts
function start(options: StartOptions): Promise<Flue>;   // from '@flue/runtime/node'

interface StartOptions {
  agents: readonly StartAgentEntry[];   // required, non-empty
  db?: PersistenceAdapter;              // default: in-memory SQLite (process lifetime)
  env?: Record<string, string | undefined>;  // default: process.env
  providers?: readonly Provider[];
}

interface Flue {
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

```ts
function init(agent: Agent, options?: InitOptions): AgentInstanceHandle;  // from '@flue/runtime'

interface InitOptions { id?: string; uid?: string | null }

interface AgentInstanceHandle {
  readonly id: string;
  dispatch(request: string | { message: DeliveredMessageInput; initialData?: unknown }): Promise<DispatchReceipt>;
  read(target: string | DispatchReceipt, options?: { onEvent?: (chunk: ConversationStreamChunk) => void; signal?: AbortSignal }): Promise<AgentReply>;
  abort(): Promise<void>;
}

interface DispatchReceipt { submissionId: string; acceptedAt: string; uid: string }

interface AgentReply {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
  uid?: string;
  submissionId: string;
}

class AgentRunError extends Error {
  readonly outcome: 'failed' | 'aborted';
  readonly submissionId: string;
}
```

- `init()` performs no I/O and creates nothing — it is an address. The instance is created on first contact; `init()` at module scope is safe.
- `dispatch()` resolves at admission with the durable receipt; `read()` awaits settlement and resolves with the reply, rejecting with `AgentRunError` when the submission settled `failed` or `aborted`.
- Also exported from `@flue/runtime/node`: `sqlite(path)` persistence adapter, `local()` sandbox factory.

### Flue Agent SDK (`@flue/sdk`)

```ts
import { createFlueClient } from '@flue/sdk';
// createFlueClient({ url, token, headers?, fetch? }) — one client per conversation URL
// conversation.send({ message, initialData?, uid? }) -> admission
// conversation.read(admission | submissionId) -> reply, throws FlueExecutionError on failure/abort
// also: wait(), history(), observe(), abort(), attachmentUrl()
```

## Patterns

### Chaining agents from a shell script

```bash
summary=$(flue run src/agents/reporter.ts -m "Summarize yesterday's deploys." --json | jq -r .message)
flue run src/agents/notifier.ts -m "Post this summary to #eng: $summary"
```

### Recurring workflow hosted in CI

```yaml
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: >
          npx flue run src/agents/triage.ts
          --message "Triage issue #${{ github.event.issue.number }}."
          --id "issue-${{ github.event.issue.number }}"
          --new --json > triage.json
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Provider credentials come from the job's environment. The envelope in `triage.json` carries the outcome, the reply, and the conversation id for later steps.

### Standalone Node script

```ts
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Reporter } from '../src/agents/reporter.ts';

await using flue = await start({
  agents: [Reporter],
  db: sqlite('./nightly.db'),
});

const reporter = init(Reporter, { id: 'nightly-2026-07-17' });
const receipt = await reporter.dispatch('Produce the nightly report.');
const reply = await reporter.read(receipt);
console.log(reply.text);
```

A failed or aborted run rejects the `read()` with `AgentRunError`, so ordinary `try`/`catch` is all the error handling a script needs. The `db` option decides whether conversations outlive the script: omit it for in-memory state that vanishes with the process.

### Talking to a deployed agent over HTTP

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: `https://example.com/agents/release-auditor/release-${version}`,
  token: process.env.FLUE_TOKEN,
});

const admission = await conversation.send({
  message: { kind: 'user', body: `Audit the ${version} rollout.` },
});
const reply = await conversation.read(admission);
console.log(reply.text);
```

`send()` resolves at admission with the submission's identifiers; `read()` awaits settlement (throwing `FlueExecutionError` on failure or abort). `read()` also takes a bare submission id, so a process that persisted just the admission can re-attach later.

### Durable workflow: split dispatch and read into separate steps

The key shape: the dispatch runs in its own workflow step, so the receipt — the durable claim ticket for the submission — is checkpointed the moment it exists, and a second step reads the settled reply. A completed dispatch step never re-runs the send, and a read step that crashes re-attaches with the same receipt instead of prompting again.

Cloudflare Workflows (written in the same Worker as the Flue application):

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { init } from '@flue/runtime';
import { Reviewer } from './agents/reviewer.ts';
import { collectFindings, fileReport } from './shared/nightly.ts';

type Params = { date: string };

export class NightlyReview extends WorkflowEntrypoint {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const findings = await step.do('collect findings', () => collectFindings(event.payload.date));

    const agent = init(Reviewer, { id: `nightly-${event.payload.date}` });

    const receipt = await step.do('dispatch review', () =>
      agent.dispatch(`Review these findings:\n${findings}`),
    );

    const review = await step.do('read review', async () => {
      const reply = await agent.read(receipt);
      return { text: reply.text, data: reply.data };
    });

    await step.do('file report', () => fileReport(review));
  }
}
```

The class is exported from `src/cloudflare.ts`, with its workflow binding declared in `wrangler.jsonc`.

Inngest (same split; `init()` when the function runs inside the Flue application's process, Agent SDK when it runs as a separate service):

```ts
import { init } from '@flue/runtime';
import { inngest } from './client.ts';
import { Reviewer } from '../agents/reviewer.ts';
import { fileReport } from '../shared/nightly.ts';

export const nightlyReview = inngest.createFunction(
  { id: 'nightly-review' },
  { event: 'reports/nightly.requested' },
  async ({ event, step }) => {
    const agent = init(Reviewer, { id: `nightly-${event.data.date}` });

    const receipt = await step.run('dispatch review', () =>
      agent.dispatch('Review the nightly findings.'),
    );

    const review = await step.run('read review', async () => {
      const reply = await agent.read(receipt);
      return { text: reply.text, data: reply.data };
    });

    await step.run('file report', () => fileReport(review));
  },
);
```

In Temporal the dispatch and the read would each live inside an activity.

## Recommended use cases

- One-shot agent invocation from a terminal or a CI job (issue triage on an event, a nightly report step).
- Chaining agents in a shell pipeline via `--json` + `jq`.
- Local scripting or cron that needs loops, error handling, or data structures around the run — use `start()` + `init()`.
- Scripts, CI, browsers, or other services reaching a *deployed* agent — use the Agent SDK.
- Multi-step orchestration that must finish once started, span days, or survive restarts — use a durable workflow engine with the dispatch/read step split.

## When to use / when NOT to use

- Use `flue run` when you need one message in and one reply out, and shell is enough. Don't use it when the workflow needs loops, error handling, or data structures — write a Node script with `start()` instead.
- Use `start()` + `init()` when your script runs the agents itself. Use the Agent SDK when the agents run in a deployment; choose by where the agents live. Inside a Flue server process HTTP is unnecessary — call `init()`/`dispatch()` directly.
- Use a durable workflow when the script *around* the sends must survive interruption. Flue already guarantees a durable outcome per send: once admitted, that submission settles through crashes, restarts, and redeploys. What Flue does not guarantee is the surrounding script — a workflow that dies between two dispatches re-runs from its start. Fine for a quick script, not for multi-step orchestration.
- Workflows are not how you deploy a chatbot-style agent — see the Deploy guide. For time-triggered dispatch, see Schedules rather than hand-rolling a loop.

## Gotchas & constraints

- **Durability boundary.** Per-send durability is Flue's; per-script durability is the engine's. Keep the receipt as a checkpointed step result, never only in memory.
- **Step timeouts compose.** Splitting dispatch and read splits any per-step time bound: a 20-minute step timeout becomes up to 40 minutes end-to-end. If the operation carries one deadline, checkpoint it in the dispatch step's result and have the read step enforce the remainder.
- **The one remaining crash window** is inside the dispatch step itself: the send was admitted but the step died before checkpointing the receipt. The engine re-runs the step, which sends again, and the send condition decides what that means:
  - Unconditional send (no `uid`) — the duplicate is delivered and joins the live response at a turn boundary; both submissions settle with the same coalesced reply, so the retry's fresh receipt reads the same answer.
  - Create-only send (`uid: null`) — the duplicate is rejected at admission with `AgentInstanceExistsError`; nothing reaches the agent twice, and the rejection is the workflow's signal to fail the run or fall back.
- **`read()` holds no in-memory state.** Settlement and reply are durable conversation records, so any process can read a submission at any later time, and a submission that settled while the workflow was down resolves immediately. Reading the same submission again returns the same reply.
- **Cancelling a read is local only.** `signal` rejects the read; the submission keeps running and stays readable. To durably stop work, call `abort()`.
- **Persistence on Node.** `start()` defaults to in-memory SQLite — process lifetime only, nothing survives exit. Pass `db: sqlite('./file.db')` (or another adapter) for conversations that outlive the script.
- **`flue run` storage.** Uses the project's `db` entry when one exists, otherwise a project-local cache file (`node_modules/.cache/flue/run.db`). It loads only the agent module and its imports, never `app.ts`.
- **Cloudflare-only modules under `flue run`.** A module importing `cloudflare:*` APIs fails with a pointer at `vite dev`, where platform bindings exist.
- **Processing is at-least-once on both targets** — design external side effects to be idempotent.
- **One runtime per process.** `start()` throws when a runtime is already configured; inside a Flue server call `init()`/`dispatch()` directly.
- **Reading inside a tool deadlocks by design** when the submission was dispatched to the agent currently running that tool. Handles inside tools are for *other* instances.

## Related

- [Durability](https://flueframework.com/docs/guide/durability/) — the accepted-work contract behind every send.
- [Schedules](https://flueframework.com/docs/guide/schedules/) — time-triggered dispatch, in-app and external.
- [flue run](https://flueframework.com/docs/cli/run/) — the full CLI reference.
- [SDK overview](https://flueframework.com/docs/sdk/overview/) — the conversation client for deployed applications.
- [Deploy](https://flueframework.com/docs/guide/deploy/) — hosting the application these workflows drive.
- [Agent API: init()](https://flueframework.com/docs/reference/agent-api/#init), [start()](https://flueframework.com/docs/reference/agent-api/#start)
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/), [Database](https://flueframework.com/docs/guide/database/)
- [GitHub Actions](https://flueframework.com/docs/ecosystem/deploy/github-actions/), [GitLab CI](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
