---
title: FlueClient
source: https://flueframework.com/docs/sdk/flue-client/
bundled_docs: bunx flue docs read sdk/flue-client
version: "2.0.8"
reviewed: "2026-09-17"
---

# `FlueClient`

## Purpose and when

Operate one deployed agent conversation: admit messages, reattach to durable submissions, inspect or observe materialized state, abort work, and resolve attachment URLs.

For a React chat UI, `useFlueAgent({ url })` from `@flue/react` wraps this exact client (built on `observe()`) and reduces it to React state — reach for `FlueClient` directly in non-React code, scripts, or when `useFlueAgent`'s `client` option needs a pre-configured instance for custom auth or transport.

## Client and delivery API

```ts
interface FlueClient {
  readonly url: string;
  send(options: AgentPromptOptions): Promise<AgentSendResult>;
  read(target: AgentSendResult | string, options?: AgentReadOptions): Promise<AgentReadResult>;
  wait(admission: AgentSendResult, options?: AgentWaitOptions): Promise<void>;
  abort(options?: { signal?: AbortSignal }): Promise<AgentAbortResult>;
  history(options?: FlueConversationHistoryOptions): Promise<FlueConversationSnapshot>;
  observe(options?: AgentConversationObserveOptions): AgentConversationObservation;
  attachmentUrl(attachmentId: string): string;
}

interface AgentPromptOptions {
  message: DeliveredMessage;
  initialData?: unknown;
  uid?: string | null;
  signal?: AbortSignal;
}

type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | { kind: 'signal'; type: string; body: string;
      attributes?: Record<string, string>; tagName?: string };

interface DeliveredAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  filename?: string;
}

interface AgentSendResult {
  streamUrl: string;
  offset: string;
  submissionId: string;
  uid: string;
}
```

`send()` performs `POST <url>` and resolves on `202` admission. `signal` cancels only that HTTP request, not admitted work. Send conditions:

| `uid` | Behavior |
| --- | --- |
| omitted | Continue existing or create absent conversation. |
| string | Continue only that incarnation; missing/mismatch is `404 agent_instance_not_found`. Cannot combine with `initialData`. |
| `null` | Create only; existing is `409 agent_instance_exists` with existing uid at `body.error.meta.uid`. |

`initialData` is validated and recorded only on creation, ignored on unconditional continuation, and cannot combine with a string `uid`. User attachments are image-only base64; `data` is limited to 14 MiB of characters. Signal `type` must be non-empty and `tagName`, if set, must be a valid XML name.

## Read and wait API

```ts
type AgentReadOptions = AgentWaitOptions;

interface AgentReadResult {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
  submissionId: string;
  uid?: string;
}

interface AgentWaitOptions {
  signal?: AbortSignal;
  backoffOptions?: BackoffOptions;
  onEvent?: (event: ConversationStreamChunk) => void | Promise<void>;
}
```

- `read(admission)` equals settlement wait plus one history read and reply projection. It returns `uid` when the admission supplied it.
- `read(submissionId)` starts from stream origin and is the durable reattachment path when only the id remains.
- `wait(admission)` follows `admission.streamUrl` from `admission.offset`, ignores other submissions' settlement chunks, resolves `void` on completion, and rejects `FlueExecutionError` on failed/aborted/missing settlement.
- `signal` cancels local observation only; work continues. `onEvent` is awaited before the next raw chunk.

## Abort and history API

```ts
interface AgentAbortResult { aborted: boolean }
interface FlueConversationHistoryOptions { signal?: AbortSignal }

interface FlueConversationSnapshot {
  v: 1;
  conversationId: string;
  offset: string;
  messages: FlueConversationMessage[];
  settlements: FlueConversationSettlement[];
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

type FlueConversationPart =
  | { type: 'text' | 'reasoning'; text: string; state: 'streaming' | 'done' }
  | { type: `data-${string}`; data: unknown }
  | { type: 'file'; mediaType: string; id?: string; size?: number;
      url?: string; filename?: string }
  | ({ type: 'dynamic-tool'; toolName: string; toolCallId: string } & (
      | { state: 'input-available'; input: unknown }
      | { state: 'output-available'; input: unknown; output: unknown; durationMs?: number }
      | { state: 'output-error'; input: unknown; errorText: string; durationMs?: number }
    ));

interface FlueConversationSettlement {
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: unknown;
}
```

`abort()` records abort intent for all running and queued work and returns whether anything was targeted. Settlement remains asynchronous. `history()` returns one snapshot and rejects 404 if absent; recorded file parts receive ready-to-use URLs.

## Reply projection

```ts
function readSubmissionReply(
  conversation: { messages: FlueConversationMessage[] },
  submissionId: string,
): AgentSubmissionReply;

interface AgentSubmissionReply {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
}
```

This pure helper finds the final reply for a submission, including a busy-response coalesced reply. Text parts join with blank lines; named data parts are grouped in emission order.

## Observe API

```ts
interface AgentConversationObserveOptions {
  live?: 'long-poll' | 'sse';
  signal?: AbortSignal;
  backoffOptions?: BackoffOptions;
}

interface AgentConversationObservation {
  getSnapshot(): AgentConversationObservationSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  close(reason?: unknown): void;
}

interface AgentConversationObservationSnapshot {
  conversation: FlueConversationState | undefined;
  offset: string | undefined;
  phase: 'loading' | 'connecting' | 'live' | 'absent' | 'error' | 'closed';
  error: Error | undefined;
}

interface FlueConversationState {
  conversationId: string;
  messages: FlueConversationMessage[];
  settlements: FlueConversationSettlement[];
}
```

`observe()` starts I/O on first subscription: history hydration, then updates. It deduplicates chunk positions. `404` becomes `absent`; `400`/`401`/`403` become terminal `error`; other failures rehydrate with 1 s exponential delay capped at 30 s. `refresh()` retries; only `close()`/signal stops the underlying observation.

## How to

```ts
const admission = await client.send({ message, uid: knownUid });
const reply = await client.read(admission);

// Reattach after process loss without submitting again.
const recovered = await client.read(persistedSubmissionId);
```

## Recommended patterns

- Persist the admission before relying on a local await; repeat `read()`/`wait()` to reattach safely.
- Use `readSubmissionReply()` when an observation already holds state, avoiding another history fetch.
- Treat `uid` as an incarnation ETag and `submissionId` as work identity.
- Use `observe()` for UIs and filter by `display`, not by role alone.
- Make raw `onEvent` side effects idempotent by chunk `position`.

## Avoid

- Do not retry `send()` blindly after an ambiguous network failure; no request idempotency key is exposed.
- Do not assume `wait()` returns reply text or accepts a bare submission id.
- Do not call `messages.at(-1)` to find a reply; joined busy submissions can share a host response.
- Do not expect unsubscribe to close an observation; call `close()`.
- Do not expect `attachmentUrl()` to attach auth.

## Gotchas

- JSON requests are single fetches with no SDK retry; stream reads have reconnect backoff.
- Raw `onEvent` sees every conversation chunk after admission offset and can see duplicates.
- `observe()` does not poll an absent conversation into existence; call `refresh()` after creation.
- Both live modes are redelivery-safe; SSE mainly lowers token latency.
- `attachmentUrl()` URL-encodes the id and performs no I/O.

## Related

- [SDK overview](sdk_overview.md)
- [createFlueClient](sdk_create-flue-client.md)
- [Events](sdk_events.md)
- [Errors](sdk_errors.md)
- [Durability](advanced_durability.md)
- [React](frontend_react.md)
