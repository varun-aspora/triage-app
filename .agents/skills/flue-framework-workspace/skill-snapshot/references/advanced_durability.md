---
title: Durability
source: https://flueframework.com/docs/guide/durability/
section: advanced
---

# Durability

## What it is

Durability is Flue's contract for accepted work: once an input is admitted to an agent, the runtime owes that conversation a durable terminal outcome, through process crashes, restarts, and redeploys. Every input becomes a **submission** whose payload is recorded durably before any model work begins. Recovery works only from durable evidence (canonical conversation records, the admission row, attempt bookkeeping) and continues the conversation rather than restarting it. Where the state is stored is the Database guide's topic; this page covers the contract and recovery behaviour.

## The accepted-work contract

Inputs that are admitted as submissions: a direct HTTP prompt, a `dispatch(...)` call, an `init()` handle's `dispatch(...)`, a channel delivery, a scheduled trigger.

> Every accepted submission reaches exactly one durable terminal outcome — `completed`, `failed`, or `aborted` — no matter how many crashes happen in between.

- The outcome is written as a `submission_settled` record in the conversation's canonical stream. The Agent SDK's `wait()` resolves/rejects from that record; an awaited `init().read(...)` resolves with the settled reply or rejects with the settled error.
- Submissions for one conversation form a durable queue processed in admission order. One runs at a time. A message arriving while the agent is busy either joins the live response at a turn boundary or waits its turn; a delivery that misses the live response runs as its own submission. Queued messages are never lost.
- Processing happens in **attempts**: a coordinator claims the submission, runs it, settles it. An interruption consumes the attempt; recovery claims a new one, up to the retry budget.
- Abort: `POST /:id/abort` (or the SDK's `abort()`) records a durable abort intent on every unsettled submission for the conversation; each settles `aborted` through the normal attempt machinery, even if the running process is gone. An abort arriving after a finished response leaves it `completed`.
- Overall discipline: **at-least-once execution over exactly-once recording.** Work committed durably (recorded responses, recorded tool results, committed state writes) never re-runs. Work interrupted before committing re-runs.

## API surface

### `durability` agent static

```ts
'use agent';
import { useModel } from '@flue/runtime';

export function IssueTriage() {
  useModel('anthropic/claude-opus-4-6');
  return 'Triage the bound issue end-to-end.';
}

IssueTriage.durability = { maxAttempts: 5, timeoutMs: 7_200_000 };
```

```ts
interface DurabilityConfig {
  maxAttempts?: number;
  timeoutMs?: number;
}
```

- `maxAttempts` — maximum total attempts before the submission terminalizes as failed (`SubmissionRetryExhaustedError` settlement). The initial run is the first attempt. Positive integer. Default `10`.
- `timeoutMs` — maximum wall-clock ms for a single submission, measured from the first attempt's start; exceeding it aborts and settles failed (`SubmissionTimeoutError`). Turn-boundary joins and `useAgentFinish` continuations do not extend it. Positive integer. Default `3_600_000` (one hour).
- Unknown fields throw at validation. Absent the static, store defaults apply.
- It is a static, not a hook, because the platform applies it while the agent function is *not* running — so it survives a crash in the agent's own render. Unlike `agentName`, the value need not be a literal, so environment-dependent policy is fine:
  `Fn.durability = process.env.CI ? { timeoutMs: 60_000 } : { timeoutMs: 3_600_000 }`

### Durable tools: `durable: true` and `step.do`

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { billing, projects, DEFAULT_PROJECTS } from '../shared/provisioning.ts';

export const provisionWorkspace = defineTool({
  name: 'provision_workspace',
  description: 'Create the customer tenant, then seed each default project.',
  input: v.object({ customerId: v.string() }),
  durable: true,
  async run({ data, step }) {
    const tenant = await step.do('create-tenant', () => billing.createTenant(data.customerId));
    for (const project of DEFAULT_PROJECTS) {
      await step.do(`seed:${project.name}`, () => projects.seed(tenant.id, project));
    }
    return { output: { tenantId: tenant.id } };
  },
});
```

`step.do(name, fn)` runs `fn` once per name for the tool call and durably records its returned value before resolving. On recovery the whole call re-runs, completed steps return recorded values without executing, and execution continues from the first step that never finished. Step records are keyed to the tool call id, so they carry across attempts of the same call and are scoped to it — a fresh invocation runs every step fresh. The model sees only the tool's final result; step progress surfaces live as the call's log events.

### Other named surfaces on this page

- `usePersistentState` — persisted state (see below).
- `dispatch(...)` → `DispatchReceipt`, and `read(receipt)` to re-attach to accepted work from any process.
- `start()` with its `db` option, for standalone scripts.
- Timeline/advisory records: `submission_settled`, `submission_interrupted`.

## Recovery after an interruption

A crash leaves no record of itself. Recovery runs when a replacement owner wakes and proceeds in two phases.

1. **Converge the stream.** Any partially streamed assistant output the dead attempt persisted is closed out as an aborted entry — unconditionally and idempotently, so no crash shape leaves the conversation looking mid-stream. The partial output stays in history.
2. **Classify the durable evidence** and continue:

| Durable evidence after the input | What recovery does |
| --- | --- |
| The input was never persisted | Requeues the submission for a clean first attempt. |
| A completed assistant response | Settles completed — finished work is never discarded, even past the retry budget. |
| A partial response with text or reasoning | Tells the model its stream was interrupted and continues from the durable partial. |
| A tool turn with unresolved calls | Repairs the tool batch, then continues the turn loop. |
| A transient provider error (rate limit, outage) | Retries the turn after a backoff, under a bounded error budget. |
| A context-overflow response | Compacts the conversation and retries the turn. |
| A durable abort intent | Settles aborted. |

**Tool-batch repair** is conservative:
- Results recorded before the crash are preserved exactly; those calls never run again.
- An unresolved *ordinary* call is **not** re-executed — the runtime cannot know which side effects already happened. It settles with an explicit unknown-outcome error the model sees and can react to.
- Only two kinds resolve real outcomes: `durable: true` tools (re-execute, completed steps replay from records) and in-flight delegated tasks (resume from their own transcripts).

A recovered conversation always comes to rest in a state where the next message processes normally — an interrupted submission cannot wedge the queue. The interruption stays visible in the timeline: the aborted partial, interrupted-tool markers, and on a failed settlement a terminal advisory signal.

### Retry budget and timeout

When a submission exhausts its attempts or exceeds its wall-clock timeout, retrying stops: the conversation settles to a rest state, a `submission_interrupted` advisory lands in the timeline, and the submission settles `failed`. Waiters reject with the structured error, including which tool calls were left with unknown outcomes.

The coordinator supervises running attempts on its wake cadence. At the deadline it fires the attempt's abort signal, so work suspended on a signal-aware await (a provider call, a sandbox command, any tool) unwinds and settles normally — a `run` that ignores its signal is abandoned rather than awaited. An attempt hung below the abandonable layer is settled `failed` over the hung fiber after a short grace, with late writes fenced off. A hang delays settlement by at most the deadline plus that grace. Most stalls never reach the deadline: a model stream silent past its idle timeout fails as a transient provider error and the turn retries under the error budget.

### Delegated tasks (subagents)

A subagent task runs as a child session with its own durable conversation stream, so a crash mid-task loses none of the child's progress. When recovery repairs a tool batch containing an unresolved `task` call, it reattaches to the child's durable transcript, resumes the child to completion under the same recovery rules, and commits the child's real final result as the parent's tool outcome. This recurses — a child interrupted inside *its* delegate resumes the grandchild first. Several tasks interrupted in one parallel batch are all resumed before the batch commits.

A delegate has no durability configuration of its own: resumed child work runs inside the parent's attempt, under the parent's retry budget and timeout.

Edge cases:
- **Delegate removed by a redeploy** — if the subagent is no longer declared when recovery runs, that call settles with an error outcome and the parent continues. A renamed or removed delegate cannot be resumed under any retry.
- **Terminal settlement** — when a submission exhausts its budget with a task unresolved, the interrupted marker for that call carries the child's conversation id, so the child's transcript stays inspectable.

### Persisted state

Every `usePersistentState` write is a record in the conversation's canonical stream, which is why state survives restarts for the life of the conversation. A write becomes durable atomically with the unit of work that made it:
- a write from a tool commits with that turn's tool batch;
- a write from an event hook commits with the hook seam's checkpoint.

If recovery settles the batch as interrupted, the write never happened — the re-attempt renders from the last committed state, matching exactly what the model sees as done. That atomicity is what makes persistent state the correct guard for at-least-once callbacks: a `sent` flag set by the same unit of work that sent the email cannot end up `true` while the work it guarded rolled back.

## Recommended use cases

- Long-running agent work that must reach a terminal outcome across deploys — triage runs, multi-step provisioning, batch syncs.
- Tools whose side effects must complete: payments, provisioning, multi-step syncs → `durable: true` with `step.do`.
- Tuning per-agent risk: a short `timeoutMs` for cheap interactive agents, a long one for big jobs; fewer `maxAttempts` where re-running is expensive.
- Guarding one-shot external actions (send email, page someone) with persistent state so an at-least-once callback doesn't repeat it.
- Re-attaching to accepted work from a different process by persisting the `DispatchReceipt` and calling `read(receipt)`.

## Patterns

**Per-agent durability policy, environment-aware**

```ts
Fn.durability = process.env.CI ? { timeoutMs: 60_000 } : { timeoutMs: 3_600_000 };
```

**Deterministic step names, derived from data**

```ts
for (const project of DEFAULT_PROJECTS) {
  await step.do(`seed:${project.name}`, () => projects.seed(tenant.id, project));
}
```

**Durable + harness composed** — wrap `harness.prompt(...)` in a step so recovery doesn't re-prompt.

**Recovering a lost local promise** — persist the receipt (for example as a workflow step's durable result), then re-attach:

```ts
const receipt = await dispatch(/* ... */);   // persist receipt durably
// later, from any process:
await init(/* ... */).read(receipt);          // resolves immediately if already settled
```

**Guard one-shot effects with persistent state** — set the flag in the same unit of work that performs the effect, so it rolls back together.

## When to use / when NOT to use

Use durability features when:
- The work is accepted by an agent and must settle — that is the default, nothing to opt into.
- A tool's side effects must complete despite a crash → `durable: true` + `step.do`.
- Knowledge must survive a restart → `usePersistentState`.
- Files must survive a restart → a **sandbox adapter** (remote sandbox) keyed on the agent instance id, not the conversation database.

Do NOT use it for:
- **Arbitrary TypeScript outside the agent.** Flue does not checkpoint arbitrary execution and resume a function from its last completed line. The checkpoint boundary is the agent itself. For the endpoint, script, or cron job that *drives* the agent, use the workflow engine your platform provides (Cloudflare Workflows, Inngest, or plain re-runs) and treat Flue like any other service — see the Workflows guide. Redelivering a message is a new submission, and the durable record shows what the previous attempt completed.
- **Persisting sandbox files.** The virtual sandbox is ephemeral by design; use a sandbox adapter instead.
- **Keeping an in-flight local promise alive.** `init(...).read(...)` / `client.wait(...)` promises are not durable; persist the receipt instead.
- **Recording external effects.** Flue records that a tool ran and what it returned, never the effect itself.

## Gotchas & constraints

- **Ordinary interrupted tool calls are never re-executed.** They settle with an unknown-outcome error. If completion matters, mark the tool `durable`.
- **Steps are exactly-once-recorded, at-least-once-executed.** A crash between a step's function finishing and its record landing re-runs that one step. Steps around external effects must be individually idempotent.
- **Code between steps re-executes on recovery.** Keep it cheap and effect-free: derive values, branch, loop.
- **Step names must be deterministic**, never from randomness or timing. Reusing a name within one call throws.
- **Step values are JSON and should stay small.** Store large artifacts in the sandbox and record a pointer.
- **A thrown error is not an interruption.** A durable tool that throws settles the call as a tool error the model sees; nothing retries automatically.
- **A redeploy can withdraw the durable contract.** If recovery finds the current render no longer declares the tool, or no longer marks it `durable`, the call falls back to the ordinary interrupted-marker path. Same for a removed or renamed subagent delegate.
- **Event hooks can double external side effects.** Their durable effects commit atomically and never duplicate, but an external effect inside one (an email, a page) may rarely happen twice. Guard with persistent state or application-level idempotency.
- **A durable database does not make a sandbox durable, and a durable workspace does not preserve conversation history.** They are independent choices.
- **External effects are outside the recovery model.** Design them to be idempotent, key them on stable ids like `toolCallId` or `step.do` names, and guard one-shot actions with persistent state.

### Node.js target

A coordinator inside your server process owns submission processing. Ownership is lease-based: each running submission carries a short lease the owning process heartbeats.

- **Startup reconciliation** — a replacement process scans for interrupted work on boot, requeues it, and begins serving immediately while that work settles in the background. Ordering is preserved per conversation: recovered work runs ahead of newly delivered work, so a restart never reorders a timeline.
- **Periodic lease scans** — the coordinator scans for expired leases while running, so work stranded by a fast restart (new process boots before the old lease expires) is reclaimed within seconds.
- **Graceful shutdown** aborts active submissions at the turn boundary and waits for them to settle; work that does not settle in time is left running with its lease intact and reclaimed at the next startup after expiry.
- **Recovery is only as durable as the database.** With the in-memory default, accepted work survives interruptions within the process lifetime but a restart loses everything. Cross-restart recovery requires a durable adapter in `db.ts`.
- **One live owner per conversation.** A shared database lets a *replacement* process recover work; it does not make two concurrent owners safe. Multi-replica deployments must route each conversation to one owner and avoid overlapping owners during replacement.

### Cloudflare target

Every agent conversation is a Durable Object with its own SQLite storage, so ownership is structural — one live instance per conversation, no lease protocol to operate.

- **Wake on start** — whenever the Durable Object starts (eviction, code deploy, platform reset), Flue flags any attempt running when the previous instance died and reconciles it before serving new work. The platform's fiber-recovery callback triggers the same path.
- **A durable wake schedule** — while unsettled work exists, the object keeps a short self-renewing wake scheduled, so interrupted submissions recover even if no external request arrives. Each wake runs a bounded supervision pass (reconcile, enforce deadlines, start work) and re-arms its successor before doing anything that can fail, so a hung attempt or failed pass delays supervision by at most one wake. Attempt execution runs detached from the wake that started it.
- Abort intents, attempt bookkeeping, and settlement records live in the object's own storage, so an abort requested while the object was evicted is honoured on the next wake.

The durable records and recovery decisions are identical on both targets; only ownership and wake-up differ.

## Related

- [Database](https://flueframework.com/docs/guide/database/) — configure the durable store recovery depends on.
- [Tools › Durable tools](https://flueframework.com/docs/guide/tools/#durable-tools) — the durable-tool walkthrough and full `step.do` rules.
- [Subagents](https://flueframework.com/docs/guide/subagents/) — delegated tasks and what a child session inherits.
- [Agent API › DurabilityConfig](https://flueframework.com/docs/reference/agent-api/#durabilityconfig) — `DurabilityConfig`, agent statics, event-hook contracts.
- [Agent Hooks › Persisted state](https://flueframework.com/docs/guide/agent-hooks/#persisted-state)
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) — the virtual sandbox and remote sandbox adapters.
- [Workflows](https://flueframework.com/docs/guide/workflows/) — driving agents from an external durable engine.
- [Node.js target](https://flueframework.com/docs/guide/node-target/#state-and-durability) · [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/#durable-agent-execution)
- [Observability](https://flueframework.com/docs/guide/observability/) — watch submissions, settlements, and recovery live.
