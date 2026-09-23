# tool_result

**Fires:** after tool execution finishes, before `tool_execution_end` and the
final tool-result message events.
**Can change:** yes — can rewrite the result.

Handlers chain like middleware: they run in extension load order, each sees the
latest result, and each can return a **partial patch**. Omitted fields keep
their current values.

## Signature

```typescript
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError, event.usage

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  return { content: [...], details: {...}, isError: false, usage: nestedModelUsage };
});
```

## Where to use it

- **Redact secrets** from command output before the model sees them.
- **Summarize huge results** — send a long build log to a small model and return
  the summary, reporting the nested `usage`.
- **Enrich** — attach lint results to a write, or blame info to a read.
- **Downgrade an error** — turn an expected non-zero exit into a clean result so
  the model doesn't spiral.
- **Post-process** — rewrite absolute container paths back to host paths.

## Gotchas

- **Pass `ctx.signal` to nested async work.** Without it Esc cannot cancel a
  slow `fetch` or model call started here, and the user is stuck.
- Return a *patch*, not a full object. Returning `{ content }` alone is correct
  and preserves `details`.
- If you make nested model calls, return their combined `usage` or session cost
  totals under-count.
- In parallel tool mode, `tool_result` and `tool_execution_end` may interleave
  in completion order, while final `toolResult` message events are still emitted
  in assistant source order. Don't rely on ordering across sibling tools.
- Rewriting `details` breaks any renderer that expects the built-in shape.

## See also

[tool_call.md](tool_call.md) · [../tools.md](../tools.md)
