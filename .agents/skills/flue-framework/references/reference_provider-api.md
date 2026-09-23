---
title: Provider API
source: https://flueframework.com/docs/reference/provider-api/
bundled_docs: bunx flue docs read reference/provider-api
version: 2.0.8
reviewed: 2026-09-17
---

# Provider API

## What and when

Flue uses Pi's `Provider` and `Models` protocol directly. Use this reference when limiting bundled providers, replacing or adding a provider at runtime, resolving model specifiers, or routing Cloudflare Workers AI through `env.AI`. Flue adds configuration and registration; provider catalogs, auth resolution, endpoints, and custom provider construction remain Pi responsibilities.

Provider registration is process/isolate memory, not durable configuration. Register at module scope before an agent runs.

## API index

| API | Import | Contract |
| --- | --- | --- |
| `providers` | `flue(...)` config | Exhaustive build-time built-in provider selection. |
| `setProvider(provider)` | `@flue/runtime` | Register or replace one Pi provider by `provider.id`. |
| `createProvider`, `envApiKeyAuth` | `@earendil-works/pi-ai` | Pi's public custom-provider and auth APIs. |
| Built-in provider factories | `@earendil-works/pi-ai/providers/<id>` | Pi provider objects usable with `setProvider`. |
| `cloudflareBindingProvider(options)` | `@flue/runtime/cloudflare/workers-ai` | Build the `cloudflare` provider around a Workers AI binding. |
| `CloudflareAIBinding`, `CloudflareGatewayOptions`, `CloudflareAIBindingError` | `@flue/runtime/cloudflare` | Structural binding, gateway options, and binding failure type. |

The generated server entry and its conditional built-in registrations are documented behavior, but are not public callable APIs.

## Build-time `providers`

```ts
// vite.config.ts or flue.config.ts
flue({ providers: ['anthropic', 'openai'] });
```

- Omitted: all built-ins register. On Cloudflare this includes the Workers AI binding provider.
- Present: the list is exhaustive for generated built-ins. An unlisted provider fails later model resolution.
- Unknown IDs fail the build because `@earendil-works/pi-ai/providers/<id>` cannot resolve.
- `'cloudflare'` selects Flue's binding provider and is valid only on the Cloudflare target. It is a config error on Node.
- Custom `setProvider()` registrations are independent of the list.
- A user registration wins: generated registration skips an ID already present.
- Inline plugin options override the same field in `flue.config.ts`.
- `flue run` ignores this narrowing. It loads the agent module, not `app.ts` or the generated entry, and registers the full built-in set.

The list controls shipped catalogs and lazy protocol implementations; it is primarily a server-build size and availability boundary.

## `setProvider()` contract

```ts
import type { Provider } from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

function setProvider(provider: Provider): void;
```

- The key is `provider.id`; a later call for the same ID replaces the entire earlier provider. Nothing merges.
- Registration performs no network request or credential check. Endpoint/auth failures appear on the first model request.
- Resolution consults the live module-scoped registry for every model call.
- There is no public unregister API.
- Provider auth owns credential resolution. Flue does not add an auth layer.
- On Node, module-scope registration covers the process. On Cloudflare, `app.ts` evaluates in each conversation Durable Object isolate.
- If registration must affect `flue run`, put it in the agent module because that command does not load `app.ts`.

### End-to-end custom provider

```ts
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider } from '@flue/runtime';

setProvider(
  createProvider({
    id: 'ollama',
    auth: {
      apiKey: {
        name: 'Ollama (keyless)',
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [/* Pi Model objects, including baseUrl and metadata */],
    api: openAICompletionsApi(),
  }),
);
```

Then select a declared model with `useModel('ollama/model-id')`. Replace a built-in provider in the same way when model metadata must differ; Flue has no separate metadata override registry.

## Model resolution contract

A model specifier is `provider-id/model-id`, split at the first `/`.

1. The provider ID must be registered. Failure is a plain `Error` that names registered IDs and registration paths.
2. The model ID must be returned by `provider.getModels()`. Failure is a plain `Error` listing declared IDs.
3. A dynamic-model provider may resolve an undeclared model through its template. Flue ships this behavior only in `cloudflareBindingProvider()`.

A specifier with no `/` or an empty model ID is invalid; an empty provider segment cannot resolve a registered provider. Model metadata lives on Pi `Model` objects: context window, costs, reasoning support, modalities, headers, and API selection.

Cloudflare dynamic fallback uses deliberately unknown metadata:

- `reasoning: false`; forwarded `thinkingLevel` is dropped.
- `input: ['text']`; images become the literal `"(image omitted)"` placeholder.
- `contextWindow: 0`; threshold compaction cannot engage.
- `maxTokens: 0` and all costs zero.
- Unknown `anthropic/...` or `openai/...` gateway IDs warn once per ID. Unknown `@cf/...` IDs are silent.

Treat fallback as dispatch compatibility, not accurate model capability metadata.

## Cloudflare Workers AI binding

```ts
interface CloudflareBindingProviderOptions {
  binding: CloudflareAIBinding;
  gateway?: CloudflareGatewayOptions | false;
  streamIdleTimeoutMs?: number;
}

interface CloudflareAIBinding {
  run(
    modelId: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Response | Record<string, unknown>>;
}

function cloudflareBindingProvider(
  options: CloudflareBindingProviderOptions,
): Provider;
```

The provider calls `binding.run(modelId, payload, options)` in-process. It has no base URL, API key, or HTTP model field: the first `run` argument selects the model. Every dispatch requests `returnRawResponse: true`.

`gateway` is tri-state:

- Omitted: use `{ id: 'default' }`, provisioned by the account as needed.
- Object: replace the default with the supplied gateway.
- `false`: pass no gateway option.

`streamIdleTimeoutMs` defaults to five minutes. A byte-silent stream beyond it fails as a retryable interruption under the turn's transient-error budget. `0` disables the guard.

```ts
interface CloudflareGatewayOptions {
  id: string;
  skipCache?: boolean;
  cacheTtl?: number;
  cacheKey?: string;
  metadata?: Record<string, number | string | boolean | null | bigint>;
  collectLog?: boolean;
  eventId?: string;
  requestTimeoutMs?: number;
}
```

All fields except `requestTimeoutMs` are forwarded in `gateway`. `requestTimeoutMs` is sent as `cf-aig-request-timeout`; it bounds time to first response part, not total stream duration.

### Serialization and metadata

The provider hydrates Pi's Workers AI and AI Gateway catalogs onto provider ID `cloudflare`. Gateway model IDs are vendor-prefixed from their URL path; `/compat` aliases are skipped. Serialization selection is:

1. Hydrated model `api` metadata.
2. Unknown `anthropic/...`: Anthropic Messages.
3. Unknown `openai/...`: OpenAI Responses.
4. `@cf/...` and unknown vendors: OpenAI-compatible chat completions.

Responses protocol handling uses Pi primitives, maps reasoning through `thinkingLevelMap`, and requests encrypted reasoning for stateless replay. A catalog API with no binding serializer produces an explicit stream error instead of sending an assumed format.

Non-OK binding responses throw `CloudflareAIBindingError` with `type: 'cloudflare_ai_binding_error'`. HTTP 413 also sets `meta.reason: 'request_too_large'`, allowing compaction recovery.

### End-to-end gateway override

```ts
import { setProvider } from '@flue/runtime';
import { cloudflareBindingProvider } from '@flue/runtime/cloudflare/workers-ai';

setProvider(
  cloudflareBindingProvider({
    binding: env.AI,
    gateway: { id: 'production', collectLog: true, requestTimeoutMs: 30_000 },
    streamIdleTimeoutMs: 120_000,
  }),
);
```

Register before generated entry logic runs; its built-in registration sees the existing `cloudflare` ID and skips it. The structural factory is import-safe on Node, but a real binding is required to call a model.

## Provider telemetry

`turn_request.request` and `turn.request` include unmodified `providerId` and normalized `providerName`. Known mappings include `amazon-bedrock -> aws.bedrock`, `azure-openai-responses -> azure.ai.openai`, `google -> gcp.gemini`, `google-vertex -> gcp.vertex_ai`, `mistral -> mistral_ai`, `moonshotai`/`moonshotai-cn -> moonshot_ai`, and `xai -> x_ai`. Unknown IDs pass through. Server host/port come from the resolved model's `baseUrl` when present.

## Recommended patterns

- Narrow `providers` in production builds; use `setProvider` for application-specific endpoints or metadata.
- Register at module scope and test the same module-loading path used by `flue run` when CLI parity matters.
- Declare complete model metadata rather than relying on Cloudflare's dynamic fallback.
- Use both gateway first-byte timeout and stream idle timeout when each failure mode needs a bound.
- Branch on `CloudflareAIBindingError.type` and `meta.reason`, not message text.

## Avoid

- Do not expect `setProvider()` to persist, synchronize isolates, validate credentials, or mutate Pi's catalog.
- Do not list `'cloudflare'` on Node or import binding dispatch accidentally through a broad barrel; use its dedicated subpath.
- Do not assume the configured provider list constrains `flue run`.
- Do not treat zero fallback metadata as evidence that a model has no context window or cost.
- Do not put `model` in a Workers AI request body; `binding.run()` receives it separately.

## Gotchas and errors

- User registrations replace, rather than merge with, built-ins.
- Generated registrations intentionally skip an existing ID, so module evaluation order does not overwrite user providers.
- A malformed model specifier or missing provider/model throws plain `Error`, not a categorized `FlueError`.
- Long-thinking streams may be legitimately byte-silent; setting a short idle timeout creates retries.
- Gateway `requestTimeoutMs` covers first response only; it does not detect a mid-stream stall.

## Related

- [Models guide](https://flueframework.com/docs/guide/models/)
- [Configuration reference](https://flueframework.com/docs/reference/configuration/)
- [Events reference](https://flueframework.com/docs/reference/events/)
- [Errors reference](https://flueframework.com/docs/reference/errors/)
- [Cloudflare target guide](https://flueframework.com/docs/guide/cloudflare-target/)
