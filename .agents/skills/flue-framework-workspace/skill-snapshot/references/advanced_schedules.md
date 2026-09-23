---
title: Schedules
source: https://flueframework.com/docs/guide/schedules/
section: advanced
---

# Schedules

## What it is

A schedule delivers agent input at a fixed cadence: a cron trigger fires and your code calls `dispatch(...)` with a message for an agent conversation. Flue has no scheduler of its own — each target pairs its own cron mechanism with the same dispatch surface every other delivery uses. On Node.js that is an in-process cron library in `app.ts`; on Cloudflare it is a Worker Cron Trigger; on managed platforms it is the platform's cron service hitting your HTTP mount. The agent itself is ordinary — nothing in the agent function marks it as scheduled.

A schedule has three parts: a **trigger** (cron), a **delivery** (`dispatch(agent, { id, message })`, which resolves at durable admission, not at model completion), and a **conversation** (the `id` you pass, which decides whether fires continue one conversation or start fresh ones).

## API surface

This page introduces no new Flue exports. It composes existing ones:

- `dispatch(agent, request)` from `@flue/runtime` — fire-and-forget delivery, resolves at admission.
  ```ts
  function dispatch(agent: Agent, request: AgentDispatchRequest): Promise<DispatchReceipt>;

  interface AgentDispatchRequest {
    id: string;
    message: DeliveredMessageInput;
    initialData?: unknown;
    uid?: string | null;
  }

  interface DispatchReceipt {
    submissionId: string;
    acceptedAt: string;
    uid: string;
  }
  ```
- `init(agent, { id })` from `@flue/runtime` — handle with `dispatch()` / `read()` / `abort()`, used when the schedule needs the run's result.
- `DeliveredMessage` signal form, the shape a scheduled fire should use:
  ```ts
  { kind: 'signal'; type: string; body: string; attributes?: Record<string, string>; tagName?: string }
  ```
- `useDelivery()` (agent hooks) — how hooks and tools read the delivered message in code.
- `'use agent'` directive on the agent module, as normal.
- Cloudflare: `"triggers": { "crons": [...] }` in `wrangler.jsonc`; a `scheduled(controller)` handler on the default export of source-root `src/cloudflare.ts`; `controller.cron` and `controller.scheduledTime`.
- Node: no Flue config key — the cron library (`croner`'s `Cron`) lives in `app.ts` module scope. Options used: `timezone`, `protect: true`, `catch`.
- CLI: `flue run <agent file> --message <text> --id <id>`.

### The agent (nothing special)

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function Reporter() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Complete scheduled tasks autonomously.';
}
```

### Node.js: in-process cron in `app.ts`

```ts
import { dispatch } from '@flue/runtime';
import { Cron } from 'croner';
import { Hono } from 'hono';
import { Reporter } from './agents/reporter.ts';

const app = new Hono();

new Cron(
  '0 9 * * *',
  {
    timezone: 'America/New_York',
    protect: true,
    catch: (error) => console.error('Scheduled dispatch failed', error),
  },
  async () => {
    await dispatch(Reporter, {
      id: 'daily-summary',
      message: {
        kind: 'signal',
        type: 'schedule',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: { scheduledAt: new Date().toISOString() },
      },
    });
  },
);

export default app;
```

The `Cron` instance is created at module load, so the schedule starts with the server (`node dist/server.mjs` in production, `vite dev` in development). Cadence and timezone belong to the cron library, not to Flue; any in-process scheduler works the same way. Runnable version: `examples/node-schedules` in the Flue repo.

### Cloudflare: Worker Cron Trigger

`wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["0 9 * * *"],
  },
}
```

`src/cloudflare.ts` (Flue merges this default export into the generated Worker entry):

```ts
import { dispatch } from '@flue/runtime';
import { Reporter } from './agents/reporter.ts';

export default {
  async scheduled(controller) {
    await dispatch(Reporter, {
      id: 'daily-summary',
      message: {
        kind: 'signal',
        type: 'schedule',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: {
          cron: controller.cron,
          scheduledAt: new Date(controller.scheduledTime).toISOString(),
        },
      },
    });
  },
};
```

`dispatch()` in a `scheduled` handler behaves exactly as in an HTTP route: no mount needed, bypasses HTTP middleware, durably admits the message to the agent's Durable Object before resolving. A Worker has one `scheduled` handler; when `crons` lists several patterns, `controller.cron` says which one fired.

### What a fire delivers

A scheduled fire is a structured event, so deliver it as `kind: 'signal'` — caller-defined `type`, instruction in `body`, flat string metadata in `attributes`. It renders into model context as an XML-tagged block:

```plaintext
<signal type="schedule" scheduledAt="2026-07-17T13:00:00.000Z">
Review recent activity and prepare the daily summary.
</signal>
```

Hooks and tools read the same delivery in code via `useDelivery()`, so a tool can consume `attributes` values directly rather than relying on the model to echo them.

### Awaiting a run's result

```ts
import { init } from '@flue/runtime';
import { Reporter } from './agents/reporter.ts';

const reporter = init(Reporter, { id: `daily-${isoDate}` });
const receipt = await reporter.dispatch('Review recent activity and prepare the daily summary.');
const reply = await reporter.read(receipt);
await postSummary(reply.text);
```

Works inside a cron callback in `app.ts` and in a `scheduled` handler alike.

### External scheduler over HTTP

```http
POST /agents/reporter/daily-summary HTTP/1.1
Content-Type: application/json
Authorization: Bearer <scheduler-token>

{
  "kind": "signal",
  "type": "schedule",
  "body": "Review recent activity and prepare the daily summary."
}
```

Server responds `202` at admission, exactly like `dispatch(...)`.

### One-shot run from CI

```bash
flue run src/agents/reporter.ts \
  --message "Review recent activity and prepare the daily summary." \
  --id "daily-$(date +%F)"
```

Each invocation compiles the agent module locally, delivers one `kind: 'user'` message (there is no signal form), streams activity to stderr, prints the reply to stdout, and exits.

## Recommended use cases

- Daily/periodic reporting where an agent reviews recent activity and writes a summary.
- Recurring autonomous work that should build on its own history (fixed conversation id).
- Independent periodic runs that must stay individually inspectable and cheap in context (per-fire id).
- Triggering a deployed app from a platform cron service (Fly scheduled Machines, Render cron jobs, Railway cron schedules) instead of running a second process.
- Driving an agent from CI / GitHub Actions / system cron without a live server, via `flue run`.

## Patterns

**Dispatch-only agent.** Because dispatch addresses the registered agent function directly, a scheduled agent needs no HTTP mount at all.

**Put application-controlled steps behind a harness tool.** When the scheduled work reads a data source, writes a report, or calls an external API, put those steps behind a harness tool so they behave the same on every fire.

**Choosing the conversation id.**

| Id choice | Behavior |
| --- | --- |
| Fixed (`'daily-summary'`) | Every fire continues one conversation. The agent sees its previous runs and keeps persistent state across them. |
| Per fire (`` `daily-${isoDate}` ``) | Each fire creates a fresh conversation with bounded context. Pair with `initialData` to seed the new instance. |

A fixed id suits recurring work that builds on its own history — the agent can compare today against yesterday without re-fetching it. Per-fire ids suit independent runs where an ever-growing transcript is a cost.

**Keep the Cloudflare handler thin** — dispatch and return. Nothing durable exists until `dispatch(...)` resolves.

**Gate the Node trigger.** It also fires under `vite dev`, so gate construction on an environment variable when development fires are unwanted.

**Standalone cron script on another machine.** Boot the runtime with `start()` and use the same `init()` handle.

## When to use / when NOT to use

Use a **Worker Cron Trigger** (Cloudflare) or an **external/platform scheduler** when the schedule must address or create conversations from outside — it runs in the Worker, independent of any conversation's activity — and when a fire must not be lost to a restart or deploy window.

Do **not** use a Cron Trigger for a schedule that belongs to one *existing* conversation (a follow-up timer inside a running agent's Durable Object). Use the Agents SDK `schedule()` / `scheduleEvery()` APIs through the per-module `extend()` extension point in `@flue/runtime/cloudflare` instead. The docs are explicit: do not add a Worker cron trigger just to reach `scheduleEvery(...)`.

```ts
export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async onStart() {
        await this.scheduleEvery(60, 'heartbeat');
      }
      async heartbeat() {
        this.setState({ ...this.state, lastHeartbeatAt: Date.now() });
      }
    },
});
```

Do **not** rely on an in-process Node cron when the fire must survive downtime, or when the server runs more than one replica (see gotchas).

Do **not** put crash-critical side effects after an `await reporter.read(...)`. For orchestration that must survive crashes, use **Workflows** (durable workflows). For the same signal-delivery pattern driven by provider webhooks rather than cron, use **Channels**.

Use `flue run` rather than a live server for one-shot CI-driven runs — but note it only sends `kind: 'user'` messages.

## Gotchas & constraints

- **Node, dev fires.** The in-process `Cron` starts with the module, including under `vite dev`. Gate it on an env var if that is unwanted.
- **Node, replicas.** An in-process schedule runs in *every* replica of the server. Past one instance, gate the trigger to a single replica or move to a platform scheduler.
- **Node, missed fires.** Fires during downtime or a deploy are skipped; cron libraries do not replay them on restart. Either use a platform scheduler, or track the last completed run yourself and catch up at startup.
- **Cloudflare timezone.** Cron expressions are evaluated in **UTC**; there is no timezone option. The Node cron library does support an IANA `timezone`.
- **Cloudflare, one handler.** A Worker has a single `scheduled` handler; disambiguate multiple patterns with `controller.cron`.
- **Cloudflare, nothing durable before admission.** A `scheduled` handler that throws before `dispatch(...)` resolves delivers nothing for that fire.
- **Overlap.** Deliveries to one conversation never run concurrently — inputs are processed in accepted order, and a message arriving mid-response joins it at a turn boundary. Overlapping fires against a fixed id queue or coalesce; they cannot double-run the agent. Croner's `protect: true` additionally skips a fire while the previous callback is still executing, which matters when the callback awaits a settled reply rather than a fast admission. Per-fire ids are independent conversations and *do* run concurrently.
- **Durability by target.** On Node with the in-memory default, admitted work lasts only as long as the process — configure a durable database so accepted submissions survive a restart. On Cloudflare, admission is durable in the agent's Durable Object and interrupted processing is reconciled, making delivery **at-least-once**.
- **Idempotency.** Design a scheduled agent's external side effects to be idempotent.
- **`read()` is not durable.** If the process dies mid-await, the run still settles, but anything after the `await` is gone. Side effects that must not be lost belong inside the agent (a tool call), not after the read.
- **External HTTP schedulers require a mount, and a mounted agent has no built-in authentication.** Put the mount behind middleware that verifies the scheduler's credential.
- **`flue run` has no signal form** — it delivers one `kind: 'user'` message. A reused `--id` continues one conversation only with a configured database.
- **Cloudflare `extend()` scheduled callbacks share the object's alarm** with agent execution: one that comes due while a response is running fires after it settles. Delivery is durable; timeliness is not guaranteed while the agent is busy.

## Related

- [Building Agents — dispatch](https://flueframework.com/docs/guide/building-agents/#dispatch) and [standalone `start()` scripts](https://flueframework.com/docs/guide/building-agents/#standalone-scripts)
- [dispatch(...) reference](https://flueframework.com/docs/reference/agent-api/#dispatch) · [init() handle](https://flueframework.com/docs/reference/agent-api/#init) · [DeliveredMessage](https://flueframework.com/docs/reference/agent-api/#deliveredmessage)
- [Routing — dispatch-only agents](https://flueframework.com/docs/guide/routing/#dispatch-only-agents), [sending a message](https://flueframework.com/docs/guide/routing/#sending-a-message), [protecting your agents](https://flueframework.com/docs/guide/routing/#protecting-your-agents)
- [Durability](https://flueframework.com/docs/guide/durability/) · [Database](https://flueframework.com/docs/guide/database/)
- [Workflows — durable workflows](https://flueframework.com/docs/guide/workflows/#durable-workflows)
- [Channels](https://flueframework.com/docs/guide/channels/)
- [Cloudflare target — extending agents](https://flueframework.com/docs/guide/cloudflare-target/#extending-agents-on-cloudflare), [extending `cloudflare.ts`](https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint)
- [Tools — harness tools](https://flueframework.com/docs/guide/tools/#harness-tools) · [useDelivery()](https://flueframework.com/docs/reference/agent-hooks-api/#usedelivery)
- [flue run CLI](https://flueframework.com/docs/cli/run/)
- Deploy pages: [Fly](https://flueframework.com/docs/ecosystem/deploy/fly/) · [Render](https://flueframework.com/docs/ecosystem/deploy/render/) · [Railway](https://flueframework.com/docs/ecosystem/deploy/railway/)
