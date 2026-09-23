---
title: Skills
source: https://flueframework.com/docs/guide/skills/
section: guides
---

# Skills (Flue guide)

## What it is

A skill packages reusable expertise — markdown instructions, optionally with supporting files — that an agent loads only when it needs it. Where a tool executes application code, a skill teaches a procedure. Skills follow the open [Agent Skills](https://agentskills.io) format, so a Flue skill works in other harnesses that speak the format, and third-party skills drop in unchanged.

Skills are progressively disclosed: each mounted skill costs one always-present catalog line (name + description) in the system prompt and nothing more until the model decides the task matches. It then activates the skill, receives the full instructions, and reads supporting files only as needed.

Every skill has three parts: `name` (short identifier the model uses to activate it), `description` (one or two sentences: what it does *and when to use it* — the only part the model always sees, so it carries the whole routing decision), and `instructions` (the full procedure, loaded on activation).

## API surface

### Skill directory on disk

A skill is a directory containing `SKILL.md`. Frontmatter holds name and description; the markdown body is the instructions. Anything else in the directory is a supporting file.

```text
src/skills/refunds/
├─ SKILL.md        # frontmatter + instructions
└─ POLICY.md       # supporting file, loaded only if read
```

```markdown
---
name: refunds
description: Process a customer refund request end-to-end. Use when a customer asks for a refund or disputes a charge.
---

Follow this procedure for every refund request:

1. Confirm the order ID and the reason for the refund.
2. Read `POLICY.md` and check the eligibility rules for that reason.
3. If eligible, issue the refund with the `issue_refund` tool and confirm the amount to the customer.
4. If not eligible, explain which rule applies and offer the alternatives listed in the policy.
```

### Frontmatter fields

Flue validates every `SKILL.md` against the [Agent Skills specification](https://agentskills.io/specification), whether imported or discovered in a workspace:

- `name` (required) — lowercase letters, numbers, hyphens; no leading, trailing or consecutive hyphens; at most 64 characters; must match the skill directory name.
- `description` (required) — non-empty, at most 1024 characters.
- `license` (optional) — accepted; informational only.
- `compatibility` (optional) — accepted; at most 500 characters; informational only.
- `metadata` (optional) — string-to-string mapping; not interpreted by Flue.
- `allowed-tools` (optional) — accepted, **not enforced**. Experimental in the spec; Flue does not restrict the session's toolset.

Unknown frontmatter fields are ignored, so skills carrying host-specific fields still load. The spec's [skills-ref validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) flags unknown fields for stricter authoring checks.

### Import and mount: `useSkill`

Import `SKILL.md` by module specifier. At build time Flue recognizes the import, validates the frontmatter, and packages the whole directory with the application. The import's value is a typed `SkillReference`; mount it with `useSkill`.

```ts
'use agent';
import { useModel, useSkill } from '@flue/runtime';
import refunds from '../skills/refunds/SKILL.md';

export function SupportAgent() {
  useModel('anthropic/claude-haiku-4-5');
  useSkill(refunds);
  return 'Answer customer support questions clearly and accurately.';
}
```

From a package, the same way:

```ts
import review from '@acme/review-skills/review/SKILL.md';
```

The package must publish `SKILL.md` and its supporting files; if it defines package exports, it must export the imported `SKILL.md` subpath.

Signature (Agent Hooks API):

```ts
function useSkill(skill: Skill): void;

type Skill = SkillReference | SkillDefinition;

interface SkillReference {
  readonly __flueSkillReference: true;
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
```

There is no registration step and no runtime file copying — the import is the declaration, and it works in the dev server, `vite build`, and `flue run`. Type declarations for `SKILL.md` and `.md` imports ship with `@flue/runtime`. In dev, editing any file in the skill directory is picked up automatically.

### Inline skills: `defineSkill`

```ts
function defineSkill(definition: SkillDefinition): SkillDefinition;

interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
}
```

```ts
import { defineSkill } from '@flue/runtime';

export const escalation = defineSkill({
  name: 'escalation',
  description:
    'Escalate an unresolved case to a human specialist. Use when the customer asks for a human or the issue is out of scope.',
  instructions:
    'Summarize the case so far, tag the conversation with the escalation reason, and hand off with the `escalate_case` tool.',
});
```

With supporting files:

```ts
const reviewSkill = defineSkill({
  name: 'review-pr',
  description: 'Review a pull request against the team checklist. Use when asked to review code.',
  instructions: 'Read CHECKLIST.md, then review the diff against every item.',
  files: { 'CHECKLIST.md': checklistText },
});
```

Field constraints (Agent API):

- `name` — lowercase ASCII letters, numbers, single hyphens only; at most 64 characters. Required.
- `description` — the catalog line; at most 1024 characters. Required.
- `instructions` — loaded on activation. Required, non-empty — an empty definition is rejected rather than mounted as an empty catalog line.
- `license`, `compatibility` — optional strings recorded in the packaged frontmatter (`compatibility` at most 500 characters).
- `metadata` — string-to-string map recorded in frontmatter.
- `allowedTools` — space-separated pre-approved tools (experimental in the spec).
- `files` — supporting resources keyed by path relative to the skill root. Paths must be safe relative paths (no leading `/`, no `.`/`..` segments, no backslashes) and must not be `SKILL.md` itself. Content is `string` or `Uint8Array`.

`defineSkill` validates and returns the definition frozen — no packaging at definition time. Invalid definitions throw `SkillDefinitionValidationError` with field-level issues, at module load. The runtime packages the definition lazily, the first time the skill is needed, into the same shape a `SKILL.md` import produces, writing spec-valid frontmatter itself (so `instructions` stays plain markdown).

### Converting plain markdown

A bare `.md` import loads as a plain string — nothing is packaged — so pass it through `defineSkill` to make it a skill:

```ts
import { defineSkill } from '@flue/runtime';
import runbook from './incident-runbook.md'; // plain markdown text

export const incidents = defineSkill({
  name: 'incidents',
  description:
    'Run the incident response procedure. Use when an outage or security event is reported.',
  instructions: runbook,
});
```

`useSkill(...)` also accepts a definition object written directly in the call, with the same validation.

### Runtime tools the framework adds

- `activate_skill` — present whenever the agent has skills. The model calls it with the skill's name and receives the full instructions as the tool result.
- `read_skill_resource` — added whenever a mounted skill carries supporting files.

Both names are framework-reserved; a custom tool cannot take them.

### Workspace discovery

For an agent with a sandbox, at session start the runtime scans `.agents/skills/` in the sandbox's working directory. Every valid `<name>/SKILL.md` joins the catalog alongside declared skills — no import, no `useSkill(...)` call.

```text
<cwd>/.agents/skills/
└─ greet/
   └─ SKILL.md
```

## Recommended use cases

- A procedure the agent should follow only sometimes: refunds, PR review, incident response, onboarding steps.
- Bulky reference material (policies, checklists, templates) that would bloat every turn if folded into instructions.
- Expertise that ships with a repository checkout, CI environment or prepared workspace, so any agent working there picks it up (`.agents/skills/`).
- Third-party or cross-harness expertise, since the format is the open Agent Skills spec.
- Capability unlocked mid-conversation: gate the mount on state.

## Patterns

**Steer activation from instructions.** Because activation is a tool call, the prompt can direct it:

```ts
useSkill(refunds);
return 'Activate the `refunds` skill before handling any refund request.';
```

The same steering works from application code: a [harness tool](https://flueframework.com/docs/guide/tools/#harness-tools)'s `harness.prompt(...)` runs with the agent's rendered configuration — same system prompt, skill catalog and tools — so naming the skill in the prompt text is enough for the model to activate it there too, workspace-discovered skills included.

**Conditional mount.** Mounts can be conditional, like every resource hook — gate `useSkill(...)` on [persistent state](https://flueframework.com/docs/guide/agent-hooks/#persisted-state) to unlock a skill mid-conversation. The runtime announces catalog changes to the model as `resources` signals without invalidating the cached prompt.

**Thin SKILL.md, fat supporting files.** Keep `SKILL.md` focused on the procedure and move bulky reference material into supporting files the instructions point at (`Read POLICY.md ...`).

**Description carries the routing.** State the capability and the trigger ("Use when…"); it is the only text the model sees before activating.

## When to use / when NOT to use

Use a skill when the agent needs a procedure or reference only some of the time, and you want it out of the prompt until then.

Do **not** use a skill when:

- **The agent should always have the content.** Import the markdown as a string (any `.md` import loads as text) and fold it into your instructions, or pass it to [`useInstruction(...)`](https://flueframework.com/docs/reference/agent-hooks-api/#useinstruction).
- **The capability is executable application code.** Use a [tool](https://flueframework.com/docs/guide/tools/): the model decides when to call, your code decides what happens. A skill only teaches a procedure.
- **You want the whole procedure run elsewhere, in its own context.** Use a [subagent](https://flueframework.com/docs/guide/subagents/) — delegate the procedure to a specialist agent instead of teaching it.
- **The expertise belongs to the workspace, not the app.** Use workspace skills (`.agents/skills/`) rather than a declared import; use declared skills when the expertise belongs to your application.

## Gotchas & constraints

- Skill imports must be **static**. A dynamic `import('./skills/x/SKILL.md')` is a build error.
- Each skill name mounts **once per render**; mounting the same name twice throws.
- Packaging skips repository noise (`node_modules`, `.git`, `dist` and similar), warns on files over 1MB, and **refuses to package secrets** — `.env` files, private keys, credential stores and symbolic links are hard errors.
- `allowed-tools` / `allowedTools` is accepted but not enforced; Flue does not restrict the session's toolset.
- `name` must match the skill directory name.
- A bare `.md` import is just a string — it is not a skill until passed through `defineSkill`.
- Supporting files travel inside the **application bundle, not the agent's workspace**. Nothing is copied into the sandbox: the runtime serves each file read-only at a virtual path, and the activation briefing lists every resource with the exact path. The agent can never accidentally edit its own skill content. The same bundle serves the same files on your laptop, in Node.js, or on Cloudflare — no per-environment filesystem setup.
- Activation never changes the system prompt: instructions arrive as a tool result, so the provider's cached prompt prefix survives. Activating an unknown name is not an error — the result lists the available skills.
- Workspace skills stay in the workspace: their instructions are read from disk **at activation time** (mid-session edits are picked up), and their supporting files are ordinary workspace files the model reads directly.
- A malformed workspace `SKILL.md` is skipped with a warning rather than failing the session; imported skills are validated strictly at build time.
- A workspace skill whose name collides with a declared skill is an error.
- Workspace discovery requires a sandbox.

## Related

- [Agent Skills specification](https://agentskills.io/specification) — the full `SKILL.md` format, shared across compatible harnesses.
- [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/) — how `useSkill` composes with the rest of an agent's capabilities.
- [Agent Hooks API — useSkill](https://flueframework.com/docs/reference/agent-hooks-api/#useskill)
- [Agent API — defineSkill](https://flueframework.com/docs/reference/agent-api/#defineskill) and [SkillDefinition](https://flueframework.com/docs/reference/agent-api/#skilldefinition)
- [Agent API — Dynamic resources](https://flueframework.com/docs/reference/agent-api/#dynamic-resources)
- [Tools](https://flueframework.com/docs/guide/tools/) — executable application capabilities, and when a tool beats a skill.
- [Subagents](https://flueframework.com/docs/guide/subagents/) — delegate a whole procedure to a specialist agent.
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) — the workspace where workspace skills are discovered.
