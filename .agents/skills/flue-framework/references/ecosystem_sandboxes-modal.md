---
title: Modal Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/modal/
provider_docs: https://modal.com/docs/guide/sandbox
nav_section: ecosystem
flue_version: 2.0.8
---

# Modal

The Modal adapter wraps an application-created `modal` JavaScript SDK `Sandbox` as a Flue
`SandboxFactory`. Modal is a serverless compute platform; its Sandboxes give per-second-billed,
container-based isolation with first-class GPU access, on-demand image builds, and persistent
Volumes. Flue maps the SDK's exec and file surface onto the standard `bash`, `grep`, `glob`,
`read`, `write`, and `edit` tools by shelling out for stat/mkdir/rm, since the JS SDK does not
expose those directly.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| GPU-attached execution (inference, training, CUDA workloads) | Modal |
| Fast, simple microVM with create/pause/kill lifecycle, no GPU | E2B |
| Rich auto-archive, volume, and network lifecycle controls | Daytona |
| Persistent-by-default named sandboxes with automatic snapshot/resume | Vercel Sandbox |
| A durable full development VM with systemd and Docker | boxd, exe.dev, or islo |
| Cloudflare-native container or durable filesystem | Cloudflare Sandbox or Cloudflare Computer |
| A mounted virtual filesystem over cloud resources, not arbitrary code execution | Mirage |
| No native binaries, only safe scratch shell work | Flue's virtual sandbox |

Choose Modal when the agent's work needs GPU compute, a serverless image/build pipeline, or
Volumes for data that must outlive one sandbox — not on an assumption that it starts faster than
E2B or Vercel Sandbox. All three report sub-second-to-low-hundreds-of-milliseconds boot for their
base primitive (Modal's own docs put median sandbox start latency for CPU containers under half a
second); the difference that actually matters is what happens *after* boot — dependency install,
a `git pull`, model load into memory — and there Modal is the only one of the three with native
GPU billing and Volumes as a first-class persistence primitive.

## Prerequisites and environment

- A Node-target Flue application on Node.js 22 or later (required by the `modal` SDK).
- The `modal` npm package.
- `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or a `~/.modal.toml` credentials file, in trusted
  runtime configuration.
- An image that provides `bash` and standard filesystem utilities — the adapter shells out for
  `stat`, `mkdir`, `readdir`, and `rm` rather than using a dedicated Modal filesystem API.
- A decision on GPU type (if any), `timeoutMs`, idle-timeout behavior, and which paths (if any)
  need a mounted Volume to survive past one sandbox's lifetime.

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox modal
   ```

2. Review `<source-root>/sandboxes/modal.ts`; the current marker is
   `flue-blueprint: sandbox/modal@1`.
3. Make `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` (or the credentials file) available to the server
   process.
4. Create the Modal `App`, image, and `Sandbox` lazily inside `createSandbox()` — never during
   the synchronous agent render.
5. Attach a Modal Volume at a known path if data must survive past a single sandbox's `timeoutMs`.
6. Set an explicit `timeoutMs` (max 24 hours) instead of relying on the 5-minute default, and
   decide idle-timeout behavior for interactive workloads.
7. Terminate ephemeral sandboxes with `sandbox.terminate()` from application-owned lifecycle code.

## Exact `useSandbox` integration

```ts
'use agent';
import { ModalClient } from 'modal';
import { useModel, useSandbox } from '@flue/runtime';
import { modal } from '../sandboxes/modal';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    // Lazy, per the SandboxFactory contract: constructing this object is cheap;
    // the expensive Modal sandbox creation happens once, inside createSandbox(),
    // at initialization — never on a re-render.
    async createSandbox(options) {
      const client = new ModalClient();
      const app = await client.apps.fromName(`flue-${options.id}`, { createIfMissing: true });
      const image = client.images.fromRegistry('python:3.13-slim');
      const sandbox = await client.sandboxes.create(app, image, { timeoutMs: 600_000 });
      return modal(sandbox).createSandbox(options);
    },
  });
  return 'Use the Modal sandbox for all generated code.';
}
```

Keying the `App` name on `options.id` gives each Flue agent instance its own Modal App namespace;
it does not by itself make the *sandbox* durable across restarts — a fresh `Sandbox.create` call
still starts a new container unless application code looks up an existing one first. For GPU
work, pass `gpu` in the `sandboxes.create(...)` options and select an image with the required
CUDA toolkit.

## Lifecycle

- A Modal sandbox moves through documented states: Created → Scheduled → Started → Ready →
  Finished. "Started" is not "ready" — application-level init (package install, model load) runs
  after the container starts and is not included in most cold-start numbers.
- Flue calls the factory's `createSandbox({ id })` once per initialized harness; that harness and
  its subagents share the resulting `Sandbox`.
- The adapter's base directory is `/` unless `modal(sandbox, { cwd })` sets one.
- Default maximum lifetime is 5 minutes; `timeoutMs` extends this up to 24 hours. Idle time
  (no stdin, no active command, no open TCP connection) also counts toward automatic
  termination independent of the hard `timeoutMs` ceiling.
- Flue never terminates Modal resources; `SandboxFactory` has no teardown verb. Call
  `sandbox.terminate({ wait: true })` from application-owned cleanup code.
- For work that must outlive 24 hours, Modal's own guidance is Filesystem Snapshots across
  sandbox instances, not one long-lived sandbox — plan multi-day agent workspaces around that.

## Recommended patterns

- Pass a custom image with the toolchain the agent needs; installing packages on every
  sandbox start defeats Modal's fast-start advantage.
- Mount a Volume for anything (build caches, checkouts, generated artifacts) that must survive
  past one sandbox's `timeoutMs`.
- Set `timeoutMs` and an idle-timeout policy explicitly; do not rely on the 5-minute default for
  interactive or long-running agent work.
- Use GPU sandboxes only for the step that needs one; keep routine shell/file work on a CPU
  sandbox to avoid paying GPU-second rates for idle time.
- Key the Modal `App` (and any durable Volume) on a stable identifier such as `options.id` so
  restarts of the same conversation land in a recognizable namespace.
- Treat `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` as server-side secrets; never place them in agent
  instructions or the sandbox's own environment unless the agent's task requires calling Modal
  itself.

## Avoid

- Do not call `client.sandboxes.create(...)` during the synchronous agent render.
- Do not assume caller cancellation stops the remote command — the generated adapter forwards
  `timeoutMs` but does not compose the caller's `AbortSignal` into the Modal exec call, so an
  aborted call can leave an orphaned process running in the sandbox.
- Do not select a minimal/scratch image without `bash` and basic coreutils; the adapter's
  `stat`/`mkdir`/`rm` implementations depend on them.
- Do not treat a 5-minute default timeout as generous for anything beyond a single short task.
- Do not keep a GPU sandbox alive for shell/file work that a CPU sandbox handles just as well.
- Do not share one writable sandbox across untrusted tenants.

## Gotchas, security, cost, and persistence

- Sandbox compute bills per-core-second (`$0.00003942`/core/sec for Sandbox-class CPU as of this
  writing) and GPUs bill per-second at rates that vary by GPU class (roughly `$0.000164`/sec for
  a T4 up to `$0.001972`/sec for a B300) — verify current rates before sizing a workload, and
  remember GPU seconds cost far more than CPU seconds for the same wall-clock time.
- Volumes cost separately (`$0.09`/GiB/month as of this writing) with a modest amount included
  free monthly; Volume storage is a distinct billing line from sandbox compute time.
- The adapter rejects a requested `stat` field the underlying provider doesn't report rather than
  fabricating it; only GNU- and BusyBox-`stat`-compatible output is parsed.
- Idle-timeout resets on stdin writes, active commands, or open TCP connections — a sandbox
  running a background server with no active exec call can still idle out if nothing is
  interacting with it.
- Filesystem Snapshots are how Modal recommends surviving the 24-hour ceiling across sandbox
  instances; this is a provider-level concern independent of Flue's own conversation durability.
- Provider docs distinguish "Started" from "Ready" explicitly — a sandbox usable for the
  underlying container primitive is not yet usable for agent work until its own init finishes.

## Related

- [Flue Modal ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
- [Modal Sandbox guide](https://modal.com/docs/guide/sandbox)
- [Modal cold start performance](https://modal.com/docs/guide/cold-start)
- [Modal pricing](https://modal.com/pricing)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [Flue Daytona ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
- [Flue Vercel Sandbox ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)
