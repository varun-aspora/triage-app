## Runtime Environment

- Flue 2.0.8 app on Node >= 22.19. Use Bun for installs, scripts and unit tests; Vite and Vitest only where Flue needs them; no `Bun.*` or `bun:*` in `src/`. Check @.agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md

## Conventions

- Directory layout, naming, tool, CLI, HTTP and agent file shapes, registration rules, test placement and commit format: @CONVENTIONS.md

## Tests

- Run tests with `--only-failures`, for example `bun run test --only-failures` or `bun test <path> --only-failures`, so the output shows only the failing tests and the summary.
