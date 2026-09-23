---
title: Sandboxes
source: https://flueframework.com/docs/guide/sandboxes/
nav_section: guides
---

# Sandboxes

## What it is

A sandbox is an execution environment attached to an agent: a filesystem plus a shell where the agent reads, writes, and runs commands. An agent has none of this unless you attach one with `useSandbox()`. An agent has at most one environment at a time. Flue ships three modes behind one interface: an in-memory virtual sandbox (just-bash), `local()` binding to the host machine (Node target only), and provider-managed remote sandboxes through adapters.

## What attaching a sandbox adds

- **File and shell tools** — the agent's tool set gains `read`, `write`, `edit`, `bash`, `grep`, `glob`, all operating on the sandbox. A sandbox may replace this set with its own (see Sandbox-provided tools).
- **Workspace context** — at initialization Flue composes the working directory path, a directory listing, and the contents of `AGENTS.md` (when present) into the system prompt.
- **Workspace skills** — skill directories under `<cwd>/.agents/skills/` are discovered and offered by name, no import required.
- **Subagents** — delegates share the parent's environment. A `task` call can scope a child to a different working directory, but never to a different sandbox.
- **Harness access** — harness tools reach the same environment via `harness.sandbox`, for staging files in and out without a conversation record.

Without a sandbox: no file or shell tools, no workspace in the prompt, and `harness.sandbox` throws. Custom tools, skills, subagents, and state all still work.

## API surface

### `useSandbox()`

```ts
useSandbox(factory);
useSandbox(factory, { cwd: '/srv/checkouts/flue' });
```

Rules:

- **At most once per render.** A second call in the same render throws. It also throws inside a subagent's render — delegates share the parent's environment.
- **The factory is lazy.** Building the factory value on every render is cheap by design; the expensive work lives in `createSandbox()`, which the runtime calls once at agent initialization, never on re-renders.
- **The factory receives the agent instance id**, so adapters can key provider resources on it.
- **`cwd` scopes the working directory** inside the environment, resolved once at initialization against the sandbox's own base directory. It sets where commands run by default and where workspace discovery (`AGENTS.md`, skills, directory listing) happens.

### `SandboxFactory` (from `@flue/runtime`)

```ts
interface SandboxFactory {
  createSandbox(options: { id: string }): Promise<Sandbox>;
  tools?: SandboxToolFactory;
}
```

- `createSandbox(options)` — called once per initialized harness (one call per `init()`); every session and task session of that harness shares the returned sandbox. A rejection fails agent initialization.
- `options.id` — the agent instance id (`ctx.id`). Multiple harnesses in the same context receive the same `id`, so an adapter keying on it must tolerate repeated calls with the same value.
- No teardown verb. There is no `dispose()`. Flue never creates or destroys provider infrastructure; that belongs to the application.
- Legacy: factories implementing the pre-rename `createSessionEnv` still work (one-time deprecation warning). Deprecated aliases: `SessionEnv`, `SandboxApi`, `SessionToolFactory`, `createSandboxSessionEnv`.

### `Sandbox` — the interface every mode implements

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
  resolvePath(p: string): string;
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

This is the same object exposed to application code as `harness.sandbox`. The model never calls this surface directly — it sees the built-in tools. Operations through it are never recorded in the conversation.

Path semantics: POSIX-style, `/`-separated (`local()` on Windows uses host semantics). Relative paths resolve against `cwd`. `writeFile` must create missing parent directories — a cross-mode guarantee. `exists` never throws. `stat` throws on a missing path.

### Built-in factories

```ts
// @flue/runtime
function bash(factory: BashFactory): SandboxFactory;
type BashFactory = () => BashLike | Promise<BashLike>;

// @flue/runtime/node
function local(options?: LocalSandboxOptions): SandboxFactory;
interface LocalSandboxOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

// @flue/runtime/cloudflare
function cloudflareSandbox(
  sandbox: CloudflareSandboxStub,
  options?: { cwd?: string },
): SandboxFactory;
```

### Adapter helpers (from `@flue/runtime`)

```ts
function sandboxFromDriver(
  driver: SandboxDriver,
  cwd: string,
  options?: { onOrphanSettled?: (settlement: OrphanedExecSettlement) => void },
): Sandbox;

type SandboxToolFactory = (sandbox: Sandbox, options: SandboxToolFactoryOptions) => AgentTool<any>[];
interface SandboxToolFactoryOptions { subagents: Record<string, SubagentDefinition> }

// per-tool factories, for composing a replacement tool set
function createReadTool(sandbox: Sandbox): AgentTool;
function createWriteTool(sandbox: Sandbox): AgentTool;
function createEditTool(sandbox: Sandbox): AgentTool;
function createBashTool(sandbox: Sandbox): AgentTool;
function createGrepTool(sandbox: Sandbox): AgentTool;
function createGlobTool(sandbox: Sandbox): AgentTool;
```

`SandboxDriver` mirrors `Sandbox`'s file verbs and `exec`, except paths arrive pre-resolved (absolute) and the `writeFile` parent guarantee is handled by the wrapper.

Error type: `SandboxDiedError` (`type: 'sandbox_died'`), and `SandboxOperationUnsupportedError` for `rm` options a provider cannot honor.

### CLI

```bash
flue add sandbox e2b
flue add sandbox <docs-url>   # unsupported provider: builds the adapter from its docs
```

Creates `<source-dir>/sandboxes/<name>.ts` and installs the provider SDK.

## Patterns

### Virtual sandbox (in-memory, just-bash)

```ts
'use agent';
import { bash, useModel, useSandbox } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export function ScratchWorker() {
  useModel('anthropic/claude-haiku-4-5');
  useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));
  return 'Fetch, reshape, and summarize the data the user points you at.';
}
```

Add `just-bash` to your dependencies. Most of the standard unix toolbox works — `ls`, `sed`, `awk`, `jq`, `sort`, pipes, redirects — plus `curl` for HTTP. No real process is ever spawned.

### Seeding files and allowlisting network

```ts
'use agent';
import { bash, useModel, useSandbox } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import { exportCatalogCsv } from '../shared/catalog.ts';

export function CatalogAnalyst() {
  useModel('anthropic/claude-haiku-4-5');
  useSandbox(
    bash(
      () =>
        new Bash({
          fs: new InMemoryFs({ '/data/catalog.csv': exportCatalogCsv() }),
          network: { allowedUrlPrefixes: ['https://api.example.com/'] },
        }),
    ),
  );
  return 'Answer questions about the product catalog in /data/catalog.csv.';
}
```

Network is opt-in: `network: { allowedUrlPrefixes: [...] }`, or `dangerouslyAllowFullInternetAccess: true`.

### Staging files in and out with a harness tool

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const reviewDocument = defineTool({
  name: 'review_document',
  description: 'Review one supplied document and report findings.',
  input: v.object({ document: v.string() }),
  harness: true,

  async run({ harness, data }) {
    await harness.sandbox.writeFile('document.md', data.document);
    await harness.prompt('Review document.md and write your findings to review.md.');
    return { output: { review: await harness.sandbox.readFile('review.md') } };
  },
});
```

The model sees `document.md` appear in its workspace; none of the staging enters the conversation.

### Local sandbox (Node target)

```ts
'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function ReleaseManager() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }));
  return 'Prepare the release: check CI status, draft the changelog, tag the release.';
}
```

Working directory defaults to `process.cwd()`; override with `local({ cwd })`.

### Remote provider sandbox

```ts
'use agent';
import { Daytona } from '@daytona/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona.ts';

export function CodeRunner() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    async createSandbox(options) {
      const client = new Daytona();
      const sandbox = await client.create();
      return daytona(sandbox).createSandbox(options);
    },
  });
  return 'Clone the repository the user names, run its test suite, and report results.';
}
```

`createSandbox({ id })` receives the agent instance id. A factory that looks up an existing provider sandbox by that id before creating one gives each conversation a durable workspace that survives across messages and process restarts.

### Minimal adapter over a provider SDK

```ts
import { sandboxFromDriver, type SandboxDriver, type SandboxFactory } from '@flue/runtime';

export function myProvider(client: MyProviderClient): SandboxFactory {
  return {
    async createSandbox({ id }) {
      const sandbox = await client.findOrCreate(id);
      const driver: SandboxDriver = {/* map each SandboxDriver method to the provider SDK */};
      return sandboxFromDriver(driver, '/workspace');
    },
  };
}
```

### Cloudflare Sandbox (container-backed)

```ts
'use agent';
import { getSandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';

export function Assistant({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(cloudflareSandbox(getSandbox(env.Sandbox, id)), { cwd: '/workspace' });
}
```

Export the sandbox Durable Object class from `cloudflare.ts` and declare its binding and container image in `wrangler.jsonc`.

### Conditional attachment

```ts
'use agent';
import { useModel, usePersistentState, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function SupportEngineer() {
  useModel('anthropic/claude-sonnet-4-6');
  const [investigating, setInvestigating] = usePersistentState('investigating', false);

  useTool({
    name: 'open_investigation',
    description: 'Call when the issue needs hands-on debugging in the repository.',
    async run() {
      setInvestigating(true);
      return 'Investigation opened. The repository workspace will be attached.';
    },
  });

  if (investigating) {
    useSandbox(local({ cwd: '/srv/support/repro' }));
  }

  return investigating
    ? 'Reproduce the issue in the workspace and report your findings.'
    : 'Diagnose the issue from the conversation. Open an investigation when you need hands-on debugging.';
}
```

Presence of the `useSandbox()` call is read at initialization and again at every turn boundary. When it flips, the environment swaps before the next model call. The model is told with a single `environment` signal restating the complete current state (working directory plus the full tool, skill, and subagent rosters) and warning that files and results from the previous environment may no longer be accessible.

## Recommended use cases

- **Virtual sandbox** — `curl`-and-`jq` data work, text reshaping, scratch space, per-message file staging through a harness tool, analysis over a seeded dataset. Enough for many production agents.
- **`local()`** — development tools, CI tasks, coding agents, self-hosted automation where the host either *is* the workspace or already provides isolation (a container, a dedicated VM).
- **Remote provider sandbox** — per-conversation isolation, a full Linux toolchain, package installation, native binaries, or code you wouldn't run on your own host. Also when a workspace must persist durably across messages and restarts.
- **Cloudflare Computer** — a filesystem that survives Durable Object restarts without provisioning a container, when the work is shell-expressible.
- **Conditional attachment** — an agent that starts as a pure conversational diagnostician and only gains a workspace once it needs to touch files.

## When to use / when not to use

| Situation | Use |
|---|---|
| Agent needs to read/write files or run commands | `useSandbox()` |
| Agent only needs custom tools, skills, subagents, structured results | No sandbox — everything else works without one |
| Scratch space, HTTP + text munging, no host access | virtual sandbox via `bash(() => new Bash(...))` |
| The host machine is the workspace (coding agent, CI) | `local()` on the Node target |
| Untrusted requests, multi-tenant, code you don't trust | remote provider sandbox — **not** `local()` |
| Durable knowledge that must outlive a message | persistent state (`usePersistentState`), not virtual-sandbox files |
| Files themselves must last across messages | a real sandbox keyed on the instance id, not the virtual one |
| A privileged action the shell would need credentials for | a narrow application tool, rather than widening `local({ env })` |
| Full Linux with native binaries on Cloudflare | Cloudflare Sandbox (container), not Cloudflare Computer |
| Durable filesystem on Cloudflare, shell-expressible work only | Cloudflare Computer, not a container |

Choose the narrowest environment that supports the task: expanding it expands what model-directed work can read, change, execute, and reach.

## Gotchas and constraints

- **The virtual sandbox is ephemeral.** The filesystem starts empty and is rebuilt fresh each time the runtime initializes the agent for new work. Files written while processing one message are gone by the next.
- **The virtual sandbox has no network by default.** `curl` reaches only `allowedUrlPrefixes`, unless you set `dangerouslyAllowFullInternetAccess: true`.
- **`local()` is not an isolation boundary, by design.** Do not use it for untrusted requests or multiple tenants.
- **`local()` does not inherit `process.env`.** Default allowlist: `PATH`, `HOME`, `USER`, `LOGNAME`, `HOSTNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `TMPDIR`, `TMP`, `TEMP`. Everything else is a per-variable opt-in via `options.env`; set a key to `undefined` to drop a default. The snapshot is taken once at construction — later `process.env` mutations are not picked up. `env: { ...process.env }` hands the model's shell your whole host environment, secrets included.
- **`local()` exec details.** Real `bash` when present, else the platform default shell. On POSIX the child leads its own process group; abort/timeout signals the group with `SIGTERM` escalating to `SIGKILL` after a 2-second grace. Captured output is capped at 64 MiB (exceeding it kills the tree, `exitCode: 1` plus a truncation note on stderr). A `timeoutMs` expiry resolves as `ShellResult` with `exitCode: 124`; a caller `signal` abort rejects with `AbortError` instead.
- **Remote cancellation is usually not real.** A cancelled command always rejects promptly, but most provider SDKs have no mid-flight cancellation — the remote command keeps running in the background as an *orphan* and its eventual output is discarded rather than appearing later in the conversation. Providers whose SDKs do support cancellation (Vercel, Mirage) stop the command for real. `local()`'s process-group kill actually stops it.
- **Orphan bookkeeping.** `sandboxFromDriver`'s `onOrphanSettled` is the only place an orphan's eventual settlement surfaces; without it the settlement is discarded.
- **A `cwd` override drops an adapter's native surface.** `useSandbox(factory, { cwd })` wraps the sandbox and exposes only the standard `Sandbox` members; extra properties an adapter attached are not forwarded.
- **Sandbox-provided `tools` replace the whole default six-tool set** (`read`, `write`, `edit`, `bash`, `grep`, `glob`) for that agent. Check an integration's docs before assuming ordinary file or command tools exist. Framework tools (`task`, `activate_skill`, `read_skill_resource`) and custom tools are appended separately. `task`, `activate_skill`, `read_skill_resource`, `finish`, `give_up` are reserved names.
- **The system prompt stays frozen across a swap.** It keeps describing the workspace discovered at initialization until the next compaction re-discovers against the current environment.
- **A swap invalidates the provider's prompt cache**, because it rewrites the native tools array.
- **Only *presence* of `useSandbox()` is observable.** Factories are fresh objects every render, so replacing sandbox A with sandbox B while staying attached doesn't swap mid-run — it takes effect when the next submission initializes.
- **Cloudflare Computer runs a JavaScript shell** (just-bash in a Dynamic Worker): coreutils and text tools work, native binaries and package managers do not. Import its helpers (`getComputerSandbox`, `getComputerWorkspace`) from your generated adapter file, not from `@flue/runtime/cloudflare`.
- **Packaged-skill files are not in the sandbox.** They are served read-only at `/.flue/packaged-skills/<skill-id>/…` via a `readFile` overlay on the env handed to tool factories. Shell commands cannot see that root; `harness.sandbox` and `useTool` handlers see the real env.
- **`stat` fields may be absent.** Adapters must not fabricate `isSymbolicLink`/`size`/`mtime`; `local()` populates all of them.

## Related

- [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/) — the hook model `useSandbox()` participates in; persisted state.
- [Agent API](https://flueframework.com/docs/reference/agent-api/) — full `useSandbox(...)` and `harness.sandbox` contracts.
- [Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/) — `SandboxFactory`, `Sandbox`, `SandboxDriver`, tool factories, built-in factories.
- [Ecosystem: Sandboxes](https://flueframework.com/docs/ecosystem/#sandboxes) — Daytona, E2B, Modal, Cloudflare Sandbox, Cloudflare Computer.
- [Node.js target](https://flueframework.com/docs/guide/node-target/#local-sandbox) — `local()` reference and host deployment.
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/#cloudflare-sandbox) — container-backed sandboxes on Workers.
- [Durability](https://flueframework.com/docs/guide/durability/#keep-workspace-state-separate) — conversation persistence and workspace persistence are independent.
- [Tools](https://flueframework.com/docs/guide/tools/#harness-tools) — harness tools.
- [Skills](https://flueframework.com/docs/guide/skills/#workspace-skills) — workspace skill discovery.
- [Subagents](https://flueframework.com/docs/guide/subagents/#what-a-subagent-inherits) — what a delegate inherits.
- [flue add](https://flueframework.com/docs/cli/add/) — the sandbox adapter blueprint.
