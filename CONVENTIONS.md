# Conventions

The rules every sub-ticket follows. They come from the conventions list in
[docs/plan/plan.json](docs/plan/plan.json) and
[docs/09-implementation-plan.md](docs/09-implementation-plan.md); when the plan
changes, update this file with it.

## Directory layout

- bin/triage.mjs (CLI shim, Node)
- src/app.ts and src/db.ts (Flue entries, T01)
- src/config/ (env.ts, keys.ts, errors.ts, registry.ts, repos.ts; T01)
- src/types/<domain>.ts (shared Valibot schemas; T01; no barrel file)
- src/gate/ (pure gate, T02, plus quickwit.ts and quickwit-window.ts from T04.4)
- src/mock/ (fixture lookup and recording, T03)
- src/connectors/ (all real I/O: pg, http, quickwit-http, quickwit-qw, cbs, codegraph and the one exec runner; T04, T05.10, T11.1)
- src/models.ts (provider registration side effect, T06.1)
- src/tools/**/<name>.tool.ts (one tool per file; T05 entity, code and evidence tools, T06.9 finish_report)
- src/agents/<name>.agent.ts (root agents with 'use agent') and src/agents/delegates/ (plain modules without the directive; T06)
- src/classify/ (T06)
- src/ingress/ (T07)
- src/server/ (HTTP server boot, T07.10)
- src/http/**/<name>.http.ts (T07)
- src/cli/commands/**/<name>.command.ts (T07, T08, T10, T11)
- src/report/ (rendering, T08; together with src/gate/audit.ts, the only code that reads config.display.envLabel)
- src/runstore/ and src/embed/ (T09; src/runstore/ settles the HLD vs P2 path conflict)
- src/runlog/ (the per-run event log, D54)
- src/evals/ (T10)
- src/ops/ (T11; src/ops/preflight.ts is the only consumer of deployModeForPreflight)
- knowledge/ (T12)
- resources/ (registries, rules files, repos.json)
- fixtures/ and fixtures/_unreviewed/ (T03)
- test/support/ (shared test helpers: T01 owns no-io-guard, bun-preload, vitest-setup, home, fake-tool-context; other areas add new files here)
- test/contract/**/*.contract.ts (T03, T06, T10; never *.contract.test.ts)
- evals/promptfoo/classifier/ (T10)
- scripts/ (bun scripts)
- web/ (the browser console: Vite + React + TypeScript, built to web/dist and served at /ui by src/http/ui.http.ts; imports only types from src/types, its tests run with `bun run test:web`)

## Naming

File names are kebab-case. A tool's model-facing name is snake_case and its file is the kebab form (sql_select -> src/tools/sql-select.tool.ts; SSFB-only tools go in src/tools/ssfb/, code tools in src/tools/code/). Delegate names are investigate_<entity>, investigate_<entity>_deep and code_walker. Skill directory names are <entity>-<service> or a global name (patterns, repo-map), unique across knowledge/. Schemas are <Name>Schema, with the type = v.InferOutput<typeof <Name>Schema> in the same file. Entity ids are lowercase ssfb|atspl|rtl; 'shivalik' is accepted only as a registry alias. Env keys are never read directly: use config, lookupEnv or the registry.

## Tool file shape

Src/tools/<name>.tool.ts exports `export const toolModule: ToolModule = { name: 'sql_select', mounts: ['investigator'], entities: 'all' | ['ssfb'], enabled: (ctx) => ({ on: true }) | ({ on: false, reason }), create: (ctx) => defineTool({ name, description, input: v.object({...}), run: async ({ data, signal }) => ok(data) | refused(msg) | notConfigured(entity, service) }) }`. Entity and run_id come from ctx (a closure) and never appear in the input schema. create() builds the tool only and touches ctx.deps only inside run(). run() takes Flue's single context ({ data, signal }), always returns the { output } envelope built by the helpers in src/types/tool-result.ts, passes signal to all async work, and throws only for loud errors such as a strict mock miss. Gate refusals are returned, not thrown. Row-returning tools stage full rows with stageRows() from src/tools/_lib/pipeline.ts (T05.1), which picks the persisted profile for e2b and daytona (D45).

## CLI command file shape

Src/cli/commands/<name>.command.ts exports `export const command: CliCommand = { path: ['tunnel', 'up'], summary: '...', configure(cmd) { cmd.argument(...).option('--json') }, async run(ctx, { args, opts }) { ...; return EXIT.OK } }`. Load config lazily with ctx.config(). Write output only through ctx.io and printJson/printHuman, never console.log in commands. --json output is machine-stable. There is no --env flag. Prompt for interactive input only when ctx.io.isTTY.

## HTTP module shape

Src/http/<name>.http.ts exports `export const httpModule: HttpModule = { id, order, mount(app, ctx) }`. The bearer middleware is the module with id 'bearer-auth' and order 0. Until it exists, src/app.ts answers 503 on every route. There is no createAgentRouter mount.

## Root agent file shape

Src/agents/<name>.agent.ts starts with 'use agent' as its first statement, exports the capitalized agent function and `export const rootAgent = <Fn>`. Delegate factories live in src/agents/delegates/ without the directive.

## How areas register without editing shared files

Add a file that matches the glob (*.tool.ts, *.command.ts, *.http.ts, src/agents/*.agent.ts) with the named export. bun run gen (run automatically by postinstall, test, typecheck and build) regenerates the gitignored *.gen.ts import lists. Never edit src/tools/index.ts, src/agents/index.ts, src/cli/index.ts, src/app.ts or any *.gen.ts. Add fields to ToolDeps, CliDeps or HttpDeps with `declare module '<path>/types.ts' { interface ToolDeps { audit: AuditSink } }` in your own file. Needing a new dependency, script, env key or schema field means a declared shared edit to package.json, keys.ts/.env.example or src/types/<file>.ts; list it in the sub-ticket's files and the merge step serialises it.

## Test placement

Unit tests are colocated *.test.ts files next to the source and run by `bun run test` (bun test ./src ./test ./scripts ./integrations, with preload running gen and installing the no-io guard). Contract tests are test/contract/**/*.contract.ts (never *.contract.test.ts) and eval files are *.eval.ts, both run by Vitest on Node (`bun run test:contract`) with the same no-io guard. promptfoo suites live under evals/promptfoo/ (`bun run evals:classifier`). No test reads a real .env: use makeTestHome() from test/support/home.ts and makeToolContext() from test/support/fake-tool-context.ts. Model calls in tests go only through the fake provider T03 provides. Only *.test.ts files may import bun:test; src/ never imports bun:* or uses Bun.*.

## Commit format

Conventional commits, one commit per sub-ticket, subject '<type>(<sub-ticket id>): <summary>' in the imperative, under 72 characters, for example 'feat(T02.1): SQL parser refuses non-SELECT'. Types are feat, fix, test, chore, docs and refactor. The body says what changed and names any declared shared-file edit. Every commit message ends with exactly this trailer line, whatever model wrote it:
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>

## Toolchain and runtime

- Flue 2.0.8 on Node >= 22.19 (`engines.node`). Bun installs packages, runs
  scripts and runs unit tests. Vite builds the Flue app (`flue()` from
  `@flue/vite` in `vite.config.ts`) and Vitest runs contract and eval files,
  because Flue needs them (D1, D18). The full rule is in
  [.agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md](.agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md).
- `flue.config.ts` sets `target: 'node'` and narrows the agent scan to
  `agents/*.agent.ts` under the `src/` source root. There is no `.flue/`
  directory; if one existed, Flue would use it instead of `src/`.
- `src/` is erasable-only TypeScript (`erasableSyntaxOnly`) with explicit `.ts`
  import extensions, so `bin/triage.mjs` and `bin/triage-server.mjs` can run
  it through Node type stripping, with no build (D50). No `Bun.*` and no `bun:*` imports in `src/`.
- Scripts that exist before the index generator: `typecheck:raw` (tsc),
  `build:raw` (vite build) and `triage` (node bin/triage.mjs). T01.2 adds
  `gen`, `test`, `typecheck`, `build` and the rest.

## Dependencies left out on purpose

- No `better-sqlite3` and no `libsql`: Flue's built-in `sqlite()` adapter from
  `@flue/runtime/node` uses Node's `node:sqlite`, which covers the laptop
  sqlite provider (D38). Postgres goes through `@flue/postgres` and `pg`.
  `promptfoo` (dev only) brings in `@libsql/client` for its own result store;
  app code never imports it.
- No `node-pg-migrate`: the run store migrations are few and hand-rolled in
  T09 (D43).
- No `import 'dotenv/config'`: config is loaded explicitly from `TRIAGE_HOME`
  by `src/config/env.ts`, never from the process working directory. `dotenv`
  is a dependency only for its parser.
- No `pgsql-ast-parser`: the SQL gate (T02.1) uses `libpg-query`, the real
  Postgres grammar, and the other parser was removed.
- `hono` is pinned to the version `@flue/runtime` depends on, so the app and
  Flue share one Hono.
