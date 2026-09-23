# session_before_switch

**Fires:** before starting a new session (`/new`) or switching to another
(`/resume`).
**Can change:** yes — can cancel the switch.

## Signature

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason: "new" | "resume"
  // event.targetSessionFile: only for "resume"
  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

## Return value

`{ cancel: true }` aborts the switch. Anything else (including `undefined`)
lets it proceed.

## Where to use it

- **Confirm destructive transitions** — warn before `/new` discards an
  unfinished conversation.
- **Dirty-repo guard** — block a switch while the working tree has uncommitted
  changes the user probably wants to deal with first.
- **Flush unsaved work** — write out a draft, push a checkpoint, commit a stash.

## What happens after a successful switch

`session_shutdown` for the old instance → extensions reload and rebind →
`session_start` with `reason: "new" | "resume"` and `previousSessionFile` →
`resources_discover`. Do cleanup in `session_shutdown`, rebuild in
`session_start`.

## Gotchas

- Check `ctx.hasUI` before prompting, or a print-mode run stalls.
- This is a veto point, not a place to mutate the target session. Use the
  `withSession` callback on `ctx.switchSession()` for that
  (see [../api.md](../api.md)).

## See also

[session_before_fork.md](session_before_fork.md) · [session_shutdown.md](session_shutdown.md)
