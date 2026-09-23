# agent_settled

**Fires:** last. pi will not continue running automatically after this.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("agent_settled", async (_event, ctx) => {
  // ctx.isIdle() is true here
});
```

## Where to use it

- **Desktop / Slack / terminal-bell notifications** — this is the correct event
  for "pi is waiting for you". `agent_end` fires too early and double-notifies
  on retry.
- **Status integrations** — set a tmux title, clear a spinner, mark a host
  dashboard idle.
- **Idle-time work** — indexing, cache warming, generating a session summary.
- **Auto-actions on completion** — run the test suite, open a diff.

## Gotchas

- Work *requested* from here (e.g. `pi.sendUserMessage()`) is deferred until
  every settled handler completes, so dispatch is non-reentrant. It will run,
  just not inside your handler.
- Don't use this to modify the conversation — that boundary has passed. Use
  `agent_before_settle`.

## See also

[agent_before_settle.md](agent_before_settle.md)
