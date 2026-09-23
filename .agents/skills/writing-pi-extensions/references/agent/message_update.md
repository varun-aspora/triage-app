# message_update

**Fires:** on assistant streaming updates, token by token.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("message_update", async (event, ctx) => {
  // event.message              - the message so far
  // event.assistantMessageEvent - the token-level stream event
});
```

## Where to use it

- **Live progress UI** — a word count, a "still streaming" status, an elapsed
  timer in the footer.
- **Early detection** — spot a marker or a refusal in the stream and react
  before the message finishes.
- **Streaming relay** — forward deltas to an external client or log.

## Gotchas

- This is the hottest event in the system. Keep the handler synchronous and
  cheap; anything expensive here visibly slows streaming.
- Assistant only — user and toolResult messages do not stream.
- Don't accumulate the full text yourself; `event.message` already holds the
  message so far.
