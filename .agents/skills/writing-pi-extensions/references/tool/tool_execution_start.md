# tool_execution_start

**Fires:** at the start of tool execution, **before** `tool_call`.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});
```

## Where to use it

- **Timing** — record a start timestamp to measure tool latency at
  `tool_execution_end`.
- **Progress UI** — set a status line showing which tool is running.
- **Concurrency tracking** — count in-flight tools in parallel mode.
- **Unconditional audit log** of attempted calls, including ones `tool_call`
  later blocks.

## Gotchas

- This fires **before** `tool_call`, so it also fires for calls that are
  subsequently blocked. It is "a call was attempted", not "a tool ran".
- To gate or modify a call, use `tool_call` — nothing you return here is read.
- In parallel mode this is emitted in assistant source order during the
  preflight phase, while `tool_execution_end` comes in completion order. Match
  them by `toolCallId`, not by arrival order.

## See also

[tool_call.md](tool_call.md) · [tool_execution_end.md](tool_execution_end.md)
