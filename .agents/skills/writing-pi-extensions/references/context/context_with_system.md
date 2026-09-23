# context_with_system

**Fires:** before each LLM call, after every `context` handler has run and pi
has restored the prompt and tool state.
**Can change:** yes — and what you return is sent as-is.

`event.messages` is the **full transcript**, including the leading system
message and any mid-conversation prompt or tool patches. This hook owns the
prompt and the tool declarations for the request. There is no safety net.

## Signature

```typescript
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

pi.on("context_with_system", async (event, ctx) => {
  const cut = findCutIndex(event.messages);
  // Fold the dropped prefix so its prompt and tool state survives as the new head.
  const head = getCurrentSystemMessage(event.messages.slice(0, cut));
  return {
    messages: head ? [head, ...event.messages.slice(cut)] : event.messages.slice(cut),
  };
});
```

## Rules

- **Keep a system message at index 0.** Providers read the prompt and the initial
  tool declarations there. pi reports an error if a handler drops it.
- Removing a system message removes the tool declarations and section patches it
  carried. Fold them forward with `getCurrentSystemMessage()`.
- Verify your output with `getCurrentSystemPrompt()` and `getCurrentTools()`
  from `@earendil-works/pi-ai`.
- Handlers run in extension load order.
- A `systemPrompt` forced from `before_agent_start` is still projected onto the
  request after this hook.

## Where to use it

- **Aggressive truncation that must preserve tool state** — cut the transcript
  at an arbitrary point and carry the accumulated prompt/tool head forward.
- **Custom cache-boundary management** — restructure the head to control where
  the provider's cached prefix ends.
- **Provider-specific transcript shapes** that require touching system messages
  directly.

## Gotchas

- Use `context` instead unless you specifically need the system message. Almost
  every filtering or windowing job belongs there, where you cannot break the
  prompt.
- Naively slicing `event.messages` is the classic bug: it silently strips the
  tool declarations and the model loses every tool.
- Because this runs last, whatever you return wins — including over other
  extensions' careful work.

## See also

[context.md](context.md)
