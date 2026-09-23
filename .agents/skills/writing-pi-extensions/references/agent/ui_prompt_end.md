# ui_prompt_end

**Fires:** when pi is no longer waiting on that UI prompt span.
**Can change:** no. Notification only, and not awaited.

## Signature

```typescript
pi.on("ui_prompt_end", async (event, ctx) => {
  // pairs with the preceding ui_prompt_start
});
```

## Where to use it

- **Clear the "waiting for user" state** set in `ui_prompt_start`.
- **Resume timers** paused while the dialog was open.
- **Re-enable notifications** that were suppressed during the prompt.

## Gotchas

- Because overlapping prompts coalesce, this fires once for the outer span, not
  once per nested dialog. Track state as a boolean, not a counter of prompts.
- The event does not tell you what the user chose. Read the return value of the
  `ctx.ui.*` call for that.

## See also

[ui_prompt_start.md](ui_prompt_start.md)
