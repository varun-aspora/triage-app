---
title: Discord channel
source: https://flueframework.com/docs/ecosystem/channels/discord/
bundled_docs: ecosystem/channels/discord
version: 2.0.8
reviewed: 2026-09-17
---

# Discord channel

## When to use

Use the Discord channel when an agent must receive Discord HTTP interactions,
such as application commands, autocomplete, message components, or modal
submissions, and post through a project-owned Discord REST client.

This integration implements Discord's outgoing-webhook interaction transport.
Do not use it for Gateway events or a persistent bot WebSocket. Discord allows
Gateway or HTTP delivery for an application's interactions, not both.

## Prerequisites and environment variables

- A Discord application and bot in the Discord Developer Portal.
- A public HTTPS Flue deployment.
- Application commands registered for only the command surfaces the handler supports.
- Bot permissions appropriate for every outbound REST operation.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_PUBLIC_KEY` | Yes | Verifies inbound interaction request bytes. |
| `DISCORD_BOT_TOKEN` | Yes | Authenticates project-owned outbound REST calls. |

The public key and bot token have different trust roles. Keep both in server
secret storage; never place either in a payload, prompt, or client bundle.

## How to

1. Apply the documented blueprint using Bun:

   ```sh
   bunx flue add channel discord
   ```

2. Review the generated `channels/discord.ts`. The blueprint installs
   `@flue/discord` and community-maintained `@discordjs/rest`, then exports a
   verified `channel`, a project-owned REST `client`, and a message tool.
3. Set `DISCORD_PUBLIC_KEY` and `DISCORD_BOT_TOKEN` through the deployment's
   existing secret mechanism.
4. Mount the channel in `app.ts`:

   ```ts
   import { channel as discord } from './channels/discord.ts';

   app.route('/channels/discord', discord.route());
   ```

5. In the Developer Portal, set the Interactions Endpoint URL to:

   ```txt
   https://example.com/channels/discord/interactions
   ```

6. Register only the commands implemented by the handler. Branch on the native
   numeric interaction `type`, command name, and any relevant command subtype.
7. For durable work, derive a trusted destination, call
   `channel.instanceId(destination)`, dispatch a signal, and immediately return
   a valid interaction callback.
8. Bind the generated outbound tool from trusted `initialData` in the target
   agent. Test signatures, PING handling, supported and unsupported commands,
   deadlines, and outbound permissions before deployment.

Signed PING requests are answered with PONG inside `@flue/discord`; application
code does not handle that handshake.

## Routing, dispatch, and outbound replies

The conventional route is:

```txt
POST /channels/discord/interactions
```

The interaction handler should admit work rather than wait for model output:

```ts
await dispatch(Assistant, {
  id: channel.instanceId(destination),
  initialData: { channelId: destination.channelId },
  message: {
    kind: 'signal',
    type: 'discord.command.ask',
    body: question,
    attributes: { interactionId: interaction.id },
  },
});

return {
  type: 4,
  data: { content: 'Your request was accepted.', flags: 64 },
};
```

Discord requires the initial response within three seconds. Callback type `4`
responds immediately; type `5` defers when the application will complete the
interaction through Discord's webhook API. Interaction tokens remain valid for
follow-ups for up to 15 minutes.

For an ordinary later channel message, use the generated `@discordjs/rest`
client from a `defineTool`. Bind `channelId` in application code and expose only
message content to the model. A bot-token channel message is not an interaction
follow-up and is not inherently ephemeral.

## Recommended patterns

- Keep one agent instance per validated Discord destination.
- Store destination fields in `initialData`; use `parseInstanceId()` only as an escape hatch.
- Return an explicit ephemeral acknowledgement for accepted or unsupported commands where appropriate.
- Tolerate authenticated future numeric interaction types with a safe fallback.
- Validate every REST operation used on both Node and the actual Cloudflare target.
- Set `allowed_mentions` deliberately when model-produced text could mention users or roles.

## Avoid

- Do not combine Gateway interaction delivery with this HTTP interaction route.
- Do not await the agent's answer before acknowledging the interaction.
- Do not let the model choose a channel id, credential, REST method, or arbitrary route.
- Do not assume every interaction has a guild or channel; modal and private contexts can differ.
- Do not treat a private-channel interaction token as permission to post arbitrary channel messages.
- Do not put `interaction.token` in dispatch bodies, attributes, logs, or durable history.

## Security and idempotency gotchas

- `@flue/discord` verifies request bytes with `DISCORD_PUBLIC_KEY` before the handler runs, following Discord's own scheme: an Ed25519 signature in `X-Signature-Ed25519` over the concatenation of `X-Signature-Timestamp` and the raw body. Discord's own docs do not specify a timestamp freshness window for this check.
- The channel rejects signed requests whose timestamp is more than five minutes from server time; this is `@flue/discord`'s own added replay bound, not a Discord-mandated window.
- Timestamp freshness limits stale replay but does not deduplicate requests.
- Discord does not document dependable interaction redelivery behavior.
- Preserve `interaction.id` for tracing. If duplicate admission is unacceptable,
  atomically claim it in application-owned durable storage before dispatch.
- Instance ids identify destinations; they are not authorization capabilities.
- Treat the interaction token as a short-lived response capability and keep it
  only in immediate trusted code.

## Related

- [Flue Channels guide](https://flueframework.com/docs/guide/channels/)
- [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [`@flue/discord` README](https://github.com/withastro/flue/tree/main/packages/discord#readme)
- `advanced_channels.md`
- `guides_routing.md`
