# message_start

**Fires:** when a message begins — for user, assistant, and toolResult messages.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("message_start", async (event, ctx) => {
  // event.message
});
```

## Where to use it

- **Timing** — mark when an assistant message started, to measure
  time-to-first-token against `message_update`.
- **Per-message setup** for a renderer or an external log.
- **Counting** messages by role for a footer or budget display.

## Gotchas

- Fires for all three roles; branch on `event.message.role` or you will act on
  tool results you didn't mean to.
- Use `message_end` if you want the finished content — at start it isn't there.
