---
title: MCP
source: https://flueframework.com/docs/guide/mcp/
section: guides
also_read:
  - https://flueframework.com/docs/reference/agent-hooks-api/#usemcpconnection
  - https://flueframework.com/docs/reference/agent-api/#mcpconnectiondefinition
---

# MCP (Flue guide)

## What it is

MCP (Model Context Protocol) is an open standard for connecting agents to external services. Instead of hand-writing a Flue tool for every Linear / Notion / GitHub action, you connect the agent to a remote MCP server and its tools are mounted into the agent's tool set. In Flue you declare a server with the `useMcpConnection()` hook inside the agent function; the runtime connects, discovers tools, and namespaces them. Connections are runtime-owned — you never open or close them yourself.

## API surface

All symbols exported from `@flue/runtime`.

```ts
function useMcpConnection(definition: McpConnectionDefinition): void;
function defineMcpConnection(definition: McpConnectionDefinition): McpConnectionDefinition; // validates + freezes
function createMcpConnection(definition: McpConnectionDefinition): Promise<McpConnection>;  // low-level

interface McpConnection {
  name: string;
  tools: ToolDefinition[];
  close(): Promise<void>;
}
```

### `McpConnectionDefinition`

```ts
type McpTransport = 'streamable-http' | 'sse';
type McpAuth = string | (() => string | Promise<string>);

interface McpConnectionDefinition {
  name: string;
  url: string | URL;
  transport?: McpTransport;
  auth?: McpAuth;
  headers?: HeadersInit;
  requestInit?: RequestInit;
  fetch?: typeof fetch;
  timeoutMs?: number;
  resetTimeoutOnProgress?: boolean;
  tools?: string[];
  optional?: boolean;
}
```

- `name` — required, non-empty; becomes the `mcp__<server>__` tool namespace.
- `url` — required; a string must parse as an absolute URL.
- `transport` — defaults to `'streamable-http'`. Use `'sse'` for legacy servers.
- `auth` — bearer credential, sent as `Authorization: Bearer <token>` on every request. A function is resolved fresh per request; on a 401 the transport re-resolves once and retries.
- `headers` — static extra headers merged into every transport request (set-wins over `requestInit` headers). For credentials prefer `auth`.
- `requestInit` — additional transport request configuration.
- `fetch` — custom fetch implementation for the transport.
- `timeoutMs` — per-request timeout. Defaults to the MCP SDK default (60 seconds).
- `resetTimeoutOnProgress` — reset the per-request timeout on each progress notification. Default `false`.
- `tools` — allowlist by the server's own tool names, adapted in this order. Unknown, repeated, and task-required names reject the connection.
- `optional` — default `false`. `true` lets the submission run with zero tools from that server instead of failing.
- Unknown fields throw; malformed values throw with the offending field named.

### File conventions / directives

Agent modules start with the `'use agent';` directive; the hook is called synchronously in the agent function body. Reusable definitions are commonly kept in their own module (the docs import from `'../connections/linear.ts'`).

## Patterns

### Basic connection

```ts
'use agent';
import { useMcpConnection, useModel } from '@flue/runtime';

export function ProjectAssistant() {
  useModel('anthropic/claude-sonnet-4-6');
  useMcpConnection({
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    auth: process.env.LINEAR_API_KEY,
  });
  return 'Manage Linear issues and projects for the team.';
}
```

Tools are mounted as `mcp__<server>__<tool>` — here `mcp__linear__create_issue` — so they cannot collide with your own tools, and the model calls them like any other tool.

### Dynamic / per-user auth

`auth` may be a function, resolved on every request, so tokens can rotate or be revoked:

```ts
export function Assistant() {
  const { userId } = useInitialData<{ userId: string }>();

  useMcpConnection({
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    auth: () => tokenStore.get(userId, 'linear'),
  });

  return 'Help this user manage their Linear issues.';
}
```

Flue never stores or manages tokens. The OAuth flow, token storage and refresh logic are yours.

### Attach a server after mid-conversation authorization

Declare the connection conditionally on a persistent flag:

```ts
const [linearReady, setLinearReady] = usePersistentState('linear-ready', false);

if (linearReady) {
  useMcpConnection({
    name: 'linear',
    url: LINEAR_MCP_URL,
    auth: () => tokenStore.get(userId, 'linear'),
  });
}

useAgentStart(async () => {
  if (!linearReady && (await tokenStore.has(userId, 'linear'))) setLinearReady(true);
});
```

When the flag flips, the agent has the server's tools from its next message on.

### Trim the mounted surface

```ts
useMcpConnection({
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  auth: process.env.LINEAR_API_KEY,
  tools: ['create_issue', 'search_issues', 'get_issue'],
});
```

If the allowlist names a tool the server doesn't expose, the connection fails with an error.

### Define once, mount anywhere

```ts
import { defineMcpConnection } from '@flue/runtime';

export const linear = defineMcpConnection({
  name: 'linear',
  url: 'https://mcp.linear.app/mcp',
  auth: process.env.LINEAR_API_KEY,
});
```

```ts
import { linear } from '../connections/linear.ts';
useMcpConnection(linear);
useMcpConnection({ ...linear, tools: ['search_issues'] }); // override fields per mount
```

`defineMcpConnection` validates and returns the definition frozen, so bad definitions fail at module load instead of first render.

### Low-level: application-owned connection

```ts
const linear = await createMcpConnection({ name: 'linear', url: LINEAR_MCP_URL, auth: TOKEN });

export function ProjectAssistant() {
  useModel('anthropic/claude-sonnet-4-6');
  for (const tool of linear.tools) useTool(tool);
  return 'Manage Linear issues and projects for the team.';
}
```

`createMcpConnection` connects, discovers tools, and returns them as ordinary `ToolDefinition` values, so trusted application code can filter or wrap them before mounting with `useTool`. The adapted definitions are complete — do not wrap them in `defineTool()`. Also useful inside a Node.js script using the Node.js JavaScript API directly.

## Recommended use cases

- The agent needs actions in a third-party SaaS (Linear, Notion, GitHub) that already ships an MCP server — connect rather than reimplement each action as a tool.
- Per-user integrations where each end user authorizes their own account (function `auth` + a token store you own).
- An integration several agents share: put it in an application-owned integration service that is itself an MCP server, and have agents connect to it.
- Trusted application code that needs to filter, wrap or inspect the remote tools before they reach the model (`createMcpConnection` + `useTool`).

## When to use / when NOT to use

Use `useMcpConnection()` when the capability lives behind a remote MCP server and you want its tools in the agent. Prefer it over writing one Flue [tool](https://flueframework.com/docs/guide/tools/) per remote action.

Do not use it when:
- The capability is your own code — write a tool with `defineTool` / `useTool` instead; MCP adds a network hop and a third-party trust boundary for nothing.
- You are inside a subagent render — `useMcpConnection` throws there. Declare the connection on the root agent.
- You are on the Cloudflare target and were reaching for a module-scope `await createMcpConnection(...)` — use the hook instead (see Gotchas).
- You only want a subset of a huge server's tools and your goal is context economy — you still use the hook, but with the `tools` allowlist rather than mounting everything.

## Gotchas & constraints

- **Timing / scoping.** Definitions are submission-scoped: read once when a submission initializes. A conditional declaration added or dropped takes effect at the next submission, narrated to the model as a `resources` signal. Connections are then reused for the instance's in-memory lifetime; `auth` is the exception, resolved per request.
- **Failure behavior.** A failed connect fails the submission before the model runs and is never cached; the next message retries. `optional: true` instead mounts zero tools for that submission, announces the gap to the model as a `resources` signal with `resource="mcp"`, and logs a `log`-level warning. That signal is re-emitted on each affected response while the server stays down; recovery has no signal of its own.
- **Duplicate names.** Two connections with the same `name` in one render throw. Duplicate adapted tool names reject the connection.
- **Name sanitization.** Adapted names are `mcp__<server>__<tool>` with characters outside `[A-Za-z0-9_-]` replaced by underscores. Original tool/server names are spelled out in the description only when sanitization altered a name part.
- **Discovery.** Follows `tools/list` pagination; a repeated cursor throws. Tools that require task-based execution are skipped with a console warning, and allowlisting one is an error.
- **Results.** Tool result content is flattened to text for the model; a result with `isError` becomes a tool error. If the server declares an output schema, structured content is validated against it and a mismatch is an error.
- **Node vs Cloudflare.** `createMcpConnection` is async and is typically called at module scope with top-level `await` — **Node target only**. Cloudflare Workers prohibit network I/O in global scope; a Worker whose module graph connects at top level fails to boot, and the violation does not surface under `vite dev`, only at `wrangler dev`/deploy. On Cloudflare use `useMcpConnection()`.
- **Closing.** `close()` closes the underlying client; call it at application shutdown for caller-owned connections. On any connection or discovery failure the client is closed before the error propagates. Hook-declared connections are closed by the runtime.
- **Security.** A server you connect to can influence the agent: its tool descriptions enter the prompt and its tool results enter the conversation. Treat a server you don't control like any third-party dependency and use the `tools` allowlist to limit exposure.

## Related

- [Tools](https://flueframework.com/docs/guide/tools/) — how tools work, guards, conditional mounting.
- [useMcpConnection reference](https://flueframework.com/docs/reference/agent-hooks-api/#usemcpconnection) — render contract and semantics.
- [McpConnectionDefinition](https://flueframework.com/docs/reference/agent-api/#mcpconnectiondefinition) / [createMcpConnection](https://flueframework.com/docs/reference/agent-api/#createmcpconnection) — definition fields and adaptation contract.
- [Dynamic resources](https://flueframework.com/docs/reference/agent-api/#dynamic-resources) — the `resources` signal vocabulary.
- [Standalone scripts](https://flueframework.com/docs/guide/building-agents/#standalone-scripts) — Node.js JavaScript API usage.
