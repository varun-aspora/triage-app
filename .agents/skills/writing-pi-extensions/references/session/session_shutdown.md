# session_shutdown

**Fires:** before a started session runtime is torn down — on quit (Ctrl+C,
Ctrl+D, SIGHUP, SIGTERM), `/reload`, and every `/new`, `/resume`, `/fork`,
`/clone`.
**Can change:** no. Cleanup only.

## Signature

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason: "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile: destination for session replacement flows
  await watcher?.close();
  connection?.close();
  clearInterval(timer);
});
```

## Where to use it

- **Close everything `session_start` opened** — watchers, sockets, child
  processes, intervals, DB handles. This is the paired half; treat them as one
  unit when you write them.
- **Persist final state** — flush a cache, write a log, append a summary entry.
- **Side effects on exit** — auto-commit, push a checkpoint, report session
  duration to telemetry.

## Gotchas

- **Make it idempotent.** It can fire more than once across a process lifetime,
  and it fires for every session replacement, not just quit.
- Branch on `reason` when the cleanup differs: `"quit"` may warrant an
  auto-commit, `"reload"` usually shouldn't.
- Don't start new long-running work here — the runtime is going away.
- A `withSession` callback from `ctx.newSession()` / `ctx.fork()` /
  `ctx.switchSession()` runs *after* this handler, in the old closure. Assume
  anything you tore down here is already gone by then.

## See also

[session_start.md](session_start.md) · [../api.md](../api.md)
