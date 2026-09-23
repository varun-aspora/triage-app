# tool_execution_update

**Fires:** when a tool reports partial progress via its `onUpdate` callback.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});
```

## Where to use it

- **Live progress** — surface a long-running tool's partial output in a status
  line or widget.
- **Watchdogs** — detect a tool that has stopped reporting progress and warn.
- **Stream relay** — forward partial results to an external client.

## Gotchas

- Only fires for tools that actually call `onUpdate`. Most don't. Absence of
  updates says nothing about whether a tool is alive.
- In parallel mode, updates from different tools interleave. Key everything by
  `toolCallId`.
- Can be high-frequency. Keep the handler cheap.
