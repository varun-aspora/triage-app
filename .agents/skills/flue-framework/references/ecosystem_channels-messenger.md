---
title: Facebook Messenger channel
source: https://flueframework.com/docs/ecosystem/channels/messenger/
bundled_docs: ecosystem/channels/messenger
version: 2.0.8
reviewed: 2026-09-17
---

# Facebook Messenger channel

## When to use

Use the Messenger channel for verified Facebook Page webhook events and
project-owned Messenger Graph API behavior. The generated example admits
non-echo text messages and binds replies to the same Page participant.

The verified payload can also contain postbacks, reactions, deliveries, reads,
opt-ins, referrals, edits, standby events, and other subscribed families. The
application decides which of those should reach an agent.

## Prerequisites and environment variables

- A Meta app connected to a Facebook Page.
- A public HTTPS callback and Page webhook subscriptions.
- A chosen callback verify token shared through trusted configuration.
- A Page access token with permissions required by outbound operations.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MESSENGER_APP_SECRET` | Yes | Verifies signed inbound webhook bodies. |
| `MESSENGER_VERIFY_TOKEN` | Yes | Verifies Meta's callback setup challenge. |
| `MESSENGER_PAGE_ID` | Yes | Scopes conversation identity and outbound sends. |
| `MESSENGER_PAGE_ACCESS_TOKEN` | Yes | Authenticates Graph API calls. |

The app secret verifies ingress; the Page access token authorizes egress. Never
expose either credential to the model or browser.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel messenger
   ```

2. Review `channels/messenger.ts` and the generated source-root
   `messenger-client.ts`. The blueprint installs `@flue/messenger` and creates
   an editable Graph API Fetch client, channel, and reply tool.
3. Set all four variables through trusted deployment configuration.
4. Mount the channel:

   ```ts
   import { channel as messenger } from './channels/messenger.ts';

   app.route('/channels/messenger', messenger.route());
   ```

5. Configure Meta's callback as:

   ```txt
   https://example.com/channels/messenger/webhook
   ```

6. Complete the GET verification challenge with the configured verify token,
   connect the app to the Page, and subscribe only to needed fields.
7. Iterate every `entry` and relevant native event array in delivered order.
   Filter echoes and unsupported event families in application code.
8. Use `channel.conversationRef(event)` to derive the counterpart participant,
   dispatch a signal, and bind `postMessage()` from trusted `initialData`.
9. Test callback verification, exact-body signature failures, batched entries,
   echo loops, duplicate message ids, participant kinds, and messaging-window policy.

## Routing, dispatch, and outbound replies

The channel exposes both setup and delivery methods:

```txt
GET  /channels/messenger/webhook
POST /channels/messenger/webhook
```

One signed POST can contain multiple entries and events. Admit each selected
message independently:

```ts
const conversation = channel.conversationRef(event);
if (!conversation || !event.message?.text || event.message.is_echo) return;

await dispatch(Assistant, {
  id: channel.instanceId(conversation),
  initialData: {
    pageId: conversation.pageId,
    participant: conversation.participant,
  },
  message: {
    kind: 'signal',
    type: 'messenger.message',
    body: event.message.text,
    attributes: { messageId: event.message.mid },
  },
});
```

The generated tool sends text through the project-owned Graph client to the
bound participant. The model selects text only. The fixed Page id, participant,
Graph version, access token, and API operation remain trusted code choices.

Returning nothing produces Meta's documented `EVENT_RECEIVED` response with
status `200`. Use an explicit Hono or Fetch `Response` only when intentional.

## Recommended patterns

- Iterate all entries; do not assume one event per webhook request.
- Discriminate event families by property presence, such as `message`, `postback`, or `reaction`.
- Filter `message.is_echo` to prevent the Page's own sends from re-entering the agent.
- Keep Page and participant identity in `initialData` and bind the reply tool from it.
- Claim stable message ids before dispatch when duplicate admission matters.
- Persist any webhook history the application needs; Messenger does not provide historical notifications.

## Avoid

- Do not look for a synthetic event `type`; Messenger families are property-discriminated.
- Do not treat Page-scoped ids and `user_ref` values as interchangeable.
- Do not let the model choose recipients, Page ids, Graph paths, versions, or credentials.
- Do not dispatch echoes, attachment-only events, or standby events without explicit policy.
- Do not assume a successful signature provides deduplication or event ordering.
- Do not send ordinary replies outside Meta's standard messaging window without an eligible mechanism.

## Security and idempotency gotchas

- The GET route checks `MESSENGER_VERIFY_TOKEN` for callback setup.
- The POST route verifies `X-Hub-Signature-256` over exact request bytes with
  `MESSENGER_APP_SECRET` before parsing events.
- The channel forwards verified payloads but does not filter or deduplicate them.
- Meta retries non-`2xx` deliveries for up to about 15 minutes, which can repeat
  or reorder individual events; roughly an hour of continuous failures gets the
  app unsubscribed from the webhook with a "Webhooks Disabled" alert.
- Use a stable event identity such as `message.mid` in application-owned durable
  storage before dispatch when duplicates are unacceptable.
- A `notification_messages_token` from opt-in events is a provider capability.
  Keep it out of model context, dispatch messages, logs, and durable history.
- Ordinary replies are governed by the standard 24-hour messaging window;
  tags and notification-token surfaces have separate permission and content rules.
- Instance ids identify Page conversations but do not authorize direct HTTP access.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Messenger Platform](https://developers.facebook.com/docs/messenger-platform)
- [`@flue/messenger` README](https://github.com/withastro/flue/tree/main/packages/messenger#readme)
- `advanced_channels.md`
- `guides_routing.md`
