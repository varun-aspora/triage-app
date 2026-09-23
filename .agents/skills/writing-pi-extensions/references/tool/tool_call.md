# tool_call

**Fires:** after `tool_execution_start`, before the tool executes.
**Can change:** yes — can block the call, and can patch its arguments.

This is the gate. Permission prompts, path protection, and argument rewriting
all live here.

## Signature

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string; offset?: number; limit?: number }
  }
});
```

## Event

| Field | Meaning |
|---|---|
| `toolName` | `"bash"`, `"read"`, `"write"`, `"edit"`, … or your custom tool |
| `toolCallId` | Identifier for this call |
| `input` | Tool parameters — **mutable, patch in place** |

`isToolCallEventType` narrows the event and types `input`. Built-in tools need
no type parameters. For a custom tool, export its input type and pass it
explicitly:

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;

// elsewhere
if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
  event.input.action;  // typed
}
```

## Return value

`{ block: true, reason?: string, terminate?: boolean }` blocks the call and
reports `reason` to the model. `terminate` applies only to a blocked call, and
the agent stops early only when **every** finalized result in the batch is
terminating. Return nothing to allow.

## Behaviour guarantees

- Mutations to `event.input` affect the actual execution.
- Later handlers see earlier handlers' mutations.
- **No re-validation happens after your mutation** — you can write a value the
  schema would have rejected.

## Where to use it

- **Permission gates** — confirm before `rm -rf`, `sudo`, `git push --force`.
- **Path protection** — block writes to `.env`, `node_modules/`, generated files.
- **Environment injection** — prepend `source ~/.profile` or `nvm use` to bash
  commands.
- **Path rewriting** — redirect a path into a sandbox or container mount.
- **Auditing** — log every file read and command run.
- **Budget enforcement** — block after N calls to an expensive tool.

## Gotchas

- Before this fires, pi drains previously emitted agent events, so
  `ctx.sessionManager` is current through the assistant tool-calling message.
  But in the default **parallel** tool mode, sibling calls from the same
  assistant message are preflighted sequentially and executed concurrently — you
  are **not** guaranteed to see sibling tool results.
- Check `ctx.hasUI` before `ctx.ui.confirm()`, or a print-mode run hangs.
- An error thrown in a `tool_call` handler blocks the tool (fail-safe).
- Blocking is a message to the model, not a hard security boundary — the model
  can try a different phrasing. Combine with real filesystem permissions for
  anything that matters.

## See also

[tool_result.md](tool_result.md) · [tool_execution_start.md](tool_execution_start.md)
