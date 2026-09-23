---
title: Flue SDK events and records
source: https://flueframework.com/docs/sdk/events/
bundled_docs: bunx flue docs read sdk/events
version: "2.0.8"
reviewed: "2026-09-17"
---

# Flue SDK events and records

## Purpose and when

Choose the correct SDK event level and handle reconnect redelivery. Application code should normally consume materialized `FlueConversationState` from `observe()` or `FlueConversationSnapshot` from `history()`. Use raw `ConversationStreamChunk` only for first-party progress presenters and low-level integrations.

The runtime's low-level `FlueEvent` union is not exposed by `FlueClient`; it belongs to in-process `@flue/runtime` observation.

## Exported shapes

Materialized exports are defined on the client page:

- `FlueConversationSnapshot`
- `FlueConversationState`
- `FlueConversationMessage`
- `FlueConversationPart`
- `FlueConversationSettlement`
- `PromptUsage`, matching the runtime shape and carried by conversation settlements
- `ConversationStreamChunk`, the updates-view wire union exposed to `wait().onEvent`

SDK-owned stream surface:

```ts
interface FlueEventStream<T = ConversationStreamChunk> extends AsyncIterable<T> {
  cancel(reason?: unknown): void;
  readonly offset: string;
}

interface FlueStreamOptions {
  offset?: string;
  live?: LiveMode;
  signal?: AbortSignal;
  backoffOptions?: BackoffOptions;
}

type LiveMode = boolean | 'long-poll' | 'sse';
```

`LiveMode` and `BackoffOptions` are re-exported from `@durable-streams/client`.

| Field | Contract |
| --- | --- |
| `offset` option | Starting checkpoint; default `'-1'` for full history. |
| `live` | Default `true` (long-poll). `false` reads to current end; `'sse'` keeps a low-latency stream. |
| `signal` | Cancels the stream; iteration ends without throwing. |
| `backoffOptions` | Durable-stream connection retry policy. |
| stream `.offset` | Resume checkpoint advanced only after every event in a delivered batch has yielded. |
| stream `.cancel()` | Aborts the connection; iteration ends with `done: true`. |

Breaking from `for await...of` also cleans up the underlying connection. A caller-supplied validator runs before each yield; validation failure is terminal and subsequent `next()` calls rethrow.

## How to

Prefer maintained state:

```ts
const observation = client.observe({ live: 'sse' });

const unsubscribe = observation.subscribe(() => {
  const { conversation } = observation.getSnapshot();
  for (const message of conversation?.messages ?? []) {
    if (message.display !== 'visible') continue;
    for (const part of message.parts) {
      if (part.type === 'text') renderText(message.id, part.text, part.state);
    }
  }
});

// unsubscribe only removes this listener.
unsubscribe();
observation.close();
```

For script progress, keep `onEvent` idempotent:

```ts
const seen = new Set<string>();
await client.wait(admission, {
  onEvent(chunk) {
    if (seen.has(chunk.position)) return;
    seen.add(chunk.position);
    renderProgress(chunk);
  },
});
```

## Recommended patterns

- Treat every offset as an opaque string; store and pass it without parsing.
- Use chunk `position` only to order/deduplicate chunks, never as a resume offset.
- Keep raw callback side effects idempotent because transport delivery is at-least-once.
- Prefer `observe()` because it deduplicates by position and rehydrates snapshots after failures.
- Use `sse` for lower token latency and `long-poll` for the default transport; guarantees are identical.

## Avoid

- Do not confuse `ConversationStreamChunk` with runtime `FlueEvent`.
- Do not treat raw stream chunks as stable application API.
- Do not checkpoint a stream's `.offset` before the application has handled all events associated with it.
- Do not assume `wait().onEvent` receives only the awaited submission's chunks.
- Do not perform arithmetic or ordering comparisons on opaque offsets.

## Gotchas

- Delivery is at-least-once: reconnecting after a mid-batch failure can replay that batch.
- `wait()` settlement matching is idempotent, but its `onEvent` callback can observe duplicate chunks.
- `observe()` drops chunks at or below the last applied position and rehydrates after connection failure.
- Stream cancellation ends iteration quietly rather than throwing an SDK error.
- A validation mismatch in `wait()` surfaces as internal `ConversationStreamError`; `observe()` attempts recovery through rehydration.

## Related

- [FlueClient](sdk_flue-client.md)
- [SDK errors](sdk_errors.md)
- [SDK overview](sdk_overview.md)
- [Observability](advanced_observability.md)
- [Streaming Protocol](reference_streaming-protocol.md) — the wire format behind `ConversationStreamChunk` and offsets
