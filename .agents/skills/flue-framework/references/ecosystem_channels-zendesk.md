---
title: Zendesk Channel
source: https://flueframework.com/docs/ecosystem/channels/zendesk/
provider_docs: https://developer.zendesk.com/api-reference/webhooks/event-types/webhook-event-types/
section: ecosystem
topic: ecosystem / channels / zendesk
flue_version: 2.0.8
---

# Zendesk Channel

## What it is

`@flue/zendesk` verifies Zendesk JSON event-subscription webhooks and provides
account-scoped ticket identity helpers. The blueprint generates a narrow native
Fetch Ticketing API client because Zendesk has no officially supported Node
server SDK; it also installs `lossless-json` to preserve large identifiers.

Use it when provider-defined Zendesk events should wake a durable agent per
account and ticket. Custom trigger/automation payloads, Sunshine Conversations,
and Zendesk AI Agent webhooks are different protocols.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `ZENDESK_WEBHOOK_SIGNING_SECRET` | yes | Verify event body and signature timestamp. |
| `ZENDESK_ACCOUNT_ID` | yes | Restrict tenant and scope resource identity. |
| `ZENDESK_WEBHOOK_ID` | optional | Restrict ingress to one configured webhook. |
| `ZENDESK_SUBDOMAIN` | yes | Fix the Ticketing API origin. |
| `ZENDESK_EMAIL` | yes | Identify the API-token user. |
| `ZENDESK_API_TOKEN` | yes | Authenticate outbound Ticketing API calls. |

Create a JSON event-subscription webhook. Confirm that the account exposes the
ticket event subscriptions used by the app; Zendesk's event catalog and Support
UI list them, while another developer guide still recommends triggers or
automations for ticket activity.

## How to

1. Apply the blueprint:

```sh
bunx flue add channel zendesk
```

2. Set the signing and Ticketing API credentials in deployment secrets.
3. Configure the JSON event-subscription endpoint:

```txt
https://example.com/channels/zendesk/webhook
```

4. Mount the generated channel:

```ts
import { channel as zendesk } from './channels/zendesk.ts';

app.route('/channels/zendesk', zendesk.route());
```

5. Narrow `payload.type`, validate that ticket ids in `subject` and `detail.id`
   agree, dispatch with the signed event id, and bind ticket tools to
   `initialData`.

## Verified inbound route

- Route: `POST /channels/zendesk/webhook` for the conventional mount.
- Factory: `createZendeskChannel({ signingSecret, accountId, webhookId?, webhook })`.
- Callback: `{ c, payload, delivery }`.
- Signature: base64 HMAC-SHA256 over signature timestamp concatenated directly
  with the exact body, with no delimiter.
- Response: no return means empty `200`; JSON-compatible values become JSON;
  a normal `Response` passes through. Unsupported return values fail closed
  with retryable `409`.

The package requires Zendesk account, webhook, invocation, signature, and
signature-timestamp headers. It checks payload `account_id` against the account
header and configured account, and can restrict the configured webhook id.

The HMAC covers timestamp plus body, not account, webhook, or invocation
headers. `delivery.webhookId`, `delivery.invocationId`, and
`delivery.signatureTimestamp` are routing metadata, not signed authorization
claims. Zendesk documents no timestamp freshness window, so Flue does not
invent one.

## Instance identity and idempotency

Validate application identity before using the package helper:

```ts
const ticketId = ticketIdFromEvent(payload.subject, payload.detail);
if (!ticketId) return c.json({ error: 'Expected a ticket event.' }, 400);

const ref = { accountId: payload.account_id, ticketId };
await dispatch(Assistant, {
  id: channel.instanceId(ref),
  idempotencyKey: payload.id,
  initialData: ref,
  message: {
    kind: 'signal',
    type: `zendesk.${payload.type}`,
    body: JSON.stringify(payload.event),
    attributes: {
      eventId: payload.id,
      ticketId,
      occurredAt: payload.time,
      invocationId: delivery.invocationId,
    },
  },
});
```

| Concern | Stable value |
| --- | --- |
| Agent instance | `channel.instanceId({ accountId, ticketId })` |
| Delivery idempotency | signed body field `payload.id` |
| Attempt correlation only | unsigned `delivery.invocationId` |

Ticket/resource ids are account-scoped, so always include account identity.
`parseInstanceId()` is an escape hatch; prefer validated creation data. The
package is stateless; claim `payload.id` durably when admission coordinates
other application writes.

Zendesk ids can exceed JavaScript's safe integer range. The package and
generated client use lossless parsing so unsafe integers remain decimal strings.
Never round identity through `Number`.

## Outbound client tool pattern

The generated client fixes a validated bare subdomain and uses documented
Basic authentication as `{email}/token:{api_token}`:

```ts
export const client = createZendeskClient({
  subdomain: process.env.ZENDESK_SUBDOMAIN!,
  email: process.env.ZENDESK_EMAIL!,
  apiToken: process.env.ZENDESK_API_TOKEN!,
});

export function retrieveTicket(ref: ZendeskTicketRef) {
  if (ref.accountId !== process.env.ZENDESK_ACCOUNT_ID) {
    throw new TypeError('Unexpected Zendesk account.');
  }
  return defineTool({
    name: 'retrieve_zendesk_ticket',
    description: 'Retrieve the ticket bound to this agent.',
    async run() {
      return { output: await client.getTicket(ref.ticketId) };
    },
  });
}
```

Bind the account and ticket from validated `initialData`. The model chooses no
account, ticket, host, credential, URL, or generic API operation.

## Recommended patterns

- Require ticket identity in `subject` and `detail.id` to agree.
- Use signed `payload.id` for idempotency and keep invocation id only for tracing.
- Restrict both account and webhook id when the deployment has one expected source.
- Keep the Ticketing API origin fixed to `<subdomain>.zendesk.com`.
- Parse all webhook and API identifiers losslessly.
- Filter event types and validate fields independently for each subscribed type.
- Test synthetic valid/tampered bodies, large ids, missing headers, account
  mismatch, and timeout/retry responses.

## Avoid

- Do not treat unsigned delivery headers as authorization or dedupe identity.
- Do not accept an arbitrary API base URL from a webhook or model.
- Do not use a host-mapped Help Center domain as the Ticketing API origin.
- Do not treat custom trigger payloads as the fixed common event envelope.
- Do not block acknowledgement on Ticketing API calls or agent completion.
- Do not assume ticket subscriptions exist in every Zendesk account/UI.

## Gotchas and security

- The provider-native envelope keeps snake_case fields and open `type` strings;
  future authenticated fields are forwarded through an index signature.
- Zendesk allows 12 seconds. It retries `409` up to three times, conditionally
  retries `429`/`503` only when the response's `Retry-After` is under 60
  seconds, and retries timeouts up to five times; plain `500`/`502`/`504`
  responses are not retried at all. Delivery remains best effort and can be
  duplicated or omitted.
- Use exact `200` for ordinary acknowledgement.
- The package does not create subscriptions, deduplicate, infer ticket ids,
  manage API tokens, or support unrelated Zendesk webhook products.
- The generated client uses Fetch plus `Buffer` for Basic auth and runs in
  Workers with Flue's `nodejs_compat`; Node types are declaration support only.

## Related

- [Flue channels](./advanced_channels.md)
- [Zendesk event types](https://developer.zendesk.com/api-reference/webhooks/event-types/webhook-event-types/)
- [Zendesk Ticketing API](https://developer.zendesk.com/api-reference/ticketing/introduction/)
- [`@flue/zendesk` README](https://github.com/withastro/flue/tree/main/packages/zendesk#readme)
