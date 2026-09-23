---
title: Flue Agent SDK overview
source: https://flueframework.com/docs/sdk/overview/
bundled_docs: bunx flue docs read sdk/overview
version: "2.0.8"
reviewed: "2026-09-17"
---

# Flue Agent SDK overview

## Purpose and when

`@flue/sdk` is the ESM-only TypeScript HTTP client for one conversation in a deployed Flue application. Use it from browsers, Bun scripts, edge runtimes, CI, or another service. Inside the Flue server process, prefer direct `@flue/runtime` `init()` and `dispatch()` calls.

The SDK requires a `fetch` implementation and depends on `@durable-streams/client` for reconnecting `wait()` and `observe()` streams.

## API shape

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  url: 'https://example.com/agents/support/ticket-8472',
  token: process.env.FLUE_TOKEN,
});

const admission = await client.send({
  message: { kind: 'user', body: 'Summarize my case.' },
});
const reply = await client.read(admission);
```

One client wraps exactly one conversation URL: mounted agent-router path plus caller-chosen conversation id. Construction is synchronous and performs no I/O; the first send creates the conversation when absent.

| Method | HTTP behavior and result |
| --- | --- |
| `send()` | `POST <url>`; resolves at durable admission (`202`) with an `AgentSendResult`, not a reply. |
| `read()` | Follows settlement, then reads history and projects the submission reply. |
| `wait()` | Follows `GET <url>?view=updates` from admission offset; resolves `void` on completion. |
| `history()` | `GET <url>?view=history`; one materialized snapshot. |
| `observe()` | Hydrates history, then maintains state from updates with reconnect and deduplication. |
| `abort()` | `POST <url>/abort`; records abort intent for unsettled conversation work. |
| `attachmentUrl()` | Builds `<url>/attachments/<id>` without making a request or attaching auth. |

## How to

```bash
bun add @flue/sdk
```

```ts
const admission = await client.send({ message });

// Need the assistant reply.
const result = await client.read(admission);

// Need only durable success/failure.
await client.wait(admission);

// Need maintained renderable state.
const observation = client.observe({ live: 'sse' });
```

## Recommended patterns

- Build the URL from the application's route map and a stable, application-owned conversation id.
- Persist `AgentSendResult` or `submissionId` after admission; a replacement process can call `read()` later.
- Use `read()` for request/reply scripts, `wait()` when no reply is needed, and `observe()` for UIs.
- Use a `uid` send condition to prevent delivery to a missing or re-created conversation incarnation.
- Make side effects behind agent tools idempotent; accepted execution may retry after interruption.

## Avoid

- Do not look for deployment-wide agent discovery, conversation enumeration, or deletion APIs; those are application concerns.
- Do not treat `send()` as completion or expect a reply in `AgentSendResult`.
- Do not treat `uid` as an idempotency key. It is an incarnation precondition; separate accepted sends are separate submissions.
- Do not hand-reduce raw stream chunks for normal UI state; consume `observe()`.
- Do not use the HTTP SDK inside the same server process when direct runtime APIs are available.

## Gotchas

- `wait()` is an observer, not a work owner. Losing the local promise does not stop server work.
- `read()` and repeated `wait()` calls reattach to durable settlement; they do not submit duplicate work.
- Stream transport is at-least-once. `observe()` deduplicates; raw `wait().onEvent` callbacks can see redelivery.
- Auth headers apply to client requests and stream reconnects, but not to requests made from `attachmentUrl()` strings.
- `@flue/react` builds `useFlueAgent()` on this client and is usually the higher-level browser UI surface.

## Related

- [createFlueClient](sdk_create-flue-client.md)
- [FlueClient](sdk_flue-client.md)
- [Events](sdk_events.md)
- [Errors](sdk_errors.md)
- [Routing](guides_routing.md)
- [Durability](advanced_durability.md)
