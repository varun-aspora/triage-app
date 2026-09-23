---
name: writing-pi-extensions
description: "Write, review, or debug pi coding-agent extensions (plugins) in TypeScript: lifecycle event hooks, custom tools, dynamic tool loading, commands, shortcuts, flags, providers, and session state. Use this skill whenever the work touches `@earendil-works/pi-coding-agent`, `pi.on(...)`, `pi.registerTool(...)`, `~/.pi/agent/extensions/`, `.pi/extensions/`, or a `pi -e ./thing.ts` run — and also when someone asks to 'hook into', 'intercept', 'gate', 'block', or 'extend' a coding agent's tool calls, prompts, compaction, or sessions, even if they don't say the word 'extension'. Covers which event to pick, what each one can change, and the failure modes that bite."
---

# Writing pi extensions

A pi extension is a TypeScript module that default-exports a factory taking
`ExtensionAPI`. Inside that factory you subscribe to lifecycle events, register
tools the model can call, add slash commands, and hold state. pi loads it via
[jiti](https://github.com/unjs/jiti), so TypeScript runs without a build step.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("loaded", "info");
  });
}
```

Two decisions carry most of the design:

1. **Which event.** Each hook sees a different slice of state and can change a
   different thing. Picking the wrong one is the usual reason an extension
   "doesn't do anything" — e.g. trying to change the tool set from `context`
   instead of `before_agent_start`.
2. **Tool or hook.** A hook reacts to what pi is already doing. A tool gives the
   model a new capability it chooses to invoke. Gating, auditing, and rewriting
   are hooks; new abilities are tools.

## Related but different

`@flue/runtime` depends on `@earendil-works/pi-ai` and
`@earendil-works/pi-agent-core`, not on `@earendil-works/pi-coding-agent`.
Flue reuses pi's model and agent-core layers but has no `pi.on()` /
`pi.registerTool()` extension host. Nothing in this skill applies to a Flue app.

## Where the file goes

| Location | Scope | `/reload`-able |
|---|---|---|
| `~/.pi/agent/extensions/*.ts` or `*/index.ts` | global | yes |
| `.pi/extensions/*.ts` or `*/index.ts` | project-local, loads only after the project is trusted | yes |
| `pi -e ./path.ts` | one run | no |

Use `-e` for a quick test, then move the file into a discovered location so
`/reload` works. Distribution over npm/git and multi-file layouts are in
[references/packaging.md](references/packaging.md).

## Event index

Read only the file for the event you are using. Each one covers the payload,
the return value, what it can change, where it's worth using, and its gotchas.

### Startup and resources

| Event | Read | Use it to |
|---|---|---|
| `project_trust` | [startup/project_trust.md](references/startup/project_trust.md) | Decide or defer trust for a project before its local config loads |
| `resources_discover` | [resources/resources_discover.md](references/resources/resources_discover.md) | Contribute extra skill, prompt, and theme directories |

### Session (`references/session/`)

| Event | Read | Use it to |
|---|---|---|
| `session_start` | [session_start.md](references/session/session_start.md) | Rebuild in-memory state, start session-scoped resources |
| `session_info_changed` | [session_info_changed.md](references/session/session_info_changed.md) | React to the session being renamed |
| `session_before_switch` | [session_before_switch.md](references/session/session_before_switch.md) | Confirm or cancel `/new` and `/resume` |
| `session_before_fork` | [session_before_fork.md](references/session/session_before_fork.md) | Confirm or cancel `/fork` and `/clone` |
| `session_before_compact` | [session_before_compact.md](references/session/session_before_compact.md) | Cancel compaction or supply your own summary |
| `session_compact` | [session_compact.md](references/session/session_compact.md) | React to a completed compaction |
| `session_compact_failed` | [session_compact_failed.md](references/session/session_compact_failed.md) | React to a failed or aborted compaction |
| `session_before_tree` | [session_before_tree.md](references/session/session_before_tree.md) | Cancel `/tree` navigation or write the branch summary |
| `session_tree` | [session_tree.md](references/session/session_tree.md) | React to a completed tree navigation |
| `session_shutdown` | [session_shutdown.md](references/session/session_shutdown.md) | Close anything `session_start` opened |

### Agent and turn (`references/agent/`)

| Event | Read | Use it to |
|---|---|---|
| `before_agent_start` | [before_agent_start.md](references/agent/before_agent_start.md) | Inject context, edit the system prompt, change the active tool set |
| `agent_start` | [agent_start.md](references/agent/agent_start.md) | Mark the start of a low-level run |
| `agent_end` | [agent_end.md](references/agent/agent_end.md) | Inspect a finished run (pi may still retry or continue) |
| `agent_before_settle` | [agent_before_settle.md](references/agent/agent_before_settle.md) | Last chance to append entries and request one more turn |
| `agent_settled` | [agent_settled.md](references/agent/agent_settled.md) | Fire notifications once pi is definitively done |
| `turn_start` | [turn_start.md](references/agent/turn_start.md) | Per-turn checkpointing |
| `turn_end` | [turn_end.md](references/agent/turn_end.md) | Rewrite the turn's entries, force one continuation |
| `message_start` | [message_start.md](references/agent/message_start.md) | Observe a message beginning |
| `message_update` | [message_update.md](references/agent/message_update.md) | Watch assistant streaming deltas |
| `message_end` | [message_end.md](references/agent/message_end.md) | Replace a finalized message (same role) |
| `ui_prompt_start` | [ui_prompt_start.md](references/agent/ui_prompt_start.md) | Report "waiting on the user" to a host |
| `ui_prompt_end` | [ui_prompt_end.md](references/agent/ui_prompt_end.md) | Clear that waiting state |

### Context (`references/context/`)

| Event | Read | Use it to |
|---|---|---|
| `context` | [context.md](references/context/context.md) | Filter or window the conversation, prompt and tools untouched |
| `context_with_system` | [context_with_system.md](references/context/context_with_system.md) | Own the full transcript including the system message |

### Provider (`references/provider/`)

| Event | Read | Use it to |
|---|---|---|
| `before_provider_headers` | [before_provider_headers.md](references/provider/before_provider_headers.md) | Add, override, or drop outgoing HTTP headers |
| `before_provider_request` | [before_provider_request.md](references/provider/before_provider_request.md) | Inspect or replace the serialized request payload |
| `after_provider_response` | [after_provider_response.md](references/provider/after_provider_response.md) | Read status and headers before the stream is consumed |
| `cache_warming_decision` | [cache_warming_decision.md](references/provider/cache_warming_decision.md) | Override pi's prompt-cache refresh decision |

### Model (`references/model/`)

| Event | Read | Use it to |
|---|---|---|
| `model_select` | [model_select.md](references/model/model_select.md) | React to a model change from `/model`, Ctrl+P, or restore |
| `thinking_level_select` | [thinking_level_select.md](references/model/thinking_level_select.md) | React to a thinking-level change |

### Tool (`references/tool/`)

| Event | Read | Use it to |
|---|---|---|
| `tool_call` | [tool_call.md](references/tool/tool_call.md) | Block a call or patch its arguments before it runs |
| `tool_result` | [tool_result.md](references/tool/tool_result.md) | Rewrite, redact, or enrich a result |
| `tool_execution_start` | [tool_execution_start.md](references/tool/tool_execution_start.md) | Observe execution beginning (fires before `tool_call`) |
| `tool_execution_update` | [tool_execution_update.md](references/tool/tool_execution_update.md) | Observe streaming partial results |
| `tool_execution_end` | [tool_execution_end.md](references/tool/tool_execution_end.md) | Observe execution finishing, with error flag |

### Bash and input

| Event | Read | Use it to |
|---|---|---|
| `user_bash` | [bash/user_bash.md](references/bash/user_bash.md) | Redirect or replace `!` / `!!` commands |
| `input` | [input/input.md](references/input/input.md) | Transform or fully handle user input before expansion |

## Tools

| Topic | Read |
|---|---|
| Registering a tool, schemas, truncation, errors, file-mutation safety | [references/tools.md](references/tools.md) |
| Keeping many tools registered but few active, loader/search tools | [references/dynamic-tools.md](references/dynamic-tools.md) |
| Overriding `read`/`bash`/`edit`/… and routing them to remote backends | [references/overriding-and-remote.md](references/overriding-and-remote.md) |

## API surface and state

| Topic | Read |
|---|---|
| `pi.*` methods and `ctx.*` fields, including which are command-only | [references/api.md](references/api.md) |
| Persisting state, session entries, branch-safe reconstruction | [references/state.md](references/state.md) |
| Locations, npm deps, packaging, run modes | [references/packaging.md](references/packaging.md) |

## Recommended practices

These apply to almost every extension, so they live here rather than in a
reference.

**Start resources in `session_start`, not in the factory.** The factory also
runs for invocations that never open a session (`--list-models`, some CLI
paths). A watcher or socket started there leaks. Pair every start with an
idempotent `session_shutdown` handler.

**Reconstruct state from the session, don't just hold it in a closure.**
Sessions fork, resume, and navigate a tree. A `let items = []` that is only
mutated by your tool will be wrong the moment the user forks. Write the state
into tool-result `details` or a custom entry, and rebuild it in `session_start`
from `ctx.sessionManager`. See [references/state.md](references/state.md).

**Prefer the narrowest hook that can do the job.** `tool_call` to gate a
command; `before_agent_start` to change the prompt or tool set;
`context_with_system` only when you genuinely need to own the system message.
Broad hooks chain with other extensions and are easy to get subtly wrong.

**Mutate `event.input` in place, return values only where documented.** Only
some events read a return value, and each reads a specific shape. `tool_call`
returns `{ block, reason, terminate }`; `input` returns `{ action, ... }`;
notification-only events ignore whatever you return. The per-event reference
states this for each one.

**Guard UI by mode.** `ctx.hasUI` is false in print (`-p`) and JSON mode — check
it before `confirm`/`select`/`input`/`editor`, or your extension hangs or
silently no-ops in scripted runs. `ctx.mode === "tui"` gates terminal-only
features.

**Thread `ctx.signal` through async work.** Any `fetch`, model call, or child
process started inside a handler should take `ctx.signal`, otherwise Esc won't
cancel it. It is defined during turn events and usually `undefined` when idle.

**Truncate tool output.** The built-in ceiling is 50KB / 2000 lines. Blowing
past it causes context overflow and compaction failures. Use `truncateHead` or
`truncateTail`, tell the model it was truncated, and say where the full output
lives.

**Throw to signal a tool error.** Returning an object with an error-ish field
does not set `isError`. Only a thrown error does.

**Name the tool in `promptGuidelines`.** Guideline bullets are appended flat to
the shared `Guidelines` section with no tool prefix, so "Use this tool when…" is
ambiguous to the model. Write "Use `my_tool` when…".

**Don't hardcode `.pi`.** Use `CONFIG_DIR_NAME` from
`@earendil-works/pi-coding-agent`; rebranded distributions rename it.

**Use `StringEnum` from `@earendil-works/pi-ai` for string enums.**
`Type.Union` / `Type.Literal` does not survive Google's API.

**Remember that handlers chain.** Handlers run in extension load order, then
registration order. Another extension may have already mutated what you see, and
may mutate what you return. Write handlers that are correct when they are not
the only one.

## Before you call it done

- Does the extension work in `-p` print mode, or does it block on a dialog?
- Does `/reload` leave duplicate watchers, timers, or sockets behind?
- After `/fork`, does your state reflect the forked branch?
- Does every tool truncate, and throw (not return) on failure?
- If you changed the active tool set, is the loader tool still active?
- Do guard conditions on `continue: true` terminate, or can they loop forever?
