---
title: flue init
source: https://flueframework.com/docs/cli/init/
bundled_docs: bunx flue docs read cli/init
version: "2.0.8"
reviewed: "2026-09-17"
---

# `flue init`

## Purpose and when

Scaffold a complete starter Flue project, optionally including an HTTP server. Use interactive mode for exploration and explicit flags for repeatable setup or automation.

## Command and flags

```bash
bunx flue init [directory] [--root <path>] [--target <node|cloudflare>] [--deploy] [--force]
```

| Argument or flag | Contract |
| --- | --- |
| `[directory]` | Destination resolved from the current directory; defaults to `.` and missing parents are created. |
| `--root <path>` | Exact alternative to `[directory]`; passing both is an error. |
| `--target <node\|cloudflare>` | Build target. Omission prompts on a terminal and errors without one. Other values are rejected. |
| `--deploy` | Add HTTP server files and Hono/Vite dependencies. Off by default for Node; implied for Cloudflare. |
| `--force` | Skip non-empty-directory confirmation and overwrite every colliding skeleton file. |

Each flag can appear at most once. Unknown flags, extra positional arguments, and arguments after bare `--` are rejected.

The package name, and Cloudflare Worker name, comes from the destination basename: lowercase characters in `[a-z0-9-]`; if none remain, `my-flue-app` is used.

Generated files:

```text
flue.config.ts       package.json          tsconfig.json
.gitignore           .env                  AGENTS.md
README.md            src/agents/hello.ts
src/db.ts            # Node only
src/cloudflare.ts    # Cloudflare only
vite.config.ts       # --deploy only
src/app.ts           # --deploy only
```

## How to

```bash
# Minimal local-run project, no prompts
bunx flue init ./agent-app --target node

# Node HTTP server
bunx flue init ./agent-api --target node --deploy

# Cloudflare HTTP server; --deploy is implicit
bunx flue init ./edge-agent --target cloudflare

cd agent-app
bun install
```

## Recommended patterns

- Pass `--target` in scripts and CI to prevent terminal prompts.
- Choose an empty destination and review generated configuration before adding application code.
- Run `bun install`, even though the generated upstream next-step text may show another package manager.
- Commit the scaffold before broad customization so future blueprint updates are easy to review.

## Avoid

- Do not combine `[directory]` with `--root`.
- Do not use `--force` in a directory containing work you have not backed up or committed.
- Do not expect `init` to install dependencies or launch a server.
- Do not pass `--deploy=false`; the flag is presence-only.

## Gotchas

- Without `--force`, a non-empty destination requires confirmation; existing skeleton files are kept and reported rather than overwritten.
- With `--force`, all colliding skeleton files are overwritten, including `flue.config.*`.
- Cloudflare always gets deploy/server setup, even when `--deploy` is omitted.
- `.env` is generated; treat credentials as local secrets and verify ignore rules.

## Related

- [CLI overview](cli_overview.md)
- [run](cli_run.md)
- [Project layout](guides_project-layout.md)
- [Deploy](advanced_deploy.md)
