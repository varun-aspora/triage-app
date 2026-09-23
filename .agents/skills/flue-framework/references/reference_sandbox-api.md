---
title: Sandbox Adapter API
source: https://flueframework.com/docs/reference/sandbox-api/
bundled_docs: bunx flue docs read reference/sandbox-api
version: 2.0.8
reviewed: 2026-09-17
---

# Sandbox Adapter API

## What and when

A sandbox adapter maps a provider SDK, container, host, or in-memory shell onto Flue's universal filesystem/command contract. Use this reference when authoring an adapter or scripting `harness.sandbox`. The model never invokes `Sandbox` directly; it invokes model-facing tools layered over it.

Flue owns path scoping, standard tool behavior, and orchestration. The adapter owns provider resource lookup/provisioning policy, exact filesystem semantics, timeout forwarding, real cancellation when available, and liveness detection.

## Public API index

| API/type | Import | Purpose |
| --- | --- | --- |
| `SandboxFactory`, `Sandbox`, `SandboxDriver` | `@flue/runtime` | Factory, universal surface, and minimal adapter surface. |
| `sandboxFromDriver()` | `@flue/runtime` | Add path resolution, write-parent retry, and abort/orphan handling. |
| `SandboxToolFactory` | `@flue/runtime` | Replace the default model-facing sandbox tool group. |
| `createReadTool` etc. | `@flue/runtime` | Compose standard tools individually. |
| `bash()` / `BashLike` | `@flue/runtime` | Wrap a just-bash-compatible in-memory environment. |
| `local()` | `@flue/runtime/node` | Bind to host filesystem/processes; Node only. |
| `cloudflareSandbox()` | `@flue/runtime/cloudflare` | Wrap a structural Cloudflare Sandbox stub. |
| `SandboxDiedError` | `@flue/runtime` | Infrastructure liveness failure. |
| `SandboxOperationUnsupportedError` | `@flue/runtime` | Requested option cannot be honored safely. |

Deprecated aliases remain runtime-compatible: `SessionEnv`, `SandboxApi`, `SessionToolFactory`, `createSandboxSessionEnv`, and factory method `createSessionEnv`. New adapters use current names.

## Factory contract

```ts
interface SandboxFactory {
  createSandbox(options: { id: string }): Promise<Sandbox>;
  tools?: SandboxToolFactory;
}
```

- The factory object must be cheap; an agent creates one on each render.
- `createSandbox()` runs once per initialized harness (`init()`), not per render/message. All sessions and tasks of that harness share the result.
- `id` is the agent instance ID. Multiple harnesses can call with the same ID, so provider resource lookup must be repeat-safe.
- Rejecting initialization fails the agent init.
- There is no teardown callback. Flue does not delete, terminate, kill, or otherwise own provider infrastructure.
- Only `id` is supplied; capture provider configuration in the factory closure.

If `useSandbox(factory, { cwd })` is used, the runtime resolves/normalizes that value through the returned sandbox, scopes relative files and exec cwd, and exposes only standard members. The adapter must not apply this agent-level override itself. Extra native properties are dropped by the scoping wrapper.

## `Sandbox` contract

```ts
interface Sandbox {
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ShellResult>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  cwd: string;
  resolvePath(path: string): string;
}

interface ShellResult { stdout: string; stderr: string; exitCode: number }

interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtime?: Date;
}
```

Paths are POSIX except host semantics in `local()` on Windows. Every file verb accepts absolute or relative paths; relative paths use absolute `cwd`. `resolvePath()` does not touch storage and must canonicalize equivalent spellings identically because write/edit locking uses it.

File requirements:

- `readFile` is UTF-8; `readFileBuffer` is raw bytes.
- `writeFile` creates missing parent directories before success, in every mode.
- `stat` and `readdir` throw on missing/wrong kinds; `readdir` returns names, not paths.
- `exists` never throws.
- `rm` honors `recursive` and `force` exactly. If impossible, throw unsupported before mutation.
- Optional stat fields are omitted when unavailable, never fabricated.
- For symlinks, target data determines file/directory/size/mtime while the path itself determines `isSymbolicLink`.

The exact object is exposed as `harness.sandbox`, including custom native properties unless a `cwd` scoping wrapper is active. Calls made through it are not recorded in the conversation.

### Exec requirements

- Completed commands, including non-zero exits, resolve `ShellResult`. Rejection is for transport/infrastructure failure and caller abort.
- Relative per-call cwd resolves against sandbox cwd; missing cwd uses sandbox cwd.
- Per-call env layers over adapter-defined base env.
- Forward `timeoutMs` to the provider's native timeout, converting and rounding up when necessary.
- Adapter-enforced deadline expiry resolves exit code `124` with details on stderr.
- Caller signal abort rejects promptly as `DOMException` `AbortError`, with signal reason as `cause`.
- Forward signal only when the provider really cancels/kills. Otherwise the remote command may continue as an orphan after caller rejection.

## `sandboxFromDriver()` and driver responsibilities

```ts
function sandboxFromDriver(
  driver: SandboxDriver,
  cwd: string,
  options?: { onOrphanSettled?: (value: OrphanedExecSettlement) => void },
): Sandbox;
```

`SandboxDriver` mirrors all file/exec methods, but receives already-resolved absolute paths. The wrapper:

- POSIX-resolves file and exec paths.
- Retries a failed write once after recursive parent creation; retry failure is authoritative.
- Rejects an already-aborted exec before invoking the driver.
- Races an in-flight driver promise against signal abort and releases the caller promptly.
- Consumes eventual orphan fulfillment/rejection to prevent a second conversation outcome or unhandled rejection.

```ts
interface OrphanedExecSettlement {
  command: string;
  startedAt: Date;
  abortedAt: Date;
  settledAt: Date;
  result?: ShellResult;
  error?: unknown;
}
```

`onOrphanSettled` is out-of-band reporting for logging, billing, or reaping. Without it, the late settlement is discarded. Even cancel-capable providers can briefly create an orphan until cancellation confirms.

Driver responsibilities:

- Return `Uint8Array`, not provider-native buffer wrappers; convert strings to UTF-8 as needed.
- Let missing-parent writes fail so the wrapper can perform its standardized retry.
- Catch missing-path errors in `exists` and return false.
- Implement `rm` flags faithfully or reject before changing anything.
- Forward the native timeout even when signal is also present; the two controls are independent.
- Do not add a second local abort race or duplicate pre/post abort checks.
- Detect sandbox death separately from caller cancellation and reject `SandboxDiedError`.
- Ensure in-flight calls settle when provider infrastructure dies when the SDK permits it. Otherwise document that a call can hang until the outer operation aborts.

`SandboxOperationUnsupportedError` takes `{ operation, provider, options }`, has type `sandbox_operation_unsupported`, and preserves those values in `meta`.

### End-to-end adapter skeleton

```ts
import {
  sandboxFromDriver,
  type SandboxDriver,
  type SandboxFactory,
} from '@flue/runtime';

export function remoteSandbox(client: ProviderClient): SandboxFactory {
  return {
    async createSandbox({ id }) {
      const resource = await client.findOrCreate(id);
      const driver: SandboxDriver = {
        readFile: (path) => resource.readText(path),
        readFileBuffer: async (path) => new Uint8Array(await resource.read(path)),
        writeFile: (path, content) => resource.write(path, content),
        stat: (path) => resource.stat(path),
        readdir: (path) => resource.listNames(path),
        exists: async (path) => {
          try { return await resource.exists(path); } catch { return false; }
        },
        mkdir: (path, options) => resource.mkdir(path, options),
        rm: (path, options) => resource.rm(path, options),
        exec: (command, options) => resource.exec(command, options),
      };
      return sandboxFromDriver(driver, '/workspace', {
        onOrphanSettled: (settlement) => client.recordOrphan(settlement),
      });
    },
  };
}
```

Map actual provider options and normalize results; the skeleton does not imply provider APIs have these names.

## Model-facing tool factory

```ts
type SandboxToolFactory = (
  sandbox: Sandbox,
  options: { subagents: Record<string, SubagentDefinition> },
) => AgentTool<any>[];
```

When `factory.tools` exists, it replaces the default sandbox group: `read`, `write`, `edit`, `bash`, `grep`, `glob`. It is synchronous, runs whenever tool lists are assembled (init and each turn boundary), and returns a fresh array.

The runtime separately appends `task`, skill tools, custom tools, and result tools. Reserved names are `task`, `activate_skill`, `read_skill_resource`, `finish`, and `give_up`; any cross-group collision throws `ToolNameConflictError`.

Use `createReadTool`, `createWriteTool`, and `createEditTool` for file-only sandboxes. Add `createBashTool`, `createGrepTool`, and `createGlobTool` only when `exec` works. The `AgentTool` element type comes from `@earendil-works/pi-agent-core` and is not re-exported.

Tool behavior details:

- Write/edit operations in one parallel tool batch lock by resolved path; arbitrary bash mutation is not synchronized.
- Bash converts seconds to `timeoutMs` and also composes a timeout signal backstop.
- Grep probes `rg --version` once with a 10-second deadline, then falls back to `grep -rnH`.
- Glob shells out to `find -name`.

### Packaged-skill overlay

Tool factories receive a sandbox whose `readFile` recognizes `/.flue/packaged-skills/<skill-id>/...` from the in-memory bundle. Other methods pass through; shell cannot see this virtual root. Unknown virtual files throw a Flue-prefixed not-found error, and binary resources are base64 text wrapped to 76 columns. `harness.sandbox` and custom tool handlers see only the real adapter filesystem.

## Built-in target differences

### `bash(factory)`

Wraps structural `BashLike` (`exec`, `getCwd`, `fs`) as an in-memory factory. Invalid duck types throw `[flue] BashFactory must return a Bash-like object.` just-bash has no native timeout, so the wrapper merges a timeout-derived signal with caller cancellation. Write parent creation is standardized.

### `local(options?)` - Node only

Defaults cwd to `process.cwd()`. It exposes the host without isolation. Shell env starts from a fixed allowlist (`PATH`, home/user/shell/locale/timezone/terminal/temp keys), snapshotted at construction; `options.env` adds/removes keys and per-call env layers above it. Passing all `process.env` may expose secrets.

Commands use real bash when available. POSIX cancellation kills the process group with SIGTERM then SIGKILL after two seconds. Timeouts resolve 124; caller abort rejects; spawn/non-zero failures resolve results. Output is capped at 64 MiB.

### `cloudflareSandbox(stub, { cwd? })` - Cloudflare

Wraps a structural `@cloudflare/sandbox` Durable Object stub and defaults cwd to `/workspace`. Runtime has no direct package dependency on the provider SDK.

## Recommended patterns

- Key durable provider workspaces by instance ID using repeat-safe find-or-create logic.
- Build adapters from `SandboxDriver`; keep path/abort mechanics in `sandboxFromDriver`.
- Forward provider-native timeout and verified cancellation independently.
- Offer only tools the environment can implement correctly.
- Use orphan callbacks for billing and remote-process cleanup.

## Avoid

- Do not provision expensive resources while constructing the factory or rebuild per message.
- Do not delete provider infrastructure on Flue's behalf; no lifecycle contract authorizes it.
- Do not silently ignore unsupported `rm` options, fabricate stat metadata, or reject ordinary non-zero exits.
- Do not duplicate the wrapper's signal race or conflate sandbox death with caller abort.
- Do not combine native sandbox extensions with `useSandbox(..., { cwd })` and expect them to survive.

## Gotchas and errors

- Abort can release the caller while an uncancellable command keeps mutating the workspace.
- The model tool sandbox has a packaged-file overlay; `harness.sandbox` does not.
- A sandbox with no command execution still implements all file verbs and throws from `exec` while omitting exec-backed tools.
- Provider timeout units must round up, never down.
- `writeFile` parent creation is a hard cross-adapter guarantee.

## Related

- [Sandboxes guide](https://flueframework.com/docs/guide/sandboxes/)
- [Agent hooks API](https://flueframework.com/docs/reference/agent-hooks-api/)
- [Agent behavior](https://flueframework.com/docs/reference/agent-behavior/)
- [Errors reference](https://flueframework.com/docs/reference/errors/)
- [Sandbox ecosystem](https://flueframework.com/docs/ecosystem/#sandboxes)
