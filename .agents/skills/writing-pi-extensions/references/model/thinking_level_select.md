# thinking_level_select

**Fires:** when the thinking level changes — via settings, a keybinding,
`pi.setThinkingLevel()`, or a model change that clamps the level.
**Can change:** no. Return values are ignored.

## Signature

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level         - new level
  // event.previousLevel - previous level
  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

Levels: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.

## Where to use it

- **Status display** so the current reasoning budget is visible.
- **Paired settings** — raise a timeout or a turn budget when thinking goes to
  `high`/`max`.
- **Telemetry** on how often high reasoning is actually used.

## Gotchas

- The level is **clamped to model capabilities** — non-reasoning models are
  always `"off"`. So this fires as a side effect of `model_select`, with a level
  the user never chose.
- On a model change, `thinking_level_select` fires *before* `model_select`.
- Return values are ignored; you cannot veto or adjust the level from here. Use
  `pi.setThinkingLevel()` and accept the re-entrant event.

## See also

[model_select.md](model_select.md)
