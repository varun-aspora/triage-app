# agent_start

**Fires:** when a low-level agent run begins. Also fires again after a
successful retry recovery.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("agent_start", async (_event, ctx) => {
  ctx.ui.setStatus("my-ext", "thinking…");
});
```

## Where to use it

- **Start a timer or spinner** for "how long has this run been going".
- **Snapshot state** you want to diff against at `agent_end` — git HEAD, file
  mtimes, an open-file list.
- **Show system prompt info** for debugging, via `ctx.getSystemPrompt()`.
- **Mark external systems busy** — set a tmux title, update a dashboard.

## Gotchas

- One user prompt can produce **several** `agent_start` events, because retries
  and auto-compaction recovery start fresh runs. Don't treat it as "the user
  just asked something" — that's `before_agent_start`.
- Pair it with `agent_settled`, not `agent_end`, if you want "pi is done".
