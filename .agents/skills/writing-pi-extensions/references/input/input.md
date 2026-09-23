# input

**Fires:** when user input is received — after extension commands are checked,
but **before** skill and prompt-template expansion. The event sees raw text, so
`/skill:foo` and `/template` are not yet expanded.
**Can change:** yes — can transform the text, or handle it entirely.

## Processing order

1. Extension commands (`/cmd`) checked first — if found, the handler runs and
   `input` is **skipped**.
2. `input` fires.
3. If not handled: skill commands (`/skill:name`) expand.
4. If not handled: prompt templates (`/template`) expand.
5. Agent processing begins (`before_agent_start`, …).

## Signature

```typescript
pi.on("input", async (event, ctx) => {
  // event.text              - raw input, before expansion
  // event.images            - attached images
  // event.source            - "interactive" | "rpc" | "extension"
  // event.streamingBehavior - "steer" | "followUp" | undefined

  if (event.text.startsWith("?quick ")) {
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
  }

  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  if (event.source === "extension") return { action: "continue" };

  return { action: "continue" };
});
```

## Return value

| Action | Effect |
|---|---|
| `continue` | Pass through unchanged. The default if the handler returns nothing. |
| `transform` | Modify `text` / `images`, then continue to expansion. Transforms chain across handlers. |
| `handled` | Skip the agent entirely. First handler to return this wins. |

`streamingBehavior` is `undefined` when idle, `"steer"` for a mid-stream
interrupt, and `"followUp"` for a message queued until the agent finishes.

## Where to use it

- **Shorthand expansion** — `?quick`, `@file`, `#1234` turned into fuller
  prompts before the model sees them.
- **Lightweight local commands** that shouldn't burn a model call — return
  `handled` after doing the work yourself.
- **Prepend standing context** to every prompt (repo conventions, current
  ticket) without touching the system prompt.
- **Streaming-aware routing** — treat a steering interrupt differently from a
  fresh prompt (`input-transform-streaming.ts`).
- **Intercept skill invocations** before expansion, to rewrite or veto them.

## Gotchas

- **Extension commands bypass this event entirely.** If you registered
  `/deploy`, your `input` handler never sees `/deploy foo`.
- Check `event.source`. Messages you inject with `pi.sendUserMessage()` arrive as
  `"extension"` and will re-enter your own handler — an easy infinite loop.
- `handled` means no agent turn at all. The user sees nothing unless your
  handler produces feedback itself.
- Text here is pre-expansion. Matching on the *expanded* content of a skill or
  template is not possible from this hook.

## See also

[../agent/before_agent_start.md](../agent/before_agent_start.md) · [../api.md](../api.md)
