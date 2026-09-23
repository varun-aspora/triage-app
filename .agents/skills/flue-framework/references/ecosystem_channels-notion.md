---
title: Notion channel
source: https://flueframework.com/docs/ecosystem/channels/notion/
bundled_docs: ecosystem/channels/notion
version: 2.0.8
reviewed: 2026-09-17
---

# Notion channel

## When to use

Use the Notion channel when an agent must react to signed Notion webhook events
and optionally retrieve current resource state through the official Notion
client. Webhook payloads describe changes; they are not complete page snapshots.

The generated example groups page lifecycle and content events by page id and
binds a page-retrieval tool. Choose a different local instance identity for
comments, databases, data sources, views, or installations when the application
needs a different conversation boundary.

## Prerequisites and environment variables

- A Notion connection with access to the resources that should emit events.
- A public HTTPS webhook URL.
- A webhook subscription for only the required event types.
- An integration token with the minimum capabilities required by outbound calls.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | After setup | Verifies recurring signed webhook events. |
| `NOTION_TOKEN` | Yes for generated client | Authenticates outbound Notion API calls. |

The webhook verification token and API token are separate secrets. The official
client's declarations require `@types/node`; add it as a development dependency
and include `node` in a restrictive `compilerOptions.types` list when needed.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel notion
   ```

2. Review the generated `channels/notion.ts`. It installs `@flue/notion`, pins
   official `@notionhq/client@5.22.0`, and creates page identity and retrieval helpers.
3. Mount the channel:

   ```ts
   import { channel as notion } from './channels/notion.ts';

   app.route('/channels/notion', notion.route());
   ```

4. Configure the subscription URL:

   ```txt
   https://example.com/channels/notion/webhook
   ```

5. For initial setup only, temporarily configure the generated
   `verification({ verificationToken })` callback instead of `verificationToken`.
6. Receive the one-time unsigned token, securely persist it, complete provider
   subscription verification, and set `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
7. Redeploy with `verificationToken` enabled and remove the temporary setup callback.
8. Select event types, narrow on `event.type`, derive an application-owned
   instance id, and dispatch only relevant verified changes.
9. Bind the retrieval tool to the page selected by trusted application code.
   Test initial verification separately from recurring signed delivery.

While no verification token is configured, recurring signed events receive
`503` and the `webhook` callback does not run.

## Routing, dispatch, and outbound replies

The conventional route is:

```txt
POST /channels/notion/webhook
```

The generated page flow uses a local `notion-page:` id convention:

```ts
await dispatch(Assistant, {
  id: pageInstanceId(event.entity.id),
  message: {
    kind: 'signal',
    type: `notion.${event.type}`,
    body: JSON.stringify(event.data ?? {}),
    attributes: {
      eventId: event.id,
      pageId: event.entity.id,
      attemptNumber: String(event.attempt_number),
    },
  },
});
```

`@flue/notion` does not define a universal instance helper because unrelated
Notion resources have different useful boundaries. Include workspace or
installation identity when one agent can cross credential domains.

Outbound behavior uses the project-owned `Client`. The generated tool calls
`client.pages.retrieve()` for only the bound page. It is a retrieval flow, not
an automatic reply flow; create mutation or comment tools explicitly and bind
their resource and credential policy in trusted code.

## Recommended patterns

- Fetch current resource state after dispatch only when the selected action needs it.
- Keep page or installation identity in a validated local id or trusted `initialData`.
- Handle future authenticated event types in a safe default branch.
- Route deletion events to persistence rather than a retrieval tool that may fail.
- Subscribe only to events allowed by the connection's configured capabilities.
- Inject standards-based Fetch as generated and test SDK operations in the target runtime.

## Avoid

- Do not log, dispatch, or expose the one-time verification token.
- Do not leave the unauthenticated setup callback enabled after verification.
- Do not reserialize JSON before signature verification; exact bytes are signed.
- Do not retrieve every changed resource synchronously during webhook ingress.
- Do not assume a page event contains complete current page content.
- Do not let the model choose a workspace, page id, integration token, or API route.

## Security and idempotency gotchas

- Initial verification is an unsigned JSON request containing `verification_token`.
  Treat it as narrowly scoped temporary setup ingress.
- Recurring events use `X-Notion-Signature` with HMAC-SHA256 over exact request
  bytes and `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
- Notion can retry failed deliveries up to eight times with exponential backoff.
- Delivery order is not guaranteed.
- `event.id` is the stable delivery identity; `event.attempt_number` is retry metadata.
- The channel is stateless. Atomically claim `event.id` in durable application
  storage before dispatch when duplicate admission is unacceptable.
- Recreating or rotating a subscription requires updating the securely stored
  verification token.
- Directly mounted agent routes need application authentication and authorization.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Notion webhooks](https://developers.notion.com/reference/webhooks)
- [`@flue/notion` README](https://github.com/withastro/flue/tree/main/packages/notion#readme)
- `advanced_channels.md`
- `guides_routing.md`
