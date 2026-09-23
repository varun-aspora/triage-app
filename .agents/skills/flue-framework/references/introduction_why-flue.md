---
title: Why Flue
source: https://flueframework.com/docs/guide/why-flue/
bundled_docs:
  path: guide/why-flue
  version: 2.0.8
reviewed: 2026-09-17
---

# Why Flue

## What this is and when to use it

Flue is an open TypeScript framework for autonomous agents. Use it when the
unit of work is a continuing, addressable agent that needs some combination of
model calls, tools, skills, subagents, MCP connections, a sandbox, persistent
state, and durable message processing.

It is a strong fit for assistants, support or triage agents, coding agents,
event-driven channel agents, CI agents, and products whose agent conversations
must continue across messages and process restarts. Plain application code is
usually a better fit for a deterministic operation that needs neither a model
nor a durable conversation.

## The design principles

### Harness-first

The harness is the product, not an optional SDK helper. Flue builds on Pi and
gives an agent a model loop plus declared tools, skills, subagents, and an
optional sandbox. This supports autonomous work rather than one isolated model
completion.

### Dynamic

An agent is a program, not a static configuration object. Its synchronous
function re-renders before each model turn, while hooks declare the current
capabilities. Persistent state can therefore change which tools or skills are
available on the next turn.

### Durable

Accepted inputs are recorded in a replayable conversation log. Flue coordinates
admission, retries, recovery, and reconnectable reads. The exact survival
guarantee depends on the deployment target and persistence adapter; durability
does not make arbitrary external side effects exactly-once.

### Open

Models, deployment targets, sandboxes, and integrations are replaceable. Flue
supports Pi model providers, Node and Cloudflare targets, local or remote
sandboxes, MCP, and Durable Streams rather than requiring one vendor's cloud.

### Built for non-trivial agents

The framework prioritizes stable identity, persistent conversations, explicit
routing, observability, and composable capabilities. This adds structure that a
single prompt call does not need, but avoids rebuilding production recovery and
coordination once an agent grows.

## Exact programming model

The core authoring surface is a marked, exported function plus hooks:

```ts
'use agent';
import {
  useModel,
  usePersistentState,
  useSkill,
  useTool,
} from '@flue/runtime';
import policy from './skills/policy/SKILL.md';
import { lookupTicket } from './tools/lookup-ticket.ts';

export function Support({ id }: { id: string }) {
  const [status] = usePersistentState('status', 'new');
  useModel('anthropic/claude-sonnet-4-6');
  useTool(lookupTicket);
  useSkill(policy);
  return `Support ticket ${id}. Current status: ${status}.`;
}

Support.agentName = 'support';
Support.durability = { maxAttempts: 5 };
```

Common hooks imported from `@flue/runtime`:

| Hook | Capability |
| --- | --- |
| `useModel()` | Required model selection |
| `useTool()` | Application-defined action or query |
| `useSkill()` | Packaged expertise loaded on demand |
| `useSubagent()` | Delegation to a declared agent |
| `useMcpConnection()` | MCP server tools |
| `useSandbox()` | Filesystem and command environment |
| `usePersistentState()` | Per-instance durable application state |
| Lifecycle hooks | Logic at agent and response boundaries |

Relevant commands in this Bun project:

```bash
bunx flue init ./support-agent --target node
bun install
bunx flue run src/agents/support.ts --id ticket-8472 \
  --message "Review the latest customer message."
```

## How to: decide and build a thin vertical slice

1. Name the durable entity. If messages should accumulate around a ticket,
   account, repository, or user, use that entity's stable key as the agent ID.
2. List required capabilities. Use a tool for application code, a skill for
   guidance, MCP for an existing tool server, and a sandbox only for filesystem
   or command execution.
3. Create one synchronous agent function with one `useModel()` call and a short,
   stable instruction string.
4. Mark the module with `'use agent'`, export the capitalized function, and pin
   `agentName` before production data exists.
5. Run it with `bunx flue run <module> --id <stable-id> --message <text>`.
6. Send a second message with the same ID and verify that the conversation
   continues.
7. Add persistence appropriate to the target, then test interruption and
   retry behavior before claiming a durability guarantee.
8. Add a Hono route only when clients need an HTTP conversation URL.

## Recommended patterns

- Keep instructions stable and capabilities explicit; let skills hold detailed
  procedures that should be loaded only when relevant.
- Treat the agent ID and `agentName` as durable schema, not display labels.
- Normalize webhooks to `kind: 'signal'` messages and use the provider event ID
  as `idempotencyKey`.
- Wrap non-repeatable external effects in durable tools and also use the
  destination system's idempotency support.
- Protect each HTTP conversation route with application authentication and an
  authorization check for the requested ID.
- Start with one agent and split into subagents only when delegation creates a
  clear context or capability boundary.

## Avoid

- Do not use Flue as a wrapper around a deterministic function that normal
  application code can call directly.
- Do not put network or filesystem I/O in the agent render; use tools, event
  hooks, or resource factories.
- Do not confuse declarative hooks with one-time setup. The function re-renders
  on every model turn.
- Do not assume "durable" means external effects cannot repeat.
- Do not attach a host sandbox to untrusted agents without an isolation review.

## Gotchas

- Flue 2 has no framework workflow primitive. Use an `init()` handle for one
  awaited agent operation, a durable tool for checkpointed steps, or an
  application-owned orchestrator for larger workflows.
- Sandboxes are opt-in. No `useSandbox()` means no shell or filesystem tools.
- A Node process with the default in-memory store does not survive process
  loss; configure a durable database when that guarantee matters.
- HTTP sends resolve with `202` at admission. The client must observe, wait, or
  read history for completion.
- Reusing an agent ID continues a conversation. Reusing an idempotency key
  deduplicates one delivery; these are separate concepts.

## Related references

- [Getting started](introduction_getting-started.md)
- [Building agents](guides_building-agents.md)
- [Project layout](guides_project-layout.md)
- [Agent hooks](https://flueframework.com/docs/guide/agent-hooks/)
- [Durability](https://flueframework.com/docs/guide/durability/)
- [Tools](https://flueframework.com/docs/guide/tools/)
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [MCP](https://flueframework.com/docs/guide/mcp/)
