---
title: Deploy
source: https://flueframework.com/docs/guide/deploy/
nav_section: advanced
---

# Deploy

## What it is

Flue applications are Vite applications. `vite dev` serves the app in development, `vite build` produces the deployable artifact, and shipping that artifact is the same as shipping any other Vite app. The `flue()` plugin from `@flue/vite` is what makes a Vite project a Flue app, and Flue builds for exactly two targets: **Node.js** (a self-starting server) and **Cloudflare** (a Worker with one Durable Object per agent).

## API surface

### `flue()` — the Vite plugin

```ts
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

Cloudflare, as the deploy page shows it:

```ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare()],
});
```

The plugin does three jobs on both targets:

1. **Resolves the project** — discovers `flue.config.ts` and locates entry modules (`app.ts` required; `db.ts` and `cloudflare.ts` optional).
2. **Scans for agents** — the `'use agent'` scan over the source root defines the app's agent set; the generated server bootstrap registers every scanned agent.
3. **Transforms agent modules** — stamps each agent's identity (the function name, or its `agentName` static override) as a string literal bound to the function, so a minified production bundle cannot corrupt the durable identity.

`flue()` also accepts inline configuration, merged over `flue.config.ts` per field.

### Target selection

`target` is a `flue.config.ts` / inline-option field: `'node' | 'cloudflare'`. When unset, `flue()` auto-detects from the Vite plugin array — `'cloudflare'` if `@cloudflare/vite-plugin` is present, otherwise `'node'`. An explicit `target` overrides detection.

### Node build and run

```bash
vite build
node dist/server.mjs
```

`vite build` bundles into two Node entries: the self-starting `dist/server.mjs`, and the non-listening `dist/app.mjs` chunk it imports. `vite preview` serves the built artifact locally with production behavior.

### Cloudflare generated files (gitignore)

```plaintext
.flue-vite/
.flue-vite.wrangler.jsonc
```

### `wrangler.jsonc` — what stays yours to author

```jsonc
{
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueTriageAgent"] }],
}
```

Only two things are yours: the `nodejs_compat` compatibility flag, and the Durable Object **migrations** — an append-only record of your deployments that Flue never writes.

## Recommended use cases

- Turning a working local Flue app into something you can run on a VM, container, or managed host (Node target).
- Shipping agents that need durable per-conversation state and global addressability with no database of your own (Cloudflare target).
- Adding a new agent to an already-deployed Cloudflare Worker — the page tells you the exact triple of changes required.
- Checking production behavior before you ship, via `vite preview`.

## Patterns

**Adding an agent on Cloudflare is always a triple:** the agent itself, its mount in `app.ts` (skip for dispatch-only agents), and a new migration tag:

```jsonc
{
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueSupportChatAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["FlueTriageAgent"] },
  ],
}
```

**Node production start** — the built server does not read `.env`, so supply the environment at start time:

```bash
set -a; source .env; set +a
node dist/server.mjs
```

**Cloudflare plugin ordering** — `flue()` must come before `cloudflare()`; the wrong order is diagnosed with an error. The related configuration reference shows the fuller wiring, where the Cloudflare plugin is handed Flue's worker-config customizer:

```ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';

export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
```

## When to use / when not to use

- **Node target** when you want a plain server you can run anywhere Node runs, or when agents need host filesystem/shell access. Not the target if you want per-conversation durable state for free — Node without a `db.ts` adapter keeps conversations in process memory and loses them on restart.
- **Cloudflare target** when you want durable state and global addressability out of the box. Not the target if you need a custom persistence adapter — `db.ts` is a Node-only entry, and a resolved `db` entry on Cloudflare is a hard build error; Cloudflare agents persist in Durable Object SQLite.
- **`vite preview`** for a faithful pre-deploy check of the built artifact, rather than trusting `vite dev`.
- For platform-by-platform, step-by-step hosting instructions, this page is not the place — go to the ecosystem deploy guides (Node.js, Docker, Cloudflare). This page covers build mechanics and the target choice only.

## Gotchas and constraints

- **Node — environment:** the built server does not load `.env`. Supply provider keys and other configuration when you start it. It listens on port `3000` by default; set `PORT` to change it.
- **Node — dependencies:** application dependencies are externalized, not bundled. Deploy the artifact alongside its `node_modules`, or in a container that installs them.
- **Node — state:** without a `db.ts` adapter, conversations live in process-local memory and a restart loses them. Configure a durable adapter before deploying anything you care about.
- **Cloudflare — plugin order:** `flue()` before `cloudflare()`, enforced with an error.
- **Cloudflare — generated paths:** add `.flue-vite/` and `.flue-vite.wrangler.jsonc` to `.gitignore`. Flue merges your authored `wrangler.jsonc` with generated bindings into the generated file; it never modifies your authored one.
- **Cloudflare — migrations:** every deployed agent needs a migration entry for its generated class. Renaming or removing a deployed agent is a storage migration too (`renamed_classes` / `deleted_classes`) — read "Managing migrations" in the Cloudflare target guide before changing anything already deployed.
- **Agent identity is durable identity:** the build stamps the function name (or `agentName`) into the bundle precisely so minification cannot change it. Renaming the agent function is therefore a storage-identity change.

## Related

- [Node.js target](https://flueframework.com/docs/guide/node-target/) — runtime behavior: state and durability, process ownership, multi-replica rules, environment and secrets.
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/) — generated classes and bindings, durable execution, service bindings, managing migrations.
- [Deploy Agents on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/), [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/), [Deploy Agents on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) — step-by-step hosting walkthroughs.
- [Database](https://flueframework.com/docs/guide/database/) — durable conversation storage for the Node target.
- [Configuration](https://flueframework.com/docs/reference/configuration/) — every `flue.config.ts` field and the Vite plugin's options.
- [Agents / 'use agent' directive](https://flueframework.com/docs/guide/building-agents/#use-agent-directive) — what the build scan looks for.
