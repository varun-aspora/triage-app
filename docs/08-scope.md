# 08. Scope: what v1 is, what comes later, what never

"v1" in these docs means the first release that a human on the NRI banking on-call uses instead of the triage-shivalik workspace. Anything not in the v1 column is not built until a decision moves it. This table is the single place to look; decision ids point at the reasoning.

## In v1

| Area | What ships | Decisions |
|---|---|---|
| Runtime | Flue 2.x agent service on Node, Bun for scripts, one `.env` per deployment, `TRIAGE_DEPLOY_MODE=local\|server` read only by pre-flight | D1, D4, D18, D32 |
| Ingress | CLI (`run`, `start`, `wait`, `status`, `ask`, `post`, `feedback`, `doctor`, `preflight`, `tunnel`, `repos sync`, `fixtures review`, `evals`), HTTP API (polling only, bearer auth, no Slack post by default), Claude Code / Codex skill that drives the CLI | D12, D25, D28 |
| Identity and classification | Deterministic ID-chain resolution in ingress, classifier on a configurable model, deterministic tier policy including the image-capable fallback | D9, D22, D36 |
| Orchestration | `Triage` root agent, `investigate_<entity>` and `_deep` per enabled entity, `code_walker` on CodeGraph, deterministic escalation and strong-model synthesis; one Flue sandbox (`virtual` default, `e2b`/`daytona` by config) inherited by all delegates | D3, D10, D11, D23, D45 |
| Entities | SSFB, ATSPL, RTL, each with DBs, admin APIs (GET-only by default), Quickwit over `qw` or HTTP per entity; SSFB adds statement and reversal tools, AES-SIV field encrypt/decrypt, and `cbs_call` behind its flag | D5, D14, D21, D29, D34, D40, D44 |
| Gate | Per-entity `api.rules.json` (ships empty), SQL parser + `BEGIN READ ONLY` + `SET LOCAL` timeouts, scope rule, budgets, two redaction profiles, JSONL audit with `transport` | D7, D8, D20, D24, D26, D31, D33 |
| Mock and fixtures | Mock mode default on, strict misses, fixtures promoted by a human | D19, D27 |
| Output | Report JSON + Markdown with `status`, `cx_answer`, `suggested_fix` (commands for a human, never executed) | D35 |
| Approval | `TRIAGE_APPROVAL_MODE=cli`; Slack post only after confirmation | D13, D39 |
| Persistence | Flue DB on sqlite or Postgres; run store on the same DSN with pgvector, or folder provider on sqlite; embeddings on `MODEL_EMBEDDING`; `TRIAGE_PRIOR_CASES` off by default | D38, D43 |
| Evals | `bun test` unit, Vitest contract tests with the fake model, promptfoo classifier suite | D42 |
| Ops | Doctor, pre-flight, `resources/repos.json` pinned branches | D32, D37 |

## Later (designed for, not built in v1)

| Area | Trigger to build | Decisions |
|---|---|---|
| promptfoo full-Triage suite (suite 2) | recorded fixtures exist from real runs | D42 |
| Prior-case retrieval switched on | an eval shows it helps | D43 |
| Slack bot ingress with Yes / No / Comment approval buttons | after v1 is in use | D17, D39 |
| Batch / cohort status mode | a request for it | D17 |
| Self-learning proposals (`triage learn`) | proposal P4 decided | pending |
| Repo test and lint runs in the sandbox | a case needs it; needs a remote backend with the repo staged | D45 |
| GitHub repo tooling beyond clone/sync | proposal P5 decided | pending |

## Never

| Item | Why |
|---|---|
| Executing remediation writes (trigger-delivery, sync-address, force-sign, DB updates) | read-only triage; the report recommends, a human acts | D17, D35 |
| A host shell, `curl` to a host, `psql`, `git`, `kubectl`, `ssh` or Flue's `local()` sandbox for the model | the gate rests on typed tools; the only shell is the isolated sandbox | D2, D45 |
| Slack write as an agent tool | approval must be proven by the channel that granted it | D13 |
| Code branching on an environment name | one `.env` per deployment | D4 |
| Serena, code-review-graph, headroom, ClickUp, Grafana via Playwright | dropped by the owner | D41 |
