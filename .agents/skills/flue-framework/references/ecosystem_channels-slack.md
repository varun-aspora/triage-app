---
title: Slack Channel
source: https://flueframework.com/docs/ecosystem/channels/slack/
provider_docs: https://docs.slack.dev/authentication/verifying-requests-from-slack/
section: ecosystem
topic: ecosystem / channels / slack
flue_version: 2.0.8
---

# Slack Channel

## What it is

`@flue/slack` verifies Slack HTTP requests and exposes optional Events API,
interactivity, and slash-command callbacks. The blueprint installs Slack's
official `@slack/web-api` SDK for application-owned outbound behavior.

Use it for thread-scoped Slack agents, event-driven workflows, or immediate
interactive acknowledgements. It does not implement Socket Mode, OAuth
installation storage, or an outbound Flue messaging abstraction.

## Prerequisites and environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | yes | Verify inbound request bytes and timestamp. |
| `SLACK_BOT_TOKEN` | yes for outbound | Authenticate Slack Web API calls. |

Create a Slack app, grant only required bot scopes, install it to the intended
workspace(s), and configure only the HTTP surfaces the application handles.

## How to

1. Apply the blueprint through the project-pinned CLI:

```sh
bunx flue add channel slack
```

2. Set the signing secret and bot token in deployment secrets.
3. Configure one or more Slack request URLs:

```txt
Events API:   https://example.com/channels/slack/events
Interactivity: https://example.com/channels/slack/interactions
Commands:     https://example.com/channels/slack/commands
```

4. Mount the named channel export:

```ts
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
```

5. Filter provider-native payloads, derive the thread, dispatch a signal, and
   bind a thread reply tool from trusted `initialData` in the target agent.

## Verified inbound routes

| Configured callback | Method and conventional route |
| --- | --- |
| `events` | `POST /channels/slack/events` |
| `interactions` | `POST /channels/slack/interactions` |
| `commands` | `POST /channels/slack/commands` |

Omitting a callback omits its route. `@flue/slack` verifies Slack's versioned
HMAC-SHA256 signature (`v0=` + HMAC-SHA256 of `v0:{timestamp}:{raw body}` using
the signing secret, sent in `X-Slack-Signature`) against the exact raw body and
enforces timestamp freshness — Slack rejects a request whose
`X-Slack-Request-Timestamp` differs from local time by more than five minutes —
before invoking application code. Slack's URL verification challenge is
answered internally after signature verification.

Callbacks preserve Slack's native shapes and snake_case wire fields. Returning
nothing produces empty `200`; JSON-compatible data becomes JSON; a `Response`
passes through. Return promptly after durable admission.

The Events callback receives Slack's outer envelope. Narrow
`payload.type === 'event_callback'`, then switch on `payload.event.type`. The
package does not filter bots, message subtypes, workspaces, or event families.

## Instance identity and idempotency

For messages, keep one agent instance per Slack thread:

```ts
const thread = {
  teamId: payload.team_id,
  channelId: event.channel,
  threadTs: event.thread_ts ?? event.ts,
};

await dispatch(Assistant, {
  id: channel.instanceId(thread),
  idempotencyKey: payload.event_id,
  initialData: { channelId: thread.channelId, threadTs: thread.threadTs },
  message: {
    kind: 'signal',
    type: 'slack.app_mention',
    body: event.text,
    attributes: { eventId: payload.event_id },
  },
});
```

| Concern | Stable value |
| --- | --- |
| Agent instance | `channel.instanceId({ teamId, channelId, threadTs })` |
| Events delivery idempotency | Signed body field `payload.event_id` |
| Retry diagnostics | `x-slack-retry-num`, `x-slack-retry-reason` headers |

`channel.parseInstanceId(id)` is an escape hatch; prefer creation data. The
package is stateless, so claim event ids in application storage if duplicate
admission must be coordinated with other writes.

Interactions and commands have different semantics and no universal event-id
mapping in this channel guide. Handle their acknowledgements immediately and
choose idempotency only from a documented stable identifier for that surface.

## Outbound SDK tool pattern

```ts
import { WebClient } from '@slack/web-api';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export function replyInThread(ref: { channelId: string; threadTs: string }) {
  return defineTool({
    name: 'reply_in_slack_thread',
    description: 'Reply in the Slack thread bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const result = await client.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text,
      });
      return { output: { channel: result.channel ?? null, ts: result.ts ?? null } };
    },
  });
}
```

Read `ref` with `useInitialData()` and bind the tool in trusted agent code. The
model chooses text, not workspace, channel, thread, token, or API method.

## Recommended patterns

- Use `event.thread_ts ?? event.ts` so root mentions and replies converge.
- Include `teamId` to avoid cross-workspace collisions.
- Allowlist workspace or enterprise identity when installation policy requires it.
- Filter bot events and unwanted message subtypes in application code.
- Add only callback routes the app actually implements.
- Acknowledge interactions and commands with their required body immediately.
- Use the SDK directly for Assistant status or `chatStream()`; those are not
  channel features.
- Test valid, stale, and tampered signatures plus URL verification.

## Avoid

- Do not expose arbitrary channel ids or Web API methods as model tool input.
- Do not dispatch `trigger_id`, `response_url`, or view `response_urls`.
- Do not put short-lived capabilities in logs, model context, or durable history.
- Do not assume signature verification authorizes every workspace installation.
- Do not wait for agent output in the request handler.
- Do not expect this HTTP channel to support Socket Mode.

## Gotchas and security

- Slack signs the raw body with a request timestamp; body parsing before the
  channel invalidates verification.
- Slack's five-minute timestamp tolerance means clock drift, not just a bad
  secret, can cause spurious verification failures; keep servers NTP-synced.
- Slack can retry timed-out or failed Events API deliveries; preserve
  `event_id` even when also using it as `idempotencyKey`.
- The native payload union evolves; switch on discriminants rather than casting
  the entire payload to one event shape.
- OAuth installation, per-workspace tokens, authorization, and rotation are
  application concerns.
- The Fetch-based Slack client path runs on Node and Workers with Flue's
  `nodejs_compat`; verify the exact APIs used by the app.

## Related

- [Flue channels](./advanced_channels.md)
- [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Slack Events API](https://docs.slack.dev/apis/events-api/)
- [Slack interactivity](https://docs.slack.dev/interactivity/handling-user-interaction/)
- [`@flue/slack` README](https://github.com/withastro/flue/tree/main/packages/slack#readme)
