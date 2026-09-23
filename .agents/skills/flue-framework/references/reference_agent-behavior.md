---
title: Agent Behavior
source: https://flueframework.com/docs/reference/agent-behavior/
bundled_docs: bunx flue docs read reference/agent-behavior
version: 2.0.8
reviewed: 2026-09-17
---

# Agent Behavior

## What and when

What a Flue agent does *out of the box*, in one place: the tools the model gets, what environment
it runs in, how incoming messages are handled, what its context window contains, and the limits
the runtime enforces. This is a map of **runtime behavior**, not an authoring API — the pages that
define these behaviors (`reference_agent-hooks-api.md`, `reference_sandbox-api.md`,
`guides_tools.md`) are linked from each section. Flue's inner agent loop builds on
[pi](https://pi.dev)'s agent core; everything below is Flue's own contract.

## Contents

- Built-in tools
- Environment defaults
- Message handling
- Context composition
- Context management
- Limits

## Built-in tools

An agent **with a sandbox attached** gets six tools that operate on it. These are the tools the
*model* calls — application code and sandbox adapters use the `Sandbox` surface
(`reference_sandbox-api.md`) these tools are built on, which is deliberately lower-level
(whole-file verbs, no truncation).

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `read` | `path`, `offset?`, `limit?` | Truncated to 2000 lines or 50 KB, whichever hits first, never mid-line. Truncated output ends with a continuation marker (`Use offset=N to continue.`). An `offset` past EOF errors naming the file's actual line count. A single line larger than the byte budget surfaces its first 50 KB with a note that the remainder is unreachable via `offset`/`limit`. |
| `write` | `path`, `content` | Writes a file whole; creates the file and missing parent directories; overwrites silently. |
| `edit` | `path`, `oldText`, `newText`, `replaceAll?` | Exact-text replacement. Zero matches errors (check whitespace/indentation); multiple matches errors (need more context) unless `replaceAll` is set (replaces every occurrence, reports the count). The read→replace→write transaction is atomic per file: parallel batch calls to the same file via `write`/`edit` serialize through a per-path lock, surfacing a genuine conflict as "could not find" rather than a silently lost edit. A concurrent `bash` mutation of the same file is **not** synchronized. |
| `bash` | `command`, `timeout?` (seconds) | Returns combined stdout/stderr, **tail**-truncated to the last 2000 lines or 50 KB (errors and final results live at the tail). A non-zero exit appends the exit code. A command exceeding `timeout` returns a recoverable exit-124 result rather than failing the operation. |
| `grep` | `pattern` (regex), `path?`, `include?` (glob filter), `literal?` | Runs `rg` inside the sandbox when available (probed once), falling back to POSIX `grep -E`. Capped at 100 matches and 500 characters per line; hitting the cap advises narrowing the search. |
| `glob` | `pattern`, `path?` | Shell `find -name` semantics — the pattern matches file names, not paths. Returns up to 1000 paths. |

**Framework tools**, independent of any sandbox: `task` for subagent delegation (always present;
inert until agents are declared), `activate_skill` when the agent has skills, and
`read_skill_resource` when an imported skill packages resource files. These names are
**reserved** — a custom tool can't take them.

A sandbox adapter may **replace** the six sandbox tools with its own set (`SandboxToolFactory` in
`reference_sandbox-api.md`) — check an integration's own documentation before assuming ordinary
file/command tools are present.

## Environment defaults

An agent has **no sandbox unless you attach one** with `useSandbox()`, and **at most one**.
Without a sandbox: the six file/shell tools aren't in the tool set, no workspace context enters the
system prompt, workspace skills aren't discovered, and `harness.sandbox` throws. Everything else —
custom tools, imported skills, subagents, state — works the same either way.

Attaching one defines several behaviors at once (tools, workspace discovery, skills, what
subagents inherit) — see `guides_sandboxes.md#what-a-sandbox-adds`. Presence is re-read at every
turn boundary, so a conditional `useSandbox()` can attach/detach mid-conversation; the swap is
narrated to the model as an `environment` signal (`reference_agent-api.md#dynamic-resources`).

## Message handling

Every input — HTTP prompt, `dispatch()`, channel delivery, scheduled trigger — is admitted as a
**submission**, recorded durably before any model work begins. Submissions for one conversation
form a queue processed in admission order, and the agent does not sit idle behind a busy
conversation's turn:

- One submission runs at a time.
- A message arriving while the agent is busy **joins the live response at the next turn boundary**
  when it can, and otherwise waits its turn as its own submission. Nothing is dropped — a delivery
  that misses the live response runs on its own afterward.
- Every accepted submission reaches exactly one durable terminal outcome — `completed`, `failed`,
  or `aborted` — no matter how many crashes happen in between.

Retries, recovery, and abort mechanics are `advanced_durability.md`'s territory; the wire contract
(the `202` admission response, streaming) is `guides_routing.md`/`reference_streaming-protocol.md`.

## Context composition

At initialization the runtime composes the system prompt from what it finds: the agent function's
returned instructions, and — when a sandbox is attached — the working directory path, a directory
listing, the contents of `AGENTS.md` when present, plus the discovered skill, subagent, and tool
rosters.

The system prompt is then **frozen**: it keeps describing the workspace and catalogs discovered at
initialization until the next compaction rebaselines it against the current environment. Mid-window
changes (tools mounting/unmounting, skills flipping, the environment swapping) are narrated as
append-only signals instead of prompt rewrites — keeping the transcript's earlier turns consistent
with the prompt they actually ran under, and keeping the system prompt's share of the provider's
prompt cache warm (though a tool-set change still invalidates the cache through the native tools
array).

## Context management

When the conversation approaches the model's context window, the runtime **compacts**: older
messages fold into a summary and recent ones are preserved verbatim. Threshold compaction triggers
when used tokens exceed the window minus a model-aware reserve (capped at 20,000 tokens); the most
recent 8,000 tokens are kept verbatim by default. Both knobs, the summarization model, and opting
out are `CompactionConfig` (`reference_agent-hooks-api.md#compactionconfig`); overflow recovery and
explicit `harness.compact()` (`reference_agent-api.md#harnesscompact`) compact even when threshold
compaction is disabled.

## Limits

| Limit | Value |
| --- | --- |
| `read` output | 2000 lines / 50 KB, head-truncated with continuation marker |
| `bash` output | 2000 lines / 50 KB, tail-truncated |
| `grep` results | 100 matches, 500 chars per line |
| `glob` results | 1000 paths |
| Delegation depth | 4 — a `task` chain (including harness invocations) deeper than this fails with `delegation_depth_exceeded` (`DelegationDepthExceededError`) |
| Compaction reserve | model-aware, capped at 20,000 tokens |
| Kept verbatim after compaction | 8,000 tokens by default |

Tool-set size has no framework cap, but every mounted tool spends context — see
`guides_tools.md#conditional-tools` for keeping the set lean.

## Recommended patterns

- Attach a sandbox whenever an agent needs file/shell capability, rather than hand-rolling
  `read`/`write`/`bash`-equivalent tools — the built-ins already have truncation, locking, and
  timeout semantics worked out.
- Design tools and workflows around the delegation-depth cap of 4 — a `task` chain that might
  legitimately need to go deeper needs an architecture change, not a retry.
- Treat `grep`/`glob`/`read` truncation as normal operation the model is expected to page through
  (`offset`), not an error condition to special-case.
- Rely on the frozen-system-prompt + signal-narration model when reasoning about why a tool/skill
  change didn't rewrite the visible system prompt — check the conversation's signals instead.

## Avoid

- Don't assume built-in file/shell tools exist without a declared sandbox — `harness.sandbox` and
  the six tools are both absent otherwise.
- Don't rely on `bash`'s output including everything for a long-running command — it's
  tail-truncated, so early diagnostic output can be lost if the command is chatty.
- Don't assume every sandbox exposes the same six tools — an adapter's `SandboxToolFactory` can
  replace the set entirely.
- Don't treat the compaction reserve/keep-verbatim defaults as fixed across models — both are
  model-aware.

## Gotchas and errors

- A tool-set change from `useTool` still invalidates the provider's prompt cache unless the tool
  was added by a completed tool call — see `reference_agent-hooks-api.md`.
- `delegation_depth_exceeded` (`DelegationDepthExceededError`) is the only limit on this page with
  an importable error class; the rest surface as tool-result text or truncation markers, not
  errors. Full class in `reference_errors.md`.
- `grep`'s `rg` probe and `glob`'s `find -name` are adapter-dependent — an adapter without a real
  shell (an exec-less sandbox) omits these tools entirely rather than emulating them.

## Related

- [Agent Hooks API](https://flueframework.com/docs/reference/agent-hooks-api/) —
  `useSandbox()`, `useModel()`'s `compaction` option, the hooks that shape this behavior.
- [Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/) — the
  `Sandbox`/`SandboxDriver` contract and `SandboxToolFactory` underneath the six built-in tools.
- [Tools](https://flueframework.com/docs/guide/tools/) — authoring custom tools alongside these
  built-ins, conditional tools.
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) — what attaching a sandbox adds,
  workspace discovery, skill discovery.
- [Skills](https://flueframework.com/docs/guide/skills/) — `activate_skill`/`read_skill_resource`
  and the skill catalog.
- [Subagents](https://flueframework.com/docs/guide/subagents/) — the `task` tool and the
  delegation-depth limit.
- [Durability](https://flueframework.com/docs/guide/durability/) — submission queueing, recovery,
  and the durable terminal outcomes.
- [Errors Reference](https://flueframework.com/docs/reference/errors/) —
  `DelegationDepthExceededError` and other errors this behavior can throw.
