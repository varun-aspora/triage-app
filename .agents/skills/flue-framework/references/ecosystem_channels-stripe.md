---
title: Stripe Channel
source: https://flueframework.com/docs/ecosystem/channels/stripe/
provider_docs: https://docs.stripe.com/webhooks
section: ecosystem
topic: ecosystem / channels / stripe
flue_version: 2.0.8
---

# Stripe Channel

## What it is

`@flue/stripe` verifies Stripe webhook events with Stripe's official `stripe`
SDK. The same project-owned SDK client performs outbound API calls and can be
wrapped in narrowly scoped agent tools.

Use it when snapshot or thin event notifications should drive an agent keyed
by a billing resource. Stripe has no universal conversation identity; select a
customer, subscription, account, Checkout Session, or other resource according
to the workflow.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `STRIPE_WEBHOOK_SECRET` | yes | Verify this event destination's signatures. |
| `STRIPE_SECRET_KEY` | yes for outbound/thin fetches | Authenticate SDK calls. |

Create an HTTPS event destination, select only required event types, and keep
its API version aligned with the installed SDK declarations. Snapshot and thin
destinations use different payloads and must be configured deliberately.

## How to

1. Apply the blueprint:

```sh
bunx flue add channel stripe
```

2. Set the endpoint signing secret and API key in deployment secrets.
3. Configure the destination URL:

```txt
https://example.com/channels/stripe/webhook
```

4. Mount the generated channel:

```ts
import { channel as stripe } from './channels/stripe.ts';

app.route('/channels/stripe', stripe.route());
```

5. Subscribe only to handled types. Narrow `event.type`, validate the resource
   used as identity, dispatch promptly, and bind resource-specific SDK tools.

## Verified inbound route

- Route: `POST /channels/stripe/webhook` for the conventional mount.
- Factory: `createStripeChannel({ client, webhookSecret, eventPayload?, webhook })`.
- Default mode: snapshot `Stripe.Event`.
- Thin mode: set `eventPayload: 'thin'`; callback gets
  `Stripe.V2.Core.EventNotification` with `fetchEvent()` and
  `fetchRelatedObject()`.
- Verification: the official SDK receives exact bytes plus `Stripe-Signature`
  before the callback runs.
- Response: no return means empty `200`; JSON-compatible data becomes JSON;
  a normal `Response` passes through.

The package rejects a payload that does not match the configured snapshot/thin
mode. It forwards verified future event types even when installed TypeScript
declarations do not yet know them.

## Instance identity and idempotency

The checkout example keeps one agent per Stripe customer:

```ts
const customerId =
  typeof session.customer === 'string' ? session.customer : session.customer?.id;
if (!customerId) return;

await dispatch(Billing, {
  id: customerId,
  idempotencyKey: event.id,
  initialData: { customerId },
  message: {
    kind: 'signal',
    type: `stripe.${event.type}`,
    body: `Checkout session ${session.id} is ${session.payment_status}.`,
    attributes: { eventId: event.id, customerId, sessionId: session.id },
  },
});
```

| Concern | Stable value |
| --- | --- |
| Agent instance | Application-selected, account-scoped billing resource. |
| Delivery idempotency | Signed event body field `event.id`. |
| Business duplicate detection | Resource id plus event type when Stripe emits separate Event objects. |

For Connect or organization destinations, include verified `event.account` or
`event.context` in resource identity when namespaces require it. Do not collapse
same-looking customer ids from different accounts.

`event.id` deduplicates redelivery of one Event object. Stripe can emit two
different Event objects for one resource change, so external business side
effects still need their own idempotency policy.

## Outbound SDK tool pattern

```ts
import Stripe from 'stripe';

export const client = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  httpClient: Stripe.createFetchHttpClient(),
});

export function retrieveCustomer(customerId: string) {
  return defineTool({
    name: 'retrieve_stripe_customer',
    description: 'Retrieve the customer bound to this billing agent.',
    async run() {
      const customer = await client.customers.retrieve(customerId);
      return {
        output: 'deleted' in customer
          ? { id: customer.id, deleted: true }
          : { id: customer.id, name: customer.name, email: customer.email },
      };
    },
  });
}
```

Bind `customerId` and any account context in trusted code. The model should not
select another customer, account, API key, endpoint, or arbitrary SDK method.

## Recommended patterns

- Select a resource identity that matches the business workflow.
- Include account/context in both instance ids and outbound SDK request context.
- Keep webhook handling thin: verify, filter, normalize, dispatch, return.
- Preserve `event.id` in attributes for tracing as well as idempotency.
- Retrieve current resource state when ordering matters instead of trusting a
  sequence of snapshots.
- Keep event destination API versions and SDK types aligned.
- Test both configured payload modes and exact raw-body verification.

## Avoid

- Do not parse or mutate the body before Stripe verification.
- Do not use `event.created` as ordering or duplicate identity.
- Do not assume webhook event order.
- Do not subscribe to all events without a concrete need.
- Do not expose generic Stripe clients or account selection to the model.
- Do not use this asynchronous channel for latency-sensitive synchronous
  Issuing authorization decisions.

## Gotchas and security

- Live deliveries retry for up to three days; sandbox deliveries retry three
  times over several hours. Manual retries can overlap automatic retries.
- Signature timestamps and signatures are regenerated for retry attempts;
  `event.id`, not the signature, is the delivery-stable key.
- The `Stripe-Signature` header carries `t=<timestamp>` plus one or more
  `v1=<hmac>` values (HMAC-SHA256 of `{timestamp}.{raw body}` with the
  webhook secret); official libraries default to a five-minute tolerance
  between that timestamp and the receiving clock to block replay. Stripe
  explicitly warns against setting tolerance to `0`, which disables the
  recency check entirely.
- Snapshot object shape follows the event destination's API version.
- For unknown future types, switch on `event.type as string` locally and treat
  untyped resource fields as untrusted; do not weaken all known narrowing.
- The package does not register destinations, rotate secrets, manage OAuth,
  deduplicate events, restore ordering, or define generic tools.
- Stripe's Fetch/Web Crypto path runs on Node and Workers with
  `nodejs_compat`; `@types/node` references are type-only.

## Related

- [Flue channels](./advanced_channels.md)
- [Stripe webhook guide](https://docs.stripe.com/webhooks)
- [Stripe event destinations](https://docs.stripe.com/event-destinations)
- [`@flue/stripe` README](https://github.com/withastro/flue/tree/main/packages/stripe#readme)
