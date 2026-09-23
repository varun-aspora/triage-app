# Applying the guidance to Flue

Read this when authoring tools with `@flue/runtime` or reviewing changes to
Flue's tool model. Verify against the installed Flue version: this reference
describes the public 2.x surface documented in September 2026.

## What Flue supports now

| Pattern | Current Flue mechanism | Important limit |
| --- | --- | --- |
| Typed inputs | Valibot `input` on `defineTool` | Validation occurs before `run`, but is not proof of provider strict decoding |
| Typed results | Valibot `output` | The result still needs a useful model-facing shape and description |
| Smaller MCP surface | `useMcpConnection({ tools: [...] })` | Static allowlist, not semantic on-demand discovery |
| Dynamic visibility | Conditional `useTool` / `useMcpConnection` during agent renders | State-driven mounting, not provider-native tool search; frequent changes can hurt prompt caching |
| Context-free deterministic work | Application logic inside `run`; `harness.sandbox` for hidden plumbing | The model cannot programmatically call arbitrary Flue tools from that code |
| Model work behind one call | `harness: true` plus `harness.prompt()` | Child model calls still have their own context and cost; this is not Anthropic Programmatic Tool Calling |
| Recoverable effects | `durable: true` plus deterministic `step.do(...)` calls | Steps are at-least-once executed, so external effects still need idempotency |
| Tool evaluation | Flue harness plus `vitest-evals` tool-call assertions and judges | Add token, latency, and call-count measurements for optimization work |

`ToolDefinition` currently accepts only `name`, `description`, `input`, `output`,
`harness`, `durable`, and `run`, and rejects unknown fields. Do not add
`defer_loading`, `allowed_callers`, `input_examples`, or `strict` to an
application tool and assume Flue will forward them.

## Use today's primitives well

### Prefer a composite tool for deterministic orchestration

Factor API operations into ordinary TypeScript functions. A workflow tool can
call those functions with `Promise.all`, filter and aggregate the data locally,
then return only what the model needs. Do not make one model-facing tool call
another tool's `run` method; both wrappers should share application functions.

For effectful multi-step work, declare the composite tool `durable: true` and
put each external side effect in a deterministically named `step.do`. Keep
independent reads parallel, but keep mutations ordered unless the external API
is explicitly idempotent.

Use `harness: true` only when the tool genuinely needs a scratch model operation
or the agent's sandbox. Filesystem calls through `harness.sandbox` are plumbing
and do not enter the conversation. `harness.prompt()` opens model work whose
child conversation is retained for inspection, so it is useful isolation but
not a free token-saving substitute for deterministic TypeScript.

### Keep the visible set intentional

- Allowlist MCP operations with `useMcpConnection({ tools: [...] })` rather than
  mounting every endpoint a server exposes.
- Mount tools conditionally when trusted state or a completed prerequisite
  changes what is relevant or permitted. Flue announces the resource delta to
  the model.
- Do not toggle tools on every turn merely to imitate search; Flue documents
  that tool-set changes can invalidate prompt caches.
- A custom catalog/search tool may unlock a group in persistent state on the
  next render, but treat this as an application-specific fallback. Test replay,
  cache behavior, bad searches, and authorization before adopting it broadly.

Conditional visibility is stronger than a prompt instruction for prerequisites,
but it is not authentication. Bind tenant, repository, credentials, and other
trusted scope in application code or delivery context; never let the model
select them merely because the schema accepts a string.

### Encode ambiguity without native input examples

Use Valibot constraints, picklists, nested objects, and schema descriptions for
format and units. Keep cross-field rules in runtime validation where possible.
If a relationship cannot be expressed and evals show failures, put one concise,
contrasting example in the tool description. Do not paste 1–5 examples into
every Flue tool: Flue has no structured `input_examples` field today, so that
would tax every prompt without definition-time example validation.

## Framework additions worth considering

These should be provider-neutral Flue capabilities with provider-specific
lowering, not Anthropic property names copied into the public API.

### 1. Structured input examples — smallest, highest-confidence addition

Add validated examples to `defineTool`, inferred from its Valibot input type.
Reject an example that fails the schema at module load. Lower examples to native
provider metadata where supported; for unsupported providers either omit them
or use an explicit, measured fallback rather than silently bloating every
description.

Examples belong to the reusable definition because their semantics travel with
the tool. Loading policy belongs to the mount because the same tool can be core
in one agent and rare in another.

### 2. A deferred tool catalog

Add a catalog separate from the eager mounted set, with per-mount policy such as
`eager` or `deferred`, plus a namespace and short discovery summary. Keep a few
core tools eager. Provider adapters can lower the catalog to native Anthropic or
OpenAI tool search; other providers can use a Flue-owned deterministic search
and promotion path.

The design must preserve these invariants:

- Search can reveal only tools already authorized for that agent instance.
- Promotion uses the ordinary Flue executor; it does not bypass input/output
  validation, durability, cancellation, tracing, or reserved-name checks.
- Search and promotion are recorded canonically enough for crash recovery and
  conversation replay.
- Dynamic-resource signals and prompt-cache anchors remain coherent.
- MCP allowlists remain the security and scope boundary; deferred loading is a
  context optimization layered on top.
- Discovery metadata is indexed without eagerly serializing full schemas.

### 3. Programmatic callers

Add caller policy at mount time and a sandboxed code-orchestration runtime that
invokes tools through Flue's normal executor. Keep intermediate results in the
runtime and send only the program's final bounded output to the model.

The code path must preserve tool authorization, parsed Valibot inputs, output
validation, abort signals, timeouts, logs/traces, durable recovery, and per-call
identity. Do not expose service credentials through the ordinary `bash` tool or
let generated code call provider SDKs directly; that would bypass the very
controls Flue tools provide. Caller policy is routing metadata, not an access
control decision.

### 4. Provider strict decoding

Flue already validates generated input before `run`, returning a correction
opportunity on failure. A separate provider-neutral strictness option could ask
capable adapters for grammar-constrained tool arguments. It must degrade
explicitly on unsupported providers and must not replace runtime validation.

### 5. Effect annotations

Add provider-neutral read-only, destructive, idempotent, and open-world
metadata, and preserve compatible MCP annotations when adapting remote tools.
Use it for planning, confirmation UX, and observability, not as authorization.
The executor must still enforce trusted scope and the durable runtime must still
assume an external side effect can run more than once around a crash boundary.

## Suggested delivery order

1. Document and evaluate composite tools, MCP allowlists, output schemas, and
   conditional mounting using the existing surface.
2. Add validated structured input examples.
3. Add a provider-neutral deferred catalog with native adapters and a fallback.
4. Add programmatic callers only after the executor, durability, observability,
   and sandbox invariants are specified and tested.
5. Add provider strict decoding and effect annotations independently; they solve
   malformed structure and risk signaling, not discovery or orchestration.

For each step, use held-out Flue evals and record task success, semantic argument
accuracy, tool-search recall, model turns, tool calls, tokens, latency, and
errors. An optimization is not successful if it saves prompt tokens but adds
more search failures or unsafe retry behavior.

Sources: [Flue tools](https://flueframework.com/docs/guide/tools/),
[Flue MCP](https://flueframework.com/docs/guide/mcp/),
[Flue evals](https://flueframework.com/docs/guide/evals/),
[Flue Agent API](https://flueframework.com/docs/reference/agent-api/),
[Anthropic — advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use),
[Anthropic — writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
