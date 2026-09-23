# agent_end

**Fires:** when a low-level agent run ends.
**Can change:** no. Notification only.

**pi may still keep going after this.** Auto-retry, auto-compaction + retry, and
queued follow-up messages all happen after `agent_end`.

## Signature

```typescript
pi.on("agent_end", async (event, ctx) => {
  // event.messages - messages produced by this low-level run
});
```

## Where to use it

- **Post-run automation on the messages of one run** — scan for a marker the
  model emitted, extract a produced artifact, run a linter over what changed.
- **Trigger follow-up work** — `git-merge-and-resolve.ts` in the pi examples
  fetches and merges here, then uses `pi.sendUserMessage()` to ask the model to
  resolve conflicts.
- **Per-run telemetry** — token usage and duration for this run specifically.

## Gotchas

- **This is not "pi finished".** Use `agent_settled` for that, or
  `agent_before_settle` if you need to act one last time. Sending notifications
  from `agent_end` produces duplicates whenever a retry occurs.
- `event.messages` covers this run only, not the whole conversation. Use
  `ctx.sessionManager` if you need the full picture.
- Work kicked off here races with pi's own retry logic. Prefer
  `agent_before_settle` when ordering matters.

## See also

[agent_before_settle.md](agent_before_settle.md) · [agent_settled.md](agent_settled.md)
