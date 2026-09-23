---
title: Cloudflare Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/
provider_docs: https://developers.cloudflare.com/sandbox/
nav_section: ecosystem
flue_version: 2.0.8
---

# Cloudflare Sandbox

Cloudflare Sandbox runs agent file and shell operations in a full Linux container
backed by Cloudflare Containers. It is a platform-native Cloudflare integration, not a
drop-in adapter for a Node-target Flue application.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| Full Linux, package managers, native binaries, or custom images on Workers | Cloudflare Sandbox |
| Durable SQLite-backed files and a JavaScript shell without a container | Cloudflare Computer |
| Keep a Flue Node deployment and call a remote provider | E2B, Daytona, Modal, Vercel Sandbox, boxd, exe.dev, or islo |
| A mounted virtual filesystem over cloud resources, not arbitrary code execution | Mirage |
| Lightweight scratch files and allowlisted HTTP only | Flue's `bash()` virtual sandbox |
| Host filesystem access on a trusted Node server | `local()` |

Choose it when the Flue app already targets Cloudflare and Linux tooling is required.
Migrating a Node app solely for this integration is a platform migration, not a sandbox
configuration change.

## Prerequisites and environment

- A Flue project targeting Cloudflare Workers.
- A Workers Paid plan; Containers are a paid-plan feature.
- `@cloudflare/sandbox` and a matching `cloudflare/sandbox:<version>` image.
- A Sandbox Durable Object binding, migration entry, and container declaration in
  `wrangler.jsonc`.
- Docker running for local `vite dev`; deployed Workers do not need local Docker.
- No provider API key is passed to `useSandbox`; the Worker uses platform bindings.
- Wrangler authentication for development and deployment.

## How to

1. If the project is Node-targeted, confirm the complete Cloudflare migration before
   changing files. Otherwise add the blueprint:

   ```bash
   bunx flue add sandbox cloudflare
   ```

2. Let the blueprint inspect the project. It is an implementation guide and may update
   dependencies, `cloudflare.ts`, `wrangler.jsonc`, the `Dockerfile`, and an agent.
3. Export the provider Durable Object from the Flue source root:

   ```ts
   export { Sandbox } from '@cloudflare/sandbox';
   ```

4. Add a new, unique migration entry; never replace deployed migration history.
5. Pin the Docker image tag to the exact installed package version.
6. Bind the same class and binding names used by `getSandbox(...)`.
7. Run local development with Docker available, then verify a deployed preview.

## Exact `useSandbox` integration

The installed Flue 2.0.8 ecosystem page documents this agent-level form:

```ts
'use agent';
import { env } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

interface Env {
  Sandbox: DurableObjectNamespace;
}

export function Assistant({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  const { Sandbox } = env as unknown as Env;
  useSandbox(cloudflareSandbox(getSandbox(Sandbox, id)), { cwd: '/workspace' });
  return 'Use the isolated Linux workspace for code and command execution.';
}
```

`cloudflareSandbox()` already ships in `@flue/runtime/cloudflare`; do not generate a
project-owned `sandboxes/cloudflare.ts` adapter.

## Lifecycle

- `getSandbox(binding, id)` selects the provider Durable Object by stable sandbox id.
- The provider creates its container on the first operation.
- Flue resolves the `SandboxFactory` once per initialized harness; re-renders do not
  create another Flue sandbox.
- The container retains files and processes only while active. Stable-provider docs say
  that after the default idle sleep, the next request starts a clean container.
- Explicit `sandbox.destroy()` permanently removes files, processes, and state, but Flue
  does not invoke it because `SandboxFactory` has no teardown method.
- Mount persistent object storage or rehydrate required files if state must survive a
  container sleep or replacement.
- Provider and conversation durability remain independent: a Durable Object conversation
  can survive while its container filesystem resets.

## Recommended patterns

- Key interactive sandboxes on `AgentProps.id`; key one-off tasks on a deliberate unique
  task id and destroy them from application-owned cleanup.
- Bake toolchains into the image instead of installing them on every cold container.
- Keep `@cloudflare/sandbox` and the Docker base image on the same release line.
- Set a narrow network policy and broker credentials in Worker code where possible.
- Mount R2 or another supported object store for artifacts that must outlive the active
  container.
- Enable the provider's RPC transport for high-frequency SDK operations when Worker
  subrequest limits become material.
- Bound `cwd` to the intended workspace rather than exposing the whole container root.

## Avoid

- Do not use this integration from a Node process or non-Worker edge runtime.
- Do not silently migrate an existing Node-target project.
- Do not invent `account_id`, API tokens, bindings, or migration tags.
- Do not overwrite old Durable Object migrations.
- Do not assume a stable sandbox id makes local container disk durable.
- Do not set `keepAlive` without explicit cleanup and cost controls.
- Do not expose control-plane credentials to model-directed shell commands.

## Gotchas, security, cost, and persistence

- Cloudflare requires a Workers Paid plan and bills the Worker, Durable Object, Container
  resources, optional logs, and network usage separately.
- The default active-container idle period in current provider docs is 10 minutes. A
  sleeping stable SDK container loses its filesystem and process state.
- `keepAlive: true` prevents normal idle sleep and therefore needs explicit lifecycle and
  spend management.
- Each SDK operation normally counts as a Worker subrequest; paid Workers have a finite
  per-request budget. RPC transport multiplexes operations over one connection.
- Cloudflare's direct delete API lacks Node-style recursive/force flags. Flue's wrapper
  uses in-container `rm` when needed to preserve `Sandbox.rm` semantics.
- The blueprint says platform bindings may need to be captured where request/DO scope is
  available, while the ecosystem page shows `cloudflare:workers` `env` in the agent body.
  Treat this as a Flue 2.0.8 documentation discrepancy: follow the generated blueprint
  for the actual project and verify against installed types/build output.
- A custom image controls what commands and binaries exist; the adapter cannot add tools
  the image does not contain.

## Related

- [Flue Cloudflare Sandbox ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
- [Deploy Flue on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)
- [Cloudflare Sandbox pricing](https://developers.cloudflare.com/sandbox/platform/pricing/)
- [Cloudflare Sandbox limits](https://developers.cloudflare.com/sandbox/platform/limits/)
- [Flue Cloudflare Computer ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-computer/)
- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [Flue Daytona ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
