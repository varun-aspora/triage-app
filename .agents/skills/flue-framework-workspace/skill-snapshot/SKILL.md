---
name: flue-framework
description: Working reference for the Flue agent framework (@flue/runtime, @flue/vite, @flue/sdk, @flue/react) — agent functions and the 'use agent' directive, the use* hook family, tools, skills, subagents, MCP, sandboxes, models, HTTP routing, database/persistence, durability and recovery, channels, schedules, evals, observability, and deploying to Node or Cloudflare. Use this whenever the user writes, reviews, debugs, or plans Flue code, or mentions Flue, @flue/*, 'use agent', useModel/useTool/useSandbox/useSubagent/useSkill/useMcpConnection/useFlueAgent, flue.config.ts, db.ts, app.ts routing, createAgentRouter, dispatch(), or a Durable-Object-per-agent deployment. Also use it when the user asks how to do something agent-shaped in this repo — add a tool, delegate work, run an agent on a schedule, put a chat UI on it — without naming Flue, because in a Flue project the right answer is usually a specific Flue primitive rather than hand-rolled code. Consult it before writing Flue code from memory: the API is small but unusual, and guessing hook names or return shapes produces code that fails at build time.
---

# Flue framework

Flue builds LLM agents out of plain functions and React-style hooks, with a durability
contract underneath. This skill carries a per-topic reference set distilled from the official
docs, so you can answer precisely instead of pattern-matching from other agent frameworks —
Flue looks familiar and isn't.

## Mental model

Internalize this before reaching for a reference file. Most wrong answers about Flue come
from importing assumptions from LangChain, the Vercel AI SDK, or React.

- **An agent is a function that returns its system instructions as a string.** Nothing else.
  Capabilities are attached by calling `use*` hooks in the body.
- **`'use agent'` at the top of a module** registers that module's exported capitalized
  functions as agents. Registration makes an agent addressable — it does **not** serve it.
- **Hooks re-run before every model call**, like a React re-render. Unlike React, hooks may be
  added or removed conditionally, and Flue narrates the change to the model so the transcript
  stays coherent. This is the idiomatic way to gate a capability.
- **`useModel()` is the one required hook.** It is a declaration, not a client — no SDK object
  or API key passes through agent code.
- **Nothing is auto-mounted.** `src/app.ts` is the single HTTP entrypoint; every agent, channel
  and route is mounted by hand with `createAgentRouter(Agent)`. No file-based routing.
- **Two targets, and they differ materially.** Node.js (self-starting server, `db.ts` adapter,
  lease-based recovery) and Cloudflare (Worker plus one Durable Object per agent conversation,
  built-in SQLite, `db.ts` rejected at build time).
- **Accepted work is owed a durable outcome.** Every input becomes a *submission* recorded
  before any model work begins; it settles exactly once as `completed`, `failed`, or `aborted`,
  across crashes and redeploys. `dispatch()` resolves at **admission**, not completion.

## Choosing the primitive

This is the decision most Flue questions reduce to. Pick with the distinction, then read that
primitive's reference file for the exact API.

| Need | Reach for | Not |
| --- | --- | --- |
| Model runs *your code* — typed args, typed result | **tool** (`useTool` / `defineTool`) | a skill, which only teaches |
| Reusable *instructions/procedure*, loaded on demand | **skill** (`useSkill`) | a tool; skills execute nothing |
| Focused work in a fresh context, model decides when | **subagent** (`useSubagent`, built-in `task` tool) | a tool; parent only sees the final answer |
| *Your code* drives model work behind one call | **harness tool** (`harness: true`) | a subagent — delegation would be model-driven |
| Tools that already exist on a remote service | **MCP** (`useMcpConnection`) | hand-writing one tool per endpoint |
| Files and shell for the agent | **sandbox** (`useSandbox`) | hand-rolled read/write/bash tools |
| Multi-step work that must survive a crash | **durable tool** (`durable: true`, `step.do`) | a plain tool |
| Inbound events from Slack/GitHub/Stripe | **channel** + `dispatch()` | Flue has no outbound messaging API |
| Recurring runs | **cron on the target** + `dispatch()` | Flue ships no scheduler |
| Driving agents from a script, CI, or an external engine | **`flue run` / `init()` / `@flue/sdk`** | Flue has no workflow engine of its own |
| Forbidding a capability | **don't mount it** | instructing the model not to use it |

## Reference map

Each file is self-contained: what it is, the exact API surface with real signatures and code,
recommended use cases, patterns, when to use / when not to, gotchas, and links to siblings.
Read the one file the question is about, plus any sibling its **Related** section names.
Reading all nineteen is almost never the right move.

### Core — building an agent

| File | Covers | Read when |
| --- | --- | --- |
| `references/guides_building-agents.md` | Agent functions, `'use agent'`, `AgentProps`, `init()` / `start()` / `dispatch()`, the LLM-harness-context framing | Starting any agent, or unsure how an agent gets addressed and run |
| `references/guides_agent-hooks.md` | The whole hook family, the render lifecycle, lifecycle callbacks (`useAgentStart`, `useResponseFinish`, ...), `usePersistentState`, `useDataWriter` | Attaching capabilities, hooking lifecycle, or asking "which hook?" |
| `references/guides_models.md` | `useModel()`, `'provider/model'` ids, thinking level, compaction, `setProvider()`, custom providers | Choosing or configuring a model, tuning reasoning or context |
| `references/guides_project-layout.md` | `src/app.ts`, `src/db.ts`, `src/cloudflare.ts`, `flue.config.ts`, `vite.config.ts`, source-dir resolution, `dist/` | Scaffolding, or deciding where a file belongs |

### Capabilities

| File | Covers | Read when |
| --- | --- | --- |
| `references/guides_tools.md` | `defineTool()`, `useTool()`, `ToolContext`, built-in tools, harness tools, durable tools, conditional tools, access protection | Writing any tool — the richest file, and the one guessing breaks most |
| `references/guides_skills.md` | Agent Skills format, `useSkill`, progressive disclosure, catalog cost | Packaging reusable instructions, or mounting third-party skills |
| `references/guides_subagents.md` | `useSubagent()`, `defineSubagent()`, the `task` tool, context isolation | Delegating focused work |
| `references/guides_mcp.md` | `useMcpConnection()`, discovery, namespacing, authentication, runtime-owned lifecycle | Connecting Linear/Notion/GitHub-style servers |
| `references/guides_sandboxes.md` | `useSandbox()`, just-bash virtual mode, `local()`, remote providers, workspace context, `.agents/skills/` discovery | The agent needs a filesystem or shell |

### Serving and persistence

| File | Covers | Read when |
| --- | --- | --- |
| `references/guides_routing.md` | `createAgentRouter()`, `Fetchable`, mounting agents/channels/custom routes in `app.ts` | Exposing an agent over HTTP |
| `references/guides_database.md` | `db.ts` adapters, canonical conversation streams, accepted submissions, `migrate()`, in-memory default | Node persistence, migrations, or "where does conversation state live?" |
| `references/advanced_durability.md` | The accepted-work contract, `durability` static (`maxAttempts`, `timeoutMs`), `step.do`, recovery, per-target behavior | Anything about crashes, retries, timeouts, at-most-once effects |
| `references/advanced_deploy.md` | `flue()` Vite plugin, `vite build`, Node artifact, Cloudflare Worker + Durable Objects, `wrangler.jsonc` migrations | Building or shipping |

### Driving and operating

| File | Covers | Read when |
| --- | --- | --- |
| `references/advanced_workflows.md` | `flue run`, `start()` + `init()` scripts, `@flue/sdk` HTTP client, external durable engines | Running agents from CI, scripts, or Temporal/Inngest/CF Workflows |
| `references/advanced_schedules.md` | croner on Node, Worker Cron Triggers, external schedulers, `kind: 'signal'` messages, conversation-id strategy | Anything recurring |
| `references/advanced_channels.md` | Verified provider webhooks, `channel.route()`, `useDelivery()`, idempotency, inbound-only design | Slack/GitHub/Stripe ingress |
| `references/advanced_observability.md` | `observe()`, the event vocabulary, token usage, `instrument()` adapters (Sentry, Braintrust, OTel, Cloudflare), content protection | Telemetry, metering, debugging what the agent did |
| `references/advanced_evals.md` | Vitest against live models, in-process vs HTTP harnesses, `vitest-evals` judges, asserting on behavior not strings | Testing agent behavior |

### Frontend

| File | Covers | Read when |
| --- | --- | --- |
| `references/frontend_react.md` | `useFlueAgent()`, conversation-by-URL addressing, `sendMessage`/`refresh`, status states, custom auth clients | Building a chat UI |

## Rules that bite

These come up repeatedly and fail at build or runtime rather than degrading gracefully.

- `useModel()` is required. An agent without it doesn't run.
- A tool's `input` must be a **top-level Valibot object schema** — anything else throws.
- A tool's `run` must return the result **envelope**. Bare objects, arrays, numbers, booleans
  and `null` throw.
- The tool `description` is the model's only documentation. Vague descriptions are the top
  cause of a tool being misused or ignored — this is a correctness issue, not polish.
- The agent function must return **synchronously**. No async agent bodies, no re-entrant renders.
- `db.ts` is Node-only. Its presence is a **build-time error** on the Cloudflare target.
- `dispatch()` resolves at durable admission. Awaiting it does not mean the agent replied —
  use the SDK's `wait()` or an awaited `init().read(...)` for the settled outcome.
- Channels are **inbound only**. Outbound messaging is your application's job, against the
  provider's own SDK, ideally wrapped as a narrow tool that binds credential and destination.
- Don't wrap MCP-adapted tool definitions in `defineTool()`.
- Persisted state has atomicity rules — check `advanced_durability.md` before assuming a write
  survives a crash mid-turn.

## Where the docs contradict themselves

The reference files are faithful to the published docs, and the docs disagree with themselves
in four places. When any of these decides the answer, say so and verify against the installed
package's types rather than asserting one side.

1. **`durability.timeoutMs` enforcement** — the durability guide says the deadline fires the
   attempt's abort signal *preemptively*; the Agent API reference says it is checked
   *cooperatively* between turns, so a hung provider call can outlive it. Changes how you write
   a long-running tool.
2. **`thinkingLevel`** — the models guide lists `'max'`; the hooks reference's `ThinkingLevel`
   type omits it.
3. **Cloudflare Vite plugin** — the deploy page shows bare `cloudflare()`; the configuration
   reference says that is a config-resolution error and requires
   `cloudflare({ config: flueWorkerConfig() })`.
4. **Eval env var** — the evals guide uses `FLUE_AGENT_URL` (full mount URL); the vitest-evals
   ecosystem page uses `FLUE_BASE_URL` (base URL), for the same generated setup.

Also undocumented upstream: `dispatch()`'s `idempotencyKey` appears on the channels page but
not in the `AgentDispatchRequest` interface, and the `task` tool's full parameter schema isn't
published anywhere.

## Using this skill well

Answer from the reference file, not from memory of similar frameworks. When a question spans
primitives ("should this be a tool or a subagent?"), the decision table above usually settles
it, and the two candidate files' *when not to use* sections confirm it.

If the installed `@flue/*` packages disagree with a reference file, the packages win — these
notes were distilled from flueframework.com/docs (guides, advanced, and frontend sections) on
2026-09-17 and the framework moves. Say which source you used when it matters.
