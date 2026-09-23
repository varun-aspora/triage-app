# tool_execution_end

**Fires:** after a tool finishes, after `tool_result` handlers have run.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

## Where to use it

- **Latency metrics** — close the timer opened in `tool_execution_start`.
- **Error rate tracking** — `isError` per tool, to spot a flaky integration.
- **Clear progress UI** set during execution.
- **Trigger follow-on work** after a specific tool succeeds, e.g. re-index after
  a write.

## Gotchas

- `event.result` reflects `tool_result` handler changes, since those run first.
  If you want the raw result, you need `tool_result` itself.
- Emitted in **completion order** in parallel mode, while final `toolResult`
  message events come later in assistant source order.
- To change the result, use `tool_result`. Returning anything here is ignored.

## See also

[tool_result.md](tool_result.md) · [tool_execution_start.md](tool_execution_start.md)
