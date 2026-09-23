# before_agent_start

**Fires:** after the user submits a prompt, before the agent loop begins.
**Can change:** yes — inject a persistent message, and/or rewrite the system
prompt and tool set for this run.

This is the main hook for shaping what the model sees. If you are reaching for
`context` to change the prompt or tools, you want this instead.

## Signature

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  return {
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

## Event

| Field | Meaning |
|---|---|
| `prompt` | The user's prompt text |
| `images` | Attached images, if any |
| `systemPrompt` | The **chained** system prompt as of this handler — includes earlier handlers' changes |
| `systemPromptOptions` | Structured inputs pi used to build the prompt (mutable) |

`systemPromptOptions` fields: `customPrompt`, `forceSystemPrompt`,
`selectedTools`, `toolSnippets`, `toolGuidelines`, `promptGuidelines`,
`sections`, `appendSystemPrompt`, `cwd`, `contextFiles`, `skills`.

## Two ways to change the prompt — pick deliberately

**Structured (preferred).** Mutate `sections`, `selectedTools`, or
`promptGuidelines` on `event.systemPromptOptions`. pi diffs the resulting
sections and appends one system message patching only what changed. Models that
accept mid-conversation system messages keep their cached prefix.

**Wholesale.** Return `systemPrompt`, or set `forceSystemPrompt`. Every provider
receives the forced text as its leading system prompt — a cache miss every time
it changes. Use only when you truly need to replace the whole thing.

Changing `selectedTools` updates both the prompt text and the executable
provider tools. `pi.setActiveTools()` inside this handler does the same thing.

## Where to use it

- **Inject repo context** — load `CLAUDE.md`-style rule files, an architecture
  note, or the current ticket into a custom section each run.
- **Mode switching** — plan mode, read-only mode, review mode: narrow
  `selectedTools` and add a section explaining the constraint.
- **Per-turn instructions** — a `/pirate` style command that sets a flag which
  this handler turns into an extra section.
- **Dynamic guidelines** — add tool guidance only when the relevant tool is
  active or the repo has the relevant files.
- **Attach a persistent message** — `message` is stored in the session and sent
  to the model, unlike `appendEntry`.

## Gotchas

- `event.systemPrompt` and `ctx.getSystemPrompt()` both reflect the chain *so
  far*. Later-loaded extensions can still change it after you.
- Rewriting the whole prompt on every turn destroys prompt caching. If the
  content is stable, put it in a section, not in a freshly interpolated string.
- The returned `message` is persisted and counted in context. For durable
  TUI-only content that the model shouldn't see, use `pi.appendEntry()` with an
  entry renderer instead.
- `systemPromptOptions.contextFiles` can contain full file contents. Treat it as
  sensitive; don't log it or expose it through command metadata.

## See also

[../context/context.md](../context/context.md) · [../dynamic-tools.md](../dynamic-tools.md)
