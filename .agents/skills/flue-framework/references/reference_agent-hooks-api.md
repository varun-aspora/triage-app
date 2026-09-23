---
title: Agent Hooks API
source: https://flueframework.com/docs/reference/agent-hooks-api/
bundled_docs: bunx flue docs read reference/agent-hooks-api
version: 2.0.8
reviewed: 2026-09-17
---

# Agent Hooks API

## What and when

Every hook an agent function can call while it renders — `useModel` through the four event hooks
— plus the render contract that governs all of them. Read this when authoring or debugging an
agent's hook calls: which hooks are required, which may be conditional, what scope a value is read
at, and what a render is even allowed to do. This page covers each hook's own contract; the
resource shapes hooks consume (`defineTool`, `defineSkill`, `defineSubagent`,
`defineMcpConnection`) and the programmatic surface around agents (`dispatch()`, `init()`,
`start()`, routing, the harness) are `reference_agent-api.md`.

All symbols are exported from `@flue/runtime` unless noted.

## Public API index

| Hook | Purpose |
| --- | --- |
| `useModel()` | Declare the agent's LLM and tuning. **Required.** |
| `useSandbox()` | Attach the agent's execution environment. |
| `useTool()` | Mount a model-callable tool. |
| `useMcpConnection()` | Declare a remote MCP server. |
| `useSkill()` | Mount a skill in the catalog. |
| `useSubagent()` | Declare a `task`-tool delegate. |
| `useInstruction()` | Append raw instruction text. |
| `usePersistentState()` | Durable per-instance state. |
| `useInitialData()` | Read instance-creation data. |
| `useDelivery()` | Read the message in front of the model. |
| `useDispatchMessage()` | A dispatcher bound to this instance. |
| `useDataWriter()` | Stream named data parts to clients. |
| `useAgentStart()` | Run a callback when work starts on a delivered message. |
| `useAgentFinish()` | Run a callback at every would-stop point of a response. |
| `useResponseStart()` | Observe a response's true start. |
| `useResponseFinish()` | Observe a response's true end. |

## Rendering and the rules of hooks

The runtime renders the agent function before every model call: at each turn, and the moment a
delivery joins a live response. Every render starts from a fresh frame; hooks record onto it in
call order.

**Call-site rules:**

- Hooks may only be called while the agent function renders: synchronously in its body, or in a
  custom hook it calls. Called anywhere else (tool `run` functions, event-hook callbacks, module
  scope) every hook throws `[flue] <hook>() was called outside an agent function.`
- A custom hook is a plain function; hooks it calls record exactly as if the agent body called
  them directly.
- Renders are **pure reads**. The write functions hooks return (`usePersistentState` setters,
  `useDataWriter` writers, the `useDispatchMessage` dispatcher) throw when called during a render —
  call them from tool `run` and other callbacks that run while the agent is responding.

**What may vary between renders, and what may not:**

- **Conditional and reorderable** — `useTool`, `useSkill`, `useSubagent` (set changes narrate as
  `resources` signals); `useMcpConnection` (conditional too, submission-granularity — a change
  takes effect at the next submission); `usePersistentState` (keyed by name, not order/presence);
  the four event hooks (no durable identity — each seam runs whatever the current render
  declares); `useSandbox` **presence** (a flip swaps the environment at the next turn boundary,
  narrated as an `environment` signal).
- **Identity-invariant** — `useDataWriter` names must be declared **identically on every render**
  (the response's client-facing identity); a delta between consecutive renders throws naming the
  added/removed names.
- **Required, exactly once** — `useModel`. The argument may vary render to render; the call itself
  may not disappear (`[flue] ... requires a model. Call useModel('provider-id/model-id') in the
  agent function.`).
- Within one render, duplicate names throw everywhere they identify something: tool names, MCP
  server names, skill names, subagent names, state names, data-part names. `useModel` and
  `useSandbox` throw when called twice in one render.

**Value scoping:**

- `useModel` values (model, `thinkingLevel`, `compaction`), the `useSandbox` factory and `cwd`, and
  `useMcpConnection` definitions are **submission-scoped**: read once when a submission starts. A
  later render's different value takes effect on the *next* submission, not mid-run — except
  `useSandbox` *presence*, re-read at every turn boundary.
- Resource sets (tools, skills, subagents) and instruction text are **per-render**: each model
  call uses what the current render declared.

**Root and subagent renders:**

- A delegate's agent function renders in its own **subagent frame** at delegation time, fresh per
  task. `useTool`, `useSkill`, `useInstruction`, nested `useSubagent`, and custom hooks compose as
  usual there.
- Instance-scoped and client-facing hooks **throw in a subagent render**: `useModel` (the
  delegate's model comes from its `SubagentDefinition`), `useSandbox` (delegates share the
  parent's environment), `useMcpConnection`, `usePersistentState`, `useDataWriter`,
  `useDispatchMessage`, and all four event hooks. `useInitialData()` returns `undefined` instead of
  throwing; `useDelivery()` returns the parent's task prompt.

**The four event hooks** (`useAgentStart`, `useAgentFinish`, `useResponseStart`,
`useResponseFinish`) run callbacks at fixed lifecycle seams, under one shared contract:

- One **response** may absorb several delivered messages (deliveries joining at turn boundaries).
  `useAgentStart` runs once per delivered message; `useAgentFinish` runs at every would-stop point;
  `useResponseStart`/`useResponseFinish` run once per response, at its true start/end.
- No durable identity — declare conditionally, reorder, add/remove across deploys; each seam runs
  whatever the current render declares. Identity within a render is declaration order.
- `useAgentStart`/`useAgentFinish` are awaited, may be async, receive a `FlueHarness`;
  `useResponseStart`/`useResponseFinish` are synchronous observers — a returned promise fails the
  submission.
- A callback throw **fails the submission**.
- Callbacks run **at-least-once**: durable outcomes (signal appends, state writes) commit
  atomically per seam, so a crash mid-seam leaves nothing durable and re-runs the callback. Durable
  effects never duplicate; external side effects (network, files) may rarely happen twice — make
  them idempotent or guard with persistent state.

## `useModel()`

```ts
function useModel(model: string, options?: UseModelOptions): void;

interface UseModelOptions {
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

Declares the agent's model. **Required** — a render without it cannot start. Exactly once per
render; a second call throws, and a subagent render throws (delegates declare their model on
`useSubagent`'s definition).

- `model` — `'provider-id/model-id'` (e.g. `'anthropic/claude-sonnet-4-6'`). An unresolvable
  specifier fails the submission at initialization. Catalog and resolution rules in
  `guides_models.md` and `reference_provider-api.md`.
- `options.thinkingLevel` — agent-wide default reasoning effort; individual `harness.prompt()`
  calls may override. Unset substitutes `'medium'`. Unknown value throws.

  > **Resolved:** `'max'` is a real `thinkingLevel`, verified directly against the installed
  > package (`ThinkingLevel` is re-exported from `@earendil-works/pi-agent-core` through
  > `@flue/runtime`, and its 2.0.8 union includes `'max'`). If you encounter a copy of this page
  > (or the live `flueframework.com/docs/reference/agent-hooks-api/`) that omits `'max'` from
  > `ThinkingLevel`, that copy is stale — trust the installed type, not the prose.
- `options.compaction` — threshold-compaction config (`CompactionConfig`, below), or `false` to
  disable *threshold* compaction (overflow recovery and explicit `harness.compact()` still compact
  regardless).
- Unknown option fields throw.
- Values are **submission-scoped**: read when a submission starts; a state-derived value takes
  effect on the next submission, not mid-run.

## `CompactionConfig`

```ts
interface CompactionConfig {
  reserveTokens?: number;
  keepRecentTokens?: number;
  model?: string;
}
```

- `reserveTokens` — headroom reserved in the context window; compaction triggers when used tokens
  exceed `contextWindow - reserveTokens`. Defaults to a model-aware value capped at 20,000 tokens,
  shrunk for smaller output limits and small context windows. Positive integer.
- `keepRecentTokens` — recent tokens preserved verbatim after compaction; older messages fold into
  the summary. **Default `8000`.** Lower values compact more aggressively at the cost of recent
  fidelity. Positive integer.
- `model` — specifier override for summarization calls. Defaults to the session's model.
- Unknown fields throw.

## `useSandbox()`

```ts
function useSandbox(sandbox: SandboxFactory, options?: UseSandboxOptions): void;

interface UseSandboxOptions {
  cwd?: string;
}
```

Attaches the environment this agent instance runs in. The factory's `createSandbox()` builds the
filesystem/exec surface once per initialized harness (adapters key durable resources on the
instance id); its `tools()`, when present, **replaces** the sandbox-backed model-facing tool set.
Without the hook: no built-in file/shell tools, no workspace context in the system prompt, no
workspace-skill discovery, and `harness.sandbox` throws. Full `SandboxFactory` contract in
`reference_sandbox-api.md`; first-party factories are `bash()` (a just-bash instance) and
`local()` (`@flue/runtime/node`).

- `sandbox` — a `SandboxFactory` value, passed directly (already lazy — the expensive
  `createSandbox()` call happens once, at initialization). A value with no `createSandbox` (or the
  deprecated `createSessionEnv`) throws; a non-function `tools` property throws.
- `options.cwd` — the working directory inside the environment. Non-empty string. Read once at
  submission start. Unknown option fields throw.
- At most once per render; second call throws. Subagent renders throw — delegates share the
  parent's environment (scope with the task call's `cwd` instead).
- Re-renders **never** rebuild the environment.
- Conditional: presence is read at initialization and at every turn boundary. A flip swaps the
  environment before the next model call (attach resolves the declared factory; detach removes it
  and its tools, nothing carries over), announced as one `environment` signal restating full
  current state.
- Only **presence** is observable across renders (factories are fresh objects every render).
  Swapping one factory for another while staying attached takes effect at the *next submission's*
  initialization, not mid-run.
- A condition derived from persistent state replays durably: every later submission re-attaches
  the same declaration, and id-keyed adapters resolve back to the same durable workspace.

## `useTool()`

```ts
function useTool(tool: ToolDefinition): void;
```

Mounts a model-callable tool for the current render. Accepts a `defineTool(...)` value or an
inline definition object (same validation applied at the mount site). Whether called in the agent
body or a custom hook, the tool joins the render's single flat tool set. What a tool *is* — the
full contract, `ToolContext`, `harness`/`durable` — is `defineTool()` in `reference_agent-api.md`
and the walkthrough in `guides_tools.md`.

- Mounts may be conditional; set changes narrate as `resources` signals. An unmounted tool cannot
  be called at all.
- Duplicate tool names across the whole render throw `ToolNameConflictError`.
- Invalid definitions throw at mount with the same messages as `defineTool()`.

## `useMcpConnection()`

```ts
function useMcpConnection(definition: McpConnectionDefinition): void;
```

Declares a remote MCP server whose tools this agent uses. Accepts an `McpConnectionDefinition`
(typically `defineMcpConnection(...)`'s frozen export, or the same shape inline). The runtime
connects when a submission initializes — inside request context, on every target, all declared
servers in parallel — and mounts tools as `mcp__<server>__<tool>` into the render's flat tool set.
Definition shape and adaptation contract in `reference_agent-api.md#mcpconnectiondefinition`;
usage patterns in `guides_mcp.md`.

- Read once per submission at initialization. A conditional declaration takes effect on the next
  submission, narrated as a `resources` signal.
- Connections are reused for the instance's in-memory lifetime; definitions read at first connect
  (`auth` excepted — resolved per request). A failed connect fails the submission before the model
  runs and is never cached, unless `optional: true` mounts zero tools instead and announces the
  gap.
- Duplicate server names in one render throw. **Subagent renders throw** — declare the connection
  on the root agent.

## `useSkill()`

```ts
function useSkill(skill: Skill): void;

type Skill = SkillReference | SkillDefinition;

interface SkillReference {
  readonly __flueSkillReference: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
```

Mounts a skill in the agent's catalog. Skills are progressive disclosure: every mounted skill costs
one always-present catalog line (name + description) in the system prompt; the model pulls full
instructions on demand via the framework's `activate_skill` tool — the briefing arrives as a tool
result, so the prompt prefix never changes. Supporting files stay lazy until explicitly read.

- Accepts a `SkillReference` (a `SKILL.md` import's value, packaged automatically by the build, or
  a `defineSkill(...)` result) or an inline `SkillDefinition`, validated at the mount site. Full
  definition contract in `reference_agent-api.md#skilldefinition`.
- Mounting the same skill name twice in one render throws.
- Mounts may be conditional; catalog changes narrate as `resources` signals.
- Always-on content needs no skill: import markdown as a string and pass it to
  `useInstruction()`.

## `useSubagent()`

```ts
function useSubagent(subagent: SubagentDefinition): void;
```

Declares a delegate the model can hand focused work to via the framework's `task` tool. Delegation
is a declared capability: `task` is always in the tool set with a fully static spec (either
changing would rewrite the serialized tools block and invalidate the prompt cache), the roster
lives in the system prompt's "Available Agents" section, and the tool's required `agent` parameter
only resolves against declared subagents — with an empty roster the tool is inert. Definition shape
(`SubagentDefinition`, `defineSubagent()`, `GeneralSubagent`) is `reference_agent-api.md`.

- Duplicate delegate names in one render throw. Declarations may be conditional; roster changes
  narrate as `resources` signals.
- The delegate's `agent` function renders at delegation time, in its own frame, fresh per task —
  closures read current values; two delegations to the same subagent render independently.
- The delegate is isolated from the parent: nothing flows in except the shared environment and,
  unless overridden, the parent's model and reasoning effort. It runs a detached session; only its
  final text returns to the parent.

## `useInstruction()`

```ts
function useInstruction(text: string): void;
```

Appends raw instruction text for the current render — the deliberately low-level escape hatch.
Text lands after the agent's returned instruction, in call order, joined with blank lines; the
author owns all formatting. No structure, no identity, no per-fragment change tracking — the
composed document is digest-tracked as a whole (see the `instructions` signal).

- `text` — required, non-empty after trimming; anything else throws.
- Callable in root and subagent renders, any number of times.

## `usePersistentState()`

```ts
function usePersistentState<T>(name: string, defaultValue: T): [T, StateSetter<T>];
function usePersistentState<T = unknown>(name: string): [T | undefined, StateSetter<T | undefined>];

type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
```

Durable agent state: an API over the instance's record log. Reads the value as of this render;
returns a setter that persists a new value, directly or via an updater resolved at call time.
Reads are render-time snapshots; writes are silent — never post a message, never wake the agent,
never re-render mid-run. The next render reads the latest persisted values.

- Values are JSON: writes normalize through a JSON round-trip and throw on non-serializable input.
  Setting `undefined` throws — there is no unset; a name, once written, always has a value.
  `defaultValue` fills in before the first write and is never itself persisted.
- The updater form (`set((previous) => next)`) resolves `previous` at **call time** through the
  attempt's write buffer, not the render snapshot the closure was born with — two callbacks in one
  turn composing with updaters cannot drop each other's writes. Any function argument is treated as
  an updater.
- Writing a value **deep-equal** to the current one is a no-op — no record appended.
- Writes made by tools become durable **atomically with the tool batch** that made them: if the
  batch settles, the write is durable; if recovery settles it as interrupted, the write never
  happened.
- The setter throws during render (renders are pure reads) and on bare tooling/test renders with no
  durable runtime behind them.
- Scoped to the instance, keyed by `name`. Declaring the same name twice in one render throws;
  declaring conditionally across renders is legal — a render that skips the declaration didn't
  touch it, and the recorded value is read again when the declaration returns.
- **Subagent renders throw** — durable state is instance-scoped; pass what a delegate needs through
  the task prompt.
- The type parameter is compile-time only — nothing parses persisted values at runtime.

## `useInitialData()`

```ts
function useInitialData<T = unknown>(): T;
```

Reads the instance's creation data — the `initialData` a caller sent with the instance's first
contact, recorded exactly once and constant for the instance's whole life. Evolving facts belong
in `usePersistentState`; per-message facts in `useDelivery`.

- With an `initialData` schema static on the agent, the value is validated at creation (a mismatch
  fails the creating send, so it's always present here) and the hook returns the schema-parsed
  output. Without a schema, whatever the creator sent is returned untyped.
- `initialData` sent to an existing instance is ignored — nothing can change the recorded value.
- The value **is** `undefined` when creation carried no data, on bare tooling/test renders, and in
  subagent renders (a delegate has no creation data of its own). Say so in the type:
  `useInitialData<Config | undefined>()`.
- Part of the durable record stream but **never served to clients**. Still not a secrets channel —
  keys/tokens stay in the environment.

## `useDelivery()`

```ts
function useDelivery(): DeliveredMessage;
```

Reads the message currently in front of the model, as the validated `DeliveredMessage` shape every
transport admits (`reference_agent-api.md#deliveredmessage`). The value is a cursor: starts as the
delivery that woke the response, advances whenever a new message reaches the model (a join at a
turn boundary, or a signal appended by an event-hook callback). It gives code the same access the
model has, so tools need not depend on the model echoing values back into their input.

- Transport- and origin-agnostic: HTTP prompt, `dispatch()`, and an event hook's `append` produce
  the same shape.
- Framework narration signals (`resources`/`instructions`/`environment`) **do not** advance the
  cursor.
- Constant within one render; fresh at the next. A `useAgentStart` callback for a joined message
  reads that message.
- **Crash-safe**: a resumed attempt derives the same cursor from the durable record stream the live
  attempt saw.
- Subagent render: the delivery is the parent's task prompt as a `kind: 'user'` message (task
  images ride as `attachments`).
- Always present at runtime — a bare tooling/test render with no delivery behind it throws.

## `useDispatchMessage()`

```ts
function useDispatchMessage(): (message: DeliveredMessageInput) => Promise<DispatchReceipt>;
```

Gets a dispatcher bound to this instance — the agent-scoped form of top-level `dispatch()`. The
returned function takes just the message; there is no `initialData` and no `uid` (the instance
already exists). Semantics are identical to the global verb by construction (same queue, admission,
delivery — one accepted order shared with direct HTTP prompts).

- A bare string is shorthand for `{ kind: 'user', body }`.
- A dispatch to the busy own instance joins the live response at the next turn boundary — durably
  admitted, its own `useAgentStart` run, read by the model on its next turn — without interrupting
  the turn in flight. To an idle instance it wakes a new response. A delivery that misses the live
  response runs as its own submission — never lost.
- A joined delivery settles when the response that carried it settles, with the same outcome,
  under the host response's durability budget. A joined HTTP prompt still writes its own
  `submission_settled` record.
- Each call is a durable delivery with its own receipt — like any external side effect in a
  re-attempted tool, a re-run dispatches again. Design for at-least-once.
- Throws when called during render, on bare tooling/test renders, and before a runtime is
  configured. **The hook itself throws in subagent renders** — a delegate has no instance of its
  own; it returns what it produced as its task result instead.

## `useDataWriter()`

```ts
function useDataWriter<TSchema extends v.GenericSchema>(
  name: string,
  options: { schema: TSchema },
): (data: v.InferOutput<TSchema>) => void;
function useDataWriter(name: string): (data: unknown) => void;
```

Declares a named, client-facing data part and returns a write-only function that streams it.
Output is one-way and non-reactive: the model never sees data parts, writes never re-run the
agent, and nothing is read back. Each write is appended durably and streamed immediately, so a
part can show live progress mid-tool-run.

- `name` — the part's identity within the response (`data-<name>` on the response message's
  parts, AI SDK convention). The first write places the part; later writes update it in place.
  Mounting emits nothing.
- `options.schema` — validates every write; throws on mismatch. Unknown option fields throw.
- Values are JSON: writes normalize through a JSON round-trip; `undefined` and non-serializable
  values throw.
- The writer throws during render and on bare tooling/test renders with no durable runtime.
- **Names are unique per render and part of the render's structural identity** — declare
  unconditionally, identical on every render; a delta between renders throws. A custom hook that
  declares one inherits that rule. **Throws in subagent renders.**
- Parts land on the wire as data parts of the conversation message and on `AgentReply.data`.

## `useAgentStart()`

```ts
function useAgentStart(run: (ctx: AgentStartContext) => void | Promise<void>): void;

interface AgentStartContext {
  readonly append: (message: AgentAppendMessage) => void;
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
  readonly signal: AbortSignal;
}
```

Runs a callback when the agent starts work on a delivered message — after input is durable, before
the model's first turn. The intake seam: load what the model should wake up knowing, seed files,
write durable state, announce it by dispatching a signal.

- Runs **once per delivered message**, before the model reads it — including joined deliveries.
  Not reactive: never re-runs for a message already dealt with. For once-per-instance work, guard
  with durable state.
- A delivery's callbacks run **concurrently, in no guaranteed order** — the model waits for the
  slowest. Never rely on a sibling's writes; work needing ordering composes into one callback.
  Appended signals reach the conversation grouped in declaration order regardless of completion
  order.
- All output is explicit: model-facing signals via `useDispatchMessage()` (each is a real delivery
  that fires these hooks itself — guard with durable state), durable values via state setters,
  files via the harness.
- `ctx.append` writes a signal into this response **without** registering a delivery — no
  `useAgentStart` run of its own, no submission. Same `AgentAppendMessage` shape/validation as
  `useAgentFinish`'s `append`; legal only during the callback's execution window (a captured
  reference throws afterwards). Prefer dispatching; reach for `append` only when a delivery is
  wrong.
- `ctx.harness` materializes lazily on first access. `ctx.signal` is the submission's abort signal.
  `ctx.log` emits progress the model never sees.
- Compaction can eventually fold signals away — keep a callback's substance in durable state and
  files; a signal is the announcement, not the storage.

## `useAgentFinish()`

```ts
function useAgentFinish(run: (ctx: AgentFinishContext) => void | Promise<void>): void;

interface AgentFinishContext {
  readonly response: {
    readonly toolCalls: readonly AgentResponseToolCall[];
    readonly usage: PromptUsage;
  };
  readonly append: (message: AgentAppendMessage) => void;
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
  readonly signal: AbortSignal;
}

interface AgentResponseToolCall { tool: string; isError: boolean; }

interface AgentAppendMessage {
  kind: 'signal';
  type: string;
  body: string;
  attributes?: Record<string, string>;
  tagName?: string;
}
```

Runs a callback when the agent would otherwise finish responding — no more tool calls, response
about to settle. The **enforcement seam**: inspect what the response actually did and, if the work
isn't done, `append` a signal to send the model back to work within the same response.

- Not a passive tap: callbacks are awaited before the response settles. `ctx.append` steers a
  signal into the same response — another turn runs, and once dealt with the hook runs again at
  the next would-stop point. The response settles only when a cycle completes with no appends
  **and** no delivered input is waiting; queued deliveries join before finish evaluation, so several
  messages collect into several `useAgentStart` runs and one final `useAgentFinish`.
- `append` accepts only `kind: 'signal'` messages, same validation as delivered signals; a
  `kind: 'user'` message throws (new input belongs on `useDispatchMessage()`).
  Framework-reserved signal types throw too. Legal only during the callback's execution window.
- **Append vs. dispatch**: an append is the response steering itself — no `useAgentStart` run, no
  submission of its own, counted against the continuation ceiling. A dispatch from this callback is
  a real delivery — joins the same response, the hook fires again at the new true end, its own
  `useAgentStart` run, never counted against the ceiling.
- Runs on delivered submissions only, in declaration order, sequentially; multiple hooks share
  each cycle, and the response continues if *any* of them appended.
- `response.toolCalls` aggregates every tool call across all turns and re-attempts (durable
  records). `response.usage` is the aggregate so far (the settled total belongs to
  `useResponseFinish`).
- **Durable**: a continued cycle is a response-control checkpoint, recorded atomically with its
  signals — a resumed response drives a pending checkpoint instead of re-evaluating (never re-runs
  a completed cycle or appends twice). An interrupted evaluation re-runs wholesale (at-least-once).
- **Runaway protection**: a fixed, non-configurable ceiling of **32 continuation cycles** per
  response — a hook that appends unconditionally fails the submission loudly instead of settling
  as success. The submission's `durability.timeoutMs` remains the total wall-clock backstop;
  neither continuations nor joins extend it.

## `useResponseStart()`

```ts
function useResponseStart(run: ResponseMetadataCallback<ResponseStartContext>): void;

type ResponseMetadataCallback<TCtx> = (ctx: TCtx) => Record<string, unknown> | void;

interface ResponseStartContext {
  readonly metadata: Record<string, unknown>;
  readonly log: FlueLogger;
}
```

Observes the response's true start — once per response, synchronously, before the first model call
and before any `useAgentStart` callback. Return a plain object to deep-merge onto the response
message's metadata (AI SDK convention: the message's `metadata` field). Return nothing to observe
without attaching.

- Once per response: joined deliveries re-fire `useAgentStart`, but the response only wakes once —
  this hook does not re-fire. A resume whose response already has durable assistant steps skips it;
  a re-attempt from before the first durable step re-runs it (at-least-once).
- **Synchronous observer**: no append, no dispatch, no harness. A returned promise fails the
  submission — async start-seam work belongs in `useAgentStart`.
- `ctx.metadata` is metadata accumulated so far (earlier hooks' contributions, declaration order),
  handed in at call time — never a stale render capture. Returns deep-merge: later keys win,
  `undefined` values skipped, prototype-polluting keys (`__proto__`, `constructor`, `prototype`)
  dropped. A non-object/array/promise return fails the submission.
- **Fail-fast**: a throw fails the submission — no retry, no recovery.
- Metadata is model-invisible and non-reactive; the runtime stamps no keys of its own. Reaches
  clients on the conversation stream and on `AgentReply.metadata`.

## `useResponseFinish()`

```ts
function useResponseFinish(run: ResponseMetadataCallback<ResponseFinishContext>): void;

interface ResponseFinishContext {
  readonly metadata: Record<string, unknown>;
  readonly response: {
    readonly usage: PromptUsage;
    readonly toolCalls: readonly AgentResponseToolCall[];
  };
  readonly log: FlueLogger;
}
```

Observes the response's true end — once per response, synchronously, after the last
`useAgentFinish` cycle settles and every queued output write has flushed. Same return contract,
merge rules, and failure semantics as `useResponseStart()`.

- Runs after the final finish cycle, when the response actually settles; `response.usage`/
  `response.toolCalls` are final.
- `ctx.metadata` includes what `useResponseStart` hooks attached (read from the durable record
  log — survives re-attempts) plus earlier finish hooks' contributions.
- Async finish-seam work belongs in `useAgentFinish`.

## Custom hooks

A custom hook is a plain function, named with a `use` prefix by convention, that calls other hooks.
No registration, no wrapper — the render frame is ambient, so hooks called inside it record
exactly as if the agent body called them directly, in the same call order. Custom hooks may take
arguments, return values, and compose (a custom hook may call other custom hooks):

```ts
function useRetention(active: () => boolean) {
  useTool({
    ...offerCredit,
    run: (ctx) => (active() ? offerCredit.run(ctx) : 'Refused: no churn risk on record.'),
  });
  useInstruction(
    'Only while the customer is weighing cancellation: you may offer retention incentives.',
  );
}
```

All rules of hooks apply through custom hooks unchanged — a custom hook called outside a render
throws at its first inner hook call, and per-render uniqueness (one `useModel`, one `useSandbox`,
unique names) counts hooks called through any depth of custom hooks.

## Recommended patterns

- Gate a capability with a conditional `useTool`/`useSkill`/`useSubagent` rather than instructing
  the model not to use it — an unmounted resource literally cannot be called.
- Compose repeated gate + tools + instruction shapes into a custom hook (`useRetention` above)
  instead of duplicating the pattern across agents.
- Use `useAgentStart` for intake (seed state/files, announce via dispatch) and `useAgentFinish` for
  enforcement (verify the response actually did the work, `append` to continue) — they are
  different seams with different output rules.
- Use `useResponseStart`/`useResponseFinish` only for cheap, synchronous metadata stamping;
  anything async or side-effecting belongs in the `useAgentStart`/`useAgentFinish` pair.
- Guard `useDispatchMessage()` calls made from inside `useAgentStart`/`useAgentFinish` with
  persistent state so an at-least-once re-run doesn't re-dispatch.
- Declare `useDataWriter` names unconditionally at the top of the render so the identity-invariant
  rule can never be violated by a later conditional branch.

## Avoid

- Don't call any hook from a tool `run`, an event-hook callback, or module scope — only the render
  itself (or a custom hook it calls) is a legal call site.
- Don't rely on `usePersistentState`'s setter to trigger a re-render or notify the client — writes
  are silent; the *next* render sees the new value.
- Don't declare `useDataWriter` conditionally — a delta between renders throws.
- Don't call `useModel`, `useSandbox`, `useMcpConnection`, `usePersistentState`, `useDataWriter`,
  `useDispatchMessage`, or an event hook inside a subagent render — all throw there.
- Don't assume a `useAgentFinish` `append` extends the durability timeout — only the continuation
  ceiling (32 cycles) and the submission's own `timeoutMs` bound it, independently.
- Don't treat `useResponseStart`/`useResponseFinish` as places to dispatch or use the harness — they
  are synchronous observers only.

## Gotchas and errors

- `useModel()`'s `thinkingLevel` accepts `'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`
  per this page's type — but the models guide additionally documents `'max'`; treat that as an
  open discrepancy (see the callout under `useModel()` and SKILL.md).
- A tool set change from `useTool` invalidates the provider's prompt cache **unless** the tool was
  added by a completed tool call (current Anthropic models except Haiku load it at its transcript
  position) — gate tools on state that changes rarely.
- `useSandbox` swaps only on **presence** flips across renders; swapping one factory for another
  while staying attached needs a new submission to take effect.
- `useAgentStart` callbacks for one delivery run concurrently with no ordering guarantee — a
  callback that depends on a sibling's write will race it.
- `useDataWriter`'s identity-invariant rule is stricter than every other hook family — it is the
  one place a conditional declaration is an error, not a supported pattern.
- `ResultUnavailableError`, `SessionBusyError`, and the tool validation errors these hooks'
  consumers can throw are documented fully in `reference_errors.md`.

## Related

- [Agent API](https://flueframework.com/docs/reference/agent-api/) — the agent module contract,
  `dispatch()`, `init()`, `start()`, routing, the harness surface, and the
  `defineTool`/`defineSkill`/`defineSubagent`/`defineMcpConnection` resource helpers every hook
  here mounts.
- [Agent Hooks guide](https://flueframework.com/docs/guide/agent-hooks/) — the walkthrough of
  hooks, state, event hooks, and data writers.
- [Agents guide](https://flueframework.com/docs/guide/building-agents/) — agent functions,
  `'use agent'`, and how an agent gets addressed.
- [Tools](https://flueframework.com/docs/guide/tools/),
  [Skills](https://flueframework.com/docs/guide/skills/),
  [Subagents](https://flueframework.com/docs/guide/subagents/),
  [MCP](https://flueframework.com/docs/guide/mcp/),
  [Sandboxes](https://flueframework.com/docs/guide/sandboxes/),
  [Models](https://flueframework.com/docs/guide/models/) — per-capability guides for the
  corresponding hook.
- [Durability](https://flueframework.com/docs/guide/durability/) — persisted-state atomicity and
  the event-hook durability contract.
- [Errors Reference](https://flueframework.com/docs/reference/errors/) — the error classes hooks
  and the tools/skills/subagents they mount throw.
