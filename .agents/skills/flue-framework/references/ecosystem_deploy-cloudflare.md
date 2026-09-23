---
title: Deploy Agents on Cloudflare
source: https://flueframework.com/docs/ecosystem/deploy/cloudflare/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://developers.cloudflare.com/workers/vite-plugin/
  - https://developers.cloudflare.com/workers/configuration/secrets/
  - https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/
---

# Deploy Agents on Cloudflare

## When to choose Cloudflare

Choose this target for globally addressable agents whose conversation state should live
in per-agent-instance Durable Object SQLite. It is also the natural target for Workers AI,
Cloudflare bindings, and optional Cloudflare Sandbox containers.

Choose Node instead when agents require a custom `db.ts`, direct host filesystem access,
or Node-only infrastructure. `flue run` is Node-local and does not emulate workerd; use
`vite dev` for this target and do not treat a CI `flue run` as a Worker deployment test.

## Prerequisites

- A Cloudflare account with Workers and Durable Objects access.
- Bun and Wrangler authentication (`bunx wrangler login`).
- Flue 2.0.8 dependencies and the official Cloudflare Vite plugin.
- A unique Worker name and compatibility date `2026-04-01` or newer.
- A provider key, unless the application uses a Workers AI binding.
- Workers Paid plus Docker only when using Cloudflare Sandbox containers.

## How to build and deploy

### 1. Create the Worker project

```bash
mkdir my-flue-worker
cd my-flue-worker
bun init -y
bun add @flue/runtime@2.0.8 hono
bun add -d @flue/vite@2.0.8 @cloudflare/vite-plugin vite wrangler
```

`@flue/vite` carries the tested Cloudflare Agents SDK version. Do not add `agents` merely
to upgrade it; a project-local copy overrides Flue's tested copy and is runtime-checked for
required durability APIs.

### 2. Configure Vite

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
```

`flue()` must come first. `flueWorkerConfig()` points the Cloudflare plugin at Flue's
generated Worker entry and merged Wrangler input.

```jsonc
// package.json (relevant fields)
{
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "deploy": "vite build && wrangler deploy"
  }
}
```

`"type": "module"` is required because `@cloudflare/vite-plugin` is ESM-only.

### 3. Define and mount the agent

```ts
// src/agents/translator.ts
'use agent';
import { useModel } from '@flue/runtime';

export function Translator() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Translate the user message. Reply with the translation only.';
}
```

```ts
// src/app.ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Translator } from './agents/translator.ts';

const app = new Hono();
app.get('/api/ping', (c) => c.text('pong'));
app.route('/agents/translator', createAgentRouter(Translator));

export default app;
```

### 4. Author Durable Object migrations

For Flue 2.0.8, keep the ordered migration history in the authored project-root file:

```jsonc
// wrangler.jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [
    {
      "tag": "flue-class-FlueTranslatorAgent",
      "new_sqlite_classes": ["FlueTranslatorAgent"]
    }
  ]
}
```

An agent's durable identity determines its class and binding. `Translator` becomes
`FlueTranslatorAgent` and `FLUE_TRANSLATOR_AGENT`; `IssueTriage` becomes
`FlueIssueTriageAgent` and `FLUE_ISSUE_TRIAGE_AGENT`.

Every added agent requires three changes: its `'use agent'` export, its route mount when
HTTP-accessible, and a new uniquely tagged migration using `new_sqlite_classes`. Append
deployed migrations; never rewrite their history.

### 5. Configure local secrets

Create an uncommitted `.dev.vars` beside `wrangler.jsonc`:

```dotenv
ANTHROPIC_API_KEY="your-api-key"
```

Ignore local and generated files:

```text
.dev.vars*
.env*
.flue-vite/
.flue-vite.wrangler.jsonc
```

Use either `.dev.vars` or `.env`, not both. When `.dev.vars` exists, Cloudflare does not
load `.env` values into local Worker bindings.

### 6. Run in local workerd

```bash
bun run dev
```

```bash
curl -X POST 'http://localhost:5173/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello world"}'
curl 'http://localhost:5173/agents/translator/demo-1'
```

### 7. Build, validate, and deploy

```bash
bun run build
bunx wrangler deploy --dry-run
bunx wrangler secret put ANTHROPIC_API_KEY
bunx wrangler deploy
```

Run deployment commands from the project root without `--config`. The Cloudflare Vite
plugin writes deploy metadata into `dist/`, so Wrangler follows the built output and its
finalized generated config. `wrangler secret put` itself creates and deploys a new Worker
version; set it deliberately before the final code deploy.

### 8. Verify production

```bash
curl --fail 'https://my-flue-worker.<subdomain>.workers.dev/api/ping'
curl -X POST 'https://my-flue-worker.<subdomain>.workers.dev/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

## Environment and secrets

- Store local values in ignored `.dev.vars` or `.env` files.
- Store deployed API keys as Worker secrets, never plaintext Wrangler `vars`.
- In CI, `wrangler deploy --secrets-file <protected-path>` can upload protected secrets.
- `nodejs_compat` lets provider code access secrets through `process.env` where supported.
- Authenticate inbound HTTP before admission; original headers, cookies, query, and body
  are not reconstructed inside later durable processing.

## Persistence and files

Flue stores each generated agent instance's canonical conversation stream, attachments,
and submission queue in Durable Object SQLite. `db.ts` is Node-only and is a build error
on this target. Conversation durability does not make the default virtual sandbox's
in-memory files durable; use an owned storage or container-backed sandbox integration.

## Health, assets, and streaming

Workers do not need a container health check, but an application-owned ping route is useful
for probes. If the same Worker serves static assets, ensure API prefixes reach Hono:

```jsonc
{
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/agents/*", "/channels/*"]
  }
}
```

Clients should use the Flue SDK or reconnect to update streams using the returned
`streamUrl` and `offset`; accepted work is independent of the attached HTTP connection.

## Recommended patterns

- Keep `flue()` before `cloudflare(...)` and commit only authored Wrangler config.
- Pin durable identity with `agentName` before first deploy if function names may change.
- Append one migration tag per storage lifecycle change and review it before deploy.
- Use ordinary Hono middleware at the mount path for authentication and authorization.
- Start with a virtual sandbox; add Cloudflare Sandbox only for full Linux requirements.
- Enable Workers logs/traces and Flue observability deliberately, considering content.

## Avoid

- Do not use `flue run` to validate Worker-only imports or Cloudflare bindings.
- Do not add `db.ts`, legacy `new_classes`, or colliding `FLUE_*_AGENT` bindings.
- Do not edit `.flue-vite.wrangler.jsonc` or generated `.flue-vite/` files.
- Do not rename or delete a deployed agent without a storage lifecycle migration.
- Do not let static-asset SPA fallback intercept agent or channel routes.

## Gotchas

- Current Cloudflare docs also describe declarative `exports`, but `exports` and legacy
  `migrations` are mutually exclusive. Follow Flue 2.0.8's migration-based guide for this
  integration; do not combine both config shapes.
- Function rename changes Durable Object identity; file rename or route remount does not.
- Use `renamed_classes` to preserve data when changing a deployed Flue agent identity.
- Generated classes require SQLite and persisted format versions can block unsafe rollback.
- A missing migration can build successfully but fail when Cloudflare provisions classes.
- The compatibility date must be `2026-04-01` or newer, with `nodejs_compat` enabled.

## Related

- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Deploy overview](https://flueframework.com/docs/guide/deploy/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Models](https://flueframework.com/docs/guide/models/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
- [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
