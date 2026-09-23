---
title: exe.dev Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/exedev/
provider_docs: https://exe.dev/docs
nav_section: ecosystem
flue_version: 2.0.8
---

# exe.dev

The exe.dev adapter adapts an existing exe.dev VM into Flue's sandbox interface over SSH (for
commands) and SFTP (for files), using `ssh2`. exe.dev VMs are genuinely persistent servers —
root, `apt`, systemd, a public HTTPS hostname — not ephemeral, pause-on-idle microVMs, so this
adapter is Node-only and depends on an SSH-reachable VM your application already provisioned.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| A persistent Linux server reached over plain SSH, root by default | exe.dev |
| A comparable persistent VM driven by an SDK instead of SSH | boxd |
| A comparable persistent environment driven by a local CLI instead of SSH | islo |
| A managed, ephemeral microVM with create/pause/kill lifecycle | E2B, Daytona, Modal, or Vercel Sandbox |
| Cloudflare-native container or durable filesystem | Cloudflare Sandbox or Cloudflare Computer |
| No native binaries, only safe scratch shell work | Flue's virtual sandbox |

Choose exe.dev when the mental model you want is "a VM I SSH into," not "a sandbox API I call."
Its VMs are not paused or wiped when idle — they keep running (or fall back to disk-only billing
when explicitly stopped) rather than tearing down like E2B, Daytona, Modal, or Vercel Sandbox
between sessions. That persistence is the whole pitch; it is not a fit for short-lived,
per-request isolation of untrusted code from many different tenants on one machine.

## Prerequisites and environment

- A Node-target Flue application — this adapter uses Node's `ssh2` client and does not run on
  Cloudflare Workers.
- The `ssh2` package (and its TypeScript types); the blueprint installs both.
- An existing, SSH-reachable exe.dev VM. Provisioning happens outside the adapter (`ssh exe.dev`,
  the exe.dev CLI, or the optional lifecycle helpers the blueprint also generates).
- `EXE_VM_HOST` identifying which VM to connect to.
- SSH authentication: `EXE_SSH_KEY` (a private key file) or an SSH agent via `SSH_AUTH_SOCK`.
- `EXE_API_TOKEN` only if application code also uses the generated lifecycle helpers
  (create/clone/ready-check/delete a VM), separate from the SSH-based sandbox adapter itself.

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox exedev
   ```

2. Review `<source-root>/sandboxes/exedev.ts`; the current marker is
   `flue-blueprint: sandbox/exedev@1`.
3. Provision (or identify) the target VM out of band — by hand, via the exe.dev CLI, or with the
   blueprint's optional lifecycle helpers.
4. Make `EXE_VM_HOST` and an SSH credential (`EXE_SSH_KEY` or `SSH_AUTH_SOCK`) available to the
   server process.
5. Pass the VM hostname (or a richer `ExeDevVm` descriptor) to `exedev(...)` inside
   `createSandbox()`.
6. Decide whether VMs are shared across conversations or allocated one-per-tenant, and where
   cleanup for abandoned VMs lives.

## Exact `useSandbox` integration

```ts
'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { exedev } from '../sandboxes/exedev';

export function ReleaseManager() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(exedev(process.env.EXE_VM_HOST!));
  return 'Work inside the exe.dev VM for all repository changes and command execution.';
}
```

Passing a bare hostname is the minimal form; the generated `ExeDevAdapterOptions` shape (SSH
port, explicit key path, connection retry behavior) lives in the blueprint file itself — read
`<source-root>/sandboxes/exedev.ts` for the exact fields available in this project rather than
assuming a shape the bundled docs don't publish. For a durable per-conversation VM, resolve a
stable hostname or `ExeDevVm` from application storage keyed by the agent instance id before
calling `exedev(...)`, the same pattern used for Daytona and boxd.

## Lifecycle

- `useSandbox()` may appear once per render; the factory object is cheap to rebuild each time.
- Flue calls `createSandbox({ id })` once per initialized harness. The adapter opens one SSH
  connection at that point and reuses it for every subsequent `exec`/file operation in that
  harness, rather than reconnecting per command.
- The adapter detects the remote home directory with `echo $HOME` once at connection time and
  uses it as the workspace root, falling back to `/home/user` if detection fails.
- Flue has no teardown hook for this adapter; it never disconnects the SSH session, stops the
  VM, or deletes it. Application code owns all of that, including closing idle connections.
- exe.dev VMs are persistent by design: they are not paused or wiped when idle. A stopped VM
  keeps its disk and moves to disk-only billing rather than being torn down.
- File removal goes through SFTP directly, so requesting `recursive`/`force` options Flue's `rm`
  doesn't support on this transport is rejected before anything is mutated, rather than emulated.

## Recommended patterns

- Allocate one VM per tenant, project, or stable agent identity when persistent, hands-on state
  (installed tools, checked-out repositories, running services) is the point.
- Prefer an SSH agent (`SSH_AUTH_SOCK`) over a static private-key file path where your deployment
  environment supports it.
- Reuse the adapter's single SSH connection for a whole harness's lifetime instead of opening
  new connections per operation elsewhere in application code.
- Use the optional lifecycle helpers (behind `EXE_API_TOKEN`) for provisioning and teardown, and
  keep that token out of the VM's own shell environment.
- Treat the VM's public HTTPS hostname and IAM-based sharing as part of your access-control
  design, not an incidental detail — exe.dev VMs are reachable and shareable by default.

## Avoid

- Do not use this adapter from a Cloudflare Worker or any runtime without Node's `child_process`
  and TCP socket APIs — it depends on `ssh2`.
- Do not assume caller cancellation stops the remote command; the adapter closes the SSH stream
  at a `timeoutMs` deadline and reports `exitCode: 124`, but a caller-aborted call can still leave
  the remote process running, since the generated adapter does not forward the caller's
  `AbortSignal` into the SSH channel the way the Vercel and Mirage adapters do.
- Do not share one VM across mutually untrusted tenants — persistence means yesterday's files and
  installed tools are still there for whoever connects next.
- Do not treat "persistent" as "backed up" — a VM losing its disk is still a real availability
  risk despite not being intentionally wiped on idle.
- Do not put the full server environment on the SSH connection's remote shell; scope credentials
  to what the agent's task actually needs.

## Gotchas, security, cost, and persistence

- Pricing is either a flat monthly pool (shared CPU/RAM/disk/transfer across your VMs) or
  per-second usage billing; a stopped VM still costs disk storage even while compute cost drops
  to zero — factor idle disk cost into any "how many VMs" plan.
- Isolation is hardware-level (KVM virtual machines, not a shared kernel), but that isolates VMs
  from each other — it does not by itself restrict a VM's own outbound network access; configure
  egress policy separately if the workload runs untrusted code.
- `timeoutMs` closes the SSH command stream at the deadline and reports `exitCode: 124` for that
  call; it does not stop the underlying VM or kill unrelated processes still running on it.
- The adapter's `stat` reads whatever the SFTP protocol reports; it does not fabricate fields the
  transport doesn't provide.
- Because a VM persists by default, credentials, generated code, and prior task output persist
  right along with it — clean up secrets and scratch state as part of normal task completion,
  not just at VM deletion time.
- The optional lifecycle helpers (create/clone/ready-check/delete) are a separate control-plane
  concern from the SSH-based sandbox adapter; keep `EXE_API_TOKEN` out of code paths reachable
  from model-directed shell commands.

## Related

- [Flue exe.dev ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
- [exe.dev documentation](https://exe.dev/docs)
- [exe.dev AI Sandboxes](https://exe.dev/sandbox)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Deploy Flue on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Flue boxd ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
- [Flue islo ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
