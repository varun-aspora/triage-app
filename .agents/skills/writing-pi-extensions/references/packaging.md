# Locations, dependencies, packaging, modes

## Where extensions load from

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | global |
| `~/.pi/agent/extensions/*/index.ts` | global, subdirectory |
| `.pi/extensions/*.ts` | project-local |
| `.pi/extensions/*/index.ts` | project-local, subdirectory |

Project-local extensions load **only after the project is trusted**. Extensions
in these locations can be hot-reloaded with `/reload`; `pi -e ./path.ts` cannot,
so use it for quick tests only.

Extra paths via `settings.json`:

```json
{
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"],
  "extensions": ["/path/to/local/extension.ts", "/path/to/local/extension/dir"]
}
```

> Extensions run with your full system permissions and can execute arbitrary
> code. Only install from sources you trust.

## Testing without polluting the real config

An extension that writes logs, caches, or state under `CONFIG_DIR_NAME` will
create those files in the user's actual `~/.pi/` the first time you exercise it.
That is fine in normal use and unwelcome during development — especially when
you are only checking that the code runs.

Make the base directory injectable rather than reading `getAgentDir()` at module
scope, and point it somewhere disposable while testing:

```typescript
const BASE_DIR = process.env.MY_EXT_DIR ?? getAgentDir();
const LOG_FILE = join(BASE_DIR, "my-extension.log");
```

Exercise pure logic (path matchers, command parsers, decision tables) by
exporting those functions and calling them directly — no session, no filesystem.
Save a real pi run for the integration check, and tell the user if a test left
files behind.

## Imports

| Package | Purpose |
|---|---|
| `@earendil-works/pi-coding-agent` | Extension types: `ExtensionAPI`, `ExtensionContext`, events, helpers |
| `typebox` | Tool parameter schemas |
| `@earendil-works/pi-ai` | AI utilities — `StringEnum`, `getCurrentSystemMessage`, provider types |
| `@earendil-works/pi-tui` | TUI components for custom rendering |

Node built-ins (`node:fs`, `node:path`, …) work. Extensions load through
[jiti](https://github.com/unjs/jiti), so TypeScript needs no build step.

## Layouts

**Single file** — `~/.pi/agent/extensions/my-extension.ts`.

**Directory** — `my-extension/index.ts` (entry) plus helper modules.

**Package with dependencies:**

```
my-extension/
├── package.json
├── package-lock.json
├── node_modules/
└── src/index.ts
```

```json
{
  "name": "my-extension",
  "dependencies": { "zod": "^3.0.0" },
  "pi": { "extensions": ["./src/index.ts"] }
}
```

Run `npm install` in the directory and imports resolve automatically. A
`package.json` in a parent directory works too.

For packages installed with `pi install`, **runtime deps must be in
`dependencies`, not `devDependencies`** — installation uses `npm install
--omit=dev`. (When `npmCommand` is configured, git packages use a plain
`install` for wrapper compatibility.)

## Distributing

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install ./relative/path

pi remove npm:@foo/bar
pi list
pi update --extensions     # update packages, reconcile pinned git refs

pi -e npm:@foo/bar         # try without installing (temp dir, this run only)
```

By default `install` / `remove` write to `~/.pi/agent/settings.json`. Use `-l`
for `.pi/settings.json`, which can be committed — pi installs missing packages
automatically on startup once the project is trusted.

Versioned npm specs and pinned git refs are **not** moved forward by
`pi update --extensions`; it only reconciles an existing clone to the configured
ref. Packages can bundle skills, prompt templates, and themes alongside
extensions.

## Async factories

A factory may be `async`; pi awaits it before continuing startup, so async init
completes before `session_start`, before `resources_discover`, and before queued
`pi.registerProvider()` calls are flushed.

```typescript
export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = await response.json();
  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((m) => ({ /* ... */ })),
  });
}
```

This makes fetched models available at startup and to `pi --list-models`.

**Do not start background resources in the factory** — processes, sockets,
watchers, timers. The factory also runs in invocations that never open a
session. Defer them to `session_start` or to the command/tool that needs them,
and close them in `session_shutdown`.

## Run modes

| Mode | `ctx.mode` | `ctx.hasUI` | Notes |
|---|---|---|---|
| Interactive | `"tui"` | `true` | Full TUI |
| RPC (`--mode rpc`) | `"rpc"` | `true` | Dialogs via JSON protocol; `custom()` returns `undefined` |
| JSON (`--mode json`) | `"json"` | `false` | Event stream to stdout; UI methods are no-ops |
| Print (`-p`) | `"print"` | `false` | Extensions run but cannot prompt |

Gate dialogs and notifications on `ctx.hasUI`; gate terminal-only features
(`custom()`, component factories, direct TUI rendering) on `ctx.mode === "tui"`.

## Error handling

- Extension errors are logged and the agent continues.
- An error thrown in a `tool_call` handler **blocks** the tool (fail-safe).
- A tool's `execute` must **throw** to report failure; the error is caught,
  reported to the model with `isError: true`, and execution continues.

## See also

[api.md](api.md) · [tools.md](tools.md)
