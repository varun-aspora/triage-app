---
title: Agents (building agents)
source: https://flueframework.com/docs/guide/building-agents/
section: guides
---

# Agents

## What it is

An agent in Flue is a plain JavaScript function that returns the agent's `system` instructions as a string. Those instructions are rendered and sent to the LLM along with the conversation's user and assistant messages. Capabilities (model, sandbox, tools, skills, subagents, state, lifecycle callbacks) are attached by calling `use*` **agent hooks** inside the function body. A module marked with the `'use agent'` directive registers its exported, capitalized functions as agents so the rest of the application can address them.

The two core primitives are **agent functions** and **agent hooks**. The docs frame an agent as three parts working together: LLM, harness, and specialized context.

## API surface

### Agent function

```ts
// Example: A simple agent, written in Flue.
function TriageAgent() {
  return "Investigate the user's issue and recommend the next action.";
}
```

- The function re-renders on **every turn** — every time the model is about to be called, Flue runs the function again and rebuilds the instructions from scratch.
- The function must be synchronous and return a `string` or `undefined`/nothing. Async work belongs in tools, event-hook callbacks, and resource factories. (Agent API reference.)
- Conceptually modelled on a React component render function.

### Props

Every agent instance is initialized with an ID; the function receives it as a prop:

```ts
function TriageAgent({ id }) {
  return `Investigate GitHub issue #${id} and recommend the next action.`;
}
```

`AgentProps` is `{ id: string }` (Agent API reference). The ID is supplied by `--id` on `flue run` (optional), the `POST /:id` route of a hosted agent (required), or the `id` of a `dispatch()`/`init()` call. Its meaning is yours: user ID, ticket, GitHub issue number, random string. Each instance is persisted by ID, so the ID is how you message the same agent over time.

For structured data beyond the ID, see "Passing data to the agent" in the Agent Hooks guide (`initialData` + `useInitialData()`).

### Hooks introduced (all imported from `@flue/runtime` unless noted)

| Hook | Purpose |
| --- | --- |
| `useModel` | selects the LLM powering the agent |
| `useSandbox` | filesystem + command-execution environment |
| `useTool` | call application code / affect external systems |
| `useMcpConnection` | mount tools from MCP servers |
| `useSkill` | expertise loaded on demand |
| `useSubagent` | delegate focused work to other agents |
| `usePersistentState` | custom data durable across the agent lifetime |
| `useAgentStart`, `useAgentFinish` (and others) | lifecycle event hooks |

```ts
import { useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { searchIssues } from '../tools/search-issues.ts';
import reviewChecklist from '../skills/review-checklist/SKILL.md';

function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useTool(searchIssues);
  useSkill(reviewChecklist);
  return 'Investigate the reported issue and recommend the next action.';
}
```

### `'use agent'` directive

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}
```

- A plain string literal at the top of the file, before imports and any other statement (like `'use strict'` / `'use client'`).
- At build time Flue scans the project for marked files and registers **every exported, capitalized function** as an agent. One file may export several agents.
- Registration is what makes an agent addressable: `dispatch(...)` can message it and `createAgentRouter(...)` can serve it over HTTP.
- The exported function's name becomes the agent's **durable identity**, which keys its conversation storage in the persistent database.

### `agentName` static

Pin the durable identity so you can rename the function without a database migration:

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}

TriageAgent.agentName = 'triage-agent';
```

The guide notes that setting an explicit agent name is considered a best practice by some Flue developers. (Reference: Agent API → Agent statics, which also documents `initialData` and `durability`.)

## Ways to interact with an agent

All four run the same agent and durability APIs; they differ only in how the runtime starts and whether an HTTP server exists.

### 1. CLI — `flue run`

```bash
flue run src/agents/triage-agent.ts --message "Triage issue 17307"
```

Runs one agent module directly — no server, no application build. Pass `--id` to name the conversation and continue it across invocations; without it each run starts a fresh conversation and prints its generated id:

```bash
flue run src/agents/triage-agent.ts --id issue-17307 --message "Look at issue 17307"
flue run src/agents/triage-agent.ts --id issue-17307 --message "Any update?"
```

Conversations persist between runs — in the project's configured database, or a local cache file when there is none.

### 2. HTTP

Agents mounted in the application (see the Routing guide) get one URL per conversation, ending in the conversation id:

```http
POST /agents/support-assistant/ticket-8472 HTTP/1.1
Content-Type: application/json

{
  "kind": "user",
  "body": "Can you summarize the open issues in my case?"
}
```

Prompts are fire-and-forget: the server responds `202` immediately and the reply is read from the conversation. `GET` the same URL to follow its events, or use the Flue Agent SDK, which wraps `send()`, `wait()`, `observe()`, `history()` around one conversation URL.

### 3. `dispatch()`

For asynchronous events — webhooks, queue messages, chat events, notifications.

```ts
import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import { SupportAssistant } from './agents/support-assistant.ts';
import { verifySupportWebhook } from './shared/support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await verifySupportWebhook(c.req.raw);
  const receipt = await dispatch(SupportAssistant, {
    id: event.ticketId,
    message: {
      kind: 'signal',
      type: 'support.comment.created',
      body: event.text,
      attributes: { commentId: event.commentId },
    },
  });

  return c.json(receipt, 202);
});

export default app;
```

Your application chooses the agent conversation before dispatching. `dispatch(...)` accepts the event for asynchronous processing rather than waiting for a response. Because registration comes from the `'use agent'` scan, an agent used only through `dispatch(...)` **needs no mount at all**.

Signature (Agent API reference):

```ts
function dispatch(agent: Agent, request: AgentDispatchRequest): Promise<DispatchReceipt>;

interface AgentDispatchRequest {
  id: string;
  message: DeliveredMessageInput; // a bare string is shorthand for { kind: 'user', body }
  initialData?: unknown;
  uid?: string | null;
}
```

### 4. Standalone scripts — `start()`

Run agents with no Flue application, no server, no `app.ts`. Boots the Flue runtime inside your own Node.js process; useful for cron jobs, one-off scripts, and tests.

```ts
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Reporter } from '../src/agents/reporter.ts';

await using flue = await start({
  agents: [Reporter],
  db: sqlite('./nightly.db'),
});

const reporter = init(Reporter, { id: 'nightly-2026-07-16' });
const receipt = await reporter.dispatch('Produce the nightly report.');
const reply = await reporter.read(receipt);
console.log(reply.text);
```

- Provider credentials come from the process environment.
- `db` decides whether conversations outlive the script: omit it for in-memory state, or pass an adapter like `sqlite()` so a later run can continue the same conversation.
- Inside an already-running Flue application there is **no** `start()` — call `init()` or `dispatch()` directly.

## Recommended use cases

- A long-lived assistant keyed to a real-world entity (support ticket, GitHub issue, customer account) that you message over days or weeks by ID.
- Reacting to provider webhooks or queue events: verify in an application route, then `dispatch()` a `signal` message to the agent for that entity.
- Local development and iteration on one agent module (`flue run --id ...`).
- Cron jobs, CI steps, and tests that need an agent but no HTTP server (`start()` + `init()`).
- A user-facing chat surface, mounted over HTTP and driven from the Agent SDK.

## Patterns

**Instructions from the ID.** The ID is the agent's primary input; interpolate it directly.

```ts
function TriageAgent({ id }) {
  return `Investigate GitHub issue #${id} and recommend the next action.`;
}
```

**Compose capability with hooks, keep the prompt short.** `useModel` + `useSandbox` + `useTool` + `useSkill` in the body, one sentence returned.

**Pin the durable identity.** `TriageAgent.agentName = 'triage-agent';` before the function name ever needs to change.

**Signals for non-chat input.** Application events go in as `{ kind: 'signal', type, body, attributes }`, not as fake user turns.

**Receipt then read.** `dispatch()` returns a receipt at admission; `handle.read(receipt)` awaits the settled reply (`reply.text`).

## When to use / when NOT to use

Use an agent function when the unit of work is a conversation that persists by ID and evolves over time.

Do **not**:

- **Put async work in the agent function.** It must return synchronously; a promise throws `[flue] Agent functions must be synchronous.` Async work goes in tools, event-hook callbacks (`useAgentStart` is the async one), and resource factories.
- **Call one agent function from another.** Renders never nest — that throws `[flue] Re-entrant agent render.` Share behaviour through **custom hooks**; delegate work through **`useSubagent()`**.
- **Reach for `start()` inside a Flue application.** Use `init()`/`dispatch()` there. One process holds at most one Flue runtime.
- **Use `dispatch()` when you need the answer inline.** `dispatch()` resolves at admission, not at completion; use the `init()` handle and `read()` the receipt, or the HTTP `GET`/SDK stream.
- **Mount over HTTP just to receive events.** Webhook-only agents need no router mount at all.
- **Use the raw scripting surface for multi-step orchestration** without reading the Workflows guide, which covers that surface in depth (CI pipelines, durable orchestration).

## Gotchas & constraints

- **Re-render on every turn.** Anything you interpolate into the instructions is recomputed each model call.
- **Dynamic data busts the prompt cache.** The docs warn explicitly:

  ```ts
  function AssistantAgent() {
    // Warning: Inserting dynamic data into your agent instructions can bust the cache
    // that LLMs use to give you cheaper inference tokens. It's often a best practice
    // to avoid doing this in production agents, specifically to save money.
    return `You are a helpful assistant. The time now is ${Date.now()}.`;
  }
  ```

- **Directive placement is strict.** `'use agent'` must be the first statement in the file, before imports.
- **Only exported, capitalized functions are registered.** A lowercase or non-exported function in a `'use agent'` module is not an agent.
- **Renaming an exported agent function changes its durable identity** and therefore its conversation storage key — pin `agentName` (a string literal in a `'use agent'` module) to avoid a database migration.
- **HTTP conversation URLs are the authorization boundary.** Anyone who can reach a conversation URL can talk to that conversation. Protect the mount with your application's normal middleware: verify the caller, and check that they are allowed to access that conversation id. See Routing.
- **HTTP prompts return `202`, not the reply.** The reply is read back from the conversation.
- **`start()` without `db` is in-memory only**; nothing survives the process.
- **`initialData` is validated once, at instance creation** and ignored on sends that continue an existing instance (Agent API reference).

## Related

- [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/) — compose capabilities: tools, skills, state, event hooks
- [Agent API reference](https://flueframework.com/docs/reference/agent-api/) — session operations, agent statics, `dispatch()`/`init()`/`start()`
- [Routing](https://flueframework.com/docs/guide/routing/) — mount agent HTTP surfaces inside an authenticated app
- [Schedules](https://flueframework.com/docs/guide/schedules/) — dispatch agent input on a schedule
- [Channels](https://flueframework.com/docs/guide/channels/) — verified provider events into agent conversations
- [Observability](https://flueframework.com/docs/guide/observability/) — inspect agent activity
- [Workflows](https://flueframework.com/docs/guide/workflows/) — the scripting/orchestration surface in depth
- [Models](https://flueframework.com/docs/guide/models/), [Tools](https://flueframework.com/docs/guide/tools/), [MCP](https://flueframework.com/docs/guide/mcp/), [Skills](https://flueframework.com/docs/guide/skills/), [Subagents](https://flueframework.com/docs/guide/subagents/), [Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Agent SDK](https://flueframework.com/docs/sdk/overview/), [flue run CLI](https://flueframework.com/docs/cli/run/)
