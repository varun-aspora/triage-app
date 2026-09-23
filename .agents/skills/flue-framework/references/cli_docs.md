---
title: flue docs
source: https://flueframework.com/docs/cli/docs/
bundled_docs: bunx flue docs read cli/docs
version: "2.0.8"
reviewed: "2026-09-17"
---

# `flue docs`

## Purpose and when

Browse documentation bundled inside the installed `@flue/cli`. Use it when implementation must match the installed version rather than the potentially newer live website.

## Command surface

```bash
bunx flue docs
bunx flue docs read <path>
bunx flue docs search <query>
```

There are no command-specific flags.

| Form | Output |
| --- | --- |
| `docs` | One catalog entry per line as `<path> -- <title>` with description. |
| `docs read <path>` | One page as Markdown on stdout. |
| `docs search <query>` | JSON with the normalized query and at most eight ranked results. |

`read <path>` accepts:

- Catalog path: `guide/sandboxes`
- Website URL: `https://flueframework.com/docs/guide/sandboxes/`
- Website absolute path: `/docs/guide/sandboxes/`
- Source filename: `guide/sandboxes.md`

Search joins everything after `search` into one query, so quotes around multiple words are optional. Each result has `path`, `title`, `description`, `excerpt`, and numeric `score`.

## How to

```bash
# Catalog
bunx flue docs

# Search then read the selected result
bunx flue docs search durable execution
bunx flue docs read guide/durability

# Confirm the exact client contract installed here
bunx flue docs read sdk/flue-client
```

## Recommended patterns

- Check `bunx flue --version` and cite that version with extracted guidance.
- Search broadly, inspect ranked result metadata, then read the authoritative full page.
- Prefer bundled pages for version-sensitive flags, types, and behavior.
- Keep catalog paths in skill metadata so future reviewers can reproduce the source read.

## Avoid

- Do not infer complete API contracts from search excerpts.
- Do not assume live-site content matches the locally installed CLI.
- Do not parse offsets, types, or flags from an unrelated version's docs.

## Gotchas

- Bundled docs make no network requests and only change when `@flue/cli` changes.
- Blueprint commands are different: `flue add` and `flue update` do fetch live registry content.
- Search returns at most eight results and is relevance-ranked, not exhaustive output.
- Primary output is stdout, making reads and JSON search results pipeable.

## Related

- [CLI overview](cli_overview.md)
- [SDK overview](sdk_overview.md)
- [Events](sdk_events.md)
- [Errors](sdk_errors.md)
