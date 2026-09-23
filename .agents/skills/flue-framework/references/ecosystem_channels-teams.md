---
title: Microsoft Teams Channel
source: https://flueframework.com/docs/ecosystem/channels/teams/
provider_docs: https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
section: ecosystem
topic: ecosystem / channels / teams
flue_version: 2.0.8
---

# Microsoft Teams Channel

## What it is

`@flue/teams` authenticates Microsoft Bot Connector activities for Teams. The
blueprint generates a project-owned Fetch client for OAuth client-credentials
exchange and outbound Bot Connector REST calls instead of adding Microsoft's
Node-oriented hosting SDKs.

Use it for an agent scoped to a Teams conversation or channel thread. The
channel handles authenticated HTTP ingress; permissions, bot registration,
message selection, and outbound behavior remain application concerns.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `TEAMS_APP_ID` | yes | Constrain inbound JWT audience and identify the bot. |
| `TEAMS_TENANT_ID` | yes | Constrain host conversation/channel tenant. |
| `TEAMS_APP_PASSWORD` | yes for outbound | Obtain Bot Connector OAuth tokens. |

Register an Azure Bot and Teams app. By default, bots receive channel messages
when mentioned; receiving all channel or group-chat messages requires the
appropriate Teams resource-specific consent permissions.

## How to

1. Apply the blueprint:

```sh
bunx flue add channel teams
```

2. Set the app id, tenant id, and app password as deployment secrets.
3. Configure the Azure Bot messaging endpoint:

```txt
https://example.com/channels/teams/activities
```

4. Mount the generated channel:

```ts
import { channel as teams } from './channels/teams.ts';

app.route('/channels/teams', teams.route());
```

5. Switch on native `activity.type`, derive the verified destination, dispatch
   promptly, and bind the generated client to destination data in `initialData`.

## Verified inbound route

- Route: `POST /channels/teams/activities` for the conventional mount.
- Factory: `createTeamsChannel({ appId, tenantId, activities })`.
- Callback: `{ activity }`, where `activity` is the provider-native Bot
  Framework `Activity` re-exported from `botframework-schema`.
- Response: no return means empty `200`; JSON is useful for `invoke`
  acknowledgements; a normal `Response` passes through.

Before invoking the callback, Flue verifies the Connector bearer token's
Microsoft OpenID signing key, `RS256` signature, issuer, app audience, expiry,
and `msteams` endorsement. It also matches the activity's exact `serviceUrl` to
the signed token claim and checks host conversation/channel tenant against
`TEAMS_TENANT_ID`.

## Instance identity and idempotency

Use the package helpers rather than concatenating Bot Framework fields:

```ts
const destination = channel.destination(activity);
await dispatch(Assistant, {
  id: channel.instanceId(destination),
  ...(activity.id ? { idempotencyKey: activity.id } : {}),
  initialData: {
    serviceUrl: destination.serviceUrl,
    conversationId: destination.conversationId,
    botId: destination.botId,
    ...(destination.threadId ? { threadId: destination.threadId } : {}),
  },
  message: {
    kind: 'signal',
    type: 'teams.message',
    body: activity.text!,
    attributes: {
      ...(activity.id ? { activityId: activity.id } : {}),
      senderId: activity.from.id,
    },
  },
});
```

| Concern | Stable value |
| --- | --- |
| Agent instance | `channel.instanceId(channel.destination(activity))` |
| Destination data | service URL, conversation id, bot id, optional thread id |
| Delivery idempotency | `activity.id` when Microsoft supplies it |

The package does not deduplicate activity ids. If duplicate admission must be
atomic with other app state, claim the id in durable application storage. Do
not fabricate an idempotency key for activities without an id.

## Outbound client tool pattern

The generated `lib/teams-client.ts` obtains and caches a Connector token until
shortly before expiration, then posts through the verified service URL:

```ts
export const client = createTeamsClient({
  appId: process.env.TEAMS_APP_ID!,
  tenantId: process.env.TEAMS_TENANT_ID!,
  appPassword: process.env.TEAMS_APP_PASSWORD!,
});

export function postMessage(ref: TeamsMessageRef) {
  return defineTool({
    name: 'post_teams_message',
    description: 'Post to the Teams conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const result = await client.postMessage(ref, text);
      return { output: { activityId: result.id } };
    },
  });
}
```

Read the ref with `useInitialData()` and bind it in trusted code. The model
chooses text, not the Connector URL, conversation, bot identity, credential, or
REST operation.

## Recommended patterns

- Derive every reply destination from the authenticated activity.
- Use `initialData` for stable destination fields and signal attributes for
  sender/activity facts.
- Switch on native activity types such as `message`, `conversationUpdate`,
  `invoke`, and `messageReaction`.
- Return the protocol-specific JSON body required by `invoke` activities.
- Cache OAuth tokens only until shortly before expiry.
- Configure documented sovereign-cloud metadata, issuer, and authority
  together when not using Microsoft's public cloud defaults.
- Test audience, tenant, endorsement, service URL, expiry, and signing-key failures.

## Avoid

- Do not trust a model-supplied or unverified `serviceUrl`.
- Do not disable any JWT verification step.
- Do not expose app passwords or Connector access tokens to model context.
- Do not assume every activity has text or an id.
- Do not block the inbound response on agent completion or outbound messaging.
- Do not add broad Teams permissions when mention-only delivery is sufficient.

## Gotchas and security

- Connector requests use bearer-token authentication, not an HMAC over the
  body; the exact service URL claim and full JWT validation are critical.
- Azure Bot Service retries non-2xx responses. The channel itself is stateless.
- Connector signing keys can rotate; OpenID/JWK retrieval and validation are
  package responsibilities, not hard-coded app keys. Microsoft documents the
  keys document as stable but recommends refreshing the cached copy at least
  once every 24 hours so newly rotated keys are recognized.
- Token expiry/validity uses an industry-standard five-minute clock-skew
  tolerance; keep servers NTP-synced rather than widening that window.
- The generated Fetch client is the blueprint's cross-runtime path and works on
  Node and Workers; test token exchange and exact Connector destinations.
- A dispatch-only target agent needs registration via `'use agent'`, not an
  externally mounted agent route.

## Related

- [Flue channels](./advanced_channels.md)
- [Bot Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication)
- [Flue routing](./guides_routing.md)
- [`@flue/teams` README](https://github.com/withastro/flue/tree/main/packages/teams#readme)
