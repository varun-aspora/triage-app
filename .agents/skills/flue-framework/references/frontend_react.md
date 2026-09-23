---
title: React (@flue/react)
source: https://flueframework.com/docs/guide/react/
nav_section: Frontend
also_read:
  - https://flueframework.com/docs/guide/routing/
  - https://github.com/withastro/flue/tree/main/packages/react#readme
---

# React (`@flue/react`)

## What it is

`@flue/react` turns a Flue agent's durable conversation stream into live React state. The single hook `useFlueAgent()` observes one conversation (addressed by URL) and sends messages into it. HTTP, auth and stream transport stay in `@flue/sdk`; this package only manages UI state. There is no provider or app-level setup — a hook addresses one conversation, and starting a new conversation just means rendering the hook with a fresh conversation id appended to the agent's mount URL.

## Install

```sh
pnpm add @flue/react @flue/sdk
```

Requires React 18 or later.

## API surface

### `useFlueAgent()`

```ts
function useFlueAgent(options?: UseFlueAgentOptions): UseFlueAgentResult;

interface UseFlueAgentOptions {
  url?: string;
  client?: FlueClient;
  live?: 'sse' | 'long-poll';
}
```

| Option | Description |
| --- | --- |
| `url` | Conversation URL (agent mount URL + conversation id). Relative URLs resolve against the browser origin. Omit (together with `client`) to keep the hook dormant. |
| `client` | Pre-configured `createFlueClient({ url, headers, token, fetch })` for custom auth or transport. Takes precedence over `url`. Memoize it — a new instance replaces the session. |
| `live` | Live stream mode. Defaults to `'sse'`; use `'long-poll'` to disable SSE. |

```ts
interface UseFlueAgentResult {
  messages: FlueConversationMessage[];
  status: AgentStatus;
  historyReady: boolean;
  error: Error | undefined;
  failedSends: FailedSend[];
  settlements: FlueConversationSettlement[];
  sendMessage(message: string, options?: SendMessageOptions): Promise<AgentSendResult>;
  refresh(): void;
}

// AgentSendResult is the SDK's admission receipt (from @flue/sdk, sdk/flue-client):
interface AgentSendResult {
  streamUrl: string;
  offset: string;
  submissionId: string; // correlates this send with `settlements` above
  uid: string;
}

interface SendMessageOptions {
  images?: DeliveredAttachment[];
}

type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';
```

| Status | Meaning |
| --- | --- |
| `idle` | No local prompt is active, or the hook is dormant. |
| `connecting` | Initial connection or retry. `error` holds the latest retryable failure. |
| `submitted` | A prompt is being admitted or awaits attributable assistant activity. |
| `streaming` | Assistant activity for this client's submission is arriving. |
| `error` | Prompt admission, a submission, or stream observation failed. |

- `historyReady` becomes `true` once the requested durable history has loaded as one coherent snapshot; it stays `true` through later live reconnects.
- `settlements` mirrors terminal submission outcomes (`FlueConversationSettlement[]`), so app code can correlate a `submissionId` with its `completed` / `failed` / `aborted` outcome. It does not affect `status` or `error`.
- `failedSends` holds optimistic messages whose admission failed (with `status: 'error'`), so a UI can offer retry.

### `sendMessage(message, options?)`

Adds an optimistic user message, delivers it through the conversation client, and resolves with the admission receipt (`AgentSendResult`, mirroring the SDK's `client.send()`) when the server admits the prompt (202 admission) — **not** when generation finishes. The receipt's `submissionId` is the join key back to `settlements` above. On admission failure the optimistic message is retained, surfaced in `failedSends`, and the promise rejects. The canonical user message later re-keys to the optimistic row's id, so the rendered row is stable across the optimistic→confirmed swap. Concurrent sends use the runtime's per-conversation queue. Calling it on a dormant hook rejects.

### `refresh()`

Re-runs history catch-up and resumes live updates. A conversation that does not exist yet reports as empty (`historyReady`, no messages); when it is created out-of-band (webhook, queue worker, server-side wakeup), call `refresh()`. Deciding *when* to re-check is the application's responsibility.

### Message shape

Messages are Flue-owned `FlueConversationMessage` values with a parts-based shape (`FlueConversationPart[]`):

- `text` and `reasoning` — carry a `streaming | done` state.
- `dynamic-tool` — progresses `input-available` → `output-available` / `output-error`; validated structured tool output is preserved on the part's `output`, so custom tool UIs need no separate data-event channel.
- `file` — carries a ready-to-use `url` (hosted attachment URL once durably recorded, served through the agent router's attachments endpoint; a local `data:` preview on an optimistic echo).

Message `metadata` carries the server-authored `timestamp`, token `usage`, and `model` identity when known.

### Re-exported types

`@flue/react` re-exports these SDK types: `DeliveredAttachment`, `FlueClient`, `FlueConversationMessage`, `FlueConversationPart`, `FlueConversationSettlement`, `PromptUsage`.

## Patterns

### Basic chat component

```tsx
import { useFlueAgent } from '@flue/react';
import { useState } from 'react';

export function Chat({ conversationId }: { conversationId: string }) {
  const [input, setInput] = useState('');
  const agent = useFlueAgent({
    url: `/api/agents/support-assistant/${conversationId}`,
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    setInput('');
    await agent.sendMessage(message);
  }

  return (
    <section>
      <div aria-live="polite">
        {agent.messages.map((message) => (
          <article key={message.id}>
            <strong>{message.role}</strong>
            {message.parts.map((part) =>
              part.type === 'text' ? <p key={part.text}>{part.text}</p> : null,
            )}
          </article>
        ))}
      </div>

      <form onSubmit={submit}>
        <input value={input} onChange={(event) => setInput(event.target.value)} />
        <button disabled={!input.trim()} type="submit">
          Send
        </button>
      </form>
    </section>
  );
}
```

The `url` assumes `app.ts` mounted the agent at `/api/agents/support-assistant`; use whatever URL your route map chose.

### Custom auth / custom client

For custom headers, a bearer token, or custom `fetch`, build the client yourself and memoize it:

```tsx
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { useMemo } from 'react';

function Chat({ conversationId, token }: { conversationId: string; token: string }) {
  const client = useMemo(
    () =>
      createFlueClient({
        url: `/api/agents/support-assistant/${conversationId}`,
        token,
      }),
    [conversationId, token],
  );
  const agent = useFlueAgent({ client });
  // ...
}
```

The hook does **not** take ownership of a client you pass in. Share one instance between the rendered conversation and programmatic needs — call `observe()`, `wait()`, or `read()` on the same client when app code must await a specific submission's settlement or extract a reply outside the React tree. One client means one set of connections and one auth configuration.

### Deferred conversation identity

Omit `url` and `client` to keep the hook dormant while routing or application data resolves which conversation to show. Render it with the URL once known.

### New conversation

Render the hook with a fresh id appended to the mount URL. There is no "create conversation" call — the conversation is created on the first message it receives.

## Recommended use cases

- A chat UI over a Flue agent mounted with `createAgentRouter(...)`.
- Rendering custom tool interfaces: read `dynamic-tool` parts and their validated `output` instead of building a side channel of data events.
- Resuming a conversation across reloads or devices — the hook rebuilds the transcript from durable events, so nothing needs to be kept in client storage.
- Showing a conversation driven by the server (webhook, queue worker, schedule) — mount the hook on the conversation id and call `refresh()` when you expect it to have appeared.
- Attaching images to a user turn via `sendMessage(text, { images })`.

## When to use / when NOT to use

Use `useFlueAgent()` when a React tree needs maintained, live conversation state.

Do not use it for:

- **A single point-in-time read with no live updates** — use the SDK client's `history()` directly.
- **Awaiting a specific submission's outcome, or pulling a reply outside React** — use the shared `createFlueClient` instance's `observe()`, `wait()`, or `read()`.
- **Raw HTTP work** — the conversation routes (`POST /:id`, `GET /:id`, `POST /:id/abort`, `GET /:id/attachments/:attachmentId`) are documented under Routing / Streaming Protocol; the SDK wraps them and you rarely consume them by hand.
- **Cancelling server-side work from the browser** — there is no `stop()` on the hook, because ending browser observation does not cancel server work. Use the abort route / SDK `abort()`.

## Gotchas & constraints

- **Mounting is required and separate from registration.** The agent must be mounted in `app.ts` (`app.route('/agents/x', createAgentRouter(X))`) for the browser to reach it. Registering an agent (the `'use agent'` directive) only makes it addressable.
- **No built-in auth.** Anyone who can reach a conversation URL can send to it, read its full history, and abort its work. Conversation ids are caller-chosen path segments, so you need both authentication (who is the caller) and authorization (may this caller access *this* conversation id) as middleware in `app.ts` before the mount. There is no per-agent middleware export.
- **`sendMessage()` resolves on admission, not completion.** Use `status` and `settlements` to track the rest.
- **Retrying a failed send:** the underlying `AgentPromptOptions` (v2.0.8, bundled `sdk/flue-client` reference) has `message`, `initialData`, `uid`, and `signal` — no `idempotencyKey`. The `@flue/react` package README on GitHub (main branch, ahead of this installed version) additionally documents an `idempotencyKey`-forwarding option and a `deduplicated` flag on the send result; treat that as unreleased/aspirational for v2.0.8 rather than relying on it, and re-verify against the installed package's types before depending on it. For now, use `uid` (from a prior `AgentSendResult`) to target a specific instance incarnation on retry instead.
- **Memoize a custom `client`.** A new instance replaces the session. Likewise, changing `url`, `client`, or `live` replaces the current session.
- **SSR:** during server rendering the hook returns empty, idle state and opens no connections. A relative `url` resolves against the browser origin, so the server render stays dormant and the hook connects after hydration. React Strict Mode effect replay is supported.
- **Streaming text is best-effort.** Partial `text` and `reasoning` are best-effort while streaming; the completed canonical assistant message is authoritative.
- **Do not sort `messages` yourself.** The hook uses the SDK's materialized `observe()` layer: complete canonical snapshot, published atomically in durable order, continued from that exact checkpoint through reconnects and canonical resets. Transient stream failures retry with capped exponential backoff from a fresh snapshot, and redelivered chunks are deduped so at-least-once transports never double-apply deltas.
- **Transport:** live updates default to SSE and fall back to Durable Streams long-polling; `live: 'long-poll'` selects long-polling explicitly.
- **Not AI SDK types.** `FlueConversationMessage` is Flue's own shape. `@flue/react` does not depend on `ai` at runtime and does not implement its transport protocol.
- **Cross-origin apps** are handled at the mount in `app.ts` (see Routing), not by hook options.

## Related

- [Routing](https://flueframework.com/docs/guide/routing/) — `app.ts`, `createAgentRouter(...)`, the conversation URL surface, protecting mounts.
- [Agents](https://flueframework.com/docs/guide/building-agents/) — the `'use agent'` directive, conversation ids, `dispatch(...)`.
- [createFlueClient(...)](https://flueframework.com/docs/sdk/create-flue-client/) — `send()`, `wait()`, `observe()`, `history()`, `abort()`, `attachmentUrl()`.
- [Streaming Protocol](https://flueframework.com/docs/reference/streaming-protocol/) — the wire format under the hook.
- [Errors Reference](https://flueframework.com/docs/reference/errors/) — the shared machine-readable error envelope.
- [@flue/react README](https://github.com/withastro/flue/tree/main/packages/react#readme) — full option, result and part types.
- [examples/react-chat](https://github.com/withastro/flue/tree/main/examples/react-chat) — complete runnable chat UI.
