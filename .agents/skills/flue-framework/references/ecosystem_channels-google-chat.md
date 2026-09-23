---
title: Google Chat channel
source: https://flueframework.com/docs/ecosystem/channels/google-chat/
bundled_docs: ecosystem/channels/google-chat
version: 2.0.8
reviewed: 2026-09-17
---

# Google Chat channel

## When to use

Use the Google Chat channel for authenticated Chat app interactions and,
optionally, Google Workspace Events delivered by authenticated Pub/Sub push.
Direct interactions cover activity addressed to the app; Workspace Events cover
broader space changes such as messages, reactions, memberships, and space updates.

Outbound messages use a generated, project-owned service-account Fetch client.
`@flue/google-chat` authenticates ingress but does not own Chat API calls.

## Prerequisites and environment variables

- A Google Cloud project with the Google Chat API enabled.
- A configured Chat app using an HTTP endpoint URL.
- A public HTTPS deployment.
- For outbound calls, a service account authorized for the required Chat behavior.
- For Workspace Events, a subscription and authenticated Pub/Sub push subscription.

| Variable | Required for | Purpose |
| --- | --- | --- |
| `GOOGLE_CHAT_APP_URL` | Direct interactions | Exact endpoint URL used as the OIDC audience. |
| `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` | Workspace Events | Exact subscription resource required in the push body. |
| `GOOGLE_CHAT_PUBSUB_AUDIENCE` | Workspace Events | Exact audience configured on Pub/Sub push. |
| `GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT` | Workspace Events | Expected push-token service-account email. |
| `GOOGLE_CHAT_CLIENT_EMAIL` | Outbound API | Service-account identity for token exchange. |
| `GOOGLE_CHAT_PRIVATE_KEY` | Outbound API | Signs the service-account JWT assertion. |

Configure only variables for the surfaces in use. Preserve private-key newlines
according to the deployment's secret mechanism; do not transform credentials
unless that mechanism requires it.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel google-chat
   ```

2. Review `channels/google-chat.ts` and `lib/google-chat-client.ts`. The
   blueprint installs `@flue/google-chat` plus `jose` and exports the channel,
   project-owned client, and message tool.
3. Mount the channel:

   ```ts
   import { channel as googleChat } from './channels/google-chat.ts';

   app.route('/channels/google-chat', googleChat.route());
   ```

4. Configure the Chat app's HTTP endpoint as:

   ```txt
   https://example.com/channels/google-chat/interactions
   ```

5. Set `GOOGLE_CHAT_APP_URL` to that exact URL, including any outer prefix.
6. Handle only selected native interaction types, derive and validate the space
   and optional thread, dispatch durable work, and return `200` promptly.
7. If broader Workspace Events are needed, configure `workspaceEvents`, the
   three Pub/Sub variables, and the route below:

   ```txt
   https://example.com/channels/google-chat/events
   ```

8. Bind the outbound message tool from trusted `initialData`. Test OIDC audience
   and identity mismatches, malformed space/thread names, retries, token exchange,
   and threaded sends in the target runtime.

Omitting `interactions` or `workspaceEvents` from `createGoogleChatChannel()`
omits that route.

## Routing, dispatch, and outbound replies

| Surface | Route |
| --- | --- |
| Chat app interactions | `POST /channels/google-chat/interactions` |
| Workspace Events Pub/Sub push | `POST /channels/google-chat/events` |

For interactions, preserve Google's native uppercase type and bind identity:

```ts
await dispatch(Assistant, {
  id: channel.instanceId(ref),
  initialData: { space: ref.space, thread: ref.thread },
  message: {
    kind: 'signal',
    type: `google-chat.${payload.type}`,
    body: payload.message?.argumentText ?? payload.message?.text ?? '',
    attributes: {
      ...(payload.message?.name ? { messageName: payload.message.name } : {}),
    },
  },
});
return c.body(null, 200);
```

The generated client requests and caches a `chat.bot` access token, then posts
through the Chat REST API. Bind `space` and `thread` in trusted code; expose only
message text to the model. Google requires synchronous interaction responses
within 30 seconds, but durable dispatch should return much sooner.

Workspace Events preserve the Pub/Sub wrapper. Application code decodes
`delivery.message.data` from base64 bytes to UTF-8 JSON and handles CloudEvent
attributes separately.

## Recommended patterns

- Use direct interactions for addressed app behavior and Workspace Events only when broader activity is required.
- Validate that a thread resource belongs to the exact bound space.
- Use the message resource name as the retry identity for direct message interactions.
- Use `delivery.message.messageId` as the Pub/Sub delivery identity.
- Renew expiring Workspace Event subscriptions in application-owned lifecycle code.
- Keep the destination in `initialData` and bind it into a narrow outbound tool.

## Avoid

- Do not use deprecated `space.type`; use `space.spaceType` only as metadata.
- Do not accept a thread from a different space.
- Do not treat `delivery.deliveryAttempt` as a unique delivery id.
- Do not normalize away the Pub/Sub envelope before recording needed attributes.
- Do not let the model choose a service account, space, thread, URL, or REST operation.
- Do not perform long-running work before acknowledging either route.

## Security and idempotency gotchas

- Endpoint-URL authentication verifies the request's bearer OIDC ID token:
  Google's signature, expiration, exact audience (the configured endpoint URL),
  and that the issuer/email claim is exactly `chat@system.gserviceaccount.com`
  before invoking the handler. Google returns `401` on a verification failure.
- Pub/Sub authentication must match the exact subscription resource, audience,
  and service-account email configured on the push subscription.
- The channel does not deduplicate interactions, Pub/Sub message ids, or CloudEvent ids.
- Google Chat may retry failed direct calls; Pub/Sub retries failed or unacknowledged pushes.
- Atomically claim the relevant stable identity in durable application storage
  before dispatch when duplicate admission is unacceptable.
- Instance ids identify a conversation but do not authorize direct agent access.
- Domain-wide delegation, user impersonation, subscription state, and token
  storage remain application responsibilities.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Google Chat interactions](https://developers.google.com/workspace/chat/receive-respond-interactions)
- [Google Workspace Events for Chat](https://developers.google.com/workspace/events/guides/events-chat)
- [`@flue/google-chat` README](https://github.com/withastro/flue/tree/main/packages/google-chat#readme)
- `advanced_channels.md`
- `guides_routing.md`
