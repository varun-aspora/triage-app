# Evaluating a tool set

Read this when you're changing tools and want to know if it helped. Description
tweaks have outsized, unintuitive effects — guessing doesn't work.

1. **Prototype against real data.** Synthetic fixtures hide the context-bloat
   and ambiguity problems you're trying to find.
2. **Write realistic tasks.** Multi-step, requiring many tool calls.
   - Strong: "Schedule a meeting with Jane next week to discuss Acme Corp.
     Attach notes from the last planning meeting and reserve a room."
   - Weak: "Schedule a meeting with jane@acme.corp next week."
3. **Run them in a plain agent loop.** No harness needed — API call, tool
   results back, repeat.
4. **Collect**: accuracy, wall time, tool call count, total tokens, error count.
5. **Read the transcripts**, not just the scores. Where the agent hesitated,
   re-called a tool, or worked around a bad response is the actual finding.
6. **Hold out a test set** so description tuning doesn't overfit the tasks you
   iterated on.

Feeding transcripts back to a model and asking it to refactor the tool set works
well — it sees its own failure modes.

## In Flue

Use the Flue agent harness with `vitest-evals`. Prefer deterministic assertions
for exact contracts (tool called or prohibited, argument shape, output schema)
and add an LLM judge only for semantic behavior that cannot be checked exactly.
Keep live-model evals separate from ordinary unit tests.

Capture tool calls and errors from the eval result, and retain the usage and
wall-time data needed to compare variants. For advanced changes, add the metric
that matches the claim:

- Deferred discovery: search recall, wrong promotions, eager definition tokens,
  number of search steps, and end-to-end latency.
- Programmatic orchestration: model turns, tool calls, intermediate bytes kept
  out of context, retries, and final correctness.
- Input examples: semantic correctness of optional-field combinations and
  domain formats, not merely schema validity.

Test provider-specific lowering separately from framework semantics. A Flue
feature that works only because one provider silently ignores or accepts an
extra field is not a portable contract.
