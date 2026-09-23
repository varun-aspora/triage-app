---
title: Channels
source: https://flueframework.com/docs/guide/channels/
bundled_docs:
  - guide/channels
  - ecosystem/channels/slack
  - reference/agent-api
  - reference/events
  - guide/routing
  - guide/durability
version: 2.0.8
reviewed: 2026-09-17
---

# Channels

## What and when

A channel is verified provider HTTP ingress. A provider package authenticates the exact raw request, enforces its protocol rules and replay window, handles handshakes, and gives an application handler the provider's native payload. The handler filters and normalizes the event, then calls `dispatch()`.

Channels are inbound-only. Outbound replies use the provider's official SDK from application code or a narrow Flue tool. Use channels for provider webhooks; use schedules for time triggers and ordinary `app.ts` routes for application-owned ingress.

## Current API

| Surface | Purpose |
| --- | --- |
| `create<Provider>Channel(options)` | Configure verification and selected provider callbacks. |
| `channel.route()` | Pure mountable router for configured callbacks. |
| `channel.instanceId(fields)` | Canonical id for conversation-shaped providers. |
| `channel.parseInstanceId(id)` | Recover fields when creation data is unavailable; prefer `initialData`. |
| `createChannelRouter(routes)` | Mount a hand-written channel definition. |
| `dispatch(agent, request)` | Durably admit normalized input. |
| `useDelivery()` / `useInitialData()` | Read per-delivery and creation facts in the agent. |
| Provider SDK | Perform outbound actions. |

Exact dispatch fields in 2.0.8:

```ts
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

The key is at most 256 characters and scoped to `(agent, id)`. An exact replay returns the same receipt with `deduplicated: true`; the same key with another payload rejects with `SubmissionConflictError` (`submission_conflict`, HTTP 409 on transports).

Channel signals use:

```ts
{
  kind: 'signal',
  type: string,
  body: string,
  attributes?: Record<string, string>,
  tagName?: string,
}
```

## How to: Slack end to end

### 1. Fetch and apply the blueprint

```bash
bunx flue add channel slack --print
```

A blueprint is an implementation guide, not a package installer. The Slack blueprint adds `@flue/slack` for verified ingress and `@slack/web-api` for outbound calls. Other providers follow the same split.

### 2. Configure verified ingress and idempotent delivery

```ts
// src/channels/slack.ts
import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import { Assistant } from '../agents/assistant.ts';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

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
      idempotencyKey: payload.event_id,
      initialData: {
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        startedBy: event.user,
      },
      message: {
        kind: 'signal',
        type: 'slack.app_mention',
        body: event.text,
        attributes: {
          eventId: payload.event_id,
          senderId: event.user,
        },
      },
    });
  },
});
```

`SLACK_SIGNING_SECRET` verifies ingress. `SLACK_BOT_TOKEN` authenticates outbound SDK calls. Slack may retry an event, so use its stable `event_id` as the delivery key. Also retain it in attributes for tracing.

### 3. Mount only the channel routes

```ts
// src/app.ts
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
```

Configured Slack callbacks publish relative routes: `events` at `/events`, `interactions` at `/interactions`, and `commands` at `/commands`. Omitted callbacks create no route. With this mount, register `/channels/slack/events` in Slack.

The target agent needs no HTTP mount. Provider signature verification is the channel route's ingress authentication, but application code must still enforce allowed workspaces, enterprises, repositories, accounts, or tenants from the verified payload.

### 4. Bind trusted destination data into the agent

```ts
// src/agents/assistant.ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack.ts';

const initialData = v.object({
  channelId: v.string(),
  threadTs: v.string(),
  startedBy: v.optional(v.string()),
});

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This conversation must be created by Slack ingress.');
  useTool(replyInThread(data));
  return 'Participate in the bound Slack thread and use the reply tool when needed.';
}

Assistant.initialData = initialData;
```

`initialData` is validated and recorded only when the first delivery creates the conversation. Per-event facts belong in signal attributes. The model should not parse or choose provider destinations.

### 5. Use the provider SDK for outbound calls

```ts
// src/channels/slack.ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export function replyInThread(ref: { channelId: string; threadTs: string }) {
  return defineTool({
    name: 'reply_in_slack_thread',
    description: 'Reply in the Slack thread bound to this conversation.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data, toolCallId }) {
      const result = await postSlackOnce(toolCallId, () =>
        client.chat.postMessage({
          channel: ref.channelId,
          thread_ts: ref.threadTs,
          text: data.text,
        }),
      );
      return { output: { channel: result.channel ?? null, ts: result.ts ?? null } };
    },
  });
}
```

`postSlackOnce` represents application-owned deduplication keyed by the stable tool call id. Use a provider-native idempotency field when available, otherwise claim the key in durable application storage. Ingress deduplication does not make outbound effects exactly once.

### 6. Handle protocol response bodies promptly

Returning nothing from a channel callback produces an empty `200`; a JSON-compatible value becomes JSON; a `Response` passes through. Return protocol-required acknowledgement bodies immediately. Do not wait for agent completion in the provider request.

## Hand-written provider channel

```ts
import { createChannelRouter, type ChannelRouteDefinition } from '@flue/runtime';

const routes: ChannelRouteDefinition[] = [{
  method: 'POST',
  path: '/webhook',
  async handler(c) {
    const raw = await c.req.arrayBuffer();
    await verifySignature(raw, c.req.raw.headers);
    const payload = JSON.parse(new TextDecoder().decode(raw));
    await deliver(payload);
    return c.body(null, 200);
  },
}];

app.route('/channels/acme', createChannelRouter(routes));
```

Verify the unconsumed raw bytes before parsing. Route suffixes must be non-empty and begin with `/`. Test valid signatures, invalid signatures, timestamps/replay windows, handshakes, and provider retries.

## Recommended patterns

- Map one provider destination to one conversation: Slack thread, GitHub issue, support ticket, or Teams chat.
- For event feeds without `instanceId()`, deliberately choose per-customer, per-resource, or per-event conversation ids.
- Filter irrelevant event families and bot/self events before dispatch.
- Use the provider delivery id as `idempotencyKey`; keep it in signal attributes for tracing too.
- Bind workspace, channel, repository, or account identifiers from verified payloads into narrow tool factories.
- Keep provider OAuth installation, token rotation, workspace authorization, and outbound retries in application code.

## Avoid

- Do not use a channel as an outbound abstraction; Flue has none.
- Do not acknowledge only after the agent replies.
- Do not trust a guessed conversation id as provider authorization.
- Do not expose generic tools that let the model select credentials, arbitrary destinations, or API methods.
- Do not put short-lived capabilities such as `response_url`, interaction tokens, or `trigger_id` into durable signals, model context, or logs.
- Do not parse JSON before signature verification when the provider signs raw bytes.

## Gotchas

- Channel packages are stateless. Without `idempotencyKey`, a provider redelivery creates another submission.
- `submission_queued` runtime events are live and at least once; a deduplicated retry can re-emit it with the same `submissionId`.
- A signing secret authenticates the provider/app request, not necessarily an allowed tenant. Enforce payload-level allowlists.
- `initialData` is ignored after creation. Schema validation happens at creating admission.
- Node delivery is restart-durable only with a durable adapter. Cloudflare delivery is admitted to the destination Durable Object.
- Processing is at least once on both targets. Outbound SDK calls need provider or application idempotency.
- Interaction and command callbacks may require a provider-specific response body even when no agent delivery occurs.

## Related

- [Channels](https://flueframework.com/docs/guide/channels/)
- [Slack](https://flueframework.com/docs/ecosystem/channels/slack/)
- [Agent API](https://flueframework.com/docs/reference/agent-api/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Tools](https://flueframework.com/docs/guide/tools/)
- [Durability](https://flueframework.com/docs/guide/durability/)
