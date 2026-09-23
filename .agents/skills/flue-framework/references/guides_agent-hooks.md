---
title: Agent Hooks
source: https://flueframework.com/docs/guide/agent-hooks/
section: guides
also_read:
  - https://flueframework.com/docs/reference/agent-hooks-api/
---

# Agent Hooks

## What it is

An agent function returns instructions; hooks give it everything else — model, tools, skills, subagents, sandbox, durable state, lifecycle callbacks. A hook is a plain function, named `use*`, called synchronously inside the agent function body (or inside a custom hook it calls). The agent function *re-renders* before every model call and re-runs its hooks, like React — but unlike React, resource hooks may be added and removed conditionally, and Flue narrates the change to the model so the transcript stays coherent.

## API surface

All hooks are exported from `@flue/runtime`.

Built-in hooks introduced by this page:

| Hook | Purpose |
| --- | --- |
| `useModel` | selects the LLM powering the agent |
| `useSandbox` | filesystem + command-execution environment |
| `useTool` | mount a model-callable tool |
| `useMcpConnection` | mount tools from a remote MCP server |
| `useSkill` | mount a skill the model can load on demand |
| `useSubagent` | declare a delegate for the `task` tool |
| `usePersistentState` | durable custom data across the agent lifetime |
| `useInitialData` | read data passed at instance creation |
| `useAgentStart` / `useAgentFinish` / `useResponseStart` / `useResponseFinish` | lifecycle callbacks |
| `useDataWriter` | stream structured data to the client UI |

Signatures (from the Agent Hooks API reference):

```ts
function useModel(model: string, options?: { thinkingLevel?: ThinkingLevel; compaction?: false | CompactionConfig }): void;
function useSandbox(sandbox: SandboxFactory, options?: { cwd?: string }): void;
function useTool(tool: ToolDefinition): void;
function useMcpConnection(definition: McpConnectionDefinition): void;
function useSkill(skill: Skill): void;
function useSubagent(subagent: SubagentDefinition): void;
function useInstruction(text: string): void;

function usePersistentState<T>(name: string, defaultValue: T): [T, StateSetter<T>];
function usePersistentState<T = unknown>(name: string): [T | undefined, StateSetter<T | undefined>];
type StateSetter<T> = (value: T | ((previous: T) => T)) => void;

function useInitialData<T = unknown>(): T;
function useDelivery(): DeliveredMessage;
function useDispatchMessage(): (message: DeliveredMessageInput) => Promise<DispatchReceipt>;

function useDataWriter<TSchema extends v.GenericSchema>(name: string, options: { schema: TSchema }): (data: v.InferOutput<TSchema>) => void;
function useDataWriter(name: string): (data: unknown) => void;

function useAgentStart(run: (ctx: AgentStartContext) => void | Promise<void>): void;
function useAgentFinish(run: (ctx: AgentFinishContext) => void | Promise<void>): void;
function useResponseStart(run: ResponseMetadataCallback<ResponseStartContext>): void;
function useResponseFinish(run: ResponseMetadataCallback<ResponseFinishContext>): void;
type ResponseMetadataCallback<TCtx> = (ctx: TCtx) => Record<string, unknown> | void;
```

Event-hook contexts:

```ts
interface AgentStartContext {
  readonly append: (message: AgentAppendMessage) => void;
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
  readonly signal: AbortSignal;
}

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

interface AgentAppendMessage {
  kind: 'signal';
  type: string;
  body: string;
  attributes?: Record<string, string>;
  tagName?: string;
}

interface ResponseStartContext { readonly metadata: Record<string, unknown>; readonly log: FlueLogger }
interface ResponseFinishContext {
  readonly metadata: Record<string, unknown>;
  readonly response: { readonly usage: PromptUsage; readonly toolCalls: readonly AgentResponseToolCall[] };
  readonly log: FlueLogger;
}
```

File conventions and directives:

- `'use agent';` at the top of the agent module file.
- Agent function is a named export; hooks are called in its body.
- Skills are imported as `SKILL.md` files: `import reviewChecklist from '../skills/review-checklist/SKILL.md';`
- Agent static for creation-data validation: `Triage.initialData = v.object({ ... })` (Valibot).
- `local()` sandbox factory comes from `@flue/runtime/node`.

## The basic shape

```ts
'use agent';
import { useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { searchIssues } from '../tools/search-issues.ts';
import reviewChecklist from '../skills/review-checklist/SKILL.md';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useTool(searchIssues);
  useSkill(reviewChecklist);
  return 'Investigate the reported issue and recommend the next action.';
}
```

## Persisted state

`usePersistentState` looks like `useState` but the value is durable: every write is recorded in the conversation's storage and every render reads the latest value back — across turns, restarts, for the life of the conversation. Values must be JSON-serializable; each piece of state is keyed by its name.

```ts
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';

export function CaseAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  const [phase, setPhase] = usePersistentState('phase', 'gathering');
  const [factsChecked, setFactsChecked] = usePersistentState('factsChecked', 0);

  useTool({
    name: 'check_fact',
    description: 'Verify one case fact.',
    async run() {
      setFactsChecked((previous) => previous + 1);
    },
  });
  useTool({
    name: 'begin_draft',
    description: 'Call once the case facts are verified.',
    async run() {
      setPhase('drafting');
    },
  });

  return `Current phase: ${phase}. Facts checked: ${factsChecked}.`;
}
```

When the next value derives from the current one, pass an updater (`(previous) => previous + 1`) rather than computing from the render value: the render value is a snapshot, an updater always sees the latest write.

## Patterns

### Gate capabilities on state (conditional resources)

```ts
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';
import refundTool from '../tools/refund.ts';

export function SupportAgent() {
  useModel('anthropic/claude-haiku-4-5');
  const [escalated, setEscalated] = usePersistentState('escalated', false);
  // Tools can modify persisted state.
  useTool({
    name: 'escalate',
    description: 'Escalate this conversation when the customer needs a refund.',
    async run() {
      setEscalated(true);
      return 'Escalated. The refund tool is now available.';
    },
  });
  // If the agent has determined that the conversation needs escalation,
  // the "refund" tool is unlocked and made available to the agent.
  if (escalated) {
    useTool(refundTool);
  }
  return 'Answer customer support questions clearly and accurately.';
}
```

### Load data once per conversation in `useAgentStart`

`useAgentStart()` runs every time a message is delivered to the agent and is async, which makes it the natural place to load data before the model runs.

```ts
'use agent';
import { type AgentProps, useAgentStart, useModel, usePersistentState } from '@flue/runtime';
import { crm, type Customer } from '../shared/crm.ts';

export function AccountSupport({ id }: AgentProps) {
  useModel('anthropic/claude-haiku-4-5');
  const [customer, setCustomer] = usePersistentState<Customer | null>('customer', null);

  useAgentStart(async () => {
    if (customer) return; // load once per conversation
    setCustomer(await crm.lookupCustomer(id));
  });

  return customer
    ? `Help ${customer.name} (${customer.plan} plan) with their account.`
    : 'Help the customer with their account.';
}
```

### Stamp response metadata

`useResponseStart` / `useResponseFinish` run exactly once at a response's true start and true end, regardless of how many messages the agent received. Anything returned is merged onto the response's **metadata** — an envelope field the client reads outside the message content.

```ts
useResponseStart(() => ({ startedAt: Date.now() }));
useResponseFinish(({ metadata, response }) => ({
  elapsed: Date.now() - (metadata.startedAt as number),
  totalTokens: response.usage.totalTokens,
}));
```

### Pass structured data in at creation

```ts
'use agent';
import * as v from 'valibot';
import { useModel, useInitialData } from '@flue/runtime';

export function Triage() {
  useModel('anthropic/claude-opus-4-6');
  const data = useInitialData<v.InferOutput<typeof Triage.initialData>>();
  return `Triage GitHub issue #${data!.issue} end-to-end.`;
}
// Optional: Pass a schema object to type-check the initial data at runtime
Triage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
```

Callers:

```ts
// Dispatch
await dispatch(Triage, {
  id: 'issue-17307',
  initialData: { issue: 17307 },
  message: 'New GitHub issue created.',
});
```

```bash
# CLI
flue run ./triage-agent.ts --id issue-17307 --data '{"issue": 17307}' \
  --message "New GitHub issue created."
```

```bash
# HTTP
curl -X POST https://example.com/agents/triage-agent/issue-17307 \
  -H 'Content-Type: application/json' \
  -d '{"initialData": {"issue": 17307}, "kind": "user", "body": "New GitHub issue created."}'
```

`client.send({ message, initialData })` carries it the same way.

### Stream structured data to the client

```ts
'use agent';
import { useDataWriter, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export function OrderAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  const writeOrderCard = useDataWriter('orderCard', {
    schema: v.object({ orderId: v.string(), status: v.picklist(['loading', 'loaded']) }),
  });

  useTool({
    name: 'lookup_order',
    description: 'Look up one order for the customer.',
    input: v.object({ orderId: v.string() }),
    async run({ data }) {
      writeOrderCard({ orderId: data.orderId, status: 'loading' });
      const order = await orders.get(data.orderId);
      writeOrderCard({ orderId: data.orderId, status: 'loaded' });
      return order.summary;
    },
  });

  return 'Help customers check the status of their orders.';
}
```

Client side with `@flue/react` — data parts arrive alongside text parts on the same message:

```tsx
import { useFlueAgent } from '@flue/react';
import { OrderCard } from './order-card.tsx';

export function OrderChat({ conversationId }: { conversationId: string }) {
  const agent = useFlueAgent({ url: `/api/agents/order-assistant/${conversationId}` });

  return agent.messages.map((message) =>
    message.parts.map((part, index) => {
      if (part.type === 'text') return <p key={index}>{part.text}</p>;
      if (part.type === 'data-orderCard') {
        const order = part.data as { orderId: string; status: string };
        return <OrderCard key={index} {...order} />;
      }
      return null;
    }),
  );
}
```

### Custom hooks

A custom hook is a function you define yourself, always prefixed with `use`. It may take arguments and return values like any other function; hooks it calls record exactly as if the agent body had called them.

```ts
import { useModel, useTool } from '@flue/runtime';
import { escalateCase } from '../shared/support-tools.ts';

function useEscalation() {
  useTool(escalateCase);
  return 'Escalate to a specialist only after you have confirmed the account and issue.';
}

function SupportAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  const escalationInstructions = useEscalation();
  return `Answer customer support questions accurately. ${escalationInstructions}`;
}
```

A `useGitHub()` hook that bundles the right tools, skills and instructions can be written once and dropped into every agent that works with GitHub.

## Recommended use cases

- Multi-step / multi-phase agents: keep the phase in `usePersistentState`, interpolate it into instructions, gate tools and skills on it.
- Progressive unlocking: a sensitive tool (refund, deploy, payout) only mounted once a precondition is recorded.
- Loading context before the model runs (CRM record, ticket, account) — `useAgentStart`, guarded so it loads once.
- One-time work that must happen exactly once — guard with persistent state.
- Custom UI alongside the reply (order card, progress meter, chart) — `useDataWriter`.
- Per-instance configuration fixed at creation — `initialData` + `useInitialData`.
- Timing / usage / application markers on the response envelope — `useResponseStart` + `useResponseFinish`.
- Sharing a capability bundle across several agents — a custom hook.

## When to use which

- **Persisted state vs. the transcript**: everything else an agent knows lives loosely in the conversation transcript; persistent state is the part your code can read and act on. Use it when code must branch on the value.
- **`usePersistentState` vs. `useInitialData`**: evolving facts go in persistent state; facts fixed at creation go in `initialData` (it is recorded once and never changes — data sent to an existing instance is ignored). Per-message facts belong to `useDelivery`.
- **`useAgentStart` vs. `useResponseStart`**: async loading work goes in `useAgentStart` (it is awaited and can be async). `useResponseStart`/`useResponseFinish` are synchronous observers — returning a promise fails the submission.
- **`useAgentFinish` vs. `useResponseFinish`**: `useAgentFinish` is a control seam that can `append` a signal and send the model back to work; `useResponseFinish` only observes and stamps metadata after everything settles.
- **`useDataWriter` vs. a tool result**: data writers are one-way to the client — the model never sees them. If the model needs the value, return it from the tool instead.
- **`useSkill` vs. `useInstruction`**: always-on content needs no skill — import the markdown as a string (any `.md` import loads as text) and pass it to `useInstruction()`. Use a skill when the content should be loaded on demand.
- **`useSubagent` vs. more tools**: delegate focused work to a subagent when you want isolation and only a final text answer back; mount tools directly when the main agent should keep the context.
- Do **not** call a write function (state setter, data writer, dispatcher) during a render — renders are pure reads and those functions throw. Call them from tool `run` functions and other callbacks.

## Gotchas and constraints

- Hooks may only be called while the agent function renders — synchronously in its body or in a custom hook it calls. Anywhere else (tool `run`, event-hook callbacks, module scope) every hook throws `[flue] <hook>() was called outside an agent function.`
- Changing the tool set can invalidate the provider's prompt cache (see the conditional-tools note in the Tools guide).
- `useModel` is required, exactly once per render; calling it twice throws, and so does calling `useSandbox` twice.
- `useDataWriter` names are structural identity: declare them unconditionally and identically on every render; a delta between consecutive renders throws with the added/removed names. One unique name each.
- Duplicate names within one render throw everywhere they identify something: tool, MCP server, skill, subagent, state and data-part names.
- Persistent state values must be JSON-serializable; writes are normalized through a JSON round-trip and throw on non-serializable input. Setting `undefined` throws — there is no unset.
- Event-hook callbacks run **at-least-once**: completed work commits durably and is never repeated, interrupted work is retried. Guard anything that must not happen twice (an outbound email, a page) with persistent state.
- A `useAgentStart` delivery's callbacks run concurrently in no guaranteed order — never rely on a sibling callback's writes; work needing ordering goes in one callback.
- An event-hook callback throw fails the submission.
- `useAgentFinish` has a fixed framework ceiling of 32 continuation cycles per response (not configurable); a hook that appends unconditionally fails the submission loudly. The submission's `timeoutMs` deadline (the `durability` static — see Durability below) is still the wall-clock backstop underneath that ceiling — continuation cycles and joined deliveries never extend it.
- `ctx.append` (on `useAgentStart`/`useAgentFinish`) is not `useDispatchMessage()`/`dispatch()` in miniature: it writes a `kind: 'signal'` message into the *current* response only — no new delivery, no `useAgentStart` run of its own, no submission — and is only callable during that callback's execution window (a captured reference used later throws). It also only accepts `kind: 'signal'`; passing `kind: 'user'` throws. Reach for `append` to steer the response inline (the `useAgentFinish` "go do more work" pattern); reach for `useDispatchMessage()`/top-level `dispatch()` for anything that should be real new input with its own durable delivery record — e.g. one component posting to another agent, or a signal that must survive independently of this response settling.
- Submission-scoped values (`useModel` model/`thinkingLevel`/`compaction`, the `useSandbox` factory and `cwd`, `useMcpConnection` definitions) are read once when a submission starts — a value computed from state takes effect on the next submission, not mid-run. `useSandbox` *presence* is the exception: re-read at every turn boundary.
- Subagent renders throw for the instance-scoped and client-facing hooks: `useModel`, `useSandbox`, `useMcpConnection`, `usePersistentState`, `useDataWriter`, `useDispatchMessage` and all four event hooks. `useInitialData()` returns `undefined` there; `useDelivery()` returns the parent's task prompt.
- Compaction can eventually fold signals away — keep a callback's substance in durable state and files; a signal is the announcement, not the storage.

## Related

- [Agent guide](https://flueframework.com/docs/guide/building-agents/) — read first
- [Agent Hooks API](https://flueframework.com/docs/reference/agent-hooks-api/) — full contract for every built-in hook
- [Agent API](https://flueframework.com/docs/reference/agent-api/) — `dispatch()`, `init()`, `start()`, harness, `defineTool`/`defineSkill`/`defineSubagent`
- [Models](https://flueframework.com/docs/guide/models/), [Sandboxes](https://flueframework.com/docs/guide/sandboxes/), [Tools](https://flueframework.com/docs/guide/tools/), [MCP](https://flueframework.com/docs/guide/mcp/), [Skills](https://flueframework.com/docs/guide/skills/), [Subagents](https://flueframework.com/docs/guide/subagents/)
- [Durability](https://flueframework.com/docs/guide/durability/) — how state is stored and recovered
- [@flue/react](https://flueframework.com/docs/guide/react/) — client rendering of data parts
