---
title: Building Agents
source: https://flueframework.com/docs/guide/building-agents/
bundled_docs:
  path: guide/building-agents
  version: 2.0.8
reviewed: 2026-09-17
---

# Building Agents

## What this is and when to use it

A Flue agent is a synchronous JavaScript or TypeScript function that returns
system instructions. Hooks called during that render attach a model, tools,
skills, subagents, MCP connections, persistent state, lifecycle callbacks, and
an optional sandbox. Use an agent when work belongs to a conversation that is
addressable by ID and can evolve over multiple messages or events.

The conceptual parts are the LLM, its harness, and specialized context. Flue's
two authoring primitives are the agent function and agent hooks.

## Exact agent API

```ts
'use agent';
import {
  type AgentProps,
  useModel,
  useSkill,
  useTool,
} from '@flue/runtime';
import checklist from '../skills/review-checklist/SKILL.md';
import { searchIssues } from '../tools/search-issues.ts';

export function TriageAgent({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  useTool(searchIssues);
  useSkill(checklist);
  return `Investigate issue ${id} and recommend the next action.`;
}

TriageAgent.agentName = 'triage-agent';
TriageAgent.durability = { maxAttempts: 5 };
```

Agent function rules:

- It must be synchronous and return `string` or `undefined`.
- It re-renders before every model turn, rebuilding instructions and hook
  declarations from current state.
- It receives `AgentProps`, currently `{ id: string }`.
- `useModel()` is required exactly once in the root render.
- Async work belongs in tools, lifecycle callbacks, and resource factories.

Common hooks, all from `@flue/runtime` unless documented otherwise:

| Hook | Purpose |
| --- | --- |
| `useModel` | Select model and model options |
| `useSandbox` | Attach filesystem and command execution |
| `useTool` | Expose application code to the model |
| `useMcpConnection` | Mount tools from an MCP server |
| `useSkill` | Add expertise activated on demand |
| `useSubagent` | Declare focused delegates |
| `usePersistentState` | Store per-instance application state |
| `useInitialData` | Read creation data validated once |
| Event hooks | Run logic at agent or response boundaries |

## Registration, identity, and instance IDs

`'use agent'` must be the first statement, before imports. The build scans
marked modules and registers every exported, capitalized function. A module can
export multiple agents.

Registration makes the function usable by `dispatch()` and
`createAgentRouter()`. It is independent of HTTP mounting: an event-only agent
can be registered without a route.

Three identifiers have different jobs:

- Function identity: `agentName`, or the function name when no static is set.
  It keys durable storage across all instances.
- Instance ID: the caller-chosen ticket, account, user, or generated ID. It
  addresses one continuing conversation.
- Submission ID: one admitted delivery and its eventual settlement.

Pin `agentName` before production. Renaming an unpinned function changes its
storage identity; renaming the file does not.

Other contract statics include `initialData` for the creation-data schema and
`durability` for retry/deadline policy.

## Delivery APIs

The installed 2.0.8 runtime exposes this request and receipt shape:

```ts
function dispatch(
  agent: Agent,
  request: AgentDispatchRequest,
): Promise<DispatchReceipt>;

interface AgentDispatchRequest {
  id: string;
  message: DeliveredMessageInput;
  initialData?: unknown;
  uid?: string | null;
  idempotencyKey?: string;
}

interface DispatchReceipt {
  submissionId: string;
  acceptedAt: string;
  uid: string;
  deduplicated?: true;
}
```

Messages are either user turns or structured signals:

```ts
type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };
```

`dispatch()` resolves after durable admission, not after model completion. A
bare string is shorthand for a user message in server-side dispatch and on an
instance handle.

`uid` controls instance creation: omit it to create-or-continue, pass a string
to continue only that incarnation, or pass `null` to create only. `initialData`
is validated and stored only when the send creates the instance.

`idempotencyKey` names one delivery. It is a non-empty string up to 256
characters, scoped to `(agent, instance ID)`. Replaying the same key and payload
returns the original receipt with `deduplicated: true`; different content under
the key returns `409 submission_conflict`. A failed keyed submission remains
failed, so use a new key to request new work.

## How to: build and exercise an agent end to end

1. Create the marked agent module shown above. Keep instructions stable and
   add only capabilities the task requires.
2. Run it directly without a server:

   ```bash
   bunx flue run src/agents/triage-agent.ts \
     --id issue-17307 \
     --message "Review the latest report."
   ```

3. Repeat with the same ID to verify conversation continuity.
4. To serve it, mount it in the Hono application:

   ```ts
   import { createAgentRouter } from '@flue/runtime/routing';
   import { Hono } from 'hono';
   import { TriageAgent } from './agents/triage-agent.ts';

   const app = new Hono();
   app.use('/agents/*', authenticateAndAuthorize);
   app.route('/agents/triage', createAgentRouter(TriageAgent));
   export default app;
   ```

5. Send the bare message object. Optional creation and delivery fields are
   top-level siblings:

   ```http
   POST /agents/triage/issue-17307 HTTP/1.1
   Content-Type: application/json

   {
     "kind": "user",
     "body": "What should happen next?",
     "idempotencyKey": "web-request-001"
   }
   ```

6. Expect `202`, then read `GET /agents/triage/issue-17307?view=history` or use
   the Agent SDK's `wait()`, `observe()`, and `history()`.
7. For a verified webhook, dispatch a signal and use the provider's stable
   event ID to prevent a redelivery from creating a second turn:

   ```ts
   const receipt = await dispatch(TriageAgent, {
     id: event.issueId,
     message: {
       kind: 'signal',
       type: 'issue.comment.created',
       body: event.text,
       attributes: { commentId: event.commentId },
     },
     idempotencyKey: event.eventId,
   });
   ```

8. When in-process code needs the reply, use a handle:

   ```ts
   import { init } from '@flue/runtime';

   const triage = init(TriageAgent, { id: 'issue-17307' });
   const receipt = await triage.dispatch('Summarize the decision.');
   const reply = await triage.read(receipt);
   console.log(reply.text);
   ```

9. In a standalone Node script, call `start({ agents, db? })` from
   `@flue/runtime/node` before using `init()` or `dispatch()`. Inside a Flue
   server, the runtime is already configured; do not call `start()`.

## Recommended patterns

- Use real entity IDs for long-lived conversations and generated IDs for
  throwaway work.
- Pin `agentName` and treat it as persisted schema.
- Use signals for webhooks, queues, and participant events rather than
  pretending they are direct user turns.
- Pass a provider redelivery ID as `idempotencyKey` and also make external tool
  effects idempotent because processing attempts are at-least-once.
- Compose repeated hook declarations in custom hooks; delegate actual work with
  `useSubagent()`.
- Use `init()` plus `read()` when code must await an answer; use top-level
  `dispatch()` when admission is enough.

## Avoid

- Do not make the agent function `async` or perform I/O during render.
- Do not call one agent function from another; nested renders are rejected.
- Do not mount an event-only agent just to make `dispatch()` work.
- Do not create a new runtime with `start()` inside an already-running app.
- Do not nest the HTTP body under `{ message: ... }`; the direct route accepts
  the bare delivered-message object.
- Do not treat cancellation of `read()` as an agent abort. Call
  `handle.abort()` for a durable abort request.

## Gotchas

- Dynamic instruction text is recomputed each turn and can invalidate provider
  prompt caching. Keep volatile data out unless the model truly needs it.
- Only exported, capitalized functions in marked modules are registered.
- Anyone able to reach an unprotected conversation URL can send to that ID.
  Authentication and per-ID authorization belong in Hono middleware.
- HTTP sends and `dispatch()` are fire-and-forget at admission.
- `initialData` is ignored when continuing an existing instance; use
  `uid: null` when accidental continuation must fail.
- `start()` without `db` uses process-lifetime in-memory persistence.
- Idempotency keys deduplicate delivery, not retries within a submission and not
  arbitrary external effects.

## Related references

- [Getting started](introduction_getting-started.md)
- [Project layout](guides_project-layout.md)
- [Agent hooks](https://flueframework.com/docs/guide/agent-hooks/)
- [Agent API](https://flueframework.com/docs/reference/agent-api/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Channels](https://flueframework.com/docs/guide/channels/)
- [Durability](https://flueframework.com/docs/guide/durability/)
- [Workflows and scripting](https://flueframework.com/docs/guide/workflows/)
- [`flue run`](https://flueframework.com/docs/cli/run/)
