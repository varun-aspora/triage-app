---
title: Streaming Protocol
source: https://flueframework.com/docs/reference/streaming-protocol/
bundled_docs: bunx flue docs read reference/streaming-protocol
version: 2.0.8
reviewed: 2026-09-17
---

# Streaming Protocol

## What and when

This is the HTTP wire contract served by `createAgentRouter(agent)` for one agent conversation. Use it when implementing a client, proxy, CORS policy, resume loop, or attachment endpoint. Prefer the Flue Agent SDK for application UIs; this reference matters when speaking the protocol directly.

The Node and Cloudflare targets use identical request, response, header, error, and SSE semantics. Mounting, authentication, and CORS remain application responsibilities.

## Route index

All paths are relative to the mounted router. `:id` is caller-selected and must be a non-empty, non-whitespace path segment.

| Route | Purpose | Success |
| --- | --- | --- |
| `POST /:id` | Durably admit one message | `202` JSON |
| `GET /:id` | Snapshot (`view=history`, default) | `200` JSON |
| `GET /:id?view=updates&offset=...` | Incremental updates | `200` JSON or SSE |
| `HEAD /:id` | Current stream metadata | headers only |
| `POST /:id/abort` | Abort running and queued work | `200` JSON |
| `GET /:id/attachments/:attachmentId` | Immutable attachment bytes | `200` bytes |

The first admitted `POST` creates the conversation and stream. Reads before that return `stream_not_found` (404). Unsupported methods return `method_not_allowed` (405) with `Allow`.

## Offsets and coordination

Normal offsets look like `0000000000000000_0000000000000003`: two zero-padded 16-digit integers joined by `_`; Flue's first component is always `0`. `-1` means before the first batch.

Treat every offset as opaque:

- It addresses a durable record batch, not a message.
- Reads are exclusive and return records after the supplied offset.
- Internal-only batches can advance the offset while producing no client chunks.
- Obtain offsets only from responses and return them unchanged.
- Malformed offsets are `invalid_request` (400); offsets beyond the current head are `conversation_stream_store_failure` (500).

Coordination headers:

- `Stream-Next-Offset`: exclusive resume point. It is on admission, JSON reads, snapshots, and `HEAD`; SSE carries it in `control` events.
- `Stream-Up-To-Date: true`: this response reached the durable head. Absence means more was already available; it is never sent as `false`.
- `Location`: admission only, equal to the response `streamUrl`.

Expose these headers explicitly in cross-origin CORS middleware.

## Message admission

```ts
type PromptBody = DeliveredMessage & {
  initialData?: unknown;
  uid?: string | null;
};

type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };

type DeliveredAttachment = {
  type: 'image';
  data: string;
  mimeType: string;
  filename?: string;
};
```

Send JSON with `Content-Type: application/json`. The server-side bare-string `dispatch()` shorthand is not legal on the wire.

- User attachments are images only. `data` is base64 and may be at most 14,680,064 characters.
- A signal `type` must be non-empty. Its `body` remains a string; stringify structured values yourself.
- `tagName` must match `^[A-Za-z_][A-Za-z0-9_.-]*$`. It becomes an unescaped model-context envelope.
- `initialData` is used only if this send creates the instance and is validated against the agent schema before durable admission.
- `uid: '<value>'` requires that exact existing incarnation. Missing/mismatched is `agent_instance_not_found` (404), and it cannot be combined with `initialData`.
- `uid: null` means create only: an existing instance yields `agent_instance_exists` (409) with the existing UID in `details`.
- Omitted `uid` is unconditional delivery.
- Failed conditions leave no durable record.
- Valid W3C `traceparent` and optional `tracestate` link the submission to the caller trace.

Wrong content type is `unsupported_media_type` (415); malformed JSON is `invalid_json` (400). `?wait` is unsupported and returns `invalid_request` (400).

### Admission response

```ts
interface Admission {
  streamUrl: string;
  offset: string;
  submissionId: string;
  uid: string;
}
```

The server returns after durable admission and before agent execution. `streamUrl` is the request URL without query and is mirrored by `Location`. `offset` is the head after recording the input; reading updates from it observes only resulting work. `submissionId` correlates settlements. `uid` identifies the contacted incarnation and can condition a later send.

## History snapshot

`GET /:id` and `GET /:id?view=history` return `FlueConversationSnapshot` with `Cache-Control: no-store`, the snapshot offset, and `Stream-Up-To-Date: true`. `offset`, `tail`, and `live` cannot accompany history.

```ts
interface FlueConversationSnapshot {
  v: 1;
  conversationId: string;
  offset: string;
  messages: FlueConversationMessage[];
  settlements: FlueConversationSettlement[];
}

interface FlueConversationSettlement {
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: unknown;
}

interface FlueConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  purpose: 'user' | 'assistant' | 'dispatch' | 'advisory';
  display: 'visible' | 'hidden' | 'diagnostic';
  submissionId?: string;
  turnId?: string;
  signal?: { tagName?: string; attributes?: Record<string, string> };
  settlement?: { outcome: 'failed' | 'aborted' };
  parts: FlueConversationPart[];
  metadata?: Record<string, unknown>;
}
```

Part union summary:

- `text` and `reasoning`: `{ text, state: 'streaming' | 'done' }`.
- `data-${string}`: `{ data }`, one part for each named client-data write.
- `file`: `{ mediaType, id?, size?, url?, filename? }`; server never fills `url` because it does not know the mount.
- `dynamic-tool`: input state with `toolName`, `toolCallId`, `input`; then output or error with `output`/`errorText` and optional `durationMs`.

One assistant message folds all model steps in a response. Metadata is wholly agent-authored. Failed/aborted settlements also create an advisory timeline message; completed submissions do not, but all terminal outcomes appear in `settlements`. Only the root conversation is exposed; child sessions and canonical records remain internal.

## Incremental updates

`GET /:id?view=updates&offset=X` requires exactly one `offset`. `tail` is rejected because a suffix may omit structural state. A response covers at most 100 durable batches; there is no page-size query option.

Without `live`, response JSON is `ConversationStreamChunk[]`. Continue from `Stream-Next-Offset` until `Stream-Up-To-Date: true`. Chunks are deltas against state at the requested offset, so resume only from state you actually hold. Start at `-1` for a `conversation-reset`, or fetch history after losing local state.

Each read reconstructs reduced state through the supplied offset; there is no persisted replay cache. Reconnect cost therefore grows with total conversation length.

### Long-poll

`live=long-poll` returns immediately when data exists. Otherwise it waits up to 30 seconds. Timeout returns `[]`, the unchanged next offset, and up-to-date `true`. Client disconnect while parked is discarded as status 499 with no body.

### SSE

`live=sse` returns `text/event-stream`, `Cache-Control: no-cache`, and remains open until the client disconnects.

```text
event: data
data:[{"type":"message-delta",...}]

event: control
data:{"streamNextOffset":"...","upToDate":true}

: heartbeat
```

- `data` contains a JSON chunk array and is omitted for an empty cycle.
- `control` follows every read cycle and carries the changing offset; `upToDate` appears only as `true`.
- An empty caught-up cycle still emits control at least every 30 seconds.
- Heartbeat comments arrive every 15 seconds.
- Reconnect from the last control offset. SSE is at-least-once across reconnects.

## Update chunk contract

`ConversationStreamChunk` is exported by `@flue/sdk`. Every chunk has `type`, `conversationId`, and `position: { batch: number; index: number }`. Positions are unique and monotonic within the conversation; compare `(batch, index)` lexicographically to deduplicate, but otherwise treat them as opaque.

| Chunk | Reducer action |
| --- | --- |
| `conversation-reset` | Replace all state with `snapshot`; structural boundary subsumes its batch. |
| `message-appended` | Append a complete user or signal message. |
| `message-started` | Open or continue an assistant message; merge initial metadata. |
| `message-metadata` | Merge agent-authored metadata. |
| `data-part` | Append one `data-<name>` part. |
| `message-delta` | Append `text` or `reasoning`; close the prior kind when kind changes. |
| `tool-input` | Add an `input-available` dynamic-tool part. |
| `tool-output` | Resolve the matching `toolCallId` with output and optional duration. |
| `tool-output-error` | Resolve the matching call with `errorText`. |
| `message-completed` | Mark open streaming parts done. |
| `submission-settled` | Record `completed`, `failed`, or `aborted` for a submission. |

Boundary chunks may include ISO timestamps; `message-delta` omits timestamps for wire size. A repeated `message-started` for an open message is continuation, not a second message. A reset snapshot may already contain settlements, so settlement waiters inspect both snapshots and later chunks.

### End-to-end direct client loop

1. `POST` a message and retain `submissionId`, `uid`, and admission `offset`.
2. Initialize local state from `GET ?view=history`, or start updates at `-1` and apply the reset.
3. Read updates exclusively after the held offset.
4. Apply chunks in position order and deduplicate repeated positions.
5. Replace the held offset only with `Stream-Next-Offset` or SSE control data.
6. Page immediately while up-to-date is absent; otherwise long-poll or keep SSE open.
7. Finish waiting when the matching submission settles in a chunk or reset/snapshot settlement index.
8. After state loss, fetch a new history snapshot; never guess an offset or apply deltas to unknown state.

## Metadata, abort, and attachments

`HEAD /:id` returns no body, the current head in `Stream-Next-Offset`, and `Stream-Up-To-Date: true`.

`POST /:id/abort` returns `{ aborted: boolean }`. It durably requests abort for running and queued work and returns immediately. `true` means work existed; affected submissions settle asynchronously as `aborted`.

Attachment downloads are conversation-scoped. URI-encode `attachmentId`. Unknown IDs and child-conversation attachments return `attachment_not_found` (404). Success includes stored `Content-Type`, `Content-Length`, `Content-Disposition: inline`, `Cache-Control: private, max-age=31536000, immutable`, and `Content-Security-Policy: sandbox`.

## Errors and fixed headers

```ts
interface ErrorEnvelope {
  error: {
    type: string;
    message: string;
    details: string;
    dev?: string;
    meta?: Record<string, unknown>;
  };
}
```

Branch on `error.type`, never prose. Relevant statuses include 400 (`invalid_request`, `invalid_json`), 404 (`agent_instance_not_found`, `stream_not_found`, `attachment_not_found`), 405 (`method_not_allowed`), 409 (`agent_instance_exists`), 415 (`unsupported_media_type`), 503 (`runtime_unavailable`, with `Retry-After` during local reload), and 500 (`internal_error`, `conversation_stream_store_failure`). Unknown server exceptions are redacted to generic `internal_error`.

Every read and error response includes `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: cross-origin`. The protocol deliberately sets no auth challenge, CORS headers, `ETag`, or `Last-Modified`.

## Recommended patterns

- Prefer SDK `history()`, `observe()`, and `wait()` unless implementing transport infrastructure.
- Persist the last applied offset and position together with reduced UI state.
- Dedupe SSE replay by chunk position and treat reset as authoritative replacement.
- Expose coordination headers in CORS and use offsets instead of cache validators.
- Render by `display` and `purpose`, not role alone.

## Avoid

- Do not synthesize offsets, read inclusively, or assume one offset equals one message.
- Do not use a tail read, synchronous wait query, string request body, or child-conversation URL.
- Do not construct attachment URLs from server `file.url`; the server leaves it unset.
- Do not use runtime observability events as this client stream; they have a different schema and durability contract.

## Gotchas

- An empty chunk array can still advance the next offset because internal records were consumed.
- `Stream-Up-To-Date` being absent means keep paging; it never appears as `false`.
- Admission offset is after the submitted input, ideal for waiting only on its response.
- Aborting is asynchronous; the abort response is not the settlement.
- SSE delivery after reconnect is at-least-once, while event positions make deduplication deterministic.

## Related

- [Routing guide](https://flueframework.com/docs/guide/routing/)
- [SDK client](https://flueframework.com/docs/sdk/flue-client/)
- [SDK events](https://flueframework.com/docs/sdk/events/)
- [Events reference](https://flueframework.com/docs/reference/events/)
- [Errors reference](https://flueframework.com/docs/reference/errors/)
