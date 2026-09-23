---
title: Deploy Agents on Railway
source: https://flueframework.com/docs/ecosystem/deploy/railway/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://docs.railway.com/builds/railpack
  - https://railpack.com/languages/node
  - https://docs.railway.com/infrastructure-as-code
  - https://docs.railway.com/guides/variables
---

# Deploy Agents on Railway

## When to choose Railway

Choose Railway for a managed, long-running Flue Node web service with Git-based deploys,
injected `PORT`, service variables, and one-click Postgres. Do not use a cron or function
as the primary server: Flue holds sessions in an always-on process and serves streamed
conversation reads.

## Prerequisites

- A Git repository containing a Flue 2.0.8 Node application.
- `bun.lock` committed so Railpack selects Bun as the package manager.
- `package.json` build and start scripts.
- A `/health` route in `app.ts` if a Railway health check will be configured.
- Provider credentials ready for sealed Railway variables.
- A Railway account connected to the Git provider, or an authenticated Railway CLI.

## How to deploy

### 1. Define the build and runtime contract

```jsonc
// package.json (relevant fields)
{
  "type": "module",
  "scripts": {
    "build": "vite build",
    "start": "node dist/server.mjs"
  }
}
```

Railpack detects `package.json`, supports Bun through `bun.lock`, installs dependencies,
and keeps Node available for the production server. Flue externalizes dependencies, so
the runtime image must retain production `node_modules`.

### 2. Create the service from Git

1. In Railway, create a project and select **Deploy from GitHub repo**.
2. Select the repository and the correct root directory for a monorepo.
3. In service settings, set build command to `bun install --frozen-lockfile && bunx vite build`.
4. Set start command to `node dist/server.mjs`.
5. In **Networking**, generate a Railway domain.
6. Keep the service always-on; do not assign a cron schedule to the HTTP service.

Railway injects `PORT`; leave it unset so the generated server binds Railway's chosen
port on `0.0.0.0`.

### 3. Add variables and secrets

On the service's **Variables** tab add the provider variable expected by the configured
model, for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Seal sensitive variables so
their values cannot be read back through the dashboard or API. Add `MODEL_SPECIFIER` only
when application code reads it.

The production server reads only the environment present at process start. A committed
`.env` is neither required nor safe.

### 4. Add durable Postgres when required

Create a PostgreSQL service in the same project with **+ New > Database > PostgreSQL**.
On the Flue service, create a reference variable rather than copying credentials:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

Install the adapter and add the complete documented transaction runner as `src/db.ts`:

```bash
bun add @flue/postgres@2.0.8 pg
```

Commit and redeploy. Flue discovers `db.ts` during `vite build` and wires it into
`dist/server.mjs`.

### 5. Configure health checking

Define the application-owned route before enabling the platform check:

```ts
app.get('/health', (c) => c.text('ok'));
```

Set the service health-check path to `/health`. Without this route, Railway holds the new
deployment because the health gate never succeeds. Without a configured path, Railway
considers the deployment ready when the process binds `PORT`.

### 6. Deploy and verify

Git pushes trigger deployments for a connected repository. For a CLI-created project:

```bash
railway login
railway link
railway up
```

After the deployment is active:

```bash
curl --fail 'https://<railway-domain>/health'
curl -X POST 'https://<railway-domain>/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

## Current infrastructure-as-code path

Railway deprecated per-service `railway.json` and `railway.toml`. New services cannot opt
in, existing files stop being read on December 1, 2026, and `.railway/railway.ts` is the
replacement. For an existing project, import rather than guessing resource configuration:

```bash
bun add -d railway
railway login
railway link
railway config pull
railway config plan
railway config apply
```

The imported TypeScript preserves existing values instead of writing secrets into source.
Review plans carefully: omitting an IaC-owned resource can mean deletion. A service cannot
be managed by old Config as Code and new IaC simultaneously.

## Environment and secrets

- Railway supplies `PORT`; manually fixing it can break proxy routing.
- Provider keys and `DATABASE_URL` belong in sealed variables or service references.
- `MODEL_SPECIFIER` is optional application configuration, not a Flue platform default.
- Variable changes cause a new deployment; verify health and stream reconnection.
- Do not expose a sealed value to an agent's `local()` sandbox unless explicitly needed.

## Persistence

Default Node production state is process-local and is lost on every restart and deploy.
Use Railway Postgres plus `db.ts` for canonical streams, immutable attachments, and
submission recovery. Shared Postgres supports replacement but does not allow two replicas
to own the same agent instance concurrently.

## Health and streaming

Flue creates no health endpoint. Keep `/health` cheap and independent of model calls.
Conversations use long-lived `GET` reads; attached connections can be replaced, so retain
the admission's `streamUrl` and `offset` and resume rather than relying on one request.

## Recommended patterns

- Commit `bun.lock` and explicit build/start scripts.
- Use service-reference syntax for Railway Postgres credentials.
- Seal model-provider keys and rotate them through Railway variables.
- Start with one replica and add persistence before any rolling or horizontal scaling.
- Use current Railway IaC for reproducible projects, with plan review before apply.

## Avoid

- Do not deploy the primary Flue server as a Railway cron job or scale-to-zero function.
- Do not commit `.env`, copy a database URL, or put secrets into IaC source.
- Do not rely on `railway.json`/`railway.toml` for a new service.
- Do not configure `/health` until the route exists.
- Do not assume shared Postgres makes active-active same-instance execution safe.

## Gotchas

- Railway Config as Code has a hard cutoff on December 1, 2026; migrate legacy files.
- A root Vite app can look like a static SPA to generic detection; set the Node start command.
- The build output alone is insufficient because Flue externalizes dependencies.
- Sealed variables cannot be unsealed; replace their values instead.
- Railway cron schedules are UTC, skip overlapping runs, and are not the HTTP service.
- Rolling overlap can create competing owners unless traffic affinity and draining are planned.

## Related

- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)
- [Schedules](https://flueframework.com/docs/guide/schedules/)
- [Railway IaC](https://docs.railway.com/infrastructure-as-code)
