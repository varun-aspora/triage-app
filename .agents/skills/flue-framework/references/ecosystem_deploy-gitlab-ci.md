---
title: Build Agents for GitLab CI/CD
source: https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://docs.gitlab.com/ee/ci/variables/
  - https://docs.gitlab.com/ee/ci/triggers/
  - https://docs.gitlab.com/ee/ci/yaml/
---

# Build Agents for GitLab CI/CD

## When to choose GitLab CI/CD

Choose this path when the agent should run once per pipeline — triggered by an issue, a
merge request, or a scheduled pipeline — and report back into that event, not serve a
standing conversation endpoint. This is `bunx flue run`'s home turf: one agent module, one
message, no build, no port, no listener.

Do not confuse this with deploying the Node or Cloudflare target. A pipeline job runs the
agent module transport-free and exits; a deployed app builds `dist/` and keeps a server or
Worker up to hold sessions. `flue run` never emulates `app.ts` routing, middleware, provider
registration, or Cloudflare bindings — it loads only the given module and its imports.

## Prerequisites

- `@flue/runtime`, `valibot`, and `@flue/cli` as project dependencies.
- A model provider key stored as a masked CI/CD variable.
- `local()` from `@flue/runtime/node` for any agent that touches the checkout or shell.
- A project or personal access token with `api` scope if the agent's tools call the GitLab
  API (`glab`, issue notes, merge request updates) — `CI_JOB_TOKEN`'s scope is narrower and
  may not cover those calls depending on what your project allow-lists.
- A pipeline trigger token if the pipeline must react to an event GitLab doesn't feed into CI
  variables directly, such as an issue webhook.

## How to run an agent in a pipeline

### 1. Create the agent module

```typescript
// src/agents/triage.ts
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function Triage() {
  useModel('anthropic/claude-opus-4-7');
  useSandbox(
    local({
      env: { GITLAB_TOKEN: process.env.GITLAB_TOKEN },
    }),
  );
  return 'When given an issue IID, run the `triage` skill on it and report severity, reproducibility, and a summary.';
}
```

`local()` runs the agent's bash tool directly against the runner's checkout and `$PATH`
(`glab`, `git`, `bun`). It inherits only shell-essential env vars by default; anything else —
tokens, keys — must be passed explicitly through `local({ env: { ... } })`. The runner is the
isolation boundary; there is no second sandbox layer under `local()`.

### 2. Test it locally before wiring CI

```bash
bunx flue run src/agents/triage.ts --message "Triage issue !42"
```

`flue run` streams progress to stderr and prints only the final reply to stdout; pass
`--json` for a machine-readable envelope. This is the same execution path the pipeline job
will use — no build, no `app.ts`.

### 3. Bridge issue events into pipeline variables

GitLab does not pass issue payloads into CI variables automatically. A pipeline trigger token
plus a small webhook relay bridges the gap: a project webhook on **Issue events** calls the
trigger API with the fields the job needs.

```bash
curl --request POST --form token="$TRIGGER_TOKEN" --form ref=main \
  --form "variables[ISSUE_ACTION]=open" \
  --form "variables[ISSUE_IID]=42" \
  --form "variables[ISSUE_AUTHOR]=octocat" \
  "https://gitlab.example.com/api/v4/projects/$CI_PROJECT_ID/trigger/pipeline"
```

Create the trigger token under **Settings > CI/CD > Pipeline trigger tokens**. GitLab's
inputs mechanism (`inputs:`) is the newer, validated way to parameterize a pipeline and is
worth preferring over ad hoc trigger variables for anything beyond a quick relay.

### 4. Wire the pipeline

```yaml
# .gitlab-ci.yml
triage:
  image: oven/bun:1
  timeout: 30 minutes
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger" && $ISSUE_ACTION == "open"
  before_script:
    - bun install --frozen-lockfile
  script:
    - |
      bunx flue run src/agents/triage.ts \
        --message "Triage issue !$ISSUE_IID in project $CI_PROJECT_ID" \
        --id "issue-$ISSUE_IID" --json
```

Add these as masked CI/CD variables under **Settings > CI/CD > Variables**:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Authenticates calls to the model provider. |
| `GITLAB_TOKEN` | Project or personal access token (`api` scope) the agent's tools use for `glab`/API calls. |

The job-level `timeout` keyword accepts a human-readable duration such as `30 minutes` or
`1 hour` and overrides the project-wide default for this job only.

### 5. Give it structured, deterministic work

Wrap orchestration in a harness-connected tool so branching happens in plain code instead of
free-form model text:

```typescript
useTool({
  name: 'triage-issue',
  description: 'Triage one GitLab issue and auto-fix critical reproducible ones.',
  input: v.object({ issueIid: v.number() }),
  harness: true,
  async run({ harness, data }) {
    const { data: triage } = await harness.prompt(
      `Apply the triage skill to issue !${data.issueIid}.`,
      {
        result: v.object({
          severity: v.picklist(['low', 'medium', 'high', 'critical']),
          reproducible: v.boolean(),
        }),
      },
    );
    return { output: triage };
  },
});
```

See `guides_tools.md` for harness tools, `guides_skills.md` for the `.agents/skills/`
format the agent reads from its sandbox, and `guides_subagents.md` for delegating a
sub-task (e.g. a dedicated reviewer) via `useSubagent()`.

## Environment and secrets

- CI/CD variables are the only place secrets exist; `local()` does not forward them
  automatically — allow-list each one via `local({ env: { NAME: process.env.NAME } })`.
- Mark provider keys and tokens **Masked** (and **Protected** if only protected
  branches/tags should see them). A masked value must be a single line with no line breaks
  and generally needs to be at least 8 characters — a short or multi-line secret cannot be
  masked and GitLab will refuse to save it as such.
- `CI_JOB_TOKEN` is automatically available and scoped for GitLab-internal operations
  (downstream pipelines, package/container registry, an allow-listed set of API endpoints).
  Do not assume it covers arbitrary `glab`/API calls a triage agent needs, such as posting
  issue notes — use a masked access token with `api` scope instead, as above.
- Prefer the pipeline `inputs:` mechanism over trigger `variables` for anything beyond a thin
  webhook relay; it validates shape and is documented as the safer parameterization path.

## Conversation continuity

`flue run` persists conversation state to the project's configured database when `db.ts` is
present, otherwise to `node_modules/.cache/flue/run.db` — a per-checkout, per-runner path.
Give recurring automations a stable `--id` derived from the triggering event (`issue-42`) so
a retried or re-triggered pipeline continues the same conversation rather than starting a new
one; add `--new` when accidental continuation should fail loudly instead. Do not rely on that
cache to survive between separate jobs or pipeline runs — each job starts from a clean
checkout unless you restore GitLab CI cache/artifacts or point `db.ts` at a real external
database.

## Recommended patterns

- Mask and, where possible, protect provider keys and API tokens; never put them in
  `variables:` as plaintext.
- Allow-list secrets into `local({ env: { ... } })` one variable at a time; never spread
  `process.env` wholesale into the sandbox.
- Set a job-level `timeout` so a stuck model loop or hung tool call can't run indefinitely.
- Use `--json` plus the process exit code (`0` completed, `1` failed, `130` aborted) to
  branch later pipeline stages on outcome.
- Prefer `inputs:` over ad hoc trigger `variables` when a webhook relay needs to pass more
  than a couple of fields into the pipeline.
- Give a tighter boundary to any single sensitive operation with `useTool(...)` instead of
  handing the whole token to `local()`.

## Avoid

- Do not expect `src/app.ts` routes, middleware, or provider registration to load — `flue run`
  imports only the given module.
- Do not import `cloudflare:*` bindings in a module run this way; validate Worker-only code
  with `vite dev`, not `flue run`.
- Do not rely on `CI_JOB_TOKEN` alone for API calls the agent's tools make; check its scope
  before assuming it can post comments or update issues.
- Do not treat `--uid` as a delivery idempotency key — it only guards which conversation
  incarnation a read attaches to. Use a stable `idempotencyKey` on `dispatch()` (see
  `advanced_durability.md`) for at-most-once tool effects.
- Do not put unmasked provider keys or tokens in `.gitlab-ci.yml` or trigger `variables`.

## Gotchas

- A module exporting more than one agent has no silent default; pass `--name`.
- GitLab does not forward issue/MR payloads into CI variables on its own — a pipeline trigger
  plus webhook relay (or an equivalent integration) is required to react to those events.
- `local()`'s default env allow-list is shell essentials only (`PATH`, `HOME`, locale) — a
  CLI failing with a missing-token error almost always means the variable wasn't forwarded.
- The default `flue run` cache is local development storage, not a durable production
  database; recovery across process restarts still needs a configured `db.ts`.
- A successful admission can execute tool work at least once under recovery — keep externally
  visible effects (pushing a branch, posting a note) idempotent.
- A masked variable that is too short, multi-line, or otherwise fails GitLab's masking rules
  cannot be saved as masked; you'll be prompted to fix the value, not warned silently.

## Related

- [Deploy overview](https://flueframework.com/docs/guide/deploy/)
- [Workflows](https://flueframework.com/docs/guide/workflows/)
- [`flue run`](https://flueframework.com/docs/cli/run/)
- [GitHub Actions](https://flueframework.com/docs/ecosystem/deploy/github-actions/)
- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
