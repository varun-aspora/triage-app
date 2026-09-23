---
title: Deploy Agents with Docker
source: https://flueframework.com/docs/ecosystem/deploy/docker/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://docs.docker.com/build/building/multi-stage/
  - https://docs.docker.com/engine/reference/run/#specify-an-init-process
  - https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
---

# Deploy Agents with Docker

## When to choose Docker

Choose Docker when the destination accepts OCI images and you want one portable build
for ECS, Fly.io, Railway, Render, SST, or a self-managed host. This packages Flue's Node
target as a single deployable container image, built once and run unmodified everywhere.

Do not use this image as a one-shot CI agent. CI normally runs `bunx flue run <module>`
directly and never starts `dist/server.mjs`.

## Prerequisites

- A working Flue 2.0.8 Node application with `vite.config.ts` and `src/app.ts`.
- Docker with BuildKit and a committed `bun.lock`.
- Production dependencies correctly classified under `dependencies`.
- A model-provider secret available only at container start.
- A persistence adapter and database if state must outlive the container.

## How to build and run

### 1. Add the production Dockerfile

This uses Bun for deterministic installs and Vite compilation, then runs the generated
Node target on the supported Node 22 runtime:

```dockerfile
# syntax=docker/dockerfile:1

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx vite build

FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
```

The stages intentionally retain production `node_modules`: Flue externalizes application
dependencies instead of bundling them into `dist/server.mjs`.

### 2. Exclude local and secret material

```text
# .dockerignore
node_modules
dist
.git
.env
.env.*
.dev.vars*
```

Do not exclude `bun.lock`; it is required by both install stages.

### 3. Build the image

```bash
docker build --pull -t flue-agents:2.0.8 .
```

### 4. Run it locally

```bash
docker run --rm --init \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY \
  -e MODEL_SPECIFIER=anthropic/claude-sonnet-4-6 \
  flue-agents:2.0.8
```

Export `ANTHROPIC_API_KEY` in the invoking shell first. `-e ANTHROPIC_API_KEY` forwards
the value without embedding it in shell history. Use the corresponding provider variable
for another model provider.

### 5. Verify the running HTTP application

```bash
curl --fail http://localhost:8080/health
curl -X POST 'http://localhost:8080/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello"}'
```

The first command requires an application-owned `/health` route. Flue does not create it.

### 6. Tag and publish

Use the exact registry login flow for the destination, then tag an immutable release:

```bash
docker tag flue-agents:2.0.8 registry.example.com/team/flue-agents:2.0.8
docker push registry.example.com/team/flue-agents:2.0.8
```

Deploy the immutable tag or digest, configure port `8080`, inject runtime secrets, and
keep at least one replica running.

## Environment and secrets

- The built server reads only the environment passed when the container starts.
- `PORT` defaults to `3000`; this image sets and exposes `8080`.
- Provider keys and `DATABASE_URL` must come from the orchestrator's secret store.
- `MODEL_SPECIFIER` is optional and only applies when application code reads it.
- Do not use Docker `ARG` or image-layer `ENV` for secrets.
- For local-only testing, `--env-file` injects values into the process; it does not make
  Flue load `.env`, and that file must remain uncommitted.

## Persistence

Without `db.ts`, canonical conversations, attachments, and submissions are process-local
and disappear with the container. Install and configure a documented Flue persistence
adapter before relying on restarts or replacement:

```bash
bun add @flue/postgres@2.0.8 pg
```

Supply `DATABASE_URL` at runtime. Do not solve conversation durability by writing the
default database or sandbox to the container filesystem; container filesystems are
ephemeral, and shared storage still does not permit active-active ownership of one agent
instance.

## Health, lifecycle, and streaming

Define a cheap `GET /health` route in `app.ts`, then point the orchestrator at the same
container port. Run with `--init` locally or an init process in production so PID 1 reaps
children and forwards `SIGTERM`. Allow enough shutdown grace for active work.

Conversation reads use long-poll/SSE. Raise proxy idle timeouts where needed and retain
`streamUrl` plus `offset` after admission so the client can reconnect after replacement.

## Recommended patterns

- Pin the Flue packages, lockfile, base-image version, and deployed image digest.
- Build in one stage and install only production dependencies in the runtime image.
- Run as the non-root `node` user and use exec-form `CMD`.
- Add Postgres before enabling replacement, rolling deploys, or multiple replicas.
- Scan the final image and rebuild regularly for base-image security fixes.

## Avoid

- Do not copy `.env`, credentials, or the Docker socket into the image.
- Do not deploy as a request-scoped function or scale the only replica to zero.
- Do not copy only `dist/`; externalized dependencies are required at runtime.
- Do not rely on the writable image layer for durable conversations or sandbox files.
- Do not round-robin the same agent instance between concurrent containers.

## Gotchas

- `EXPOSE` documents a port; it does not publish it. Use `-p` or service port mapping.
- The orchestrator port, `PORT`, health check, and load-balancer target must all agree.
- `docker stop` only helps if signals reach the Node process; use an init and grace period.
- Native dependencies must be installed for the runtime image's OS and architecture.
- A healthy process is not proof that model credentials or the database are valid.

## Related

- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [AWS](https://flueframework.com/docs/ecosystem/deploy/aws/)
- [Fly.io](https://flueframework.com/docs/ecosystem/deploy/fly/)
- [Database](https://flueframework.com/docs/guide/database/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
