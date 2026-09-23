---
title: Flue CLI overview
source: https://flueframework.com/docs/cli/overview/
bundled_docs: bunx flue docs read cli/overview
version: "2.0.8"
reviewed: "2026-09-17"
---

# Flue CLI overview

## Purpose and when

`@flue/cli` provides the `flue` binary for scaffolding projects, running one agent module locally, fetching integration blueprints, and reading version-matched documentation. Use it for project setup and agent development; use Vite with the `flue()` plugin for development servers and production builds.

## Command surface

```text
flue init [directory]
flue run <path>
flue add [kind] [name|url]
flue update <kind> <name|url>
flue docs [read|search]
```

| Command | Purpose |
| --- | --- |
| `init` | Scaffold a Node or Cloudflare project. |
| `run` | Submit one message to one local agent module, print the reply, and exit. |
| `add` | List blueprints or fetch an integration implementation guide. |
| `update` | Fetch a guide for updating an existing integration. |
| `docs` | List, read, or search documentation bundled with the installed CLI. |

Global flags:

| Flag | Meaning |
| --- | --- |
| `-h`, `--help` | Print global or command-specific usage to stdout and exit `0`. |
| `-v`, `--version` | Print the `@flue/cli` version to stdout and exit `0`. |

There are no other global flags. Commands reject undeclared flags.

## How to

Install locally and inspect the version:

```bash
bun add @flue/runtime
bun add --dev @flue/cli
bunx flue --version
bunx flue run src/agents/assistant.ts -m "Say hello"
```

Use a `package.json` script for stable project tasks; invoke one-off CLI operations as `bunx flue ...` in this repository.

## Recommended patterns

- Pin `@flue/cli` with the application dependencies so CLI behavior and bundled docs remain version-matched.
- Read the command page before automating a command: `bunx flue docs read cli/run`.
- Pipe stdout safely. Primary payloads go to stdout; prompts, streaming activity, and errors go to stderr.
- Use `bun run <script>` for checked-in scripts and `bunx flue` for direct invocations.

## Avoid

- Do not use the CLI as the build or dev-server tool; those are Vite responsibilities.
- Do not assume unknown global flags are ignored.
- Do not parse progress output from stderr as the command result.

## Gotchas

- The package declares Node.js 22.19 or newer as its upstream runtime baseline; this repository invokes the compatible binary through Bun.
- `flue init` writes dependencies but does not install them. Run `bun install` afterward.
- `flue add` and `flue update` fetch Markdown instructions; they do not install packages or edit source themselves.
- Exit behavior and output envelopes are command-specific; see the `run` reference for automation.

## Related

- [init](cli_init.md)
- [run](cli_run.md)
- [add](cli_add.md)
- [update](cli_update.md)
- [docs](cli_docs.md)
- [SDK overview](sdk_overview.md)
