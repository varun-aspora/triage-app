# session_compact_failed

**Fires:** when compaction fails or is aborted.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  // event.reason        - "manual" | "threshold" | "overflow"
  // event.errorMessage  - present for non-abort failures
  // event.aborted       - true for cancelled/aborted compactions
  // event.willRetry     - whether the aborted turn would have retried
  // event.fromExtension - whether extension-supplied content was in use
});
```

## Where to use it

- **Surface the failure** — a silent compaction failure on `reason: "overflow"`
  usually means the next request will hard-fail on context length. Tell the user.
- **Fall back** — trigger `ctx.compact()` again with simpler instructions, or
  with `fromExtension` logic disabled.
- **Debug your own summarizer** — if `fromExtension` is true and `errorMessage`
  is set, your `session_before_compact` returned something invalid.

## Gotchas

- Distinguish `aborted` (user pressed Esc — expected) from `errorMessage`
  (something broke). Don't alarm the user about their own cancellation.
- Retrying compaction from inside this handler can loop. Bound the attempts.
