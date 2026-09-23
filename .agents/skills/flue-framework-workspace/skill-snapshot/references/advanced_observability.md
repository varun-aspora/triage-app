---
title: Observability
source: https://flueframework.com/docs/guide/observability/
section: advanced
---

# Observability

## What it is

Flue emits everything its agents do — model turns, tool calls, structured logs, compactions, subagent tasks, and submission settlements — as typed **runtime events** you subscribe to in process with `observe()` from `@flue/runtime`. This is the operational surface: live activity across every agent in the isolate, used for telemetry, metering, and error reporting. It is separate from the **conversation stream** (one conversation's durable, render-ready messages over HTTP via the Agent SDK's `createFlueClient(...).observe()` / `history()`), which is what a chat UI reads. The two surfaces share correlation ids: a conversation message's `submissionId` matches the runtime events its submission produced.

## API surface

All symbols below are imported from `@flue/runtime` unless noted.

### `observe()`

```ts
function observe(subscriber: FlueEventSubscriber): () => void;

type FlueEventSubscriber = FlueObservationSubscriber;

type FlueObservationSubscriber = (
  observation: FlueObservation,
  ctx: FlueEventContext,
) => void | Promise<void>;
```

Registers a global subscriber for every runtime event emitted in the current process. Returns an unsubscribe function. Register once at startup, at module top level in `app.ts` (or a module `app.ts` imports).

```ts
import { observe } from '@flue/runtime';

observe((event) => {
  if (event.type === 'submission_settled' && event.outcome === 'failed') {
    console.error(
      `[${event.agentName}] submission ${event.submissionId} failed:`,
      event.error?.message,
    );
  }
});
```

Three rules for subscribers:

- **Stay cheap.** Subscribers run synchronously on the event emission path. Branch on `event.type`, return immediately for activity you don't consume, queue substantial async work instead of blocking emission.
- **Treat events as read-only.** Each delivery is a detached, deep-frozen observation.
- **Failures are contained.** A throwing subscriber is caught and logged (`console.error` with the `[flue:observe]` prefix) and skipped; other subscribers and the agent are unaffected. Returned promises are observed for rejection but never awaited.

Ordering: events from one emitting context arrive in `eventIndex` order; no ordering guarantee across contexts. The API deliberately has no type filtering, backpressure, replay, or veto.

### `FlueEventContext` (second subscriber argument)

```ts
interface FlueEventContext<TEnv = Record<string, any>> {
  readonly id: string;
  readonly agentName: string | undefined;
  readonly env: TEnv;
  readonly req: Request | undefined;
  readonly log: FlueLogger;
}

interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}
```

`id` is the agent instance id (equals `instanceId` on the context's events). `env` is `process.env` on Node, the Workers env object on Cloudflare. `req` is the Fetch `Request` or `undefined`. `ctx.log` emits further `log` events — guard against loops if you call it inside a subscriber.

### Event envelope

```ts
type FlueEvent = FlueEventInput & {
  v: 3;
  eventIndex: number;
  timestamp: string;
};

// Correlation fields available on every event type (all optional):
{
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

`v` is the durable event-format version (literal `3`); `eventIndex` is a per-context monotonic counter (ordering, not identity); `timestamp` is ISO 8601. Ids are opaque — correlate by equality only.

### Event families

| Events | Activity |
| --- | --- |
| `agent_start`, `agent_end`, `idle` | Agent loop lifecycle. |
| `submission_settled` | A durable submission reached completed, failed, or aborted — the reliable terminal signal. |
| `operation_start`, `operation` | Prompt, skill, task, shell, and compact operation boundaries, with duration and rolled-up usage. |
| `turn_start`, `turn_request`, `turn`, `turn_messages` | Model turns. |
| `message_*`, `text_delta`, `thinking_*` | Live message and reasoning progress. |
| `tool_start`, `tool` | Tool execution, correlated by `toolCallId`. |
| `task_start`, `task` | Subagent task delegation, with result, error state, duration. |
| `compaction_start`, `compaction` | Context compaction, with message counts and usage. |
| `log` | Structured logs written by your tools and hooks. |

The v3 vocabulary has 27 event types in total; the Events Reference documents each payload.

Key payload shapes:

```ts
{
  type: 'submission_settled';
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: { name?: string; message: string; type?: string; details?: string; dev?: string; meta?: Record<string, unknown> };
}

{
  type: 'operation';
  operationId: string;
  operationKind: 'prompt' | 'skill' | 'task' | 'shell' | 'compact';
  durationMs: number;
  isError: boolean;
  error?: unknown;
  result?: unknown;
  usage?: PromptUsage;
}

{
  type: 'turn';
  turnId: string;
  purpose: LlmTurnPurpose;       // 'agent' | 'compaction' | 'compaction_prefix'
  durationMs: number;
  request: ModelRequestInfo;
  response: ModelResponse;
  isError: boolean;
}

{ type: 'tool_start'; toolName: string; toolCallId: string; args?: any }
{ type: 'tool'; toolName: string; toolCallId: string; isError: boolean; result?: unknown; durationMs: number }

{ type: 'task_start'; taskId: string; prompt: string; agent?: string; cwd?: string }
{ type: 'task'; taskId: string; agent?: string; isError: boolean; result?: any; durationMs: number }

{ type: 'log'; level: 'info' | 'warn' | 'error'; message: string; attributes?: Record<string, unknown> }
```

### Usage and model-request types

```ts
interface PromptUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

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

`usage` fields: `input`/`output` tokens, `cacheRead`/`cacheWrite` prompt-cache tokens, `totalTokens`, and `cost` estimated from the model catalog's per-million-token rates (USD for the built-in registry's commercial providers).

### `FlueObservation` (live-only detail fields)

```ts
type FlueObservation = FlueEvent & {
  agentInput?: { text: string; images?: Array<{ mimeType: string }> };
  agentOutput?:
    { type: 'text'; text: string; finishReason: string } | { type: 'data'; data: unknown };
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

Every detail field is live-only: never persisted, never replayed, never on a transported event. `args` lands on `tool_start`; `effectiveResult` on successful `tool`; `origin` on `tool_start`/`tool`; `errorInfo` (with throw-site `stack`) on failed `operation`, `tool`, `task`, `compaction`, `submission_recovery`, `submission_settled`.

### `instrument()` and interceptors

```ts
function instrument(instrumentation: FlueInstrumentation): () => Promise<void>;

interface FlueInstrumentation {
  key?: symbol;
  observe: FlueObservationSubscriber;
  interceptor: FlueExecutionInterceptor;
  dispose(): void | Promise<void>;
}

type FlueExecutionInterceptor = <T>(
  operation: FlueExecutionOperation,
  ctx: FlueExecutionContext,
  next: () => Promise<T>,
) => Promise<T>;

type FlueExecutionOperation =
  | { type: 'agent'; operationId: string; operationKind: 'prompt' | 'skill' | 'task' }
  | { type: 'model'; turnId: string }
  | { type: 'tool'; toolCallId: string; toolName: string }
  | { type: 'task'; taskId: string };
```

`instrument()` pairs an observer with an execution interceptor so spans wrap live agent, model, tool, and task execution. Scopes nest (a `model` interception runs inside its enclosing `agent` interception's async context), which lets a tracer parent spans with no Flue-specific propagation. `next` is exactly-once. `key` prevents double installation: reinstalling the same key throws `InstrumentationAlreadyInstalledError` (`type: 'instrumentation_already_installed'`) in production; in dev the newest install wins and the prior is disposed, which makes module-scope installs safe across dev-server reloads.

### `IMAGE_DATA_OMITTED`

```ts
const IMAGE_DATA_OMITTED = '[image data omitted from event]';
```

Exported from both `@flue/runtime` and `@flue/sdk`. Replaces raw base64 image bytes in every event payload. Session history and canonical attachments keep the real bytes; only events are redacted.

### Integrations and config

- Sentry — `flue add tooling sentry`. Terminal failures as issues, every log in Sentry Logs, optional AI traces with content off by default.
- Braintrust — `flue add tooling braintrust`. Operations as traces with model, tool, task, and compaction spans plus usage.
- OpenTelemetry — add `@flue/opentelemetry` to your OTel SDK setup. GenAI spans, metrics, and logs.
- `tracing: false` in `flue.config.ts` drops agent tracing from the Cloudflare build.
- `createCloudflareTracing({ content, transform, truncateContent })` from `@flue/runtime/cloudflare`.

## Recommended use cases

- Per-agent/per-model token and cost metering.
- Alerting on terminal failures (`submission_settled` with `outcome: 'failed'`).
- Forwarding tool and hook `log` lines to an external logging backend.
- Diagnosing provider-level model failures (finish reasons, AI Gateway log ids).
- Wiring LLM tracing into Sentry, Braintrust, or an OTel backend.

## Patterns

**Token metering from `turn` events.**

```ts
import { observe } from '@flue/runtime';
import { metrics } from './shared/metrics.ts';

observe((event) => {
  if (event.type !== 'turn' || !event.response.usage) return;
  const { usage } = event.response;
  metrics.increment('llm.tokens', usage.totalTokens, {
    agent: event.agentName,
    model: event.request.requestedModel,
    purpose: event.purpose, // 'agent' | 'compaction' | 'compaction_prefix'
  });
  metrics.increment('llm.cost', usage.cost.total, { agent: event.agentName });
});
```

**Provider diagnostics on failed turns.**

```ts
import { observe } from '@flue/runtime';

observe((event) => {
  if (event.type !== 'turn' || !event.isError) return;
  console.error('model turn failed', {
    provider: event.request.providerName,
    model: event.request.requestedModel,
    finishReason: event.response.finishReason,
    providerFinishReason: event.response.providerFinishReason,
    gatewayLogId: event.response.gatewayLogId,
    error: event.response.error?.message,
  });
});
```

`providerFinishReason` is the provider's exact finish value before normalization (for example Workers AI's `tool_calls` behind the normalized `toolUse`); `gatewayLogId` is the Cloudflare AI Gateway `cf-aig-log-id` for that response. Both are telemetry only and present only when the provider records them — the Workers AI provider attaches both today. `request.providerId` is the registration key from the model specifier; `request.providerName` is the semantic provider identity, which differs when a gateway or custom registration fronts the model.

**Logging from inside a tool, then forwarding.**

```ts
async run({ data, log }) {
  log.info('sync started', { records: data.ids.length });
  const failed = await crm.sync(data.ids);
  if (failed.length > 0) log.error('sync incomplete', { failed: failed.length });
  return { synced: data.ids.length - failed.length };
}
```

```ts
import { observe } from '@flue/runtime';
import { logger } from './shared/logger.ts';

observe((event) => {
  if (event.type !== 'log') return;
  logger.log(event.level, event.message, {
    ...event.attributes,
    conversation: event.conversationId,
  });
});
```

Tool logs are stamped with `tool` and `toolCallId`; hook logs with the hook that wrote them (`hook`, `hookIndex`). The model never sees log lines.

**Installing a span-producing integration.**

```ts
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';

instrument(createOpenTelemetryInstrumentation());
```

**Customizing Cloudflare's built-in agent tracing** (install at `app.ts` module scope; this replaces the default):

```ts
import { instrument } from '@flue/runtime';
import { createCloudflareTracing } from '@flue/runtime/cloudflare';

instrument(createCloudflareTracing({ content: false }));
```

## When to use / when not to use

Use the runtime event stream (`observe()` / `instrument()`) for telemetry, metering, error reporting, and log export — anything operational, across all agents in the process.

Do not use it for:

- **Rendering a conversation in a UI.** Use the conversation stream instead: `createFlueClient(...)` `observe()` / `history()` from the Flue Agent SDK, covered by the Routing guide. The two `observe()` functions share a name but not a shape — the SDK client's maintains one conversation's materialized message state, the runtime's delivers raw activity events.
- **Stamping token counts onto a response for your client.** Do that inside the agent with `useResponseFinish()`, which receives the whole response's aggregate usage (see Agent Hooks / Event hooks).
- **Scored regression checks on agent behavior.** Use Evals.
- **Durable history or cross-process aggregation.** The subscription is live-only with no replay; export to a backend that stores.
- **Fleet health, latency, and reading conversations on Cloudflare.** The platform's Workers Logs and Workers Traces already show that with no Flue-side wiring; reach for the runtime stream when you need the complete record (settlement outcomes, error details, anything a trace attribute can't hold).

Choose Sentry when you want failures, logs, and traces in an existing application monitor; Braintrust when you want content-bearing LLM traces for inspection and evaluation; OpenTelemetry when your organization standardizes on an OTel backend. They compose — an error reporter and a tracer can subscribe side by side.

## Gotchas and constraints

- **Isolate-scoped and live-only.** No durable replay, no cross-process aggregation. On Node.js one process hosts all agents, so one registration sees everything. On Cloudflare each agent conversation runs in its own Durable Object isolate, so a subscriber registered from `app.ts` runs in each isolate and sees that isolate's activity only.
- **`flue run` never loads `app.ts`** — it loads only the agent module. Register the subscriber in the agent module when it must also run under the CLI. Same caveat as `setProvider()`.
- **Subscribers run on the emission path.** Slow subscribers slow emission; interceptors are worse — a slow interceptor slows the agent and a throwing interceptor fails the wrapped operation.
- **Do not double-count usage.** `turn` usage is the leaf; `operation` and `compaction` roll-ups already include it. Sum one level only. Durations overlap the same way and should not be added.
- **Do not meter from both families.** The normalized `turn` events and the detailed `turn_messages`/`message_*` family describe the same model activity — pick one.
- **Streaming deltas are not authoritative.** The assistant `message_end` event carries the completed message.
- **Nested errors don't imply failure.** An agent can recover from a failed turn or tool call. Alert on `submission_settled` outcomes; read nested `isError` events as diagnostic context.
- **`turn_request` never leaves the process.** It carries the system prompt, complete message context, and tool list; delivered to `observe()` subscribers only, never persisted, never served over HTTP.
- **No raw image bytes in events.** Image content blocks carry `IMAGE_DATA_OMITTED` in place of their base64 data.
- **Stacks are live-only.** Durable-shaped error fields on `operation`, `compaction`, `log`, `submission_recovery`, and `submission_settled` never include stacks; the stack appears only on `turn.response.error` and the observation's `errorInfo`.
- **`tool_start.args` is declared but not populated** by the current runtime — read normalized arguments from the observation's `args` instead. Same for `ModelRequestInfo.contextCompacted` and `FlueExecutionContext.eventContext`.
- **Terminal `tool` events for model-invoked calls publish when the turn's tool batch durably commits**, not when execution finishes; an interrupted batch never publishes them. `shell()` publishes immediately, appears as `toolName: 'bash'` with observation `origin: 'caller'`, redacts per-call `env` values to `<redacted>`, and a failure carries `details.exitCode: -1`.
- **Content is captured by default by both trace adapters.** Installing an instrumentation with `instrument(...)` is the consent for any exporter that leaves Cloudflare. `content: false` turns capture off entirely; `content: { transform }` is the policy hook (redact, drop by `scope.contentType`, or tighten the byte budget with `truncateContent`).
- **Per-exporter posture differs.** The Cloudflare adapter never emits raw error messages or stacks (failures record only a low-cardinality `error.type`); the OTel adapter passes exception messages and stacks through the same content gate; Sentry keeps model and tool content out of traces unless its record flags opt in; Braintrust is content-bearing with a masking hook.
- **Cloudflare flushing.** Each integration exports per isolate and final flushes are best-effort. On Node a module-scope `instrument()` install is not disposed at server shutdown — register your own signal handling if you must flush on exit.
- **Internal shapes without stability guarantees:** `AgentMessage` values on `message_start`/`message_end`/`turn_messages`/`agent_end`, `tool.result` and `effectiveResult`, and `operation.result`. Prefer `turn.response.output` (typed `LlmAssistantMessage`). Breaking changes bump `v`; additive optional fields do not.

## Related

- [Events Reference](https://flueframework.com/docs/reference/events/) — full event vocabulary, envelope fields, `observe()` and `instrument()` contracts.
- [Routing](https://flueframework.com/docs/guide/routing/) and [Agent SDK](https://flueframework.com/docs/sdk/overview/) — the conversation stream a UI consumes.
- [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/#event-hooks) — read usage and stamp response metadata from inside the agent.
- [Tools](https://flueframework.com/docs/guide/tools/#how-a-tool-call-works) — the tool run context's logger.
- [Models](https://flueframework.com/docs/guide/models/#cloudflare-workers-ai-cloudflare-only) — the Workers AI provider and its diagnostics.
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/) and [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/#observability).
- [Sentry](https://flueframework.com/docs/ecosystem/tooling/sentry/), [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/), [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/).
- [Evals](https://flueframework.com/docs/guide/evals/) — turn observed behavior into scored regression checks.
