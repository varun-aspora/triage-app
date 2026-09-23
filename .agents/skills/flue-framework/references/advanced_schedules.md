---
title: Schedules
source: https://flueframework.com/docs/guide/schedules/
bundled_docs:
  - guide/schedules
  - guide/durability
  - guide/node-target
  - guide/cloudflare-target
  - reference/agent-api
  - guide/workflows
version: 2.0.8
reviewed: 2026-09-17
---

# Schedules

## What and when

Flue has no scheduler. A scheduler owned by the runtime platform fires, and application code calls `dispatch()` to admit a signal into an agent conversation. Separate scheduler ownership from delivery and completion:

| Need | Owner |
| --- | --- |
| Application-wide recurring trigger on one Node process | In-process cron in `app.ts`. |
| Application-wide trigger across replicas or downtime | Platform/external scheduler with one logical owner. |
| Cloudflare application-wide trigger | Worker Cron Trigger plus `src/cloudflare.ts`. |
| Timer belonging to one existing Cloudflare conversation | Agents SDK `schedule()`/`scheduleEvery()` through module-local `extend()`. |
| Crash-safe steps after the agent reply | Durable workflow engine. |

The scheduler owns when a fire occurs. Flue owns durable admission and settlement after `dispatch()` resolves.

## Current API

Schedules add no Flue export. They compose:

```ts
function dispatch(agent: Agent, request: {
  id: string;
  message: DeliveredMessageInput;
  initialData?: unknown;
  uid?: string | null;
  idempotencyKey?: string;
}): Promise<{
  submissionId: string;
  acceptedAt: string;
  uid: string;
  deduplicated?: true;
}>;
```

Use a signal for scheduled input:

```ts
{
  kind: 'signal',
  type: 'schedule.daily-summary',
  body: 'Prepare the daily summary.',
  attributes: { scheduledAt: '2026-09-17T13:00:00.000Z' },
}
```

`attributes` is a flat string map. Agent code can inspect the exact delivery with `useDelivery()`.

## How to

### Node: one in-process owner

```bash
bun add croner
```

```ts
// src/app.ts
import { dispatch } from '@flue/runtime';
import { Cron } from 'croner';
import { Hono } from 'hono';
import { Reporter } from './agents/reporter.ts';

const app = new Hono();

if (process.env.ENABLE_SCHEDULER === 'true') {
  new Cron(
    '0 9 * * *',
    {
      timezone: 'America/New_York',
      protect: true,
      catch: (error) => console.error('Scheduled dispatch failed', error),
    },
    async () => {
      const day = new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
      });
      await dispatch(Reporter, {
        id: 'daily-summary',
        idempotencyKey: `daily-summary:${day}`,
        message: {
          kind: 'signal',
          type: 'schedule.daily-summary',
          body: 'Review recent activity and prepare the daily summary.',
          attributes: { scheduledDay: day },
        },
      });
    },
  );
}

export default app;
```

The module loads in dev and production. Gate it to avoid accidental dev fires and ensure exactly one replica enables it. The stable key deduplicates retries for the same logical day; `protect: true` only prevents overlapping callback execution in that process.

### Cloudflare: application-wide Cron Trigger

```jsonc
{
  "triggers": { "crons": ["0 9 * * *"] }
}
```

```ts
// src/cloudflare.ts
import { dispatch } from '@flue/runtime';
import { Reporter } from './agents/reporter.ts';

export default {
  async scheduled(controller) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    await dispatch(Reporter, {
      id: 'daily-summary',
      idempotencyKey: `cron:${controller.cron}:${controller.scheduledTime}`,
      message: {
        kind: 'signal',
        type: 'schedule.daily-summary',
        body: 'Review recent activity and prepare the daily summary.',
        attributes: { cron: controller.cron, scheduledAt },
      },
    });
  },
};
```

Cloudflare cron expressions are UTC. A Worker has one `scheduled` handler; use `controller.cron` to branch among configured patterns. Await dispatch so the event does not finish before admission.

### External scheduler: authenticate and deduplicate in a custom route

```ts
app.post('/internal/schedules/daily-summary', async (c) => {
  await verifySchedulerRequest(c.req.raw);
  const { scheduledFor, deliveryId } = await c.req.json();
  const receipt = await dispatch(Reporter, {
    id: 'daily-summary',
    idempotencyKey: deliveryId,
    message: {
      kind: 'signal',
      type: 'schedule.daily-summary',
      body: 'Prepare the daily summary.',
      attributes: { scheduledFor, deliveryId },
    },
  });
  return c.json(receipt, 202);
});
```

The direct HTTP prompt route does accept a top-level `idempotencyKey` sibling in the request body (the installed runtime parses and enforces it identically to server-side `dispatch()`, even though some bundled API prose omits the field — see `introduction_changelog.md`). Prefer a narrow, dedicated route like this one anyway when the scheduler can retry: it lets you authenticate the scheduler's own credential separately from your mounted-agent auth, and it limits the caller to one intended action and payload shape instead of the general prompt surface (arbitrary `kind`/`body`/`initialData`).

### Cloudflare: timer owned by one conversation

```ts
'use agent';
import { extend } from '@flue/runtime/cloudflare';

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

This module-local extension applies to every agent exported from that module. It does not create the first conversation. Callbacks share the Durable Object alarm with agent execution, so a callback due during a response runs after it settles. Do not add a Worker Cron Trigger merely to call `scheduleEvery()`.

### Wait for a result only when the outer code can tolerate failure

```ts
const reporter = init(Reporter, { id: `daily-${isoDate}` });
const receipt = await reporter.dispatch({
  message: 'Prepare the daily summary.',
  idempotencyKey: `daily:${isoDate}`,
});
const reply = await reporter.read(receipt);
await postSummaryOnce(receipt.submissionId, reply.text);
```

If the process dies after `read()` but before `postSummaryOnce`, Flue cannot resume that line. Put the post inside an idempotent agent tool or use a durable workflow for the outer steps.

## Recommended patterns

- Derive one idempotency key from the logical schedule slot or provider delivery id.
- Keep platform handlers thin: validate/normalize, await admission, return.
- Use a fixed conversation id when runs should share history; use a per-fire id for bounded independent history.
- Pair per-fire ids with `initialData` for creation facts.
- Use platform scheduling when missed in-process fires are unacceptable.
- Track the last completed logical slot in application storage when catch-up behavior is required.

## Avoid

- Do not run an ungated in-process scheduler in every Node replica.
- Do not confuse Croner's `protect` with distributed singleton ownership or delivery deduplication.
- Do not treat a `dispatch()` receipt as the completed report.
- Do not put required crash-safe side effects after an ordinary `read()` await.
- Do not use Worker Cron for a timer that belongs to one existing Durable Object conversation.
- Do not use a fresh conversation id accidentally when historical context is required.

## Gotchas

- Node in-process fires are skipped during downtime and deploys; cron libraries do not replay them automatically.
- In-process schedules also start under `vite dev` when their module loads.
- Cloudflare creates no durable Flue work until `dispatch()` resolves.
- One conversation processes one submission at a time, but duplicate schedule deliveries are still duplicate submissions unless keyed. They may join a busy response or queue.
- Per-fire conversation ids can execute concurrently.
- Node restart recovery requires durable `db.ts` persistence. Cloudflare admissions live in Durable Object SQLite.
- Processing is at least once even after delivery deduplication; outbound effects still need idempotency.
- `flue run` emits a user message, not a signal, and only continues history when storage persists.

## Related

- [Schedules](https://flueframework.com/docs/guide/schedules/)
- [Agent API](https://flueframework.com/docs/reference/agent-api/)
- [Durability](https://flueframework.com/docs/guide/durability/)
- [Workflows](https://flueframework.com/docs/guide/workflows/)
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Routing](https://flueframework.com/docs/guide/routing/)
