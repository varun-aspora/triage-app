---
title: Migrating from Flue 1 Beta to Flue 2
source: https://flueframework.com/docs/guide/migration/
bundled_docs:
  path: guide/migration
  version: 2.0.8
reviewed: 2026-09-17
---

# Migrating from Flue 1 Beta to Flue 2

## What this is and when to use it

Use this reference for applications moving from `1.0.0-beta.9` or another Flue
1 beta to Flue 2.0.8. This is a redesign, not a dependency-only upgrade: Vite
owns builds, `app.ts` owns routing, plain functions and hooks replace
`defineAgent`, and the framework workflow and deployment-wide SDK surfaces are
removed.

For a new project, use `flue init` instead. For an existing application, migrate
in place; do not run `flue init --force` because 2.0.8 overwrites every file in
the selected scaffold.

## Hard boundary: persisted beta state

The current runtime rejects pre-1.0 persisted formats and provides no in-place
database migration: 2.0.8 stores schema version 8, the `1.0.0-beta.9` runtime
stored version 5, and the newer runtime refuses to read the older schema before
any application code runs. Decide this before changing code:

- If beta conversations can be discarded, drain the old deployment and create
  fresh Flue 2 agent storage.
- If they must survive, export the required information through the beta app
  before upgrading, then re-seed it in the new application.
- On Cloudflare, deleting old agent or workflow Durable Object classes also
  deletes application data stored beside Flue's data. Export it first.
- The beta's deployment-wide `FlueRegistry` Durable Object (which indexed
  workflow runs) has no Flue 2 replacement. Append a `deleted_classes`
  migration for it, and for every `Flue<Name>Workflow` class the beta
  deployed, alongside the ordinary `new_sqlite_classes` entries for new Flue 2
  agents. Because the schema reset applies regardless of class name, a
  `renamed_classes` migration cannot carry a beta agent's data forward either
  — beta-era classes are normally retired with `deleted_classes` in favor of
  fresh Flue 2 identities.

## API and configuration map

| Flue 1 beta | Flue 2.0.8 |
| --- | --- |
| `flue dev`, `flue build` | `vite dev`, `vite build` with `flue()` |
| Auto-mounted `flue()` router | Explicit Hono routes in `app.ts` |
| Directory-based agent discovery | First-statement `'use agent'` scan |
| `defineAgent(async () => config)` | Synchronous exported agent function plus hooks |
| Config `model`, `tools`, `skills`, `sandbox` | `useModel`, `useTool`, `useSkill`, `useSandbox` |
| Config `durability` | `Agent.durability` static |
| `defineWorkflow`, `invoke`, runs | `init()` + `dispatch()` + `read()`, durable tools, or external orchestration |
| Deployment-wide SDK client | One `createFlueClient({ url })` per conversation |
| `client.agents.*` | `send`, `wait`, `observe`, `history`, `abort` |
| Tool `run({ input })` | Tool `run({ data })` |
| Bare object tool result | `{ output: value }` result envelope |
| Implicit virtual sandbox | Explicit `useSandbox()` |
| Skill import attributes | Import `SKILL.md` directly; other `.md` is text |
| `dispatch({ agent: 'name', ... })` | `dispatch(AgentFunction, request)` |
| `dispatchId` | `submissionId` |
| Channel `conversationKey` | `instanceId` |

## Exact Flue 2 setup

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({ target: 'node' });
```

```ts
// vite.config.ts
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [flue()] });
```

For Cloudflare, install `@cloudflare/vite-plugin` and wire it with the
`flueWorkerConfig()` customizer — bare `cloudflare()` (shown on some published
docs pages, including the migration source this section is drawn from) is a
config-resolution error in 2.0.8:

```ts
// vite.config.ts (Cloudflare)
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
```

`flue()` must precede `cloudflare()`, and `flueWorkerConfig()` must be called
after `flue()` in the same config evaluation — see `advanced_deploy.md` for
the full wiring contract and the other documented contradiction it resolves.

An agent conversion looks like this:

```ts
// Before
export default defineAgent(async ({ id }) => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: `Help with ticket ${id}.`,
  tools: [lookupOrder],
  durability: { maxAttempts: 5 },
}));
```

```ts
// After: src/agents/support.ts
'use agent';
import { type AgentProps, useModel, useTool } from '@flue/runtime';

export function Support({ id }: AgentProps) {
  useModel('anthropic/claude-sonnet-4-6');
  useTool(lookupOrder);
  return `Help with ticket ${id}.`;
}

Support.agentName = 'support';
Support.durability = { maxAttempts: 5 };
```

Explicit routing replaces the auto-router:

```ts
// src/app.ts
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';

const app = new Hono();
app.use('/agents/*', requireUser);
app.route('/agents/support', createAgentRouter(Support));
export default app;
```

The direct HTTP body is a bare `DeliveredMessage`, not `{ message: ... }`:

```json
{
  "kind": "user",
  "body": "Where is my order?",
  "idempotencyKey": "request-8472"
}
```

Server-side dispatch wraps the message in the request and accepts the same
delivery key:

```ts
const receipt = await dispatch(Support, {
  id: ticketId,
  message: {
    kind: 'signal',
    type: 'support.comment.created',
    body: event.text,
  },
  idempotencyKey: event.id,
});
```

## How to: migrate end to end

1. Export any beta state that must survive and plan a drained cutover.
2. Upgrade all `@flue/*` packages in lockstep. Add `@flue/vite`, `vite`, and
   `hono`; add `@cloudflare/vite-plugin` for Cloudflare.
3. Replace package and CI scripts with `vite dev` and `vite build`.
4. Change `defineConfig` imports to `@flue/runtime/config`; remove retired
   `root` and `output` fields.
5. Create `app.ts`, preserve public URL shapes, and explicitly mount each agent
   and channel. Dispatch-only agents need registration but no HTTP mount.
6. Convert every agent to an exported capitalized synchronous function in a
   `'use agent'` module. Move behavior to hooks and contracts to statics.
7. Convert tool parameters from `input` to `data`, return result envelopes, and
   use `durable: true` with `step.do()` for checkpointed side effects.
8. Add `useSandbox()` only to agents that need execution or files. Move remote
   sandbox creation into the sandbox factory.
9. Replace workflows with the smallest equivalent: an awaited `init()` handle,
   a durable tool, or an application-owned orchestrator.
10. Replace deployment-wide clients with conversation-scoped URLs. Treat sends
    as admission and wait/read separately.
11. Update channels, database adapter runners, custom providers, observability
    event names, and `submissionId` correlations.
12. On Cloudflare, update Durable Object migrations and use a compatibility
    date of at least `2026-04-01`.
13. Run typechecks, tests, `bunx vite build`, and a smoke conversation before
    shifting traffic.

## Recommended patterns

- Preserve existing HTTP mount paths even though routing is now explicit.
- Pin each new function's `agentName` before production data is created.
- Put structured creation facts in `initialData`; do not encode them into IDs
  only to parse them later.
- Pass provider event IDs as `idempotencyKey` to converge redeliveries.
- Migrate one agent vertically, including its route, tools, persistence, and
  client, before applying the pattern to the rest.

## Avoid

- Do not attempt to open a beta database with Flue 2.
- Do not leave a converted agent as a default export or omit `'use agent'`.
- Do not call async code from the agent render.
- Do not recreate removed workflows as an uncheckpointed chain of calls.
- Do not carry over `?wait`, `client.agents.*`, import attributes, or an
  assumed implicit sandbox.
- Do not treat cancellation of `handle.read(..., { signal })` as a durable
  abort; call `handle.abort()` when the work must stop.

## Gotchas

- `app.ts` mounts routes but does not register agents. Registration comes from
  the `'use agent'` scan.
- A mounted HTTP send returns `202`; completion comes through the conversation
  stream or SDK.
- `dispatch()` and `handle.dispatch()` resolve at admission. Pass the receipt
  to `handle.read()` for the settled reply.
- Changing an unpinned function name changes its durable identity; changing its
  filename does not.
- `flue run` loads the selected agent module, not `app.ts`. Provider setup done
  only in `app.ts` will not be visible to local runs.
- Vite dev loads `.env`; built servers use the process environment and do not
  load `.env` themselves.
- The Cloudflare `vite.config.ts` snippet on the published migration page
  omits `flueWorkerConfig()`; use the exact wiring shown above instead.

## Related references

- [Flue 2 changelog notes](introduction_changelog.md)
- [Getting started](introduction_getting-started.md)
- [Project layout](guides_project-layout.md)
- [Building agents](guides_building-agents.md)
- [Deploy](advanced_deploy.md)
- [Agent hooks](https://flueframework.com/docs/guide/agent-hooks/)
- [Routing](https://flueframework.com/docs/guide/routing/)
- [Workflows](https://flueframework.com/docs/guide/workflows/)
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
