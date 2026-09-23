---
title: Agent API
source: https://flueframework.com/docs/reference/agent-api/
bundled_docs: bunx flue docs read reference/agent-api
version: 2.0.8
reviewed: 2026-09-17
---

# Agent API

## What and when

This is the agent module contract: every `@flue/runtime` export (plus `/node` and `/routing`
subpaths) that addresses, runs, or serves an agent from the outside — agent functions and
statics, `dispatch()`/`init()`/`start()`, HTTP routing, the harness, and the
`defineTool`/`defineSkill`/`defineSubagent`/`defineMcpConnection` resource helpers. Read this when
writing code that creates, calls, or mounts an agent from outside its own render. The hooks an
agent calls *while it renders* (`useModel`, `useTool`, `usePersistentState`, the event hooks) are
in `reference_agent-hooks-api.md`, not here.

## Public API index

| API/type | Purpose |
| --- | --- |
| `AgentFunction`, `Agent`, `AgentProps` | The agent function shape and its route-data props. |
| `'use agent'` directive | Build-time registration of a module's capitalized exports. |
| `AgentStatics`, `DurabilityConfig` | `agentName`, `initialData` schema, retry/timeout policy. |
| `DeliveredMessage`, `DeliveredMessageInput`, `DeliveredAttachment` | The one input shape every transport admits. |
| `dispatch()`, `AgentDispatchRequest`, `DispatchReceipt` | Fire-and-forget delivery to one instance. |
| Conditional sends (`uid`) | `AgentInstanceNotFoundError`, `AgentInstanceExistsError`. |
| `init()`, `AgentInstanceHandle` | Programmatic client: `dispatch`, `read`, `abort`. |
| `AgentReply`, `AgentRunError` | The settled reply shape and the failed/aborted rejection. |
| `getAgentInstance()` | Look up an instance's uid without sending anything. |
| `start()` (`@flue/runtime/node`) | Node bootstrap for scripts and tests, outside a built server. |
| `createAgentRouter()`, `Fetchable` | Mountable HTTP surface for one agent. |
| Harness (`FlueHarness`, `CallHandle`) | The environment/model surface behind harness tools and lifecycle hooks. |
| `defineTool()`, `ToolContext`, `ToolStep` | Tool authoring helper and its run context (full contract in the Tools guide). |
| `defineSkill()`, `SkillDefinition` | Inline skill authoring. |
| `defineSubagent()`, `SubagentDefinition`, `GeneralSubagent` | Delegate authoring. |
| `defineMcpConnection()`, `McpConnectionDefinition`, `createMcpConnection()` | Remote MCP server declaration and low-level connection. |
| Dynamic resources | The `resources`/`instructions`/`environment` narration signals and reserved signal types. |

Sibling reference pages: `reference_errors.md` (error classes), `reference_events.md`
(`observe()`/`instrument()`), `reference_provider-api.md` (`providers` config, `setProvider()`),
`reference_sandbox-api.md` (`SandboxFactory`/`Sandbox`), `reference_data-persistence-api.md`
(`PersistenceAdapter`), `reference_streaming-protocol.md` (the wire format behind
`createAgentRouter()`).

## Agent functions

```ts
type AgentFunction<TProps = void> = TProps extends void
  ? () => string | undefined | void
  : (props: TProps) => string | undefined | void;

type Agent = AgentFunction<AgentProps> & AgentStatics;
```

An agent is a plain synchronous function. Hooks called in its body attach capabilities; the
returned string is its instruction document. `Agent` is the addressable unit — every API on this
page that takes an agent (`dispatch()`, `init()`, `getAgentInstance()`, `createAgentRouter()`,
`start()`) takes the function value itself.

- Must return **synchronously**. Returning a promise throws `[flue] Agent functions must be
  synchronous.` Async work belongs in tools, event-hook callbacks, and resource factories.
- Must return a `string` or `undefined`. Anything else throws. A body with no `return` (a
  tools-only agent) is legal.
- The instruction document is composed in call order: the returned string first, then each
  `useInstruction()` contribution, joined with blank lines.
- Re-rendered before every model call. Renders never nest — an agent function that directly
  invokes another agent function throws `[flue] Re-entrant agent render.` Shared behavior composes
  through custom hooks; delegation goes through `useSubagent()`.
- Two tools, two skills, two subagents, or two state names with the same name in one render throw
  (a duplicate tool name throws `ToolNameConflictError`).

## `AgentProps`

```ts
interface AgentProps {
  id: string;
}
```

Passed to the **root** agent function only — its route data.

- `id` — the instance id: the `:id` URL segment, the `id` of a `dispatch()`/`init()` call, or
  `flue run`'s `--id`. Constant for the instance's whole life.
- A subagent's agent function receives no arguments; close over values explicitly.
- Reading `props.id` on a bare render with no instance behind it (direct renders in tests/tooling)
  throws.
- Prefer `initialData` + `useInitialData()` over encoding structured facts into `id`.

## The `'use agent'` directive

```ts
'use agent';

export function TriageAgent() { /* ... */ }
```

A plain string literal at the top of the module (before imports and any other statement) marks
the module for scanning. At build time Flue registers **every exported function with a
capitalized name** as an agent — one module may export several. Registration makes an agent
addressable to `dispatch()`/`init()`; it is separate from HTTP exposure, which is an explicit
`createAgentRouter()` mount.

The agent's **durable identity** (the slug keying conversation storage, and the Durable Object
class on Cloudflare) resolves in order:

1. The build-stamped binding the `'use agent'` transform captures as a string literal (survives
   minification).
2. The `agentName` static.
3. The function's own `name` (safe only in plugin-less contexts: `flue run`, unit tests, `start()`
   scripts).

- Identities must match `/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/` (exported as
  `AGENT_IDENTITY_PATTERN`) — PascalCase or kebab-case, no `:`, no leading digit. Invalid identities
  throw at registration.
- Duplicate identities across the registered set throw; registering the same function under two
  identities throws.
- `__flueBindAgentModule()` and `AgentIdentityBinding` are build-transform internals — not public
  API, do not call them.
- Outside a built application, `start()` registers agents explicitly instead.

## Agent statics

```ts
interface AgentStatics {
  agentName?: string;
  initialData?: v.GenericSchema;
  durability?: DurabilityConfig;
}
```

Plain properties the platform reads **without running the function** — assigned after the
declaration:

```ts
export function IssueTriage() { /* ... */ }
IssueTriage.agentName = 'issue-triage';
IssueTriage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
IssueTriage.durability = { maxAttempts: 5, timeoutMs: 7_200_000 };
```

- `agentName` — durable identity override, decoupling storage identity from the function name.
  Must match `AGENT_IDENTITY_PATTERN`. In a `'use agent'` module the value must be a **string
  literal**.
- `initialData` — a Valibot schema for instance-creation data, validated exactly once at first
  contact, synchronously, before anything durable is admitted. A mismatch — including absence,
  unless the schema accepts `undefined` — rejects the creating send. The schema-parsed output is
  what `useInitialData()` returns. Without a schema, whatever the creator sent is recorded
  untyped.
- `durability` — the submission retry policy, applied while the function is **not** running
  (including after a crash in the agent's own render). Unlike `agentName`, need not be a literal —
  express environment-dependent policy in the assigned expression.

## `DurabilityConfig`

```ts
interface DurabilityConfig {
  maxAttempts?: number;
  timeoutMs?: number;
}
```

- `maxAttempts` — total attempts before terminalizing `failed` (`SubmissionRetryExhaustedError`).
  The initial run counts as the first attempt. Positive integer. **Default `10`.**
- `timeoutMs` — wall-clock deadline from the first attempt's start; exceeding it aborts and settles
  `failed` (`SubmissionTimeoutError`). Turn-boundary joins and `useAgentFinish` continuations do
  not extend it. Positive integer. **Default `3_600_000`** (one hour).
- Unknown fields throw at validation. Absent the static, the store defaults above apply.

> **Docs disagree here.** The durability guide describes the deadline firing the attempt's abort
> signal *preemptively*; this page's canonical text says the deadline is checked **cooperatively**
> — before each turn and before recovery work, not preemptively during provider calls — so a hung
> provider call can outlive it (covered by the attempt budget instead). Verify against the
> installed package before writing a long-running tool against either assumption. See
> `advanced_durability.md` and SKILL.md's "Where the docs contradict themselves".

## `DeliveredMessage`

```ts
type DeliveredMessage =
  | { kind: 'user'; body: string; attachments?: DeliveredAttachment[] }
  | {
      kind: 'signal';
      type: string;
      body: string;
      attributes?: Record<string, string>;
      tagName?: string;
    };

type DeliveredMessageInput = string | DeliveredMessage;
type DeliveredAttachment = PromptImage & { filename?: string };
```

The unified input shape for `dispatch()`, the `init()` handle, `useDispatchMessage()`, and a direct
HTTP prompt (whose wire body is this shape verbatim). A bare string is shorthand for
`{ kind: 'user', body }`.

- `kind: 'user'` — a direct user turn. Produces a canonical `user_message` record, `purpose:
  'user'`. `attachments` carries images for vision-capable models:
  `{ type: 'image', data, mimeType, filename? }`, base64 `data` capped at 14 MiB of base64
  characters (`14 * 1024 * 1024`). Images are the only supported attachment.
- `kind: 'signal'` — everything beyond a 1:1 exchange (most channel activity): sender identity and
  structured metadata in `attributes`, content in `body`. Renders as an XML-tagged block, not a
  chat turn.
  - `type` — caller-defined event type (e.g. `'slack.message'`). Non-empty. Framework-reserved
    types (see Dynamic resources) are rejected at admission.
  - `attributes` — string-to-string map.
  - `tagName` — overrides the rendered XML tag (default `signal`); rendered unescaped, so it must
    be a valid XML name.
- A malformed message throws the stable `InvalidRequestError` (`invalid_request`) on every
  transport. Agent code reads the current message with `useDelivery()`.

## `dispatch()`

```ts
function dispatch(agent: Agent, request: AgentDispatchRequest): Promise<DispatchReceipt>;

interface AgentDispatchRequest {
  id: string;
  message: DeliveredMessageInput;
  initialData?: unknown;
  uid?: string | null;
  idempotencyKey?: string;
}

interface DispatchReceipt {
  submissionId: string;
  acceptedAt: string;
  uid: string;
}
```

Fire-and-forget delivery of one message to one agent instance. Resolves once the runtime has
**admitted and queued** the input — not once the model has replied. Use `init()`'s `read()` (or the
SDK's `wait()`) for the settled reply.

- `id` — target instance id, required. First contact creates the instance; there is no separate
  create step.
- `message` — snapshotted at admission.
- `initialData` — consulted **only when this send creates the instance**: validated against the
  `initialData` static and recorded once. Silently ignored on a continuing send — pair with
  `uid: null` to error instead. Combining with a string `uid` is rejected before anything durable
  happens (the condition forbids creation).
- `uid` — the send condition; see Conditional sends below.
- `idempotencyKey` — names one delivery (non-empty string, ≤256 characters), scoped to
  `(agent, instance id)`. Replaying the same key with the same payload returns the original
  receipt with `deduplicated: true`; different content under the same key returns `409
  submission_conflict`. A failed keyed submission stays failed — use a new key to request new
  work. **Verified directly against the installed runtime** (`dispatch-*.mjs`'s
  `parseDeliveredInput`/`parseIdempotencyKey`): the field is real and enforced on both
  `dispatch()` and the raw HTTP `POST` body, even though the published
  `flueframework.com/docs/reference/agent-api/` page's own `AgentDispatchRequest` listing and
  `@flue/sdk`'s typed `AgentPromptOptions` both omit it. Trust the field above, not an upstream
  copy that's missing it.
- The target must be a registered agent (`'use agent'` export or `start()` entry); an
  unregistered function, or calling before a runtime is configured, rejects. A missing `id`
  rejects with a plain `Error`; a malformed `message` throws `InvalidRequestError`.
- A dispatch to a busy instance joins the live response at the next turn boundary; to an idle
  instance it wakes a new response. A delivery that misses the live response runs as its own
  submission — never lost.
- **Target differences.** Cloudflare durably admits to the target's Durable Object and may retry
  after interruption. Node follows the configured persistence adapter (the default in-memory store
  is process-lifetime only). Both targets process **at-least-once** — design side effects to be
  idempotent.

## Conditional sends

`uid` is the send condition, with the instance uid playing the ETag:

- Omitted — unconditional: continue, or create.
- `'<string>'` — continue only that incarnation. A missing instance or mismatched uid rejects with
  `AgentInstanceNotFoundError` (`agent_instance_not_found`, HTTP `404`); nothing durable happens.
  Cannot combine with `initialData`.
- `null` — create only when no instance exists. An existing instance rejects with
  `AgentInstanceExistsError` (`agent_instance_exists`, HTTP `409`).

`AgentInstanceExistsError` carries the existing instance's uid on `.uid` and in `details` —
deliberately, so a caller can recover from the `409` and continue without a separate lookup. The
uid is accident prevention, not access control (that belongs in routing middleware). Both classes
are importable from `@flue/runtime`; full shapes in `reference_errors.md`.

The uid to condition on comes from a prior receipt/reply, or `getAgentInstance()`. Direct HTTP
carries the same condition as a reserved `uid` sibling on the message body; the `202` echoes `uid`
alongside `streamUrl`/`offset`/`submissionId` (see `reference_streaming-protocol.md`).

## `init()`

```ts
function init(agent: Agent, options?: InitOptions): AgentInstanceHandle;

interface InitOptions {
  id?: string;
  uid?: string | null;
}

interface AgentInstanceHandle {
  readonly id: string;
  dispatch(request: string | AgentHandleDispatchRequest): Promise<DispatchReceipt>;
  read(target: string | DispatchReceipt, options?: AgentReadOptions): Promise<AgentReply>;
  abort(): Promise<void>;
}

type AgentHandleDispatchRequest = Omit<AgentDispatchRequest, 'id' | 'uid'>;
// = { message: DeliveredMessageInput; initialData?: unknown }

interface AgentReadOptions {
  onEvent?: (chunk: ConversationStreamChunk) => void;
  signal?: AbortSignal;
}
```

The programmatic client for one instance. The handle is an **address, not a resource** —
`init()` performs no I/O; the instance is created on first contact exactly like any other
delivery, and the runtime resolves when the handle is *used*, so `init()` at module scope is safe.

- `id` — omit to mint a fresh unique id (a throwaway instance); pass a stable id to address it
  later. Empty/non-string throws; non-function `agent` throws `InvalidRequestError`.
- `uid` — the send condition for the handle's **first** contact (same semantics as `dispatch()`).
  After the first receipt the handle pins the contacted incarnation.

`handle.dispatch()` — same dispatch queue as every other transport, resolves at admission with the
same `DispatchReceipt`. Payload is the top-level request minus `id`/`uid`; a bare string is
shorthand for `{ message }`. A payload that isn't a string and has no `message` throws; a payload
carrying `id`/`uid` throws (pass those to `init(agent, { id, uid })`). A failed send condition
rejects with `AgentInstanceNotFoundError`/`AgentInstanceExistsError` before anything durable
happens.

`handle.read()` — awaits one submission's settlement, resolves with `AgentReply`. Target is a
dispatch receipt or bare `submissionId`.

- **Re-attachable**: settlement and reply are durable records — a read works from any process at
  any later time, and re-reading a settled submission returns the same reply. Nothing in memory is
  load-bearing between `dispatch()` and `read()`.
- Concurrent deliveries to one instance serialize, or join a live response at a turn boundary.
- Rejects with `AgentRunError` when the submission settles `failed` or `aborted`.
- `onEvent` receives every projected `ConversationStreamChunk` as it is durably recorded (see
  `reference_streaming-protocol.md`).
- `signal` cancels the **read only** — the submission keeps running and stays readable. To
  durably stop the agent's work, call `abort()`.
- Rejects with `AgentInstanceNotFoundError` when the instance was never contacted (a read waits for
  settlement, and there is nothing to settle).
- **Deadlocks by design** inside a tool reading a submission dispatched to the *currently running*
  agent: the delivery joins the tool's own live response, which cannot settle mid-tool. A tool
  never needs this — the harness is its own model surface; handles inside tools are for *other*
  instances.

`handle.abort()` — requests a **durable** abort of the instance's whole queue (running head plus
everything queued behind it). Resolves once the intent is recorded; the `aborted` settlement lands
asynchronously (a live `read()` observes it and rejects with `AgentRunError` outcome `'aborted'`).

All three verbs work anywhere a Flue runtime is configured: inside a server, in a standalone
script after `start()`, under `flue run`, and in a deployed Worker (including as Workflow steps,
where the receipt and settled reply each become a durable step result).

## `AgentReply`

```ts
interface AgentReply {
  text: string;
  data: Record<string, unknown[]>;
  metadata?: Record<string, unknown>;
  uid?: string;
  submissionId: string;
}
```

- `text` — final assistant text; `''` when none.
- `data` — named client data parts written via `useDataWriter`, keyed by part name, each an
  ordered array of writes.
- `metadata` — agent-authored response metadata (`useResponseStart`/`useResponseFinish`).
- `uid` — the contacted incarnation's uid.
- `submissionId` — the settled submission's id.

## `AgentRunError`

```ts
class AgentRunError extends Error {
  readonly outcome: 'failed' | 'aborted';
  readonly submissionId: string;
}
```

The `read()` rejection for a submission that settled `failed` or `aborted`. The settlement's
underlying error, when recorded, is attached as `cause`. Full settlement-error shape in
`reference_errors.md`.

## `getAgentInstance()`

```ts
function getAgentInstance(agent: Agent, id: string): Promise<AgentInstanceInfo | null>;

interface AgentInstanceInfo {
  id: string;
  uid?: string;
}
```

`null` when no instance exists, else its info (including the uid usable as a send condition).
`uid` is absent only mid-materialization. Most callers never need this — reach for it when code
that didn't create the instance wants to condition a send without attempting one first.

## `start()`

```ts
import { start } from '@flue/runtime/node';

function start(options: StartOptions): Promise<Flue>;

interface StartOptions {
  agents: readonly StartAgentEntry[];
  db?: PersistenceAdapter;
  env?: Record<string, string | undefined>;
  providers?: readonly Provider[];
}

type StartAgentEntry = Agent | StartAgentConfig;
interface StartAgentConfig { agent: Agent; name?: string; }

interface Flue {
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

The Node bootstrap for standalone scripts and test suites — mirrors what a built server does at
boot (registration, persistence, the durable coordinator) with no HTTP surface. After it resolves,
`init()`/`dispatch()`/`getAgentInstance()` work exactly as inside a server.

- `agents` — required, non-empty. Each entry is a function, or `{ agent, name }` for an identity
  override (inline/anonymous functions in tests). Identity resolves from the entry's `name`, else
  the agent's own identity — **never positionally**. An anonymous function with neither throws.
- `db` — defaults to in-memory SQLite (process-lifetime only). Pass `sqlite('./run.db')` (from
  `@flue/runtime/node`) to persist across runs. See `reference_data-persistence-api.md`.
- `env` — defaults to `process.env`.
- `providers` — omitted registers every Pi built-in (same as `flue run`); an empty array registers
  none; given explicitly it registers unconditionally, overwriting a same-ID `setProvider()` call
  made *before* `start()` (a call made after still wins — `setProvider()` always replaces on ID).
  See `reference_provider-api.md`.
- Returns a `Flue` handle: `stop()` drains in-flight work then disconnects persistence;
  `await using` cleans up automatically.
- **One process holds at most one Flue runtime** — `start()` throws when one is already
  configured (inside a server, call `init()`/`dispatch()` directly).

`@flue/runtime/node` also exports `local()` (sandbox factory) and `sqlite()` (persistence
adapter) — documented in the Node target guide's reference section.

## `createAgentRouter()`

```ts
import { createAgentRouter } from '@flue/runtime/routing';

function createAgentRouter(agent: Agent): Hono;
```

Builds the mountable Hono sub-app serving one agent's HTTP surface:
`app.route('/agents/support', createAgentRouter(Support))`.

| Route | Purpose |
| --- | --- |
| `POST /:id` | Send a prompt (body: `DeliveredMessage` + optional `initialData`/`uid`); `202` on admission. |
| `GET \| HEAD /:id` | Conversation stream read. |
| `POST /:id/abort` | Abort all in-flight/queued work for the instance. |
| `GET /:id/attachments/:attachmentId` | Attachment byte download. |

Full wire semantics in `reference_streaming-protocol.md`.

- Pure factory: no side effects, no options. Callable any number of times; mount the result at any
  path — conversations key by durable identity, never by URL.
- Handlers resolve the runtime at request time, so creating the router before bootstrap completes
  is fine.
- Throws at creation when the agent's identity is unresolvable (anonymous, no `agentName`) or
  invalid.
- Unmatched methods render the canonical `405` envelope; other errors render through the
  `reference_errors.md` transport envelope.
- **Carries no authentication.** Mounting is the exposure decision — compose auth middleware in
  the host app.
- Exposes `.fetch`, so it mounts in any fetch-based server framework too.

The parallel `createChannelRouter(routes)` (from `@flue/runtime`) serves a channel package's
declarative `routes` array the same way; see `advanced_channels.md`.

## `Fetchable`

```ts
import type { Fetchable } from '@flue/runtime/routing';

interface Fetchable {
  fetch(request: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>;
}
```

The structural contract for an authored `app.ts`'s default export. Any compatible `fetch()`
satisfies it, including a `new Hono()` instance. On Cloudflare, `env`/`ctx` are bindings/
`ExecutionContext`; on Node, Hono's Node-adapter bindings and `undefined`.

## Harness

```ts
interface FlueHarness {
  readonly name: string;
  prompt<S extends v.GenericSchema>(
    text: string,
    options: PromptOptions<S> & { result: S },
  ): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
  prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;
  compact(): Promise<void>;
  readonly sandbox: Sandbox;
}
```

The initialized agent environment owned by a runtime runner — handed to a `harness: true` tool's
`run` and to the `useAgentStart`/`useAgentFinish` contexts. There is no way to construct one
directly; it only exists inside an agent session, scoped to the invocation that received it.

### `harness.prompt()`

Runs a model operation in the harness's own **scratch conversation** — separate from the agent's
public conversation, never shown to clients. Repeated calls continue it (one active operation at a
time); it can delegate to the agent's declared subagents via `task`. Harness invocations count
against the delegation-depth cap, and child conversations they open are retained on the parent
conversation for inspection.

Pass `options.result` (a Valibot schema) to require validated structured data: the model must call
a framework-injected `finish` tool whose arguments validate against the schema, and the call
resolves with `PromptResultResponse` instead of freeform text. Giving up or exhausting follow-up
attempts rejects with `ResultUnavailableError`.

```ts
interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
  result?: S;
  tools?: ToolDefinition[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  images?: PromptImage[];
}

interface PromptResponse { text: string; usage: PromptUsage; model: PromptModel; }
interface PromptResultResponse<T> { data: T; usage: PromptUsage; model: PromptModel; }
interface PromptModel { provider: string; id: string; }
interface PromptUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

- `result` — validated structured data, resolved as `response.data`.
- `tools` — extra model-callable tools for this operation only.
- `model` — specifier override (`'provider-id/model-id'`); defaults to the agent's `useModel`.
- `thinkingLevel` — reasoning-effort override for this call.
- `images` — inline images for the operation's user message (requires a vision-capable model).
- `PromptUsage` aggregates every LLM call the operation dispatched (assistant turns,
  result-extraction retries, triggered compaction). `cost` follows the model's per-million-token
  rate table. Operation failures beyond aborts reject with typed `FlueError` subclasses (e.g.
  `SessionBusyError`).

### `CallHandle`

```ts
interface CallHandle<T> extends Promise<T> {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
```

`prompt()`'s awaitable return. Aborting (via `abort()` or `options.signal`) rejects with a standard
`AbortError` (`DOMException`). `signal` fires from either source, so tools passed to the call can
observe cancellation; `harness.sandbox.exec()` uses its own `options.signal` for the same purpose
since it resolves a plain `Promise`.

### `harness.compact()`

Triggers immediate compaction of the **harness's own scratch conversation** (the agent's main
conversation compacts automatically per `CompactionConfig`). No-op when nothing to compact; rejects
on summarization failure/abort, and with `SessionBusyError` when another operation is in flight.

### `harness.sandbox`

The agent's live `Sandbox` (from its `useSandbox()` declaration): `exec()`, file verbs (`readFile`,
`readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`), `cwd`, `resolvePath()`.
Full contract in `reference_sandbox-api.md`.

- Throws `[flue] This agent has no sandbox. ...` when the agent declared none.
- **Never recorded** in the conversation — this is plumbing the model shouldn't see, not the
  model's own file tools.
- `writeFile` creates missing parent directories in every mode.
- Relative paths resolve against the agent's `cwd`; use absolute paths for portability.
- **A live getter, not a snapshot** — a conditional `useSandbox()` may swap the environment at a
  turn boundary, and this property follows. Do not cache the reference across turn boundaries.

## `defineTool()`

```ts
function defineTool<...>(options: {
  name: string;
  description: string;
  input?: ToolInputSchema;   // Valibot schema; top-level object
  output?: ToolOutputSchema; // Valibot schema
  harness?: boolean;
  durable?: boolean;
  run(context: ToolContext<...>): ToolRunEnvelope<Output> | string | void | Promise<...>;
}): ToolDefinition;
```

Validates a tool definition and returns it frozen, so bad definitions fail at module load rather
than first render. Also importable from `@flue/runtime/tool`. Mount the result with `useTool()`.
The full authoring contract — `ToolContext`, harness/durable flags, output rules, the model-facing
call lifecycle, error semantics — is documented in `guides_tools.md` and cross-referenced from
`reference_agent-hooks-api.md#usetool`; this page only fixes the shapes:

```ts
type ToolContext<Input, Harness, Durable> = {
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
  readonly log: FlueLogger;
} & { readonly data: v.InferOutput<Input> }      // when `input` is declared
  & { readonly harness: FlueHarness }             // when `harness: true`
  & { readonly step: ToolStep };                  // when `durable: true`

interface ToolStep {
  do<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}
```

`ToolInput<TTool>` / `ToolOutput<TTool>` extract a tool's inferred argument/output types from its
definition. Errors this surface throws (`ToolInputValidationError`, `ToolOutputValidationError`,
`ToolOutputSerializationError`, `ToolNameConflictError`) are in `reference_errors.md`.

## `defineSkill()`

```ts
function defineSkill(definition: SkillDefinition): SkillDefinition;
```

Declares an inline skill in code, in the `defineTool()` mold — validates and returns frozen; the
runtime packages it the same shape a `SKILL.md` import produces, lazily, the first time it's
needed. Invalid definitions throw `SkillDefinitionValidationError` with field-level issues at
module load. Mount with `useSkill()`.

### `SkillDefinition`

```ts
interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
}
```

- `name` — lowercase ASCII letters/numbers/single hyphens, ≤64 chars. Required.
- `description` — the catalog line, ≤1024 chars. Required.
- `instructions` — the `SKILL.md` body, loaded on activation. Required, non-empty.
- `license`, `compatibility` (≤500 chars) — recorded in packaged frontmatter.
- `metadata` — string-to-string map recorded in frontmatter.
- `allowedTools` — space-separated pre-approved tools (experimental in the Agent Skills spec).
- `files` — supporting resources keyed by safe relative path (no leading `/`, no `.`/`..`
  segments, no backslashes, not `SKILL.md` itself); string or `Uint8Array` content.

## `defineSubagent()`

```ts
function defineSubagent(definition: SubagentDefinition): SubagentDefinition;
```

Validates and freezes a delegate definition — define once, mount from any agent with
`useSubagent(...)`. Per-mount overrides spread cleanly:
`useSubagent({ ...issueClassifier, model: 'anthropic/claude-haiku-4-5' })`.

### `SubagentDefinition`

```ts
interface SubagentDefinition {
  name: string;
  description: string;
  agent: AgentFunction;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}
```

- `name` — the `task` tool's catalog name for this delegate. Required, non-empty.
- `description` — how the model decides when to delegate. Required, non-empty.
- `agent` — the delegate's whole world. Required.
- `model`, `thinkingLevel` — override; inherit the parent turn's values when omitted.

### `GeneralSubagent`

```ts
const GeneralSubagent: SubagentDefinition;
```

A blank general-purpose delegate (`useSubagent(GeneralSubagent)`): shared environment tools,
filesystem context from its cwd, and the parent's model — none of the parent's instructions,
tools, skills, or subagents. Registered under the framework-reserved name `flue-general`.

## `defineMcpConnection()`

```ts
function defineMcpConnection(definition: McpConnectionDefinition): McpConnectionDefinition;
```

Validates and freezes a reusable MCP server declaration — define once, mount with
`useMcpConnection(...)` (which also accepts the shape inline). Per-mount overrides spread cleanly.

### `McpConnectionDefinition`

```ts
type McpTransport = 'streamable-http' | 'sse';
type McpAuth = string | (() => string | Promise<string>);

interface McpConnectionDefinition {
  name: string;
  url: string | URL;
  transport?: McpTransport;
  auth?: McpAuth;
  headers?: HeadersInit;
  requestInit?: RequestInit;
  fetch?: typeof fetch;
  timeoutMs?: number;
  resetTimeoutOnProgress?: boolean;
  tools?: string[];
  optional?: boolean;
}
```

- `name` — the `mcp__<server>__` tool namespace. Required.
- `url` — must parse as an absolute URL. Required.
- `transport` — default `'streamable-http'`; `'sse'` for legacy servers.
- `auth` — bearer credential (`Authorization: Bearer <token>`). A **function** resolves fresh per
  request (per-user/rotating credentials); a 401 re-resolves once and retries.
- `headers` — **static** extras merged into every request (set-wins over `requestInit`). Prefer
  `auth` for credentials.
- `timeoutMs` — per-request timeout; default is the MCP SDK's 60 seconds.
- `resetTimeoutOnProgress` — reset the timeout on server progress notifications. Default `false`.
- `tools` — allowlist by the server's own tool names, in order. Unknown/repeated/task-required
  names reject the connection.
- `optional` — default `false` (a failed connection fails the submission before the model runs).
  `true` mounts zero tools for the submission instead, announced as a `resources` signal
  (`resource: 'mcp'`) and a `log`-level warning; the next submission retries.
- Unknown/malformed fields throw, naming the offending field.

### `createMcpConnection()`

```ts
function createMcpConnection(definition: McpConnectionDefinition): Promise<McpConnection>;

interface McpConnection {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}
```

The low-level function underneath `useMcpConnection()` — connects and adapts the server's listed
tools into ordinary `ToolDefinition` values, for trusted application code that wants to own the
connection directly. **Node target only** at module scope (top-level `await`) — Cloudflare Workers
prohibit network I/O in global scope; a Worker that tries fails to boot only at `wrangler
dev`/deploy, not under `vite dev`. Use `useMcpConnection()` on Cloudflare.

- Adapted names: `mcp__<server>__<tool>`; characters outside `[A-Za-z0-9_-]` become underscores.
  Duplicate adapted names reject the connection.
- Discovery follows `tools/list` pagination; a repeated cursor throws. Task-execution-only tools
  are skipped with a console warning (allowlisting one is an error).
- A result's content flattens to text for the model; `isError` becomes a tool error. A declared
  output schema is validated; mismatch is an error.
- **The adapted definitions are complete — do not wrap them in `defineTool()`.**
- `close()` closes the underlying client; call it at shutdown. Any connection/discovery failure
  closes the client before the error propagates. (Hook-declared connections are runtime-owned —
  the runtime closes them.)

## Dynamic resources

Tools, skills, and subagents may be declared conditionally, so the model-usable set changes across
renders. The runtime never rewrites presentation surfaces the model already read — the system
prompt's skill catalog and the `task` tool's roster stay frozen on a durable baseline snapshot, so
a skill/subagent flip never invalidates the provider's prompt cache. Each render's declared set is
diffed against the last-narrated snapshot and appended as **signals**. A custom-tool change *does*
rewrite the native tools array (cache-invalidating) unless the tool was added by a completed tool
call — current first-party Anthropic models except Haiku load such an addition at its transcript
position.

- **`resources` signal** — emitted at a turn boundary when declared tools/skills/subagents differ
  from the last-narrated set (one signal per changed kind). Lists additions as catalog lines,
  removals/updates as one-liners, and always ends with the full current roster (names only).
- **`resources` signal, `resource: 'mcp'`** — emitted before a response's first turn when an
  `optional: true` MCP connection failed to resolve. Re-announced each affected response; recovery
  has no signal of its own.
- **`instructions` signal** — emitted when the composed instruction document changes between
  renders (digest-detected). Body is the fixed marker `System instructions updated.`
- **`environment` signal** — emitted when a conditional `useSandbox()` presence flip swaps the
  environment at a turn boundary. Always a full snapshot (cwd, complete tool roster, skill/subagent
  catalogs), never a delta, and supersedes that boundary's trailing `resources` narration.
- **Compaction rebaselines** — the post-compaction system prompt snapshots the then-current
  resource sets; delta narration restarts from that baseline.

**Reserved signal types** — always framework-authored; `dispatch()` admission and event-hook
`append` reject them: `resources`, `instructions`, `environment` (narration), `stream_interrupted`,
`stream_continued`, `submission_aborted`, `submission_interrupted` (recovery/settlement
advisories), and `compaction`/`memory` (held for future framework use). Everything else is
application vocabulary. Narration signals never advance the `useDelivery()` cursor.

## Recommended patterns

- Treat `dispatch()` as admission-only; read outcomes with `init().read()` or the SDK's `wait()`.
- Persist a `DispatchReceipt`/`submissionId` when an external system needs the eventual reply — a
  read is re-attachable from any process at any later time.
- Pin a specific incarnation with `uid` whenever a caller must not silently create or continue the
  wrong instance; recover a `409`'s existing uid from `AgentInstanceExistsError.uid` instead of a
  separate lookup.
- Define reusable tools/skills/subagents once with `defineTool`/`defineSkill`/`defineSubagent` and
  mount the frozen value, so bad definitions fail at module load, not first render.
- Compose auth/CORS middleware around `createAgentRouter()`'s mount point rather than expecting the
  router to carry any itself.
- Use `harness: true` tools for staged file + focused model work behind one call; `durable: true`
  for effects that must survive a crash. See `guides_tools.md`.

## Avoid

- Don't treat a resolved `dispatch()` promise as "the agent replied" — it resolves at admission.
- Don't call `createMcpConnection()` at Cloudflare Worker module scope — use `useMcpConnection()`.
- Don't wrap an MCP-adapted `ToolDefinition` in `defineTool()`.
- Don't call another agent function directly from inside an agent render — that's a re-entrant
  render, not delegation; use `useSubagent()`.
- Don't cache `harness.sandbox` across turn boundaries when the agent conditionally swaps
  environments.
- Don't read a submission dispatched to the *currently running* agent from inside one of its own
  tools — it deadlocks.
- Don't rely on `agentName`/`durability` being re-evaluated live — statics apply while the
  function is not running.

## Gotchas and errors

- `useModel()` is required; a render that never calls it cannot start.
- Agent identity resolution order (build-stamped binding → `agentName` → function name) means a
  minifier-safe identity requires either the build transform or an explicit `agentName`.
- `durability.timeoutMs` enforcement is disputed between the durability guide (preemptive) and this
  page (cooperative) — see the callout under `DurabilityConfig` above.
- `AgentInstanceExistsError`/`AgentInstanceNotFoundError` are HTTP-typed (`409`/`404`) and are the
  only two error classes with public constructors carrying `status`/`headers` through the
  unexported `FlueHttpError` base — see `reference_errors.md`.
- `createAgentRouter()` is a pure factory with no auth — a request served against an unmounted or
  misconfigured runtime errors, but that is not the same as unauthorized.
- `init()` itself performs no I/O — a stale reference to a handle after the process restarts is
  still valid; the runtime resolution happens at call time.
- `ResultUnavailableError` and `SessionBusyError` (harness operation failures) are plain/`FlueError`
  classes documented fully in `reference_errors.md`.

## Related

- [Agent Hooks API](https://flueframework.com/docs/reference/agent-hooks-api/) — every hook
  callable during a render, including `useTool`, `useSkill`, `useSubagent`, `useMcpConnection`,
  and the event hooks that receive this page's harness.
- [Agents guide](https://flueframework.com/docs/guide/building-agents/) — the walkthrough of
  agent functions, registration, and interaction surfaces.
- [Tools](https://flueframework.com/docs/guide/tools/) — full tool-authoring contract and the
  harness/durable tool patterns.
- [Skills](https://flueframework.com/docs/guide/skills/) ·
  [Subagents](https://flueframework.com/docs/guide/subagents/) ·
  [MCP](https://flueframework.com/docs/guide/mcp/) — capability-specific guides for
  `defineSkill`/`defineSubagent`/`defineMcpConnection`.
- [Routing](https://flueframework.com/docs/guide/routing/) — mounting and protecting
  `createAgentRouter()`.
- [Durability](https://flueframework.com/docs/guide/durability/) — `DurabilityConfig`, recovery,
  and the timeout-enforcement discrepancy.
- [Streaming Protocol](https://flueframework.com/docs/reference/streaming-protocol/) — the wire
  format `createAgentRouter()` serves.
- [Errors Reference](https://flueframework.com/docs/reference/errors/) — every error class this
  page's APIs throw.
- [Agent SDK](https://flueframework.com/docs/sdk/overview/) — the browser/server client built
  over `dispatch()`/`init()`'s wire contract.
- [`flue run`](https://flueframework.com/docs/cli/run/) — the CLI surface over the same
  submission path.
