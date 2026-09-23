---
title: E2B Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/e2b/
provider_docs: https://docs.e2b.dev/
nav_section: ecosystem
flue_version: 2.0.8
---

# E2B

The E2B adapter wraps an initialized `e2b` `Sandbox` as a Flue
`SandboxFactory`. E2B supplies an isolated Linux microVM; Flue maps its command and
filesystem APIs to standard `bash`, `grep`, `glob`, `read`, `write`, and `edit` tools.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| Fast, general-purpose Linux microVM with simple create/pause/kill lifecycle | E2B |
| Jupyter-style code interpretation in the same provider | `@e2b/code-interpreter` with the adapter import adjusted |
| Rich auto-archive, volume, and network lifecycle controls | Daytona |
| Persistent-by-default named sandboxes in Vercel | Vercel Sandbox |
| A durable full development VM with systemd and Docker | boxd, exe.dev, or islo |
| GPU-attached execution | Modal |
| A mounted virtual filesystem over cloud resources, not arbitrary code execution | Mirage |
| No native binaries, only safe scratch shell work | Flue's virtual sandbox |

Choose E2B for short-lived code execution and coding agents that need real Linux but do
not need a long-lived server VM. E2B's own numbers put cold start in the low hundreds of
milliseconds for a simple template; Vercel Sandbox's Firecracker microVMs report a similar
"milliseconds" boot, so treat the two as comparable on raw startup and choose between them on
lifecycle model (explicit pause/kill vs. persistent-by-default) instead.

## Prerequisites and environment

- A Node-target Flue application.
- The `e2b` package; use `@e2b/code-interpreter` only for that provider variant.
- `E2B_API_KEY` in trusted runtime configuration.
- A decision on template, timeout, auto-pause, network policy, and final kill behavior.
- Application storage for a sandbox id if pause/resume must survive process restarts.

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox e2b
   ```

2. Review `<source-root>/sandboxes/e2b.ts`; the current marker is
   `flue-blueprint: sandbox/e2b@1`.
3. Make `E2B_API_KEY` available to the server process.
4. Create the E2B sandbox lazily in `createSandbox()`.
5. Select a custom template at creation if the agent needs preinstalled tools.
6. Persist the sandbox id before pausing if later work must reconnect.
7. Kill ephemeral and expired sandboxes from application-owned lifecycle code.

## Exact `useSandbox` integration

```ts
'use agent';
import { Sandbox } from 'e2b';
import { useModel, useSandbox } from '@flue/runtime';
import { e2b } from '../sandboxes/e2b';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    async createSandbox(options) {
      const sandbox = await Sandbox.create();
      return e2b(sandbox).createSandbox(options);
    },
  });
  return 'Use the E2B Linux workspace for all generated code.';
}
```

For a prepared image, the documented provider call is
`Sandbox.create('<template-name-or-id>')`. For persistence, use provider-supported
`Sandbox.connect(sandboxId, options)` in application lifecycle code and pass the
connected object through the same `e2b(sandbox)` adapter.

## Lifecycle

- Flue calls the factory's `createSandbox({ id })` once per initialized harness and
  shares the resulting `Sandbox` with its subagents.
- The adapter base directory is `/home/user`.
- Flue never pauses or kills E2B resources; `SandboxFactory` has no teardown verb.
- A running E2B sandbox can be paused with `sandbox.pause()`, preserving filesystem and,
  by default, memory state.
- Reconnect with `Sandbox.connect(id, ...)`; provider docs say this resumes a paused
  sandbox.
- `sandbox.kill()` is terminal and removes the sandbox permanently.
- E2B timeout defaults to kill unless lifecycle `onTimeout: 'pause'` is configured.
- Paused sandboxes are retained until explicitly killed according to current provider
  persistence documentation.

## Recommended patterns

- Use a custom E2B template for compilers, package caches, and common dependencies.
- Set a finite `timeoutMs` and choose explicit `lifecycle.onTimeout` behavior.
- Store `sandbox.sandboxId` transactionally with the application entity that owns it.
- Pause interactive workspaces when idle and kill one-off execution sandboxes.
- Use one sandbox per untrusted tenant or job.
- Keep API credentials outside the workspace; expose only task-specific secrets.
- Treat reconnect and kill operations as application tools or control-plane code, not
  model-directed shell commands.

## Avoid

- Do not call `Sandbox.create()` during the synchronous agent render itself.
- Do not expect Flue to reconnect a sandbox after process restart without application
  identity mapping.
- Do not leave paused sandboxes indefinitely without a retention sweeper.
- Do not share a writable microVM between mutually untrusted users.
- Do not assume caller cancellation has killed the remote process.
- Do not use a base template that lacks the commands the agent instructions require.

## Gotchas, security, cost, and persistence

- The adapter forwards command `timeoutMs` in milliseconds unchanged.
- E2B's direct remove API has no `recursive` or `force` controls. The adapter rejects
  either requested option before changing files.
- E2B command execution does not receive Flue's caller `AbortSignal` in the generated
  adapter. Flue releases the caller promptly, but the provider command can become an
  orphan and continue mutating the workspace.
- File stats include only metadata exposed by E2B; absent size or modification fields
  are not fabricated.
- Current provider docs describe default five-minute timeout behavior and tier-specific
  continuous-runtime limits. Verify plan limits before long jobs.
- Pause preserves state but running compute and paused retention have different billing;
  check current E2B pricing rather than hard-coding rates.
- Persistence of memory and disk is provider state. Flue conversation durability is a
  separate database concern.
- A sandbox that times out with the default kill policy cannot be resumed.

## Related

- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [E2B documentation](https://docs.e2b.dev/)
- [E2B persistence](https://docs.e2b.dev/sandbox/persistence)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Flue Daytona ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
- [Flue Vercel Sandbox ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)
- [Flue Modal ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
