---
title: Deploy Agents on Node.js
source: https://flueframework.com/docs/ecosystem/deploy/node/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://nodejs.org/en/learn/getting-started/nodejs-the-difference-between-development-and-production
---

# Deploy Agents on Node.js

## When to choose Node.js

Choose the Node target for a long-running HTTP service on a VM, container, or managed
host. It is the right target when the agent needs ordinary Node libraries, a host-local
sandbox, or infrastructure that is not available in Cloudflare Workers.

Do not confuse this deployment with `flue run`. A deployed Node app builds and starts an
HTTP server with all routes mounted by `app.ts`; `flue run` executes one agent module once,
without a build, listener, port, or HTTP persistence boundary.

## Prerequisites

- Node.js 22 on the production host.
- Bun for dependency installation and Vite/Flue commands.
- Flue packages pinned to `2.0.8` and a committed `bun.lock`.
- A model provider key, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- Postgres and a `db.ts` adapter if conversations must survive process replacement.
- A trusted isolation boundary if an agent uses `local()`; it directly reaches the host.

## How to build and run

### 1. Create the application

```bash
mkdir my-flue-server
cd my-flue-server
bun init -y
bun add @flue/runtime@2.0.8 hono valibot
bun add -d @flue/vite@2.0.8 @flue/cli@2.0.8 vite
```

```ts
// vite.config.ts
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

```jsonc
// package.json (relevant fields)
{
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "start": "node dist/server.mjs"
  }
}
```

### 2. Define and mount an agent

```ts
// src/agents/translator.ts
'use agent';
import { useModel } from '@flue/runtime';

export function Translator() {
  useModel('openai/gpt-5.5');
  return 'Translate the user message. Reply with the translation only.';
}
```

```ts
// src/app.ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Translator } from './agents/translator.ts';

const app = new Hono();
app.get('/health', (c) => c.text('ok'));
app.route('/agents/translator', createAgentRouter(Translator));

export default app;
```

`app.ts` is required. Every exported, capitalized function in a scanned `'use agent'`
module is registered, but it is reachable over HTTP only when explicitly mounted.

### 3. Develop and test locally

Put the provider key in an uncommitted project-root `.env`, then run:

```bash
bun run dev
```

Vite dev loads `.env`; shell-exported values win. Send and read a conversation:

```bash
curl -X POST 'http://localhost:5173/agents/translator/demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"user","body":"Translate to French: Hello world"}'
curl 'http://localhost:5173/agents/translator/demo-1'
```

For a transport-free check of only the module, use:

```bash
bunx flue run src/agents/translator.ts --message 'Translate to French: Hello world'
```

That command is not a test of routing, production startup, ports, or deployed storage.

### 4. Build the production artifact

```bash
bun install --frozen-lockfile
bun run build
```

Vite emits the self-starting server at `dist/server.mjs` and its imported application
chunk at `dist/app.mjs`. Application dependencies are externalized, so deploy `dist/`,
`package.json`, `bun.lock`, and production `node_modules`; do not ship `dist/` alone.

Verify production behavior before release:

```bash
set -a; source .env; set +a
bun run preview
```

### 5. Start the deployed HTTP service

The built server does not load `.env`. Supply its environment through the host and keep
the process supervised:

```bash
NODE_ENV=production PORT=8080 node dist/server.mjs
```

Example systemd unit:

```ini
[Unit]
After=network.target

[Service]
WorkingDirectory=/opt/flue-agents
ExecStart=/usr/bin/node dist/server.mjs
Environment=NODE_ENV=production
Environment=PORT=8080
EnvironmentFile=/etc/flue-agents.env
Restart=always

[Install]
WantedBy=multi-user.target
```

Install production dependencies and enable the service using the host's normal release
procedure. Restrict `/etc/flue-agents.env` to the service account and mode `600`.

## Environment and secrets

- `PORT` controls the listener; the default is `3000`.
- `NODE_ENV=production` is recommended for libraries that switch behavior on it.
- Provider keys use the provider's standard variable name.
- `MODEL_SPECIFIER` is optional and matters only if application code reads it.
- `DATABASE_URL` belongs in the host secret manager or protected environment file.
- `local()` inherits only shell essentials by default. Pass each allowed secret explicitly
  through `local({ env: { GH_TOKEN: process.env.GH_TOKEN } })`.

## Persistence

The built Node server uses in-memory SQLite by default. Canonical conversations,
attachments, and accepted submissions survive only for that process lifetime. Add
`src/db.ts` and a Flue persistence adapter for restart and replacement recovery:

```bash
bun add @flue/postgres@2.0.8 pg
```

The adapter must use one checked-out Postgres client for each transaction; follow the
complete Postgres ecosystem reference rather than implementing a partial transaction
runner. Shared Postgres supports replacement recovery, but it does not make concurrent
owners of the same agent instance safe.

## Health and streaming

Flue creates no health or operator routes. Define `/health` in `app.ts`, keep it cheap,
and protect any diagnostic endpoint separately. Agent `GET` reads can be long-lived
long-poll or SSE connections. Proxies must allow suitable idle timeouts, and clients
should retain the admission's `streamUrl` and `offset` so they can reconnect.

## Recommended patterns

- Build once, verify with `vite preview`, and promote the same artifact.
- Run one always-on supervised process before adding replicas.
- Put durable state in Postgres before enabling replacement or horizontal scaling.
- Authenticate with Hono middleware before the `createAgentRouter(...)` mount.
- Use remote sandboxes for multi-tenant sessions; use `local()` only on trusted hosts.

## Avoid

- Do not deploy the Node target as a short-lived function or scale-to-zero invocation.
- Do not assume `.env` is read by `dist/server.mjs`.
- Do not expose the server directly without TLS termination and authentication.
- Do not round-robin one agent instance across simultaneous Node owners.
- Do not treat the virtual or local sandbox filesystem as conversation persistence.

## Gotchas

- Renaming an agent function changes durable identity unless `agentName` pins it.
- A production build still needs runtime `node_modules` because dependencies are external.
- A restart loses default in-memory state even if the process uses a stable conversation id.
- `vite dev` uses a local disk-backed development database; production defaults differ.
- The Node server serves plain HTTP. Terminate TLS in a reverse proxy or load balancer.

## Related

- [Deploy overview](https://flueframework.com/docs/guide/deploy/)
- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
- [Database](https://flueframework.com/docs/guide/database/)
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
