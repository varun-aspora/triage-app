# session_before_tree

**Fires:** on `/tree` navigation, before the branch is switched.
**Can change:** yes — can cancel, or supply the branch summary.

## Signature

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  return { cancel: true };

  // or supply a summary of the abandoned branch:
  return {
    summary: {
      summary: "...",
      // usage: summaryResponse.usage,
      details: {},
    },
  };
});
```

## Where to use it

- **Custom branch summaries** — when navigating away from a branch, write a
  summary in your own format so the abandoned work is recoverable.
- **Guard navigation** — block moving away while your extension has pending
  work bound to the current branch.
- **Checkpoint** the current branch (stash, commit, snapshot) before leaving it.

## Gotchas

- Pass `event.signal` to any model call you make here.
- The summary describes the branch being *left*, not the one being entered.
- Navigation is rejected outright while an agent response, compaction, or
  another navigation is active — that rejection happens before this event, so
  don't rely on it as your only concurrency guard.

## See also

[session_tree.md](session_tree.md)
