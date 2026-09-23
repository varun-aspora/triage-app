---
title: Linear channel
source: https://flueframework.com/docs/ecosystem/channels/linear/
bundled_docs: ecosystem/channels/linear
version: 2.0.8
reviewed: 2026-09-17
---

# Linear channel

## When to use

Use the Linear channel for verified resource webhooks or Linear agent-session
events. Resource events can continue an agent per issue or nested comment
thread; agent-session events can continue one instance per Linear agent session.

Outbound comments and agent activities use the official `@linear/sdk` client
owned by the application. The Flue package verifies ingress and preserves
Linear's native webhook types.

## Prerequisites and environment variables

- A Linear webhook or an OAuth application with webhook settings.
- A public HTTPS endpoint that can return `200` quickly.
- A signing secret and credentials scoped for intended SDK operations.
- For agent sessions, an OAuth app actor with required scopes and optionally
  `app:mentionable` when users should mention it.

| Variable | Required | Purpose |
| --- | --- | --- |
| `LINEAR_WEBHOOK_SECRET` | Yes | Verifies inbound webhook bodies. |
| `LINEAR_API_KEY` | Yes for generated client | Authenticates example outbound SDK calls. |
| `LINEAR_ORGANIZATION_ID` | No | Restricts deliveries to one organization. |
| `LINEAR_WEBHOOK_ID` | No | Restricts deliveries to one configured webhook. |

Use an OAuth `accessToken` instead of `apiKey` for an installed OAuth app.
Installation-specific token storage and selection remain application concerns.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel linear
   ```

2. Review the generated `channels/linear.ts`. It installs `@flue/linear` and
   the official `@linear/sdk`, exports `channel` and `client`, and creates a
   destination-bound message tool.
3. Set the webhook secret and outbound credential. Set organization or webhook
   constraints when the deployment should accept only one source.
4. Mount the channel:

   ```ts
   import { channel as linear } from './channels/linear.ts';

   app.route('/channels/linear', linear.route());
   ```

5. Configure the complete URL in Linear:

   ```txt
   https://example.com/channels/linear/webhook
   ```

6. Select only needed resource families, usually Comments, Issues, or Projects,
   or enable agent-session events for the OAuth app actor.
7. Narrow native payloads with both `type` and a nested discriminating field,
   validate action and identifiers, derive a stable conversation ref, and dispatch.
8. Bind `postMessage()` from trusted `initialData` in the target agent.
9. Test stale timestamps, invalid signatures, organization/webhook mismatches,
   duplicate `Linear-Delivery` ids, retries, resource comments, and agent sessions.

## Routing, dispatch, and outbound replies

The conventional route is:

```txt
POST /channels/linear/webhook
```

For a new comment, dispatch by issue and optional root thread:

```ts
const ref = {
  type: 'issue' as const,
  organizationId: payload.organizationId,
  issueId: comment.issueId,
  ...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
};

await dispatch(Assistant, {
  id: channel.instanceId(ref),
  initialData: {
    type: 'issue',
    issueId: ref.issueId,
    ...(ref.threadCommentId ? { threadCommentId: ref.threadCommentId } : {}),
  },
  message: {
    kind: 'signal',
    type: 'linear.comment.created',
    body: comment.body,
    attributes: { deliveryId },
  },
});
```

For agent sessions, use `channel.instanceId()` with organization and
`agentSession.id`, then signal `linear.agent_session.<action>`.

The bound outbound tool uses `client.createComment()` for issue conversations
and `client.createAgentActivity()` for agent sessions. Trusted code chooses the
operation and destination; the model chooses only response text.

## Recommended patterns

- Use issue identity for top-level comments and the root comment id for nested threads.
- Pair `payload.type` with a nested-field guard because the official union has a catch-all member.
- Keep stable destination fields in `initialData` and delivery-specific actor data in attributes.
- Restrict organization and webhook ids when one deployment serves one source.
- Post agent-session progress or results after durable dispatch, not before acknowledgement.
- Return exactly `200` promptly; Linear treats other statuses as failures.

## Avoid

- Do not rely on a literal `payload.type` check alone for TypeScript narrowing.
- Do not let the model select an issue, thread, agent session, organization, or credential.
- Do not block the handler on model output or slow SDK calls.
- Do not treat a syntactically valid instance id as authorization.
- Do not use an API key where an installed OAuth app requires organization-specific tokens.
- Do not assume retry arrival order.

## Security and idempotency gotchas

- `@flue/linear` verifies `Linear-Signature` against the exact raw body and
  rejects signed timestamps outside one minute.
- The required `Linear-Delivery` header is a UUID-v4 delivery identity.
- The channel exposes but does not persist or deduplicate delivery ids.
- Atomically claim `deliveryId` in durable application storage before dispatch
  when duplicate admission or non-idempotent effects are unacceptable.
- Linear requires `200` within five seconds and retries failures after roughly
  one minute, one hour, and six hours (three attempts total). Repeated failures
  across every retry can lead Linear to disable the webhook automatically, so
  treat sustained failures as an operational alert rather than just retry noise.
- New agent sessions should receive an activity or external URL update within
  ten seconds; use the SDK after prompt admission.
- Optional source constraints reduce cross-organization confusion but do not
  replace authorization on directly mounted agent routes.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Linear webhooks](https://linear.app/developers/webhooks)
- [`@flue/linear` README](https://github.com/withastro/flue/tree/main/packages/linear#readme)
- `advanced_channels.md`
- `guides_routing.md`
