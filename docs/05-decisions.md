# 05. Decisions, rejected options, assumptions

Append-only. When a decision is reversed, add a new entry that supersedes it; do not edit history. Each decision names the option we did **not** take so the same debate is not repeated.

## Decisions

### D1. Runtime: Flue 2.x, with pi-ai as its provider layer
- **Chosen**: `@flue/runtime` for the agent loop, subagents, skills, HTTP routing, durability, `flue`-style CLI driving via `start()`/`init()`, Slack channel later.
- **Rejected**: (a) hand-rolled host on `@earendil-works/pi-agent-core`: would have to build HTTP, durability, subagents, skills and Slack ourselves; its one advantage, a native `beforeToolCall` argument-level gate, is replaced by D2. (b) pi coding-agent (`@earendil-works/pi-coding-agent`) with an extension: it is an interactive coding CLI, not a service; no HTTP, no Slack; not installed.
- **Why**: survey 07 comparison table. Everything the interfaces need already exists in Flue.
- **Consequence**: Flue is a Vite app and its evals are Vitest. The repo's Bun-only rule is amended (D18).

### D2. Gating lives inside tools and in what is mounted; no shell for the model
- **Chosen**: typed tools only. Each I/O tool calls a shared pure gate module before any network. Nothing generic (`bash`, `curl`, `psql`, file write) is mounted. No `useSandbox`. An `instrument()` interceptor denies unexpected tool names as a tripwire.
- **Rejected**: (a) porting the `PreToolUse` hook idea: there is no shell to hook. (b) Flue `useSandbox(local())` with a custom `SandboxToolFactory` for read-only file tools: `local()` "is not an isolation boundary" and the six built-in tools would have to be replaced anyway; simpler to write `repo_read`/`repo_grep` as plain tools with a path jail. (c) relying on pi-agent-core `beforeToolCall`: Flue does not surface it.
- **Why**: the current hook self-describes as an accident-stopper; the live allowlist drifted to 67 entries including `python3 *`. Gates owned by code are testable and do not drift.

### D3. Entity is a closure, not a parameter
- **Chosen**: one investigator subagent per enabled entity; its tools are constructed with the entity fixed. The orchestrator has no entity I/O tools.
- **Rejected**: a single investigator with an `entity` argument. It makes cross-entity leakage a one-token mistake and gives the model a wider surface for no benefit.
- **Consequence**: cross-entity reasoning happens only in the orchestrator, from summaries. Briefs must be complete because delegates do not inherit history.

### D4. One `.env` per deployment; names never encode the environment
- **Chosen**: `<ENTITY>_<SERVICE>_DB_URL`, `<ENTITY>_<SERVICE>_API_URL`, `<ENTITY>_QUICKWIT_*`, `SSFB_CBS_*`, `MODEL_*`, `TRIAGE_*`. `TRIAGE_ENV_LABEL` is display-only.
- **Rejected**: keeping `_DEBUG_`/`_STAGE_`/`_UAT_` infixes or `--env` flags. Also rejected: deriving structure purely by scanning env var names (fragile; a typo silently drops a service). Structure lives in `resources/<entity>.entity.json` (D5).
- **Why**: your brief; survey 03 §1 shows env and tenant were only lookup keys anyway.

### D5. Small per-entity registry file for structure
- **Chosen**: `resources/<entity>.entity.json` maps services to env var names, Quickwit `service` field values and repos. Loader fails at startup if a listed var is missing.
- **Rejected**: (a) generating it from `.env` (see D4); (b) hardcoding in TypeScript (harder for non-developers to review in a PR).

### D6. Allowlist: your `[{api, source}]` shape plus `methods`, `match`, `reason` — **superseded by D31**
- **Chosen**: `resources/<entity>.allow.api.json`, entries `{api, source, methods?=["POST"], match?="prefix", reason}`. `source` resolves to a base-URL env var, which is the host binding. `reason` is required.
- **Rejected**: the bare `{api, source}` form. The current file's own comment explains why: a path without a host binding lets the same path on another host through, and one existing entry uses an exact path on purpose so sibling mutating endpoints stay blocked. Dropping `methods`, `match` and `reason` would weaken the gate and lose review context.
- **Migration**: the four Shivalik entries move to `ssfb.allow.api.json`. ATSPL and RTL start empty.

### D7. SQL guard is a parser, not a regex
- **Chosen**: parse with a Postgres parser; accept one `SELECT`/`WITH…SELECT`; deny a function list; wrap `LIMIT`; server-side `$n` parameters; `default_transaction_read_only=on` and `statement_timeout` per connection.
- **Rejected**: porting `safe_sql.sh`'s keyword regex. It false-positives on identifiers (`last_update`), strips `--` inside literals, and its `-v` binding under `psql -c` is probably broken.
- **Still wanted, not ours to do**: read-only Postgres roles server-side (Q6).

### D8. HTTP: the model gives a path, never a URL
- **Chosen**: `http_get({service, path, query, customer_id})` builds the URL from the registry; `http_call_allowlisted` for the allowlisted non-GETs. `x-customer-id` set when known.
- **Rejected**: exposing a curl-like tool with option parsing (today's `safe_curl` spends 200 lines validating curl flags).

### D9. Classification is a code-driven step before dispatch, on a configurable model
- **Chosen**: `src/classify` calls `MODEL_CLASSIFIER` via pi-ai with structured output; a deterministic policy finalises the tier; the result is passed as `initialData`, and `Triage` picks its model from it.
- **Rejected**: (a) a separate Flue `Classifier` agent: doubles durable conversations per request for a one-second call. (b) letting the orchestrator classify itself: it would already be running on some model, defeating the purpose. (c) a `harness: true` tool inside Triage: the harness only exists inside an agent session, so the orchestrator's model would already be fixed.
- **Fail direction**: uncertainty routes **up** to the strong tier.

### D10. Escalation within a run is by delegation, not by switching models
- **Chosen**: `deep_investigator` subagent on `MODEL_TIER_STRONG`, always mounted; the method skill says when to use it.
- **Why**: Flue's `useModel` is submission-scoped; the model cannot change mid-run. Subagent `model` overrides can.
- **Rejected**: re-dispatching a new submission on a stronger model (loses tool-call history; doubles cost).

### D11. Code navigation: CodeGraph CLI via `execFile`, repo enum, plus jailed read/grep
- **Chosen**: `code_explore/node/callers/impact` wrap the CLI with `-p repos/<repo>`; `repo_read`/`repo_grep` under a realpath jail. Optional `codegraph sync` once per repo per run.
- **Rejected**: (a) Flue `useMcpConnection` to `codegraph serve --mcp`: Flue supports only `streamable-http`/`sse`, the server is stdio. (b) mounting the whole repos directory through a sandbox (D2). (c) running `git-clone.sh` in the request path: needs SSH to GitHub and ~50s.
- **Why**: survey 01 §5. CLI output for `explore`/`node` is identical to the MCP tools.

### D12. Claude Code / Codex integration is a skill that calls the CLI or HTTP, not an MCP server
- **Chosen**: a `SKILL.md` in this repo. Posting to Slack goes through `triage post <run_id>`, which asks for confirmation.
- **Rejected**: exposing the agent as an MCP server. Not documented for Flue; adds a second protocol to maintain for a benefit the CLI already gives. Revisit if a coding agent needs streaming.

### D13. Slack write is never an agent tool
- **Chosen**: ingress code paths only (`triage post`, `POST /triage/:id/post-to-slack`), always behind explicit approval. Reviewer handle and fallback group come from `.env`.
- **Rejected**: a `slack_post` tool with an "ask first" instruction. Prompt rules are not enforcement.

### D14. CBS direct read via bastion + kubectl stays, behind `SSFB_CBS_VIA_KUBECTL_ENABLED`
- **Chosen**: `cbs_read` mounted only when the flag is true; GET only; paths from the SSFB allow file (`source: finacle`); token passed on stdin and cached under `.data/cache`; k8s namespace, selector, container, secret and OAuth scope all from `.env`.
- **Rejected**: keeping `cbs_curl_via_eventbus.sh` as-is: token in argv on three hosts, writes the token into `.env`, heredoc quoting allows injection, denylist for extra args.
- **Closed 2026-09-23 (Q4)**: the OAuth mint is tool infrastructure, cache under `.data/cache`. Kube context and AWS profile are per entity (`<ENTITY>_KUBE_CONTEXT`, `<ENTITY>_AWS_PROFILE`, registry `kube` block); the login runs in pre-flight (D32), not in the tool.

### D15. The SSFB SSH tunnel is operator-managed — **superseded by D32 for local mode**
- **Chosen originally**: `triage doctor` reports tunnel status; `triage tunnel up` exists for laptops; the request path only checks reachability.
- **Now**: in `TRIAGE_DEPLOY_MODE=local`, pre-flight starts the tunnel before a real run (the process is owned by the CLI/server process, not a tool call). In `server` mode the original rule stands: infra owns it.
- **Still rejected**: starting `ssh -L` inside a tool call.

### D16. Knowledge is copied into this repo as Flue skills and fixed here
- **Chosen**: `knowledge/**` ported from triage-shivalik, contradictions resolved or marked unverified, Claude-Code wording removed.
- **Rejected**: reading the triage-shivalik CLAUDE.md tree at runtime by path. The files are mid-migration (root `CLAUDE.md` deleted, `.Codex` paths), contain 20+ contradictions, and reference wrappers that will not exist.
- **Cost**: two copies until triage-shivalik is retired. Accepted.

### D17. v1 scope is single-request, read-only triage
- **Deferred to v2**: batch/cohort status (DocketHub lists), Slack bot ingress, screenshot OCR beyond passing images to a multimodal model.
- **Refined 2026-09-23 (Q10, Q11)**: cohort is an ordinary SSFB service (DB, GET API, repo `cohort-service`) that any investigation may read; there is no separate batch mode. Incident impact analysis runs only when the request asks for it (classifier category `systemic`), not as a default step.
- **Never in scope**: executing remediation writes. They appear only under `suggested_fix` in the report (D35).

### D18. Toolchain: Bun for package management and scripts; Vite/Vitest where Flue requires them
- **Chosen**: `bun install`, `bun run`, `bun test` for the gate's unit tests; `vite build` for the Flue app; Vitest for `*.eval.ts` because Flue's eval harness is Vitest-based. Node ≥ 22.19 at runtime.
- **Rejected**: strict Bun-only (blocks Flue), or dropping Bun (no reason to). The rule file `.agents/rules/use-bun-instead-of-node-vite-npm-pnpm.md` is to be amended when implementation starts.

### D19. Mock mode is a first-class runtime flag
- **Chosen**: `TRIAGE_MOCK_MODE=true` routes every I/O tool to redacted fixtures; `TRIAGE_RECORD_FIXTURES=true` captures them. Evals and demos run with mock mode on. Your brief: never run real calls during implementation or evals.
- **Rejected**: mocking at the network layer (nock-style). Tool-level fixtures are simpler and match the audit granularity.

### D20. Audit log gains `run_id`, `interface`, `entity`, `decision`
- **Chosen**: schema in 02 §3. Refusals are logged. DSNs are never logged, only the env var name.
- **Why**: today's log cannot correlate a multi-entity run or tell a refusal from a failure.

### D21. Entity naming: `ssfb` is the canonical id for Shivalik
- **Chosen**: `ssfb` in file names and env prefixes, alias `shivalik` accepted in the registry. You used SSFB in the brief; the workspace uses shivalik.
- **Rejected**: keeping both as separate ids.

### D31. HTTP policy is one ordered rules file per entity: `resources/<entity>.api.rules.json` (supersedes D6 and the `never_call` list; refines D8)
- **Chosen** (your proposal, 2026-09-23): entries `{service, method, api, action: allow|block, reason?}`, evaluated top to bottom, first match wins; no match means GET/HEAD allowed and every other method blocked. `service` resolves to `<ENTITY>_<SERVICE>_API_URL` via the registry, which is the host binding. `:param` matches one segment, trailing `/*` matches a subtree at a segment boundary. Matching runs on the canonical built path. Loader rejects unknown services, unreachable rules, and over-broad allows. Semantics in 02 §4.4.
- **Consequences**: `http_get` and `http_call_allowlisted` merge into one `http_call` tool (method defaults to GET; the rules decide, not the tool name). `cbs_call` uses the same rules with `service: finacle`. The known mutating harbor triggers and the bro `PUT rules` become block rules instead of a separate registry list.
- **Rejected**: the two-file model (allowlist + never_call); `source` as the field name (`service` is the registry key, and it is what the model already uses in every other tool); making `reason` mandatory (the doctor warns instead, so the file stays as light as you asked).
- **Open**: whether read-only calculator POSTs (TD calculate, deposits config) may be allowed, since the current workspace rule says never re-issue them (Q25).

### D22. Identity resolution runs in ingress, before the classifier (supersedes the ordering implied in D9)
- **Chosen**: `identity.ts` resolves the ID chain and reads three basic state items deterministically; the classifier receives thread + IdChain + state. The same code is also the `resolve_identity` tool for mid-run re-resolution.
- **Rejected**: classifying on thread text alone. The survey shows Slack `Tag`/`Summary` misclassify often and re-routing happened after the first lookup. Fixing the model before any lookup would have baked that error in.
- **Source**: product-fit review.

### D23. `deep_investigator` replaced by `investigate_<entity>_deep`; escalation is deterministic; synthesis escalates through a harness tool (supersedes D10's mechanism)
- **Chosen**: per-entity deep delegates on `MODEL_TIER_STRONG` (same factory, entity still a closure). `note_evidence` sets `escalation.triggered` on low confidence, conflicting hypotheses, money movement on a non-strong run, or budget exhaustion. `finish_report` is a `harness: true` tool that, when triggered, re-synthesises the report on the strong model from the evidence folder.
- **Rejected**: an entity-less deep investigator (violates D3 and would hit Flue's duplicate tool-name error when mounting three entities' tools in one render); letting the cheap orchestrator decide whether it needs help.
- **Source**: product-fit and Flue reviews.

### D24. Redaction has two profiles and a stated residual risk (refines D2/D20)
- **Chosen**: model-facing profile keeps search keys (account numbers, UTRs, phones, UUIDs, names) and masks PAN, passport, card numbers, email local parts. Persisted/egress profile masks everything, decodes before scanning, uses names collected by ingress, and treats model free text as untrusted. `finish_report` refuses on a miss.
- **Rejected**: one profile applied to tool results. It would have hidden the account number the investigator needs to search logs with.
- **Residual risk accepted for v1**: free-text names or addresses that ingress never saw can pass. Recorded here so it is not rediscovered.
- **Source**: product-fit and security reviews.

### D25. HTTP surface is polling-only in v1; no `createAgentRouter` mount; HTTP Slack posting disabled by default (refines D13)
- **Chosen**: `GET /triage/:run_id` through egress redaction; `post-to-slack` behind `TRIAGE_HTTP_ALLOW_SLACK_POST=false` until the Slack bot can present a signature-verified approval. One shared bearer is a recorded v1 limit.
- **Rejected**: mounting Flue's agent router for SSE (streams model-facing data and exposes creation and arbitrary-conversation reads behind one token); trusting a caller-supplied `approved_by`.
- **Source**: security and Flue reviews.

### D26. Scope rule: id-shaped parameters must belong to the run's ID chain
- **Chosen**: `scope.ts` in the gate; `scope: 'systemic'` allows aggregate-only SQL and count/group-by log queries. Out-of-scope ids are audited as denies.
- **Rejected**: relying on the prompt to keep the model on the ticket's customer.
- **Source**: security review.

### D27. Fixtures are recorded to an unreviewed folder and promoted by a human; mock mode is the default
- **Chosen**: `TRIAGE_MOCK_MODE=true` by default; `TRIAGE_MOCK_STRICT=true` in evals; fixtures keyed by semantic key; recording goes to `fixtures/_unreviewed/` (gitignored) and is promoted only after a human reads it.
- **Rejected**: hash-of-input keys (miss on every run because model-written SQL varies); auto-committed fixtures (repeats the survey leak pattern).
- **Source**: product-fit and security reviews.

### D28. CLI gains `start`/`wait`/`status`/`ask`/`feedback`; `post` is non-interactive when stdin is not a TTY
- **Chosen**: coding agents call `triage start … --json`, poll `triage wait`, ask the human in chat, then `triage post <run_id> --yes --approved-by <user>`. `--thread-file` accepts a thread the coding agent fetched itself.
- **Rejected**: a blocking `run` as the only entry (coding agents' shell tools time out at 2–10 minutes); a y/N prompt as the only approval path (no TTY under Claude Code).
- **Source**: product-fit review.

### D29. Ports of `transfer_lifecycle.sh` and `list_transactions.sh` are SSFB tools; eval capture becomes `triage feedback`
- **Chosen**: `detect_silent_reversals`, `get_account_statement` on `investigate_ssfb`; `triage feedback` and `POST /triage/:run_id/feedback` write the existing eval front-matter.
- **Rejected**: expecting a mid-tier model to reproduce the DB-vs-statement join; dropping the only ground-truth pipeline.
- **Source**: product-fit review.

### D30. `cbs_call` carries data on stdin through a fixed remote script; the OAuth mint is tool infrastructure
- **Chosen**: charset-validated path; fixed ssh and kubectl argv; path, body and token as stdin data lines; no `sh -c`. The password-grant POST is performed by the tool to obtain a token and is not a model-reachable call; it is listed here as an explicit carve-out from "non-GET only via allowlist" pending Q4.
- **Rejected**: interpolating the path into a remote heredoc (the injection in today's script); treating the mint as an allowlist entry (it is not a model action).
- **Source**: security review.

### D32. `TRIAGE_DEPLOY_MODE=local|server` is the one env var code branches on, and only in pre-flight (Q3, Q4)
- **Chosen**: `local` means the process owns the network path: before a real run it brings the SSFB tunnel up, runs the per-entity kube/AWS login, probes hosts. `server` means infra owns the path: probe only. Failures never block; they become warnings for the caller and gaps in the report, and the affected tools answer "unreachable". Mock mode skips pre-flight. The variable is read in `preflight.ts` only; a test greps the rest of `src/` for it.
- **Why not a stage/prod flag**: deploy mode is orthogonal to environment. A stage `.env` on a laptop is `local`; a prod `.env` on a server is `server`. D4 still holds.
- **Rejected**: blocking the run when the tunnel fails (you asked for a warning; the run can still use Quickwit, other entities and code).

### D33. SQL runs inside `BEGIN READ ONLY` with `SET LOCAL` timeouts; role check warns by default (Q6, Q23)
- **Chosen**: one transaction per `sql_select` call: `BEGIN READ ONLY; SET LOCAL statement_timeout; SET LOCAL lock_timeout; <select>; COMMIT`. Postgres rejects writes and DDL inside a read-only transaction regardless of role, and `SET LOCAL` is permitted inside it. Works unchanged on a hot-standby reader node, where the session is read-only already. The parser refuses `SET`/`RESET`/`SHOW` so the model cannot lift the timeouts. The connection string also sets `default_transaction_read_only=on`.
- **Role check**: `has_table_privilege(..., 'INSERT')` true → doctor warning. `TRIAGE_REQUIRE_READONLY_DB_ROLE=true` turns it into a real-mode block per entity once infra provisions roles.
- **Rejected**: blocking by default (ATSPL and RTL would be unusable until roles exist); relying on the parser alone (client-side only).

### D34. Harbor field encryption is available to the SSFB investigator as two narrow tools (Q7; supersedes A6)
- **Chosen**: harbor uses AES-SIV, which is deterministic, so `encrypt_lookup_value` produces a ciphertext usable as a `$n` parameter for lookups by phone or CIF, and `decrypt_fields` decrypts values already fetched. Key in `.env` as `SSFB_HARBOR_FIELD_ENC_KEY`; the tools mount only when it is set. Plaintext follows the model-facing profile and is masked on persist. Audit lines record counts, never values. Native implementation (AES-SIV is standard RFC 5297), no `go run` dependency.
- **Rejected**: a generic "decrypt anything" tool; decrypting inside `sql_select` results automatically (the model should ask for it so the audit shows intent).

### D35. Remediation is rendered as `suggested_fix`, never executed (Q8)
- **Chosen**: the report carries cURL and SQL the human can run, with `$VAR` placeholders for tokens and hosts, preconditions and a verification query. The runtime has no code path that executes them. No `allow` rules for `trigger-delivery`, `sync-address`, `trigger-customer-creation`, `debit-unfreeze`, force-sign.
- **Rejected**: an "apply fix after approval" mode (out of the read-only scope; a v2 question at the earliest).

### D36. Tier policy raises to an image-capable model when the thread has screenshots (Q12)
- **Chosen**: pi-ai model metadata says whether a model accepts image input. If the selected tier's model does not and the request has attachments, the tier is raised to the first tier that does. `MODEL_TIER_STRONG` must accept images (doctor check). The classifier stays text-only when its model lacks vision and records `images_seen: false`; the tier model still gets the images.
- **Rejected**: a separate `MODEL_VISION` slot (another knob for the same thing); OCR pre-pass (v2 at the earliest, D17).

### D37. Repos are pinned by `resources/repos.json` (Q15)
- **Chosen**: `[{repo, entities[], branch}]`, `branch` defaulting to the repo's default branch. `triage repos sync` checks out, pulls and re-indexes outside the request path. The doctor warns on drift; the report records the commit per repo used.
- **Rejected**: tracking whatever is checked out (today's state, mostly `pre-prod`); pinning to deployed tags (no source of truth for "deployed" was named).

### D38. Persistence provider is configurable (Q20)
- **Chosen**: `TRIAGE_DB_PROVIDER=sqlite|postgres` + `TRIAGE_DB_URL`; `src/db.ts` selects the Flue adapter. sqlite is the laptop default.

### D39. Approval mode is configurable; `cli` in v1, `slack` buttons in v2 (Q22)
- **Chosen**: `TRIAGE_APPROVAL_MODE=cli` (interactive y/N or `--yes --approved-by`). `slack` will post the report with Yes / No / Comment buttons and treat the signed interaction as the approval proof. Until then `TRIAGE_HTTP_ALLOW_SLACK_POST` stays `false`.

### D40. All `api.rules.json` files ship empty (Q24, Q25; refines D31)
- **Chosen**: `[]` for every entity: GET and HEAD everywhere, nothing else. Every known mutating endpoint is POST or PUT, so no block rules are needed. The old allow file's bro and Finacle entries are not migrated; they come back by PR with a reason when a case needs them. The td-calculate example in the brief was illustrative.
- **Rejected**: seeding block rules for endpoints the default already denies (noise in the file; the loader would flag them as unreachable anyway).

### D41. Housekeeping answers recorded (Q9, Q13, Q14, Q16, Q17, Q18, Q19, Q21)
- Reviewer email and fallback group live in `.env`; a Slack bot token will be provided.
- Credential rotation after the survey incident is outside this project's scope by your decision; it is not raised again here.
- Knowledge is copied from the old workspace's `AGENTS.md` files (CLAUDE.md files under `repos/*` belong to their repos and are not copied).
- `.env.example` keeps hostnames where known and blank values otherwise; every key is present; credentials are always blank.
- Stage deployments exist for SSFB and ATSPL; they are separate `.env` files, nothing else changes.
- Serena, code-review-graph, headroom, ClickUp, Grafana/Playwright are dropped for good.
- Slack bot uses the HTTP Events API (no Socket Mode).
- Tier models: Anthropic, OpenAI direct, local Ollama. OpenRouter only for the classifier, which sees the redacted thread.

### D42. Evals: promptfoo for model suites on top of Vitest contract tests; runtime skills; pseudonymised eval data (P1, 2026-09-23; refines D18, D20, D27, D29)
- **Chosen**: three layers. `bun test` for the gate. Vitest with pi-ai `fauxProvider` for scripted contract tests on every PR (in-process only, zero spend). promptfoo for case-file suites against real models: suite 1 (classifier + tier policy, no fixtures needed, side-by-side providers) and suite 2 (full Triage in strict mock over recorded fixtures). One shared `runCase()` driver. **v1 ships unit + contract + suite 1**; suite 2 waits for recorded fixtures, which do not exist yet.
- **Eval models are configurable per provider** (your decision): local Ollama, Anthropic, OpenAI direct, or another registered provider, set in the eval home's `.env` with the same `MODEL_*` keys plus `TRIAGE_EVAL_JUDGE_MODEL` (different family from the tiers under test; never OpenRouter under D41; a missing judge fails, it does not fall back) and `TRIAGE_EVAL_MAX_COST_USD`.
- **No real prod calls, in layers**: the eval home's `.env` has every entity credential blank; the driver refuses to start if one is set and forces `TRIAGE_MOCK_MODE=true`, `TRIAGE_MOCK_STRICT=true`, `TRIAGE_RECORD_FIXTURES=false`; every audit line carries `transport: real|mock` (D20 refined) and the `no_real_io` gate fails a case on any `real`. Config is selected by `TRIAGE_HOME`, never by a flag (D4).
- **One capture path, one promotion path** (D27, D29 refined): `triage feedback` writes the eval case draft to `evals/_unreviewed/<run_id>/`; `triage fixtures review` promotes fixtures and cases together. No separate evalset commands.
- **Pseudonyms, not masks, for eval data**: keyed, format-preserving pseudonyms so ids stay well-formed across thread text, ID chain, fixture semantic keys and the scope gate. Live runs keep the D24 masks.
- **Committing eval data**: reviewed cases and fixtures live in git, starting with the 4 verified cases; the 89 older thread conversions are promoted one at a time after a human reads each, because offline import cannot mask customer names the way ingress does.
- **Skills load at runtime** via `defineSkill()` over `knowledge/**/SKILL.md`, replacing static `SKILL.md` imports, so the agent boots under bun, Vitest and promptfoo alike.
- **Scope gate in evals**: hard fail only if an out-of-scope id was ever allowed; the model not attempting one is a soft metric.
- **Not added**: `root_cause.service` in the Report; service attribution is derived from `root_cause.code_refs[].repo` through the registry first, and the field is added only if that proves ambiguous.
- **Rejected**: promptfoo for everything (faux scripting needs in-process control); vitest-evals blueprint (its harness needs the agent router D25 keeps unmounted); a `--env .env.eval` flag (D4); a separate `point_in_time` metric (`taken_at` is already required by the schema).

### D43. Run store: provider interface, Postgres + pgvector in v1 on the Flue DSN, folder provider for sqlite deployments (P2, 2026-09-23; refines D20, D24, D38)
- **Chosen**: a `RunStore` interface owned by the app, separate from Flue's conversation persistence (Flue's own docs say business records do not belong there). The provider follows `TRIAGE_DB_PROVIDER` (D38): `postgres` → tables in a `triage` schema on the same `TRIAGE_DB_URL` (your decision: one DSN), with pgvector; `sqlite` → the folder provider at `.data/runs/<run_id>/` with brute-force cosine over `embeddings.json`, so laptops and evals behave the same. Tools reach the store through the same closure that carries `run_id`; the model never sees it. The idempotency key lives in the store. **One store per deployment**: a stage `.env` and a prod `.env` never share a schema or a runs dir, because the only column that could tell them apart is the display label, which code may not read (D4).
- **Model**: run → submissions (a `triage ask` follow-up is a new submission on the same run, so there can be several reports) → evidence, report, feedback. Audit stays in the JSONL (D20) as the single source; no audit table.
- **Text stored is the persisted-profile (redacted) text only.** The raw thread never enters the run store. Embeddings are computed over that text, never over the Flue stream. Two embedding kinds in v1: the case card (category, ask, root cause, status, pattern id) and the request. Exact cosine scan (`<=>`) with no index at this volume (about 150 cases a year); a per-model vector table so a model change is not a column migration. `triage runs reembed` rebuilds them.
- **Embedding model** is configurable like every other model: `MODEL_EMBEDDING=<provider>/<model>`, default local Ollama so nothing leaves the machine. pi-ai 0.83 and Flue 2.0.8 have no embeddings API, so this is a small in-repo client (Ollama and OpenAI shapes). Local Ollama embedding calls are allowed in evals (your decision); a remote embedder in evals is not.
- **Prior cases** go only to the orchestrator's initial data as a structured projection (ids stripped, no free text), never to the classifier: the classifier may run on OpenRouter, which D41 approved for this request's redacted thread only, and classifier confidence drives tier rules 1–3, so prior cases would change the tier through the back door. Retrieval is behind `TRIAGE_PRIOR_CASES=false` until an eval shows it helps. Old `refs/` threads enter the corpus only through the same reviewed-case promotion as eval cases (D42): one review pipeline.
- **Erasure and retention** (your decision): `triage runs delete <run_id>` clears the run store only. It cannot reach Flue's conversation stream, the global audit JSONL, or other runs that received this run as a prior case; that is stated, not hidden. Retention is time-based per store (`TRIAGE_RUNS_RETENTION_DAYS`), applied by a scheduled job.
- **Rejected**: deferring Postgres to the server deployment (you chose to build it now); a separate run-store DSN; an HNSW index and a fixed `vector(n)` column; five embedding kinds; a `run_audit` table; prior cases in the classifier prompt; a `find_similar_cases` tool on the orchestrator in v1.

### D44. Quickwit transport is chosen per entity: `qw` CLI or direct HTTP (2026-09-23; refines D5, D8; answers Q2 for ATSPL and RTL)
- **Chosen**: `logs_search` keeps one typed input and one query builder; the last hop is a per-entity transport from the registry and `.env`: `<ENTITY>_QUICKWIT_TRANSPORT=qw|http`. `qw` runs the SSO-authenticated Quickwit CLI (Vivek's launch, #C0B36S0NT54, 2026-08-07) with `execFile`, fixed argv, `--context <ENTITY>_QW_CONTEXT`, JSON output; `http` is the REST call to `<ENTITY>_QUICKWIT_URL` with `none|bearer` auth. The model never sees or chooses the transport. Concurrency cap, window rule, hit cap, both redaction profiles, mock fixtures (transport-neutral semantic key) and our audit line apply to both. `qw` runs in tool code on the host, never in the virtual sandbox (no native binaries there, and it is entity I/O).
- **Auth**: `qw login` is an interactive browser SSO, so it is a pre-flight check in local mode (`qw whoami --context <ctx>`, warning if not logged in, D32), never a tool action. Stage and prod differ only by the context value in each `.env` (`ssfb-stage` vs `ssfb-prod`), no branching (D4).
- **Why both**: `qw` solves ATSPL's OIDC proxy (browser-only until now) and covers RTL through `core-prod-london`, and every query is also recorded in infra's identity-stamped `qw_audit`. Direct HTTP stays for SSFB's no-auth endpoint and for server deployments until `qw` has a headless login.
- **Per entity (2026-09-24)**: SSFB uses `http`. ATSPL (`envoy-prod`) and RTL (`core-prod-london`) use `qw`, and every `qw` call carries `--context <ENTITY>_QW_CONTEXT`. `.env.example` ships these values; a test checks `--context` on every `qw` mode.
- **Open with Vivek** (Q27–Q29): headless login for server mode; absolute `--from/--to` (the thread shows `--since` only); a way to carry our `run_id` into `qw_audit`.
- **Rejected**: exposing `qw` to the model through the sandbox or as a shell (D2); a single global transport (SSFB's endpoint and ATSPL's proxy differ today); driving Quickwit through the `quickwit-logs` skill's prose instead of the typed tool.

### D45. Sandbox: Flue `useSandbox` on `Triage`, provider `virtual|e2b|daytona` from `.env`, `local()` refused (P3, 2026-09-23; amends D2)
- **Chosen**: `Triage` mounts one Flue sandbox; delegates inherit it (Flue allows one per conversation). `TRIAGE_SANDBOX_PROVIDER=virtual` (default) is just-bash in memory: coreutils, `jq`, `sqlite3`, `yq`, `xan`, pipes, loops, functions, and `python3` as CPython in WebAssembly, network off, no native binaries, resource limits on. `e2b` and `daytona` are the remote backends, switchable by that one key. Row-returning tools write their full result as `/data/<call_id>.json` into the sandbox so the model can join and filter with `jq`, `sqlite3` or Python; the tool return stays the capped summary. Sandbox output passes the model-facing redaction like any tool result. Remote backends receive **persisted-profile text only**, so unmasked joins work only on `virtual`.
- **D2 amended, not repealed**: "no shell" becomes "no shell to the host". `bash`, `read`, `write`, `edit`, `grep`, `glob` exist, over the sandbox filesystem only. Every entity touch still goes through the typed tools. `local()` is refused in code and by the doctor because Flue's own guide says it is not an isolation boundary. The tripwire allowlist gains the six sandbox tools.
- **Why virtual first**: no Docker, no daemon, nothing to install, covers the join-and-chart case, and Python is a config flag away. Honest limits: the boundary is the emulator plus WebAssembly, not an OS; files are wiped per message (use `note_evidence` for anything that must persist); which Python packages ship with the WASM build is unverified.
- **Rejected**: `local()`; a separate typed `run_analysis` tool with Docker or a standalone WASM runtime (more moving parts for the same result once `python: true` exists in just-bash); sandbox-backed `repo_grep` (D11 stands); running repo tests or linters (later); executing `suggested_fix` in any sandbox (D35, never).

### D46. Repos are cloned from an org over ssh or https; the token goes through git's environment (2026-09-24; refines D37)
- **Chosen**: a pin in `resources/repos.json` without `remote` is cloned from a URL built from `TRIAGE_GIT_PROTOCOL` (`ssh` default, or `https`), `TRIAGE_GIT_HOST` (`github.com`) and `TRIAGE_GIT_ORG` (`Vance-Club`): `git@github.com:Vance-Club/<repo>.git` or `https://github.com/Vance-Club/<repo>.git`, the same org and shallow clone as triage-shivalik's `git-clone.sh`. A pin's own `remote` still wins. When the protocol changes, sync points an existing clone's `origin` at the new URL if it names the same repo; an `origin` that names another repo is left alone with a warning that does not print it. Four repos sync at a time.
- **Auth**: ssh uses the host's keys and ssh config as they are. For https, `TRIAGE_GIT_HTTPS_TOKEN` reaches git as `http.https://<host>/.extraheader` through `GIT_CONFIG_COUNT/KEY/VALUE` variables, so it is never in argv, a URL or `.git/config`; blank means the host's credential helper. Every git call gets `GIT_TERMINAL_PROMPT=0`. git's stderr is mapped to fixed reasons and never returned, as the tunnel does for ssh.
- **Rejected**: a token inside the clone URL (it lands in `.git/config` and in `ps`); a `-c http.extraheader=...` argument (visible in `ps`); setting `GIT_SSH_COMMAND` (it would override a per-directory `core.sshCommand` that picks the right GitHub account); a `remote` on every pin (21 near-identical URLs to keep in step).

## Assumptions (explicit; each needs your confirmation or correction)

| # | Assumption | Basis | If wrong |
|---|---|---|---|
| A1 | "pi-core" means `@earendil-works/pi-agent-core`, the library Flue already depends on | it is installed; pi coding-agent is not | D1 still holds; comparison table covers all three |
| A2 | ~~v1 runs on an operator laptop~~ **Resolved (Q3, D32)**: either, selected by `TRIAGE_DEPLOY_MODE` | — | — |
| A3 | **Confirmed (Q2), refined by D44**: each entity's Quickwit is reachable either over HTTP with a token in `.env` or through the SSO `qw` CLI, chosen per entity | your answer to Q2; the `qw` launch thread | an entity with neither leaves `logs_search` answering "not configured" |
| A4 | Entities are exactly SSFB, ATSPL, RTL; frontend repos attach to entities via the repo map | your brief and the ecosystem table | registry gains an entry |
| A5 | RTL London copies of eventbus, pdf-generator, reminder-service are out of scope for v1 | no DB vars exist for them; not in the entity table | add services to `rtl.entity.json` |
| A6 | ~~Field decryption is not given to the agent~~ **Superseded by D34 (Q7)**: two narrow AES-SIV tools, mounted when the key is set | — | — |
| A7 | Slack read uses a bot token with `channels:history`, `groups:history`, `files:read`; posting uses the same bot | standard Slack app model; today's path is the interactive claude.ai connector | ingress adapter changes only |
| A8 | ~~The 4 existing non-GET exceptions are still wanted~~ **Resolved (Q25, D40)**: not migrated; rules files ship empty | — | — |
| A9 | `refs/` content may be converted into eval cases after redaction | it is the only ground truth available | evals start from the 4 labelled cases only |
| A10 | **Confirmed (Q10)**: cohort DB is in scope; owner `cohort-service`, repo already checked out | your answer | — |
| A13 | In `local` mode, kubectl for `cbs_call` runs on the laptop against EKS after `aws sso login` / `aws eks update-kubeconfig`, not on the bastion over SSH as today | your Q4 answer names "aws kubectl login" as the local pre-check | keep today's ssh → bastion → kubectl hop and drop the laptop login from pre-flight (Q26) |
| A11 | UUIDs (customer_id, form_id, userId) are identifiers, not PII, and may appear unmasked in reports and audit lines | today's `redact.py` and eval cases treat them that way | mask UUIDs in the egress profile; reports become harder to act on |
| A12 | v1 tiers are three (cheap/mid/strong) but `MODEL_TIER_CHEAP` may equal `MODEL_TIER_MID` | your brief named two classes of model | set the two keys to the same model |

## Non-assumptions (things deliberately left open rather than guessed)

- RTL Quickwit endpoint and index, and the `service` field values for ATSPL and RTL (env values; blank until filled).
- ATSPL and RTL admin API base URLs (they exist and go in `.env`; not needed by the design).
- Stage hosts for SSFB and ATSPL (a second `.env`).
- The exact SQL parser library.
- Whether kubectl runs on the laptop or on the bastion in local mode (A13, Q26).
- Cohort service admin API base URL, if one exists (`SSFB_COHORT_API_URL` blank until known).

## Mistakes recorded so they are not repeated

- **Regex redaction on `.env` values** missed quoted values and leaked DSNs into a transcript (survey incident). Redaction must be tested against quoted, exported and multi-line forms, and any tool that echoes config must whitelist key names rather than mask values.
- **IDE-maintained allowlists drift** (67 entries, `python3 *`). Gates belong in code under test.
- **Point-in-time reads reported as final** (eval case graded partial). Every state item carries `taken_at`.
- **Fan-out without a cap** took down a single-CPU Quickwit. Per-entity semaphores, default 1.
- **Token written into `.env`** by a script. Config files are read-only to the runtime.
- **`--env` defaults to prod with a warning** in two wrappers. There is no default environment in the new design; there is only the `.env` you loaded.
- **Interpolating a path into a remote shell** (today's CBS script). Remote hops take fixed argv and read data from stdin.
- **Trusting a caller-asserted approver** would have made the HTTP Slack post a one-token action. Approval must be proven by the channel that granted it.
- **Designing a "deep" helper without the entity closure** slipped through the first draft of this very design. Any new delegate goes through the same factory.
