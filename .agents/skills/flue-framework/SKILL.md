---
name: flue-framework
description: Working reference for the Flue agent framework (@flue/runtime, @flue/vite, @flue/sdk, @flue/react, @flue/cli) — agent functions and the 'use agent' directive, the use* hook family, tools, skills, subagents, MCP, sandboxes, models, HTTP routing, database/persistence, durability and recovery, channels, schedules, evals, observability, deploying to Node or Cloudflare, the `flue` CLI (init/run/add/update/docs), the Agent SDK for driving agents from external code, and the ecosystem of third-party adapters (channel providers like Slack/Stripe/Discord/Twilio/WhatsApp, databases like Postgres/MongoDB/Redis/Turso, sandbox providers like E2B/Modal/Daytona/Vercel, deploy targets like AWS/Fly/Railway/Docker/GitHub Actions/GitLab CI, and tooling like Sentry/OpenTelemetry/Braintrust). Use this whenever the user writes, reviews, debugs, or plans Flue code, or mentions Flue, @flue/*, 'use agent', useModel/useTool/useSandbox/useSubagent/useSkill/useMcpConnection/useFlueAgent, flue.config.ts, db.ts, app.ts routing, createAgentRouter, dispatch(), a Durable-Object-per-agent deployment, the `flue` CLI, or wiring up any of the ecosystem integrations above. Also use it when the user asks how to do something agent-shaped in this repo — add a tool, delegate work, run an agent on a schedule, put a chat UI on it, receive a webhook, pick a sandbox or database — without naming Flue, because in a Flue project the right answer is usually a specific Flue primitive or adapter rather than hand-rolled code. Consult it before writing Flue code from memory: the API is small but unusual, and guessing hook names or return shapes produces code that fails at build time.
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
Reading more than two or three files for one question is almost never the right move — this
corpus is intentionally wide (~95 files, one per doc page) so a single lookup stays narrow.

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

### Introduction

| File | Covers | Read when |
| --- | --- | --- |
| `references/introduction_getting-started.md` | Scaffolding via `flue init`, or building the first agent by hand | Starting a brand-new Flue project |
| `references/introduction_why-flue.md` | The framework's own case for itself — what problem it solves and how | Explaining or evaluating Flue conceptually |
| `references/introduction_migration.md` | Upgrading from Flue 1.0.0-beta.x to 2.0.0 — build, routing, agents, tools, workflows, SDK, deployment | Working in a project still on the 1.x beta line |
| `references/introduction_changelog.md` | How to research version-specific behavior for the installed `2.0.8` — not a copy of the changelog | A behavior seems version-dependent, or generated code disagrees with what's installed |

### CLI

| File | Covers | Read when |
| --- | --- | --- |
| `references/cli_overview.md` | The `flue` command catalog, global flags, exit codes | Any `flue` invocation question |
| `references/cli_init.md` | `flue init` — scaffolding a new project, interactive or flagged | Starting a project, or unsure what `init` generates |
| `references/cli_run.md` | `flue run` — running one agent module locally, transport-free | Running an agent from a script or CI without HTTP |
| `references/cli_add.md` | `flue add` — fetching a blueprint implementation guide for a channel/database/sandbox/tooling integration | Wiring up a new ecosystem integration |
| `references/cli_update.md` | `flue update` — refreshing an existing integration's blueprint to the current version | Bringing an already-integrated adapter up to date |
| `references/cli_docs.md` | `flue docs` — browsing/searching the docs bundled with the installed CLI | Looking up any Flue doc page, version-pinned to what's actually installed (`bunx flue docs read <path>` is the most authoritative source available — prefer it over the public website) |

### Agent SDK (`@flue/sdk`)

| File | Covers | Read when |
| --- | --- | --- |
| `references/sdk_overview.md` | Installing `@flue/sdk`, a minimal round trip, the HTTP surface it wraps | Driving a Flue agent from an external Node/browser client |
| `references/sdk_create-flue-client.md` | `createFlueClient()` — URL semantics, fetch override, headers, token | Constructing the SDK client |
| `references/sdk_flue-client.md` | `FlueClient` — `send()`, `read()`, `wait()`, `abort()`, `history()`, `observe()`, `attachmentUrl()` | Calling into a conversation from client code |
| `references/sdk_events.md` | SDK event/conversation types and how they map to the reference event vocabulary | Consuming the SDK's event stream |
| `references/sdk_errors.md` | SDK error classes, the HTTP error envelope, discriminating failures | Handling or classifying an SDK-thrown error |

### Formal API reference (`reference/`)

These are the framework's dense, formal contracts — read one when a guide's informal
explanation isn't precise enough, or when writing code against a surface a guide doesn't fully
specify.

| File | Covers | Read when |
| --- | --- | --- |
| `references/reference_agent-api.md` | The full agent module contract: agent functions/statics, `dispatch()`, `init()`, `AgentInstanceHandle`, `start()`, `createAgentRouter()`, the harness, `defineTool`/`defineSkill`/`defineSubagent`/`defineMcpConnection` | Needing the exact, complete agent-level API surface |
| `references/reference_agent-hooks-api.md` | Every hook callable during a render, and the render/rules-of-hooks contract | The precise signature or scoping rule for any `use*` hook |
| `references/reference_agent-behavior.md` | Default tools, environment, message handling, context rules, and limits an agent runs under | What an agent does with nothing configured |
| `references/reference_configuration.md` | `flue.config.ts`, the `flue()` Vite plugin, `flueWorkerConfig()`, target detection, how `vite dev`/`build`/`preview`/`flue run` each resolve it | Any question about how the project is wired at the build level |
| `references/reference_data-persistence-api.md` | The persistence adapter contract for a custom `db.ts` | Implementing or reviewing a Node persistence adapter |
| `references/reference_errors.md` | The full `FlueError` hierarchy, stable error codes, the HTTP error envelope | Handling, classifying, or debugging a thrown Flue error |
| `references/reference_events.md` | The runtime event vocabulary, `observe()`/`instrument()` contracts | Building an observability integration |
| `references/reference_provider-api.md` | `providers` config, `setProvider()`, model resolution, the Cloudflare AI binding provider | Registering or resolving a custom model provider |
| `references/reference_sandbox-api.md` | The contract for building a sandbox adapter | Writing a custom `SandboxFactory` |
| `references/reference_streaming-protocol.md` | The HTTP wire protocol for agent conversation reads/writes | Implementing a client against the raw protocol |

### Ecosystem — third-party integrations

Each file documents Flue's adapter for one real external service: what it does, recommended
patterns, how to wire it up, and provider-specific gotchas (often researched from the
provider's own docs, not just Flue's — e.g. exact webhook signature schemes and retry windows).
Pick the file for the exact provider in question; don't read the whole category.

| Files | Covers | Read when |
| --- | --- | --- |
| `references/ecosystem_overview.md` | The ecosystem catalog itself, and `flue add`/`flue update`'s blueprint model | Orienting before picking a specific integration |
| `references/ecosystem_channels-{provider}.md` — discord, github, google-chat, intercom, linear, messenger, notion, resend, salesforce-marketing-cloud, shopify, slack, stripe, teams, telegram, twilio, whatsapp, zendesk | Inbound webhook adapter for that provider — signature verification, retries/idempotency, `channel.route()` wiring | Receiving events from that specific provider |
| `references/ecosystem_databases-{engine}.md` — libsql, mongodb, mysql, postgres, redis, supabase, turso, valkey | `db.ts` adapter for that engine — connection setup, operational gotchas under Flue's persistence contract | Choosing or wiring up production persistence on Node |
| `references/ecosystem_deploy-{target}.md` — aws, cloudflare, docker, fly, github-actions, gitlab-ci, node, railway, render, sst | Deploying a built Flue app to that platform, or running `flue run`/evals in that CI system | Shipping to, or building a pipeline against, that specific platform |
| `references/ecosystem_sandboxes-{provider}.md` — boxd, cloudflare, cloudflare-computer, daytona, e2b, exedev, islo, mirage, modal, vercel | Wiring that provider as a `useSandbox()` `SandboxFactory` — cold start, persistence, cancellation, pricing | Choosing or configuring a specific sandbox provider |
| `references/ecosystem_tooling-{tool}.md` — braintrust, jetty, opentelemetry, sentry, vitest-evals | Wiring that tool's `instrument()` adapter or eval harness | Adding that specific observability or eval tool |

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
in a few places. Where this corpus could verify against the installed package's actual types and
source (`node_modules/@flue/*`), it resolved the contradiction and says so inline; where it
couldn't, it still flags both sides rather than picking one silently.

1. **`durability.timeoutMs` enforcement** — still open. The durability guide says the deadline
   fires the attempt's abort signal *preemptively*; the Agent API reference says it is checked
   *cooperatively* between turns, so a hung provider call can outlive it. Changes how you write
   a long-running tool — verify against behavior, not either doc, if it matters for your case.
2. **`thinkingLevel`** — resolved. `'max'` is real (verified directly against the installed
   `ThinkingLevel` type, re-exported from `@earendil-works/pi-agent-core` through
   `@flue/runtime`). `references/guides_models.md` and `references/reference_agent-hooks-api.md`
   both carry the corrected union; if you see a copy elsewhere that omits `'max'`, that copy is
   stale.
3. **Cloudflare Vite plugin** — still open. The deploy page shows bare `cloudflare()`; the
   configuration reference says that is a config-resolution error and requires
   `cloudflare({ config: flueWorkerConfig() })`. `references/advanced_deploy.md` and
   `references/reference_configuration.md` both document the working form.
4. **Eval env var** — still open. The evals guide uses `FLUE_AGENT_URL` (full mount URL); the
   vitest-evals ecosystem page uses `FLUE_BASE_URL` (base URL), for the same generated setup.
5. **`dispatch()`'s `idempotencyKey`** — resolved. It's real and enforced (verified directly in
   the installed runtime's `dispatch-*.mjs`) on both `dispatch()` and the raw HTTP `POST` body,
   even though the published `reference/agent-api` page's own `AgentDispatchRequest` listing and
   `@flue/sdk`'s typed `AgentPromptOptions` both omit the field. `references/reference_agent-api.md`
   and `references/guides_building-agents.md` both carry the corrected interface.

Also undocumented upstream: the `task` tool's full parameter schema isn't published anywhere.

## Using this skill well

Answer from the reference file, not from memory of similar frameworks. When a question spans
primitives ("should this be a tool or a subagent?"), the decision table above usually settles
it, and the two candidate files' *when not to use* sections confirm it.

If the installed `@flue/*` packages disagree with a reference file, the packages win — these
notes were distilled from flueframework.com/docs (guides, advanced, and frontend sections) on
2026-09-17 and the framework moves. Say which source you used when it matters.
