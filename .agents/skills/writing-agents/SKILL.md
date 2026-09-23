---
name: writing-agents
description: "Design and write LLM agents and multi-agent systems: one agent vs many, choosing an orchestration pattern (manager/agents-as-tools, handoffs, code-driven chains, parallel fan-out, evaluator loops), and writing the instructions, delegation briefs, and evals that make them work. Use whenever building, reviewing, or debugging an agent, subagent, or orchestrator — including 'should this be a subagent?', an agent that is slow or burns tokens, subagents duplicating each other or returning unusable results, an orchestrator that over- or under-delegates, or a prompt that keeps needing another rule bolted on. Applies to Flue, OpenAI Agents SDK, Claude Agent SDK, and hand-rolled loops."
---

# Writing agents

An agent is a model in a loop with instructions, tools, and somewhere to
delegate. Most agent failures are not model failures. They are an orchestration
shape that doesn't match the work, a task boundary nobody drew, or a briefing
the child couldn't act on.

Two things carry almost all the weight: **the topology** (who runs, in what
order, decided by whom) and **the briefs** (what each agent is told). Tool
design is the third leg — that's [agent-tool-function-definition](../agent-tool-function-definition/SKILL.md).

Build the smallest thing that works, in this order:

1. One agent with good tools.
2. One agent with the deterministic parts moved into code.
3. Several agents.

Each step buys capability and costs tokens, latency, and debuggability. Agents
use roughly 4× the tokens of a chat turn; multi-agent systems roughly 15×. On
research-style benchmarks token usage alone explained about 80% of performance
variance, and token usage plus tool calls plus model choice explained 95%. That
is the argument *for* multi-agent on work that genuinely parallelizes, and the
argument against it everywhere else.

Framework specifics live in two references. Read the one that matches the
target: [references/flue.md](references/flue.md) for Flue's `useSubagent` /
`task` model, or [references/neutral.md](references/neutral.md) for the OpenAI
Agents SDK, Claude Agent SDK, and hand-rolled loops.

## One agent or many?

Split when at least one of these is true:

- **Breadth.** Independent directions can be explored at once and the parent
  only needs the conclusions, not the search.
- **Context economics.** The work burns a lot of context to produce a short
  answer — trawling logs, reading a codebase, surveying sources. A fresh window
  does the reading; the parent gets the paragraph.
- **Different posture.** A phase needs different instructions, tools, model, or
  reasoning effort than the rest of the run.
- **Contamination.** You want the work done without the parent's earlier turns
  biasing it — a reviewer that hasn't seen the author's reasoning finds more.

Keep it in one agent when:

- Steps are tightly sequential and each needs the previous step's full detail.
  The handoff loses more than the parallelism gains.
- The work needs shared mutable state across steps.
- The flow is deterministic. That's code, or one workflow-level tool.

**The separability test:** write the child's brief right now, without
referring to the parent's conversation. If you can't do it without "as
discussed above" or "the thing we found earlier", the work isn't separable yet.
Either pull that context into the brief or keep the work in one agent.

## Who decides: the model or your code?

| | Model-driven | Code-driven |
| --- | --- | --- |
| Decides next step | The LLM, via tools and handoffs | Your program |
| Good for | Open-ended, path-dependent work where the steps aren't knowable up front | Known steps, where predictable cost, latency, and testability matter |
| Costs | Non-deterministic, harder to test, variable spend | Can't adapt to anything you didn't anticipate |

This is not a either/or. The usual right answer is code deciding the phases and
the model deciding within a phase: a fixed research → draft → review pipeline,
where the research phase freely picks its own sources and tool calls.

### Pattern catalogue

| Pattern | Shape | Reach for it when |
| --- | --- | --- |
| **Chain** | Code runs agents in sequence, each output feeding the next | The decomposition is stable: research → outline → draft → critique → revise |
| **Route** | One agent classifies into a structured output; code picks the next agent | A small, known set of destinations, and you want the routing testable |
| **Parallel fan-out** | Code launches N agents at once, then joins | Independent subtasks; also N attempts at one task to pick the best |
| **Evaluate-and-revise** | Producer runs, judge scores, loop until it passes | Quality is checkable against criteria you can write down |
| **Manager (agents as tools)** | One agent stays in charge and calls specialists as tools | The manager should own the final answer, combine several specialists, or enforce guardrails in one place |
| **Handoff** | A triage agent transfers the conversation; the specialist takes over | Routing *is* the workflow, and the specialist should talk to the user directly with its own prompt and model |
| **Orchestrator + subagents** | A lead agent decides how many children to spawn and what each explores | Breadth is unknown up front and depends on what the lead finds |

Manager vs handoff comes down to one question: **who produces the final
answer?** If the parent must synthesize, use a manager. If the specialist
should speak for itself, hand off. They compose — a specialist reached by
handoff can still call its own agents as tools.

Evaluate-and-revise loops need a hard iteration cap and a defined fallback for
"never passed". Without one you've built a way to spend money.

## Scale the effort to the task

Orchestrators left to their own judgment over-delegate trivial lookups and
under-delegate hard research. Put the budget in the prompt as explicit rules:

- Simple fact-finding: no subagent, 3–10 tool calls.
- Direct comparison: 2–4 subagents, ~10–15 calls each.
- Open-ended research: 10+ subagents with clearly divided responsibilities.

Tune the numbers to your domain, but state them. A rule the orchestrator can
apply beats an instruction to "use good judgment".

## Writing the instructions

### Any agent

- **One job, stated first.** A specialist that does one thing well beats a
  generalist told to be good at everything. If the instructions have an "also,
  if the user asks about X" clause, X is probably a different agent.
- **Say what "done" looks like**, and what to return. An agent with no
  stopping condition either quits early or grinds.
- **Say what to do when things fail.** Tool errors, empty results, ambiguous
  input. The default — halt or hallucinate — is rarely what you want. Adapt,
  then report what couldn't be gotten.
- **Give heuristics, not scripts.** Rigid step lists break on the first input
  that doesn't fit. Explain *why* a step matters and the model generalizes.
- **Simulate before you ship.** Run the prompt and read the trace step by step.
  Most bad agent prompts are obvious once you watch where the model hesitates.

### Orchestrators

- Plan before delegating. Extended/interleaved thinking is worth the tokens
  here: which tools fit, how many children, what each covers.
- Spawn parallel children in one go, not one at a time. Firing 3–5 subagents
  simultaneously, and having each call several tools in parallel, has cut
  research wall-clock by up to 90%.
- Don't delegate what you can already answer. Delegation has a fixed cost.
- Handle partial results: what to do when one child fails, returns nothing, or
  contradicts another.
- Synthesize, don't concatenate. Say that explicitly — the default failure mode
  is stapling the children's outputs together.

### Subagents

- **Start wide, then narrow.** Models default to an over-specific first query
  and find nothing. Search broadly, see what exists, then focus.
- **Think between tool calls.** After each result: is this good, what's
  missing, what's the next query? This is where quality comes from.
- **Prefer specialized tools over generic ones** when both could work, and say
  which sources are authoritative. Left alone, agents pick well-ranked
  content farms over primary sources.
- **Return the answer, not the journey.** State the shape you want back.

## The delegation brief

This is the highest-leverage text in a multi-agent system. `"research the
semiconductor shortage"` is what produces duplicated work, gaps, and three
subagents writing the same paragraph.

Because the child usually cannot see the parent's conversation, **the brief is
the entire context.** Write it for a contractor who just walked in. Every brief
carries:

1. **Objective** — the specific question being answered.
2. **Output format** — shape and length the parent will consume.
3. **Sources and tools** — which to use, which to prefer, which to avoid.
4. **Boundaries** — what's out of scope, and which sibling covers it.
5. **Effort budget** — roughly how many tool calls this deserves.

Boundaries matter as much as objectives. Parallel children with fuzzy edges
overlap in the middle and leave holes at the seams. Decompose by question, not
by topic: "what did revenue do in FY24" is separable, "look into the finances"
is not.

## Pass artifacts by reference

Funnelling every child's full output through the orchestrator's context is a
game of telephone with a token bill attached. Have children write their work to
a shared filesystem or store and return a short summary plus a pointer. The
orchestrator reads what it needs. Fidelity survives, the parent's context
doesn't blow up, and the artifact outlives the run.

Structured output is the other half of this: if code is going to route,
filter, or branch on a result, make it a validated schema, not prose you parse
with a regex.

## Choose models per role

Spend on the orchestrator, save on the children. Planning and synthesis need
the strong model; bounded extraction, classification, and summarization usually
don't. A strong lead with cheaper subagents beat a single instance of the same
strong model by 90.2% on Anthropic's internal research eval. In the same work,
upgrading the model produced bigger gains than doubling the token budget — try
that before you add agents.

## Evaluate from the first version

- **Start small and immediately.** ~20 queries covering real usage is enough to
  see whether a prompt change helped. Early iterations on a new agent commonly
  move success rates from ~30% to ~80%; you don't need a large suite to catch
  that.
- **Judge the end state, not the path.** Identical runs take different routes.
  Ask whether the final state is correct; for long workflows, check a few
  discrete checkpoints rather than every step.
- **LLM-as-judge: one call, one rubric.** Score 0.0–1.0 plus pass/fail against
  criteria like factual accuracy, completeness, source quality, citation
  accuracy, and tool efficiency. A single call with a single prompt tracked
  human judgement better than more elaborate grading setups.
- **Keep a human in the loop.** Manual runs find what the rubric didn't think
  to ask — hallucinated specifics, a consistent bias toward bad sources.
- **Let the model fix its own prompt.** Give an agent its instructions and a
  set of failing traces and ask what's wrong. An agent that rewrote tool
  descriptions this way cut task completion time by 40% for later agents.

Measure tokens, tool calls, and latency alongside success. An agent that got
better by spending 3× more may not be an improvement.

## Checklist

- [ ] A single agent was tried, or there's a stated reason it can't work
- [ ] Every split passes the separability test
- [ ] Deterministic steps live in code, not in the model's judgment
- [ ] The pattern matches who owns the final answer (manager vs handoff)
- [ ] Effort budget is written as rules, not left to judgment
- [ ] Each brief has objective, format, sources, boundaries, budget
- [ ] Sibling briefs don't overlap and leave no gap between them
- [ ] Every loop has an iteration cap and a fallback
- [ ] Failure and empty-result behaviour is specified, per agent
- [ ] Large outputs pass by reference; code reads schemas, not prose
- [ ] Orchestrator and children are on appropriately different models
- [ ] ~20 real eval cases exist, judged on end state, with token/latency tracked

Sources: [Anthropic — how we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system),
[OpenAI Agents SDK — agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/),
[OpenAI Agents SDK — composition patterns](https://openai.github.io/openai-agents-js/guides/agents/#composition-patterns),
[Flue — subagents](https://flueframework.com/docs/guide/subagents/)
