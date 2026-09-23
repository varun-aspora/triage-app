# project_trust

**Fires:** during startup, before pi decides whether to trust a project with
dynamic config (`.pi`, `.agents/skills`). Also on session replacement (e.g.
`/resume`) into a cwd whose trust is unresolved in this process.
**Can change:** yes — owns the trust decision.

Only user/global extensions and CLI `-e` extensions participate. Project-local
extensions are not loaded until after trust resolves, so they can never see it.

## Signature

```typescript
pi.on("project_trust", async (event, ctx) => {
  if (await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

## Event

| Field | Type | Meaning |
|---|---|---|
| `cwd` | `string` | Directory whose trust is being decided |

`ctx` here is a **limited trust context**: `cwd`, `mode`, `hasUI`, and the
`select` / `confirm` / `input` / `notify` helpers. No `sessionManager`, no model
access.

## Return value

Required: `{ trusted: "yes" | "no" | "undecided", remember?: boolean }`.

- The first handler returning `"yes"` or `"no"` owns the decision and suppresses
  pi's built-in trust prompt.
- `remember: true` persists the decision to `trust.json`; otherwise it applies
  to this process only.
- `"undecided"` defers to later handlers, then to saved decisions, then to the
  `defaultProjectTrust` setting.

## Where to use it

- **Policy-driven trust** — auto-trust anything under `~/work/`, auto-decline
  anything under `~/Downloads/`, without a prompt each time.
- **Org allowlists** — trust only repos whose remote matches your org.
- **CI and headless runs** — return a deterministic decision so a `-p` run never
  stalls on the built-in prompt.

## Gotchas

- Check `ctx.hasUI` before prompting; in print/JSON mode there is nobody to ask.
- Returning `"yes"` is a real security decision — it lets project-local
  extensions execute arbitrary code. Be conservative with `remember: true`.
- A project-local extension cannot implement this. It must be global or `-e`.
