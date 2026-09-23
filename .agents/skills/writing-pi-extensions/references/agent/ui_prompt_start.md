# ui_prompt_start

**Fires:** when a blocking extension UI prompt opens — around `ctx.ui.select()`,
`confirm()`, `input()`, `editor()`, and `custom()`.
**Can change:** no. Notification only, and not awaited.

## Signature

```typescript
pi.on("ui_prompt_start", async (event, ctx) => {
  // event.reason === "ui_prompt"
  // event.kind: "select" | "confirm" | "input" | "editor" | "custom"
  // event.title: prompt title when available
});
```

## Where to use it

- **Host and status integrations** — report "waiting for user" instead of
  "running", so an RPC client or dashboard doesn't look hung.
- **Pause timers** — stop counting model time while a human is deciding.
- **Suppress notifications** while a dialog is already in front of the user.

## Gotchas

- Nested or overlapping prompts are coalesced into one outer waiting span, so
  you get one start/end pair, not one per prompt.
- Handlers are best-effort and are not awaited before the prompt shows. Don't
  try to do anything here that must complete first.

## See also

[ui_prompt_end.md](ui_prompt_end.md)
