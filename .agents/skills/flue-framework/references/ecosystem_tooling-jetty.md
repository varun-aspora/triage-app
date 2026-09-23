---
title: Jetty
source: https://flueframework.com/docs/ecosystem/tooling/jetty/
source_command: bunx flue docs read ecosystem/tooling/jetty
flue_version: 2.0.8
section: ecosystem/tooling
---

# Jetty

## Purpose and selection

Jetty grades output produced by a Flue agent and stores the grading task as a
trajectory. Labels on the trajectory can record score, pass/fail, evaluated
configuration, and other comparison dimensions.

Select Jetty when grading should run through a separately deployed Jetty runbook
and results should be retained as comparable trajectories. Select Vitest Evals
instead when assertions and judges should run through a Vitest suite.

Jetty does not have a `flue add` blueprint.

## Prerequisites and environment

Install the SDK with Bun:

```sh
bun add @jetty/sdk
```

The bundled page states that `@jetty/sdk` and Flue's `start()` both require
Node.js. The Bun command above replaces only the documented package-manager
invocation; validate runtime compatibility before using Bun as the script runtime.

| Variable | Requirement and purpose |
| --- | --- |
| `JETTY_API_TOKEN` | Required; authenticates the SDK. |
| `JETTY_COLLECTION` | Required; collection owning the grading task. |
| `JETTY_GRADE_TASK` | Required; deployed grading task identifier. |
| `JETTY_USE_TRIAL_KEYS` | Optional; `true` uses Jetty trial model keys. |

The SDK can also read its token from `~/.config/jetty/token`. The Flue agent's
model-provider credentials remain separate and come from the process environment.

## How to

### 1. Install the SDK

```sh
bun add @jetty/sdk
```

### 2. Create and deploy the grading runbook

Follow Jetty's Flue integration guide to create and deploy a grading runbook.
The runbook must produce the `grade.json` file expected by
`gradeWithJetty(...)`.

Keep the grader separate from the agent under evaluation. Otherwise, changing the
agent can silently change the rubric used to compare it.

### 3. Configure credentials and task identity

Set `JETTY_API_TOKEN`, `JETTY_COLLECTION`, and `JETTY_GRADE_TASK`. Set
`JETTY_USE_TRIAL_KEYS=true` only when the grading task should use Jetty's trial
model keys.

### 4. Create a workflow script

```ts
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { gradeWithJetty, JettyClient } from '@jetty/sdk';
import { Triage } from '../src/agents/triage.ts';

interface TriageGrade {
  total: number;
  pass: boolean;
}

const ticket = process.argv[2] ?? 'Summarize this support request.';
const jetty = new JettyClient();

await using flue = await start({ agents: [Triage] });

const agent = init(Triage, { id: `evaluate-${Date.now()}` });
const receipt = await agent.dispatch(ticket);
const reply = await agent.read(receipt);

const { grade, trajectoryId } = await gradeWithJetty<TriageGrade>(
  jetty,
  process.env.JETTY_COLLECTION!,
  process.env.JETTY_GRADE_TASK!,
  {
    files: [
      {
        filename: 'case.json',
        data: JSON.stringify({ ticket, response: reply.text }),
      },
    ],
    useTrialKeys: process.env.JETTY_USE_TRIAL_KEYS === 'true',
    labels: (result) => ({
      'eval.grade': String(result.total),
      'eval.pass': String(result.pass),
    }),
  },
);

console.log(JSON.stringify({ grade, trajectoryId }, null, 2));
```

### 5. Run and verify

For this Bun-managed workspace, the equivalent script command is:

```sh
bun run scripts/evaluate-triage.ts "Summarize this support request."
```

The upstream page demonstrates execution in Node.js, which is the runtime it
explicitly supports. Confirm that the script prints the expected grade and
trajectory ID, then inspect the Jetty trajectory, labels, and captured content.

## Current APIs and configuration

### Flue execution

```ts
await using flue = await start({ agents: [Triage] });
const agent = init(Triage, { id: `evaluate-${Date.now()}` });
const receipt = await agent.dispatch(ticket);
const reply = await agent.read(receipt);
```

`dispatch(...)` admits the prompt; `read(receipt)` waits for and returns the
agent reply used as grading input.

### Jetty client and grading

```ts
const jetty = new JettyClient();

const { grade, trajectoryId } = await gradeWithJetty<TriageGrade>(
  jetty,
  collection,
  gradeTask,
  options,
);
```

The documented options upload `case.json`, select trial keys from an environment
flag, and derive trajectory labels from the typed grade result.

### Grading a deployed agent

To grade a deployed agent, including a Cloudflare target, prompt it over HTTP
with `@flue/sdk`. Pass the resulting reply into the same
`gradeWithJetty(...)` call from a Node.js process.

### Blueprint command

None. The bundled page explicitly says Jetty does not use a `flue add` blueprint.

## Recommended patterns

- Keep the grading runbook independent of the evaluated agent.
- Give each run a distinct Flue conversation id.
- Type the expected grade returned from `gradeWithJetty<T>()`.
- Label trajectories with stable comparison dimensions.
- Inspect the persisted trajectory after validating console output.
- Use the Agent SDK boundary to grade Cloudflare or another deployment remotely.
- Keep agent credentials separate from Jetty credentials.
- Budget grading cost separately from agent cost: each `gradeWithJetty(...)`
  call runs the deployed runbook's own model call(s) against Jetty's
  infrastructure, so a batch evaluation run pays for two model paths — the
  agent under test and the grader — not one.

## Avoid

- Do not invent a `flue add tooling jetty` command.
- Do not let agent changes silently modify the grading rubric.
- Do not assume `gradeWithJetty(...)` works without a deployed grading task.
- Do not omit the runbook's required `grade.json` output.
- Do not upload raw credentials or sensitive production content as grading files.
- Do not assume the SDK runs inside a Cloudflare Worker.

## Gotchas

### Privacy and content

Jetty trajectories can persist grading files, step inputs, and outputs. Redact
credentials, personal information, and other sensitive data before sending agent
output. Use Jetty secret parameters for runbook credentials, not persisted
initialization parameters or uploaded files. Review retention, access, privacy,
and compliance controls before grading production content.

### Lifecycle and runtime

The local example starts Flue in-process and scopes it with `await using`.
`@jetty/sdk` and `start()` are documented as Node.js requirements. For a deployed
agent, keep grading in a separate Node.js process and call the agent over HTTP.

### Sampling

The bundled Jetty page documents no trace sampling control. `JETTY_USE_TRIAL_KEYS`
selects model keys for the grading task; it is not described as sampling.

### Grading cost

Grading is a separate paid inference path from the agent under test — the
runbook's model call(s) are billed independently of whatever provider credentials
the Flue agent uses. `JETTY_USE_TRIAL_KEYS=true` lets early iteration run against
Jetty's trial model keys instead of your own provider billing, but trial keys
typically carry their own rate or volume limits; confirm the allowance before
scaling to a large batch of runs, and move to production keys once the runbook
is stable.

### Eval stability

The key stability boundary is the separate grading runbook. Keep its rubric and
output contract stable while comparing agent versions. Persist stable labels for
the dimensions being compared, and do not confuse a stored trajectory with a
deterministic assertion. Flue's eval guide remains the source for case design,
deterministic assertions, and model-based judges.

## Related

- [Jetty Flue integration guide](https://docs.jetty.io/docs/agent-integrations/flue)
- [Evals](https://flueframework.com/docs/guide/evals/)
- [Workflows](https://flueframework.com/docs/guide/workflows/)
- [Agent SDK](https://flueframework.com/docs/sdk/overview/)
- [Vitest Evals](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)
- `advanced_evals.md`
- `advanced_workflows.md`
