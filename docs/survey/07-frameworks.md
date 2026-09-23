# Candidate frameworks already in /Users/varun/code/work/triage-app (Flue vs pi-ai / pi-agent-core / pi coding-agent)

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## Scope and state of the repo

Paths below are relative to /Users/varun/code/work/triage-app. Nothing was installed or run.

- FACT: The repo is still an empty `bun init` project. `index.ts` is `console.log("Hello via Bun!")`, and `README.md` is the bun boilerplate.
- FACT: `package.json` declares these dependencies: `@earendil-works/pi-ai` 0.83.0, `@flue/cli` ^2.0.8 and `@flue/runtime` ^2.0.8. Dev dependency: `@types/bun`. Peer dependency: `typescript ^7`. Installed versions: `@flue/{cli,runtime,vite}` 2.0.8, `@earendil-works/{pi-ai,pi-agent-core}` 0.83.0. `@flue/sdk`, `@flue/slack` and `@earendil-works/pi-coding-agent` are NOT installed (checked `ls node_modules/@flue`, `ls node_modules/@earendil-works`).
- FACT: `AGENTS.md` says only "Use Bun instead of Node.js, npm, pnpm, or vite", pointing at `.agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md`. That rule says: use `bun test` not vitest, `Bun.serve()` not express, "Don't use `vite`", and "Bun automatically loads .env, so don't use dotenv".
- FACT: `.claude/skills` is a symlink to `../.agents/skills`. `.cursor/rules/use-bun-...mdc` is a BROKEN symlink: its relative target `.agents/rules/...` resolves inside `.cursor/rules/`.
- FACT: `.agents/skills/` holds: agent-tool-function-definition, flue-framework, flue-framework-workspace, writing-agents, writing-evals, writing-pi-extensions.
- FACT: `flue-framework-workspace/SKILL.md` does NOT exist. The only file is `flue-framework-workspace/skill-snapshot/SKILL.md`, 156 lines, an older copy of `flue-framework/SKILL.md` (230 lines). The two files differ.
- FACT: `tmp/flue/*.md` are distilled copies of flueframework.com docs, captured 2026-09-17 (`flue-framework/SKILL.md` L224-230, `tmp/flue/tools/README.md` L3).

## Layering: how Flue and pi relate

- FACT: `node_modules/@flue/runtime/package.json` depends on `@earendil-works/pi-agent-core` ^0.83.0, `@earendil-works/pi-ai` ^0.83.0, `hono`, `@hono/node-server`, `@modelcontextprotocol/client` 2.0.0 and `valibot`.
- FACT: Flue builds its turn loop on pi-agent-core's `Agent` class: `runtime/dist/conversation-stream-store-C6cHMN0p.mjs` L11 (`import { Agent } from "@earendil-works/pi-agent-core"`) and L2184-2197 (`new Agent({... toolExecution: "parallel", steeringMode: "all" ...})`).
- FACT: `writing-pi-extensions/SKILL.md` L33-38: "Flue reuses pi's model and agent-core layers but has no `pi.on()` / `pi.registerTool()` extension host."

So there are three Pi layers to keep apart:

1. **pi-ai** is a model adapter only. `pi-ai/README.md` L1-3: "Unified LLM API with provider collections, automatic auth resolution, token and cost tracking". It also ships a small `pi-ai` CLI for `login`/`list` (L1523-1533). It has no agent loop.
2. **pi-agent-core** is a single-process stateful agent loop with tool execution and events (`pi-agent-core/README.md` L1-3). It has no HTTP, durability, subagents or skills. SQLite sessions live in a separate package, `@earendil-works/pi-storage-sqlite-node` (L11-13), which is not installed.
3. **pi coding-agent** (`@earendil-works/pi-coding-agent`, which is what "pi" usually means) is the full CLI coding agent with an extension host. It is NOT installed. It is known here only through the `writing-pi-extensions` skill.

"pi-core", as the user wrote it, most plausibly means pi-agent-core. That is an INFERENCE; see Unknowns.

## Flue

### (1) What it is
FACT: Flue is a full agent runtime and application framework. Agents are synchronous functions that return a system prompt and attach capabilities through `use*` hooks that re-render before every model call (`tmp/flue/guides_building-agents.md` L11-28, `guides_agent-hooks.md` L13). On top of that it provides durability, HTTP routing, channels, a CLI and a Vite build.

### (2) Tools, subagents, hooks, skills, MCP and models

**Tools**
- `defineTool({name, description, input: <top-level Valibot object>, output?, harness?, durable?, run})` mounted with `useTool` (`guides_tools.md` L28-60).
- Input is validated before `run`. A failure goes back to the model as `ToolInputValidationError` (L168-170).
- The docs say "A tool's arguments are model-selected inputs, **not** an authorization boundary". Trusted code should bind credentials and destinations in a closure (L342-380).
- Conditional mounting (`if (approved) useTool(x)`) is the documented gate: "An unmounted tool can't be called" (L301-337). The same point appears in `SKILL.md` L52: "Forbidding a capability → don't mount it".

**Pre/post tool-call gating (critical)**
- FACT: Flue has no public before- or after-tool-call hook that can inspect arguments. The hook list (`guides_agent-hooks.md` L19-61) has only `useAgentStart/Finish` and `useResponseStart/Finish` lifecycle hooks.
- FACT: pi-agent-core does support `beforeToolCall` (can return `{block:true, reason}`) and `afterToolCall` (`pi-agent-core/README.md` L207-222). But `grep beforeToolCall node_modules/@flue/runtime/dist` returns nothing, and Flue's `new Agent({...})` at L2184 passes neither.
- FACT: Flue does have a global `instrument({ interceptor })` (`advanced_observability.md` L219-243). The operation passed to it is `{type:'tool', toolCallId, toolName}` only, with no args (`dist/conversation-stream-store-*.mjs` L3309-3313). The context has only IDs (`dist/observation-Bi5tisZp.d.mts` `FlueExecutionContext`).
- INFERENCE: The interceptor can refuse a call by tool name (throw instead of calling `next`), but it cannot gate by HTTP method or SQL text, and the docs present it for tracing only.
- Consequence for triage: the GET-only and SELECT-only rules must be enforced INSIDE each tool's `run`, through a shared guard module (method check plus `resources/{entity}.allow.api.json` lookup, and a SQL parser/validator). Any generic `bash` tool must also be kept off the model.

**Sandbox risk**
- FACT: `useSandbox(local())` mounts built-in `read/write/edit/bash/grep/glob` tools (`guides_tools.md` L198-214).
- FACT: `local()` "is not an isolation boundary" (`guides_sandboxes.md` L348).
- A sandbox adapter's `tools` factory replaces the whole default six-tool set (L354, `SandboxToolFactory` L125). That is the lever for exposing read-only file tools over `repos/` without `bash`.
- The virtual sandbox has no network by default, allowlisted with `network.allowedUrlPrefixes` (L183-191, L347).

**Subagents**
- `useSubagent({name, description, agent, model?, thinkingLevel?})`, invoked by the model through the built-in `task` tool. Only the child's final message returns to the parent (`guides_subagents.md` L29-43, L165-175).
- Per-subagent `model` override is documented for "routing a per-ticket classification step to a cheaper model" (L151-163, L196).
- Delegation depth is capped at 4. `useModel`, `useSandbox`, `useMcpConnection`, `usePersistentState` and the event hooks throw inside a delegate (L208-211).
- Children inherit the sandbox (L181-189).
- Tasks in one batch run in parallel (L175). That fits a per-entity fan-out (ATSPL/SSFB/RTL).
- Code-driven model work: a `harness: true` tool can use `harness.prompt(text, {result: ValibotSchema, model, thinkingLevel})` (`guides_tools.md` L100-121, L216-254). That suits a deterministic classifier with typed output.

**Skills**
- `import x from './skills/foo/SKILL.md'` plus `useSkill`, or `defineSkill` (`guides_skills.md` L58-117).
- With a sandbox, `.agents/skills/` in the cwd is auto-discovered (L174-188).

**MCP**
- Client only: `useMcpConnection({name, url, transport?: 'streamable-http'|'sse', auth, headers, tools?: [allowlist], optional?})`, mounted as `mcp__<server>__<tool>` (`guides_mcp.md` L32-59, L133-141).
- FACT: `type McpTransport = 'streamable-http' | 'sse'` in the dist types. There is no stdio transport.
- `createMcpConnection` returns `ToolDefinition`s that app code can filter or wrap (L166-178). INFERENCE: wrapping a returned definition's `run` would be the way to gate MCP tool args.
- UNKNOWN: whether Flue can expose an agent AS an MCP server. It is not documented in any file read.

**Models**
- `useModel('provider/model', {thinkingLevel, compaction})`, exactly once per render. The model is chosen at submission scope, so a change "takes effect on the next submission" (`guides_models.md` L17-33, L311).
- There is no per-message model parameter on dispatch or HTTP (L303).
- The built-in provider set comes from Pi and includes anthropic, openai, openrouter, groq, bedrock and more (L56).
- Ollama goes through `setProvider(createProvider({id:'ollama', ... api: openAICompletionsApi()}))`, which requires `@earendil-works/pi-ai` as a direct dependency (L114-122, L196-229). That explains why pi-ai is in `package.json`.
- Gotcha: "`flue run` ignores `app.ts`", so `setProvider` has to live in the agent module for the CLI path (L313).
- Credentials come from provider env vars. `flue run` loads `.env` or `--env <path>`; a built server does not load `.env` (L180-194, `advanced_deploy.md` L67).

### (3) HTTP, CLI and Slack
- **HTTP:** mounting is explicit in `src/app.ts` through `app.route('/agents/x', createAgentRouter(Agent))`, using Hono. Routes: `POST /:id` (202 admission, returns `{streamUrl, offset, submissionId}`), `GET /:id` (snapshot, updates or SSE), `POST /:id/abort` (`guides_routing.md` L31-104). There is no built-in auth and no send-and-wait route (L242, L249-251). Callers use `@flue/sdk` `send()` plus `wait()` (L106-121).
- **CLI:** `flue run <path> --message --id --data <json> --env <path> --json`. Exit codes are 0/1/130. Only the reply goes to stdout; with `--json` the output is `{id, agent, submissionId, outcome, message, uid}` (`advanced_workflows.md` L26-36).
- In-process driving: `start({agents, db})` plus `init(Agent).dispatch()/read()` (`guides_building-agents.md` L187-209).
- **Claude Code/Codex:** nothing is built in. INFERENCE: those tools would call it through a skill that shells `flue run --json`, or through the HTTP API.
- **Slack:** `flue add channel slack` installs `@flue/slack` (verified Events API, interactivity and slash commands) plus `@slack/web-api`. Channels are inbound only, and outbound replies are a tool you write (`advanced_channels.md` L13-30, L181-214).
  - `idempotencyKey: payload.event_id` dedupes Slack retries (L234).
  - `channel.instanceId({teamId, channelId, threadTs})` gives one conversation per thread (L226-230).
  - Socket Mode is not supported (`flue-framework/references/ecosystem_channels-slack.md` L19, L168).

### (4) Durability and evals
- Every input is a durable submission and settles once as completed, failed or aborted. Delivery is at-least-once (`advanced_durability.md` L13-23).
- The `durability` static is `{maxAttempts (default 10), timeoutMs (default 1h)}` (L27-52).
- An interrupted ordinary tool call is NOT re-executed; it settles with an unknown-outcome error (L102-105). `durable: true` plus `step.do` is available (L54-76).
- Subagent tasks resume from their own transcripts (L115-119).
- `usePersistentState` writes commit atomically with the tool batch (L125-131).
- On Node, persistence needs a `src/db.ts` adapter (`sqlite()` or Postgres, `guides_database.md`). Defaults: `vite dev` uses `node_modules/.cache/flue/dev.db`, `flue run` uses `run.db`, and `vite build` is in-memory (`guides_database.md` L165-171).
- **Evals:** there is no dedicated framework. Evals are Vitest files `src/evals/**/*.eval.ts`, run in-process with `start()`+`init()` or over HTTP with `@flue/sdk`; optional add-on: `vitest-evals` with judges (`advanced_evals.md` L13-52).
- Tool `run` functions are unit-testable with `bun test` (L212).
- For mocked, no-network evals, pi-ai ships `fauxProvider()` with scripted `fauxToolCall` and `fauxText` responses (`pi-ai/README.md` L1192-1215). INFERENCE: it can be registered in Flue with `setProvider`. This is not verified in Flue docs.

### (5) Deploy targets
- Vite app with the `flue()` plugin. Two targets: Node (`vite build` produces `dist/server.mjs`, PORT 3000, `db.ts` persistence) and Cloudflare (Worker plus one Durable Object per conversation; `db.ts` is a build error) (`advanced_deploy.md` L9-60; `guides_project-layout.md` L99-113, L207-216).
- `engines.node >=22.19.0` in all `@flue/*` and pi packages.
- Ecosystem deploy guides exist for aws, docker, fly, railway, render, sst, github-actions and gitlab-ci (`.agents/skills/flue-framework/references/ecosystem_deploy-*.md`).

## pi (pi-ai, pi-agent-core, pi coding-agent)

**(1) What each layer is:** see the Layering section above.

**(2) Tools, gating, models**
- pi-ai tools are TypeBox `{name, description, parameters}` with optional `constrainedSampling` (`pi-ai/README.md` L447-513).
- pi-agent-core `AgentTool` has an `execute(toolCallId, params, signal, onUpdate)` function (`pi-agent-core/README.md` L397-432).
- The hard gate is native: `beforeToolCall` receives the validated `args` and can return `{block:true, reason}` (L207-213). `afterToolCall` can rewrite the result or terminate (L215-222).
- The pi coding-agent equivalent is `pi.on("tool_call")`, which can block or patch `event.input` (`writing-pi-extensions/references/tool/tool_call.md` L1-55).
- Multi-provider: 30+ providers including OpenAI, Anthropic, OpenRouter, Bedrock, and "Any OpenAI-compatible API: Ollama, vLLM" (`pi-ai/README.md` L57-88). Ollama example: L993-1017. Env var table: L405-445.
- Subagents, skills and MCP: not in pi-ai or pi-agent-core (none of the README TOCs list them). In pi coding-agent: UNKNOWN from these files.

**(3) Exposure**
- pi-ai and pi-agent-core are libraries only; there is no HTTP or CLI agent surface. `streamProxy` is only a browser-to-backend LLM proxy (`pi-agent-core/README.md` L452-467).
- pi coding-agent has run modes TUI, `--mode rpc`, `--mode json` and `-p` print (`writing-pi-extensions/references/packaging.md` L140-148). It has no HTTP server or Slack in these files.

**(4) Durability and evals:** no durability. Session persistence only through the non-installed SQLite package. `fauxProvider` is available for tests.

**(5) Deploy:** whatever you build yourself (for example `Bun.serve`).

## Comparison

| Need | Flue 2.0.8 | pi-ai + pi-agent-core (hand-rolled host) | pi coding-agent + extension |
|---|---|---|---|
| Layer | Full runtime (loop, HTTP, durability, channels) | Model adapter + in-process loop | Interactive coding agent |
| Arg-level pre-tool block | No; enforce in each tool `run`; interceptor sees name only | Yes: `beforeToolCall` | Yes: `tool_call` |
| Subagents / parallel fan-out | Yes (`useSubagent`, `task`, depth 4, per-subagent model) | Build yourself | UNKNOWN |
| Skills | Yes (import + `.agents/skills` discovery) | No | Yes (not detailed here) |
| MCP | Client only, HTTP/SSE, tool allowlist | No | UNKNOWN |
| Providers incl. Ollama/OpenRouter | Yes (via pi-ai; Ollama through `setProvider`) | Yes | Yes |
| CLI | `flue run --json` | Build yourself | `pi -p` / `--mode json` |
| HTTP | `createAgentRouter` (202 + stream) | Build yourself (`Bun.serve`) | No |
| Slack later | `@flue/slack` channel + reply tool | Build yourself | No |
| Durable runs / resume | Yes (submissions, `db.ts`) | No | Session files only |
| Evals | Vitest / vitest-evals + `fauxProvider` | `fauxProvider` + `bun test` | n/a |
| Toolchain fit with repo rules | Needs Vite + vitest (the repo rules ban both) | Pure Bun-friendly | n/a |

## Recommendation (for the designer to decide)

Use Flue as the runtime. Treat pi-ai as its provider layer, not as an alternative.

Reasoning:
- It already covers CLI (`flue run --json`), HTTP (`createAgentRouter`), a future Slack bot (`@flue/slack` plus thread-bound reply tool and `idempotencyKey`), parallel per-entity subagents with cheaper per-subagent models, durable runs, and evals.
- A pi-agent-core build would have to hand-roll all of that.
- Classification fits either a `harness: true` tool calling `harness.prompt(..., {result: schema, model: env.CLASSIFIER_MODEL})` or a subagent with a `model` override. Ollama and OpenRouter work through `setProvider` and the built-in `openrouter/...` specifiers.

Flue's one real gap is the hard gate. Close it by design:
- Mount NO generic `bash`/`curl`/`psql` tool.
- Give the model only narrow tools (`http_get`, `http_allowlisted_call`, `sql_select`, `quickwit_search`, `repo_read`, `kubectl_cbs_curl` mounted only when its env flag is set). Every one of them runs a shared, unit-tested guard module before any I/O (GET-only unless the entity's allowlist file matches; SELECT-only SQL validation).
- For code walkthrough, use a sandbox with a custom `SandboxToolFactory` (read/grep/glob only), not raw `local()`.
- Optionally add an `instrument()` interceptor as a name-level deny-list backstop.

Alternative if runtime-level argument interception is a hard requirement: pi-agent-core with `beforeToolCall` gives it natively. The cost is building HTTP, durability, subagents and Slack yourself.

Toolchain conflict: Flue expects Vite, Vitest and Node ≥22.19, while `AGENTS.md` mandates Bun and no vite. This needs an explicit decision (see Contradictions).

## Key facts

- The new app is an empty bun-init project; index.ts only logs 'Hello via Bun!' (index.ts, package.json).
- Dependencies are @earendil-works/pi-ai 0.83.0, @flue/cli ^2.0.8 and @flue/runtime ^2.0.8. @flue/sdk, @flue/slack and pi-coding-agent are not installed (package.json, node_modules/@flue, node_modules/@earendil-works).
- @flue/runtime depends on pi-agent-core and pi-ai, and builds its turn loop with pi-agent-core's `new Agent({...})` (node_modules/@flue/runtime/package.json; dist/conversation-stream-store-C6cHMN0p.mjs L11, L2184-2197).
- pi-ai is a model adapter only: 'Unified LLM API with provider collections, automatic auth resolution, token and cost tracking' (node_modules/@earendil-works/pi-ai/README.md L1-3).
- pi-agent-core has a native beforeToolCall that sees validated args and can return {block:true, reason} (node_modules/@earendil-works/pi-agent-core/README.md L207-213).
- Flue does not pass beforeToolCall/afterToolCall to pi-agent-core; grep finds no beforeToolCall anywhere in @flue/runtime/dist.
- Flue's instrument() interceptor sees only {type:'tool', toolCallId, toolName}, not the tool arguments (dist/conversation-stream-store-C6cHMN0p.mjs L3309-3313; tmp/flue/advanced_observability.md L219-243).
- Flue's documented gating is conditional mounting plus checks inside the tool; the docs say 'Tool arguments are not an authorization boundary' (tmp/flue/guides_tools.md L301-380, L446).
- Any Flue sandbox mounts read/write/edit/bash/grep/glob, and local() 'is not an isolation boundary'. A custom SandboxToolFactory replaces the whole six-tool set (tmp/flue/guides_tools.md L198-214; tmp/flue/guides_sandboxes.md L125, L348, L354).
- Flue subagents take a per-definition model and thinkingLevel override, tasks run in parallel, and depth is capped at 4 (tmp/flue/guides_subagents.md L29-43, L175, L208).
- A Flue harness tool can call harness.prompt(text, {result: schema, model, thinkingLevel}) and get typed output back (tmp/flue/guides_tools.md L100-121, L216-254).
- useModel is submission-scoped, and there is no per-message model parameter on dispatch or HTTP (tmp/flue/guides_models.md L303, L311).
- Ollama in Flue goes through setProvider(createProvider({... api: openAICompletionsApi()})), which needs pi-ai as a direct dependency. 'flue run ignores app.ts' (tmp/flue/guides_models.md L114-122, L196-229, L313).
- Flue MCP is client-only, with transport 'streamable-http' | 'sse' (no stdio) and a tools allowlist (tmp/flue/guides_mcp.md L32-59, L133-141; McpTransport type in @flue/runtime/dist).
- Flue HTTP: createAgentRouter in src/app.ts serves POST /:id (202), GET /:id (snapshot/SSE) and POST /:id/abort. It has no auth and no send-and-wait route (tmp/flue/guides_routing.md L31-104, L242-251).
- Flue CLI: flue run <path> --message --id --data --env --json, with exit codes 0/1/130 and a JSON result envelope (tmp/flue/advanced_workflows.md L26-36).
- Flue Slack: @flue/slack channel (Events API, interactions, slash commands; no Socket Mode). Channels are inbound-only and outbound replies go through a hand-written tool (tmp/flue/advanced_channels.md L13-30, L181-214; .agents/skills/flue-framework/references/ecosystem_channels-slack.md L14-19, L168).
- Flue durability: each submission settles once; interrupted ordinary tool calls are not re-executed; defaults are maxAttempts 10 and timeoutMs 1h (tmp/flue/advanced_durability.md L13-52, L102-105).
- Flue persistence on Node needs a src/db.ts adapter; vite build defaults to in-memory (tmp/flue/guides_database.md L165-171).
- Flue evals are Vitest (in-process start()+init(), or HTTP via @flue/sdk), with optional vitest-evals (tmp/flue/advanced_evals.md L13-52).
- pi-ai ships fauxProvider() with scripted tool calls and text for tests with no real LLM or network calls (node_modules/@earendil-works/pi-ai/README.md L1192-1215).
- Flue deploy targets are Node (dist/server.mjs, PORT 3000) and Cloudflare (Worker + Durable Object per conversation); all packages require node >=22.19.0 (tmp/flue/advanced_deploy.md L9-73; package.json engines).
- pi coding-agent gates tool calls with pi.on('tool_call') returning {block:true}; run modes are TUI, rpc, json and print (.agents/skills/writing-pi-extensions/references/tool/tool_call.md L1-55; references/packaging.md L140-148).

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `.agents/skills/flue-framework/SKILL.md + references/` | Reference for Flue 2.x taken from the official docs: primitive decision table, rules that bite, notes on where the docs contradict themselves, ecosystem pages (Slack, databases, deploy). | reuse as-is: the main design reference for Flue; its own note says the installed packages win if they disagree |
| `.agents/skills/flue-framework-workspace/skill-snapshot/SKILL.md` | Older 156-line snapshot of the flue-framework skill. | drop: stale duplicate, and there is no top-level SKILL.md, so it is not loaded as a skill |
| `tmp/flue/*.md, tmp/flue/tools/README.md` | Distilled Flue docs (hooks, tools, subagents, models, routing, channels, evals, durability, layout, deploy, MCP, sandboxes), captured 2026-09-17. | reuse as-is for design reading; guides_models.md ThinkingLevel omits 'max' (stale) |
| `.agents/skills/writing-pi-extensions/` | pi coding-agent extension guide (tool_call gating, run modes). | drop for a Flue build (the skill says it does not apply to Flue); relevant only if the pi coding-agent route is chosen |
| `.agents/skills/agent-tool-function-definition, writing-agents, writing-evals` | Framework-neutral guides on designing tools, agents and evals, with Flue-specific references. | reuse as-is: guidance for narrow tools, the classifier/subagent split and the eval suite |
| `node_modules/@earendil-works/pi-ai (fauxProvider, createProvider, openAICompletionsApi)` | Provider layer: Ollama/OpenRouter/Anthropic/OpenAI registration plus a scripted fake provider for mocked evals. | reuse as-is: needed as a direct dependency for setProvider (Ollama/custom) and for evals with no network calls |
| `.agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md` | Bun-only toolchain rule (no vite, no vitest, Bun.serve). | port: must be amended or scoped if Flue (Vite build, Vitest evals) is adopted |
| `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc` | Symlink meant to point at the bun rule. | replace: broken relative symlink target |

## Unknowns

- By 'pi-core', do you mean @earendil-works/pi-agent-core (the library already installed with Flue), or the pi coding-agent CLI (@earendil-works/pi-coding-agent, not installed)?
- Does the design need argument-level blocking inside the agent runtime itself, or is it acceptable for every narrow tool's run() to call a shared guard module? In Flue the guard-module approach is the only argument-level option.
- Are you OK moving off the Bun-only rule where Flue needs it (Vite dev/build, Vitest evals, Node >=22.19)? Is running the Flue CLI/runtime under Bun acceptable? That is not verified anywhere in these files.
- Can Flue expose an agent as an MCP server (for Claude Code/Codex)? Nothing in the files I read documents this. The fallback is a skill that shells `flue run --json`, or the HTTP API through @flue/sdk.
- Does throwing inside an instrument() interceptor for a 'tool' operation cleanly become a tool error the model sees? The docs describe the interceptor only for tracing.
- Can fauxProvider be registered through Flue's setProvider so evals run with no real LLM calls? Both halves are documented separately, but the combination is not.
- For the Node target, which persistence backend should db.ts use (file SQLite vs Postgres), and is one live owner per conversation acceptable for the HTTP deployment?
- Does the future Slack bot need Socket Mode? @flue/slack supports only HTTP Events API delivery.

## Contradictions

- AGENTS.md and .agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md say 'Don't use vite' and 'Use bun test instead of jest or vitest', but Flue apps are Vite apps (tmp/flue/advanced_deploy.md L9) and Flue evals are Vitest suites (tmp/flue/advanced_evals.md L13, L49).
- The bun rule says Bun auto-loads .env, but a built Flue Node server 'does not load .env'. Only flue run and vite dev load it (tmp/flue/advanced_deploy.md L67; tmp/flue/guides_models.md L190-194). This matters for the 'everything from .env' requirement.
- The user brief expects hooks for pre-call gating, but Flue exposes no argument-aware pre-tool hook, even though the pi-agent-core it wraps supports beforeToolCall (pi-agent-core/README.md L207-213 vs @flue/runtime dist L2184-2197).
- The user brief says hooks are used today; Flue's docs use 'hooks' for use* render hooks (useTool, useModel), not tool-call interceptors (tmp/flue/guides_agent-hooks.md L13-61). The same word means different things.
- tmp/flue/guides_models.md L25 lists ThinkingLevel without 'max', while flue-framework/SKILL.md L201-205 and pi-agent-core/README.md L182 include 'max'.
- Eval env var: FLUE_AGENT_URL in the evals guide vs FLUE_BASE_URL in the vitest-evals blueprint (tmp/flue/advanced_evals.md L52; flue-framework/SKILL.md L210-211).
- The task asked for flue-framework-workspace/SKILL.md, but only flue-framework-workspace/skill-snapshot/SKILL.md exists, and it is an older version of flue-framework/SKILL.md.
- .cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc symlinks to a relative path that does not resolve, so Cursor never sees the bun rule while AGENTS.md does.
