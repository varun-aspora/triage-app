---
description: Bun for installs, scripts and unit tests; Vite and Vitest where Flue needs them; Node is the runtime, so no Bun APIs in src/.
globs: "*.ts, *.tsx, *.js, *.jsx, *.mjs, package.json"
alwaysApply: false
---

This project is a Flue 2.0.8 app. Flue builds with Vite, its evals run on
Vitest, and the service runs on Node >= 22.19. Bun is the package manager, the
script runner and the unit test runner. See docs/05-decisions.md D1 and D18.

## Use Bun for

- Installing: `bun install`, `bun add`, `bun add -d`. Not npm, yarn or pnpm.
- Running scripts: `bun run <script>`. Not `npm run`.
- One-off package binaries: `bunx <package> <command>`. Not `npx`.
- Unit tests: `bun test` (through `bun run test`). Unit tests are colocated
  `*.test.ts` files.
- Repo scripts under `scripts/`, which may use Bun APIs.

## Vite, Vitest and Node are allowed where Flue needs them

- `vite build` (through `bun run build`) builds the Flue app with the `flue()`
  plugin from `@flue/vite`. Do not replace it with `bun build`.
- Vitest runs contract tests (`test/contract/**/*.contract.ts`) and eval files
  (`*.eval.ts`), because Flue's eval harness is Vitest-based.
- `node` runs the CLI shim (`bin/triage.mjs`) and the built server
  (`dist/server.mjs`).

## No Bun APIs in src/

The runtime is Node, so code under `src/` must run on Node without Bun:

- Do not use `Bun.*` (`Bun.serve`, `Bun.file`, `Bun.sql`, `Bun.$`, `Bun.env`
  and so on) in `src/`.
- Do not import `bun:*` modules (`bun:sqlite`, `bun:test`, `bun:ffi`) in `src/`.
- Use Node and web APIs instead: `node:fs`, `node:path`, `fetch`, and the
  packages already in `package.json` (`hono`, `@hono/node-server`, `pg`,
  Flue's built-in `node:sqlite` adapter). Child processes go only through the
  one exec runner in `src/connectors/`.
- Do not use `better-sqlite3` or `libsql`: Flue's `sqlite()` adapter from
  `@flue/runtime/node` covers sqlite.
- Do not import `dotenv/config`. Config is loaded from `TRIAGE_HOME` by
  `src/config/env.ts`, and Bun's automatic `.env` loading is turned off.
- `src/` is erasable-only TypeScript (`erasableSyntaxOnly`) with explicit
  `.ts` import extensions, so Node type stripping can run it: no enums, no
  namespaces, no parameter properties.

Tests are exempt: `*.test.ts` files may import `bun:test`, and helpers under
`test/support/` may use Bun APIs when only `bun test` loads them. Files that
Vitest loads (`*.contract.ts`, `*.eval.ts` and the helpers they import) run on
Node and follow the `src/` rule.
