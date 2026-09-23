# session_before_fork

**Fires:** on `/fork` and `/clone`.
**Can change:** yes — can cancel.

## Signature

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId: ID of the selected entry
  // event.position: "before" for /fork, "at" for /clone
  return { cancel: true };
});
```

## Return value

- `{ cancel: true }` — abort the fork/clone.
- `{ skipConversationRestore: true }` — reserved for future conversation-restore
  control.

## Where to use it

- **Confirm before branching** when the extension holds state that will not
  survive the fork cleanly.
- **Checkpoint first** — stash or commit so both branches start from a known
  point. `git-checkpoint.ts` in the pi examples does this.
- **Block forking from the middle of an in-flight operation** your extension
  started.

## What happens after a successful fork

`session_shutdown` → reload and rebind → `session_start` with `reason: "fork"`
and `previousSessionFile` → `resources_discover`.

## Gotchas

- `position` distinguishes the two commands: `"before"` (fork, restores the
  selected prompt into the editor) vs `"at"` (clone, duplicates the path
  through the entry). Treat them differently if your state is position-sensitive.
- Forking is precisely the case where closure-held state goes stale. If you
  find yourself wanting to cancel forks to protect state, fix the state instead
  — see [../state.md](../state.md).
