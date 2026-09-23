# Custom tools

`pi.registerTool()` gives the model a new capability. Tools appear in the system
prompt, are callable by name, and can render their own TUI output.

Registration works both during extension load and after startup — inside
`session_start`, a command handler, or another event handler. New tools refresh
immediately: they show up in `pi.getAllTools()` and are callable without
`/reload`.

## Definition

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to the model)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list.",
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };

    onUpdate?.({ content: [{ type: "text", text: "Working..." }], details: { progress: 50 } });

    const result = await pi.exec("some-command", [], { signal });

    return {
      content: [{ type: "text", text: "Done" }],  // sent to the model
      details: { data: result },                  // for rendering and state
      // usage: nested.usage,                     // nested LLM usage, optional
      // terminate: true,                         // skip the follow-up LLM call
    };
  },
});
```

## Prompt surface

- `promptSnippet` — a one-line entry in the `Available tools` section. **Omit it
  and your tool is left out of that section entirely**, which is usually not
  what you want.
- `promptGuidelines` — bullets appended to the shared `Guidelines` section while
  the tool is active. They are appended **flat, with no tool-name prefix**, so
  "Use this tool when…" is ambiguous. Write "Use `my_tool` when…".

## Schemas

Use `StringEnum` from `@earendil-works/pi-ai` for string enums.
`Type.Union` / `Type.Literal` does not work with Google's API.

Some models include an `@` prefix in path arguments. Built-in tools strip a
leading `@` before resolving paths; if your tool takes a path, normalize it too.

## Errors

**Throw to signal failure.** A thrown error is caught, reported to the model
with `isError: true`, and execution continues. Returning an object with an
error-looking field does *not* set the flag, whatever you put in it.

```typescript
async execute(toolCallId, params) {
  if (!isValid(params.input)) throw new Error(`Invalid input: ${params.input}`);
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

## Output truncation

Tools must truncate. The built-in limit is **50KB (~10k tokens) or 2000 lines**,
whichever comes first. Exceeding it causes context overflow errors, compaction
failures, and degraded model performance.

```typescript
import {
  truncateHead, truncateTail, truncateLine, formatSize,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

const truncation = truncateHead(output, {
  maxLines: DEFAULT_MAX_LINES,
  maxBytes: DEFAULT_MAX_BYTES,
});

let result = truncation.content;
if (truncation.truncated) {
  const tempFile = writeTempFile(output);
  result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  result += ` Full output saved to: ${tempFile}]`;
}
```

- `truncateHead` where the beginning matters — file reads, search results.
- `truncateTail` where the end matters — logs, command output.
- Always tell the model it was truncated and where the full version lives.
- Document the limits in the tool description.

## File mutations

Tool calls run in **parallel** by default. If your tool mutates files, use
`withFileMutationQueue()` so it shares the per-file queue with built-in `edit`
and `write`. Without it, your tool and `edit` can both read the same original
`foo.ts`, compute different updates, and the later write silently wins.

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");
    return { content: [{ type: "text", text: `Updated ${params.path}` }], details: {} };
  });
}
```

Pass the **resolved absolute target path**, not the raw argument. For existing
files the helper canonicalizes through `realpath()`, so symlink aliases share
one queue. Queue the whole read-modify-write window, not just the final write.

## prepareArguments

Optional. Runs **before** schema validation and before `execute()`. Use it to
accept an older argument shape when pi resumes an old session whose stored tool
call no longer matches the current schema. Keep `parameters` strict — don't add
deprecated fields to it just to keep old sessions working.

```typescript
prepareArguments(args) {
  if (!args || typeof args !== "object") return args;
  const input = args as { edits?: unknown[]; oldText?: unknown; newText?: unknown };
  if (typeof input.oldText !== "string" || typeof input.newText !== "string") return args;
  return { ...input, edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }] };
}
```

## Usage accounting and early termination

- **`usage`** — if the tool makes nested LLM calls, return their combined
  `Usage`. pi persists it on the result and counts it in the footer, `/session`,
  and RPC totals.
- **`terminate: true`** — hints that the automatic follow-up LLM call should be
  skipped after the current batch. It only takes effect when **every** finalized
  result in that batch also terminates. Useful for a final structured-output
  tool that ends the run.

## Multiple tools, shared state

```typescript
export default function (pi: ExtensionAPI) {
  let connection = null;
  pi.registerTool({ name: "db_connect", /* ... */ });
  pi.registerTool({ name: "db_query", /* ... */ });
  pi.registerTool({ name: "db_close", /* ... */ });
  pi.on("session_shutdown", async () => { connection?.close(); });
}
```

State that must survive a fork or resume belongs in tool-result `details`, not
only in the closure — see [state.md](state.md).

## Rendering

Optional `renderCall(args, theme, context)` and
`renderResult(result, options, theme, context)` return a TUI `Component`. If a
slot is undefined, pi falls back to its built-in rendering for that slot, so you
can override execution without reimplementing the UI. `renderShell: "self"`
opts out of the default `Box` wrapper.

## See also

[dynamic-tools.md](dynamic-tools.md) ·
[overriding-and-remote.md](overriding-and-remote.md) ·
[tool/tool_call.md](tool/tool_call.md) · [tool/tool_result.md](tool/tool_result.md)
