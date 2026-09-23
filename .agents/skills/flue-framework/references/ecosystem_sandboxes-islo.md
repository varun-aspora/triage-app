---
title: islo Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/islo/
provider_docs: https://docs.islo.dev/
nav_section: ecosystem
flue_version: 2.0.8
---

# islo

The islo adapter adapts a named islo sandbox into Flue's sandbox interface by invoking the local
`islo` CLI as a child process — no provider SDK dependency is added. islo (from Incredibuild)
gives hardware-isolated, persistent microVM environments built for running coding agents
unattended, with governance controls aimed at enterprise use rather than raw per-second compute.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| A persistent, hardware-isolated agent environment with enterprise access/governance controls | islo |
| A comparable persistent VM driven by an SDK instead of a local CLI | boxd |
| A comparable persistent VM reached over plain SSH instead of a CLI | exe.dev |
| A managed, ephemeral microVM with create/pause/kill lifecycle | E2B, Daytona, Modal, or Vercel Sandbox |
| Cloudflare-native container or durable filesystem | Cloudflare Sandbox or Cloudflare Computer |
| No native binaries, only safe scratch shell work | Flue's virtual sandbox |

Choose islo when the priority is letting a coding agent run unattended for long stretches under
explicit security/access controls — scoped credentials, granular isolation, an environment that
"follows" the same identity across a laptop, a server, and a browser session — rather than
spinning up the cheapest or fastest disposable container for a single task.

## Prerequisites and environment

- A Node.js host, container, or CI runner that can spawn child processes (`node:child_process`)
  — this adapter is Node-only, like exe.dev and boxd, and does not run on Cloudflare Workers.
- The `islo` binary installed and on `PATH` (or an explicit `cliPath` pointing to it).
- Either an already-authenticated CLI session or `ISLO_API_KEY` for non-interactive server/CI use.
- A named, application- or deployment-managed islo sandbox that already exists before Flue
  connects to it — the adapter does not create one.
- Awareness that every command runs as a fresh CLI invocation, so there is no long-lived
  provider connection to reuse the way there is with the SDK-backed adapters.

## How to

1. Add the documented blueprint:

   ```bash
   bunx flue add sandbox islo
   ```

2. Review `<source-root>/sandboxes/islo.ts`; the current marker is `flue-blueprint: sandbox/islo@1`.
3. Install and authenticate the `islo` CLI on the host that will run the Flue server (interactive
   login, or `ISLO_API_KEY` for CI/server contexts).
4. Create or identify the named sandbox the agent should use, outside of Flue.
5. Pass that name to `islo(...)` inside `createSandbox()`.
6. Decide whether the same named sandbox is shared across conversations or allocated per agent
   instance, and where its lifecycle (creation, retirement) is managed.

## Exact `useSandbox` integration

```ts
'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { islo } from '../sandboxes/islo';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    // Lazy, per the SandboxFactory contract: constructing this object is cheap;
    // resolving which named islo sandbox to use happens once, inside createSandbox(),
    // at initialization — never on a re-render.
    async createSandbox(options) {
      return islo(`flue-${options.id}`, { cwd: '/workspace' }).createSandbox(options);
    },
  });
  return 'Work inside your named islo sandbox using the standard file and shell tools.';
}
```

Keying the sandbox name on `options.id` (the Flue agent instance id) gives each conversation its
own islo environment name, consistent with the durable-workspace pattern used for Daytona and
boxd — but islo (unlike those) must already have a sandbox under that name; ensure application
or platform-side provisioning creates it before the agent's first turn, or the CLI call fails.

## Lifecycle

- `useSandbox()` may appear once per render; the factory object is cheap to rebuild.
- Flue calls `createSandbox({ id })` once per initialized harness; every operation after that
  spawns a fresh `islo` CLI process rather than holding one connection open — a materially
  different cost/latency profile than the SSH-based exe.dev adapter or an SDK-based one.
- Relative paths resolve from `/workspace` unless `options.cwd` or `useSandbox(factory, { cwd })`
  narrows it.
- `timeoutMs` is converted from milliseconds to whole seconds for GNU `timeout` running inside
  the sandbox, wrapping the remote command.
- Flue never creates, suspends, or deletes the named islo sandbox; the CLI's own authenticated
  session and the sandbox's persistence are entirely outside Flue's lifecycle model.
- islo environments are designed to persist and follow a stable identity across devices — a
  sandbox is not expected to disappear between agent turns the way an ephemeral microVM might.

## Recommended patterns

- Key the sandbox name on a stable identifier (`options.id` or an application tenant id) so a
  conversation's environment is recognizable and reusable across restarts.
- Keep CLI authentication (login session or `ISLO_API_KEY`) scoped to the server process; do not
  expose it to model-directed shell commands running inside the sandbox itself.
- Rely on islo's own access-control and isolation features for the governance case this provider
  is built for — long-running, unattended agent work — rather than reimplementing equivalent
  checks in application code.
- Set `cliPath` explicitly in environments where `islo` is not guaranteed to be first on `PATH`
  (containers, CI images).
- Set an explicit `timeoutMs` for every command; there is no adapter-level default beyond
  whatever the wrapped `timeout` invocation enforces.

## Avoid

- Do not use this adapter in Cloudflare Workers or any runtime that cannot spawn native child
  processes — it shells out to a local binary.
- Do not assume high-frequency command execution is free of overhead; every `exec` forks a new
  CLI process, unlike adapters that reuse one persistent connection.
- Do not assume caller cancellation actually stops the remote command — a `timeoutMs` deadline
  is enforced by an in-sandbox `timeout` wrapper, but the generated adapter does not compose the
  caller's `AbortSignal` into that remote command the way the Vercel and Mirage adapters do.
- Do not point `cliPath` at an untrusted binary; the adapter's entire security model rests on
  that binary behaving as documented.
- Do not treat the named sandbox as something Flue provisions — connecting to a name with no
  backing sandbox is a caller error, not something the adapter recovers from.

## Gotchas, security, cost, and persistence

- Every file and shell operation is a new `islo` process invocation with `--output json`, quoted
  through a remote `bash -lc`; factor process-spawn latency into any high-throughput workload.
- Isolation is hardware-level (dedicated microVM per sandbox) rather than shared-kernel, which is
  the basis for islo's "safe to run unattended" positioning — but that isolates the sandbox from
  its host and siblings, not from whatever the agent itself is authorized to reach over the
  network from inside it.
- Persistence here means the environment (and whatever state it holds) follows the same identity
  across devices and sessions by design — plan credential rotation and stale-state cleanup
  accordingly, the same caution that applies to any long-lived workspace.
- Pricing is not published in the bundled Flue documentation or the provider's public overview
  page at the time of writing; confirm current plan terms before committing a workload to it.
- Because there is no persistent CLI-to-sandbox connection for the adapter to hold open, a
  network hiccup affects only the in-flight command, not a shared session — but also means there
  is no adapter-level connection reuse to rely on for latency-sensitive workloads.

## Related

- [Flue islo ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
- [islo documentation](https://docs.islo.dev/)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Deploy Flue on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Flue boxd ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
- [Flue exe.dev ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
