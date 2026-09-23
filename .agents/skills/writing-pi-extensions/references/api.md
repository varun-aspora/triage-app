# ExtensionAPI and contexts

Three surfaces: `pi` (the API handed to your factory), `ctx` (passed to every
handler), and `ExtensionCommandContext` (what command handlers get — a superset
of `ctx` with session-control methods that would deadlock elsewhere).

## pi.* — ExtensionAPI

### Subscriptions and registration

| Method | Notes |
|---|---|
| `pi.on(event, handler)` | Returns an unsubscribe function for that one registration. Handlers run in extension load order, then registration order. Adding or removing during a dispatch doesn't affect that dispatch. |
| `pi.registerTool(def)` | Works at load time *and* after startup. New tools are callable immediately, no `/reload`. See [tools.md](tools.md). |
| `pi.registerCommand(name, opts)` | `{ description, handler, getArgumentCompletions? }`. If two extensions register the same name, pi keeps both and suffixes them in load order (`/review:1`, `/review:2`). |
| `pi.registerShortcut(key, opts)` | e.g. `"ctrl+shift+p"`. Format in pi's `keybindings.md`. |
| `pi.registerFlag(name, opts)` | `{ description, type, default }`. Read with `pi.getFlag(name)`. |
| `pi.registerProvider(name, config)` | Register or override a model provider. Calls in the factory are queued and flushed at init; later calls take effect immediately. |
| `pi.unregisterProvider(name)` | |
| `pi.registerMessageRenderer(customType, r)` | For `sendMessage` custom messages. |
| `pi.registerEntryRenderer(customType, r)` | For `appendEntry` custom entries. |
| `pi.registerMarkdownTransformer(fn)` | Display-only rewrite of user/assistant/thinking markdown. Must be synchronous and cheap; runs on every streaming update and width change. |

### Messages and entries

| Method | Goes to the model? | Notes |
|---|---|---|
| `pi.sendMessage(msg, opts?)` | yes | Custom message. `deliverAs`: `"steer"` (default, after the current turn's tools), `"followUp"` (after the agent finishes), `"nextTurn"` (queued, no interruption). `triggerTurn: true` starts a response if idle. |
| `pi.sendUserMessage(content, opts?)` | yes | Looks like the user typed it; always triggers a turn. `deliverAs` is **required** while streaming. `expandPromptTemplates: true` opts into command/skill/template expansion (default `false`). |
| `pi.appendEntry(customType, data?)` | **no** | Durable extension state. Renders in the transcript if paired with `registerEntryRenderer`. |

### Session metadata

`pi.setSessionName(name)` · `pi.getSessionName()` ·
`pi.setLabel(entryId, label)` (pass `undefined` to clear; labels show in `/tree`
and survive restarts) · read with `ctx.sessionManager.getLabel(id)`.

### Tools, model, thinking

```typescript
const active = pi.getActiveTools();  // string[]
const all = pi.getAllTools();        // name, description, parameters, promptGuidelines, sourceInfo
pi.setActiveTools([...new Set([...active, "my_custom_tool"])]);  // merge, don't replace
```

`sourceInfo.source` is `"builtin"`, `"sdk"` (from `createAgentSession({ customTools })`),
or extension metadata. Use it rather than guessing from names.

`pi.setModel(model)` returns `false` if the provider has no auth configured. It
records the change in session history and restores on resume, but does not
change `defaultProvider` / `defaultModel` for new sessions. Same scoping applies
to `pi.setThinkingLevel(level)` / `pi.getThinkingLevel()`.

### Other

- `pi.getCommands()` — commands invokable via `prompt`: extensions, then
  templates, then skills. Each has `name`, `description?`, `source`, and
  `sourceInfo` (`path`, `source`, `scope`, `origin`, `baseDir?`). Use
  `sourceInfo` as the provenance field; don't parse names or paths. Built-in
  interactive commands like `/model` are not included.
- `pi.exec(command, args, options?)` → `{ stdout, stderr, code, killed }`.
- `pi.events` — shared bus between extensions: `pi.events.on("my:event", fn)`,
  `pi.events.emit("my:event", data)`.

## ctx.* — ExtensionContext

Every handler gets this.

| Field | Notes |
|---|---|
| `ctx.ui` | `select`, `confirm`, `input`, `editor` (blocking), `notify`, `setStatus`, `setWidget` (fire-and-forget). Dialogs accept `{ timeout }` or `{ signal }`; on timeout `select`/`input` return `undefined` and `confirm` returns `false`. |
| `ctx.mode` | `"tui" \| "rpc" \| "json" \| "print"`. Gate terminal-only features on `=== "tui"`. |
| `ctx.hasUI` | `true` in TUI and RPC. Gate dialogs and notifications on this. |
| `ctx.cwd` | Working directory. Build project config paths with `CONFIG_DIR_NAME`, never a literal `".pi"`. |
| `ctx.isProjectTrusted()` | Includes temporary and CLI trust overrides, not just saved decisions. Check before reading project-local config. |
| `ctx.sessionManager` | Read-only session access — see [state.md](state.md). |
| `ctx.modelRegistry` | `getProvider(id)`, `getProviderAuth(id)`, `getAvailable()`, `find(provider, id)`. |
| `ctx.model` / `ctx.thinkingLevel` | Active model and its effective thinking level. |
| `ctx.scopedModels` | Read-only list scoped to the session (`--models` flag, `enabledModels` setting). Empty means everything is usable. Use it to build a picker that matches the built-in one. |
| `ctx.signal` | Current agent abort signal, or `undefined` when no turn is active. Thread it through every nested `fetch`, model call, and process. |
| `ctx.isIdle()` / `ctx.abort()` / `ctx.hasPendingMessages()` | `isIdle()` is false during runs, retries, auto-compaction retries, and queued continuations. |
| `ctx.shutdown()` | Graceful shutdown. Deferred to idle in interactive and RPC; a no-op in print mode. Emits `session_shutdown` first. |
| `ctx.getContextUsage()` | Current usage for the active model. |
| `ctx.compact(opts?)` | Triggers compaction without awaiting; use `onComplete` / `onError`. |
| `ctx.getSystemPrompt()` | pi's current prompt string. Reflects `before_agent_start` chaining, but **not** `context` mutations or `before_provider_request` payload rewrites. |

### Streaming a model call from an extension

Use `ctx.modelRegistry.streamSimple(model, context, options)` for
provider-neutral options such as `reasoning`, or `stream()` for API-specific
ones. Both resolve configured providers and auth, **including providers
registered via `pi.registerProvider()`** — which `pi-ai/compat` streaming
functions cannot see. Both return an `AssistantMessageEventStream`: iterate for
events, `await .result()` for the final message. Setup failures surface as error
events and error results.

## ExtensionCommandContext — commands only

These extend `ExtensionContext`. They are restricted to command handlers because
they can deadlock if called from an event handler.

| Method | Notes |
|---|---|
| `ctx.getSystemPromptOptions()` | Same shape as `before_agent_start`'s. May contain full context-file contents — treat as sensitive, keep it out of logs and autocomplete metadata. |
| `ctx.waitForIdle()` | Waits through retries, auto-compaction retries, and queued continuations. |
| `ctx.newSession(options?)` | `{ parentSession?, setup?, withSession? }`. |
| `ctx.fork(entryId, options?)` | `position: "before"` (default, `/fork`) or `"at"` (`/clone`); `withSession?`. |
| `ctx.switchSession(path, options?)` | Discover paths with `SessionManager.list(cwd)` / `listAll()`. |
| `ctx.navigateTree(targetId, options?)` | `{ summarize, customInstructions, replaceInstructions, label }`. **Rejects** (does not return `{ cancelled: true }`) while a response, compaction, or another navigation is active. `await ctx.waitForIdle()` and retry. |
| `ctx.reload()` | Same flow as `/reload`. |

Replacement calls return `{ cancelled }` when an extension vetoed via
`session_before_switch` / `session_before_fork`.

### Session replacement footguns

`withSession` receives a fresh `ReplacedSessionContext` with async
`sendMessage()` / `sendUserMessage()` bound to the **new** session.

- It runs only after the old session emitted `session_shutdown`, the old runtime
  was torn down, and the new instance already received `session_start`.
- It still executes in the **original closure**, so your old instance may have
  already run its shutdown cleanup.
- Captured old `pi` / old command `ctx` session-bound objects are stale and
  **throw** if used. Use only the `ctx` passed to `withSession`.
- Raw objects you extracted earlier (e.g. `const sm = ctx.sessionManager`) are
  still the old ones. Don't reuse them.
- Capture only plain data that survives shutdown: strings, ids, serialized
  config.

```typescript
// Safe
pi.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "Continue from the replacement session";
    await ctx.newSession({
      withSession: async (ctx) => { await ctx.sendUserMessage(kickoff); },
    });
  },
});

// Unsafe — stale objects
const oldSessionManager = ctx.sessionManager;
await ctx.newSession({
  withSession: async (_ctx) => {
    oldSessionManager.getSessionFile();  // stale
    pi.sendUserMessage("wrong");         // stale
  },
});
```

### ctx.reload() behaviour

`await ctx.reload()` emits `session_shutdown`, reloads resources, then emits
`session_start` (`reason: "reload"`) and `resources_discover`
(`reason: "reload"`). The running handler continues **in the old call frame**,
so code after the await runs from the pre-reload version and must not assume old
in-memory state is valid. Treat reload as terminal: `await ctx.reload(); return;`.

Tools get `ExtensionContext`, not the command context, so they cannot call
`ctx.reload()`. Expose a command as the entrypoint and have the tool queue it:

```typescript
pi.registerTool({
  name: "reload_runtime",
  label: "Reload Runtime",
  description: "Reload extensions, skills, prompts, themes, and context files",
  parameters: Type.Object({}),
  async execute() {
    pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
    return { content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }] };
  },
});
```

## See also

[state.md](state.md) · [tools.md](tools.md) · [packaging.md](packaging.md)
