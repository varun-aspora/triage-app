---
title: Cloudflare Computer Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-computer/
provider_docs: https://github.com/cloudflare/computer
nav_section: ecosystem
flue_version: 2.0.8
---

# Cloudflare Computer

The Cloudflare Computer adapter places a durable `@cloudflare/computer` `Workspace`
inside each agent Durable Object. Its default Flue blueprint executes commands with
just-bash in a Dynamic Worker, directly against the SQLite-backed virtual filesystem.

`@cloudflare/computer` is preview-only and explicitly not production-ready.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| Durable files in the agent's own Durable Object, no container | Cloudflare Computer |
| Full Linux, native binaries, package managers, or writable bucket mounts | Cloudflare Sandbox |
| Production-stable remote Linux while keeping a Node deployment | E2B, Daytona, Modal, Vercel Sandbox, boxd, exe.dev, or islo |
| Temporary in-memory shell work | Flue's `bash()` virtual sandbox |

Choose Computer for experiments where filesystem durability matters more than a real
Linux userland. Its worker-shell backend understands common shell operations, but it
does not spawn native programs.

## Prerequisites and environment

- A Flue application targeting Cloudflare Workers and Durable Objects.
- `@cloudflare/computer` plus `@platformatic/vfs` when the generated git client remains.
- Worker Loader beta access on the Cloudflare account.
- `"experimental"` and `"nodejs_compat"` compatibility flags.
- A Worker Loader binding named `LOADER` (or consistently renamed in code/config).
- No provider API key; access comes through Cloudflare bindings.

Required Wrangler shape:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox cloudflare-computer
   ```

2. Review `<source-root>/sandboxes/cloudflare-computer.ts`; the current marker is
   `flue-blueprint: sandbox/cloudflare-computer@1`.
3. Add the Worker Loader binding and compatibility flags to `wrangler.jsonc`.
4. Re-export the workspace service from `<source-root>/cloudflare.ts`:

   ```ts
   export { WorkspaceServiceProxy } from '@cloudflare/computer';
   ```

5. Re-export `workspaceHost` from every agent module that uses this sandbox.
6. Pass `env.LOADER` to `getComputerSandbox(...)`.
7. Verify both file operations and a `bash` call; missing loopback wiring often appears
   only on the first command.

## Exact `useSandbox` integration

```ts
'use agent';
import { env } from 'cloudflare:workers';
import { useModel, useSandbox } from '@flue/runtime';
import { getComputerSandbox } from '../sandboxes/cloudflare-computer';

export { workspaceHost as cloudflare } from '../sandboxes/cloudflare-computer';

interface Env {
  LOADER: WorkerLoader;
}

export function Assistant() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
  const { LOADER } = env as unknown as Env;
  useSandbox(getComputerSandbox({ loader: LOADER }));
  return 'Explore and edit the durable workspace with standard file and shell tools.';
}
```

The generated adapter also exports `getComputerWorkspace(...)` for application-owned
hydration and `computerWorkspace(harness.sandbox)` for runtime-checked access to the
native `Workspace` surface.

## Lifecycle

- Each agent Durable Object id owns one authoritative Workspace in that object's SQLite
  storage.
- `useSandbox()` resolves `getComputerSandbox()` once per initialized harness.
- The adapter creates `/workspace` recursively, then exposes normal Flue `Sandbox`
  methods plus the native `workspace` property.
- A Dynamic Worker is created lazily for worker-shell execution. The durable files do
  not live in that worker.
- Durable Object eviction or restart reconstructs the `Workspace` against the same
  SQLite storage, so files survive.
- Flue provides no teardown callback. Workspace lifetime follows the Durable Object and
  application retention, not an agent render.
- Conversation records and workspace files remain independent durability domains.

## Recommended patterns

- Use `workspace.git` or `workspace.fs` outside the model turn to seed known inputs.
- Add read-only R2 mounts through the adapter's `workspace(defaults)` reshape hook when
  remote data should be visible but not mutable.
- Keep the default `/workspace` root and place `AGENTS.md` or workspace skills there.
- Use `computerWorkspace(harness.sandbox)` only when generic `Sandbox` verbs are
  insufficient.
- Set explicit command/output limits for workloads that may traverse large durable
  trees.
- Treat schema/package upgrades cautiously because the provider API is preview and
  unstable.

## Avoid

- Do not deploy this preview integration as a production isolation boundary.
- Do not expect `npm`, Python, native binaries, or arbitrary Linux utilities from the
  worker-shell backend.
- Do not omit either the `WorkspaceServiceProxy` or `workspaceHost` re-export.
- Do not share one Durable Object id across unrelated tenants.
- Do not use `useSandbox(factory, { cwd })` if code needs the sandbox's native
  `workspace` property; Flue's cwd scoping wrapper drops adapter-specific properties.
- Do not confuse durable files with durable running processes.

## Gotchas, security, cost, and persistence

- The workspace shares Durable Object SQLite storage and is capped around 10 GB by the
  documented integration.
- The shell is JavaScript emulation in a Dynamic Worker, not a Linux VM or container.
- The `experimental` compatibility flag and Worker Loader are beta-gated platform
  features.
- The full standard Flue tool set is present because adapter `exec()` works, but command
  compatibility is bounded by just-bash.
- Stored files persist across Durable Object restarts; in-memory handles and running
  Dynamic Worker commands do not.
- The preview package can change APIs or on-disk behavior. Pin versions and test upgrades
  against a disposable Durable Object namespace.
- Durable Object storage, requests, and Worker execution have Cloudflare billing and
  quota implications even though there is no container charge.
- Mounted resource credentials remain application-owned; grant the narrowest access and
  prefer read-only mounts.

## Related

- [Flue Cloudflare Computer ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-computer/)
- [Cloudflare Computer repository](https://github.com/cloudflare/computer)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Deploy Flue on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
- [Flue Cloudflare Sandbox ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
