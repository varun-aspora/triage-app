---
title: Deploy Agents on Fly.io
source: https://flueframework.com/docs/ecosystem/deploy/fly/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://fly.io/docs/launch/deploy/
  - https://fly.io/docs/reference/configuration/
  - https://fly.io/docs/apps/secrets/
  - https://fly.io/docs/mpg/create-and-connect/
---

# Deploy Agents on Fly.io

## When to choose Fly.io

Choose Fly.io for the Dockerized Flue Node target on long-running Machines, especially
when regional placement and a small operational surface are useful. Flue is not a
request-scoped function: at least one Machine should stay running to own sessions and
serve long-poll/SSE reads.

## Prerequisites

- `flyctl` installed and authenticated with `fly auth login`.
- A working Flue 2.0.8 Dockerfile at the project root.
- A `/health` route in `app.ts`.
- An available Fly app name and selected primary region.
- Provider credentials ready for `fly secrets set`.
- Fly Managed Postgres if state must survive restart or replacement.

## How to deploy

### 1. Build and verify the container locally

```bash
docker build --pull -t flue-agents:2.0.8 .
docker run --rm --init -p 8080:8080 \
  -e ANTHROPIC_API_KEY \
  flue-agents:2.0.8
curl --fail http://localhost:8080/health
```

The image must build `dist/server.mjs`, retain production dependencies, set `PORT=8080`,
and start `node dist/server.mjs`.

### 2. Create the Fly app

```bash
fly launch
```

Select the organization, app name, and primary region. Review the generated `fly.toml`
before deploying. The required Flue service settings are:

```toml
app = "my-flue-agents"
primary_region = "iad"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

`internal_port` must equal the image's `PORT` and exposed port. Keep auto-stop disabled
and at least one Machine running for the process-owned runtime.

### 3. Add provider secrets

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set MODEL_SPECIFIER=anthropic/claude-sonnet-4-6
fly secrets list
```

Use the provider's expected variable name. `MODEL_SPECIFIER` is optional and only matters
if application code reads it. Setting a secret updates/restarts Machines and resets their
ephemeral filesystem; use `--stage` only when a later deploy will activate the value.

### 4. Add durable Postgres when required

```bash
fly mpg create
fly mpg attach <cluster-id> -a my-flue-agents
bun add @flue/postgres@2.0.8 pg
```

`fly mpg attach` sets the pooled `DATABASE_URL` secret on the app and restarts it. Add the
complete Postgres adapter as `src/db.ts`; Flue discovers it at build time. Build and deploy
only after `db.ts` and its dependencies are committed.

### 5. Deploy

```bash
fly deploy
```

Fly builds the root Dockerfile and creates or updates Machines. The deploy output reports
the public hostname. Confirm allocation, checks, and logs:

```bash
fly status
fly checks list
fly logs
```

### 6. Verify production

```bash
curl --fail 'https://my-flue-agents.fly.dev/health'
curl -X POST 'https://my-flue-agents.fly.dev/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

## Environment and secrets

- The built server reads start-time environment only; it does not load `.env`.
- Fly secrets are encrypted and injected as environment variables into every Machine.
- Anyone able to deploy code can deploy code that reads those environment variables.
- Updating a secret restarts Machines unless staged, so plan for stream reconnection.
- Keep non-sensitive settings in `[env]`; keep keys and `DATABASE_URL` in Fly secrets.

## Persistence

Default Node production state is process-local and is lost on restart, secret update, or
deploy. Use Fly Managed Postgres and the Flue Postgres adapter for conversation,
attachment, and submission recovery. Do not use a Fly Volume as a shared conversation
database across Machines. Shared Postgres still requires one live owner per agent instance.

## Health and streaming

Flue does not generate `/health`. Fly HTTP checks expect success and do not follow
redirects. With `force_https = true`, ensure the internal health request does not get
redirected; use the Fly-documented HTTPS check or forwarded-protocol header configuration
if your middleware forces redirects.

Long-lived conversation reads require a running Machine. Retain `streamUrl` and `offset`
and reconnect after deploys or Machine movement instead of assuming one connection lasts
for the whole agent run.

## Recommended patterns

- Keep `auto_stop_machines = "off"` and `min_machines_running = 1` initially.
- Put `fly.toml` and the Dockerfile under version control.
- Stage secret rotation, then activate it with a planned `fly deploy` when appropriate.
- Attach Managed Postgres before enabling additional Machines.
- Scale CPU/RAM based on model orchestration and sandbox workload, not request count alone.

## Avoid

- Do not set `min_machines_running = 0` for a production Flue HTTP service.
- Do not depend on the Machine's ephemeral filesystem for conversations or workspace data.
- Do not expose provider credentials as ordinary committed `[env]` values.
- Do not add Machines without shared persistence and instance-affine ownership.
- Do not run a scheduled Machine with `flue run` when it should call the deployed endpoint.

## Gotchas

- `fly launch` generates configuration; `fly deploy` builds and releases the image.
- Secret changes restart Machines and erase ephemeral filesystem changes.
- Health checks can fail because HTTPS middleware redirects the internal HTTP check.
- The old unmanaged `fly postgres` product differs from Fly Managed Postgres (`fly mpg`).
- More Machines do not by themselves make same-instance processing active-active safe.
- Port mismatch among `PORT`, `EXPOSE`, and `internal_port` makes the app unreachable.

## Related

- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Database](https://flueframework.com/docs/guide/database/)
- [Schedules](https://flueframework.com/docs/guide/schedules/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
