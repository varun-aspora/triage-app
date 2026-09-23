# Advanced tool-use patterns

Read this when a tool surface has many capabilities, multi-call data flows, or
arguments whose valid combinations are not obvious from JSON Schema.

## Pick the mechanism that matches the bottleneck

| Symptom | First intervention | Advanced intervention |
| --- | --- | --- |
| Wrong tool or bloated definitions | Remove overlap; improve names and descriptions | Deferred tool discovery |
| Many calls and large intermediate results | Build one workflow-level tool | Programmatic tool orchestration |
| Valid JSON, wrong conventions or field combinations | Tighten schema and descriptions | Tool input examples |

These mechanisms compose, but should not be enabled as a bundle by default.
Measure the bottleneck first.

## Deferred discovery

Use a searchable catalog when eager definitions are themselves a substantial
part of the prompt or selection accuracy falls as the catalog grows. Practical
signals are 10+ available tools, definitions above roughly 10K tokens, multiple
MCP servers, or repeated confusion among similar tools.

- Keep a small core of frequent tools eager; defer the long tail.
- Index names, descriptions, namespaces, and capability summaries. Discovery
  quality still depends on excellent definitions.
- Tell the model which broad capability families exist and that it should search
  for specific operations.
- Treat discovery as visibility, never authorization. A search result may expose
  only tools already permitted for the current principal and task.
- Preserve prompt caching: deferred definitions should not appear in the eager
  prompt, and later promotion should not rewrite the stable prefix when the
  provider supports cache-safe insertion.
- Make promotion deterministic and observable. Record which definitions became
  callable so replay, recovery, tracing, and evals see the same tool surface.

Avoid it when fewer than about ten compact tools are used in most sessions. The
extra search call can cost more latency than it saves.

## Programmatic orchestration

Use code or deterministic host logic for control flow that does not benefit from
another model turn: loops, conditionals, fan-out, joins, filtering, sorting,
aggregation, and format conversion. Intermediate tool results should remain in
the execution environment; only the compact outcome should enter model context.

Good fits include three or more dependent calls, parallel reads across many
items, large datasets reduced to a few aggregates, and workflows where raw
intermediate data would distract the model.

Requirements:

- Document stable return shapes and prefer declared output schemas. Generated
  code needs a parsing contract, not merely a friendly sentence.
- Route programmatic calls through the same validation, authorization, timeout,
  cancellation, tracing, and error machinery as direct calls.
- Parallelize independent reads or idempotent operations. Preserve order for
  dependent or effectful work.
- Make mutations idempotent or durable. A code runtime retry must not duplicate
  a payment, notification, or deployment.
- Constrain which tools code may call. Caller metadata is routing guidance, not
  a security boundary; enforce access in the executor.
- Bound CPU, memory, wall time, call count, output size, and network access.

Do not use this path for a single lookup, tiny responses, or work where the model
must reason about each observation. A composite workflow tool implemented in
ordinary application code often gives the same benefit with less machinery.

## Tool input examples

Examples teach semantics that structural schemas do not: identifier patterns,
date conventions, nested-object inclusion, and correlations among optional
fields.

- Provide 1–5 valid examples, usually minimal, partial, and full forms.
- Use realistic values rather than `foo`, `string`, or `123`.
- Contrast branches that agents actually confuse.
- Validate every example against the input schema at definition time.
- Keep format rules in schema descriptions too; examples should clarify rather
  than become the only specification.
- Do not add examples for simple parameters or constraints a schema already
  enforces.

Provider-native example metadata is preferable to pasting a large examples
section into the tool description because it is structured and can be validated.
When unavailable, add one targeted example only if evals justify its prompt cost.

## Evaluate the layer you changed

- Discovery: catalog recall, wrong promotions, search steps, eager/deferred input
  tokens, and end-to-end latency.
- Orchestration: total model turns, tool calls, intermediate bytes kept out of
  context, correctness, retries, and wall time.
- Examples: argument validity is insufficient; measure semantic correctness of
  optional-field combinations and conventions.

Always retain held-out tasks and inspect raw transcripts and tool traces. See
[evaluating-tools.md](evaluating-tools.md).

Sources: [Anthropic — advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
[Anthropic — writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
