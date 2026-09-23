---
title: WhatsApp Channel
source: https://flueframework.com/docs/ecosystem/channels/whatsapp/
provider_docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/
section: ecosystem
topic: ecosystem / channels / whatsapp
flue_version: 2.0.8
---

# WhatsApp Channel

## What it is

`@flue/whatsapp` handles Meta's callback challenge and verifies WhatsApp
Business Cloud webhook bodies. The blueprint installs the Fetch-based
`@kapso/whatsapp-cloud-api` client for application-owned outbound Graph API
calls.

Use it for one durable agent per business-scoped individual or WhatsApp group.
One provider delivery can contain many entries, changes, messages, and status
updates, so the handler must walk and process every relevant item.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `WHATSAPP_APP_SECRET` | yes | Verify signed POST bodies. |
| `WHATSAPP_VERIFY_TOKEN` | yes | Verify Meta's GET setup challenge. |
| `WHATSAPP_ACCESS_TOKEN` | yes | Authenticate outbound Graph API calls. |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | Restrict handling and bind the sender. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | optional | Enforce account policy in application code. |

`@flue/whatsapp` requires Node 24 because its selected webhook type package
declares that engine floor. Use a production system-user or business access
token and keep the Graph API version explicit.

## How to

1. Apply the blueprint:

```sh
bunx flue add channel whatsapp
```

2. Set all required values in the deployment secret/config system.
3. Configure the Meta callback and subscribe the WhatsApp Business Account to
   the `messages` field:

```txt
https://example.com/channels/whatsapp/webhook
```

4. Mount the generated channel:

```ts
import { channel as whatsapp } from './channels/whatsapp.ts';

app.route('/channels/whatsapp', whatsapp.route());
```

5. Filter verified deliveries by phone number and, if required, business
   account; iterate every message; dispatch each with its own idempotency key.
6. Bind the generated outbound tool from validated destination `initialData`.

## Verified inbound route

- Routes: `GET` and `POST /channels/whatsapp/webhook`.
- Factory: `createWhatsAppChannel({ appSecret, verifyToken, webhook })`.
- GET: validates the configured verify token and answers `hub.challenge`.
- POST: verifies `X-Hub-Signature-256` against the exact body before parsing.
- Callback: `{ payload }`, Meta's provider-native webhook object.
- Response: no return means empty `200`; JSON-compatible data becomes JSON;
  a Hono/Fetch `Response` passes through.

Verification authenticates the Meta app, but the channel does not filter
`entry[].id` or `metadata.phone_number_id`. Those business-account and phone
number constraints are application policy and must run before dispatch.

## Instance identity and idempotency

Use the Business-Scoped User ID (BSUID) for individuals and provider group id
for groups, always scoped by business account and phone number:

```ts
const ref = message.group_id
  ? { type: 'group', businessAccountId: entry.id,
      phoneNumberId: value.metadata.phone_number_id, groupId: message.group_id }
  : { type: 'individual', businessAccountId: entry.id,
      phoneNumberId: value.metadata.phone_number_id,
      destination: { type: 'user-id', userId: message.from_user_id } };

await dispatch(Assistant, {
  id: channel.instanceId(ref),
  idempotencyKey: message.id,
  initialData: {
    phoneNumberId: ref.phoneNumberId,
    destination: ref.type === 'individual' ? ref.destination : undefined,
    groupId: ref.type === 'group' ? ref.groupId : undefined,
  },
  message: {
    kind: 'signal',
    type: `whatsapp.${message.type}`,
    body,
    attributes: { messageId: message.id },
  },
});
```

| Concern | Stable value |
| --- | --- |
| Individual instance | business account + phone number id + BSUID |
| Group instance | business account + phone number id + group id |
| Message idempotency | signed body field `message.id` |

Use `message.id` per dispatched message, not one key for the entire batch. The
package is stateless; claim ids in durable app storage when duplicate admission
must coordinate other writes. Prefer `from_user_id` over sender phone number:
Meta may omit or change `from`, while BSUID is the stable inbound identity.

## Outbound SDK tool pattern

```ts
export const client = new WhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  graphVersion: 'v25.0',
});

export function postMessage(ref: WhatsAppSendRef) {
  return defineTool({
    name: 'post_whatsapp_message',
    description: 'Post to the WhatsApp conversation bound to this agent.',
    input: v.object({
      text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    }),
    async run({ data: { text } }) {
      const result = await sendTextMessage(ref, text);
      return { output: { messageId: result.messages[0]?.id ?? null } };
    },
  });
}
```

For a BSUID destination, the blueprint uses the client's authenticated
low-level `request()` with the documented `recipient` body because the current
high-level text helper models only `to`. Trusted code binds phone number id and
recipient; the model chooses only text.

## Recommended patterns

- Walk all entries, changes, messages, and statuses in provider order.
- Narrow first on `change.field`, then `message.type` or status.
- Filter the expected phone number and business account before dispatch.
- Store destination facts in `initialData`; keep message facts in attributes.
- Keep the Graph version fixed and test before upgrading.
- Handle interactive button, list, and flow replies explicitly.
- Test multi-message batches, duplicate message ids, unknown shapes, and both
  GET challenge and POST signature failures.

## Avoid

- Do not assume one message per POST.
- Do not use mutable sender phone number as canonical individual identity.
- Do not forward raw payloads or transient media URLs wholesale to the model.
- Do not let a model choose business account, phone number id, recipient, or API path.
- Do not treat successful app-signature verification as tenant filtering.
- Do not assume the community-maintained webhook types cover future runtime shapes.

## Gotchas and security

- Meta expects a prompt `200` and can retry non-200 deliveries with decreasing
  frequency for up to seven days; duplicates are normal.
- Media ids and transient URLs require bearer-authenticated retrieval. Keep
  access in trusted application code.
- The webhook payload type comes from community-maintained
  `@whatsapp-cloudapi/types`; authenticated future shapes can arrive first.
- The channel does not register subscriptions, deduplicate, filter tenants,
  rotate tokens, or decide which message/status families matter.
- The Fetch client works on Node and Workers with Flue's `nodejs_compat`; test
  exact high- and low-level operations against a fake transport.

## Related

- [Flue channels](./advanced_channels.md)
- [WhatsApp Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/)
- [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [`@flue/whatsapp` README](https://github.com/withastro/flue/tree/main/packages/whatsapp#readme)
