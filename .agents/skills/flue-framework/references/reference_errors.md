---
title: Errors Reference
source: https://flueframework.com/docs/reference/errors/
bundled_docs: bunx flue docs read reference/errors
version: 2.0.8
reviewed: 2026-09-17
---

# Errors Reference

## What and when

The `FlueError` hierarchy, stable error `type` codes, the HTTP error envelope, settlement errors,
and error classification on live observations. Read this when catching or matching a Flue-thrown
error, designing telemetry that branches on failure category, or tracing a production `500` back
to its server-side log line.

Typed framework failures are `FlueError` subclasses with a stable machine-readable `type` code,
plus two plain-`Error` classes (`AgentRunError`, `ResultUnavailableError`). Cancellation rejects
with a `DOMException` named `AbortError`. Misuse of programmatic entry points (calling
`dispatch()`/`init()` before the runtime is configured, an empty instance id) throws plain
`Error`s whose `[flue]`-prefixed messages are prose, not API. Error classes are exported from
`@flue/runtime`, with two exceptions: the Cloudflare binding surface is
`@flue/runtime/cloudflare`, and the persistence store classes are `@flue/runtime/adapter`.

The Flue Agent SDK's own error classes (`FlueApiError`, `FlueExecutionError`, stream errors) are in
`sdk_errors.md` — they wrap the same wire envelope and settlement shapes documented here.

## Public API index

| Class | `type` | Status | Import |
| --- | --- | --- | --- |
| `FlueError` | (base) | — | `@flue/runtime` |
| `AgentInstanceExistsError` | `agent_instance_exists` | 409 | `@flue/runtime` |
| `AgentInstanceNotFoundError` | `agent_instance_not_found` | 404 | `@flue/runtime` |
| `AgentRunError` | — (not `FlueError`) | — | `@flue/runtime` |
| `AttachmentConflictError` | `attachment_conflict` | — | `@flue/runtime/adapter` |
| `AttachmentIntegrityError` | `attachment_integrity` | — | `@flue/runtime/adapter` |
| `AttachmentNotAvailableError` | `attachment_not_available` | — | `@flue/runtime` |
| `CloudflareAIBindingError` | `cloudflare_ai_binding_error` | — | `@flue/runtime/cloudflare` |
| `ConversationStreamStoreError` | `conversation_stream_store_failure` | — | `@flue/runtime/adapter` |
| `DelegationDepthExceededError` | `delegation_depth_exceeded` | — | `@flue/runtime` |
| `InstrumentationAlreadyInstalledError` | `instrumentation_already_installed` | — | `@flue/runtime` |
| `OperationFailedError` | `operation_failed` | — | `@flue/runtime` |
| `PersistedFormatVersionError` | `persisted_format_version_unsupported` | — | `@flue/runtime/adapter` |
| `ResultUnavailableError` | — (not `FlueError`) | — | `@flue/runtime` |
| `SandboxDiedError` | `sandbox_died` | — | `@flue/runtime` |
| `SandboxOperationUnsupportedError` | `sandbox_operation_unsupported` | — | `@flue/runtime` |
| `SessionBusyError` | `session_busy` | — | `@flue/runtime` |
| `SessionNotFoundError` | `session_not_found` | — | `@flue/runtime` |
| `SkillDefinitionValidationError` | `skill_definition_validation` | — | `@flue/runtime` |
| `SkillNotRegisteredError` | `skill_not_registered` | — | `@flue/runtime` |
| `SubagentNotDeclaredError` | `subagent_not_declared` | — | `@flue/runtime` |
| `SubmissionAbortedError` | `submission_aborted` | — | `@flue/runtime` |
| `SubmissionInterruptedError` | `submission_interrupted` | — | `@flue/runtime` |
| `SubmissionRetryExhaustedError` | `submission_retry_exhausted` | — | `@flue/runtime` |
| `SubmissionTimeoutError` | `submission_timeout` | — | `@flue/runtime` |
| `ToolInputValidationError` | `tool_input_validation` | — | `@flue/runtime` |
| `ToolNameConflictError` | `tool_name_conflict` | — | `@flue/runtime` |
| `ToolOutputSerializationError` | `tool_output_serialization` | — | `@flue/runtime` |
| `ToolOutputValidationError` | `tool_output_validation` | — | `@flue/runtime` |
| `ValidationIssue` (type) | — | — | `@flue/runtime` |

`InvalidRequestError` (`invalid_request`) exists and is thrown widely (malformed `DeliveredMessage`,
bad send conditions) but is **not exported** — match it with `instanceof FlueError` and
`type === 'invalid_request'`.

## `FlueError`

```ts
class FlueError extends Error {
  readonly type: string;
  readonly details: string;
  readonly dev: string;
  readonly meta: Record<string, unknown> | undefined;
  readonly cause: unknown;
}
```

The base class for framework-typed errors. Distinguish Flue failures with `err instanceof
FlueError`, then narrow with a concrete subclass or the `type` field.

- `type` — stable snake_case identifier, one constant per subclass. **This is the machine-readable
  contract** — match on it in code and telemetry.
- `message` — one caller-safe sentence. Prose, not API — may change between versions.
- `details` — longer caller-safe prose; always rendered on the wire. `''` when the class has
  nothing further to say.
- `dev` — developer-audience prose (alternatives, filesystem layout, fix instructions); rendered
  on the wire only in local development. `''` when the class has nothing dev-specific.
- `meta` — optional structured data, set only by the subclasses documented as carrying it;
  included on the wire in every mode when set.
- `cause` — the underlying wrapped error. Logged server-side; **never sent over the wire**.
- `name` — not a discriminator (most subclasses report `'FlueError'`/`'FlueHttpError'`). Use
  `instanceof` or `type`.

The HTTP base class (`FlueHttpError`, adding `readonly status: number` and `readonly headers:
Record<string, string> | undefined`) is **not exported**. Its two exported subclasses,
`AgentInstanceNotFoundError` and `AgentInstanceExistsError`, expose `status`/`headers` through it.

## HTTP error envelope

Every error response from an agent route, a mounted `createAgentRouter()` app, or a channel
router carries one JSON body shape:

```json
{
  "error": {
    "type": "stream_not_found",
    "message": "Event stream \"...\" was not found.",
    "details": "Streams are created when their agent instance receives its first prompt.",
    "dev": "...",
    "meta": {}
  }
}
```

- `type`, `message`, `details` — always present.
- `dev` — present only in local development (`flue dev`, `flue run`) **and** when the error class
  populated it. Not a reliable mode signal — a class that set `dev: ''` omits the field in every
  mode.
- `meta` — present whenever the error class set it, in development and production alike.
- `ref` — a server-minted correlation ref (`err_` + ULID), present exactly when the server logged
  the error (the two 500-class renders below). Mirrored on a `flue-error-ref` response header and
  prefixing the matching server-side log line. Never present on unlogged caller-mistake (4xx)
  responses.
- `cause` and stack traces — **never present**.

Status resolution:

- An HTTP-typed `FlueError` renders with its class-owned status plus any class-owned headers
  (`Allow` on 405, `Retry-After: 1` on 503).
- A non-HTTP `FlueError` that escapes to a route renders its typed envelope with status **500** and
  is logged server-side, with a fresh `ref`.
- Any non-`FlueError` thrown value renders as a generic 500 `internal_error` envelope; the original
  error is logged server-side in full, nothing about it reaches the wire beyond the `ref`.

Every error response also carries `content-type: application/json`, `x-content-type-options:
nosniff`, `cross-origin-resource-policy: cross-origin`.

Two responses deliberately omit the envelope: `HEAD` reads answer errors with status/headers only
(no body — `flue-error-ref` still present on a logged render), and a long-poll read aborted by the
client returns `499` with no body. Mid-stream failures after SSE/long-poll headers are sent
terminate the stream without an envelope. Full wire shapes: `reference_streaming-protocol.md`.

### Correlating a production 500

Quote the `ref` (from `error.ref` or the `flue-error-ref` header — the header survives body-less
responses and intermediaries that swallow bodies). The matching server-side log line begins
`[flue] [err_…]` and carries the full error with cause chain and stacks; ULIDs also bracket the
time window to search. A request carrying a W3C `traceparent` has it recorded beside the ref. The
ref exists only for the synchronous render — a submission failing *after* its `202` admission has
no ref; its handle is the `submissionId`, shared by the `submission_settled` record, the SDK's
`FlueExecutionError.targetId`, and the `[flue:submission-…]` log lines.

## Route error types

Wire `type` codes agent routes produce (full route shapes: `reference_streaming-protocol.md`):

| `type` | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Malformed request: bad URL/parameter shapes, empty instance-id segment, invalid dispatch payload, a `uid` condition combined with `initialData`, creation data failing `initialDataSchema`. |
| `invalid_json` | 400 | Body present but not parseable as JSON. |
| `unsupported_media_type` | 415 | Body present without `Content-Type: application/json`. |
| `method_not_allowed` | 405 | Carries an `Allow` header listing accepted methods. |
| `route_not_found` | 404 | No route matches method + path (routes not enumerated). |
| `stream_not_found` | 404 | Conversation stream read for an instance never prompted. |
| `attachment_not_found` | 404 | Unknown attachment id, or one belonging to another conversation. |
| `agent_instance_not_found` | 404 | See `AgentInstanceNotFoundError` below. |
| `agent_instance_exists` | 409 | See `AgentInstanceExistsError` below. |
| `runtime_unavailable` | 503 | Local dev runtime reloading/draining/failed. `Retry-After: 1`, `meta.state` (`'loading' \| 'draining' \| 'failed'`). |
| `internal_error` | 500 | Generic redaction for unexpected server errors. |

Send admission — over HTTP or through `dispatch()`/`init().dispatch()` — also rejects with
`type: 'invalid_request'` for payload misuse (`InvalidRequestError`, not exported — match with
`instanceof FlueError` + `type`).

Internal invariant/persistence failures with their own codes: `conversation_record_invariant` (no
class), the store codes (`AttachmentConflictError`, `AttachmentIntegrityError`,
`ConversationStreamStoreError`, `PersistedFormatVersionError`), and `cloudflare_ai_binding_error`
(`CloudflareAIBindingError`).

Authored routes/middleware in `app.ts` own their own responses — this envelope/status vocabulary
applies only to framework-owned routes.

## `AgentInstanceExistsError`

```ts
class AgentInstanceExistsError extends FlueError {
  // type: 'agent_instance_exists', status: 409
  readonly uid: string | undefined;
}
```

A create-only send (`uid: null`) named an instance that already exists. Raised synchronously at
admission — nothing durable is created. `uid` is the existing incarnation's uid, usable directly
as a continue condition; also rides `meta.uid` and `details`. Thrown by `dispatch()`,
`init().dispatch()`, and equivalent HTTP sends — see `reference_agent-api.md#conditional-sends`.

## `AgentInstanceNotFoundError`

```ts
class AgentInstanceNotFoundError extends FlueError; // type: 'agent_instance_not_found', status: 404
```

A continue-only send (`uid: '<string>'`) named an instance that does not exist, or whose uid
doesn't match — both produce this same error. Also the rejection of `init().read()` addressed to
an instance never contacted. Raised synchronously at admission. See
`reference_agent-api.md#conditional-sends` and `#init`.

## `AgentRunError`

```ts
class AgentRunError extends Error {
  readonly outcome: 'failed' | 'aborted';
  readonly submissionId: string;
}
```

**Not a `FlueError`.** The rejection of an awaited `init().read()` whose submission settled
`failed` or `aborted`. `cause` carries the settlement's serialized error (the shape under
"Settlement error shape" below) when one was recorded. A `read()` with an already-fired `signal`
rejects with the signal's reason instead — a local read cancellation, not this class; the
submission itself keeps running. Thrown/consumed by `reference_agent-api.md#init`,
`advanced_evals.md`, `advanced_workflows.md`.

## `AttachmentConflictError`

```ts
// from '@flue/runtime/adapter'
class AttachmentConflictError extends FlueError; // type: 'attachment_conflict'
```

An attachment id was reused with different content, metadata, or ownership. Fires inside store
operations, not as an HTTP category; one escaping to a route renders 500. `meta` carries `path`,
`attachmentId`. See `reference_data-persistence-api.md`.

## `AttachmentIntegrityError`

```ts
// from '@flue/runtime/adapter'
class AttachmentIntegrityError extends FlueError; // type: 'attachment_integrity'
```

Attachment bytes failed integrity verification. `meta` carries `attachmentId`, `reason` (`'size' |
'digest' | 'chunks'`). See `reference_data-persistence-api.md`.

## `AttachmentNotAvailableError`

```ts
class AttachmentNotAvailableError extends FlueError; // type: 'attachment_not_available'
```

Thrown by harness operations when a delegated task referenced an attachment id not visible in the
calling session's conversation. `meta` carries `attachmentId`. Relevant to `guides_subagents.md`
and `reference_agent-api.md#harness`.

## `CloudflareAIBindingError`

```ts
// from '@flue/runtime/cloudflare'
class CloudflareAIBindingError extends FlueError {
  // type: 'cloudflare_ai_binding_error'
  constructor(options: { message?: string; status?: number; statusText?: string; body?: string });
}
```

A Workers AI binding request failed. Specific to the Workers AI binding path, absent from the root
barrel. Provider response body rides in `message` (bounded 2000 chars) as well as `details` — retry
and overflow classification read the persisted assistant error message. `meta` carries `status`,
`statusText` when known, plus `reason: 'request_too_large'` on 413 (separating self-healing context
overflow from an outage). Public constructor, for regression tests. See
`reference_provider-api.md#cloudflarebindingprovider`.

## `ConversationStreamStoreError`

```ts
// from '@flue/runtime/adapter'
class ConversationStreamStoreError extends FlueError; // type: 'conversation_stream_store_failure'
```

A canonical conversation stream operation was rejected; the stream remains unchanged. Fires inside
store operations; one escaping to a route renders 500. `meta` carries `operation`, `path`,
`reason`. The related `conversation_record_invariant` code has no exported class. See
`reference_data-persistence-api.md`.

## `DelegationDepthExceededError`

```ts
class DelegationDepthExceededError extends FlueError; // type: 'delegation_depth_exceeded'
```

Thrown by harness operations when a chain of nested `task()`/harness-tool delegations exceeded the
maximum depth (**4** — see `reference_agent-behavior.md#limits`). `message` includes the limit.

## `InstrumentationAlreadyInstalledError`

```ts
class InstrumentationAlreadyInstalledError extends FlueError; // type: 'instrumentation_already_installed'
```

`instrument()` was called while an instrumentation owner of the same `key` was already active in
production. Dispose the active one first. See `reference_events.md#instrument`,
`advanced_observability.md`.

## `OperationFailedError`

```ts
class OperationFailedError extends FlueError; // type: 'operation_failed'
```

A harness operation — `prompt()`, `skill()`, `task()`, `shell()`, `compact()` — ran but did not
complete: the underlying model call errored, or a durable input couldn't be persisted/recovered.
`meta` carries `operation`, `reason` (also embedded in `message`; both prose, not API). This is
what an unrecovered model-call failure ultimately settles a submission as — see "Turn error
normalization" below.

## `PersistedFormatVersionError`

```ts
// from '@flue/runtime/adapter'
class PersistedFormatVersionError extends FlueError; // type: 'persisted_format_version_unsupported'
```

The database records a format version this runtime doesn't support (stamped by a newer Flue
version after a rollback, or an unrecognized marker). Thrown at store open, at startup. `meta`
carries `storedVersion`, `supportedVersion`. See
`reference_data-persistence-api.md#cross-store-storage-rules`.

## `ResultUnavailableError`

```ts
class ResultUnavailableError extends Error {
  readonly reason: string;
  readonly assistantText: string;
}
```

**Not a `FlueError`.** Thrown by `prompt()`, `skill()`, `task()` when the call set `options.result`
and the model invoked the framework's give-up tool instead of producing schema-conforming data.
`reason` is the model's explanation; `assistantText` is the transcript accumulated before the
give-up. See `reference_agent-api.md#harnessprompt` and `guides_tools.md` (harness tools).

## `SandboxDiedError`

```ts
class SandboxDiedError extends FlueError; // type: 'sandbox_died'
```

An adapter's own infrastructure-liveness detection rejects with this when the sandbox died
independently of caller cancellation — distinct from an `AbortError`, which represents caller
intent. See `reference_sandbox-api.md#sandboxdriver`, `guides_sandboxes.md`.

## `SandboxOperationUnsupportedError`

```ts
class SandboxOperationUnsupportedError extends FlueError; // type: 'sandbox_operation_unsupported'
```

A sandbox adapter rejected an operation or option set it doesn't implement, **before** modifying
the filesystem. `meta` carries `operation`, `provider`, `options`. See
`reference_sandbox-api.md#sandbox`.

## `SessionBusyError`

```ts
class SessionBusyError extends FlueError; // type: 'session_busy'
```

A harness operation (`prompt()`, `skill()`, `task()`, `shell()`, `compact()`) was invoked while the
session was already running one — sessions run one operation at a time; open another session for
parallel branches. See `reference_agent-api.md#harness`, `reference_agent-hooks-api.md`.

## `SessionNotFoundError`

```ts
class SessionNotFoundError extends FlueError; // type: 'session_not_found'
```

An internal session-lookup failure inside the harness. The public harness operations get-or-create
the default session and cannot hit this in ordinary use.

## `SkillDefinitionValidationError`

```ts
class SkillDefinitionValidationError extends FlueError; // type: 'skill_definition_validation'
```

`defineSkill()` received an invalid definition. `meta.issues` carries `ValidationIssue[]`. See
`reference_agent-api.md#defineskill`, `guides_skills.md`.

## `SkillNotRegisteredError`

```ts
class SkillNotRegisteredError extends FlueError; // type: 'skill_not_registered'
```

`skill(name)` named a skill not discovered in the session's sandbox at init time. Packaged skill
references imported from `SKILL.md` bypass discovery. See `guides_skills.md`.

## `SubagentNotDeclaredError`

```ts
class SubagentNotDeclaredError extends FlueError; // type: 'subagent_not_declared'
```

`task({ agent })` named a subagent absent from the agent's declarations. See
`guides_subagents.md`, `reference_agent-hooks-api.md#usesubagent`.

## `SubmissionAbortedError`

```ts
class SubmissionAbortedError extends FlueError; // type: 'submission_aborted'
```

A terminal error a durable submission settles with — becomes the `error` of the
`submission_settled` record/event and rejects a waiting settlement observer (`init().read()`, the
SDK's `wait()`). The instance's work was aborted (the route's `POST .../abort`, or `init()`'s
`abort()`). Abort is a distinct terminal outcome, not a failure — a submission that already
committed its terminal record is never aborted, and an abort losing the race to a completed
response settles as completed. See `reference_agent-api.md#handleabort`,
`reference_streaming-protocol.md#postidabort`.

## `SubmissionInterruptedError`

```ts
class SubmissionInterruptedError extends FlueError; // type: 'submission_interrupted'
```

Every processing attempt was interrupted (crash, restart, shutdown) before the submission's input
was applied; the shared attempt budget ran out with no model call ever started. `meta` carries
`phase: 'retry_exhausted_before_input'`, `attemptCount`, `maxAttempts`. Reflects
`DurabilityConfig`; see `advanced_durability.md`.

## `SubmissionRetryExhaustedError`

```ts
class SubmissionRetryExhaustedError extends FlueError; // type: 'submission_retry_exhausted'
```

Recovery re-attempted an interrupted submission after input application until
`durability.maxAttempts` ran out without a completed response. When terminalization settled tool
calls whose outcomes couldn't be confirmed, `meta.interruptedTools` lists them as `{ name, id }`
pairs — each has an explicit interrupted-error outcome in the conversation and was never assumed
complete or retried. `meta` also carries `attemptCount`, `maxAttempts`. See
`reference_agent-api.md#durabilityconfig`, `advanced_durability.md`.

## `SubmissionTimeoutError`

```ts
class SubmissionTimeoutError extends FlueError; // type: 'submission_timeout'
```

The submission exceeded `durability.timeoutMs`. See `reference_agent-api.md#durabilityconfig` and
the enforcement-timing discrepancy noted there (`advanced_durability.md`).

## `ToolInputValidationError`

```ts
class ToolInputValidationError extends FlueError; // type: 'tool_input_validation'
```

Model-supplied arguments failed a tool's `input` schema. **During a model turn** it becomes an
error tool result delivered back to the model — the submission continues, and the model may
correct its arguments and retry; outside a model turn it propagates to the caller. `meta` carries
`tool`, `issues`. See `guides_tools.md`, `reference_agent-api.md#definetool`.

## `ToolNameConflictError`

```ts
class ToolNameConflictError extends FlueError; // type: 'tool_name_conflict'
```

A tool list contained a duplicate name, or a custom/adapter tool used a framework-reserved name
(`task`, `activate_skill`, `read_skill_resource`, `finish`, `give_up`). Raised when the session
assembles its tools, before any model call. See `guides_tools.md`,
`reference_agent-hooks-api.md#usetool`, `reference_sandbox-api.md#sandboxtoolfactory`.

## `ToolOutputSerializationError`

```ts
class ToolOutputSerializationError extends FlueError; // type: 'tool_output_serialization'
```

The tool's return value isn't JSON-serializable, or the tool returned `undefined` while declaring
an `output` schema. Same model-turn-vs-caller propagation as `ToolInputValidationError`. `meta`
carries `tool`; `cause` carries the serialization failure when one exists. See `guides_tools.md`.

## `ToolOutputValidationError`

```ts
class ToolOutputValidationError extends FlueError; // type: 'tool_output_validation'
```

The tool's return value failed its `output` schema. Same propagation as above. `meta` carries
`tool`, `issues`. See `guides_tools.md`.

## `ValidationIssue`

```ts
interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}
type ToolValidationIssue = ValidationIssue;
```

One validation failure in Standard Schema's issues shape; `path` segments lead to the failing
value. Carried in `meta.issues` by the validation errors above.

## Settlement error shape

The `submission_settled` event, the durable settlement record, and the `submission-settled`
conversation stream chunk carry the outcome and, for `failed`/`aborted`, a serialized error:

```ts
{
  type: 'submission_settled';
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: {
    name?: string;
    message: string;
    type?: string;
    details?: string;
    dev?: string;
    meta?: Record<string, unknown>;
  };
}
```

A `FlueError` serializes with its `name`, `message`, `type`, `details`, `meta`. Any other failure
cause is redacted wholesale to a generic `internal_error` entry — non-Flue error messages never
ride this field. Settlement errors never carry a stack. See `reference_events.md#submission_settled`
and `reference_streaming-protocol.md#update-chunk-contract`.

## `WORKERS_AI_OVERFLOW_MARKER` and `RETRYABLE_INTERRUPTION_MARKER`

```ts
const WORKERS_AI_OVERFLOW_MARKER = '(request_too_large)';
const RETRYABLE_INTERRUPTION_MARKER = '(retryable_interruption)';
```

Message-string markers used where no typed error object survives — classification reads the
persisted assistant error message.

- `WORKERS_AI_OVERFLOW_MARKER` — appended to a binding 413 error message; the compaction layer
  matches it to trigger context-overflow recovery (compact and retry).
- `RETRYABLE_INTERRUPTION_MARKER` — stamped only by throw sites that can prove the failure was a
  transient interruption (e.g. a Workers AI stream ending without an error frame or finish
  reason); retry classification matches it before falling back to message-pattern heuristics.

Applications surfacing provider errors can match or strip these markers; their string values are
the contract.

## `errorInfo` on live observations

`FlueObservation` values delivered to in-process `observe()` subscribers carry classified error
detail on failed activity:

```ts
// FlueObservation (interface itself not exported)
errorInfo?: {
  type: string;
  name?: string;
  code?: string;
  message?: string;
  meta?: Record<string, unknown>;
  stack?: string;
};
```

Classification rules, applied to the thrown value:

- A `DOMException` named `AbortError` → `type: 'AbortError'`.
- A `FlueError` → `type` is the stable code; `meta` is the error's framework-owned metadata.
- Any other object → `type` is its string `type`, else `code`, else `name`, else `'_OTHER'`;
  `name`/`code`/`message` carried when they're strings.
- A string → `{ type: '_OTHER', message }`; anything else → `{ type: '_OTHER' }`.
- `stack` — the throw-site stack, present only when observed live from a real `Error` instance,
  never from arbitrary thrown objects.

`errorInfo` appears on failed `tool`, failed `operation`, and non-completed `submission_settled`
observations. `shell()` bash-tool failures classify to the `type`/`name`/`message` subset only
(no `meta`/`stack`). **In-process only** — the durable-shaped `error` fields on `operation` and
`compaction` events serialize to `{ name, message }` (plus `type`/`details`/`meta` for
`FlueError`s), and durable records never carry `stack` (stacks expose filesystem paths and
deployment layout). Full observation contract: `reference_events.md#flueobservation`.

## Turn error normalization

Model-call failures do not throw through the agent render. They normalize into the `turn` event's
`response` and, when the submission cannot recover, settle the submission with
`OperationFailedError` or a durable submission error.

```ts
// turn event
{
  type: 'turn';
  turnId: string;
  purpose: 'agent' | 'compaction' | 'compaction_prefix';
  durationMs: number;
  request: ModelRequestInfo;
  response: ModelResponse;
  isError: boolean;
}

interface ModelResponse {
  responseId?: string;
  responseModel?: string;
  output?: LlmAssistantMessage;
  usage?: PromptUsage;
  finishReason?: string;
  providerFinishReason?: string;
  gatewayLogId?: string;
  error?: /* errorInfo shape above */;
}
```

- `finishReason` — normalized vocabulary: `'stop'`, `'length'`, `'toolUse'`, `'error'`,
  `'aborted'`. Every provider's native finish value maps into this set.
- `providerFinishReason` — the provider's exact pre-normalization finish value. Telemetry only.
- `gatewayLogId` — Cloudflare AI Gateway log correlation. Telemetry only.
- `error` — classified error, present when the request threw or the assistant message carries a
  provider error message. A bare provider error string classifies as `type: '_OTHER'`.
- `isError` — true when the request threw, or `finishReason` is `'error'`/`'aborted'`.

Full turn-event contract: `reference_events.md#turn_start-turn_request-turn-turn_messages`.

## Boundaries

- `type` strings are the stable machine contract; `message`/`details`/`dev` prose may change
  between versions — do not parse them.
- There is no exported enum or list of error codes; the codes live on the classes and this page.
- No per-provider error hierarchy. Provider failures normalize into turn results and, terminally,
  `operation_failed` or the durable submission errors. `CloudflareAIBindingError` is the one
  provider-specific class.
- Cancellation is never a `FlueError` — aborted operations/dispatches reject with a `DOMException`
  named `AbortError`.
- The wire never carries `cause`, stacks, or non-Flue error messages — all three stay in
  server-side logs.
- CLI, configuration, and build diagnostics (`flue` commands, `flue.config.*` validation, the Vite
  plugin — see `reference_configuration.md`) are human-oriented stderr prose without stable
  machine-readable codes.
- Application-owned routes/middleware in an authored `app.ts` return whatever statuses/bodies they
  choose — Flue imposes no envelope or category (e.g. no `unauthorized` type) on them.

## Recommended patterns

- Match on `err.type`, never on `message`/`details`/`dev` prose, in both request handlers and
  telemetry.
- Correlate a `500` response back to its server log with the `flue-error-ref` header/`error.ref`,
  and a failed-after-admission submission with its `submissionId`.
- Treat `submission_settled`'s `error` as the authoritative terminal-failure record; use
  `submission_recovery` (`reference_events.md`) for failures that never terminalize.
- Guard harness/tool code against `SessionBusyError`/`ResultUnavailableError` explicitly when
  driving `harness.prompt()` with a `result` schema — a give-up is a normal outcome, not a bug.
- Wrap a sandbox adapter's unsupported-option paths in `SandboxOperationUnsupportedError` *before*
  mutating anything, matching the contract in `reference_sandbox-api.md`.

## Avoid

- Don't parse or branch on `message`/`details` text — only `type` and `meta` are stable.
- Don't expect `dev` to reliably indicate development mode — a class with `dev: ''` omits it in
  every mode.
- Don't treat `AgentRunError`/`ResultUnavailableError` as `FlueError`s — `instanceof FlueError`
  is false for both; check `outcome`/`reason` directly.
- Don't assume a nested `isError`/failed `tool`/`turn` event means the submission failed — only
  `submission_settled` is the reliable terminal signal.
- Don't rely on `stack` being present on any durable-shaped error field — it only ever appears on
  the live `turn.response.error` and observation `errorInfo`.

## Gotchas and errors

- `InvalidRequestError` is thrown constantly (malformed messages, bad send conditions, tool-set
  reserved-name collisions at the routing layer) but has **no exported class** — match by
  `instanceof FlueError` and `type === 'invalid_request'`.
- Two classes (`AgentInstanceNotFoundError`, `AgentInstanceExistsError`) are the only ones with
  HTTP `status`/`headers` — every other `FlueError` that reaches a route without an HTTP category
  renders as a generic `500`.
- `SubmissionInterruptedError` vs. `SubmissionRetryExhaustedError` vs. `SubmissionTimeoutError` are
  easy to conflate: interrupted-before-input, retries-exhausted-after-input, and
  deadline-exceeded are three distinct terminal causes with distinct `meta` shapes — see
  `advanced_durability.md`.
- `errorInfo.stack` and `turn.response.error.stack` are the *only* two places a throw-site stack
  survives past the throw — every durable/wire-facing shape strips it.

## Related

- [Agent API](https://flueframework.com/docs/reference/agent-api/) — `dispatch()`/`init()`
  conditional-send errors, `AgentRunError`,
  `defineTool`/`defineSkill`/`defineSubagent`/`defineMcpConnection` validation errors, the harness
  operation errors.
- [Agent Hooks API](https://flueframework.com/docs/reference/agent-hooks-api/) — hook-level
  throws (`ToolNameConflictError` at `useTool`, render-rule violations) and the event-hook
  failure-fails-the-submission contract.
- [Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/) —
  `DelegationDepthExceededError` and the built-in-tool limits that produce it.
- [Tools](https://flueframework.com/docs/guide/tools/) — the full tool-authoring error surface
  (`ToolInputValidationError`, `ToolOutputValidationError`, `ToolOutputSerializationError`,
  `ToolNameConflictError`) from the authoring side.
- [Skills](https://flueframework.com/docs/guide/skills/) — `SkillDefinitionValidationError`,
  `SkillNotRegisteredError`.
- [Subagents](https://flueframework.com/docs/guide/subagents/) — `SubagentNotDeclaredError`,
  `DelegationDepthExceededError`.
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) ·
  [Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/) —
  `SandboxOperationUnsupportedError`, `SandboxDiedError`.
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) —
  `AttachmentConflictError`, `AttachmentIntegrityError`, `ConversationStreamStoreError`,
  `PersistedFormatVersionError`.
- [Provider API](https://flueframework.com/docs/reference/provider-api/) —
  `CloudflareAIBindingError` and plain-`Error` model-resolution failures.
- [Durability](https://flueframework.com/docs/guide/durability/) — `SubmissionAbortedError`,
  `SubmissionInterruptedError`, `SubmissionRetryExhaustedError`, `SubmissionTimeoutError`, and the
  durability policy they encode.
- [Events Reference](https://flueframework.com/docs/reference/events/) —
  `InstrumentationAlreadyInstalledError`, `errorInfo`, and how settlement errors ride the event
  stream.
- [Streaming Protocol](https://flueframework.com/docs/reference/streaming-protocol/) — the route
  error-type table and HTTP envelope this page defines, applied on the wire.
- [SDK Errors](https://flueframework.com/docs/sdk/errors/) — the SDK-side error classes that wrap
  these same shapes for client code.
