---
title: flue update
source: https://flueframework.com/docs/cli/update/
bundled_docs: bunx flue docs read cli/update
version: "2.0.8"
reviewed: "2026-09-17"
---

# `flue update`

## Purpose and when

Fetch the current blueprint guide for upgrading an existing integration while preserving project customizations. The command supplies instructions to a coding agent; it does not inspect or modify the project itself.

## Command and flags

```bash
bunx flue update <kind> <name|url> [--print]
```

| Argument or flag | Contract |
| --- | --- |
| `<kind>` | Required: `channel`, `database`, `sandbox`, or `tooling`. |
| `<name\|url>` | Required blueprint name within the kind, or an absolute provider-documentation URL for the generic build-from-scratch guide. |
| `--print` | Always emit guide Markdown to stdout. |

Unlike `flue add`, there is no zero-argument catalog mode. Output uses the same guide and coding-agent detection behavior as `add`.

## How to

```bash
bunx flue update channel slack --print
bunx flue update database mysql --print
bunx flue update sandbox @cloudflare/computer --print
bunx flue update channel https://developers.notion.com/reference/webhooks --print
```

Review the existing integration and local customizations before applying the guide, then inspect and test the resulting diff.

## Recommended patterns

- Pass `--print` in automation for deterministic stdout.
- Give the coding agent both the current implementation and the fetched guide so it can compare instead of replace blindly.
- Preserve local authentication, migration, observability, and deployment conventions unless the new contract requires changes.
- Use `bun add` for dependency changes and run the repository's Bun-based checks after updating.
- Update one integration at a time to keep review and rollback focused.

## Avoid

- Do not assume the command detects the installed blueprint version.
- Do not assume it edits files, upgrades dependencies, or runs migrations.
- Do not replace an existing integration wholesale without checking custom behavior.
- Do not call `update` with no arguments to list blueprints; use `bunx flue add`.

## Gotchas

- The guide is fetched from the network at command time, not from bundled docs.
- `add` and `update` emit the same blueprint guide in 2.0.8; `update` differs by required arguments and upgrade intent.
- In a plain shell without `--print`, output may be piping instructions rather than the Markdown payload.

## Related

- [add](cli_add.md)
- [CLI overview](cli_overview.md)
- [docs](cli_docs.md)
- [Channels](advanced_channels.md)
- [Database](guides_database.md)
- [Sandboxes](guides_sandboxes.md)
- [Tools](guides_tools.md)
