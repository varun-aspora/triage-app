---
title: Getting Started with Flue
source: https://flueframework.com/docs/guide/getting-started/
bundled_docs:
  path: guide/getting-started
  version: 2.0.8
reviewed: 2026-09-17
---

# Getting Started with Flue

## What this is and when to use it

Use this reference to create a Flue 2 project, run the generated agent, and add
an HTTP server only when the application needs one. Flue agents are TypeScript
functions configured with hooks. They can run directly through `flue run`, in a
standalone Node process, or behind a Hono application built by Vite.

Prerequisites:

- Node.js `>=22.19.0` is Flue's declared runtime requirement.
- An API key for the selected model provider. Cloudflare Workers AI can instead
  use the Cloudflare binding provider.
- This repository uses Bun, so the commands below use `bun`, `bunx`, and
  `bun run` rather than the npm commands shown in upstream examples.

## Choose the scaffold

`flue init` is the preferred starting point. In 2.0.8 it writes a complete
project skeleton but does not install dependencies.

| Goal | Command | Server files |
| --- | --- | --- |
| Run locally or in CI, no HTTP server | `bunx flue init ./my-agent --target node` | No `app.ts` or `vite.config.ts` |
| Node HTTP service | `bunx flue init ./my-agent --target node --deploy` | Hono app and Vite config |
| Cloudflare Worker | `bunx flue init ./my-agent --target cloudflare` | HTTP setup is implied |

Every scaffold writes:

- `flue.config.ts`, `package.json`, `tsconfig.json`, `.gitignore`, and `.env`
- `src/agents/hello.ts`
- `AGENTS.md` and `README.md`
- `src/db.ts` on the Node target
- `vite.config.ts` and `src/app.ts` when deployment is enabled
- `src/cloudflare.ts` and `wrangler.jsonc` on the Cloudflare target

The target directory is created when absent. If `--target` is omitted, the CLI
prompts; non-interactive shells must pass it explicitly. `--deploy` is off for
Node and implied for Cloudflare.

## Exact APIs and configuration

The generated agent follows this shape:

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  return 'You are a helpful assistant. Keep replies short.';
}

Assistant.agentName = 'assistant';
```

- `'use agent'` must be the module's first statement.
- Flue registers exported, capitalized functions in marked modules.
- `useModel()` is required exactly once in the root agent render.
- The synchronous return value is the system instruction string.
- `agentName` is optional, but pins the durable storage identity across
  function renames.

The basic project configuration is:

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node', // or 'cloudflare'
});
```

For a deployed Node application, Vite loads Flue and `src/app.ts` explicitly
mounts the agent:

```ts
// vite.config.ts
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [flue()] });
```

```ts
// src/app.ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Assistant } from './agents/assistant.ts';

const app = new Hono();
app.route('/agents/assistant', createAgentRouter(Assistant));
export default app;
```

## How to: build and run one agent end to end

1. Scaffold without an HTTP server unless one is actually required:

   ```bash
   bunx flue init ./my-agent --target node
   ```

2. Enter the generated project and install exactly what its `package.json`
   declares:

   ```bash
   bun install
   ```

3. Set the provider credential in `.env` without committing its value:

   ```dotenv
   ANTHROPIC_API_KEY="your-api-key"
   ```

4. Customize `src/agents/hello.ts`: rename the exported function, choose the
   exact model specifier, and replace the starter instruction. If a deployed
   scaffold is renamed, update the import and route in `src/app.ts`. On
   Cloudflare, also update the generated Durable Object class named in
   `wrangler.jsonc`.

5. Run one message. `flue run` loads `.env`, executes the module without an
   HTTP server, streams activity to stderr, and prints the final reply to
   stdout:

   ```bash
   bunx flue run src/agents/assistant.ts --message "Say hello in five words."
   ```

6. Reuse an ID to continue the same conversation:

   ```bash
   bunx flue run src/agents/assistant.ts --id hello-1 --message "Name a pet crab."
   bunx flue run src/agents/assistant.ts --id hello-1 --message "Give me three more."
   ```

7. If the project includes the HTTP setup, typecheck, build, and start Vite:

   ```bash
   bun run check:types
   bunx vite build
   bunx vite dev
   ```

8. Send a bare delivered-message object. A successful `POST` returns `202` at
   admission; read the conversation separately:

   ```bash
   curl -X POST http://localhost:5173/agents/assistant/hello-1 \
     -H 'content-type: application/json' \
     -d '{"kind":"user","body":"Tell me a joke."}'

   curl 'http://localhost:5173/agents/assistant/hello-1?view=history'
   ```

## Recommended patterns

- Start with `flue run`; add `--deploy` only for an HTTP product surface.
- Keep the first agent small: one model, stable instructions, and no sandbox
  until filesystem or command execution is required.
- Give conversations stable IDs derived from the real entity they represent,
  such as a ticket or user account.
- Pin `agentName` before renaming a production agent function.
- Use `bunx flue docs search <query>` and `bunx flue docs read <path>` so
  follow-up documentation matches the installed CLI.

## Avoid

- Do not hand-author a fresh project when `flue init` can generate it.
- Do not add an HTTP server merely to test an agent; use `flue run`.
- Do not use removed `flue dev` or `flue build` commands; use Vite.
- Do not put secrets directly in source or commit a populated `.env`.
- Do not assume an agent has shell or filesystem tools without `useSandbox()`.

## Gotchas

- `flue init` writes files only. Run `bun install` afterward.
- In 2.0.8, `--force` overwrites every path in the selected scaffold, including
  `package.json`, `vite.config.ts`, `src/app.ts`, and the starter agent. It is
  not limited to `flue.config.ts`; inspect an existing directory first.
- Without `--force`, a non-empty directory requires an interactive
  confirmation and fails in a non-TTY shell. An existing Flue config is a hard
  stop until `--force` is used.
- `src/app.ts` is required for a Vite-built server, not for `flue run` or a
  standalone `start()` script.
- HTTP `POST` is fire-and-forget. `202` means admitted, not completed.
- The HTTP body is the bare `{ kind, body, ... }` message, with optional
  top-level `initialData`, `uid`, or `idempotencyKey`; there is no nested
  `{ message: ... }` wrapper on the wire.
- The bundled `cli/init` docs' own "Generated files" list omits `wrangler.jsonc`
  from the Cloudflare target's output. Verified empirically against the
  installed 2.0.8 CLI: `flue init --target cloudflare` does write
  `wrangler.jsonc` alongside `src/cloudflare.ts` — the docs list is just
  incomplete, not the behavior.

## Related references

- [Why Flue?](introduction_why-flue.md)
- [Project layout](guides_project-layout.md)
- [Building agents](guides_building-agents.md)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [`flue init`](https://flueframework.com/docs/cli/init/)
- [`flue run`](https://flueframework.com/docs/cli/run/)
- [Node deployment](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Cloudflare deployment](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
