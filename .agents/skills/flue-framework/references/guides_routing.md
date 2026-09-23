---
title: Routing
source: https://flueframework.com/docs/guide/routing/
bundled_docs:
  - guide/routing
  - reference/agent-api
  - reference/streaming-protocol
  - sdk/create-flue-client
  - sdk/flue-client
version: 2.0.8
reviewed: 2026-09-17
---

# Routing

## What and when

`app.ts` is the application's explicit HTTP route map. The `'use agent'` directive registers an agent for in-process addressing; it does not expose the agent over HTTP. Mount `createAgentRouter(Agent)` only when a browser, mobile client, or external service needs the conversation HTTP surface. Keep internal, channel-driven, and schedule-driven agents dispatch-only.

Flue uses Hono by convention, but the default export only needs the fetch-compatible `Fetchable` shape. The same `app.ts` runs on Node and Cloudflare.

## Current API

### Agent router

```ts
import { createAgentRouter, type Fetchable } from '@flue/runtime/routing';

function createAgentRouter(agent: Agent): Hono;

interface Fetchable {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
```

`createAgentRouter()` is a pure factory with no options. Relative to its mount, it serves:

| Route | Behavior |
| --- | --- |
| `POST /:id` | Admit one message; returns `202` before execution. |
| `GET /:id` | History by default, or projected updates selected by query. |
| `HEAD /:id` | Stream metadata in headers. |
| `POST /:id/abort` | Record an abort for running and queued submissions. |
| `GET /:id/attachments/:attachmentId` | Return immutable attachment bytes. |

The HTTP body is a `DeliveredMessage` object with optional top-level `initialData`, `uid`, and `idempotencyKey` siblings. It does not accept the bare-string shorthand — the request parser only skips sibling-peeling for a non-object body, and then validates that body as a `DeliveredMessage` union on `kind`, which a bare string never satisfies.

```ts
type PromptBody = DeliveredMessage & {
  initialData?: unknown;
  uid?: string | null;
  idempotencyKey?: string;
};
```

Admission returns:

```ts
interface AgentSendResult {
  streamUrl: string;
  offset: string;
  submissionId: string;
  uid: string;
  deduplicated?: true;
}
```

**Verified against the installed package, not just the docs page.** The published guide and reference pages (and several sibling reference files in this skill, e.g. `guides_building-agents.md`, `advanced_workflows.md`, `advanced_schedules.md`) state that the direct HTTP prompt route has no `idempotencyKey` field and that only server-side `dispatch()` supports it. Reading the installed `@flue/runtime@2.0.8` source (`dist/dispatch-*.mjs`, functions `parseDeliveredInput` and `handleAgentRequest`, which is what `createAgentRouter()`'s `POST /:id` actually calls on both targets) shows the opposite: the HTTP body parser explicitly destructures and validates `idempotencyKey` alongside `initialData`/`uid`, and the `202` response conditionally echoes `deduplicated: true` exactly as `dispatch()`'s receipt does. So the wire protocol itself supports it. The gap is one layer up: the documented `@flue/sdk` `AgentPromptOptions` (`FlueClient.send()`) has no `idempotencyKey` option, so there is no supported way to set it through the SDK — only by POSTing the JSON body yourself. Prefer server-side `dispatch()` for anything that needs idempotent redelivery; treat hand-rolled HTTP `idempotencyKey` as an unsupported, undocumented capability that could change without notice.

`202` means the input was admitted, not that the model ran or the submission completed. There is no `?wait` mode. A plain `GET` is `?view=history`; incremental reads use `?view=updates&offset=<opaque>&live=long-poll|sse`.

### Server-side delivery

```ts
import { dispatch } from '@flue/runtime';

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

`idempotencyKey` is at most 256 characters and scoped to `(agent, id)`. An exact replay returns the original receipt with `deduplicated: true`; reusing the key with a different payload rejects with `submission_conflict`. This deduplicates delivery, not at-least-once execution of the admitted submission's external effects.

### Hosted conversation client

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/support/ticket-8472',
  token: userToken,
});

const admission = await conversation.send({
  message: { kind: 'user', body: 'Summarize the open issues.' },
});
const reply = await conversation.read(admission);
```

One client addresses one complete conversation URL. Its surface is `send()`, `read()`, `wait()`, `abort()`, `history()`, `observe()`, and `attachmentUrl()`. `send()` resolves at admission; `read()` waits and returns the reply; `wait()` waits for settlement and returns no reply. Cancelling a read only stops the local observer. Call `abort()` to stop server work durably.

## How to: expose a protected agent

### 1. Mount the router

```ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';

const app = new Hono();
app.route('/agents/support', createAgentRouter(Support));
export default app;
```

The conversation URL is the mount plus the caller-chosen id, for example `/agents/support/ticket-8472`. The mount path is not storage identity. Moving it does not migrate data; the agent function name or `agentName` static is the durable identity.

### 2. Authenticate and authorize every sub-route

```ts
app.use('/agents/support/*', async (c, next) => {
  const user = await verifySession(c.req.raw);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const [conversationId] = c.req.path.slice('/agents/support/'.length).split('/');
  if (!(await canAccessTicket(user.id, conversationId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
});

app.route('/agents/support', createAgentRouter(Support));
```

Place middleware before the mount. The `/*` coverage matters because reads, aborts, and attachment downloads are as sensitive as sends. Prefer server-issued ids derived from the authenticated principal or an application record.

### 3. Configure production CORS only when cross-origin

```ts
import { cors } from 'hono/cors';

app.use(
  '/agents/*',
  cors({
    origin: 'https://app.example.com',
    credentials: true,
    exposeHeaders: ['Stream-Next-Offset', 'Stream-Up-To-Date', 'Location'],
  }),
);
```

Development and preview provide localhost CORS defaults; deployed routers do not. Same-origin applications need no CORS middleware.

### 4. Keep trusted webhook ingress dispatch-only

```ts
app.post('/webhooks/billing', async (c) => {
  const event = await verifyBillingWebhook(c.req.raw);
  const receipt = await dispatch(InvoiceAuditor, {
    id: event.invoiceId,
    idempotencyKey: event.deliveryId,
    message: {
      kind: 'signal',
      type: 'billing.invoice.flagged',
      body: event.summary,
      attributes: { deliveryId: event.deliveryId },
    },
  });
  return c.json(receipt, 202);
});
```

No agent mount is required. Verification and destination selection stay in trusted application code.

## Recommended patterns

- Mount explicit public surfaces; leave internal agents unmounted.
- Use `idempotencyKey` on server-side webhook, channel, queue, and scheduler dispatches when the upstream delivery can repeat.
- Persist the admission or `submissionId`, then reattach with `read()` after a caller crash.
- Use `uid: null` for create-only sends and a string `uid` to continue only the expected incarnation. A uid is an ETag-like condition, not authorization.
- Mount channel routers separately with `app.route('/channels/slack', slack.route())`.
- On Cloudflare, use the SDK's custom `fetch` option with a service binding for private cross-Worker access.

## Avoid

- Do not assume registration creates a route.
- Do not expose a mount without both authentication and per-conversation authorization.
- Do not wait for agent output in a webhook request; acknowledge after dispatch admission.
- Do not hand-parse stream offsets or implement streaming when `@flue/sdk` fits.
- Do not rely on `FlueClient.send()` for idempotent redelivery; its `AgentPromptOptions` has no `idempotencyKey` field. Prefer server-side `dispatch()` (or a trusted route that calls it) whenever redelivery must converge.
- Do not expose attachment URLs without applying the same authorization as conversation history.

## Gotchas

- Inputs to one conversation share one accepted order. A busy delivery may join the live response at a turn boundary; otherwise it remains queued.
- `initialData` is validated and recorded only when the send creates the instance, then ignored on later sends. Pair it with `uid: null` when silently continuing would be a bug.
- The `offset` is opaque and reads are exclusive. Resume only with server-provided values.
- `attachmentUrl()` only returns a URL; it does not attach client auth to an `<img>` or manual fetch.
- Node admission survives restart only with durable persistence. Cloudflare admission is stored in the target Durable Object.
- Both targets process accepted work at least once. Make external side effects idempotent even when ingress delivery is deduplicated.

## Related

- [Agents](https://flueframework.com/docs/guide/building-agents/)
- [Streaming Protocol](https://flueframework.com/docs/reference/streaming-protocol/)
- [FlueClient](https://flueframework.com/docs/sdk/flue-client/)
- [Channels](https://flueframework.com/docs/guide/channels/)
- [Schedules](https://flueframework.com/docs/guide/schedules/)
- [Deploy](https://flueframework.com/docs/guide/deploy/)
