---
title: boxd Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/boxd/
provider_docs: https://docs.boxd.sh/reference/typescript-sdk
nav_section: ecosystem
flue_version: 2.0.8
---

# boxd

boxd gives a Flue agent a full, hardware-isolated Linux VM with persistent disk.
The generated adapter wraps an already-created `@boxd-sh/sdk` `Box`; application
code still owns VM creation, identity, retention, and deletion.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| A real VM with its own kernel, systemd, Docker, and persistent disk | boxd |
| Fast branchable environments from a prepared running machine | boxd forks |
| A managed short-lived microVM with a simpler create/kill flow | E2B, Modal, or Vercel Sandbox |
| A container-native sandbox inside a Cloudflare Worker | Cloudflare Sandbox |
| Durable files on Cloudflare without native Linux binaries | Cloudflare Computer |
| A comparable persistent VM reached over SSH or a local CLI instead of an SDK | exe.dev or islo |
| A mounted virtual filesystem over cloud resources, not a VM | Mirage |
| Only HTTP and text processing in isolated memory | Flue's `bash()` virtual sandbox |

Choose boxd for coding agents, development workspaces, or untrusted Linux work that
benefits from a persistent machine. It is heavier and more privileged than an
in-memory shell, so do not use it when a narrow tool or virtual sandbox is enough.

## Prerequisites and environment

- A boxd account and capacity for the required machines.
- A Node-target Flue application for the generated adapter.
- `@boxd-sh/sdk`; the blueprint installs it when missing.
- `BOXD_API_KEY`, or the provider-supported short-lived `BOXD_TOKEN` alternative.
- A lifecycle policy deciding whether each agent gets a fresh, shared, forked, or
  reconnected VM.
- Keep credentials in server-side configuration, never in agent instructions or the VM
  workspace unless that exposure is intentional.

The adapter option defaults are:

- `cwd: '/home/boxd'`.
- `readyTimeoutMs: 30_000`; set `0` only for a VM known to be ready.
- `client?: Compute`; pass it so in-flight operations detect stopped or destroyed VMs.

## How to

1. Add the documented blueprint from the project root:

   ```bash
   bunx flue add sandbox boxd
   ```

2. Review the generated `<source-root>/sandboxes/boxd.ts`. The current marker is
   `flue-blueprint: sandbox/boxd@1`.
3. Make `BOXD_API_KEY` or `BOXD_TOKEN` available to the server process.
4. Create the VM lazily inside `createSandbox()`, then adapt the resulting `Box`.
5. Keep the `Compute` client open for as long as the Flue sandbox can be used.
6. Test readiness and cleanup behavior with a non-production VM.

## Exact `useSandbox` integration

```ts
'use agent';
import { Compute } from '@boxd-sh/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { boxd } from '../sandboxes/boxd';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    async createSandbox(options) {
      const client = new Compute({ apiKey: process.env.BOXD_API_KEY });
      const box = await client.box.create({ name: `flue-${Date.now()}` });
      return boxd(box, { client }).createSandbox(options);
    },
  });
  return 'Work in the isolated Linux VM and keep changes inside its workspace.';
}
```

For a durable per-agent workspace, application code should resolve an existing `Box`
from a stable mapping keyed by `options.id`, then call the same
`boxd(box, { client }).createSandbox(options)` adapter path. Do not create a new VM on
every process restart if persistence is the goal.

## Lifecycle

- `useSandbox()` may appear once per render. The factory object is cheap to rebuild.
- Flue calls `createSandbox({ id })` once per initialized harness, not per render or
  message. That harness and its subagents share the resulting `Sandbox`.
- The adapter waits for `box.exec(['true'])` once before exposing the VM.
- Passing `client` enables control-plane liveness polling while operations are pending;
  terminal VM state becomes `SandboxDiedError` instead of an indefinite hang.
- Flue has no sandbox teardown hook. It never calls boxd pause, hibernate, stop, or
  delete methods.
- Persist the provider VM identity outside Flue if a later harness must reconnect.
- Delete truly ephemeral VMs and close `Compute` clients from application-owned job or
  retention logic.

## Recommended patterns

- Use one VM per tenant or stable Flue agent id when files must survive restarts.
- Prepare a golden VM once and fork it for short jobs instead of reinstalling tools.
- Set auto-suspend or auto-hibernate policies for idle persistent workspaces.
- Pass `client` to the adapter; the liveness detector is materially safer than a bare
  `Box` for long commands.
- Use boxd's external egress allowlist and host-bound secret substitution for untrusted
  work. An isolated VM and an internet allowlist solve different problems.
- Put an `AGENTS.md` and workspace skills under the selected `cwd` when the agent needs
  them discovered by Flue.
- Use a narrow application tool for privileged control-plane actions instead of giving
  the model a boxd API key inside its shell.

## Avoid

- Do not call provider creation directly during the synchronous agent render.
- Do not omit cleanup for timestamp-named or otherwise ephemeral VMs.
- Do not share one writable VM across untrusted tenants.
- Do not pass the full server environment into the VM.
- Do not assume Flue conversation durability preserves VM files or VM identity.
- Do not close the `Compute` client while the adapter still uses it for liveness probes.

## Gotchas, security, cost, and persistence

- Relative paths start at `/home/boxd` unless `boxd(..., { cwd })` changes the adapter
  base or `useSandbox(factory, { cwd })` narrows it further.
- Command timeouts are milliseconds. Caller abort can return before a provider command
  has fully stopped, so design mutations to tolerate uncertain completion.
- `stat`, listing, directory creation, and removal use quoted Linux utilities; the VM
  image must retain compatible tools.
- boxd machines are persistent by default. Persistence is useful, but stale credentials,
  generated code, and user data also persist until cleaned.
- Isolation from sibling machines does not restrict outbound internet. Configure both
  machine isolation and egress policy for hostile code.
- Billing follows VM resources while running plus stored disk. Suspended or hibernated
  machines still consume quota and disk even when compute cost falls.
- Forks inherit an egress allowlist, while a machine restored from a snapshot starts
  unrestricted according to provider documentation; reapply policy after restore.

## Related

- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [boxd TypeScript SDK](https://docs.boxd.sh/reference/typescript-sdk)
- [boxd resources and limits](https://docs.boxd.sh/guides/resources)
- [boxd egress control](https://docs.boxd.sh/guides/egress)
- [Flue exe.dev ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
- [Flue islo ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
