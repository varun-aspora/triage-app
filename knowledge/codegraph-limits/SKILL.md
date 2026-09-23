---
name: codegraph-limits
description: What the code graph tools can and cannot answer, what they cost, how their output is capped, and how fresh the index is. Use it before treating a code graph answer as a finding, when a result looks empty or truncated, or when a call crosses into another repo.
metadata:
  kind: codegraph-limits
  entity: shared
  sources: docs/survey/01-code-navigation.md, repos/AGENTS.md, docs/02-hld-detailed.md, docs/05-decisions.md
  status: written
---

# CodeGraph limits

The code graph is a structural index of each repo's source: calls, imports,
containment and dynamic-dispatch hops. It is good for finding where something
happens and what it touches. It is not evidence of what happened on a given
run.

## What each tool answers

| Tool | Ask it | Output |
|---|---|---|
| `code_explore` | A flow or an area in plain words, such as "sim binding form submission". Returns the relevant source, call paths and blast radius. | Markdown text, not JSON. |
| `code_node` | One symbol with its callers and callees, or one file with line numbers. | Text, not JSON. |
| `code_callers` | Who calls a given symbol. | A list of call sites. |
| `code_impact` | What a change to a given symbol would reach. | A list of affected symbols and files. |
| `repo_read` | A file, or a line range of it. | Text. |
| `repo_grep` | A pattern across a repo, optionally narrowed by a path glob. | Matches with file and line. |

Use `repo_read` and `repo_grep` for anything the graph does not index (see
below), and to confirm a graph answer against the source before you cite it.

## Limits

- **Structural only.** No runtime behaviour, no database schema, no CBS error
  codes. A code path that could fail is not a finding. A triage finding still
  needs a log line or a database row from an investigator.
- **One index per repo, no cross-repo edges.** A call from harbor into
  `go-commons` or `shivalik-cbs-go` does not appear in harbor's graph. Make a
  second call against the library repo and join the two by hand. Every call
  names its repo, and there is no workspace-wide query.
- **Docs are not indexed.** Markdown and images are left out, so
  `prod-ssfb-aspora-argo` (manifests only) looks near-empty in the graph.
  YAML is also left out (unverified: the old workspace note says YAML is
  excluded, but an index status listing counted YAML files in harbor, so some
  YAML may be indexed as bare file nodes). Use `repo_grep` for manifests,
  config and docs either way.
- **Known parse failures.** In `vance-ios`, 14 Objective-C headers inside the
  vendored `AppProtectt.xcframework` fail to parse. The rest of that index is
  unaffected.
- **Version.** The index is built with CodeGraph 1.6.0 (unverified: the old
  workspace ran a 1.5.0 server next to a 1.6.0 binary, and no version is
  pinned).

## Freshness

There is no file watcher. The old workspace notes disagree on this: one says a
live watcher keeps every index fresh, another says per-repo indexes have no
watcher. The watcher only ever covered the workspace root, never the service
repos, so treat it as absent.

- Freshness comes from `triage repos sync`, and new commits reach an index
  only that way. It checks out the branch pinned for each repo, pulls and
  re-indexes. It runs outside any triage run,
  needs access to the code host and takes about 50 seconds for all repos.
- The code tools may re-index a repo's working tree once per repo per run
  before the first query (about 0.6 seconds when nothing changed). That picks
  up local changes only. It does not pull new commits.
- Tool output carries the repo's current commit, and the report records it. If
  the code looks older than the behaviour in the logs, say so rather than
  guessing.

## Cost and output caps

- Each call starts a process and opens that repo's index. Keep calls few and
  targeted: one `code_explore` to find the area, then `code_node` or
  `repo_read` on the symbols that matter.
- Building an index from scratch is roughly linear in repo size: under a second
  for guardian, a few seconds for harbor, about 12 seconds for `vance-ios`.
  That happens in `triage repos sync`, never in a run.
- Output is capped by the tool. A capped result says it was truncated. Narrow
  the query, ask about one symbol, or read a line range, instead of repeating
  the same broad query.
- A repo with no index answers "not configured". Fall back to `repo_grep` and
  `repo_read`, and say in the findings that the graph was not available.
