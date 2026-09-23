---
title: Twilio Channel
source: https://flueframework.com/docs/ecosystem/channels/twilio/
provider_docs: https://www.twilio.com/docs/usage/security#validating-requests
section: ecosystem
topic: ecosystem / channels / twilio
flue_version: 2.0.8
---

# Twilio Channel

## What it is

`@flue/twilio` verifies Twilio Programmable Messaging SMS/MMS webhooks and
derives a canonical conversation. The blueprint generates a standards-based
Fetch client for outbound messaging instead of installing Twilio's Node-only
official helper.

Use it for one agent per participant and configured phone number or Messaging
Service. Optional signed delivery-status callbacks are a second route with
different idempotency semantics.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | yes | Restrict ingress account and identify API calls. |
| `TWILIO_AUTH_TOKEN` | yes | Verify signatures and authenticate outbound calls. |
| `TWILIO_WEBHOOK_URL` | yes | Exact public URL used in signature verification. |
| `TWILIO_PHONE_NUMBER` | for address destination | Bind a Twilio address. |
| `TWILIO_MESSAGING_SERVICE_SID` | for service destination | Bind a Messaging Service. |
| `TWILIO_STATUS_CALLBACK_URL` | when status is enabled | Exact signed public status URL. |

Choose exactly one destination form. `TWILIO_WEBHOOK_URL` must include the
external prefix and query string visible to Twilio, even when a trusted proxy
rewrites the internal path.

## How to

1. Apply the blueprint:

```sh
bunx flue add channel twilio
```

2. Set account, token, exact public URL, and destination secrets/config.
3. Configure the Twilio inbound message webhook as:

```txt
https://example.com/channels/twilio/webhook
```

4. Mount the generated channel:

```ts
import { channel as twilio } from './channels/twilio.ts';

app.route('/channels/twilio', twilio.route());
```

5. Treat opt-out control input before dispatching, preserve native fields,
   derive the canonical conversation, and bind the generated outbound client
   to trusted `initialData`.
6. If delivery statuses are needed, configure both `statusCallbackUrl` and
   `statusCallback`, then set that same URL on outbound messages.

## Verified inbound routes

| Surface | Conventional route |
| --- | --- |
| Inbound SMS/MMS | `POST /channels/twilio/webhook` |
| Optional delivery status | `POST /channels/twilio/status` |

`createTwilioChannel` verifies `X-Twilio-Signature` with the auth token against
the configured exact external URL and every form parameter. It rejects signed
requests for another account or configured destination before the callback.

The message callback receives `{ c, payload, conversation, idempotencyToken? }`.
`payload` preserves Twilio PascalCase fields and string values; repeated form
parameters are `readonly string[]`. `idempotencyToken` is the optional
`I-Twilio-Idempotency-Token` header.

Returning nothing creates an empty TwiML `<Response/>` with `200`. Return a
Hono/Fetch `Response` for explicit TwiML, status, or headers.

## Instance identity and idempotency

Use the canonical `conversation` supplied after verification:

```ts
if (payload.OptOutType === 'STOP') return;

await dispatch(Assistant, {
  id: channel.instanceId(conversation),
  idempotencyKey: payload.MessageSid,
  initialData: conversation,
  message: {
    kind: 'signal',
    type: 'twilio.message',
    body: payload.Body,
    attributes: { messageSid: payload.MessageSid, from: payload.From },
  },
});
```

| Destination form | Instance fields |
| --- | --- |
| Address | configured `address` + verified `participant` |
| Messaging Service | configured `messagingServiceSid` + verified `participant` |
| Inbound message idempotency | signed form field `MessageSid` |
| Retry diagnostics | optional `I-Twilio-Idempotency-Token` |

The channel is stateless. Use `MessageSid` as the stable inbound-message key;
claim it in durable application storage when admission coordinates other
writes. Do not use `MessageSid` alone to collapse delivery-status callbacks:
several legitimate status transitions belong to one message. Persist status
transitions idempotently and tolerate duplicates and reordering; use the
exposed idempotency token only according to the application's observed callback
contract because Twilio may omit it.

## Outbound client tool pattern

The generated `src/twilio-client.ts` is the cross-runtime outbound client:

```ts
export const client = new TwilioClient({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
});

export function postMessage(ref: TwilioConversationRef) {
  return defineTool({
    name: 'post_twilio_message',
    description: 'Post to the Twilio conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const result = await client.messages.create({
        to: ref.participant,
        body: text,
        ...(ref.type === 'messaging-service'
          ? { messagingServiceSid: ref.messagingServiceSid }
          : { from: ref.address }),
      });
      return { output: { messageSid: result.sid } };
    },
  });
}
```

Bind the conversation from validated `initialData`. The model chooses text,
not account, sender, participant, credential, callback URL, or API operation.

## Recommended patterns

- Configure the exact externally visible URL rather than reconstructing it.
- Treat `OptOutType === 'STOP'` as control input and do not auto-reply.
- Preserve `MessageSid` in attributes for tracing and deduplication.
- Read MMS count and content types defensively from native string fields.
- Fetch authenticated MMS media only in trusted code.
- Admit work quickly, then perform outbound calls asynchronously.
- Test signatures with every form field, query strings, proxy prefixes, and
  both destination forms.

## Avoid

- Do not omit an external prefix, port, or query string from `webhookUrl`.
- Do not hard-code a subset of signed form fields; Twilio can add parameters.
- Do not dispatch STOP requests as ordinary user messages.
- Do not put authenticated media URLs or raw forms wholesale in model context.
- Do not use one message-level idempotency key to discard real status changes.
- Do not expose arbitrary recipients or sender addresses to the model.

## Gotchas and security

- Twilio signs the URL plus form fields using HMAC-SHA1 with the auth token.
  URL fragments, including connection overrides, are not sent or signed.
- Twilio's webhook read timeout is 15 seconds. Inbound message webhooks are not
  retried by default; a configured Fallback URL is used on failure.
- Connection override fragments can opt into retries, so admission must still
  be idempotent when they are enabled.
- Status callbacks may be duplicated or out of order, and a Messaging Service
  SID may be absent; then the verified callback has no derived `conversation`.
- The generated Fetch client runs on Node and Workers with `nodejs_compat`;
  it is intentionally not the Node-only Twilio helper.

## Related

- [Flue channels](./advanced_channels.md)
- [Twilio request validation](https://www.twilio.com/docs/usage/security#validating-requests)
- [Twilio Messaging](https://www.twilio.com/docs/messaging)
- [`@flue/twilio` README](https://github.com/withastro/flue/tree/main/packages/twilio#readme)
