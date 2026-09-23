---
title: Configuration
source: https://flueframework.com/docs/reference/configuration/
bundled_docs: bunx flue docs read reference/configuration
version: 2.0.8
reviewed: 2026-09-17
---

# Configuration

## What and when

Reference for the `flue.config.ts` file, the `flue()` Vite plugin and its option merging, target
detection, and how `vite dev`, `vite build`, and `flue run` each resolve configuration. Read this
when scaffolding a project, deciding where `app`/`db`/`cloudflare` entries live, wiring the
Cloudflare Vite plugin, or debugging why a config field didn't take effect for one of the three
consumers.

Two authoring surfaces and one programmatic module:

- **`flue.config.ts`** — optional project-root file: build target, entry-module paths, `'use
  agent'` scan scope.
- **Inline options to `flue()`** — the Vite plugin accepts the same fields and merges them over
  the discovered file, per field.
- **`@flue/runtime/config`** — the module implementing discovery, validation, and resolution, for
  hosts and tooling.

Two consumers read configuration: the `flue()` Vite plugin (`vite dev`, `vite build`, `vite
preview`) and `flue run`. Per-consumer behavior is in "Resolution by consumer" below.

## Public API index

| API | Import | Purpose |
| --- | --- | --- |
| `defineConfig()` | `@flue/runtime/config` | Type-check a `flue.config.ts` default export. |
| `FlueConfig` | `@flue/runtime/config` | The config field shape (also `flue()`'s inline options). |
| `flue()` | `@flue/vite` | The Vite plugin; returns `Plugin[]`. |
| `flueWorkerConfig()` | `@flue/vite` | Cloudflare sibling-plugin `config` customizer. |
| `FlueVitePluginApi` | `@flue/vite` | Read surface (`resolved`) exposed on the plugin's `api`. |
| `parseFlueConfig()`, `mergeFlueConfig()` | `@flue/runtime/config` | Validate / merge raw config values. |
| `resolveFlueConfigPath()`, `loadFlueConfig()`, `loadFlueConfigModule()` | `@flue/runtime/config` | Discover, evaluate, and load the config file. |
| `resolveSourceRoot()`, `discoverProjectEntry()`, `resolveFlueProject()` | `@flue/runtime/config` | Filesystem resolution helpers. |
| `ResolvedFlueProject` | `@flue/runtime/config` | The fully resolved project layout. |
| `FLUE_CONFIG_BASENAMES`, `PROJECT_ENTRY_EXTENSIONS` | `@flue/runtime/config` | The basename/extension priority constants. |

## `flue.config.ts`

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({ target: 'node' });
```

Optional; every field optional; must be the module's **default export**. A module without an
object default export fails: `[flue] <file> must export a config object as the default export.`

### `defineConfig()`

```ts
function defineConfig(config: FlueConfig): FlueConfig;
```

Returns the config unchanged — exists for type checking/editor completion. A plain object default
export is equally valid.

### File discovery

Searched in the project root (the Vite root for `flue()`, the working directory for `flue run`),
basenames tried in priority order (first hit wins): `flue.config.ts`, `flue.config.mts`,
`flue.config.mjs`, `flue.config.js`, `flue.config.cjs`, `flue.config.cts`.

Several coexisting files: `flue()` logs a warning naming the winner; `flue run` selects silently
by the same priority. There is no user-facing option to point either consumer at a differently
named file — an explicit path exists only on `resolveFlueConfigPath()`.

### Module evaluation

Evaluated with Node's native dynamic `import()`, cache-busted on every load — **not** through Vite.
Vite aliases/plugins/transforms do not apply; every import in the config file must resolve by Node
itself.

- Requires Node ≥ 22.19 or ≥ 23.6 for TypeScript config files (native type-stripping). Older Node:
  `[flue] Cannot load <file>: this Node (v…) does not support TypeScript natively.`
- Only **erasable** TypeScript syntax is accepted — `enum`, `namespace` with runtime code,
  parameter properties, decorators all fail.

### Validation

Strict against the field set below: an unknown field is an error (`flue run` is the exception — it
drops unknown keys instead of rejecting); a non-object value fails with `[flue] <source> must be a
config object.`; field-level failures report together as `[flue] Invalid config in <source>:`
followed by one line per field.

## Configuration fields

```ts
interface FlueConfig {
  target?: 'node' | 'cloudflare';
  app?: string;
  db?: string;
  cloudflare?: string;
  agents?: string;
  providers?: string[];
  tracing?: boolean;
}
```

Exported from `@flue/runtime/config`; the same shape is accepted by the config file's default
export and by `flue()` inline options.

### `target`

- `'node'` — self-starting Node.js server (`guides_project-layout.md`, Node target guide).
- `'cloudflare'` — Workers-compatible app with one Durable Object class per agent.
- Default unset: `flue()` auto-detects from the Vite plugin array (see Target detection below); an
  explicit value overrides detection.
- `flue run` ignores `target` entirely — always Node-local.

### `app`

Path to `app.ts` — the route map and the only module the Vite plugin requires to exist.

- Default: entry lookup `app.{ts,mts,js,mjs}` under the source root. Missing default: `vite dev`/
  `vite build` fail with `[flue] No app entry found. …`.
- Relative value resolves from the config file's directory. Explicit path not existing:
  ``[flue] Configured `app` entry not found: <path>``.

### `db`

Path to `db.ts` (default export: the persistence adapter). **Node target only.**

- Default: `db.{ts,mts,js,mjs}` under source root; unresolved falls back to Node's built-in SQLite
  default.
- Same resolution/existence rules as `app`.
- **On Cloudflare, a resolved `db` entry (discovered or explicit) is a hard error:**
  `[flue] Custom persistence (db.ts) is not supported on the Cloudflare target. …` Cloudflare
  agents persist in Durable Object SQLite.

### `cloudflare`

Path to `cloudflare.ts` (default export: contributes Worker handlers like `scheduled`, `queue`, …
to the generated Worker entry).

- Default: `cloudflare.{ts,mts,js,mjs}` under source root. Same resolution rules as `app`.
- Consumed only by the Cloudflare target; a resolved entry is inert on Node.

### `agents`

A glob narrowing the `'use agent'` scan, relative to the source root (e.g. `'agents/**/*.ts'`).

- Default: the entire source root recursively (`**/*.{ts,mts,js,mjs}`).
- Always restricted to `.ts`/`.mts`/`.js`/`.mjs`; `node_modules/`, `dist/`, `output/`,
  `.wrangler/` always excluded; dot-directories not matched.
- `flue run` ignores `agents` — it takes an explicit module path and performs no scan.

### `providers`

Providers registered at server start, by ID (e.g. `['anthropic', 'openai']`). Each entry becomes a
`@earendil-works/pi-ai/providers/<id>` factory import in the generated entry — `'cloudflare'`
selects Flue's own Workers AI binding provider instead — so only listed providers ship in the
build.

- Default unset: every built-in registers (Workers AI binding included on Cloudflare).
- Set: the list is **exhaustive**. On Cloudflare, `cloudflare/...` models require `'cloudflare'` in
  the list. On Node, `'cloudflare'` is a config error (the binding only exists on Workers).
- Entries validated as lowercase alphanumerics/dashes; an ID Pi doesn't ship fails the build with
  the unresolvable import path.
- `setProvider()` registrations in `app.ts` are unaffected and always win over a same-ID listed
  provider.
- `flue run` ignores `providers` — always registers the full built-in set.

Full semantics: `reference_provider-api.md#the-providers-config`.

### `tracing`

Agent tracing on the Cloudflare target (the built-in `createCloudflareTracing()` install). Inert
on Node.

- Default unset: tracing on (spans flow once Workers Traces is enabled on the account; until then
  a platform no-op).
- `false` drops it from the build.
- An explicit `instrument(createCloudflareTracing(...))` at `app.ts` module scope always replaces
  the built-in install, whatever this field is set to.

## Entry-path resolution

Both consumers resolve configured fields the same way:

- **Source root** — `<root>/.flue` when it exists as a directory, else `<root>/src`, else the
  project root itself.
- **Default entry lookup** — an unset `app`/`db`/`cloudflare` falls back to
  `<sourceRoot>/<field>.<ext>`, trying `ts`, `mts`, `js`, `mjs` in order. A missing default entry is
  not an error at resolution time; whether it's required is the consumer's call (`app` required by
  `vite dev`/`vite build`; nothing required by `flue run` or `vite preview`).
- **Explicit paths** — resolve from the config file's directory (from the project root when the
  value came only from inline `flue()` options) and must exist; a missing explicit entry throws
  ``[flue] Configured `<field>` entry not found: <path>``.

## The `flue()` Vite plugin

```ts
import { flue } from '@flue/vite';
function flue(config?: FlueConfig): Plugin[];
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { flue } from '@flue/vite';

export default defineConfig({ plugins: [flue({ target: 'node' })] });
```

Makes a Vite project a Flue application. Returns an array of plugins; the core plugin is named
`flue`. Adding it twice to the same config is an error.

Options are a `FlueConfig`. During Vite config resolution the plugin:

1. Validates inline options (failures name `inline flue() options` as the source).
2. Discovers and loads `flue.config.*` from the Vite root.
3. Merges inline options over the file, per field: a defined inline field wins; `undefined` falls
   through to the file. All fields are scalars — no deep merging.
4. Resolves the project layout and, outside preview, runs the `'use agent'` scan.

Resolves against the Vite root (`root`, else the working directory). If another plugin changes
`root` after `flue()` resolved, resolution fails, directing you to set `root` in the Vite config
itself.

### Target detection

1. The merged `target` field, when set.
2. `'cloudflare'` when `@cloudflare/vite-plugin` is present in the resolved Vite plugin array.
3. `'node'` otherwise.

Cloudflare wiring is validated at config-resolution time, each failure distinct:

- `target: 'cloudflare'` without `@cloudflare/vite-plugin` in the plugin array.
- `cloudflare()` listed **before** `flue()` — `flue()` must precede it, because the sibling's
  config resolution invokes Flue's worker-config customizer and needs the completed project
  resolution and agent scan.
- The Cloudflare plugin present but not visible to `flue()` as a plain `plugins` entry (wrapped in
  a Promise, or injected by another plugin).
- **`cloudflare()` invoked without `config: flueWorkerConfig()`** — the most common
  misconfiguration; see the callout below.

> **Docs disagree here.** The deploy guide's example shows bare `cloudflare()`; this page states
> that configuration is a config-resolution error requiring
> `cloudflare({ config: flueWorkerConfig() })`. Follow this page and `flueWorkerConfig()` below —
> verify against the installed `@flue/vite` version if the two keep diverging. See SKILL.md's
> "Where the docs contradict themselves".

### Vite configuration set by the plugin

Every target/mode: `appType: 'custom'`; dedupes `@flue/runtime` and `hono` to a single copy per
module graph.

**Node target**, `vite build` additionally forces: `build.ssr: true`, `build.target: 'node22'`,
the two-entry rolldown input (self-starting `server.mjs` plus the non-listening `app.mjs` chunk it
imports), `.mjs` entry/chunk names, ES module output. Node builtins, `package.json` dependencies
(with subpaths), and Flue's optional native dependencies stay external. User-set values at these
forced paths are overridden with a warning, not an error. The user keeps:

- `build.outDir` — default `'dist'`. An output directory resolving to (or containing) the project
  root or source root — including through symlinks/junctions — is rejected (the build empties it).
- `build.sourcemap` — default `true`.
- `build.emptyOutDir` — left to Vite's own default/fencing.

`vite dev`/`vite preview` (both targets): `server.cors`/`preview.cors` default to a
localhost-only credentialed policy exposing the durable-stream coordination headers
(`Stream-Next-Offset`, `Stream-Up-To-Date`, `Location`); an explicit user value replaces the
default. Deployed servers apply no CORS.

Node target `vite dev` also loads the project's `.env` file set (`.env`, `.env.local`,
`.env.[mode]`, `.env.[mode].local`) into `process.env` with shell-wins semantics, matching `flue
run`. Cloudflare dev-time variables (`.dev.vars`) belong to the Cloudflare plugin instead.

**Cloudflare target**: the plugin imposes no build configuration; `@cloudflare/vite-plugin` owns
the Worker build, dev server, and preview.

### Virtual modules

Resolvable only inside module graphs the plugin owns:

| Module | Contents |
| --- | --- |
| `virtual:flue/app` | Resolved `app` entry (required). |
| `virtual:flue/db` | Resolved `db` entry, or a stub exporting `undefined` (default adapter used). |
| `virtual:flue/agents` | Scanned `'use agent'` module set. |
| `virtual:flue/providers` | Provider registration from `providers` (or the all-built-ins default). |
| `virtual:flue/server` | Node server bootstrap. |
| `virtual:flue/worker` | Generated Cloudflare Worker entry (wrangler `main`; one DO class per agent). |

### `FlueVitePluginApi`

```ts
interface FlueVitePluginApi { readonly resolved: FlueResolvedProjectInfo | undefined; }

interface FlueResolvedProjectInfo {
  readonly config: FlueConfig;
  readonly configPath: string | undefined;
  readonly project: ResolvedFlueProject;
  readonly target: 'node' | 'cloudflare';
  readonly agents: readonly AgentScanResult[];
}
```

The core `flue` plugin exposes this on its `api` field for other tools. `resolved` is `undefined`
until Vite config resolution completes. `agents` is live in dev (reflects the latest re-scan).

## `flueWorkerConfig()`

```ts
import { flue, flueWorkerConfig } from '@flue/vite';
function flueWorkerConfig(): FlueWorkerConfigCustomizer;
type FlueWorkerConfigCustomizer = (config: object) => void;
```

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';

export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
```

Creates the worker-config customizer for the Cloudflare target, passed to the sibling plugin's
`config` option. **Must be called after `flue()`** in the same Vite config evaluation — calling it
first throws `[flue] flueWorkerConfig() was called before flue(). …`. Runs inside the Cloudflare
plugin's config resolution, against the active environment's resolved config
(`CLOUDFLARE_ENV`), contributing exactly four things:

- `main` — set to `virtual:flue/worker`, unless the user's wrangler config sets its own `main`
  (which can re-export it: `export * from 'virtual:flue/worker'`).
- One Durable Object binding per scanned agent. A user binding occupying a Flue-reserved name must
  match what Flue would generate (same `class_name`, no `script_name`/`environment`) or throws
  `[flue] wrangler config durable object binding "…" is reserved by Flue. …`.
- The `nodejs_compat` compatibility flag, unioned into `compatibility_flags`.
- Validation of a user-set `compatibility_date`: must be `YYYY-MM-DD` and **at least
  `2026-04-01`** — an older date is a hard error, not a silent bump. Unset is left to the Cloudflare
  plugin's own default.

Everything else in the wrangler config (`name`, user Durable Objects, containers, R2 buckets,
migrations) passes through untouched — Flue never reads/merges/writes a wrangler config file.
Under `vite preview` the customizer is a no-op (preview serves the already-built Worker output).

## Resolution by consumer

### `vite dev`

Resolution runs in the plugin's `config` hook: discover `flue.config.*`, merge inline options,
resolve entries, require `app`, scan agents. The dev server keeps resolution live:

- An edit to the discovered file — or the creation of any candidate basename when none existed —
  **restarts** the dev server, re-running full resolution.
- A change to the scanned agent set (file added/removed, directive/identity change) regenerates
  `virtual:flue/agents` and reloads the app on Node; on Cloudflare it restarts the dev server.
- On Cloudflare, an authored `wrangler.jsonc`/`.json`/`.toml` appearing/disappearing at the root
  restarts the dev server; edits to an existing file are handled by the Cloudflare plugin.
- Scan failures during watching (mid-edit syntax, duplicate identities) are logged, leaving the
  last good agent set in place.

### `vite build`

Same resolution as `vite dev`, once. `app` required; the agent scan must succeed; on Node the
forced build configuration and `build.outDir` safety check apply; on Cloudflare the ordering/wiring
validation applies and the merged wrangler config is emitted into the build output by the
Cloudflare plugin.

### `vite preview`

Artifact-based: the config file is still discovered/loaded/validated and entries resolved, but
nothing is required, no agent scan runs, nothing is generated. Node preview serves the built
`dist/`; Cloudflare preview is owned entirely by the Cloudflare plugin (workerd over the built
Worker).

### `flue run`

Resolves configuration directly, without Vite config or the plugin:

- `flue.config.*` discovered from the **working directory** (also the project root);
  `vite.config.ts` is never read.
- Unknown config keys are **dropped** before validation instead of rejected.
- `target` and `agents` are ignored: the run is always Node-local, and the agent module is the
  explicit `<path>` argument, not a scan result.
- `db` is honored; without one, uses a SQLite database at
  `node_modules/.cache/flue/run.db` under the project root.
- `app` and `cloudflare` are resolved but unused. Explicit-path existence checks still apply.

## `@flue/runtime/config`

Host-side tooling — touches the filesystem — imported from build/CLI code, never from agent
modules. `defineConfig()` and `FlueConfig` are above.

```ts
function parseFlueConfig(value: unknown, source?: string): FlueConfig;
function mergeFlueConfig(file: FlueConfig, inline: FlueConfig): FlueConfig;

interface ResolveFlueConfigPathOptions { cwd: string; configFile?: string; }
function resolveFlueConfigPath(opts: ResolveFlueConfigPathOptions): string | undefined;

interface LoadedFlueConfig { configPath: string | undefined; config: FlueConfig; }
function loadFlueConfig(opts: ResolveFlueConfigPathOptions): Promise<LoadedFlueConfig>;

function loadFlueConfigModule(absConfigPath: string): Promise<Record<string, unknown>>;
function resolveSourceRoot(root: string): string;
function discoverProjectEntry(sourceRoot: string, basename: string): string | undefined;

interface ResolveFlueProjectOptions {
  root: string;
  config?: FlueConfig;
  configPath?: string;
}
function resolveFlueProject(opts: ResolveFlueProjectOptions): ResolvedFlueProject;

interface ResolvedFlueProject {
  root: string;
  sourceRoot: string;
  target: 'node' | 'cloudflare' | undefined;
  app: string | undefined;
  db: string | undefined;
  cloudflare: string | undefined;
  agents: string | undefined;
}

const FLUE_CONFIG_BASENAMES: readonly string[];
const PROJECT_ENTRY_EXTENSIONS: readonly string[]; // ['ts', 'mts', 'js', 'mjs']
```

- `parseFlueConfig()` — validates a raw config value against the strict field set; throws
  per-field diagnostics naming `source` (default `'flue config'`).
- `mergeFlueConfig()` — merges host-provided config over a discovered file config, per field.
- `resolveFlueConfigPath()` — absolute path of the project's `flue.config.*`, or `undefined`.
  `configFile` not existing throws `[flue] Config file not found: <path>` rather than returning
  `undefined`.
- `loadFlueConfig()` — discovers, evaluates, validates in one step. Returns
  `{ configPath: undefined, config: {} }` when no file exists. Throws on a missing explicit
  `configFile`, a non-object default export, or validation failure.
- `loadFlueConfigModule()` — evaluates via native dynamic `import()` (cache-busted per call);
  returns the module namespace, unvalidated.
- `resolveSourceRoot()` — `<root>/.flue` when it exists, else `<root>/src`, else `root`.
- `discoverProjectEntry()` — locates `<sourceRoot>/<basename>.<ext>` by extension priority.
  `undefined` when no candidate exists.
- `resolveFlueProject()` — resolves a validated config against the filesystem per the
  entry-path-resolution rules. Missing explicit entries throw; missing default entries resolve to
  `undefined`.

## What configuration does not cover

- **Environment variables** — `flue.config.ts` declares no secrets and reads no `.env` mapping;
  API keys/runtime variables come from `process.env`.
- **Wrangler configuration** — Worker name, routes, user bindings, containers, migrations live in
  your own `wrangler.jsonc`; Flue only contributes its derived values at build time.
- **Agent behavior** — models, tools, sandboxes, durability are configured in agent modules, not
  `flue.config.ts`. See `guides_models.md`, `guides_tools.md`.
- **Vite options** — `flue.config.ts` carries no Vite configuration; server ports, plugins, build
  overrides stay in `vite.config.ts`.

## Recommended patterns

- Keep `flue.config.ts` minimal and let inline `flue()` options carry environment-specific
  overrides (they win per field without touching the checked-in file).
- Always pair Cloudflare's `cloudflare()` with `config: flueWorkerConfig()` and put `flue()` first
  in the plugins array — treat any other ordering as broken.
- Narrow `providers` for production builds to cut bundle size; leave it unset in development for
  zero-config model access.
- Use `FlueVitePluginApi.resolved` from other Vite plugins/tools that need the scanned agent set or
  resolved target, instead of re-implementing discovery.
- Validate a hand-rolled hosting tool's config with `parseFlueConfig()`/`loadFlueConfig()` rather
  than reading `flue.config.ts` directly.

## Avoid

- Don't set `db` on the Cloudflare target — a resolved entry (discovered or explicit) is a hard
  build error.
- Don't list `'cloudflare'` in `providers` on the Node target — it's a config error.
- Don't rely on `flue run` respecting `target`, `agents`, or `providers` — all three are ignored
  there.
- Don't point `build.outDir` at the project or source root — the build empties the directory.
- Don't call `flueWorkerConfig()` before `flue()`, or omit it from `cloudflare({ config: ... })`.
- Don't expect Vite aliases/plugins to apply inside `flue.config.ts` — it's loaded via native
  `import()`, not Vite's module graph.

## Gotchas and errors

- The Cloudflare Vite plugin discrepancy above (bare `cloudflare()` vs. `flueWorkerConfig()`) is a
  known cross-doc contradiction — verify against the installed `@flue/vite` version.
- `compatibility_date` validation is a **minimum bound** (`2026-04-01`), not a fixed value — an
  older user-set date is rejected outright rather than bumped.
- `flue run` silently drops unknown config keys instead of rejecting them — a typo'd field there
  fails silently rather than loudly, unlike every other consumer.
- A `db` entry that resolves by default lookup (not just an explicit path) is still a hard error
  on Cloudflare — there is no way to have an unused `db.ts` file sitting in a project that also
  targets Cloudflare.
- Config module evaluation is cache-busted per load — a config file is safe to hot-edit, but any
  module-level side effect in it runs again on every reload.

## Related

- [Project layout](https://flueframework.com/docs/guide/project-layout/) — `src/app.ts`,
  `src/db.ts`, `src/cloudflare.ts`, source-dir resolution, `dist/`.
- [Deploy](https://flueframework.com/docs/guide/deploy/) — the build-and-deploy walkthrough on
  each target using this configuration.
- [Provider API](https://flueframework.com/docs/reference/provider-api/) — the full `providers`
  config contract and `setProvider()` interaction.
- [Database](https://flueframework.com/docs/guide/database/) — `db.ts` adapters and the Node
  persistence default.
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) — the
  `PersistenceAdapter` contract `db.ts` exports.
- [Errors Reference](https://flueframework.com/docs/reference/errors/) — configuration failures
  are human-oriented `[flue]`-prefixed prose, not `FlueError` categories; see "Boundaries" there.
