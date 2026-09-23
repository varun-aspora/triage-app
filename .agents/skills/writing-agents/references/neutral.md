# Building these patterns outside Flue

Read this when the target is the OpenAI Agents SDK, a harness-level subagent
system like Claude Code's, or a loop you wrote yourself.

## OpenAI Agents SDK (JS/TS and Python)

An `Agent` is `name` + `instructions` + `model` + `tools`, plus optional
`handoffs`, `outputType`, guardrails, and run controls. The pieces that matter
for orchestration:

### Manager vs handoff

| | Manager (agents as tools) | Handoff |
| --- | --- | --- |
| API | `agent.asTool()` in the manager's `tools` | `handoffs: [...]`, plus `handoffDescription` on each target |
| Control | The manager never gives up the conversation; it calls specialists and writes the final answer | The specialist becomes the active agent and owns the rest of the turn |
| Use when | One place should own the output, combine several specialists, or enforce shared guardrails | Routing is the workflow and the specialist should speak to the user with its own prompt and model |

They compose: a triage agent hands off to a specialist, and that specialist
still calls its own agents as tools for bounded subtasks.

If handoff targets return different output types, construct with
`Agent.create(...)` rather than `new Agent(...)`. That lets TypeScript infer
the union of possible `finalOutput` shapes and avoids the runtime warning
behind `handoffOutputTypeWarningEnabled`.

### Code-driven orchestration

There is no special API for this — it's ordinary program structure:

- **Route:** give the classifier an `outputType`, read the parsed result,
  dispatch. `outputType` accepts a Zod schema, a supported Standard Schema
  value, or a raw JSON Schema. Zod and Standard Schema validate locally and
  preserve the inferred type; a raw JSON Schema describes the contract to the
  model but leaves the parsed result `unknown`, so you validate it yourself.
- **Chain:** call agents in sequence, transforming each output into the next
  input.
- **Parallel:** `Promise.all` / `asyncio.gather`.
- **Evaluate-and-revise:** a `while` loop around a producer agent and a judge
  agent, with an iteration cap.

The SDK repo's `examples/agent-patterns` has runnable versions of each.

### Controls worth knowing before you debug something weird

- **Guardrails** run at the edges: `inputGuardrails` on the first user input
  for the chain, `outputGuardrails` on the final output. Putting them on the
  manager gives you one enforcement point instead of one per specialist.
- **Forcing tool use:** `modelSettings.toolChoice` takes `'auto'` (default),
  `'required'`, `'none'`, or a specific tool name. Keep it on `'auto'` for
  deferred / tool-search tools — the model has to decide when to load those.
- **Loop prevention:** after a tool call the SDK resets `toolChoice` to
  `'auto'` (`resetToolChoice`, default `true`). Turning that off with a forced
  tool choice is the standard way to build an infinite loop.
- **`toolUseBehavior`** decides whether a tool result ends the run:
  `'run_llm_again'` (default), `'stop_on_first_tool'`,
  `{ stopAtToolNames: [...] }`, or a predicate. Function tools only — hosted
  tools always return to the model.
- **Dynamic instructions:** `instructions` can be a function of the run context
  returning a string or promise. Use it for per-tenant or per-user variation
  instead of maintaining forked prompts.
- **Context** is a dependency-injection object (`Agent<TContext, TOutput>`)
  passed to `Runner.run()` and forwarded to tools, guardrails, and handoffs.
  It's for db handles, user metadata, and flags — the model doesn't read it, so
  anything the model must know still belongs in the instructions.
- **`clone()` shares arrays.** It does not copy `tools`, `handoffs`,
  `mcpServers`, or the guardrail lists; an omitted list is shared with the
  original, so mutating through either affects both. Pass a fresh array
  (`tools: [...agent.tools, extra]`) when you want independence. Passing
  `undefined` counts as providing the property and starts that list empty.
- **Lifecycle hooks** fire on both `Agent` and `Runner`:  `agent_start`,
  `agent_end`, `agent_handoff`, `agent_tool_start`, `agent_tool_end`. Agent
  hooks are per-instance; Runner hooks cover the whole run, which makes them
  the single place to observe a multi-agent workflow.

## Harness-level subagents (Claude Code and similar)

Subagent types are declared as markdown with frontmatter naming the model,
tool grants, and a description; the parent spawns one with a prompt, the child
runs in its own context, and only its final report returns.

Everything in the brief section of SKILL.md applies literally here: the child
sees the prompt and nothing else. Two additions:

- Grant each subagent type only the tools its job needs. A read-only explorer
  that can't write is a better explorer and a safer one.
- The parent must relay what matters — the child's report isn't shown to the
  user. Instructions like "return a summary the parent can paste" tend to
  produce reports nobody can use; ask for findings, and let the parent write.

## Rolling your own loop

The minimum you need beyond a chat loop:

- A spawn primitive that runs a child to completion and returns only its final
  message.
- Parallel execution and a join.
- A trace of every decision, keyed so you can replay one run.
- Ceilings on turns *and* tool calls, with a defined outcome when hit.
- Somewhere for artifacts to live outside the conversation.

The things people leave out and regret:

- **Failure vs empty.** "The tool errored" and "there's nothing there" must
  look different to the parent, or it retries forever.
- **Cancellation and timeouts that propagate** to children. Otherwise the first
  hung child hangs the run.
- **Checkpoints.** Agents are stateful and long-running, and small failures
  compound. Restarting a twenty-minute run from zero is expensive enough that
  people start disabling safety checks; resume from the failure point instead.
- **Idempotency** for any side effect that could be retried.
- **Context management on long runs.** Summarize completed phases, write the
  essentials somewhere durable, and spawn a fresh child with a handoff note
  rather than truncating history and hoping.

**Start synchronous.** The lead waits for each batch of children to finish
before continuing. It's much easier to reason about, and the cost is real but
tolerable: the lead can't steer children mid-flight, children can't coordinate,
and one slow child blocks everything. Asynchronous execution fixes those and
hands you result coordination and error propagation in exchange. Only pay that
when the blocking is actually hurting.

For deployments, shifting traffic gradually between versions matters more than
usual — an agent can be anywhere in a long run when you ship, and a hard
cutover kills work in flight.

Sources: [OpenAI Agents SDK — agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/),
[OpenAI Agents SDK — agents](https://openai.github.io/openai-agents-js/guides/agents/),
[Anthropic — how we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
