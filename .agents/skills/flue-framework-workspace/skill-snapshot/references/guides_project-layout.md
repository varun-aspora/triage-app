---
title: Project Layout
source: https://flueframework.com/docs/guide/project-layout/
nav_section: Guides
---

# Project Layout

## What it is

Flue has very few required file/folder conventions. The page gives the recommended
structure for single-agent and multi-agent projects, names the top-level files Flue
looks for (`src/app.ts`, `src/db.ts`, `src/cloudflare.ts`, `flue.config.ts`,
`vite.config.ts`), and explains how Flue picks one *source directory* out of
`.flue/`, `src/`, or the project root. Only `app.ts` is required; everything else is
optional. Build output goes to `dist/` by default.

## Recommended layout — single agent

```yaml
my-project/
├─ src/                  # Source directory
│  ├─ app.ts             # Server and router entrypoint (required)
│  ├─ db.ts              # Database configuration (optional)
│  ├─ cloudflare.ts      # Cloudflare-specific entrypoint (optional)
│  ├─ agent.ts
│  ├─ skills/...
│  ├─ tools/...
│  ├─ subagents/...
│  └─ channels/...
├─ package.json          # npm project configuration
├─ vite.config.ts        # Vite configuration (optional)
└─ flue.config.ts        # Flue project configuration (optional)
```

## Recommended layout — multi-agent

```yaml
my-project/
├─ src/                  # Source directory
│  ├─ app.ts             # Server and router entrypoint (required)
│  ├─ db.ts              # Database configuration (optional)
│  ├─ cloudflare.ts      # Cloudflare-specific entrypoint (optional)
│  └─ agents/
│     ├─ support-agent/
│     │  ├─ skills/...
│     │  ├─ tools/...
│     │  ├─ subagents/...
│     │  ├─ channels/...
│     │  └─ agent.ts
│     ├─ triage-agent/
│     └─ shared/
├─ package.json          # npm project configuration
├─ vite.config.ts        # Vite configuration (optional)
└─ flue.config.ts        # Flue project configuration (optional)
```

Each agent gets its own folder with its own `skills/`, `tools/`, `subagents/`,
`channels/`; cross-agent code lives in `agents/shared/`.

## API surface / conventions this page introduces

### Top-level files

| Path | Purpose |
| --- | --- |
| `flue.config.ts` | Flue project configuration. Optional. |
| `vite.config.ts` | Vite build & dev server configuration. Optional. |
| `src/app.ts` | Application route map and server entrypoint. **Required.** |
| `src/db.ts` | Database configuration. Optional. |
| `src/cloudflare.ts` | Cloudflare entrypoint configuration. Optional. |

### Source-directory resolution order

Flue selects exactly one source directory, first match wins:

1. `.flue/` — a self-contained Flue source area inside a larger application.
2. `src/` — **recommended** for new projects.
3. The project root — compact layout for small dedicated projects.

Flue **does not merge layouts**. If `.flue/` exists, then `app.ts`, `db.ts`,
`cloudflare.ts` and the `'use agent'` scan are all resolved from `.flue/`, not from
`src/` or the root. Authored modules may still import ordinary supporting code from
anywhere else in the project.

### Generated output

`dist/` is the default build output directory for `vite build`; customize it in
`vite.config.ts`.

### Config keys that override entry paths (from the Configuration reference)

Entry module paths can be pinned explicitly in `flue.config.ts`:

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
});
```

```ts
interface FlueConfig {
  target?: 'node' | 'cloudflare';
  app?: string;
  db?: string;
  cloudflare?: string;
  agents?: string;      // glob narrowing the 'use agent' scan, relative to source root
  providers?: string[];
  tracing?: boolean;
}
```

Layout-relevant resolution rules:

- Unset `app`/`db`/`cloudflare` fall back to `<sourceRoot>/<field>.<ext>`, extensions
  tried in the order `ts`, `mts`, `js`, `mjs`.
- An explicit path resolves from the config file's directory and must exist, else
  `` [flue] Configured `<field>` entry not found: <path> ``.
- Missing `app` entry fails `vite dev` / `vite build` with `[flue] No app entry found. …`.
- `agents` defaults to the whole source root recursively
  (`**/*.{ts,mts,js,mjs}`); `node_modules/`, `dist/`, `output/`, `.wrangler/` and
  dot-directories are always excluded.

### `'use agent'` directive (what the scan looks for)

Placement matters for layout: the directive is a plain string at the very top of the
file, before any imports or statements. Flue scans the source root at build time and
registers every exported, capitalized function in a marked file.

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}

TriageAgent.agentName = 'triage-agent';
```

File names are irrelevant to identity — the exported function name (or `agentName`)
is the durable identity keying conversation storage.

## Recommended use cases

- Scaffolding a new Flue project: use `src/`, put `app.ts` at its root.
- Growing past one agent: move to `src/agents/<agent-name>/` with per-agent
  `skills/`, `tools/`, `subagents/`, `channels/`, and a `shared/` folder.
- Dropping Flue into an existing app that already owns `src/`: put Flue's modules in
  `.flue/` so they resolve independently.
- Small single-purpose scripts/services: keep `app.ts` at the project root and skip
  a source directory entirely.
- Non-standard existing layout you can't move: set `app`/`db`/`cloudflare`/`agents`
  explicitly in `flue.config.ts`.

## Patterns

**Narrow the agent scan in a large repo**

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  agents: 'agents/**/*.ts',
});
```

**Worker-level code that belongs to no single agent → `cloudflare.ts`**

```ts
// src/cloudflare.ts
import { DurableObject } from 'cloudflare:workers';

// This class becomes a Worker export. Declare its binding and
// migration in wrangler.jsonc so Cloudflare knows about it.
export class SalesforceAuthCache extends DurableObject {
  async refreshIfNeeded() {
    return await this.ctx.storage.get('token');
  }
}

export default {
  async scheduled(_controller, env) {
    await env.SALESFORCE_AUTH_CACHE.getByName('default').refreshIfNeeded();
  },
};
```

## When to use which location

| Need | Put it here | Not here |
| --- | --- | --- |
| HTTP routes, middleware, agent mounts | `app.ts` | `cloudflare.ts` — it must not define a default `fetch` handler |
| Persistence adapter (Node target) | `db.ts` | Cloudflare target — `db.ts` is rejected at build time there |
| Worker-level cron / queue / email handlers, app-owned Durable Objects | `cloudflare.ts` | inside an agent module |
| Scheduled or queued behavior owned by one agent | the agent module's `cloudflare` extension (`extend({ base })`) | `cloudflare.ts` |
| Flue inside a larger existing app | `.flue/` | mixing into an app-owned `src/` |
| New standalone Flue project | `src/` | `.flue/` (extra indirection for no gain) |

## Gotchas & constraints

- **No layout merging.** Once `.flue/` exists as a directory, `src/` and the root are
  ignored for entry resolution and the `'use agent'` scan.
- **Only `app.ts` is required.** Everything else is optional and has a default.
- **Cloudflare target ignores `db.ts`.** A resolved `db` entry (discovered or
  explicit) is a hard build error:
  `[flue] Custom persistence (db.ts) is not supported on the Cloudflare target. …`
  Cloudflare agents persist in Durable Object SQLite.
- **`cloudflare.ts` is inert on Node.** It resolves but is never consumed.
- **`flue.config.ts` is loaded by Node, not Vite.** Vite aliases/plugins/transforms
  don't apply; a `.ts` config needs Node ≥ 22.19 or ≥ 23.6 and erasable-only TS syntax.
- **Config file basename priority:** `flue.config.ts` → `.mts` → `.mjs` → `.js` →
  `.cjs` → `.cts`; first hit wins.
- **Renaming an agent function is a storage-identity change** unless `agentName` pins
  it. Renaming the *file* changes nothing.
- On Cloudflare, add `.flue-vite/` and `.flue-vite.wrangler.jsonc` to `.gitignore`;
  `wrangler.jsonc` lives at the project root and Flue never modifies it.

## Related

- Configuration reference: https://flueframework.com/docs/reference/configuration/
- Routing (`app.ts`): https://flueframework.com/docs/guide/routing/
- Database (`db.ts`): https://flueframework.com/docs/guide/database/
- Cloudflare target / extending `cloudflare.ts`: https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint
- Node.js target: https://flueframework.com/docs/guide/node-target/
- Deploy (`vite.config.ts`, build): https://flueframework.com/docs/guide/deploy/
- Agents / `'use agent'` directive: https://flueframework.com/docs/guide/building-agents/#use-agent-directive
