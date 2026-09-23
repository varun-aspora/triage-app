# context

**Fires:** before each LLM call.
**Can change:** yes — replaces the conversation messages for that request.

`event.messages` is a deep copy **without system messages**, so it is safe to
modify freely. The prompt and tool declarations belong to pi and are not part of
this hook.

## Signature

```typescript
pi.on("context", async (event, ctx) => {
  const filtered = event.messages.filter((m) => !shouldPrune(m));
  return { messages: filtered };
});
```

## Return value

`{ messages }` replaces the list. Return nothing to leave it untouched.

When you return a changed list, pi replays the current prompt sections and tool
declarations into one leading system message ahead of your messages. **You
cannot accidentally drop the prompt or the tools from here.** That safety is the
main reason to prefer this hook over `context_with_system`.

## Where to use it

- **Prune noise** — drop stale tool results, superseded file reads, or verbose
  outputs the model no longer needs.
- **Sliding window** — keep the last N turns plus anything after the compaction
  summary.
- **Redact** secrets or PII from what goes to the provider, while the session
  keeps the original.
- **Reorder or dedupe** — collapse repeated identical reads of the same file.

## Gotchas

- **This is not where you change the prompt or the tool set.** Those are
  reconstructed after you. Use `before_agent_start` (durable) or
  `pi.setActiveTools()`.
- Returning an *unchanged* list keeps mid-conversation system messages in place,
  so models that accept them retain their cached prefix. Returning a changed
  list triggers the replay. Don't return a new array when nothing changed.
- System messages you *add* are kept after pi's head.
- This runs before every provider request, including retries. Keep it fast.
- Dropping a tool-call message without its matching tool-result (or vice versa)
  produces a malformed conversation that most providers reject. Prune in pairs.

## See also

[context_with_system.md](context_with_system.md) ·
[../agent/before_agent_start.md](../agent/before_agent_start.md)
