# session_start

**Fires:** when a session is started, loaded, or reloaded — at startup, after
`/reload`, and after every `/new`, `/resume`, `/fork`, `/clone`.
**Can change:** no return value. It is where you *do* things, not where you veto.

## Signature

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason: "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile: present for "new", "resume", "fork"
  const file = ctx.sessionManager.getSessionFile() ?? "ephemeral";
});
```

## Where to use it

- **Rebuild in-memory state** from `ctx.sessionManager` after a fork or resume.
  This is the single most important use — see [../state.md](../state.md).
- **Start session-scoped resources**: file watchers, sockets, child processes,
  timers. Do *not* start these in the extension factory; the factory also runs
  for invocations that never open a session.
- **Set the initial active tool set**, e.g. registering many tools and then
  narrowing with `pi.setActiveTools()` (see [../dynamic-tools.md](../dynamic-tools.md)).
- **Preload data** the extension will need later — recent GitHub issues, a
  ticket list, a config file from `join(ctx.cwd, CONFIG_DIR_NAME, ...)`.
- **Seed a status line** with `ctx.ui.setStatus()`.

## Gotchas

- This fires on *every* session replacement, not once per process. Anything you
  start here must be closed in `session_shutdown`, or `/reload` leaks a watcher
  on each cycle.
- Reset your in-memory state at the top of the handler before rebuilding it.
  Leftover values from the previous session are a common fork bug.
- The extension instance is reloaded and rebound across a switch, so
  `session_start` for the new session runs on a *new* instance; don't assume
  module-level caches survived.
- Gate project-local config reads behind `ctx.isProjectTrusted()`.

## See also

[session_shutdown.md](session_shutdown.md) · [../state.md](../state.md)
