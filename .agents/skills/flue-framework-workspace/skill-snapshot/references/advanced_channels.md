---
title: Channels
source: https://flueframework.com/docs/guide/channels/
nav_section: advanced
topic: advanced / channels
last_updated_on_source: Jul 21, 2026
---

# Channels

## What it is

A channel connects an external provider (Slack, GitHub, Stripe, ...) to your agents. It is verified HTTP ingress: the channel package authenticates each incoming delivery against the provider's secret, answers protocol handshakes, and calls your handler with the provider's native payload types. Your handler routes the event into a durable agent conversation with `dispatch(...)`.

Channels are inbound-only. Flue has no outbound messaging API and no send-message abstraction over providers — outbound calls stay in your application, written against the provider's own SDK.

## API surface

### CLI

```sh
flue add channel slack
```

Blueprints are Markdown implementation guides your coding agent applies, not package installers. The Slack blueprint installs:

- `@flue/slack` — the ingress package (request verification + the channel's HTTP routes).
- `@slack/web-api` — Slack's own SDK, for outbound calls your application makes.

It produces one new module `src/channels/slack.ts` exporting the configured `channel` and the SDK `client`, plus a mount in `app.ts` and a reply tool bound into the target agent.

For a provider with no blueprint, pass a docs URL to the generic blueprint:

```sh
flue add channel https://developers.provider.example/webhooks
```

### Symbols

| Symbol | From | Notes |
| --- | --- | --- |
| `create<Provider>Channel({...})` e.g. `createSlackChannel` | `@flue/slack` (per-provider package) | Configures verification secret + one handler per protocol surface. |
| `channel.route()` | the channel object | Pure, mountable sub-router serving the channel's declared routes relative to the mount point. |
| `channel.instanceId(fields)` | conversation-shaped channels only | Canonical, collision-free conversation id from the destination's identifying fields. |
| `parseInstanceId(id)` | channel package | Recovers destination fields from a canonical id. Escape hatch — prefer `initialData`. |
| `createChannelRouter(routes)` | `@flue/runtime` | Builds the same mountable sub-router from a hand-written `routes` array. |
| `dispatch(agent, request)` | `@flue/runtime` | Delivers into a conversation. |
| `useDelivery()` | `@flue/runtime` | The message currently in front of the model, as a `DeliveredMessage`. |
| `useInitialData<T>()` | `@flue/runtime` | The conversation's creation data. |
| `defineTool({...})` | `@flue/runtime` | Used to wrap outbound SDK calls as model-callable tools. |

### Env vars (Slack example)

- `SLACK_SIGNING_SECRET` — inbound verification.
- `SLACK_BOT_TOKEN` — outbound calls.

Each provider's ecosystem page documents its own variables. Supply them like any other secret (see Provider credentials in the Models guide).

### dispatch fields used by channels

- `id` — the target conversation/instance id.
- `idempotencyKey` — the provider's redelivery-stable id.
- `initialData` — recorded once, when this delivery creates the conversation.
- `message` — `{ kind: 'signal', type, body, attributes? }`.

### Signal message shape

`DeliveredMessage` (Agent API):

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

- `type` — a namespaced event name you choose (`'slack.app_mention'`, `'github.issue_comment.created'`).
- `body` — a plain string.
- `attributes` — a string-to-string map of structured facts your verified handler attaches: sender, delivery id, resource identifiers.

## The channel module

```ts
import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { Assistant } from '../agents/assistant.ts';

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Served at POST /channels/slack/events (with the mount below).
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;
    if (payload.event.type !== 'app_mention') return;

    const event = payload.event;
    const thread = {
      teamId: payload.team_id,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
    };

    await dispatch(Assistant, {
      id: channel.instanceId(thread),
      // Slack redelivers events whose acknowledgement was slow or lost; the
      // event id names the delivery, so a retry never runs a second turn.
      idempotencyKey: payload.event_id,
      // Recorded once, when this delivery creates the conversation.
      initialData: {
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        startedBy: event.user,
      },
      message: {
        kind: 'signal',
        type: 'slack.app_mention',
        body: event.text,
        attributes: { eventId: payload.event_id },
      },
    });
  },
});
```

Handlers also receive the Hono context `c` alongside the provider's native payload types.

Package conventions:

- **Handlers select routes.** Each configured handler publishes its route (`events` -> `/events`, `interactions` -> `/interactions`, ...); omit a handler and its route does not exist. Most providers expose a single `webhook` handler at `/webhook`.
- **Return values become responses.** Returning nothing produces an empty `200`; a JSON-compatible value becomes a JSON response; a `Response` passes through unchanged — for surfaces (Slack slash commands, Discord interactions) whose protocol reads the acknowledgement body.
- **Acknowledge quickly.** `dispatch(...)` resolves as soon as the message is durably admitted; the agent runs asynchronously. Do not await agent output in the handler.
- **Deliveries can repeat.** Channel packages are stateless and do not deduplicate.

## Mounting

```ts
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
// Slack's Events API endpoint is now POST /channels/slack/events
```

`/channels/<provider>` is a convention, not a requirement. The URL you register with the provider is the mount plus the route suffix. The dispatch-target agent needs no mount of its own — the `'use agent'` directive registers it, and registration is all `dispatch(...)` requires.

Channel routes need no additional authentication middleware for the provider traffic: verification against the provider's secret is the authentication, and it happens inside the channel before your handler runs.

## Reading deliveries in the agent

```ts
'use agent';
import { useDelivery, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack.ts';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');

  const data = useInitialData<v.InferOutput<typeof Assistant.initialData>>();
  useTool(replyInThread(data));

  const delivery = useDelivery();
  const eventId = delivery.kind === 'signal' ? delivery.attributes?.eventId : undefined;

  return 'You participate in one Slack thread. Reply with the reply_in_slack_thread tool when a response is called for.';
}

Assistant.initialData = v.object({
  channelId: v.string(),
  threadTs: v.string(),
  startedBy: v.optional(v.string()),
});
```

Because the `initialData` schema static is declared, a conversation cannot exist without valid creation data, so no `undefined` narrowing is needed. Both hooks give code the same access the model has.

## Outbound: use provider SDKs

The blueprint exports a configured client from the channel module:

```ts
import { WebClient } from '@slack/web-api';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);
```

To let the model act on the provider, wrap exactly the actions needed as tools, binding the destination in trusted code:

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export function replyInThread(ref: { channelId: string; threadTs: string }) {
  return defineTool({
    name: 'reply_in_slack_thread',
    description: 'Reply in the Slack thread bound to this conversation.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const result = await client.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text: data.text,
      });
      return { output: { ts: result.ts ?? null } };
    },
  });
}
```

The model selects the reply text; it cannot select the workspace, the thread, the credential, or the Web API method. OAuth installation flows, token storage, and rotation are application concerns, outside the channel package.

## Recommended use cases

- A Slack app that answers in the thread it was mentioned in.
- A GitHub bot driven by issue/PR webhooks, one conversation per issue.
- Stripe/Shopify/Resend event feeds routed into an agent per customer, order, or occurrence.
- Support-desk integrations (Intercom, Zendesk, Linear) where each ticket is a conversation.
- Any provider webhook where signature verification, replay windows, and handshakes would otherwise be hand-rolled.

## Patterns

**One conversation per provider destination.** For conversation-shaped providers (Slack thread, GitHub issue, Teams chat), derive the id from the destination:

```ts
channel.instanceId({ teamId, channelId, threadTs }); // "slack:v1:T0123:C0456:1721760000.123456"
```

**Choose the id yourself for event feeds.** Stripe, Shopify, Notion, Resend have no inherent conversation shape and no `instanceId()` helper — pick per customer, per order, or per occurrence, the same choice a schedule makes.

**Idempotency on redelivery.** Pass the provider's redelivery-stable id as `idempotencyKey` (`payload.event_id` for Slack). A redelivered event converges on the original submission: same receipt, marked `deduplicated: true`, at most one answer. Carrying the same id in signal `attributes` keeps it visible for tracing.

**Filter early, dispatch thin.** Return from the handler for events the application does not care about, then dispatch a normalized signal.

**Trusted identifiers flow handler -> initialData/attributes -> tool factory.** The agent reads creation data and binds the reply tool to the thread, so the model never selects a destination.

**Hand-written channel.** A channel is just an object with declarative routes:

```ts
import type { Handler } from 'hono';

const webhook: Handler = async (c) => {
  const rawBody = await c.req.text();
  // Verify the provider's signature against the raw bytes before parsing,
  // then dispatch into an agent exactly like a packaged channel.
  return c.body(null, 200);
};

export const channel = {
  routes: [{ method: 'POST', path: '/webhook', handler: webhook }],
};
```

```ts
import { createChannelRouter } from '@flue/runtime';
import { channel as acme } from './channels/acme.ts';

app.route('/channels/acme', createChannelRouter(acme.routes));
```

## When to use / when not to use

Use a channel when:

- An external provider pushes verified HTTP webhooks you want to land in agent conversations.
- You want signature verification, replay-window enforcement and protocol handshakes handled before your code runs.

Do not use a channel when:

- **You need to send messages out.** There is no outbound Flue API — use the provider's own SDK, and wrap it as a tool (see the Tools guide) if the model should call it.
- **The transport is not verified HTTP delivery.** Long-lived sockets, polling loops, and provider-managed background transports stay in application-owned infrastructure.
- **The trigger is time-based, not provider-pushed.** Use a schedule instead; it makes the same conversation-id choice.
- **You just need a plain app route.** `dispatch(...)` works from any Hono route in `app.ts` — a channel only adds the provider verification and route layout. The Agents guide shows a hand-verified webhook route doing exactly this.

## Gotchas and constraints

- **Channels are inbound-only.** No reply routing, no send-message abstraction.
- **Stateless packages do not dedupe.** Without `idempotencyKey`, retried deliveries run extra turns.
- **Reusing an `idempotencyKey` with a different payload rejects with a 409 `submission_conflict`.** The key names the delivery, not the outcome.
- **Do not put short-lived provider capabilities in the dispatched message.** Interaction tokens, `response_url` values — signals enter model context and durable history; those belong only in immediate request handling.
- **Verify against the exact raw, unconsumed request body.** Signature checks run on raw bytes, before parsing.
- **Route suffixes must be non-empty paths beginning with `/`.**
- **`initialData` is recorded once** — ignored by every later send to an existing conversation. With a declared schema static, it is validated at admission, so a creating dispatch that omits or malforms it fails.
- **The instance id identifies, it does not authorize.** Protect mounted conversations separately (Routing guide, "Protecting your agents").
- **Avoid generic provider tools** that expose arbitrary destinations or API methods unless the application has an explicit authorization design.
- **Targets:** channel packages are built on Fetch and Web Crypto and run on both the Node and Cloudflare targets. (Dispatch durability itself differs by target — on Cloudflare work is admitted to the target agent's Durable Object; on Node it follows the configured persistence adapter, whose default in-memory store is process-lifetime only. Processing is at-least-once on both, so external side effects should be idempotent.)
- **Test both valid and invalid signatures**, plus the provider's protocol handshakes.

## Channel catalog

Blueprint names: `slack`, `discord`, `teams`, `google-chat`, `telegram`, `whatsapp`, `messenger`, `twilio`, `github`, `linear`, `notion`, `intercom`, `zendesk`, `stripe`, `shopify`, `resend`, `salesforce-marketing-cloud`. Each installs its ingress package (`@flue/slack`, `@flue/github`, ...) named on its ecosystem page.

## Related

- [Routing](https://flueframework.com/docs/guide/routing/) — the `app.ts` route map; [Dispatch-only agents](https://flueframework.com/docs/guide/routing/#dispatch-only-agents), [Protecting your agents](https://flueframework.com/docs/guide/routing/#protecting-your-agents)
- [Agents / dispatch()](https://flueframework.com/docs/guide/building-agents/#dispatch)
- [Tools / Protect access](https://flueframework.com/docs/guide/tools/#protect-access)
- [Agent Hooks / Passing data to the agent](https://flueframework.com/docs/guide/agent-hooks/#passing-data-to-the-agent), [Event hooks](https://flueframework.com/docs/guide/agent-hooks/#event-hooks)
- [Agent API](https://flueframework.com/docs/reference/agent-api/) — `dispatch()`, `DeliveredMessage`
- [Agent Hooks API](https://flueframework.com/docs/reference/agent-hooks-api/) — `useDelivery()`, `useInitialData()`
- [Schedules](https://flueframework.com/docs/guide/schedules/)
- [Models / Provider credentials](https://flueframework.com/docs/guide/models/#provider-credentials)
- [CLI: flue add](https://flueframework.com/docs/cli/add/)
- [Ecosystem channels](https://flueframework.com/docs/ecosystem/#channels)
