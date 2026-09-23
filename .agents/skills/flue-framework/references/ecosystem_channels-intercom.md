---
title: Intercom channel
source: https://flueframework.com/docs/ecosystem/channels/intercom/
bundled_docs: ecosystem/channels/intercom
version: 2.0.8
reviewed: 2026-09-17
---

# Intercom channel

## When to use

Use the Intercom channel when an agent must react to signed Intercom webhook
notifications and use the official Intercom client for workspace-bound follow-up
work. A common design keeps one agent instance per workspace and conversation,
then retrieves current conversation state through a narrowly bound tool.

The package verifies and forwards notifications. It does not install an app,
perform OAuth, select permissions, create subscriptions, store tokens, or decide
outbound inbox policy.

## Prerequisites and environment variables

- An Intercom developer app and webhook subscription.
- A public HTTPS deployment.
- A client secret for inbound HMAC verification.
- An access token with the minimum permissions needed by outbound operations.
- The workspace id and correct Intercom data region.

| Variable | Required | Purpose |
| --- | --- | --- |
| `INTERCOM_CLIENT_SECRET` | Yes | Verifies inbound notifications. |
| `INTERCOM_ACCESS_TOKEN` | Yes | Authenticates official-client API calls. |
| `INTERCOM_WORKSPACE_ID` | Yes | Restricts resource identity to one workspace. |
| `INTERCOM_REGION` | No | Selects `us`, `eu`, or `au`; defaults to `us`. |

The client secret and access token are separate credentials. Keep both in
trusted deployment configuration.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel intercom
   ```

2. Review the generated `channels/intercom.ts` and source-root
   `intercom-client.ts`. The blueprint installs `@flue/intercom` and pins the
   official `intercom-client@7.0.3` SDK.
3. Set the required variables and choose `INTERCOM_REGION` from `us`, `eu`, or
   `au`; do not accept an API host from inbound or model-controlled data.
4. Mount the channel:

   ```ts
   import { channel as intercom } from './channels/intercom.ts';

   app.route('/channels/intercom', intercom.route());
   ```

5. Configure this URL in Intercom's Developer Hub:

   ```txt
   https://example.com/channels/intercom/webhook
   ```

6. Subscribe only to needed topics. The generated example handles
   `conversation.user.created` and `conversation.user.replied`.
7. Validate fields for each selected topic, derive the conversation id, combine
   it with `notification.app_id`, dispatch, and return promptly.
8. Bind the retrieval tool from trusted workspace and conversation `initialData`.
9. Test Intercom's unsigned `HEAD` validation, valid and tampered exact bodies,
   nullable notification ids, unknown topics, retries, and each configured region.

## Routing, dispatch, and outbound replies

The channel exposes both methods on one conventional route:

```txt
HEAD /channels/intercom/webhook
POST /channels/intercom/webhook
```

`HEAD` returns an empty `200` for endpoint validation and never invokes the
application callback. Signed `POST` requests reach the handler after verification.

Dispatch the provider-native conversation item as a signal:

```ts
const ref = {
  workspaceId: notification.app_id,
  conversationId,
};

await dispatch(Assistant, {
  id: channel.instanceId(ref),
  initialData: ref,
  message: {
    kind: 'signal',
    type: `intercom.${notification.topic}`,
    body: JSON.stringify(notification.data.item),
    attributes: {
      ...(notification.id ? { notificationId: notification.id } : {}),
      createdAt: String(notification.created_at),
    },
  },
});
```

The generated tool calls `client.conversations.find()` for only the bound
conversation and requests plaintext display. It accepts no model-selected
workspace, conversation id, token, region, or API host. Add reply behavior in
project code only after defining explicit inbox policy and permissions.

## Recommended patterns

- Include workspace identity because Intercom resource ids are not globally unique.
- Filter `notification.app_id` against installation state before selecting credentials.
- Keep API version `2.14` with `intercom-client@7.0.3` as generated.
- Validate `data.item` independently for each topic before reading fields.
- Use `initialData` for stable workspace/conversation identity and attributes for delivery facts.
- Dispatch durable work and acknowledge within Intercom's response window.

## Avoid

- Do not assume every conversation-like topic stores its id at `data.item.id`.
- Do not manually force API version `2.15` on SDK types generated for `2.14`.
- Do not let webhook fields or model input choose an API region or credential.
- Do not await conversation processing or model output in the webhook handler.
- Do not return `410` or `429` unless disabling or throttling is intentional.
- Do not expose a direct agent route without normal authentication and authorization.

## Security and idempotency gotchas

- Intercom signs exact request bytes in `X-Hub-Signature` using HMAC-SHA1 and
  the developer app client secret. Verification occurs before parsing.
- Intercom supplies no signed timestamp or protocol replay window. A valid
  signature authenticates bytes but does not establish freshness.
- Notifications can be duplicated and can arrive out of order.
- A non-null `notification.id` is the preferred deduplication identity. Atomically
  claim it in durable storage before dispatch when duplicates are unacceptable.
- Setup and periodic pings can have a null id; handle them without inventing a key.
- Intercom expects a `2xx` in about five seconds and ordinarily retries a failure
  once after approximately one minute.
- `410` disables the subscription outright. `429` throttles all notifications for
  roughly one to two hours; notifications still undelivered after about two hours
  are dropped rather than eventually retried.
- Instance ids are identifiers, not authorization capabilities.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Intercom Developer Hub](https://developers.intercom.com/)
- [`@flue/intercom` README](https://github.com/withastro/flue/tree/main/packages/intercom#readme)
- `advanced_channels.md`
- `guides_routing.md`
