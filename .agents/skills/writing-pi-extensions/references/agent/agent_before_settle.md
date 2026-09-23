# agent_before_settle

**Fires:** after retries, recovery, and queued continuations are done — the last
actionable boundary before pi goes idle.
**Can change:** yes — can append session entries and request one continuation.

## Signature

```typescript
let addedReviewReminder = false;

pi.on("agent_before_settle", async (event, ctx) => {
  if (addedReviewReminder) return;
  addedReviewReminder = true;
  return {
    entries: [...event.entries, {
      type: "custom_message",
      customType: "review-reminder",
      content: "Review the final diff before replying.",
      display: false,
    }],
    continue: true,
  };
});
```

## Return value

- `entries` — the complete proposed entry list. Allowed draft types: `custom`,
  `custom_message`, `context_edit`, `compaction`. Spread `event.entries` first
  or you drop earlier handlers' proposals.
- `continue: true` — guarantee one more provider request. If tool results,
  steering, or a follow-up already cause one, that satisfies it and no extra
  request is made. `continue: false` never suppresses natural work.

Omitted fields keep the current proposal. Handlers run in load order and each
sees prior proposals in `event.entries` and a rebuilt `event.context`.

## Where to use it

- **Self-review pass** — inject a "check your work" message and force one more
  turn before the agent stops.
- **Completion gate** — if the model claimed done but tests weren't run, append
  an instruction and continue.
- **Final bookkeeping entries** — append a summary or checkpoint entry that
  should land before the session settles.

## Gotchas

- **Guard your continuation.** An unconditional `continue: true` is evaluated
  again after the next response, which loops forever. Use a flag, a counter, or
  a condition that demonstrably becomes false.
- If the run is aborted while handlers are running, valid entries are still
  committed but the continuation is suppressed.
- Validation happens after all handlers finish, so a bad draft fails the whole
  proposal. Persistence is not transactional.
- A `custom_message` contributes a user-role message but does **not** run input
  hooks, slash commands, skills, or prompt templates.

## See also

[turn_end.md](turn_end.md) · [agent_settled.md](agent_settled.md)
