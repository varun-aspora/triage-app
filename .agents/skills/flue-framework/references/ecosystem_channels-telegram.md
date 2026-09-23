---
title: Telegram Channel
source: https://flueframework.com/docs/ecosystem/channels/telegram/
provider_docs: https://core.telegram.org/bots/api#setwebhook
section: ecosystem
topic: ecosystem / channels / telegram
flue_version: 2.0.8
---

# Telegram Channel

## What it is

`@flue/telegram` authenticates Telegram Bot API webhook requests with the
configured secret-token header and forwards provider-native `Update` objects.
The blueprint installs grammY and exports a project-owned `Api` client for
outbound Bot API calls.

Use it for durable agents scoped to a Telegram chat, business chat, forum
thread, or channel direct-message topic. Polling is a separate transport and is
not part of this HTTP channel.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | yes | Authenticate incoming webhook requests. |
| `TELEGRAM_BOT_TOKEN` | yes | Authenticate outbound Bot API calls. |

Create the bot through BotFather. Generate a separate random webhook secret of
1-256 characters using only `A-Z`, `a-z`, `0-9`, `_`, and `-`; do not reuse it
across bots.

## How to

1. Apply the blueprint:

```sh
bunx flue add channel telegram
```

2. Set both tokens in the deployment's secret system.
3. Mount the generated channel:

```ts
import { channel as telegram } from './channels/telegram.ts';

app.route('/channels/telegram', telegram.route());
```

4. Register the exact route and only needed update families with grammY:

```ts
await client.setWebhook('https://example.com/channels/telegram/webhook', {
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
  allowed_updates: ['message', 'channel_post', 'business_message', 'callback_query'],
});
```

5. Branch on the one optional update field present, derive a canonical
   conversation ref, dispatch, and bind an outbound tool to `initialData`.

## Verified inbound route

- Route: `POST /channels/telegram/webhook` for the conventional mount.
- Factory: `createTelegramChannel({ secretToken, webhook })`.
- Callback: `{ update }`, a provider-native Bot API `Update`.
- Authentication: exact comparison of `X-Telegram-Bot-Api-Secret-Token`
  before body parsing, plus the channel body limit.
- Response: no return means empty `200`; JSON can use Telegram's webhook-reply
  method format; a `Response` gives explicit status control.

Telegram does not sign the body and provides no signed timestamp. The secret
header authenticates possession of the configured webhook secret; HTTPS and
secret isolation are therefore essential.

At most one optional `Update` field is present. Branch on `update.message`,
`update.channel_post`, `update.business_message`, `update.callback_query`, and
other enabled families rather than assuming a single message shape.

## Instance identity and idempotency

Build `TelegramConversationRef` from the native message, then use the package
helper:

```ts
const conversation = conversationFromMessage(incoming);
await dispatch(Assistant, {
  id: channel.instanceId(conversation),
  idempotencyKey: String(update.update_id),
  initialData: conversationData(conversation, incoming),
  message: {
    kind: 'signal',
    type: 'telegram.message',
    body: messageBody(incoming),
    attributes: { updateId: String(update.update_id) },
  },
});
```

| Conversation form | Canonical fields |
| --- | --- |
| Regular chat | `type: 'chat'`, `chatId`, optional topic id |
| Business chat | `type: 'business-chat'`, `businessConnectionId`, `chatId`, optional topic id |
| Forum thread | Include `messageThreadId`. |
| Channel direct-message topic | Include `directMessagesTopicId`. |

Use `String(update.update_id)` as the retry-stable `idempotencyKey`. Telegram
documents it as the ordering and duplicate-detection identifier. The package
does not persist update ids; claim one in durable app storage when admission
must be atomic with other writes.

Business connection identity is required because business chat ids can match
ordinary bot chat ids. Thread and direct-message topic ids are mutually
exclusive. Some updates have no durable chat destination and should not create
an instance.

## Outbound SDK tool pattern

```ts
import { Api } from 'grammy';

export const client = new Api(process.env.TELEGRAM_BOT_TOKEN!);

export function postMessage(ref: TelegramConversationRef) {
  return defineTool({
    name: 'post_telegram_message',
    description: 'Post to the Telegram conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const message = await client.sendMessage(ref.chatId, text, {
        ...(ref.type === 'business-chat'
          ? { business_connection_id: ref.businessConnectionId }
          : {}),
        ...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
        ...(ref.directMessagesTopicId
          ? { direct_messages_topic_id: ref.directMessagesTopicId }
          : {}),
      });
      return { output: { messageId: message.message_id } };
    },
  });
}
```

Bind `ref` from validated `initialData`. The model chooses only message text,
not bot token, chat, business connection, topic, or Bot API method.

## Recommended patterns

- Keep `allowed_updates` to the update families the handler understands.
- Handle text, captions, and media-only messages explicitly.
- Answer callback queries promptly, then dispatch only when they contain an
  accessible message destination.
- Put conversation fields in `initialData` and per-update facts in attributes.
- Keep update ids as strings at the Flue boundary for consistent keys.
- Test missing/wrong secrets, body limits, duplicate update ids, and each
  enabled update family.

## Avoid

- Do not run `getUpdates` while a webhook is configured; the modes are exclusive.
- Do not infer a destination for inline callbacks without `query.message`.
- Do not put `guest_query_id` in model context, logs, durable data, or identity;
  it authorizes one short-lived `answerGuestQuery` response.
- Do not use only `chatId` for business chats or threaded destinations.
- Do not expose arbitrary Bot API methods or destination ids as model input.
- Do not treat the secret header as a body signature or replay timestamp.

## Gotchas and security

- Telegram retries non-2xx webhook requests; duplicate updates are expected.
- `update_id` increases sequentially, but after at least a week without updates
  the next id may be randomly selected. It is an identity, not a wall clock.
- Callback queries should be acknowledged with `answerCallbackQuery` to clear
  the Telegram client's progress state.
- grammY's browser/Fetch build runs on Node and Workers with Flue's
  `nodejs_compat`; verify exact methods used by the application.
- The package verifies ingress but does not configure webhooks, poll updates,
  store offsets, deduplicate, or choose supported message families.

## Related

- [Flue channels](./advanced_channels.md)
- [Telegram `setWebhook`](https://core.telegram.org/bots/api#setwebhook)
- [Telegram `Update`](https://core.telegram.org/bots/api#update)
- [`@flue/telegram` README](https://github.com/withastro/flue/tree/main/packages/telegram#readme)
