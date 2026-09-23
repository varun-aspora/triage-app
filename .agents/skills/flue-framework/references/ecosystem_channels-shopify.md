---
title: Shopify Channel
source: https://flueframework.com/docs/ecosystem/channels/shopify/
provider_docs: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
section: ecosystem
topic: ecosystem / channels / shopify
flue_version: 2.0.8
---

# Shopify Channel

## What it is

`@flue/shopify` provides verified, inbound Shopify JSON webhooks. The Shopify
blueprint also installs the official lightweight `@shopify/admin-api-client`
for application-owned outbound Admin GraphQL calls.

Use it when Shopify topics should wake a durable agent keyed by an application
resource such as a shop and order. Shopify is an event feed, not a threaded
conversation, so the application chooses the instance identity.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `SHOPIFY_CLIENT_SECRET` | yes | Verify the exact inbound request body. |
| `SHOPIFY_PREVIOUS_CLIENT_SECRET` | no | Accept the old secret during rotation overlap. |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | yes | Authenticate outbound Admin GraphQL calls. |
| `SHOPIFY_SHOP_DOMAIN` | yes | Bind the generated client and single-shop tenancy check. |

The blueprint installs `@flue/shopify` and
`@shopify/admin-api-client@1.1.2`. It may add `@types/node` because the Admin
client's declarations reference `Buffer`; that is a type-only requirement.

## How to

1. Apply the project-pinned blueprint:

```sh
bunx flue add channel shopify
```

2. Set the four applicable environment variables in the deployment's secret
   system. Keep the inbound client secret separate from the Admin token.
3. Configure a **JSON** webhook subscription at:

```txt
https://example.com/channels/shopify/webhook
```

4. Mount the generated named export in `src/app.ts`:

```ts
import { channel as shopify } from './channels/shopify.ts';

app.route('/channels/shopify', shopify.route());
```

5. In `webhook`, allow only expected topics and the configured shop, validate
   the fields used as identity, dispatch, and return promptly.
6. Bind generated Admin GraphQL tools to trusted resource data in the target
   agent. A dispatch-only agent needs no public agent route.

## Verified inbound route

- Route: `POST /channels/shopify/webhook` for the conventional mount.
- Factory: `createShopifyChannel({ clientSecret, previousClientSecret?, webhook })`.
- Callback: `{ c, payload, rawBody }`.
- Verification: base64 HMAC-SHA256 over the exact body before JSON parsing.
- Payload: provider-native JSON parsed with `lossless-json`; XML gets `415`.
- Response: no return means empty `200`; JSON-compatible data becomes JSON;
  a `Response` passes through.

Read metadata with `c.req.header(...)`, including `x-shopify-topic`,
`x-shopify-shop-domain`, `x-shopify-webhook-id`, and optional
`x-shopify-event-id`. The HMAC covers the body, not these headers. Checking the
shop header is a tenancy consistency check, not standalone authorization.

## Instance identity and idempotency

There is no Shopify `channel.instanceId()` helper. Define a collision-free,
versionable local id from the resource boundary. The blueprint's order example
uses encoded shop domain plus the exact order id:

```ts
function orderInstanceId(shopDomain: string, orderId: string) {
  return `shopify-order:${encodeURIComponent(shopDomain)}:${encodeURIComponent(orderId)}`;
}
```

Map one delivery as follows:

| Concern | Stable value |
| --- | --- |
| Agent instance | Application-selected shop + order (or another resource). |
| Dispatch idempotency | `X-Shopify-Webhook-Id`, when present. |
| Correlation only | `X-Shopify-Event-Id` groups deliveries from one merchant action. |

```ts
const webhookId = c.req.header('x-shopify-webhook-id');
await dispatch(Orders, {
  id: orderInstanceId(shopDomain, order.id),
  ...(webhookId ? { idempotencyKey: webhookId } : {}),
  initialData: { shopDomain, orderId: order.id },
  message: {
    kind: 'signal',
    type: 'shopify.orders/create',
    body: `Shopify order ${order.name} created.`,
    attributes: { orderId: order.id, ...(webhookId ? { webhookId } : {}) },
  },
});
```

The package is stateless. For deduplication spanning other database writes,
claim the webhook id in application-owned durable storage. Multiple
subscriptions for one action have different webhook ids but may share an event
id, so the event id is not a delivery dedupe substitute.

Shopify ids can exceed JavaScript's safe integer range. Accept validated
positive decimal strings or safe integers, then normalize immediately with
`String(id)`; never round an unsafe id through `Number`.

## Outbound tool pattern

The client fixes the shop, token, and explicit API version in trusted code:

```ts
export const client = createAdminApiClient({
  storeDomain: process.env.SHOPIFY_SHOP_DOMAIN!,
  apiVersion: '2026-04',
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!,
});

export function retrieveOrder(orderId: string) {
  return defineTool({
    name: 'retrieve_shopify_order',
    description: 'Retrieve the order bound to this agent.',
    async run() {
      const result = await client.request(ORDER_QUERY, {
        variables: { id: `gid://shopify/Order/${orderId}` },
      });
      if (result.errors || !result.data?.order) throw new Error('Order lookup failed.');
      return { output: result.data.order };
    },
  });
}
```

The model selects no shop, credential, order id, host, or GraphQL operation.
For multi-shop apps, resolve installation credentials from authenticated
application state rather than webhook headers or tool input.

## Recommended patterns

- Filter topic and tenant before dispatch, then send a small normalized signal.
- Include shop scope in every resource id; Shopify ids are not a conversation.
- Put stable destination facts in `initialData` and event facts in attributes.
- Keep the Admin API version explicit and test before upgrading it.
- Use `previousClientSecret` only for the documented rotation overlap.
- Handle App Store compliance topics on the same verified route.
- Test valid/tampered bytes, both secrets, missing headers, unknown topics, and
  safe versus unsafe numeric ids with synthetic requests.

## Avoid

- Do not parse or reserialize the body before Flue verifies it.
- Do not trust the shop/topic headers as cryptographically signed claims.
- Do not use `X-Shopify-Event-Id` to deduplicate separate subscriptions.
- Do not let a model choose the shop, API host, token, resource id, or query.
- Do not make webhook verification depend on a live Admin token;
  `shop/redact` can arrive after uninstall.
- Do not perform slow Admin API work before acknowledging the webhook.

## Gotchas and security

- Shopify expects the complete request within five seconds and retries failed
  HTTPS deliveries eight times over four hours; duplicates and reordering occur.
- Shopify's connection timeout is tighter than its response window: it expects
  the TCP connection itself to be accepted in about one second, so a cold-starting
  handler can fail before application code ever runs.
- Shopify documents no signed timestamp or webhook replay window.
- The channel verifies signatures but does not register subscriptions, persist
  delivery ids, restore order, manage tokens, or infer resource identity.
- Preserve required fields if a subscription uses `includeFields`.
- Required compliance topics are `customers/data_request`,
  `customers/redact`, and `shop/redact`; their business actions are app-owned.
- The shown Fetch/Web Crypto paths work on Node and Cloudflare Workers with
  Flue's `nodejs_compat`; test the exact GraphQL operations you rely on.

## Related

- [Flue channels](./advanced_channels.md)
- [Flue routing](./guides_routing.md)
- [Shopify delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
- [`@flue/shopify` README](https://github.com/withastro/flue/tree/main/packages/shopify#readme)
