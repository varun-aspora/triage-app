# model_select

**Fires:** when the model changes — `/model`, model cycling (Ctrl+P), or session
restore.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model         - newly selected model
  // event.previousModel - previous model, undefined on first selection
  // event.source        - "set" | "cycle" | "restore"

  const next = `${event.model.provider}/${event.model.id}`;
  ctx.ui.setStatus("model", next);
});
```

## Where to use it

- **Status line** showing the active provider/model.
- **Model-specific initialization** — swap a system prompt section, adjust
  truncation limits, or enable a tool that only one provider supports.
- **Per-model tool sets** — narrow `pi.setActiveTools()` for a small model that
  handles fewer tools well.
- **Cost warnings** — notify when switching to an expensive model.
- **Telemetry** — track which models get used for what.

## Gotchas

- Branch on `source`. `"restore"` fires when a session is resumed and is not a
  user action — notifying on it is noise.
- `previousModel` is `undefined` on the first selection; don't dereference it
  blindly.
- Calling `pi.setModel()` inside the handler re-triggers the event. Guard.

## See also

[thinking_level_select.md](thinking_level_select.md)
