---
title: Events Reference
source: https://flueframework.com/docs/reference/events/
bundled_docs: bunx flue docs read reference/events
version: 2.0.8
reviewed: 2026-09-17
---

# Events Reference

## What and when

Runtime events describe live agent execution for telemetry, metering, tracing, and operational alerts. Subscribe with `observe()` or install an observer/interceptor bundle with `instrument()`. This is not the durable, per-conversation stream used by chat clients.

Events are isolate-global, live-only, and best-effort. Durable submission state and the canonical conversation remain the ledger.

## Contents

- [Public API index](#public-api-index)
- [Observation contract](#observation-contract)
- [Event envelope](#event-envelope)
- [Event vocabulary and contracts](#event-vocabulary-and-contracts)
- [Live-only FlueObservation](#live-only-flueobservation)
- [Instrumentation and interceptors](#instrumentation-and-interceptors)
- [End-to-end patterns](#end-to-end-patterns)
- [Recommended patterns](#recommended-patterns)
- [Avoid](#avoid)
- [Gotchas and errors](#gotchas-and-errors)
- [Related](#related)

## Public API index

All imports are from `@flue/runtime` unless stated otherwise.

| API/type | Contract |
| --- | --- |
| `observe(subscriber)` | Register a process/isolate-wide live subscriber; returns unsubscribe. |
| `FlueEvent`, `FlueObservation` | Versioned event plus live exporter detail. |
| `FlueEventContext`, `FlueLogger` | Emitting interaction context and structured logger. |
| `instrument(bundle)` | Install observer plus execution interceptor; returns async disposer. |
| `FlueInstrumentation` | Keyed observer/interceptor/dispose bundle. |
| `FlueExecutionInterceptor` | Middleware around agent, model, tool, and task execution. |
| `AttachedAgentEvent` | `FlueEvent` with required `instanceId`. |
| Model types | `ModelRequest`, `ModelRequestInput`, `ModelRequestInfo`, `ModelResponse`, `PromptUsage`, `LlmTurnPurpose`, `Llm*`. |
| `IMAGE_DATA_OMITTED` | Exact image-redaction sentinel, also exported by `@flue/sdk`. |

`FlueEventInput`, `AgentMessage`, `FlueObservationDetail`, and standalone `FlueErrorInfo` are internal/not exported. Internal-shaped values can ride stable event fields; prefer typed `turn.response.output` for completed model output.

## Observation contract

```ts
function observe(subscriber: FlueEventSubscriber): () => void;

type FlueObservationSubscriber = (
  observation: FlueObservation,
  ctx: FlueEventContext,
) => void | Promise<void>;

interface FlueEventContext<TEnv = Record<string, any>> {
  readonly id: string;
  readonly agentName: string | undefined;
  readonly env: TEnv;
  readonly req: Request | undefined;
  readonly log: FlueLogger;
}
```

- Subscribers see emissions after registration only; no replay, filtering, backpressure, or veto exists.
- The runtime clones one observation deeply, preserves cycles, freezes it deeply, and gives that same object to every subscriber.
- Invocation is synchronous after internal per-context consumers. A returned promise is not awaited.
- Throws/rejections are logged with `[flue:observe]`; they do not affect work or later subscribers.
- Ordering is by `eventIndex` within one context only. There is no cross-context order.
- Node registration sees its process. A Cloudflare registration sees only its Durable Object isolate. `flue run` loads the agent module, not `app.ts`.
- `ctx.env` is `process.env` on Node and Workers env on Cloudflare. `ctx.req` can be absent or synthetic during recovery.
- `ctx.log` emits another event; guard subscriber logging against recursion.

## Event envelope

```ts
type FlueEvent = FlueEventInput & {
  v: 3;
  eventIndex: number;
  timestamp: string;
};

// Optional correlation fields, present when applicable:
interface Correlation {
  instanceId?: string;
  submissionId?: string;
  agentName?: string;
  conversationId?: string;
  session?: string;
  parentSession?: string;
  taskId?: string;
  harness?: string;
  operationId?: string;
  turnId?: string;
}
```

`v` is literal `3`; breaking stable-format changes bump it. `eventIndex` orders one emitting context and is not durable identity. All IDs are opaque and compared only for equality. A root harness is named `default`; hook harnesses use the hook name.

No recognized image block contains raw base64. Its data is replaced with the exact string `[image data omitted from event]`; canonical/session storage retains the bytes. Durable-shaped error fields omit stacks.

## Event vocabulary and contracts

The v3 vocabulary contains 27 event types.

| Family | Types | Core contract |
| --- | --- | --- |
| Agent | `agent_start`, `agent_end`, `idle` | Loop bounds; `agent_end.messages` is run output in internal `AgentMessage` shape. |
| Submission | `submission_queued`, `submission_running`, `submission_settled` | Admission, each attempt, and terminal durable outcome. |
| Recovery | `submission_recovery` | Contained coordinator/reconciliation failure that may not terminalize. |
| Operation | `operation_start`, `operation` | `prompt`, `skill`, `task`, `shell`, `compact` operation bounds. |
| Turn | `turn_start`, `turn_request`, `turn`, `turn_messages` | One model call and its materialized message/tool boundary. |
| Message | `message_start`, `message_end`, `text_delta`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_delta` | Live generation details. |
| Tool | `tool_start`, `tool` | Execution bounds by `toolCallId`. |
| Task | `task_start`, `task` | Delegated session bounds by `taskId`. |
| Compaction | `compaction_start`, `compaction` | Context summarization bounds and roll-up. |
| Logging | `log` | Structured in-context diagnostics. |

Nested `isError` does not imply submission failure; agents can recover. `submission_settled` is the terminal signal.

### Submission lifecycle

```ts
type SubmissionEvent =
  | { type: 'submission_queued'; submissionId: string; kind: 'dispatch' | 'direct' }
  | {
      type: 'submission_running';
      submissionId: string;
      kind: 'dispatch' | 'direct';
      attemptCount: number;
      maxAttempts: number;
    }
  | {
      type: 'submission_settled';
      submissionId: string;
      outcome: 'completed' | 'failed' | 'aborted';
      error?: SerializedError;
    };
```

- `submission_queued` follows durable admission and is at-least-once: idempotent admission replays can re-emit it.
- `submission_running` fires for every claimed/recovery attempt and lets a new isolate rebuild busy state.
- A dispatch absorbed into a busy host emits queued and settled but no running event.
- `submission_settled` covers every terminal path, including recovery-finalized settlement. It is emitted outside session scope and also has a durable canonical settlement record.
- Non-`FlueError` terminal failures are replaced with generic `internal_error`; internal messages do not leak.

`submission_recovery` identifies an `operation` of `materialize_submission`, `finalize_settlement`, `reconcile_submission`, `start_submission`, `process_submission`, `reconcile_pass`, or `enforce_deadline`. Outcomes are `deferred`, `agent_unavailable`, retained-but-not-currently-emitted `attempt_cap_deferred`, or `terminated`. Persistent failures re-emit on each failed wake, roughly every 30 seconds at backstop cadence. `reconcile_pass` can omit `submissionId`.

### Operations and usage

```ts
interface OperationTerminal {
  type: 'operation';
  operationId: string;
  operationKind: 'prompt' | 'skill' | 'task' | 'shell' | 'compact';
  durationMs: number;
  isError: boolean;
  error?: unknown;
  result?: unknown;
  usage?: PromptUsage;
}
```

Every `operation_start` has one terminal `operation`, then `idle`. `operation.usage` is already rolled up from turns; sum one telemetry level only. Errors are stackless: categorized Flue errors retain safe fields, ordinary `Error` retains name/message, and non-Error throws pass through.

### Model turns

```ts
type LlmTurnPurpose = 'agent' | 'compaction' | 'compaction_prefix';

interface ModelRequestInfo {
  providerId: string;
  providerName: string;
  requestedModel: string;
  api: string;
  serverAddress?: string;
  serverPort?: number;
  reasoningLevel?: string;
  maxTokens?: number;
  temperature?: number;
  contextCompacted?: true;
}

interface ModelRequest extends ModelRequestInfo {
  input: { systemPrompt?: string; messages: LlmMessage[]; tools?: LlmTool[] };
}

interface ModelResponse {
  responseId?: string;
  responseModel?: string;
  output?: LlmAssistantMessage;
  usage?: PromptUsage;
  finishReason?: string;
  providerFinishReason?: string;
  gatewayLogId?: string;
  error?: FlueErrorInfo;
}
```

- `turn_start` exists only for agent-purpose turns.
- `turn_request` precedes the provider and contains full model-visible prompt/messages/tools. It is in-process only and never persisted or transported.
- `turn` is normalized completion and is error when thrown, provider-error-finished, or aborted.
- `turn_messages` follows durable tool-batch commit and exists only for agent turns.
- `contextCompacted` is present only as `true` while the effective agent context includes canonical compaction; it is absent on compaction turns themselves.
- `providerFinishReason` and `gatewayLogId` are telemetry, not replay identity.

`PromptUsage` contains input, output, cache read/write, total tokens, and corresponding costs plus total cost. Turn usage is leaf-level; operation and compaction usages are roll-ups.

### Messages, tools, tasks, compaction, logs

- `message_start`/`message_end` wrap user, assistant, and tool-result messages. Completed `message_end` is authoritative; deltas are best-effort.
- `thinking_*` correlate blocks with optional `contentIndex`; delta events use envelope `turnId` rather than a payload field.
- `toolcall_delta` is preview-only; canonical complete args appear later.
- `tool_start.args` is declared but currently not populated. Use live observation `args`; canonical records hold durable args.
- Model tools publish terminal `tool` only when their batch commits. `shell()` publishes immediately and appears as tool `bash`, observation origin `caller`.
- Tool failure means throw. `tool.result` is internal/tool-specific; `durationMs` matches the durable record.
- Task events include child session correlations plus `parentSession`; task result is assistant text or error message.
- Every non-empty compaction start gets one terminal event. Reasons are `threshold`, `overflow`, or `manual`. Failed automatic compaction is observable but best-effort; failed manual compaction also rejects.
- `log` never enters model context or client conversation. `attributes.error` becomes a safe stackless shape; runtime adds tool/hook provenance.

## Live-only `FlueObservation`

```ts
type FlueObservation = FlueEvent & {
  agentInput?: { text: string; images?: Array<{ mimeType: string }> };
  agentOutput?:
    | { type: 'text'; text: string; finishReason: string }
    | { type: 'data'; data: unknown };
  origin?: 'model' | 'caller' | 'framework' | 'adapter';
  description?: string;
  args?: unknown;
  effectiveResult?: unknown;
  toolCallId?: string;
  errorInfo?: {
    type: string;
    name?: string;
    code?: string;
    message?: string;
    meta?: Record<string, unknown>;
    stack?: string;
  };
};
```

These added fields are never persisted, replayed, or transported. `errorInfo.stack` can expose filesystem/deployment details and exists only when a live thrown `Error` supplied it. Observations are read-only.

## Instrumentation and interceptors

```ts
interface FlueInstrumentation {
  key?: symbol;
  observe: FlueObservationSubscriber;
  interceptor: FlueExecutionInterceptor;
  dispose(): void | Promise<void>;
}

function instrument(value: FlueInstrumentation): () => Promise<void>;
```

A duplicate key throws `InstrumentationAlreadyInstalledError` (`instrumentation_already_installed`) in production. In development, the newest keyed install replaces and disposes the previous one for reload safety. Reinstalling the same object returns the same memoized disposer; disposal is idempotent and unregisters before invoking bundle cleanup.

Node server shutdown does not automatically dispose module-scope instrumentation; exporters needing flush-on-exit own signal handling. Cloudflare installations live with the isolate.

```ts
type FlueExecutionOperation =
  | { type: 'agent'; operationId: string; operationKind: 'prompt' | 'skill' | 'task' }
  | { type: 'model'; turnId: string }
  | { type: 'tool'; toolCallId: string; toolName: string }
  | { type: 'task'; taskId: string };
```

Interceptors compose in registration order and execute on the work path. `next()` is exactly-once; a second call rejects with `Flue execution next() called more than once.` Omitting it skips the remaining chain/work and uses the interceptor return value. Throwing fails work; slowness delays work. `ctx.eventContext` is declared but currently unpopulated. Valid incoming W3C trace context appears as `traceCarrier`.

The `agent` operation's declared `operationKind: 'task'` variant is not currently raised; delegation uses the separate `task` interception type.

## End-to-end patterns

### Derive busy instances

Use a `Set` per instance, adding on queued/running and deleting on settled. Set semantics absorb duplicate queued/running emissions, and recovery re-emission reconstructs state in a fresh isolate.

### Meter model use

Subscribe to successful/failed `turn` events and record `response.usage` by provider/model, or consume operation roll-ups. Never add both levels. Correlate with `submissionId`, `operationId`, and `turnId` from the envelope.

### Export traces

Use keyed `instrument()`: create spans in the interceptor, project frozen events in `observe`, and flush in `dispose`. Keep observer work non-blocking; interceptor work intentionally participates in latency/failure.

## Recommended patterns

- Register at module scope in every execution path that needs telemetry.
- Alert on terminal failures from `submission_settled` and stuck/retrying work from recurring `submission_recovery`.
- Use sets and idempotent exporter keys because some lifecycle signals repeat.
- Project large `operation.result` and internal-shaped fields instead of exporting blindly.
- Version-check `v` and tolerate additive optional fields.

## Avoid

- Do not use events as guaranteed processing, history, or a cross-isolate stream.
- Do not mutate observations, await expensive work inline, or throw intentionally from subscribers.
- Do not count both turn usage and operation/compaction roll-ups.
- Do not rely on `AgentMessage`, tool details, effective result, or operation result as stable schemas.
- Do not log `ctx.log` recursively from an unguarded `log` event handler.

## Gotchas and errors

- `submission_queued` can repeat even for an idempotency-key replay.
- Joined work has no `submission_running` event.
- A subscriber attached mid-generation misses earlier deltas; completed messages remain authoritative live events but are not replayable.
- `turn.response.error` and observation `errorInfo` may have live stacks; durable-shaped event errors do not.
- `instrument()` production duplicate-key behavior differs from development replacement.

## Related

- [Observability guide](https://flueframework.com/docs/guide/observability/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
- [SDK events](https://flueframework.com/docs/sdk/events/)
- [Errors reference](https://flueframework.com/docs/reference/errors/)
- [OpenTelemetry adapter](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
