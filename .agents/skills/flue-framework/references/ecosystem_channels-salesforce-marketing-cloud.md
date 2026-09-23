---
title: Salesforce Marketing Cloud channel
source: https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/
bundled_docs: ecosystem/channels/salesforce-marketing-cloud
version: 2.0.8
reviewed: 2026-09-17
---

# Salesforce Marketing Cloud channel

## When to use

Use this channel for Salesforce Marketing Cloud Engagement Event Notification
Service (ENS) batches and tenant-bound project-owned REST behavior. It is not a
generic Salesforce CRM channel.

The generated example validates selected transactional-send and engagement
email families, derives a local email-event identity, dispatches each useful
event, and exposes a callback lookup tool through a narrow Fetch client.

## Prerequisites and environment variables

- A Marketing Cloud Engagement tenant with ENS access.
- A registered ENS callback targeting a public HTTPS deployment.
- The callback's signature key and callback id.
- A tenant REST base URL and application-owned OAuth access token.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SALESFORCE_MARKETING_CLOUD_SIGNATURE_KEY` | Yes | Verifies signed ENS batches. |
| `SALESFORCE_MARKETING_CLOUD_CALLBACK_ID` | Yes | Restricts and identifies the callback. |
| `SALESFORCE_MARKETING_CLOUD_REST_BASE_URL` | Yes | Selects the tenant-specific REST origin. |
| `SALESFORCE_MARKETING_CLOUD_ACCESS_TOKEN` | Yes | Authenticates project-owned REST requests. |

Callback registration, OAuth, refresh, and token storage are application-owned.
The signature key and access token are separate credentials.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel salesforce-marketing-cloud
   ```

2. Review the generated channel, narrow Fetch client, and email-family identity
   helpers. The blueprint installs `@flue/salesforce`; no Salesforce SDK is required.
3. Set the four variables through trusted deployment configuration.
4. Mount the channel:

   ```ts
   import { channel as salesforceMarketingCloud } from './channels/salesforce-marketing-cloud.ts';

   app.route('/channels/salesforce-marketing-cloud', salesforceMarketingCloud.route());
   ```

5. Register this complete callback URL:

   ```txt
   https://example.com/channels/salesforce-marketing-cloud/events
   ```

6. During callback creation only, use a temporary `verification` handler to
   restrict `callbackId` and perform the application-owned `/ens-verify` call.
   Disable that handler after setup.
7. For signed batches, narrow `event.eventCategoryType`, validate every family-
   specific identity field, collect valid selected events, and dispatch each one.
8. Bind outbound tools to the configured tenant origin, callback id, and token
   in trusted code. Test verification separately from steady-state signed batches.

Without a `verification` handler, unsigned setup requests receive `401`.

## Routing, dispatch, and outbound replies

The fixed channel route is:

```txt
POST /channels/salesforce-marketing-cloud/events
```

One signed body is an ordered, nonempty array of at most 1000 events. Dispatch
each selected event only after validating the whole selected identity:

```ts
await dispatch(Assistant, {
  id: emailEventInstanceId(ref),
  message: {
    kind: 'signal',
    type: `salesforce-marketing-cloud.${event.eventCategoryType}`,
    body: JSON.stringify(event.info ?? {}),
    attributes: {
      callbackId: ref.callbackId,
      mid: ref.mid,
      eid: ref.eid,
      jobId: ref.jobId,
      batchId: ref.batchId,
      listId: ref.listId,
      subscriberId: ref.subscriberId,
    },
  },
});
```

The generated client validates an HTTPS tenant origin ending in
`.rest.marketingcloudapis.com` before attaching the bearer token. Its bound tool
performs only `GET /platform/v1/ens-callbacks/{callbackId}`. This is callback
retrieval, not an outbound message reply abstraction; add other REST behavior as
explicit, tenant-bound project code.

Return `200` through `204` to acknowledge ENS. The generated flow returns `204`
after all durable admissions complete.

## Recommended patterns

- Treat `eventCategoryType` as the discriminator and validate every field read afterward.
- Validate all selected batch entries before starting partial side effects where practical.
- Keep tenant origin, callback id, token, and REST path bound in trusted code.
- Use a local identity only for event families whose tracking fields are validated.
- Dispatch promptly and make downstream effects idempotent.
- Test Fetch with a fail-closed transport that rejects every unexpected tenant or path.

## Avoid

- Do not use this integration for generic Salesforce APIs.
- Do not base64-decode `SALESFORCE_MARKETING_CLOUD_SIGNATURE_KEY`; it is UTF-8 HMAC key material.
- Do not use deprecated optional `compositeId` as a universal delivery or conversation key.
- Do not trust `timestampUTC` as a universal validated timestamp.
- Do not let events or the model choose a REST origin, callback id, token, or arbitrary path.
- Do not leave unsigned setup handling enabled after callback verification.

## Security and idempotency gotchas

- Signed delivery uses `x-sfmc-ens-signature`, a base64 HMAC-SHA256 digest over
  exact body bytes. Only the signature header is base64-decoded.
- Unsigned setup contains exactly `callbackId` and a one-time `verificationKey`;
  restrict the callback and keep the key out of model context and logs.
- The setup POST must receive `200` within 30 seconds or callback creation fails.
- ENS delivery is at least once and failed batches may retry for up to seven days.
- ENS provides no universal event delivery id. Choose a family-appropriate,
  validated idempotency key and atomically claim it in durable application state.
- The package does not deduplicate, persist, register callbacks, refresh OAuth
  tokens, or infer a universal resource identity.
- A parsed local instance id is not authorization; recheck callback identity
  before selecting credentials.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Marketing Cloud Engagement ENS](https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/ens.html)
- [`@flue/salesforce` README](https://github.com/withastro/flue/tree/main/packages/salesforce-marketing-cloud#readme)
- `advanced_channels.md`
- `guides_routing.md`
