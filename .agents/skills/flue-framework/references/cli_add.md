---
title: flue add
source: https://flueframework.com/docs/cli/add/
bundled_docs: bunx flue docs read cli/add
version: "2.0.8"
reviewed: "2026-09-17"
---

# `flue add`

## Purpose and when

List integration blueprints or fetch a blueprint's Markdown implementation guide. Use the guide as instructions for a coding agent that will implement and verify the integration in the current project.

## Command and flags

```bash
bunx flue add [<kind> <name|url>] [--print]
```

| Argument or flag | Contract |
| --- | --- |
| no arguments | List every available blueprint. |
| `<kind>` | Exactly `channel`, `database`, `sandbox`, or `tooling`. |
| `<name\|url>` | Registry blueprint name, or an absolute provider-documentation URL that selects the kind's generic build-from-scratch guide. |
| `--print` | Always write guide Markdown to stdout. |

Kinds and names are passed as a pair. Blueprints are fetched at runtime from `https://flueframework.com/cli/blueprints/`.

## How to

```bash
# Discover the current registry catalog
bunx flue add

# Print a named guide for review or piping
bunx flue add channel slack --print
bunx flue add database postgres --print

# Start a custom integration from authoritative provider docs
bunx flue add channel https://developers.notion.com/reference/webhooks --print
```

When handing output to an agent, preserve the guide as the implementation brief and separately review its resulting code and dependency changes.

## Recommended patterns

- Run with no arguments first; names are registry data and can change independently of the installed CLI.
- Pass `--print` in scripts so output does not depend on coding-agent environment detection.
- Use an absolute, authoritative provider URL for a custom integration.
- Install any guide-selected packages with `bun add` or `bun add --dev` in this repository.
- Review and test the coding agent's implementation; the CLI only returns instructions.

## Avoid

- Do not describe `flue add` as a package installer or code generator.
- Do not assume fetching a guide changed the worktree.
- Do not omit the kind when selecting a blueprint name.
- Do not use `add` to refresh an existing integration when update intent matters; use `flue update`.

## Gotchas

- The command requires network access to the live blueprint registry.
- In a detected coding-agent environment, Markdown goes to stdout automatically; in a plain shell without `--print`, the CLI prints instructions for piping it instead.
- `add` and `update` currently fetch the same guide; their distinction is workflow intent and argument handling.

## Related

- [update](cli_update.md)
- [CLI overview](cli_overview.md)
- [Channels](advanced_channels.md)
- [Database](guides_database.md)
- [Sandboxes](guides_sandboxes.md)
- [Tools](guides_tools.md)
