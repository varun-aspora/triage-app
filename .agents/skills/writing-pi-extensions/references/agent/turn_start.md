# turn_start

**Fires:** at the start of each turn (one LLM response plus its tool calls).
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});
```

## Where to use it

- **Per-turn checkpointing** — `git-checkpoint.ts` in the pi examples stashes
  the working tree at each turn so any turn can be rolled back to.
- **Snapshot for diffing** — capture file state so `turn_end` can report what
  the turn changed.
- **Turn counters and budgets** — warn or intervene after N turns.
- **Reset per-turn accumulators** in your extension.

## Gotchas

- Turns repeat within a single agent run while the model keeps calling tools, so
  this can fire many times per user prompt. Keep the handler cheap — anything
  slow here is paid on every tool round-trip.
- `turnIndex` is per run, not per session.
