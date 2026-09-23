# session_tree

**Fires:** after `/tree` navigation completes.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("session_tree", async (event, ctx) => {
  // event.newLeafId, event.oldLeafId
  // event.summaryEntry   - the branch summary, if one was written
  // event.fromExtension  - whether an extension supplied it
});
```

## Where to use it

- **Rebuild branch-scoped state.** The active branch just changed under you.
  Anything derived by walking `ctx.sessionManager.getBranch()` is now stale —
  recompute it here, the same way `session_start` does.
- **Restore external state to match the branch** — check out the git commit or
  stash associated with the target entry.
- **Update a status line** showing which branch/checkpoint is active.

## Gotchas

- This is the counterpart to `session_start` for *in-session* branch changes.
  If you only rebuild state in `session_start`, `/tree` will silently desync it.
- `oldLeafId` lets you diff what was abandoned; `summaryEntry` may be absent
  when navigation ran with `summarize: false`.
