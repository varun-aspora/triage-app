# State and session data

A pi session is a **tree**, not a list. Users fork, clone, resume, and navigate
with `/tree`. A `let items = []` in your factory closure is correct only until
the first branch operation, at which point it silently describes a branch the
user is no longer on.

The rule: **write state where it is attached to an entry, and rebuild it by
walking the branch.**

## The pattern

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    items = [];  // reset first — leftovers from the old session are a fork bug
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },   // full snapshot, not a delta
      };
    },
  });
}
```

Store a **snapshot**, not a delta. Walking the branch then means "take the last
one", which is correct under forking. Deltas require replaying in order and
break as soon as a branch diverges.

Also rebuild in [session/session_tree.md](session/session_tree.md) — `/tree`
changes the active branch without firing `session_start`. Rebuilding in only one
of the two is the most common desync.

## Where to put what

| Storage | In model context? | Survives restart? | Use for |
|---|---|---|---|
| Tool result `details` | no (only `content` is) | yes | State produced by a tool call — the default choice |
| `pi.appendEntry(type, data)` | **no** | yes | Extension bookkeeping the model shouldn't see; renders in the TUI with `registerEntryRenderer` |
| `pi.sendMessage({...})` | **yes** | yes | Context you want the model to read |
| Closure variable | no | no | Caches and handles you can cheaply rebuild |
| File under `CONFIG_DIR_NAME` | no | yes, across sessions | Cross-session config and preferences |

```typescript
pi.appendEntry("my-state", { count: 42 });

pi.on("session_start", async (_event, ctx) => {
  // getBranch(), not getEntries() — see below. pi's own docs show getEntries()
  // here, which reintroduces abandoned branches.
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // reconstruct from entry.data
    }
  }
});
```

## SessionManager (read-only from `ctx`)

```typescript
ctx.sessionManager.getEntries()           // all entries, excluding the header
ctx.sessionManager.getBranch(fromId?)     // walk from an entry (default: leaf) to root
ctx.sessionManager.buildContextEntries()  // active branch with compaction applied
ctx.sessionManager.getLeafId()            // current position
```

**`getEntries()` vs `getBranch()`** is the distinction that matters:
`getEntries()` returns everything ever written, including abandoned branches.
`getBranch()` returns only the path you are actually on. For reconstructing "the
current state", you almost always want `getBranch()`.

Use `buildContextEntries()` when you need what the model will actually see —
it applies compaction, so entries folded into a summary are gone.

Other useful reads: `getEntry(id)`, `getChildren(parentId)`, `getTree()`,
`getLabel(id)`, `getLeafEntry()`, `getSessionId()`, `getSessionFile()`
(`undefined` for in-memory), `getSessionName()`, `getCwd()`, `isPersisted()`,
`buildSessionContext()`.

Static helpers for discovery: `SessionManager.list(cwd)`,
`SessionManager.listAll()`.

Mutating methods exist on `SessionManager` (`appendMessage`, `branch`, …) but
`ctx.sessionManager` is read-only access; go through `pi.*` and the command
context instead.

## Entry types you'll encounter

`session_header`, `message`, `model_change`, `thinking_level_change`, `usage`,
`compaction`, `context_edit`, `branch_summary`, `custom` (from `appendEntry`),
`custom_message` (from `sendMessage`), `label`, `session_info`.

Sessions are JSONL; each entry carries an id and a parent id, which is what
makes the tree. Full schemas are in pi's `docs/session-format.md`.

## Gotchas

- **Reset before rebuilding.** `session_start` fires on resume and fork with the
  previous session's values still in your closure.
- **Compaction does not erase your source of truth — but the wrong reader
  will.** Compaction changes what the *model* sees, not what is stored:
  "omitted raw entries remain stored" (pi's `compaction.md`). `getBranch()`
  still returns pre-compaction tool results, so a snapshot rebuild survives
  `/compact` untouched. What breaks is rebuilding from
  `buildContextEntries()`, which applies compaction and hides everything before
  `firstKeptEntryId`. Use `getBranch()` for state and reserve
  `buildContextEntries()` for answering "what will the model see".
- **`appendEntry` data never reaches the model.** If you wanted the model to see
  it, you wanted `sendMessage`.
- **Don't reuse a captured `SessionManager` across a session replacement.** It
  is the old one and will throw — see [api.md](api.md).
- Project-local state files should be gated on `ctx.isProjectTrusted()`.

## See also

[session/session_start.md](session/session_start.md) ·
[session/session_tree.md](session/session_tree.md) · [api.md](api.md)
