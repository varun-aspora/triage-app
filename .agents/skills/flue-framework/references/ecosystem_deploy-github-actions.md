---
title: Build Agents for GitHub Actions
source: https://flueframework.com/docs/ecosystem/deploy/github-actions/
flue_version: 2.0.8
nav_section: ecosystem/deploy
verified: 2026-09-17
platform_sources:
  - https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions
  - https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
  - https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
---

# Build Agents for GitHub Actions

## When to choose GitHub Actions

Choose this path when the agent should run once per repository event — an opened issue, a
pushed commit, a PR review request — and report back into the same event, not serve a
standing conversation endpoint. This is `bunx flue run`'s home turf: one agent module, one
message, no build, no port, no listener.

Do not confuse this with deploying the Node or Cloudflare target. A CI job runs the agent
module transport-free and exits; a deployed app builds `dist/` and keeps a server or Worker
up to hold sessions. `flue run` never emulates `app.ts` routing, middleware, provider
registration, or Cloudflare bindings — it loads only the given module and its imports.

## Prerequisites

- `@flue/runtime`, `valibot`, and `@flue/cli` as project dependencies.
- A model provider key stored as a repository or organization secret.
- `local()` from `@flue/runtime/node` for any agent that touches the checkout or shell.
- `GITHUB_TOKEN` (auto-provided) or a PAT if the agent's tools call `gh`.
- A `permissions:` block scoped to what the job actually needs — Flue adds no authorization
  of its own.

## How to run an agent in a workflow

### 1. Create the agent module

```typescript
// src/agents/triage.ts
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function Triage() {
  useModel('anthropic/claude-opus-4-7');
  useSandbox(
    local({
      env: { GH_TOKEN: process.env.GH_TOKEN },
    }),
  );
  return 'When given an issue number, run the `triage` skill on it and report severity, reproducibility, and a summary.';
}
```

`local()` runs the agent's bash tool directly against the runner's checkout and `$PATH`
(`gh`, `git`, `bun`). It inherits only shell-essential env vars by default; anything else —
tokens, keys — must be passed explicitly through `local({ env: { ... } })`. The runner is the
isolation boundary; there is no second sandbox layer under `local()`.

### 2. Test it locally before wiring CI

```bash
bunx flue run src/agents/triage.ts --message "Triage issue #42"
```

`flue run` streams progress to stderr and prints only the final reply to stdout; pass
`--json` for a machine-readable envelope. This is the same execution path the workflow step
will use — no build, no `app.ts`.

### 3. Wire the workflow

```yaml
# .github/workflows/issue-triage.yml
name: Issue Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - name: Run triage agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          bunx flue run src/agents/triage.ts \
            --message "Triage issue #${{ github.event.issue.number }}" \
            --id "issue-${{ github.event.issue.number }}" --json
```

`GITHUB_TOKEN` is minted per run with the permissions the job declares; scope it with the
job-level `permissions:` block rather than relying on the repository default. Add
`ANTHROPIC_API_KEY` (or the provider's expected variable) under **Settings > Secrets and
variables > Actions**.

### 4. Give it structured, deterministic work

Wrap orchestration in a harness-connected tool so branching happens in plain code instead of
free-form model text:

```typescript
useTool({
  name: 'triage-issue',
  description: 'Triage one GitHub issue and auto-fix critical reproducible ones.',
  input: v.object({ issueNumber: v.number() }),
  harness: true,
  async run({ harness, data }) {
    const { data: triage } = await harness.prompt(
      `Apply the triage skill to issue #${data.issueNumber}.`,
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

- The runner's `env:`/`secrets.` context is the only place secrets exist; `local()` does not
  forward them automatically — allow-list each one via `local({ env: { NAME: process.env.NAME } })`.
- Secrets are not passed to workflows triggered from forked-repository pull requests, except
  `GITHUB_TOKEN` — a fork-triggered triage workflow will not see `ANTHROPIC_API_KEY` unless
  the trigger or environment is adjusted deliberately.
- Secrets cannot be referenced in an `if:` conditional; assign them to a job-level env var
  first if a condition needs to depend on one being set.
- Prefer OIDC over long-lived cloud credentials if the agent's tools call AWS, GCP, or Azure.
- If a tool must use a token without the model ever seeing it, wrap the call in `useTool(...)`
  and read `process.env` inside the tool implementation instead of exposing the value to the
  sandbox at all.

## Conversation continuity

`flue run` persists conversation state to the project's configured database when `db.ts` is
present, otherwise to `node_modules/.cache/flue/run.db` — a per-checkout, per-runner path.
Give recurring automations a stable `--id` derived from the triggering event (`issue-42`) so
a retried or re-triggered run continues the same conversation rather than starting a new one;
add `--new` when accidental continuation should fail loudly instead. Do not rely on that
cache to survive between separate jobs, matrix shards, or workflow runs — each checkout
starts clean unless you restore it (for example with `actions/cache`) or point `db.ts` at a
real external database.

## Recommended patterns

- Scope `permissions:` per job to the minimum the agent's tools need.
- Allow-list secrets into `local({ env: { ... } })` one variable at a time; never spread
  `process.env` wholesale into the sandbox.
- Set `timeout-minutes` on the job so a stuck model loop or hung tool call can't run indefinitely.
- Use `--json` plus the process exit code (`0` completed, `1` failed, `130` aborted) to
  branch later workflow steps on outcome.
- Pin `actions/checkout`, `oven-sh/setup-bun` (or `actions/setup-node`), and the `@flue/*`
  package versions together.
- Give a tighter boundary to any single sensitive operation with `useTool(...)` instead of
  handing the whole token to `local()`.

## Avoid

- Do not expect `src/app.ts` routes, middleware, or provider registration to load — `flue run`
  imports only the given module.
- Do not import `cloudflare:*` bindings in a module run this way; validate Worker-only code
  with `vite dev`, not `flue run`.
- Do not pass secrets as bare CLI arguments; keep them in `env:` and reference them as shell
  variables so they don't appear in process listings or `if:` conditions.
- Do not treat `--uid` as a delivery idempotency key — it only guards which conversation
  incarnation a read attaches to. Use a stable `idempotencyKey` on `dispatch()` (see
  `advanced_durability.md`) for at-most-once tool effects.
- Do not assume a fork-triggered workflow has the same secrets as a same-repo run.

## Gotchas

- A module exporting more than one agent has no silent default; pass `--name`.
- `local()`'s default env allow-list is shell essentials only (`PATH`, `HOME`, locale) — a
  CLI failing with a missing-token error almost always means the variable wasn't forwarded.
- The default `flue run` cache is local development storage, not a durable production
  database; recovery across process restarts still needs a configured `db.ts`.
- A successful admission can execute tool work at least once under recovery — keep externally
  visible effects (opening a PR, posting a comment) idempotent.
- `GITHUB_TOKEN`'s effective permissions come from the workflow's `permissions:` block (or
  the repository/organization default when omitted) — an over-broad default is a common
  source of a triage workflow having more access than intended.

## Related

- [Deploy overview](https://flueframework.com/docs/guide/deploy/)
- [Workflows](https://flueframework.com/docs/guide/workflows/)
- [`flue run`](https://flueframework.com/docs/cli/run/)
- [GitLab CI/CD](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
- [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [Docker](https://flueframework.com/docs/ecosystem/deploy/docker/)
