# cache_warming_decision

**Fires:** before each prompt-cache refresh, with pi's decision already filled
in.
**Can change:** yes — can override the decision.

## Signature

```typescript
pi.on("cache_warming_decision", (event, ctx) => {
  // event.warmCost               - price of this refresh
  // event.missCost               - extra price of the next request if the entry is lost
  // event.continuationProbability - pi's estimate a request arrives in time
  // event.action                 - "warm" | "stop", pi's decision

  if (ctx.model?.provider === "my-provider") {
    return { action: "stop" };
  }
});
```

## Return value

`{ action: "warm" }` or `{ action: "stop" }`. The **last** handler that returns
an action wins. `"stop"` ends warming until the next real request.

## Where to use it

- **Providers that don't bill cache writes the way pi assumes** — a
  flat-rate gateway or a local model where warming is free, or one where it is
  pointlessly expensive.
- **Cost control** — stop warming on an expensive model, keep it on a cheap one.
- **Battery / metered connections** — stop warming when on battery or tethered.
- **Custom heuristics** — combine `ctx.isIdle()` and `ctx.getContextUsage()` with
  your own knowledge of the user's rhythm.

## Gotchas

- The event carries only pi's cost estimates. Everything else — model, idleness,
  context usage — comes from `ctx`, not the event.
- Last writer wins, so another extension loaded after you can override your
  decision.
- `"stop"` is not permanent; it ends the current warming run only.
