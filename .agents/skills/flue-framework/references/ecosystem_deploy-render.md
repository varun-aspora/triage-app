---
title: Deploy Agents on Render
source: https://flueframework.com/docs/ecosystem/deploy/render/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://render.com/docs/blueprint-spec
  - https://render.com/docs/free
  - https://render.com/docs/postgresql-creating-connecting
  - https://render.com/docs/health-checks
---

# Deploy Agents on Render

## When to choose Render

Choose Render for a Git-backed, long-running Flue web service with Blueprint-managed
infrastructure and managed Postgres. Flue's Node target is an HTTP server, not a Render
function. A paid always-on service avoids cold starts; free services are suitable only for
evaluation because they can spin down and lose in-memory state.

## Prerequisites

- A working Flue 2.0.8 Node application and committed `bun.lock`.
- The Bun/Node multi-stage Dockerfile from the Docker deployment reference.
- A `/health` route in `app.ts`.
- A Git repository connected to Render.
- Provider credentials ready to enter in the Render dashboard.
- A paid Render Postgres plan for state that must be retained.

## How to deploy

### 1. Build and verify the image locally

```bash
docker build --pull -t flue-agents:2.0.8 .
docker run --rm --init -p 8080:8080 \
  -e ANTHROPIC_API_KEY \
  flue-agents:2.0.8
curl --fail http://localhost:8080/health
```

The Dockerfile uses Bun to install/build, keeps production `node_modules`, and starts the
generated Node target with `node dist/server.mjs`. Render injects `PORT` at runtime, which
overrides the image default.

### 2. Add a Blueprint

```yaml
# render.yaml
databases:
  - name: flue-db
    plan: basic-256mb

services:
  - type: web
    name: flue-agents
    runtime: docker
    plan: free
    autoDeployTrigger: commit
    healthCheckPath: /health
    maxShutdownDelaySeconds: 60
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: flue-db
          property: connectionString
      - key: MODEL_SPECIFIER
        value: anthropic/claude-sonnet-4-6
      - key: ANTHROPIC_API_KEY
        sync: false
```

`runtime: docker` uses the root `Dockerfile`. For another location, set
`dockerfilePath` and, when needed, `dockerContext` exactly as documented by the Blueprint
schema. `autoDeployTrigger: commit` is the current field; `autoDeploy` is deprecated.

### 3. Add the Postgres adapter

```bash
bun add @flue/postgres@2.0.8 pg
```

Add the complete documented adapter as `src/db.ts`, reading `process.env.DATABASE_URL`.
The transaction implementation must use one checked-out client for `BEGIN`, callback
queries, `COMMIT`/`ROLLBACK`, and release. Commit it before the first durable deployment.

### 4. Create the Blueprint deployment

1. Push `render.yaml`, `Dockerfile`, `bun.lock`, source, and package manifests.
2. In Render choose **New > Blueprint** and connect the repository.
3. Review the service and database changes.
4. Enter the `sync: false` provider secret when prompted.
5. Apply the Blueprint and wait for the `/health` gate to pass.

Optional CLI validation uses Render's platform command:

```bash
render blueprints validate render.yaml
```

### 5. Verify production

```bash
curl --fail 'https://flue-agents.onrender.com/health'
curl -X POST 'https://flue-agents.onrender.com/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

Use the actual generated Render hostname or custom domain.

## Native Node alternative

The Flue 2.0.8 Render guide also supports Render's native Node runtime with build command
`npm ci && npx vite build` and start command `node dist/server.mjs`. Prefer the Docker
Blueprint above when Bun is the project's package manager so the build environment and
lockfile behavior are explicit. The runtime contract is identical either way.

## Environment and secrets

- `sync: false` prompts for a value on initial Blueprint creation and keeps it out of Git.
- Existing `sync: false` values are ignored by later Blueprint syncs; rotate in Dashboard.
- Non-secret values may use `value`; never put provider keys there.
- `fromDatabase.connectionString` supplies the internal connection URL for same-region use.
- The built server reads process environment only and does not load `.env`.

## Persistence

Without `db.ts`, deploys, restarts, and free-service spin-down lose conversations,
attachments, and submissions. The Blueprint's `DATABASE_URL` plus Flue Postgres adapter
provides replacement recovery. A `free` Render Postgres database expires after 30 days;
the example uses a paid `basic-256mb` database for retained data.

Shared Postgres does not enable active-active ownership. Keep one web-service instance
until instance-affine routing and non-overlapping ownership are designed.

## Health, shutdown, and streaming

Flue adds no `/health` route. If `healthCheckPath` points to a missing or protected route,
Render does not shift traffic to the new deploy. Keep health checks cheap and return `2xx`.

Conversation `GET` reads can remain open for long-poll/SSE. Render can replace an instance
and close them, so clients retain `streamUrl` and `offset`. `maxShutdownDelaySeconds`
controls the grace after `SIGTERM`; Render's documented default is 30 seconds and maximum
is 300 seconds.

## Recommended patterns

- Use a Docker Blueprint for Bun-locked, repeatable builds.
- Use a paid always-on web plan and paid Postgres for production.
- Keep web service and Postgres in the same region and use the internal URL.
- Validate the Blueprint before applying and review database changes carefully.
- Test stream reconnection and graceful shutdown during a deployment.

## Avoid

- Do not use a static site, function, cron, or background worker as the public Flue server.
- Do not commit provider keys or database connection strings into `render.yaml`.
- Do not enable `healthCheckPath` before adding the route.
- Do not use a free web service when always-on sessions or predictable latency matter.
- Do not use an attached disk as a substitute for shared conversation persistence.

## Gotchas

- Free web services spin down after 15 minutes without inbound traffic and cold-start later.
- Free spin-down/redeploy destroys default in-memory state even with stable conversation IDs.
- `sync: false` does not update an existing secret during Blueprint sync.
- `autoDeployTrigger` replaces the deprecated `autoDeploy` field.
- `PORT` is injected by Render; hard-coded port assumptions break proxy health.
- Multiple instances need shared storage and instance-affine ownership, not only Postgres.

## Related

- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
- [Render Blueprint schema](https://render.com/schema/render.yaml.json)
