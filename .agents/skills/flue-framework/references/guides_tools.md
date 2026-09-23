---
title: Tools
source: https://flueframework.com/docs/guide/tools/
section: guides
related_read:
  - https://flueframework.com/docs/reference/agent-api/#definetool
  - https://flueframework.com/docs/reference/agent-hooks-api/#usetool
---

# Tools

A tool is a function you write, described to the model, that the model may call while it works
(look up an order, file a ticket, issue a refund). The model decides *when* to call it; your code
decides *what happens*. A skill gives reusable instructions, a sandbox gives file and command
access — a tool executes your application's code.

Tools are declared per render with the `useTool` hook, so the tool set is ordinary program logic
and can change between renders.

## API surface

### `defineTool()`

Imported from `@flue/runtime` (also from the lighter `@flue/runtime/tool` entry for tool-only
modules). It validates the definition and returns it frozen, so bad definitions fail at module
load rather than first render.

```ts
function defineTool<...>(options: {
  name: string;
  description: string;
  input?: ToolInputSchema;   // Valibot schema; top-level object
  output?: ToolOutputSchema; // Valibot schema
  harness?: boolean;
  durable?: boolean;
  run(context: ToolContext<...>): ToolRunEnvelope<Output> | string | void | Promise<ToolRunEnvelope<Output> | string | void>;
}): ToolDefinition;
```

- `name`, `description` — required non-empty strings. The description is the model's *only*
  documentation for the tool: say what it does, when to use it, what it returns.
- `input` — a [Valibot](https://valibot.dev) schema, must be a **top-level object schema**
  (anything else throws). Parsed arguments arrive as `context.data`, typed by inference. Without
  it, `run` receives no `data` and caller arguments are ignored.
- `output` — optional Valibot schema for the return value; the runtime parses the returned value
  through it before recording. Mismatch throws `ToolOutputValidationError`; a schema producing
  `undefined` throws `ToolOutputSerializationError`.
- `harness`, `durable` — capability flags (below); booleans when present.
- `run` — returns a result envelope `{ output?, terminate? }`, not a bare value.

### `useTool()`

```ts
function useTool(tool: ToolDefinition): void;
```

Mounts a model-callable tool for the current render. Accepts a `defineTool(...)` value or an
inline definition object (same validation at the mount site). Works in the agent body or inside a
custom hook; everything joins one flat tool set. Duplicate names across the render throw
`ToolNameConflictError`.

### `ToolContext` — what `run` receives

```ts
type ToolContext<Input, Harness, Durable> = {
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
  readonly log: FlueLogger;
} & {
  readonly data: v.InferOutput<Input>; // when `input` is declared
} & {
  readonly harness: FlueHarness; // when `harness: true`
} & {
  readonly step: ToolStep; // when `durable: true`
};

interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}
```

- `signal` — abort signal for the call; pass it to your own async work. A `run` that ignores it
  can't wedge the agent: the runtime abandons the await, the call fails with an `AbortError`
  saying the work may still be running, and the orphaned promise's result is discarded.
- `log` — progress logging that streams into the conversation as `log` events your application
  can observe. Not part of the result; **the model never sees these lines**.
- `toolCallId` — the id of this call, the same id on the call's `tool_start`/`tool` events and
  tool-result message. Use it to correlate side effects.

### `ToolStep` (durable tools)

```ts
interface ToolStep {
  do<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}
```

### `FlueHarness` (harness tools)

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

interface PromptOptions<S extends v.GenericSchema | undefined = undefined> {
  result?: S;
  tools?: ToolDefinition[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  images?: PromptImage[];
}
```

### Conventions

- Shared tools live in a `src/tools/` directory, one exported `defineTool(...)` per file; shared
  domain code in `src/shared/`.
- Agent modules start with the `'use agent'` directive and mount tools inside the agent function.
- Every active tool needs a unique name. Framework-reserved names (`task`, `activate_skill`,
  `read_skill_resource`, plus the built-ins) cannot be taken by a custom tool.
- MCP server tools mount as `mcp__<server>__<tool>`.

## First tool, end to end

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up one order by id and return its current status.',
  input: v.object({ orderId: v.string() }),
  async run({ data }) {
    const order = await orders.get(data.orderId);
    return { output: { status: order.status, eta: order.eta } };
  },
});
```

```ts
'use agent';
import { useModel, useTool } from '@flue/runtime';
import { lookupOrder } from '../tools/lookup-order.ts';

export function OrderAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  useTool(lookupOrder);
  return 'Help customers check the status of their orders.';
}
```

## How a call works

- **What the model sees**: `name`, `description`, and `input` converted to JSON Schema. A tool
  without `input` presents an empty object. Vague descriptions are the most common cause of a
  tool being called incorrectly or not at all.
- **Input**: parsed by the Valibot schema before `run` executes. Validation failure means `run` is
  never called; `ToolInputValidationError` goes back to the model as a tool error so it can fix
  its arguments and retry.
- **Output**: `run` returns `{ output?, terminate? }`. `output` must be JSON-serializable; it is
  snapshotted as JSON-compatible data and JSON-stringified for the model. A bare `string` return
  is shorthand for `{ output: <string> }`. Returning nothing is allowed only when no `output`
  schema is declared, and reaches the model as `null`. Any other bare return (object, array,
  number, boolean, `null`) throws.
- **`terminate: true`**: ends the agent's turn once the current tool batch settles — the same
  contract `finish`/`give_up` use. A multi-tool batch ends the turn only when every result in it
  terminates; a throwing tool never terminates. The flag is recorded on the canonical outcome, so
  termination survives a crash between the batch committing and the submission settling.
- **Errors**: a throw inside `run` does not crash the agent or fail the submission — it becomes an
  error result the model sees, so it can retry, try another approach, or tell the user. Throw (or
  return a descriptive failure value) rather than swallowing errors.

Typed output:

```ts
const checkInventory = defineTool({
  name: 'check_inventory',
  description: 'Check the stock level for one SKU.',
  input: v.object({ sku: v.string() }),
  output: v.object({ inStock: v.number(), warehouse: v.string() }),
  async run({ data }) {
    return { output: await inventory.lookup(data.sku) };
  },
});
```

## Built-in tools

An agent **with a sandbox** gains these; without a sandbox they are not in the set at all.

| Tool  | What it does                                                         |
| ----- | -------------------------------------------------------------------- |
| read  | Read a file (truncated to 2000 lines or 50KB; supports offset/limit) |
| write | Write a file, creating it and parent directories as needed           |
| edit  | Edit a file by exact text replacement                                |
| bash  | Execute a shell command and return stdout/stderr                     |
| grep  | Search file contents for a regex pattern                             |
| glob  | Find files by filename pattern                                       |

Framework tools added when the capability exists: `task` for subagent delegation (always
present), `activate_skill` when the agent has skills, `read_skill_resource` when a skill packages
resource files. A sandbox adapter can replace the built-in set with its own
(`SandboxToolFactory`).

## Harness tools (`harness: true`)

An ordinary tool is a pure function of its input. Declare `harness: true` when a tool needs to
reach back into the agent's own runtime — its sandbox, or the model itself.

- `harness.sandbox` — the live environment (`readFile`, `writeFile`, `exec`, other sandbox verbs),
  touched directly with **no conversation record**. Throws when the agent declared no sandbox.
- `harness.prompt(text, options?)` — a model operation in the harness's own scratch conversation,
  separate from the agent's public conversation and never shown to clients. Repeated calls
  continue it (one active operation at a time), so a later prompt sees what earlier calls
  established. `options.result` (a Valibot schema) requires validated structured data — the model
  must call a framework-injected `finish` tool whose arguments validate against the schema, and
  the call resolves with `PromptResultResponse`; it rejects with `ResultUnavailableError` when the
  model gives up or exhausts follow-up attempts. `options.tools` offers extra tools for that one
  operation.

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const Report = v.object({ riskLevel: v.picklist(['low', 'medium', 'high']), summary: v.string() });

export const reviewContract = defineTool({
  name: 'review_contract',
  description: 'Review one supplied contract and return a structured risk report.',
  input: v.object({ contract: v.string() }),
  harness: true,
  async run({ harness, data }) {
    await harness.sandbox.writeFile('contract.md', data.contract);
    const { data: report } = await harness.prompt(
      'Review contract.md for non-standard terms and assess the risk.',
      { result: Report },
    );
    return { output: report };
  },
});
```

The pattern: stage inputs, run focused model work, validate the result — all behind one tool call.

## Durable tools (`durable: true`)

When a process crashes mid-turn, Flue recovers the conversation from durable records, but an
ordinary in-flight tool call is **not** re-executed: the runtime can't know which side effects
already happened, so the call settles with an unknown-outcome error and the model continues.

For work that must complete (a payment, a multi-step sync, a provisioning job), declare
`durable: true`. `run` then receives `step`, and every side effect goes through `step.do(name, fn)`.

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { billing, projects, DEFAULT_PROJECTS } from '../shared/provisioning.ts';

export const provisionWorkspace = defineTool({
  name: 'provision_workspace',
  description: 'Provision a customer workspace: create the tenant, then seed each default project.',
  input: v.object({ customerId: v.string() }),
  durable: true,
  async run({ data, step }) {
    const tenant = await step.do('create-tenant', () => billing.createTenant(data.customerId));
    for (const project of DEFAULT_PROJECTS) {
      await step.do(`seed:${project.name}`, () => projects.seed(tenant.id, project));
    }
    return { output: { tenantId: tenant.id, projects: DEFAULT_PROJECTS.length } };
  },
});
```

`step.do(name, fn)` runs `fn` once per name for the tool call and durably records its return value
before resolving. On recovery the whole call is re-executed: completed steps return recorded
values without running again, and execution continues from the first step that never finished.

Four rules:

1. **Everything effectful goes in a step.** Code between steps re-executes on recovery — keep it
   cheap and effect-free (derive values, branch, loop).
2. **Names identify the work.** Derive them deterministically (`seed:${project.name}`), never from
   randomness or timing. Reusing a name within one call throws; a non-empty string is required.
3. **Values are JSON and should stay small.** Store large artifacts in the sandbox and record a
   pointer. Non-serializable values throw.
4. **Exactly-once-recorded, at-least-once-executed.** A crash in the window between a step
   finishing and its record landing re-runs that step, so steps around external effects must be
   individually idempotent.

## Conditional tools

The agent function re-renders before every model call and each render declares its tool set from
scratch, so a tool's *presence* is program logic. Gate `useTool` on persistent state and the agent
can unlock its own capabilities.

```ts
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { approvals } from '../shared/approvals.ts';
import { publishRelease } from '../tools/publish-release.ts';

export function ReleaseManager() {
  useModel('anthropic/claude-sonnet-4-6');
  const [approved, setApproved] = usePersistentState('approved', false);

  useTool({
    name: 'record_approval',
    description: 'Record an operator approval code for this release.',
    input: v.object({ code: v.string() }),
    async run({ data }) {
      if (!(await approvals.verify(data.code))) return 'Invalid approval code.';
      setApproved(true);
      return 'Approval recorded. The publish tool is now available.';
    },
  });

  if (approved) useTool(publishRelease);

  return 'Prepare the release. Publishing unlocks once an operator approves.';
}
```

An unmounted tool can't be called — a stronger guarantee than instructing the model not to use it.
When the set changes between renders the runtime announces the delta to the model in a `resources`
signal at the next turn boundary ("New tool available: ...").

Pairs naturally with custom hooks: a `useEscalation()` hook can bundle the gate, the tools, and the
matching instructions for reuse across agents.

## Protecting access

A tool's arguments are model-selected inputs, **not** an authorization boundary. Your application
decides which customer, account, repository or credential a tool may use; the model only selects
values inside that boundary.

For dispatched, per-customer events, carry the authorized identifier in the delivered signal's
`attributes` and read it with `useDelivery()`:

```ts
'use agent';
import { useDelivery, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export function CustomerOrders() {
  useModel('anthropic/claude-haiku-4-5');
  const delivery = useDelivery();
  const customerId = delivery.kind === 'signal' ? delivery.attributes?.customerId : undefined;

  useTool({
    name: 'lookup_customer_order',
    description: 'Look up one order belonging to this customer.',
    input: v.object({ orderId: v.string() }),
    async run({ data }) {
      const status = customerId ? await orders.getStatus(customerId, data.orderId) : undefined;
      return status ?? 'No accessible order was found.';
    },
  });

  return 'Help this customer check the status of their orders.';
}
```

The model picks the order id; it cannot pick the customer. The dispatching route must still verify
the caller before attaching that identifier. Same principle for tools wrapping a provider SDK:
trusted code binds the token, repository or destination through a closure or configuration, and the
tool exposes only the narrow action. Avoid generic provider tools that expose arbitrary
destinations or API methods unless the application has an explicit authorization design.

## MCP servers

Remote MCP servers join the same tool set: `useMcpConnection(...)` declares a server and the
runtime mounts its tools as `mcp__<server>__<tool>` alongside `useTool` mounts. Connections are
read once per submission at initialization, so a conditional declaration takes effect at the next
submission. Subagent renders throw — declare the connection on the root agent. Details in the MCP
guide.

## Recommended use cases

- Calling application code from the model: look up an order, file a ticket, issue a refund, check
  inventory.
- Acting on external systems behind a narrow, authorized action (provider SDK wrapped by trusted
  code that binds the credential and destination).
- Money- or provisioning-grade multi-step work that must complete across a crash (`durable: true`).
- A single tool call that must stage files, run focused model work and validate the output
  (`harness: true`).
- Capability gating: an approval, escalation or unlock flow where a tool should not exist until a
  condition holds.

## When to use / when NOT to use

Use a **tool** when the model needs to run *your code* — a typed action with arguments and a
result.

Reach for something else when:

- You need reusable *instructions* rather than execution — use a **skill** (`activate_skill`).
- You need file and command access over an environment — declare a **sandbox** and use the
  built-in `read`/`write`/`edit`/`bash`/`grep`/`glob` tools instead of hand-rolling them.
- You want focused work delegated in its own conversation the model can choose — use a
  **subagent** via the built-in `task` tool. A `harness: true` tool is the choice when *your code*
  drives the model work and shapes the result behind one call, rather than the model deciding to
  delegate.
- The tool already comes from a remote MCP server — mount it with `useMcpConnection` (and do not
  wrap adapted MCP definitions in `defineTool()`).
- You want to forbid a capability — don't instruct the model not to use a tool; don't mount it.

## Gotchas and constraints

- The description is the model's only documentation. Vague descriptions are the top cause of
  misuse or non-use.
- `input` must be a top-level Valibot object schema; anything else throws.
- `run` must return the envelope. Bare objects/arrays/numbers/booleans/`null` throw; only a bare
  string (shorthand) or `void` (when no `output` schema) is accepted.
- Output must be JSON-serializable, or `ToolOutputSerializationError`.
- Duplicate tool names, or collisions with reserved names (`task`, `activate_skill`,
  `read_skill_resource`), throw when the tool set is assembled (`ToolNameConflictError`).
- Built-in file/shell tools exist only when the agent declares a sandbox.
- `harness: true` tools never run standalone — a harness only exists inside an agent session.
  `harness.sandbox` throws when no sandbox is declared. Harness invocations count against the
  delegation-depth cap and their child conversations are retained on the parent conversation.
- Durable steps: JSON-serializable and small values only; deterministic names; idempotent effects;
  code between steps re-executes. Outside an agent session there is no durability — testing a
  durable `run` directly means supplying your own `step` stub.
- A thrown error is not an interruption: a durable tool that throws settles as a normal tool error
  and nothing retries automatically. Steps are scoped to one call and run fresh on the next
  invocation.
- Flags compose: `durable: true, harness: true` gives both `step` and `harness` — wrap
  `harness.prompt(...)` in a step so recovery doesn't re-prompt.
- Changing the tool set rewrites the provider's tools array and invalidates its prompt cache, so
  gate tools on state that changes rarely. Exception: a tool unlocked by a completed tool call
  (the `record_approval` → `publish_release` shape) — current Anthropic models except Haiku load
  its definition at the point in the conversation where it appeared, and the cache survives.
- Tool arguments are not an authorization boundary.
- `log` lines are for your application's observers, not the model.

## Related

- [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/) — the hook model `useTool`
  belongs to, persistent state, custom hooks.
- [Agent API](https://flueframework.com/docs/reference/agent-api/) — full `defineTool`,
  `ToolContext`, `ToolStep` and harness contracts.
- [Agent Hooks API — useTool](https://flueframework.com/docs/reference/agent-hooks-api/#usetool)
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) — the environment behind the
  built-in file and shell tools, and `SandboxToolFactory`.
- [Subagents](https://flueframework.com/docs/guide/subagents/) — delegation through `task`.
- [Skills](https://flueframework.com/docs/guide/skills/) — reusable instructions.
- [Durability](https://flueframework.com/docs/guide/durability/#durable-tools-and-stepdo)
- [MCP](https://flueframework.com/docs/guide/mcp/)
- [Channels — Use provider SDKs](https://flueframework.com/docs/guide/channels/#use-provider-sdks)
- [Agent Behavior — Built-in tools](https://flueframework.com/docs/reference/agent-behavior/#built-in-tools)
- [Routing](https://flueframework.com/docs/guide/routing/)
