---
name: agent-tool-function-definition
description: "Design or review tools/functions an LLM agent calls: workflow boundaries, naming, schemas, examples, dynamic discovery, programmatic orchestration, results, and evals. Use when defining a tool, building or extending an MCP server or Flue agent, designing a function-calling surface, or debugging wrong tool selection, malformed arguments, excessive calls, or context-heavy results. Applies to OpenAI, Anthropic, MCP, Flue, and hand-rolled agent loops."
---

# Defining tools for agents

A tool definition is a prompt. Its core interface is the name, description, and
parameter schema — not its source, host-language types, or callsite. Some
providers also expose structured examples and caller/loading metadata. Most
"the model picked the wrong tool" bugs are tool-definition or tool-set bugs.

**The intern test**: could a new hire use this correctly given only the name,
description, and schema? If they'd ask a follow-up, the model will guess
instead. Answer it in the description.

First diagnose the bottleneck instead of adding every available mechanism:

- Wrong tool selected or definitions consume the prompt: reduce overlap, then
  consider deferred discovery.
- Large intermediate results or repeated calls: consolidate the workflow or
  orchestrate calls programmatically.
- Structurally valid but semantically wrong arguments: tighten the schema and
  add a small set of contrasting input examples.

For these advanced patterns, read
[references/advanced-tool-use.md](references/advanced-tool-use.md). When the
target is Flue, also read [references/flue.md](references/flue.md); its current
`ToolDefinition` does not expose every provider-native feature.

## Build workflow tools, not endpoint wrappers

The default mistake is one tool per API endpoint. Agents have a context budget,
not memory — every intermediate round-trip costs tokens and a chance to go
wrong. Build few tools that each complete a real task:

- `list_users` + `list_events` + `create_event` → `schedule_event`
- `read_logs` → `search_logs` (returns matching lines with context, not the file)
- three customer lookups → `get_customer_context`

Corollary: merge tools always called in sequence. If `mark_location()` always
follows `query_location()`, it's one tool. But don't fuse tools the model must
*choose* between, and don't build a mega-tool with a `mode` enum over unrelated
behaviours — that hides the routing decision in a parameter.

## Name

`verb_noun`, snake_case: `cancel_order`, `search_transactions`. Must be
distinguishable from every sibling — `get_user` next to `fetch_user` is a coin
flip. No internal jargon (`query_pss_v2`).

Namespace by service or resource when tools come from several sources:
`asana_search` / `jira_search`, or `asana_projects_search` /
`asana_users_search`. Prefix vs suffix measurably changes routing accuracy —
pick one and check it against your evals.

## Description

State what it does, when to use it, when *not* to (name the sibling tool), and
what it returns. Tool-specific detail goes here, not the system prompt — the
system prompt is for cross-cutting policy.

Make implicit context explicit: query formats, domain terminology, how
resources relate. Every parameter gets a description with format and units:
`"ISO 8601 date, e.g. 2026-09-17"`, `amount_minor_units`. Name params
unambiguously (`user_id`, not `user`) and say where a value comes from: `"the
order_id returned by search_orders"`.

Use examples for relationships a schema cannot express: when optional fields
belong together, how minimal and full calls differ, or domain conventions that
remain ambiguous. Prefer 1–5 concise, realistic, contrasting examples and make
every example validate against the schema. Do not spend examples on ordinary
URLs, emails, or facts already enforced by the schema. Prefer native
tool-example metadata when the framework supports it; don't invent unsupported
definition fields.

## Schema

- Enums over free strings for any constrained set (`status`, `currency`, sort keys).
- Enums over paired booleans: `set_switch(on, off)` has two impossible states; `set_switch(state: "on"|"off")` has none.
- Objects over JSON-in-a-string. Models fill schemas better than they serialize.

**Don't ask for what you already know.** `get_order(user_id, order_id)` when the
session identifies the user → `get_order(order_id)`, inject `user_id` in the
handler. Fewer args to get wrong, and one less ID the model can be talked into
swapping.

## Validation and strict mode

Use provider strict mode when available. It commonly requires all fields
`required`, `additionalProperties: false`, and optionality expressed with
`null`. Also validate inputs again in the handler: constrained decoding is not
an authorization boundary, and some frameworks provide runtime validation but
not provider-side strict decoding. Never claim strict mode is active merely
because a schema library validates after generation.

## Effects and authorization

Describe whether a call reads, mutates, can be retried, or reaches the open
world. Use standard tool annotations when the protocol supports them, but treat
annotations and caller modes as hints, never access control. Bind credentials,
tenant/account scope, and other trusted context in the handler. For mutations,
design idempotency and confirmation around the real consequence, not the tool
name.

## How many

Keep the directly visible set small and distinct. Once roughly 10+ tools or
10K+ definition tokens are available, measure whether deferred discovery helps;
it adds a search step, so it is wasteful for a small catalog used on every
task. Keep a few frequent tools eager and make the long tail searchable. If the
harness lacks tool search, select or conditionally mount a task-specific subset
instead. Cut tool count before cutting description quality.

## Orchestration

Keep loops, joins, filtering, aggregation, and parallel fan-out out of the
model's context when their intermediate values do not require judgment. Either
put that deterministic work inside a workflow-level tool or use a supported
programmatic tool-calling runtime. Return only the result the model must reason
about.

Prefer ordinary direct calls for one or two small operations or when the model
must inspect each intermediate result. Programmatic callers need stable,
documented result shapes. Parallelize only independent reads or idempotent
operations; keep ordered mutations explicit and recoverable.

## Returns

The return value is the next thing the model reads, and it's the biggest
context leak in most tool sets.

- **High signal only.** Semantic fields (`name`, `image_url`, `file_type`) over
  plumbing (`uuid`, `mime_type`, `256px_image_url`). Resolve UUIDs to names —
  cryptic IDs are what the model hallucinates later.
- **Cap the size.** Paginate, filter, or truncate with sensible defaults. Claude
  Code caps tool responses at 25k tokens.
- **Steer on truncation.** Don't just cut — return the partial result plus what
  to do: `"showing 50 of 1,200 — narrow with date_from or a more specific query"`.
- **Errors say what to do next**: `"no order with that ID — call search_orders
  with the customer email"`. Not a stack trace.
- **Distinguish failure from empty result**, or the agent retries forever.
- Offer `response_format: "concise" | "detailed"` when downstream calls need IDs
  the reading model doesn't. Concise routinely cuts a response by two thirds.
- When code will consume the result, declare and validate a stable output schema
  and document field meanings; human-readable prose is not a parsing contract.

## Checklist

- [ ] Completes a task, not one API call; nothing is always called right after it
- [ ] `verb_noun`, namespaced, unambiguous against siblings
- [ ] Description: what / when / when not / returns
- [ ] Params have format + units; say where values come from
- [ ] Constrained sets are enums; no impossible state combos
- [ ] Nothing in the schema is known to the handler
- [ ] Complex optional/nested inputs have a few validating examples, if needed
- [ ] Small active tool set; deferred discovery considered for a large catalog
- [ ] Deterministic fan-out/aggregation stays outside model context
- [ ] Provider strict mode and handler-side validation are distinguished
- [ ] Side effects, retry safety, and open-world access are disclosed
- [ ] Response is semantic, size-capped, and steers on truncation/error
- [ ] Passes the intern test

Measuring whether changes actually helped: `references/evaluating-tools.md`.

Sources: [OpenAI — best practices for defining functions](https://developers.openai.com/api/docs/guides/function-calling#best-practices-for-defining-functions),
[Anthropic — writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
[Anthropic — advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
