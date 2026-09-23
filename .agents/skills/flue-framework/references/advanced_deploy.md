---
title: Deploy
source: https://flueframework.com/docs/guide/deploy/
bundled_docs:
  - guide/deploy
  - guide/node-target
  - guide/cloudflare-target
  - reference/configuration
  - ecosystem/deploy/node
  - ecosystem/deploy/cloudflare
version: 2.0.8
reviewed: 2026-09-17
---

# Deploy

## What and when

Flue 2.0.8 is built through Vite. The `flue()` plugin resolves project entries, scans `'use agent'` modules, registers agents, and stamps durable identities so minification cannot rename storage. Choose one target:

| Target | Use when | Persistence |
| --- | --- | --- |
| Node | You need a conventional server, host filesystem access, containers, VMs, or managed Node hosting. | `db.ts`; production defaults to process memory. |
| Cloudflare | You need global Worker ingress and one durable owner per conversation. | Automatic Durable Object SQLite; `db.ts` is rejected. |

The target is explicit in `flue.config.ts` or auto-detected: Cloudflare when the Cloudflare Vite plugin is present, Node otherwise.

## Current configuration

### Node Vite wiring

```ts
// vite.config.ts
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

`flue()` returns `Plugin[]` and accepts inline `FlueConfig`. Inline defined fields override the discovered config file field by field.

### Cloudflare Vite wiring

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
```

This exact wiring is required in 2.0.8:

- `flue()` must appear before `cloudflare()`.
- Call `flueWorkerConfig()` after `flue()` in the same config evaluation.
- Pass its return value as `cloudflare({ config })`.
- Keep the Cloudflare plugins as plain entries, not promises or indirect injection.

The customizer contributes `virtual:flue/worker` as `main`, generated Durable Object bindings, `nodejs_compat`, and validation that an authored `compatibility_date` is at least `2026-04-01`. It leaves application bindings, assets, containers, and migrations alone.

### Flue project config

```ts
interface FlueConfig {
  target?: 'node' | 'cloudflare';
  app?: string;
  db?: string;
  cloudflare?: string;
  agents?: string;
  providers?: string[];
  tracing?: boolean;
}
```

Use `defineConfig` from `@flue/runtime/config`. `app.ts` is required for dev/build. `db.ts` is Node-only. `cloudflare.ts` contributes Worker-level non-HTTP handlers and named exports on Cloudflare. The default source root is `.flue/`, else `src/`, else project root.

## How to: deploy on Node

### 1. Install and wire the build

```bash
bun add @flue/runtime hono
bun add -d @flue/vite @flue/cli vite
```

Add the Node Vite config above, register agents with `'use agent'`, and mount public agents in `src/app.ts`.

### 2. Configure durable production state

```ts
// src/db.ts
import { sqlite } from '@flue/runtime/node';

export default sqlite('/var/lib/my-app/flue.db');
```

Use an external adapter instead when state must survive host loss. A shared database still requires one live owner per conversation.

### 3. Build and verify

```bash
bunx vite build
bunx vite preview
```

The Node build produces self-starting `dist/server.mjs` and non-listening `dist/app.mjs`. Application dependencies remain external, so deploy `node_modules` or install production dependencies in the image. The generated server targets Node 22 and Flue declares Node `>=22.19.0`.

### 4. Start with deployment-owned environment

```bash
PORT=8080 node dist/server.mjs
```

The built server does not load `.env`; provide secrets and variables through the host, container, or process manager. It defaults to port `3000`.

## How to: deploy on Cloudflare

### 1. Install and wire both plugins

```bash
bun add @flue/runtime hono
bun add -d @flue/vite @cloudflare/vite-plugin vite wrangler
```

Use the exact `flueWorkerConfig()` Vite config above and set `"type": "module"` in `package.json` because the Cloudflare plugin is ESM-only.

### 2. Author Wrangler topology and migrations

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueTriageAgent"] }
  ]
}
```

Flue generates one class and binding per identity:

```text
IssueTriage -> FlueIssueTriageAgent -> FLUE_ISSUE_TRIAGE_AGENT
```

The authored migration history is application-owned and append-only. Adding an agent is a triple: add the registered export, add its `app.ts` mount unless dispatch-only, and append a unique `new_sqlite_classes` migration. Use `renamed_classes` to preserve data across an identity rename and `deleted_classes` when removing a deployed class. Never rewrite deployed entries.

### 3. Keep generated paths out of source control

```gitignore
.flue-vite/
.flue-vite.wrangler.jsonc
```

These are plugin intermediates. Flue does not rewrite the authored Wrangler file.

### 4. Develop, build, and deploy

```bash
bunx vite dev
bunx vite build
bunx wrangler deploy --dry-run
bunx wrangler deploy
```

Build first. Deploy from the project root without a custom `--config`; the Cloudflare Vite plugin's deploy redirect selects the finalized output in `dist/`. Put local Worker secrets in `.dev.vars` and deployed secrets through `bunx wrangler secret put <NAME>`.

### 5. Route static assets around application endpoints

If the same Worker serves an SPA, ensure API routes reach the Worker before the asset fallback:

```jsonc
{
  "assets": {
    "directory": "./dist/client",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/agents/*", "/channels/*"]
  }
}
```

Adjust prefixes to match `app.ts`.

## Recommended patterns

- Pin stable `agentName` values before the first production deployment when source-level renames are likely.
- Run `vite preview` through `bunx` after every Node production build.
- Keep health routes, authentication, and authorization in `app.ts`; Flue adds none automatically.
- Use `src/cloudflare.ts` for Worker events such as `scheduled`, queues, and email, not HTTP `fetch`.
- Append a migration in the same change that adds, renames, or removes a deployed Cloudflare agent identity.
- Deploy dependencies and durable storage as explicit production resources, not incidental local files.

## Avoid

- Do not use `plugins: [flue(), cloudflare()]` on 2.0.8; it omits the required worker-config customizer.
- Do not reverse plugin order or call `flueWorkerConfig()` before `flue()`.
- Do not hand-author generated `FLUE_*_AGENT` bindings.
- Do not add `db.ts` on Cloudflare or rely on Node's in-memory production default.
- Do not rename a deployed agent identity without a `renamed_classes` migration.
- Do not assume changing the URL mount requires a migration; route path is not durable identity.

## Gotchas

- Node builds externalize package dependencies and do not load `.env` at runtime.
- Node multi-replica deployments need exclusive per-conversation ownership; a shared database alone is insufficient.
- Cloudflare Durable Object migrations use generated class names and `new_sqlite_classes`, never legacy `new_classes`.
- Cloudflare `compatibility_date` values older than `2026-04-01` are rejected. An omitted date follows the Cloudflare plugin default.
- Cloudflare's automatic conversation persistence does not make virtual sandbox files durable.
- `flue run` is always Node-local and does not emulate Cloudflare bindings.
- `app.ts` public middleware runs before admission. Durable processing later receives a deterministic internal request, not the original headers or cookies.

## Related

- [Configuration](https://flueframework.com/docs/reference/configuration/)
- [Node target](https://flueframework.com/docs/guide/node-target/)
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Deploy on Node](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
- [Database](https://flueframework.com/docs/guide/database/)
