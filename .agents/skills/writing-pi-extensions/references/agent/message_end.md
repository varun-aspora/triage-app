# message_end

**Fires:** when a message is finalized — user, assistant, and toolResult.
**Can change:** yes — can replace the finalized message.

## Signature

```typescript
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: { ...event.message.usage.cost, total: 0.123 },
      },
    },
  };
});
```

## Return value

`{ message }` replaces the finalized message. **The replacement must keep the
same `role`.** Return nothing to leave it alone.

## Where to use it

- **Correct usage and cost accounting** — override `usage.cost` when you route
  through a proxy or a negotiated-rate gateway whose pricing pi doesn't know.
- **Redaction** — strip a secret or an internal hostname out of the stored
  message.
- **Normalization** — fix up malformed content blocks from a flaky provider
  before they reach the session.

## Gotchas

- Changing the role throws. Spread the original message rather than building one
  from scratch.
- This edits the persisted message, so it also changes what later turns see.
  For display-only changes, use a markdown transformer instead.
- It fires for tool results too; guard on role before rewriting.
