---
title: Vercel Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/vercel/
provider_docs: https://vercel.com/docs/sandbox
nav_section: ecosystem
flue_version: 2.0.8
---

# Vercel Sandbox

The Vercel Sandbox adapter adapts an initialized `@vercel/sandbox` `Sandbox` into Flue's sandbox
interface. Vercel Sandboxes are Firecracker microVMs that are **persistent by default**: stopping
one auto-snapshots its filesystem, and the next call against the same name auto-resumes it — no
explicit pause/resume step, unlike E2B or Daytona.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| Persistent-by-default named sandboxes, no manual snapshot management | Vercel Sandbox |
| Fast, general-purpose microVM with explicit pause/kill lifecycle | E2B |
| Rich auto-archive, volume, and network lifecycle controls | Daytona |
| GPU-attached execution, serverless images and Volumes | Modal |
| A durable full development VM with systemd and Docker | boxd, exe.dev, or islo |
| Cloudflare-native container or durable filesystem | Cloudflare Sandbox or Cloudflare Computer |
| No native binaries, only safe scratch shell work | Flue's virtual sandbox |

Choose Vercel Sandbox when persistence-by-default and named resume are worth more than manual
pause/kill control, or when the application already deploys on Vercel and wants OIDC
authentication for free. Its Firecracker microVMs boot in low hundreds of milliseconds to a few
seconds depending on image and warm capacity — in the same range as E2B's — so pick on lifecycle
model and platform fit, not on an assumption that either is unambiguously faster.

## Prerequisites and environment

- A Node-target Flue application.
- The `@vercel/sandbox` package.
- `VERCEL_OIDC_TOKEN` for OIDC authentication (automatic on Vercel deployments; run `vercel link`
  and `vercel env pull` for local development) or a Vercel access token for use outside Vercel.
- A decision on persistence (on by default), snapshot retention, region, and resource size
  (vCPU/memory) for the sandbox class in use.
- Awareness of plan limits: Hobby caps session duration at 45 minutes and concurrency at 10
  sandboxes; Pro/Enterprise allow 24-hour sessions and far higher concurrency.

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox vercel
   ```

2. Review `<source-root>/sandboxes/vercel.ts`; the current marker is
   `flue-blueprint: sandbox/vercel@1`.
3. Make `VERCEL_OIDC_TOKEN` (or an access token) available to the server process.
4. Create or resume the Vercel sandbox lazily inside `createSandbox()`, naming it so a later
   call can resume the same conversation's workspace.
5. Choose a `runtime`/image and resource size at creation; change these before the next
   `Sandbox.create()`, not mid-session.
6. Decide whether non-persistent (`Sandbox.create({ ..., persistence: false })`-style ephemeral
   use) is actually wanted anywhere — persistence is the default, so an explicitly ephemeral
   sandbox is an opt-out, not the norm.
7. Stop sandboxes explicitly (`sandbox.stop()`) when a task finishes rather than waiting out the
   session timeout, since Active CPU and Provisioned Memory are billed for the running session.

## Exact `useSandbox` integration

```ts
'use agent';
import { Sandbox } from '@vercel/sandbox';
import { useModel, useSandbox } from '@flue/runtime';
import { vercel } from '../sandboxes/vercel';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    // Lazy, per the SandboxFactory contract: constructing this object is cheap;
    // the expensive Vercel sandbox creation happens once, inside createSandbox(),
    // at initialization — never on a re-render.
    async createSandbox(options) {
      const sandbox = await Sandbox.getOrCreate({
        name: `flue-${options.id}`,
        runtime: 'node24',
      });
      return vercel(sandbox).createSandbox(options);
    },
  });
  return 'Use the persistent Vercel workspace for all generated code.';
}
```

`Sandbox.getOrCreate({ name })` is the idiomatic way to give each Flue agent instance a stable,
resumable sandbox: the first call creates it, every later call against the same name resumes it
from its last auto-snapshot. `Sandbox.get({ name })` alone throws if the sandbox does not exist
yet; `Sandbox.create({ name })` alone throws if it already does.

## Lifecycle

- Flue calls the factory's `createSandbox({ id })` once per initialized harness; that harness and
  its subagents share the resulting `Sandbox`.
- The adapter's base directory is `/vercel/sandbox` unless `vercel(sandbox, { cwd })`
  narrows it.
- A session (one running VM instance) stops after its timeout (default 5 minutes, plan-capped
  maximum 45 minutes on Hobby / 24 hours on Pro and Enterprise) or an explicit `stop()`. For a
  persistent sandbox, stopping auto-snapshots the filesystem; the *sandbox* itself — spanning
  many sessions across stop/resume — has no fixed lifetime.
- The next SDK call against a stopped persistent sandbox (e.g. `runCommand`) resumes it from the
  latest snapshot automatically; nothing in application code needs to call an explicit "resume".
- Flue never stops, snapshots, or deletes Vercel resources itself; `SandboxFactory` has no
  teardown verb — that stays application-owned.
- Non-persistent sandboxes discard their filesystem on stop instead of snapshotting it; choose
  this only for genuinely disposable, single-session work.
- Drives (beta) are a separate persistent-storage primitive from the sandbox filesystem itself —
  attach one when data must be reused across sandboxes with different names, not just resumed
  within the same one.

## Recommended patterns

- Name sandboxes with a stable identifier (`flue-${options.id}`) and use `Sandbox.getOrCreate`
  so a conversation resumes its own workspace instead of starting fresh.
- Set an explicit `timeout` sized to the task and call `sandbox.extendTimeout()` for genuinely
  long-running work rather than defaulting to the plan maximum.
- Use a custom image (via Vercel Container Registry) or a snapshot to skip repeated dependency
  installation instead of provisioning from scratch every session.
- Set a snapshot retention period deliberately; the default expiry is 30 days after last use.
- Use Drives for data that must be shared or reused across differently-named sandboxes; use
  persistence alone for data scoped to one sandbox's own history.
- Restrict outbound network with a sandbox firewall policy for untrusted code; inbound package
  downloads are free, but outbound traffic and exposed-port traffic are billed and are also the
  surface a hostile payload would use to exfiltrate data.
- Treat `VERCEL_OIDC_TOKEN` as ambient on Vercel deployments and as a secret to inject explicitly
  everywhere else (CI, another host).

## Avoid

- Do not assume a sandbox is disposable by default — persistence is the default behavior, so an
  abandoned named sandbox keeps its snapshot (and its storage bill) until you delete it.
- Do not run untrusted or multi-tenant code inside a container run *inside* the sandbox without
  installing the sandbox's proxy CA certificate in that container's own trust store — a nested
  container does not inherit the host sandbox's trust bundle.
- Do not size Active CPU/memory for peak load by default; start smaller and scale up only if the
  workload needs it, since Provisioned Memory bills for allocation, not just use.
- Do not rely on session timeout as your only cost control; call `stop()` when a task finishes.
- Do not skip a network policy for agent-generated code that can reach the public internet by
  default.
- Do not conflate Drives with the sandbox's own persistent filesystem; they are billed and
  managed separately.

## Gotchas, security, cost, and persistence

- Sandboxes bill Active CPU (only while the CPU is actually busy — I/O wait doesn't count),
  Provisioned Memory (allocation × time, 1-minute minimum increments), Sandbox Creations,
  Data Transfer, Snapshot Storage, and Drive Storage/Reads/Writes as separate metered lines; see
  current Vercel pricing before sizing a production workload.
- Outbound network and exposed-port traffic are billable; inbound package/dependency downloads
  are free.
- Maximum session duration applies per *session*, not per sandbox — a persistent sandbox resumed
  daily for a week is one sandbox and seven sessions, each under its own duration cap.
- The adapter composes the caller's `AbortSignal` with a `timeoutMs`-derived one and forwards it
  to the Vercel exec call, so cancellation actually stops the remote command (unlike most other
  remote adapters, where an aborted call leaves an orphaned process). Only a `timeoutMs` firing
  maps to `exitCode: 124`; caller-initiated abort rejects instead.
- Vercel's direct file-stat API reports the complete `FileStat` shape (including
  `isSymbolicLink`), so nothing here is fabricated or omitted the way some other adapters must.
- Hobby-plan sandbox creation pauses for the rest of the billing cycle once its included quota is
  exceeded — plan around that for anything beyond prototyping.
- A container run inside the sandbox needs the sandbox's proxy CA certificate installed into its
  own trust store for HTTPS to verify correctly against the sandbox firewall's TLS termination.

## Related

- [Flue Vercel Sandbox ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)
- [Vercel Sandbox documentation](https://vercel.com/docs/sandbox)
- [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing)
- [Vercel Sandbox concepts and security model](https://vercel.com/docs/sandbox/concepts)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [Flue Daytona ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
- [Flue Modal ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
