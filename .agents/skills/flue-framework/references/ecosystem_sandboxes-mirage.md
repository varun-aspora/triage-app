---
title: Mirage Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/mirage/
provider_docs: https://docs.mirage.strukto.ai/
nav_section: ecosystem
flue_version: 2.0.8
---

# Mirage

The Mirage adapter adapts an application-owned Mirage `Workspace` into Flue's sandbox interface.
Mirage is **not** a VM or container sandbox: it is a self-hosted library that mounts external
resources (S3, Postgres, Slack, GitHub, RAM, and more) behind one filesystem-and-shell interface,
parsing bash syntax in-process and dispatching each command to the mount it targets. There is no
subshell to `/bin/bash` and no arbitrary host filesystem access — only the resources you mounted.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| A uniform filesystem view over cloud services (S3, databases, SaaS APIs) for an agent | Mirage |
| Arbitrary, untrusted code execution with real native binaries | E2B, Daytona, Modal, Vercel Sandbox, boxd, exe.dev, or islo |
| Cloudflare-native container or durable filesystem | Cloudflare Sandbox or Cloudflare Computer |
| Scratch text/HTTP work with no external resources to mount | Flue's virtual sandbox |

Mirage explicitly does not compete with the other sandbox providers in this list for running
arbitrary or untrusted code — its own documentation says as much: for that, use a real sandbox
(Daytona, E2B, Modal, or any of the others here), and consider embedding Mirage *inside* one of
them when the agent also needs a uniform view over mounted external resources alongside a real
shell. Reach for Mirage on its own when the job is "give the agent `ls`/`grep`/`cat` over S3,
Slack, a database" and there is no need for the agent to compile, install packages, or run
arbitrary native programs.

## Prerequisites and environment

- `@struktoai/mirage-node` for a Node-target Flue application, or `@struktoai/mirage-browser` for
  the Cloudflare target — they are not interchangeable, and some Node-oriented resources (SSH-
  and database-backed ones) only exist in the Node package.
- An application-assembled `Workspace` with its mounts, credentials, and per-mount read/write/exec
  modes already configured before it reaches the adapter.
- No environment-variable credentials for Mirage itself — every mounted resource's credentials
  are supplied by application code when the resource is constructed.
- A clear answer to "does this agent need to run arbitrary shell commands," since Mirage's shell
  only sees mounted resources, never host binaries or an unrestricted filesystem.

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox mirage
   ```

2. Review `<source-root>/sandboxes/mirage.ts`; the current marker is
   `flue-blueprint: sandbox/mirage@1`.
3. Construct a `Workspace` in application code with the mounts the agent's task actually needs —
   least-privilege per mount (read-only where writes aren't required).
4. Pass that `Workspace` to `mirage(workspace)` inside `createSandbox()`.
5. If the Flue app targets both Node and Cloudflare builds, keep Node-only resources (SSH,
   certain database drivers) out of any module that also gets bundled for Cloudflare.
6. Decide whether the workspace, and thus its mounts, is shared across conversations or
   constructed fresh per agent instance.

## Exact `useSandbox` integration

```ts
'use agent';
import { Mount, MountMode, RAMResource, S3Resource, Workspace } from '@struktoai/mirage-node';
import { useModel, useSandbox } from '@flue/runtime';
import { mirage } from '../sandboxes/mirage';

const workspace = new Workspace({
  '/data': new Mount(new RAMResource(), { mode: MountMode.WRITE }),
  '/reports': new S3Resource({ bucket: 'quarterly-reports' }),
});

export function CatalogAnalyst() {
  useModel('anthropic/claude-haiku-4-5');
  useSandbox(mirage(workspace));
  return 'Answer questions about /reports using ls, grep, and cat. Use /data for scratch work.';
}
```

`Workspace` construction — which resources exist, their credentials, and their read/write/exec
modes — is entirely application-owned configuration; Mirage's own docs are the source of truth
for the exact resource types and options available, not this file.

## Lifecycle

- Flue calls `createSandbox({ id })` once per initialized harness. The adapter calls
  `workspace.createSession(id)` (falling back to `workspace.getSession(id)` if a session under
  that id already exists), so a single `Workspace` can safely back multiple Flue agent instances,
  each with its own session.
- The adapter's base directory is `/` unless `mirage(workspace, { cwd })` narrows it.
- There is no VM or container to start, pause, or kill — "lifecycle" here is the lifetime of the
  mounted resources themselves (an S3 bucket, a database connection, an in-memory mount that
  disappears with the process), not a sandbox instance.
- Flue never tears down the `Workspace` or its mounts; that stays entirely application-owned,
  same as every other adapter's non-existent teardown hook.
- Workspaces can be snapshotted and cloned the way version control treats source, per Mirage's
  own documentation, letting a run be forked or replayed from a prior state; the underlying
  storage/restoration mechanics are a Mirage-level concern, not something this adapter exposes.

## Recommended patterns

- Mount read-only wherever the agent only needs to observe data (`MountMode.READ`, the default);
  reserve `MountMode.WRITE` for mounts the task genuinely needs to mutate.
- Use `mirage provision`-style dry runs (per Mirage's own tooling) to estimate network bytes and
  cost for a command before running it against a large or expensive backend.
- Compose Mirage with a real sandbox (E2B, Daytona, Modal, boxd, exe.dev, islo) when the agent
  needs both a uniform resource view and the ability to run arbitrary native code — Mirage embeds
  inside those rather than replacing them.
- Keep credentials for each mounted resource scoped as narrowly as the resource's own IAM/token
  model allows; Mirage does not add its own credential broker on top.
- Key sessions on `options.id` (already the adapter's default behavior) so each Flue agent
  instance gets its own session over a shared `Workspace` instead of colliding on one.

## Avoid

- Do not reach for Mirage when the task is "run this code" rather than "read/write these external
  resources" — there is no subshell to a real shell and no native-binary execution here.
- Do not mix `@struktoai/mirage-node`-only resources into a build that also targets Cloudflare;
  the browser package only supports a compatible subset.
- Do not assume mounted-resource credentials are managed by Flue or the adapter — they are
  entirely application-supplied at `Workspace` construction time.
- Do not treat Mirage's `exec()` as a place to run arbitrary shell pipelines against the host;
  it only understands the bash syntax needed to address mounted resources, not general-purpose
  scripting against a real filesystem.
- Do not skip a per-mount mode decision — defaulting everything to writable defeats the
  least-privilege point of mounting resources individually in the first place.

## Gotchas, security, cost, and persistence

- Mirage is self-hosted only: a library plus a thin local daemon that runs in your own process or
  sandbox. There is no hosted SaaS tier and no Mirage-specific bill — cost and latency are
  "backend-bound," meaning each command's cost is whatever the resource it touches charges (an
  S3 `GetObject`, a database query, and so on).
- Data only leaves your network if a configured mount already does — Mirage itself does not add
  an external network hop beyond the resources you chose to mount.
- The adapter's `stat` omits `size`/`mtime` when the underlying resource reports them as unknown,
  rather than fabricating a value.
- The adapter composes the caller's `AbortSignal` with a `timeoutMs`-derived one and forwards it
  into `workspace.execute(...)`, so cancellation actually stops the in-flight operation — one of
  only two adapters in this set (with Vercel) where that's true; most others leave an orphaned
  remote operation on caller abort.
- Mirage's direct filesystem API does not implement recursive or force removal, so the adapter
  rejects either option before mutation rather than emulating it.
- Because there is no real OS-level sandbox boundary, Mirage is the wrong tool for isolating
  genuinely untrusted code — its own docs say to pair it with a real sandbox for that case.

## Related

- [Flue Mirage ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)
- [Mirage documentation](https://docs.mirage.strukto.ai/)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Deploy Flue on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Deploy Flue on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [Flue Daytona ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
