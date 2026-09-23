# session_info_changed

**Fires:** when the session display name is set — via `/name`, RPC, or
`pi.setSessionName()`.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("session_info_changed", async (event, ctx) => {
  // event.name: string | undefined (undefined when cleared)
  ctx.ui.notify(`Session renamed: ${event.name ?? "(none)"}`, "info");
});
```

## Where to use it

- **Mirror the name into an external system** — a tmux window title, a status
  bar, a dashboard, a worklog entry.
- **Derive a branch or file name** from the session name.
- **Keep a footer widget in sync** so the name is visible without opening the
  session selector.

## Gotchas

- `event.name` is the *normalized* name, and is `undefined` when the name is
  cleared. Handle the cleared case.
- Calling `pi.setSessionName()` inside this handler re-triggers it. Guard.
