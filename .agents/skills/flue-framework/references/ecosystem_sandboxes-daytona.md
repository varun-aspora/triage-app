---
title: Daytona Sandbox
source: https://flueframework.com/docs/ecosystem/sandboxes/daytona/
provider_docs: https://www.daytona.io/docs/en/typescript-sdk/daytona/
nav_section: ecosystem
flue_version: 2.0.8
---

# Daytona

The Daytona adapter connects Flue to an application-created `@daytona/sdk` `Sandbox`.
It provides a managed Linux filesystem and process boundary while leaving image,
resource, networking, persistence, and cleanup decisions to application code.

## Choose this vs alternatives

| Need | Choose |
| --- | --- |
| Managed Linux with snapshots, volumes, regions, and detailed lifecycle policy | Daytona |
| Minimal fast microVM creation and pause/resume | E2B |
| Persistent-by-default microVMs in a Vercel project | Vercel Sandbox |
| Serverless images, volumes, and optional GPU compute | Modal |
| Cloudflare-native containers | Cloudflare Sandbox |
| A real persistent VM reached over SSH or a CLI instead of an SDK | boxd, exe.dev, or islo |
| A mounted virtual filesystem over cloud resources, not arbitrary code execution | Mirage |

Choose Daytona when the application already uses its sandbox controls or needs explicit
auto-stop, auto-pause, auto-archive, auto-delete, TTL, volume, and network settings.

## Prerequisites and environment

- A Node-target Flue application.
- `@daytona/sdk`; the blueprint installs it when missing.
- `DAYTONA_API_KEY` for the normal API-key path.
- Optional Daytona API URL, target, JWT, and organization settings are provider concerns,
  not Flue adapter options.
- A declared image/snapshot, network policy, resource size, retention policy, and cleanup
  owner for production use.

## How to

1. Add the documented adapter blueprint:

   ```bash
   bunx flue add sandbox daytona
   ```

2. Review `<source-root>/sandboxes/daytona.ts`; the current marker is
   `flue-blueprint: sandbox/daytona@1`.
3. Provide `DAYTONA_API_KEY` to the trusted application process.
4. Create the provider sandbox inside Flue's lazy factory, not during agent render.
5. Configure image, snapshot, resource, network, volume, and lifecycle settings through
   `Daytona.create(...)` before adapting the result.
6. Exercise the same cleanup path used for failures and abandoned jobs.

## Exact `useSandbox` integration

```ts
'use agent';
import { Daytona } from '@daytona/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona';

export function Assistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    async createSandbox(options) {
      const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
      const sandbox = await client.create();
      return daytona(sandbox).createSandbox(options);
    },
  });
  return 'Run repository work only inside the Daytona sandbox.';
}
```

The provider SDK also supports reconnecting with `client.get(idOrName)`. A durable
mapping can therefore resolve a sandbox keyed by `options.id` before calling
`daytona(sandbox).createSandbox(options)`. Keep that mapping in application storage,
not only in process memory.

## Lifecycle

- `useSandbox()` declares a lazy `SandboxFactory`; Flue calls `createSandbox({ id })`
  once per initialized harness.
- The adapter asks Daytona for its work directory and falls back to `/home/daytona`.
- The generated adapter polls provider state during operations so stopped, destroyed,
  or failed resources surface as `SandboxDiedError`.
- The same Flue sandbox is shared by all sessions and subagents in that harness.
- Flue has no `dispose()` and never calls Daytona `stop()` or `delete()`.
- Provider cleanup remains explicit: `client.stop(sandbox)` retains a stopped resource;
  `client.delete(sandbox)` destroys it.
- Daytona lifecycle parameters can pause, stop, archive, or delete idle resources and
  enforce a wall-clock TTL independently of Flue.

## Recommended patterns

- Label or name sandboxes with a stable application tenant/agent identifier.
- Use `client.get(...)` before `create(...)` when the workspace must survive restarts.
- Set `autoPauseInterval` or `autoStopInterval` and a separate `ttlMinutes` safety net.
- Use `autoDeleteInterval` or explicit deletion for ephemeral jobs.
- Prefer snapshots and warm pools over installing a toolchain on every initialization.
- Use `domainAllowList`, `networkAllowList`, or `networkBlockAll` for untrusted code.
- Mount provider secrets with allowed hosts rather than putting raw values into files.
- Choose `useSandbox(factory, { cwd })` to narrow workspace discovery when the provider
  work directory contains unrelated data.

## Avoid

- Do not create a Daytona sandbox directly during every agent render.
- Do not rely on Flue to stop or delete provider resources.
- Do not share writable sandboxes across untrusted tenants.
- Do not use an outbound proxy alone as a security boundary; pair it with provider
  network enforcement.
- Do not assume conversation persistence reconnects a Daytona sandbox.
- Do not pass secrets in prompts or persist them in the workspace unnecessarily.

## Gotchas, security, cost, and persistence

- Daytona process timeouts use whole seconds. The adapter rounds Flue's millisecond
  `timeoutMs` up, never down.
- The provider supports recursive deletion but not Flue's `force` removal semantics;
  requesting `force` throws before mutation.
- Daytona's process API does not expose caller cancellation through this adapter. Flue
  rejects promptly, but an abandoned remote command may continue.
- A paused, stopped, archived, or volume-backed sandbox has different availability and
  cost characteristics. Define which state means "durable" for the application.
- Default lifecycle settings vary by sandbox class and provider release; set explicit
  values instead of relying on defaults for cost-sensitive workloads.
- `requestTimeoutMs` is not the same as command or lifecycle-operation timeout.
- Provider filesystem persistence does not preserve Flue's conversation records, and a
  durable Flue database does not preserve provider files.
- Public previews and broad egress expand the trust boundary; default them off unless the
  task requires them.

## Related

- [Flue Daytona ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
- [Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
- [Daytona Sandbox SDK](https://www.daytona.io/docs/en/typescript-sdk/sandbox/)
- [Flue Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Flue Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/)
- [Flue E2B ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
- [Flue Modal ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
- [Flue Vercel Sandbox ecosystem page](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)
