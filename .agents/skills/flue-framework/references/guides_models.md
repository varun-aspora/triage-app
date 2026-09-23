---
title: Models
source: https://flueframework.com/docs/guide/models/
section: guides
---

# Models

Every Flue agent is powered by exactly one LLM at a time, declared with `useModel()` — the single required hook. `useModel()` is a declaration, not a client: it returns nothing, and no SDK object or API key passes through agent code. You name the model with a `'provider-id/model-id'` string; the runtime owns connection, authentication, streaming, and retries. The same hook tunes reasoning effort and context compaction.

## API surface

### `useModel()`

From `@flue/runtime`, called in an agent body (a file with the `'use agent'` directive) or in a custom hook the body calls.

```ts
function useModel(model: string, options?: UseModelOptions): void;

interface UseModelOptions {
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
}

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
```

Rules:

- **Required.** An agent render with no `useModel()` call cannot start.
- **Exactly once per render.** The *argument* may change render to render; the call may not disappear or repeat. A second call in one render throws.
- **Not available in a subagent render.** A delegate's model is set on its `useSubagent()` definition, and it inherits the parent's model when unset.
- Unknown option fields throw. An unknown `thinkingLevel` throws.

Minimal agent:

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}
```

### Model specifier

Plain string, `'provider-id/model-id'`, split at the **first** `/`; the model ID may itself contain slashes.

- `anthropic/claude-sonnet-4-6`
- `openai/gpt-5.5`
- `openrouter/moonshotai/kimi-k2.6`
- `cloudflare/@cf/moonshotai/kimi-k2.6`

Specifiers resolve against the providers registered with the runtime. By default that is the full built-in set from [Pi](https://pi.dev/docs/latest/providers): `anthropic`, `openai`, `google`, `amazon-bedrock`, `google-vertex`, `groq`, `mistral`, `xai`, `deepseek`, `cerebras`, `together`, `fireworks`, `openrouter`, and more. Each catalog entry carries wire protocol, endpoint, context-window size, output-token limit, cost rates, reasoning support, and accepted input modalities — that metadata decides when compaction triggers, whether a thinking level reaches the wire, and whether images are accepted.

An unknown specifier fails fast: the run errors with the unresolved provider and model ID before any request is sent.

### `providers` build config

```ts
flue({ providers: ['anthropic', 'openai'] });
```

Set in the `flue()` Vite plugin config (also accepted in `flue.config.ts`). The generated server entry then imports only those provider factories. With the list set it is **exhaustive** — a specifier naming any other provider fails at resolution. Omit the field to keep the full set.

### `thinkingLevel`

```ts
useModel('anthropic/claude-opus-4-6', {
  thinkingLevel: 'high',
  compaction: { keepRecentTokens: 16000 },
});
```

Default reasoning effort for the agent's model calls. Unset, the runtime uses `'medium'`. Higher levels increase reasoning depth at the cost of latency and tokens; `'off'` disables extended thinking entirely. It is a *default*: a subagent definition can pin its own `thinkingLevel`, and programmatic `harness.prompt(...)` calls accept one per operation.

Thinking only reaches the wire for models marked reasoning-capable.

### `compaction` / `CompactionConfig`

As a conversation approaches the model's context limit, Flue automatically compacts it: older history folds into a summary, recent messages stay verbatim, the conversation continues.

```ts
interface CompactionConfig {
  reserveTokens?: number;
  keepRecentTokens?: number;
  model?: string;
}
```

```ts
useModel('anthropic/claude-opus-4-6', {
  compaction: {
    // Trigger earlier or later: compaction runs when used tokens
    // exceed contextWindow - reserveTokens. Default: model-aware, ≤ 20000.
    reserveTokens: 30000,
    // How much recent history survives verbatim. Default: 8000.
    keepRecentTokens: 16000,
    // Summarize with a cheaper model than the session runs on.
    model: 'anthropic/claude-haiku-4-5',
  },
});
```

- `reserveTokens` — positive integer. Default is model-aware, capped at 20,000, shrunk for models with smaller output limits and adjusted when the reserve would consume half or more of a small context window.
- `keepRecentTokens` — positive integer, default `8000`. Lower values compact more aggressively at the cost of recent-context fidelity.
- `model` — specifier override for the summarization calls only. Defaults to the session's model.
- Unknown fields throw.

`compaction: false` disables **threshold** compaction (the automatic trigger) only. Overflow recovery and explicit `harness.compact()` calls still compact when the conversation no longer fits.

### `setProvider()`

From `@flue/runtime`, for providers Flue doesn't know out of the box.

```ts
function setProvider(provider: Provider): void;
```

Takes a Pi `Provider` object built with Pi's `createProvider()` or any provider factory. Requires `@earendil-works/pi-ai` as a project dependency (`npm install @earendil-works/pi-ai`). Call it at module top level in `app.ts`, before any agent runs. Registrations are keyed by `provider.id`, and each call **replaces** that ID's previous provider — including a built-in.

### Cloudflare Workers AI

On the Cloudflare target the `cloudflare` provider ID is registered automatically and runs models on Workers AI with no API key — authorization and billing follow the Worker.

```ts
function cloudflareBindingProvider(options: CloudflareBindingProviderOptions): Provider;

interface CloudflareBindingProviderOptions {
  binding: CloudflareAIBinding; // env.AI
  gateway?: CloudflareGatewayOptions | false;
  streamIdleTimeoutMs?: number;
}
```

Exported from `@flue/runtime/cloudflare/workers-ai`; `CloudflareGatewayOptions` from `@flue/runtime/cloudflare`.

## Recommended use cases

- Any agent at all — `useModel()` is mandatory, so this page is the baseline for every project.
- Trading cost against capability: cheap model by default, strong model when state says the task got hard.
- Long-running conversations that outlive a context window, tuned via `compaction`.
- Cutting build size to only the providers you ship (`providers` config).
- Pointing agents at a local model, a gateway, a proxy, or a brand-new release the catalog doesn't know (`setProvider()`).
- Running on Cloudflare without managing provider API keys at all (Workers AI).

## Patterns

### Escalation on durable state

The agent function re-renders before every model call, so the specifier can be computed rather than constant.

```ts
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';

export function Reviewer() {
  const [escalated, setEscalated] = usePersistentState('escalated', false);
  useModel(escalated ? 'anthropic/claude-opus-4-6' : 'anthropic/claude-haiku-4-5');

  useTool({
    name: 'escalate_review',
    description: 'Escalate when the change is too complex for a quick pass.',
    async run() {
      setEscalated(true);
      return 'Escalated. A stronger model will take over.';
    },
  });

  return 'Review the proposed change and leave actionable feedback.';
}
```

The response where `escalate_review` fires finishes on the cheap model; the conversation's next message runs on the strong one.

### Credentials from the environment

Local development — a `.env` at the project root, using each provider's expected variable name:

```bash
ANTHROPIC_API_KEY="sk-ant-..."
OPENAI_API_KEY="sk-..."
GEMINI_API_KEY="..."
```

`anthropic` reads `ANTHROPIC_API_KEY`, `openai` reads `OPENAI_API_KEY`, `google` reads `GEMINI_API_KEY`, `groq` reads `GROQ_API_KEY`; the pattern holds across providers. Shell-exported values always win over file values.

- `flue run` loads the project-root `.env`; `--env <path>` selects one alternate file.
- `vite dev` loads Vite's standard set: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`.
- Don't commit `.env` files.

Deployed servers read only the real environment, no `.env` loading. Node.js: process environment variables via your host's secret mechanism. Cloudflare: Worker secrets (`npx wrangler secret put ANTHROPIC_API_KEY`); locally `.dev.vars` plays the `.env` role.

### Custom provider — local Ollama

```ts
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

setProvider(
  createProvider({
    id: 'ollama',
    // Keyless local server; use envApiKeyAuth('...', ['MY_KEY']) for real keys.
    auth: { apiKey: { name: 'Ollama (keyless)', resolve: async () => ({ auth: {} }) } },
    models: [
      {
        id: 'llama3.1:8b',
        name: 'Llama 3.1 8B (local)',
        api: 'openai-completions',
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
    api: openAICompletionsApi(),
  }),
);
```

```ts
useModel('ollama/llama3.1:8b');
```

### Routing a built-in provider through a gateway

Register your own provider under the built-in's ID, reusing its catalog models with your endpoint and credential. Agent specifiers don't change.

```ts
import { createProvider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { setProvider } from '@flue/runtime';

setProvider(
  createProvider({
    id: 'anthropic',
    auth: {
      apiKey: {
        name: 'Gateway key',
        resolve: async () => ({ auth: { apiKey: process.env.GATEWAY_KEY } }),
      },
    },
    models: anthropicProvider()
      .getModels()
      .map((model) => ({ ...model, baseUrl: 'https://gateway.example.com/anthropic' })),
    api: anthropicMessagesApi(),
  }),
);
```

Cost, context-window, and capability metadata ride along from the catalog.

### Cloudflare Workers AI

```ts
export function Assistant() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
  return 'Help the user with their question.';
}
```

Declare the `AI` binding in the Wrangler config:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "ai": {
    "binding": "AI",
  },
}
```

To target a named gateway, tune caching and logging, or opt out, register the `cloudflare` provider yourself in `app.ts` — your registration wins over the generated default:

```ts
import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';
import { env } from 'cloudflare:workers';

setProvider(
  cloudflareBindingProvider({
    binding: env.AI,
    gateway: { id: 'my-gateway', cacheTtl: 300, metadata: { tenant: 'acme' } },
    // ...or `gateway: false` to bypass AI Gateway entirely.
  }),
);
```

## When to use / when NOT to use

| Situation | Use |
| --- | --- |
| Set the LLM for an agent | `useModel()` in the agent body |
| Give a delegate a different model or thinking level | `useSubagent()` definition — `useModel()` throws in a subagent render |
| Different reasoning effort for one programmatic call | `harness.prompt(...)`, which accepts a `thinkingLevel` per operation |
| Pick a model per incoming message from the client | Not possible — there is no per-message model parameter on `dispatch(...)` or the HTTP surface. Compute the specifier inside the agent function from durable state instead |
| Force a compaction now | `harness.compact()`, not the `compaction` config |
| Trim the shipped provider set | `providers` in the `flue()` plugin config, not `setProvider()` |
| Add an endpoint no catalog knows, or override a built-in's endpoint/credential | `setProvider()` with a Pi provider |
| Credentials that don't fit the env-var convention (gateway credential, secret manager, rotating keys) | A custom provider's `auth.apiKey.resolve()`, which runs per request |

## Gotchas & constraints

- **Submission-scoped settings.** Model, thinking level, and compaction are read once when the agent wakes to process an accepted input (a *submission*). A different value computed by a re-render mid-run latches and takes effect on the **next** submission, not mid-run.
- **Exhaustive `providers` list.** Once set, an unlisted provider fails resolution. On the Cloudflare target, include `'cloudflare'` when agents use `cloudflare/...` models.
- **`flue run` ignores `app.ts`.** It loads only the agent module, so a `setProvider()` registration in `app.ts` never runs there — put the registration in the agent module when the agent must also work under `flue run`.
- **The runtime trusts custom-provider metadata.** `reasoning: false` means a forwarded `thinkingLevel` is silently dropped. `input: ['text']` means attached images are replaced with an "(image omitted)" placeholder. `contextWindow: 0` reads as unknown, so threshold compaction can't engage.
- **Cloudflare model ID routing.** Everything after `cloudflare/` is passed as the model ID to `env.AI.run(...)`. `cloudflare/openai/gpt-5.5` bills through Cloudflare's AI Gateway path; plain `openai/gpt-5.5` uses Flue's direct OpenAI provider and its API key.
- **AI Gateway is on by default** for every `cloudflare/...` call, giving caching, logging, and budget controls in the dashboard; opt out with `gateway: false`.
- Cloudflare's model surface is also reachable from **any** target via two ordinary catalog providers: `cloudflare-workers-ai/...` (URL-backed Workers AI) and `cloudflare-ai-gateway/...` (URL-backed AI Gateway), both authenticating with `CLOUDFLARE_API_KEY`.
- **Registration is declarative and deferred.** `setProvider()` performs no network I/O and no credential validation; a wrong endpoint or key surfaces as a provider error on the first model request. There is no public unregister function.
- On the Cloudflare target each agent conversation runs in its own Durable Object isolate, and `app.ts` is evaluated in every isolate, so top-level registrations apply everywhere.
- **`'max'` is a real `thinkingLevel`.** Verified directly against the installed package (`@earendil-works/pi-agent-core`'s `ThinkingLevel` type, re-exported through `@flue/runtime`) as of 2.0.8 — it belongs in the type above alongside `'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`. If you see a Flue reference elsewhere (e.g. the agent-hooks API doc) that omits `'max'` from `ThinkingLevel`, that copy is stale, not this one.

## Related

- [Agent Hooks API — useModel](https://flueframework.com/docs/reference/agent-hooks-api/#usemodel) — full contract, `ThinkingLevel`, `CompactionConfig`
- [Provider API](https://flueframework.com/docs/reference/provider-api/) — `providers` config, `setProvider()`, `cloudflareBindingProvider()`
- [Subagents](https://flueframework.com/docs/guide/subagents/) — give a delegate its own model and thinking level
- [Durability](https://flueframework.com/docs/guide/durability/) — what a submission is, how interrupted model work recovers
- [Observability](https://flueframework.com/docs/guide/observability/) — inspect model calls, token usage, provider diagnostics
- [Agent Hooks — custom hooks](https://flueframework.com/docs/guide/agent-hooks/#custom-hooks)
- [Node.js target — Environment and secrets](https://flueframework.com/docs/guide/node-target/#environment-and-secrets)
- [Cloudflare deploy guide](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) · [Cloudflare target guide](https://flueframework.com/docs/guide/cloudflare-target/#workers-ai-and-ai-gateway)
- [Pi providers](https://pi.dev/docs/latest/providers)
