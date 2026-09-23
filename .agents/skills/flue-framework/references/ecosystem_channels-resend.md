---
title: Resend channel
source: https://flueframework.com/docs/ecosystem/channels/resend/
bundled_docs: ecosystem/channels/resend
version: 2.0.8
reviewed: 2026-09-17
---

# Resend channel

## When to use

Use the Resend channel for verified Resend webhook events and application-owned
email operations through the official SDK. The generated example handles
`email.received`, creates one agent instance per inbound email, and lets that
agent retrieve the complete message later.

This is a message-scoped flow, not an email-thread abstraction. Define and
persist reply grouping, sender policy, recipients, and outbound behavior in
application code.

## Prerequisites and environment variables

- A Resend account and webhook endpoint.
- For inbound email, a configured receiving domain and applicable DNS setup.
- A public HTTPS Flue deployment.
- An API key with only the permissions required by project-owned SDK calls.

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_WEBHOOK_SECRET` | Yes | Verifies inbound Svix-format deliveries. |
| `RESEND_API_KEY` | Yes | Authenticates official Resend SDK calls. |

The webhook secret and API key are separate credentials. The SDK declarations
reference Node and React types, so add `@types/node` and `@types/react` as
development dependencies; these add no runtime code to a Worker bundle.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel resend
   ```

2. Review the generated `channels/resend.ts`. It installs `@flue/resend`, pins
   official `resend@6.12.4`, and exports the verified channel, project-owned
   client, local email-id helpers, and retrieval tool.
3. Set `RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY` using trusted server secrets.
4. Mount the channel:

   ```ts
   import { channel as resend } from './channels/resend.ts';

   app.route('/channels/resend', resend.route());
   ```

5. Register this complete URL in Resend:

   ```txt
   https://example.com/channels/resend/webhook
   ```

6. Subscribe only to required events. For inbound processing, include
   `email.received` and finish receiving-domain setup separately.
7. Narrow on the native `event.type`, dispatch routing metadata promptly, and
   return `200` without fetching full content in the handler.
8. Bind `retrieveReceivedEmail()` to the verified `email_id` in trusted code.
   Add attachment retrieval or outbound tools only with explicit content policy.
9. Test exact-body signatures, stale or malformed Svix headers, replayed events,
   retrieval failures, and unexpected outbound destinations.

## Routing, dispatch, and outbound replies

The conventional route is:

```txt
POST /channels/resend/webhook
```

The webhook contains routing metadata rather than the complete inbound body:

```ts
await dispatch(Assistant, {
  id: emailInstanceId(event.data.email_id),
  message: {
    kind: 'signal',
    type: 'resend.email.received',
    body: event.data.subject,
    attributes: {
      deliveryId: delivery.id,
      emailId: event.data.email_id,
      messageId: event.data.message_id,
      from: event.data.from,
      to: event.data.to.join(', '),
    },
  },
});
```

The generated retrieval tool calls:

```ts
client.emails.receiving.get(emailId)
```

Use `client.emails.receiving.attachments` only when attachment content is needed
and authorized for model context or persistence. Outbound send, forward, and
reply tools should bind credentials, approved sender identity, recipients, and
policy outside model-selected arguments.

## Recommended patterns

- Keep one local agent instance per inbound `email_id` unless application state defines a thread.
- Dispatch envelope metadata first and retrieve full content asynchronously on demand.
- Handle newer verified SDK event types with a safe default branch.
- Keep attachment download and model-ingestion decisions separate.
- Store delivery ids before non-idempotent effects.
- Test the real SDK against a fail-closed local Fetch transport in each target runtime.

## Avoid

- Do not use `message_id` as an assumed stable email thread root.
- Do not fetch bodies or attachments automatically for every inbound event.
- Do not expose API keys, webhook secrets, recipients, or sender identities to model choice.
- Do not return a non-`200` response unless redelivery is intended.
- Do not assume webhooks arrive once or in lifecycle order.
- Do not treat the local `resend-email:` id as authorization.

## Security and idempotency gotchas

- `@flue/resend` passes the exact body and `svix-id`, `svix-timestamp`, and
  `svix-signature` values to the official verifier before invoking the handler.
- Resend retries every response status other than `200` on a fixed backoff
  schedule (5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, then 10 hours),
  each attempt starting only after the previous one fails.
- Delivery is at least once and ordering is not guaranteed.
- `delivery.id` is the verified `svix-id` documented for deduplication.
- Atomically claim that id in durable application storage before dispatch when
  duplicate admission or duplicate side effects are unacceptable.
- Manual replay can redeliver even previously successful events; idempotency must
  cover operator-initiated replay as well as automatic retry.
- Receiving domains, MX records, webhook registration, secret rotation,
  persistence, and outbound reply policy remain application-owned.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Resend webhooks](https://resend.com/docs/dashboard/webhooks/introduction)
- [`@flue/resend` README](https://github.com/withastro/flue/tree/main/packages/resend#readme)
- `advanced_channels.md`
- `guides_routing.md`
