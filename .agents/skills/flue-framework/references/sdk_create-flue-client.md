---
title: createFlueClient
source: https://flueframework.com/docs/sdk/create-flue-client/
bundled_docs: bunx flue docs read sdk/create-flue-client
version: "2.0.8"
reviewed: "2026-09-17"
---

# `createFlueClient(...)`

## Purpose and when

Construct a synchronous SDK client for exactly one deployed agent conversation. Use its options to resolve the conversation URL, apply auth per request, replace `fetch`, or route calls through a fetch-shaped service binding/test transport.

## API shape

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;

type CreateFlueClientOptions = HttpClientOptions;

interface HttpClientOptions {
  url: string;
  fetch?: typeof fetch;
  headers?: RequestHeaders;
  token?: string;
}

type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
```

| Option | Contract |
| --- | --- |
| `url` | Mounted agent-router URL plus conversation id. Trailing slashes are removed. Browser-relative URLs resolve against `location.origin`; elsewhere they throw. |
| `fetch` | Used for every JSON and stream request. Defaults to global `fetch` bound to `globalThis`; a custom method must be bound by the caller. |
| `headers` | Static map or sync/async factory evaluated once per request and stream connection/reconnection. Merged after token auth. |
| `token` | Adds `authorization: Bearer <token>` to every client request. An `authorization` entry in `headers` wins. |

There are intentionally no construction-level retry or timeout options. JSON methods accept per-call `AbortSignal`; stream methods accept per-call `signal` and `backoffOptions`.

## How to

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  url: 'https://example.com/agents/triage/ticket-42',
  headers: async () => ({
    authorization: `Bearer ${await refreshToken()}`,
    'x-request-source': 'triage-app',
  }),
});
```

Cloudflare service binding or test transport:

```ts
const client = createFlueClient({
  url: 'https://agent.internal/agents/support/ticket-42',
  fetch: (input, init) => env.AGENT_APP.fetch(new Request(input, init)),
});
```

The absolute placeholder origin is used for URL resolution; the custom fetch transport controls where requests go.

## Recommended patterns

- Generate the conversation id in application code and append it to the known route mount.
- Use a header factory for short-lived credentials so stream reconnects receive fresh auth.
- Put static bearer auth in `token`; use `headers` when authorization is dynamic or non-Bearer.
- Inject a canned fetch implementation for deterministic SDK tests.
- Reuse one client for operations on the same conversation.

## Avoid

- Do not expect construction to verify the route, agent, credentials, or conversation existence.
- Do not pass a relative URL from Bun/server/edge code.
- Do not pass an unbound object method as `fetch`.
- Do not expect `attachmentUrl()` consumers such as `<img>` to inherit SDK headers.
- Do not put one client's URL at an agent mount without a conversation id.

## Gotchas

- The only construction-time failures are native URL resolution errors, including `TypeError: relative url requires a browser; pass an absolute URL`.
- The first request, not construction, reports non-2xx route/auth errors as `FlueApiError`.
- Header factories may run repeatedly during reconnects; keep them safe, cheap, and side-effect-light.
- A custom `fetch` is used by `wait()` and `observe()` as well as JSON calls.

## Related

- [SDK overview](sdk_overview.md)
- [FlueClient](sdk_flue-client.md)
- [Errors](sdk_errors.md)
- [Routing](guides_routing.md)
