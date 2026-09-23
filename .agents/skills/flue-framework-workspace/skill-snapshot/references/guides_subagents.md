---
title: Subagents
source: https://flueframework.com/docs/guide/subagents/
section: guides
related_read:
  - https://flueframework.com/docs/reference/agent-hooks-api/#usesubagent
  - https://flueframework.com/docs/reference/agent-api/#subagentdefinition
  - https://flueframework.com/docs/guide/durability/#delegated-tasks
---

# Subagents

## What it is

A subagent is a named delegate that an agent can hand a focused task to. The delegate runs in its own fresh context with its own instructions and capabilities, and only its final answer comes back into the parent's conversation — no intermediate reasoning, tool calls or file reads. Delegation is model-driven: the parent's model calls a framework-owned `task` tool naming the delegate. A subagent is a capability of an agent, not a registered agent of its own.

## API surface

### `useSubagent()`

```ts
function useSubagent(subagent: SubagentDefinition): void;
```

Declares a delegate for the `task` tool. Called inside an agent function's render.

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

- `name` — catalog name the model passes to the `task` tool. Required, non-empty.
- `description` — the catalog line the parent's model reads when deciding whether to delegate. Write it like a good tool description: what it does and when to use it. Required, non-empty.
- `agent` — an ordinary agent function that returns the delegate's instructions and mounts its capabilities. Required.
- `model` — model specifier override (`'provider-id/model-id'`). Inherits the parent's model when omitted.
- `thinkingLevel` — reasoning-effort override. Inherits when omitted.

### `defineSubagent()`

```ts
function defineSubagent(definition: SubagentDefinition): SubagentDefinition;
```

Typing helper, same role as `defineTool(...)` / `defineSkill(...)`. Validates the definition at module load instead of first render and returns it frozen. The returned object is the exportable unit.

### `GeneralSubagent`

```ts
const GeneralSubagent: SubagentDefinition;
```

A ready-made blank delegate exported from `@flue/runtime`. Mounts under the framework-reserved name `flue-general`. Its agent function is empty — the child gets the shared environment's tools, workspace context from its cwd, and the parent's model, and nothing else.

### The `task` tool

- Always present in every agent's tool set, with a fully static spec (changing it would rewrite the serialized tools block and invalidate the provider's prompt cache).
- Its required `agent` parameter only resolves against declared subagents, so an agent with no `useSubagent()` calls cannot delegate — the tool is inert.
- The model may also pass an optional `cwd` to point the child at a different working directory, and can forward images from the conversation by attachment id.
- Declared delegates are listed by name and description in an "Available Agents" section of the system prompt.

### File conventions / directives

- Agent modules carry the `'use agent'` directive; the build registers every **exported capitalized function** in such a module as a top-level agent.
- Therefore delegate agent functions must stay **unexported** inside `'use agent'` modules, or live in ordinary (non-`'use agent'`) modules.
- Shared delegates live in their own module (e.g. `../subagents/issue-classifier.ts`) and are exported as a `defineSubagent(...)` result.

## Examples from the docs

Basic declaration:

```ts
'use agent';
import { useModel, useSubagent } from '@flue/runtime';

function Summarizer() {
  return 'You summarize support cases in three sentences.';
}

export function CaseAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  useSubagent({
    name: 'summarizer',
    description: 'Summarizes one support case.',
    agent: Summarizer,
  });
  return 'Investigate the case. Delegate the summary to the `summarizer` subagent.';
}
```

Composing a delegate's own world, with a file as the hand-off surface:

```ts
'use agent';
import { useModel, useSkill, useSubagent, useTool } from '@flue/runtime';
import { searchIssues } from '../tools/search-issues.ts';
import reproduceSkill from '../skills/reproduce/SKILL.md';

function Reproducer() {
  useTool(searchIssues);
  useSkill(reproduceSkill);
  return 'You reproduce one reported issue. Write your findings to report.md.';
}

export function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  useSubagent({
    name: 'reproducer',
    description: 'Sets up the reproduction for one issue and writes report.md.',
    agent: Reproducer,
  });
  return 'Investigate the reported issue. Delegate the reproduction to the `reproducer` subagent.';
}
```

General-purpose fan-out:

```ts
'use agent';
import { GeneralSubagent, useModel, useSubagent } from '@flue/runtime';

export function Researcher() {
  useModel('anthropic/claude-sonnet-4-6');
  useSubagent(GeneralSubagent);
  return 'Answer questions about this codebase. Fan independent research out to the `flue-general` subagent, one question per task.';
}
```

Shared delegate, defined once:

```ts
import { defineSubagent } from '@flue/runtime';

function IssueClassifier() {
  return 'Return the likely product area and urgency for the reported issue.';
}

export const issueClassifier = defineSubagent({
  name: 'issue_classifier',
  description: 'Classifies support issues for routing.',
  agent: IssueClassifier,
});
```

Mounted with a per-mount override (overrides spread cleanly):

```ts
'use agent';
import { useModel, useSubagent } from '@flue/runtime';
import { issueClassifier } from '../subagents/issue-classifier.ts';

export function Support() {
  useModel('anthropic/claude-sonnet-4-6');
  useSubagent({ ...issueClassifier, model: 'anthropic/claude-haiku-4-5' });
  return 'Handle the support ticket. Classify it with the `issue_classifier` subagent first.';
}
```

## How delegation works

1. The model calls `task` with the delegate's name and a prompt.
2. The runtime renders the delegate's `agent` function — fresh, at delegation time, in its own frame — into the child's instructions, tools and skills.
3. The child runs as a detached session in the parent's environment, with its own context window, to completion.
4. Only the child's final message returns to the parent, as the `task` tool's result.

Two consequences the docs call out:

- **The prompt is the entire briefing.** The child never sees the parent's conversation, so parent instructions should tell the model to delegate with complete, self-contained prompts.
- **Tasks parallelize.** Tool calls in one batch execute in parallel, so the model can launch several tasks at once — five independent checks become five concurrent child sessions.

Application code can also delegate: a [harness tool](https://flueframework.com/docs/guide/tools/#harness-tools)'s `harness.prompt(...)` conversation (scoped to the tool call) can delegate to the agent's declared subagents, so you can require a specific delegate by naming it in the instruction instead of leaving the choice to the model.

## What a delegate inherits

Inherits (the parent's **environment**):

- the sandbox and its harness tools (read, write, bash, …);
- workspace context discovered from the working directory (`AGENTS.md`, workspace skills);
- the parent's model and reasoning effort, unless overridden by `model` / `thinkingLevel` on the definition.

Does **not** inherit (anything about the parent's **conversation**): history, instructions, tools, skills, subagents, persistent state, initial data.

Because parent and child share a sandbox, files are the natural hand-off surface — the child writes `report.md`, the parent reads it after the task returns.

## Recommended use cases

- Exploratory work that would flood the parent's context but produces a short answer: research, codebase exploration, log analysis.
- One phase of a workflow needing different instructions, tools or skills than the rest of the conversation.
- Independent pieces of work that can run in parallel, each in its own context window.
- A class of work that should run on a different model or reasoning effort — e.g. routing a per-ticket classification step to a cheaper model.

## When NOT to use one, and what to use instead

- **Deterministic work your application code executes** → use a [tool](https://flueframework.com/docs/guide/tools/). Reach for a tool when the work is a bounded function, not model-driven.
- **The current agent just needs guidance or resources, not isolation** → use a [skill](https://flueframework.com/docs/guide/skills/). A skill adds instructions and resources to the *current* agent.
- **Another party of your system needs to message an agent over time** → register a real agent and [`dispatch()`](https://flueframework.com/docs/guide/building-agents/#dispatch) to it. A subagent has no conversation id, no persistent state and no address.

## Gotchas & constraints

- **Don't export a delegate's agent function** from a `'use agent'` module — every exported capitalized function there is registered as a top-level agent. A delegate agent function has no `useModel()` call, no conversation id and no HTTP surface.
- **Duplicate names throw.** Declaring two delegates with the same name in one render throws.
- **Delegation depth is capped at four levels.** Delegates can declare their own delegates with nested `useSubagent()`.
- **`flue-general` is a framework-reserved name.**
- **Hooks that throw inside a delegate's render:** `useModel()` (the delegate's model comes from its definition), `useSandbox()`, `useMcpConnection()`, `usePersistentState()`, `useDataWriter()`, `useDispatchMessage()`, and all four event hooks (`useAgentStart`, `useAgentFinish`, `useResponseStart`, `useResponseFinish`). `useInitialData()` returns `undefined` instead of throwing; `useDelivery()` returns the parent's task prompt.
- **Hooks that compose normally in a delegate render:** `useTool()`, `useSkill()`, `useInstruction()`, nested `useSubagent()`, custom hooks.
- **Fresh render per task.** Two delegations to the same subagent render independently; closures read current values at delegation time.
- **Conditional declaration is allowed.** Roster changes are narrated to the model as `resources` signals ([Dynamic resources](https://flueframework.com/docs/reference/agent-api/#dynamic-resources)). Resource sets (tools, skills, subagents) are per-render; `useModel` values are submission-scoped.
- **Durability:** child sessions write their own durable records. On recovery, an unresolved `task` call is not settled with a marker — the runtime reattaches to the child's durable transcript and resumes it to completion, recursively (a grandchild resumes first), and several tasks interrupted in one parallel batch all resume before the batch commits.
- **A delegate has no durability configuration of its own** — resumed child work runs inside the parent's attempt, under the parent's retry budget and timeout.
- **A delegate removed or renamed by a redeploy cannot be resumed.** That call settles with an error outcome and the parent continues.
- **Terminal settlement:** when a submission exhausts its budget with a task unresolved, the interrupted marker carries the child's conversation id, so the child's transcript stays inspectable.

## Related

- [Agent Hooks API — `useSubagent`](https://flueframework.com/docs/reference/agent-hooks-api/#usesubagent)
- [Agent API — `SubagentDefinition`, `defineSubagent()`, `GeneralSubagent`, `harness`](https://flueframework.com/docs/reference/agent-api/#subagentdefinition)
- [Agent Hooks guide](https://flueframework.com/docs/guide/agent-hooks/)
- [Tools](https://flueframework.com/docs/guide/tools/) · [Skills](https://flueframework.com/docs/guide/skills/)
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Durability — Delegated tasks](https://flueframework.com/docs/guide/durability/#delegated-tasks)
- [Models — model specifier / reasoning effort](https://flueframework.com/docs/guide/models/#model-specifier)
- [Agents — agent functions, dispatch()](https://flueframework.com/docs/guide/building-agents/#agent-functions)
