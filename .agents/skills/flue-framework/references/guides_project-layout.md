---
title: Project Layout
source: https://flueframework.com/docs/guide/project-layout/
bundled_docs:
  path: guide/project-layout
  version: 2.0.8
reviewed: 2026-09-17
---

# Project Layout

## What this is and when to use it

Use this reference when creating a project, integrating Flue into an existing
application, or debugging why an entry module or agent is not discovered. Flue
selects one source directory and resolves its application entries and
`'use agent'` scan from that directory.

`src/` is canonical for new projects. `.flue/` isolates Flue inside an existing
application, while the project root is suitable for a compact dedicated app.

## Recommended layouts

Single agent:

```text
my-project/
|-- src/
|   |-- app.ts             # HTTP route map; required for Vite server builds
|   |-- db.ts              # Node persistence adapter, optional
|   |-- cloudflare.ts      # Cloudflare worker extensions, optional
|   |-- agents/
|   |   `-- assistant.ts
|   |-- tools/
|   |-- skills/
|   `-- channels/
|-- flue.config.ts
|-- vite.config.ts         # Needed for Vite dev/build
`-- package.json
```

Larger multi-agent project:

```text
my-project/
|-- src/
|   |-- app.ts
|   |-- db.ts
|   |-- cloudflare.ts
|   `-- agents/
|       |-- support/
|       |   |-- agent.ts
|       |   |-- tools/
|       |   `-- skills/
|       |-- triage/
|       |   `-- agent.ts
|       `-- shared/
|-- flue.config.ts
|-- vite.config.ts
`-- package.json
```

Folders such as `agents/`, `tools/`, `skills/`, and `channels/` are organization
conventions, not auto-routing rules. Flue 2 routes explicitly in `app.ts` and
registers agents from directives.

## Source-directory resolution

Flue chooses the first existing location and does not merge layouts:

1. `.flue/`
2. `src/` (recommended)
3. Project root

When `.flue/` exists, entry discovery and the default agent scan use `.flue/`,
not `src/` or the root. Modules in the selected source directory can still
import ordinary code from elsewhere.

## Exact files and configuration

| Path | Role |
| --- | --- |
| `flue.config.ts` | Target and optional entry/scan overrides |
| `vite.config.ts` | Vite dev/build with the Flue plugin |
| `<source>/app.ts` | Hono route map and server entry |
| `<source>/db.ts` | Node persistence adapter |
| `<source>/cloudflare.ts` | Worker-level exports and non-fetch handlers |
| Marked agent module | One or more registered agent functions |
| `wrangler.jsonc` | User-owned Cloudflare config and DO migrations |

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
  // app: './server/app.ts',
  // db: './server/db.ts',
  // cloudflare: './server/cloudflare.ts',
  // agents: 'agents/**/*.ts',
  // providers: ['anthropic'],
  // tracing: true,
});
```

Explicit entry paths resolve relative to the configuration file. The `agents`
glob narrows the build-time directive scan; it is relative to the selected
source root.

Agent registration requires the directive and a capitalized export:

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the issue and recommend the next action.';
}

TriageAgent.agentName = 'triage-agent';
```

The file path does not define durable identity. `agentName`, or otherwise the
exported function name, does.

## Current `flue init` scaffold

For `@flue/cli@2.0.8`:

```bash
bunx flue init ./my-agent --target node
bunx flue init ./my-service --target node --deploy
bunx flue init ./my-worker --target cloudflare
```

All variants write config, package and TypeScript files, `.env`, `.gitignore`,
`src/agents/hello.ts`, `AGENTS.md`, and `README.md`. Node also gets `src/db.ts`.
Deployment adds `vite.config.ts` and `src/app.ts`. Cloudflare implies deployment
and also writes `src/cloudflare.ts` and `wrangler.jsonc`.

`flue init` does not install dependencies. In 2.0.8, `--force` overwrites every
planned scaffold file; it is not limited to the Flue config.

## How to: choose and validate a layout

1. For a new project, use `src/` and let `flue init` create the skeleton.
2. For an existing app whose `src/` has unrelated conventions, choose `.flue/`
   or explicit config paths before adding entries.
3. Put HTTP routes, middleware, and agent mounts in `app.ts`.
4. Put Node persistence in `db.ts`; do not use it on Cloudflare.
5. Put Worker-level cron, queue, email, and application-owned Durable Object
   exports in `cloudflare.ts`. Keep the Hono fetch app in `app.ts`.
6. Mark every registered agent module with `'use agent'` before imports.
7. Narrow `agents` in a large repository to reduce scanning and accidental
   registrations.
8. Validate both local and built surfaces:

   ```bash
   bunx flue run src/agents/assistant.ts --message "Smoke test"
   bunx vite build
   ```

9. Inspect `dist/`, which is Vite's default build output. The Node target emits
   a runnable `dist/server.mjs`.

## Recommended patterns

- Keep entry modules thin and move domain behavior beside the owning agent.
- Give each substantial agent its own folder and keep cross-agent code in a
  clearly named `shared/` folder.
- Use `.flue/` to avoid taking over an existing application's `src/` layout.
- Set explicit paths only when a conventional source-root entry cannot work.
- Pin `agentName` so code organization and function refactors do not silently
  change storage identity.

## Avoid

- Do not spread Flue entries across `.flue/`, `src/`, and root expecting them
  to merge.
- Do not rely on an `agents/` filename convention for registration or routing.
- Do not put a default fetch handler in `cloudflare.ts`; `app.ts` owns HTTP.
- Do not commit generated Cloudflare Vite intermediates.
- Do not run `flue init --force` in an existing project without reviewing every
  path it will overwrite.

## Gotchas

- `app.ts` is required by Vite server builds, but not by `flue run` or a
  standalone `start()` script.
- A discovered `db.ts` is a build error on the Cloudflare target; Flue agents
  there persist in Durable Object SQLite.
- `cloudflare.ts` is not consumed on the Node target.
- Renaming an unpinned agent function changes durable identity; renaming its
  file does not.
- On Cloudflare, `wrangler.jsonc` is user-owned. Keep `.flue-vite/` and
  `.flue-vite.wrangler.jsonc` ignored.
- Explicit `app`, `db`, or `cloudflare` paths must exist; Flue does not silently
  fall back after an invalid override.

## Related references

- [Getting started](introduction_getting-started.md)
- [Building agents](guides_building-agents.md)
- [Configuration](https://flueframework.com/docs/reference/configuration/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Database](https://flueframework.com/docs/guide/database/)
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Deployment](https://flueframework.com/docs/guide/deploy/)
