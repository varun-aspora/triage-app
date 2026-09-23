# Applying the guidance to Flue

Read this when building agents with `@flue/runtime`. Verify against the
installed version: this describes the surface documented in September 2026.

## The mapping

| Concept in SKILL.md | Flue |
| --- | --- |
| Subagent | `useSubagent({ name, description, agent })` |
| Reusable subagent | `defineSubagent({ ... })`, exported and mounted anywhere, with per-mount overrides |
| Blank delegate | `GeneralSubagent` (reserved name `flue-general`) — no instructions, just the shared environment |
| Delegation call | The framework-owned `task` tool; mounted delegates appear in an "Available Agents" section of the system prompt |
| The delegation brief | The `task` prompt |
| Agent | A `'use agent'` module exporting a function that returns the system instructions |
| Procedure without isolation | `useSkill` |
| Deterministic bounded work | `useTool` |
| Long-lived peer with its own state and history | A separately registered agent |

Delegation is model-driven by default: the parent model reads the delegate
descriptions and calls `task` when it judges the work fits.

When you want *code* to decide — a chain, a router, an evaluate-and-revise
loop — use a `harness: true` tool. Its `harness.prompt(...)` conversation is
scoped to the tool call and can delegate to the agent's declared subagents by
name, so you can require a specific delegate instead of hoping the model picks
it. That's the Flue equivalent of the code-driven patterns in SKILL.md.

Two constraints worth knowing before you design a deep tree: delegation depth
is capped at four levels, and declaring two delegates with the same name in one
render throws.

## What a delegate inherits, and what it doesn't

The line is environment vs conversation.

**Inherits the environment:** the sandbox and its harness tools (read, write,
bash), workspace context discovered from the working directory (`AGENTS.md`,
workspace skills), and the parent's model and reasoning effort unless
overridden by `model` / `thinkingLevel`.

**Inherits nothing from the conversation:** not history, instructions, tools,
skills, subagents, persistent state, or initial data.

The delegate's `agent` function renders fresh at delegation time, in its own
frame, and only the child's final message comes back as the `task` result.
Intermediate reasoning, tool calls, and file reads never reach the parent —
that's the context saving, and it's also why a vague brief fails silently.

This makes the separability test structural rather than advisory. If a brief
needs something from the parent's conversation, it has to be written into the
task prompt or into the delegate's own instructions. There is no third option.

## Where to put what

Two places carry instructions, and mixing them up is the common mistake:

- **The delegate's agent function** holds what's true on every call: role,
  method, output contract, which tools and sources to prefer, when to stop.
  Written once.
- **The task prompt** holds this call's brief: objective, the specific entities
  and findings involved, boundaries against sibling delegates, effort budget.

Anything constant belongs in the agent function. Repeating it in every task
prompt means the parent model has to remember to include it, and eventually it
won't.

The **description** is read by the parent model to decide whether to delegate
at all, so write it like a tool description — what it does, when to use it,
when not to. See
[agent-tool-function-definition](../../agent-tool-function-definition/SKILL.md).

## Files are the handoff surface

Parent and child share a sandbox, which makes pass-by-reference natural: the
child writes its artifact to a path and returns a short summary plus that path.
Use this whenever the output is longer than a few paragraphs. It keeps the
parent's context small and the artifact intact.

## Parallelism, model, and effort

Tasks can run in parallel. The parent won't do this on its own reliably — say
in its instructions that independent delegations should be issued together, and
give it a rough count for each class of request.

Per-mount `model` and `thinkingLevel` overrides are how you spend selectively:
a cheap model for classification, extraction, and summarization; the parent's
stronger model for anything that plans or synthesizes.

## Hook restrictions inside a delegate

**Throw:** `useModel()` (the model comes from the definition or the mount
override), `useSandbox()`, `useMcpConnection()`, `usePersistentState()`,
`useDataWriter()`, `useDispatchMessage()`, and the four event hooks
(`useAgentStart`, `useAgentFinish`, `useResponseStart`, `useResponseFinish`).

**Fail quietly, which is worse:** `useInitialData()` returns `undefined`
rather than throwing, and `useDelivery()` returns the parent's task prompt.
If a delegate is behaving as though it has no input, read the emitted task
prompt before you suspect the model.

**Compose normally:** `useTool()`, `useSkill()`, `useInstruction()`, nested
`useSubagent()`, and custom hooks.

The practical consequence: **a delegate cannot own durable state.** It has no
conversation id, no persistent state, and no address. A workflow that has to
remember things across invocations stays in the parent, or becomes a
registered agent you `dispatch()` to.

## Choosing the primitive

- **Subagent** — exploratory work that burns context and yields a short answer;
  a phase needing different instructions, tools, or skills; independent work
  that can run in parallel; work that should run on a different model or
  reasoning effort.
- **Tool** — a deterministic, bounded function your application code executes.
- **Skill** — the agent needs a procedure, not isolation. If the content should
  always be present, it isn't a skill: import the markdown or use
  `useInstruction(...)`.
- **Registered agent + `dispatch()`** — other parts of the system need to
  message it over time, with persistent state and its own conversation history.

## Housekeeping

Keep a delegate's agent function unexported inside its `'use agent'` module.
Every exported capitalized function in such a module is registered as a
top-level agent, so exporting a delegate makes it both — and a delegate agent
function has no `useModel()` call, no conversation id, and no HTTP surface.

On durability: a child writes its own durable records, and on recovery the
runtime reattaches to the child's transcript and resumes it rather than
settling the `task` call with a marker. But a delegate has no durability
config of its own — resumed child work runs inside the parent's attempt, under
the parent's retry budget and timeout. A delegate removed or renamed by a
redeploy cannot be resumed; that call settles with an error and the parent
continues.

For evals, the Flue harness with `vitest-evals` can assert on tool calls and
run judges. Judge the end state, and record tokens, task-call count, and
latency alongside pass rate — a delegate that improved quality by tripling
spend needs that fact visible.

Sources: [Flue — subagents](https://flueframework.com/docs/guide/subagents/),
[Flue — building agents](https://flueframework.com/docs/guide/building-agents/),
[Flue — skills](https://flueframework.com/docs/guide/skills/)
