---
title: Routing
source: https://flueframework.com/docs/guide/routing/
section: guides
---

# Routing

## What it is

Flue never mounts an agent automatically. The `'use agent'` directive registers an agent (makes it addressable inside the app); serving it over HTTP is a separate, explicit decision made in `src/app.ts`. `app.ts` is the single HTTP entrypoint: its default export is the server, and every agent, channel, and custom route is mounted there by hand. There is no filename- or directory-based route generation — if a route exists, `app.ts` put it there.

## API surface

From `@flue/runtime/routing`:

- `createAgentRouter(agent)` — pure factory, no options, no side effects. Returns a mountable sub-router (exposes `.fetch`) that serves one agent's HTTP surface.
- `type Fetchable` — the shape a default export must satisfy: `{ fetch(request, env, ctx): Response | Promise<Response> }`.

From `@flue/runtime`:

- `dispatch(Agent, { id, message })` — server-side delivery into a conversation, no mount required. Returns a receipt.

Channel objects (from `./channels/<name>.ts`): `channel.route()` — a separate factory from the agent router, same pure/mountable kind.

SDK (`@flue/sdk`): `createFlueClient({ url, token })` → client with `send()`, `wait()`, `observe()`, `history()`, `abort()`, `attachmentUrl()`.
React (`@flue/react`): `useFlueAgent({ url })`.

File convention: `src/app.ts`, default export is the server.

### Routes served by `createAgentRouter`, relative to the mount

| Route | Purpose |
| --- | --- |
| `POST /:id` | Deliver one message (202 admission). |
| `GET /:id` | Read the conversation (snapshot, updates, or live stream). |
| `HEAD /:id` | Read conversation stream metadata. |
| `POST /:id/abort` | Abort in-flight and queued work. |
| `GET /:id/attachments/:attachmentId` | Download one attachment's bytes. |

### Scaffolded `app.ts`

```ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';

const app = new Hono();

app.route('/agents/hello', createAgentRouter(Hello));

export default app;
```

### Non-Hono entry typed with `Fetchable`

```ts
import type { Fetchable } from '@flue/runtime/routing';

const app: Fetchable = {
  fetch(request, env, ctx) {
    return new Response('Not found', { status: 404 });
  },
};

export default app;
```

A Hono app already satisfies `Fetchable`. On Cloudflare, `env` contains bindings and `ctx` is the execution context. On Node.js, `env` contains the Hono Node adapter bindings and `ctx` is `undefined`.

### Mounting several agents at arbitrary paths

```ts
app.route('/agents/support', createAgentRouter(Support));
app.route('/api/assistants/triage', createAgentRouter(Triage));
```

### Sending a message (HTTP)

```http
POST /agents/support/ticket-8472 HTTP/1.1
Content-Type: application/json

{
  "kind": "user",
  "body": "Can you summarize the open issues in my case?"
}
```

202 response body:

```json
{
  "streamUrl": "https://example.com/agents/support/ticket-8472",
  "offset": "-1",
  "submissionId": "sub_01HZX..."
}
```

Body is the same `DeliveredMessage` shape `dispatch(...)` admits — a `user` chat turn or a structured `signal` — optionally alongside `initialData` for instance creation.

### Reading

Plain `GET` on the conversation URL returns one materialized snapshot (every message reduced to complete, render-ready parts). Query params select live modes: `?view=updates&offset=...` reads changes after an offset, with long-polling or SSE for continuous streaming.

### SDK client over the same URL

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/support/ticket-8472',
  token: userToken,
});

const admission = await conversation.send({
  message: { kind: 'user', body: 'Can you summarize the open issues in my case?' },
});
await conversation.wait(admission);
const { messages } = await conversation.history();
```

The client takes no agent name or deployment address — the URL is the whole contract.

## Recommended use cases

- Exposing an agent to a web/chat UI: mount it and hand the client the conversation URL.
- Putting auth in front of an agent — session verification plus a per-conversation ownership check.
- Serving webhook receivers, health checks, and static assets from the same entrypoint as the agents.
- Mounting channel providers (Slack events, provider webhooks) next to agent routes.
- Keeping internal agents off the network entirely (dispatch-only) while still driving them from webhooks or schedules.

## Patterns

### Auth + ownership middleware before the mount

```ts
app.use('/agents/support/*', async (c, next) => {
  const user = await verifySession(c.req.raw); // your application's auth
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  // The conversation id is the first path segment after the mount.
  const [conversationId] = c.req.path.slice('/agents/support/'.length).split('/');
  if (!(await canAccessTicket(user, conversationId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
});
app.route('/agents/support', createAgentRouter(Support));
```

The `/*` pattern covers every route the agent router serves — prompts, reads, aborts, attachment downloads. Ordinary Hono composition applies: a broader prefix (`app.use('/agents/*', requireUser)`), bearer tokens, session cookies, signature verification, per-route rate limits.

Related: **server-issued ids** — derive the conversation id from the authenticated principal (`user-${user.id}`) or your own database, so the ownership check is an equality test.

### CORS for a cross-origin SPA

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

### Mounting a channel

```ts
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
// Slack's Events API endpoint is now POST /channels/slack/events
```

The channel package declares its route suffixes (`/events`, `/webhook`, `/interactions`, …); the mount point is yours.

### Directory-style mounting in userland (Vite glob)

```ts
import type { Agent } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();

const modules = import.meta.glob<Record<string, Agent>>('./agents/*.ts', { eager: true });
for (const mod of Object.values(modules)) {
  for (const [exportName, agent] of Object.entries(mod)) {
    if (typeof agent !== 'function' || !/^[A-Z]/.test(exportName)) continue; // agents are the capitalized exports
    app.route(`/agents/${agent.agentName ?? exportName}`, createAgentRouter(agent));
  }
}

export default app;
```

The glob only enumerates modules; each mount stays explicit. Filter it for agents that should stay dispatch-only.

### Dispatch-only agent behind a verified webhook

```ts
import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import { InvoiceAuditor } from './agents/invoice-auditor.ts';
import { verifyBillingWebhook } from './shared/billing.ts';

const app = new Hono();

// No createAgentRouter(InvoiceAuditor) mount anywhere — the agent is
// registered, but only this verified webhook can reach it.
app.post('/webhooks/billing', async (c) => {
  const event = await verifyBillingWebhook(c.req.raw);
  const receipt = await dispatch(InvoiceAuditor, {
    id: event.invoiceId,
    message: {
      kind: 'signal',
      type: 'billing.invoice.flagged',
      body: event.summary,
    },
  });
  return c.json(receipt, 202);
});

export default app;
```

Mounting and dispatching compose: an agent can be mounted for its chat UI *and* receive webhook signals through `dispatch(...)` — both feed the same per-conversation queue.

## When to use / when not to use

Use `createAgentRouter(...)` when an outside caller (browser, mobile app, partner service) needs to address conversations directly over HTTP, and you can put auth in front of it.

Do not mount when:

- **The agent is internal and only reacts to application events.** Keep it dispatch-only and call `dispatch(...)` from your own verified webhook route, a channel, or a schedule. Registration via `'use agent'` is enough.
- **The ingress is a provider webhook (Slack, etc.).** Use the channel's own `channel.route()` mount, not an agent router.
- **You want "send and wait for the reply" in one HTTP call.** That route does not exist. Use the SDK's `send()` + `wait()`, or read the conversation.
- **You need a private agent on Cloudflare reachable only from your backend.** Skip the public mount and use a service binding.
- **You want per-agent auth configuration.** There is no per-agent middleware export; auth is your framework's middleware in `app.ts`.
- **An internal dashboard needs to observe a dispatch-only agent.** Add a mount behind admin-only middleware rather than opening it up.

## Gotchas & constraints

- **No built-in authentication.** Anyone who can reach a conversation URL can send messages, read full history, and abort work on that conversation. Both checks are needed: authentication (who is the caller) and authorization (is this caller allowed this conversation id).
- **Conversation ids are caller-chosen path segments.** Without an ownership check, an authenticated user can read another user's conversation by guessing the id.
- **Sends are fire-and-forget.** `202` means durably admitted, not run. No wait-for-reply mode on the route.
- **Mount path is not identity.** Conversations are keyed by the agent's durable identity — its function name, or an `agentName` static override — never by URL. Moving a mount needs no data migration; mounting the same agent at two paths serves the same conversations from both.
- **CORS is your job.** The agent router sets no `Access-Control-*` headers. `vite dev` and `vite preview` apply permissive localhost CORS defaults, so a cross-origin setup that works locally can fail after deploy. Expose `Stream-Next-Offset`, `Stream-Up-To-Date`, and `Location` so the SDK can resume streams across reconnects. Same-origin deployments need no CORS config.
- **Targets.** The same `app.ts` works on both: on Node.js the built server serves whatever it exports; on Cloudflare the same export becomes the Worker's fetch handler. The `env`/`ctx` arguments differ (bindings + execution context on Cloudflare; Hono Node adapter bindings and `undefined` ctx on Node).
- **Hono is convention, not requirement.** The default export just needs a fetch-compatible shape, and the routers expose `.fetch`, so they mount in any fetch-based framework.
- **`createAgentRouter` carries no config.** Model, durability, and initial-data schema are declared on the agent module, not at the mount.

## Related

- Agents — https://flueframework.com/docs/guide/building-agents/ (`'use agent'` directive, `dispatch(...)`, `agentName` static)
- Agent SDK overview — https://flueframework.com/docs/sdk/overview/
- `createFlueClient(...)` — https://flueframework.com/docs/sdk/create-flue-client/
- React — https://flueframework.com/docs/guide/react/
- Channels — https://flueframework.com/docs/guide/channels/
- Schedules — https://flueframework.com/docs/guide/schedules/
- Streaming Protocol — https://flueframework.com/docs/reference/streaming-protocol/
- Errors reference — https://flueframework.com/docs/reference/errors/
- Node target — https://flueframework.com/docs/guide/node-target/
- Cloudflare target — https://flueframework.com/docs/guide/cloudflare-target/
- Deploy — https://flueframework.com/docs/guide/deploy/
