# Skills, subagents, commands and evals (triage-shivalik)

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## 0. Inventory (FACT)

- `.claude/skills/` has 5 skills: `aspora-triage`, `aspora-logs-finder`, `aspora-harbor-shivalik-sim-binding-issue`, `aspora-triage-slack-report`, `continuous-setup`.
- `.agents/skills/` has the same 5. Every script, config and reference file is byte-identical to the `.claude` copy. Only the SKILL.md files differ, and the differences are a mechanical rename: `CLAUDE.md`→`AGENTS.md`, `.claude/`→`.Codex/`, `Claude`→`Codex`. The result is broken: the paths point at `.Codex/skills/...` (capital C) but the real directory is `.codex/`, and `.codex/` holds no skills (see e.g. `.agents/skills/aspora-triage/SKILL.md:18,69,88`). The bad rename also produces `merge-Codex-md.sh` in `.agents/skills/continuous-setup/SKILL.md:187`.
- There is no `.claude/agents/` and no `.claude/commands/`. `.claude/tasks/` exists but is empty. Slash commands exist only as skill names, e.g. `/aspora-logs-finder --qw` (`CLAUDE.md:64-108`) and `trigger: /continuous-setup` (`continuous-setup/SKILL.md:4`). No custom subagents are defined anywhere.
- Hooks are wired in `.claude/settings.json:1-46`:
  - PreToolUse(Bash) runs `block-raw-curl-psql.py`.
  - Stop runs `triage-eval-capture.sh`.
  - SessionStart runs `shivalik/scripts/ensure_db_tunnel.sh` and `refresh-repos.sh`.
- `.codex/hooks.json` wires the same hooks but hardcodes `/Users/varun/code/work/triage-shivalik/.codex/hooks/...`, which is a different checkout from this one (that directory exists). `.codex/hooks/*` are identical to `.claude/hooks/*`.
- There are 84 zero-byte `.claude/.triage-captured-<session>` sentinel files, left behind by the Stop hook.

## 1. Per-skill summary

### aspora-triage (`.claude/skills/aspora-triage/SKILL.md`)
- **Purpose.** The general triage method. It covers:
  - the wrapper rule (§1, l.12-37)
  - a 4-rung evidence ladder: Admin API → DB → Logs → Direct CBS (§2, l.39-54)
  - a High/Medium/Low confidence score (§3)
  - PII and secret redaction (§6)
  - a human approval gate for anything outward-facing (§7)
  - a fixed output footer, `Evidence ladder:` / `Confidence:` (l.156-161)
- **Scripts:**
  - `scripts/safe_sql.sh`
    - Flags: `--env prod|uat` (`stage` is a deprecated alias), `--tenant shivalik|atspl|rtl`, `-v k=v`, `--max-rows`.
    - Accepts only a single SELECT/WITH. Runs with `default_transaction_read_only=on` and a 30s statement timeout. Caps output at 200 rows. With no query it does a dry run (l.66-82).
  - `scripts/safe_curl.sh`
    - Flags: `--env --service --path` (or a full URL).
    - Enforces a host allowlist on every method: hosts derived from `.env`, plus localhost and `*.vance.local`.
    - A non-GET call needs its host and path prefix in `config/allowed-non-get-requests.json`. `-K` is refused. `--max-time 30` is added. `--allow-any-host` is the escape hatch (l.84-100).
  - `scripts/redact.py`: stdin→stdout masking, with `--check` exiting 1 if it finds anything to mask.
  - `scripts/lint_prod_access.sh`: a static linter.
  - `scripts/eval_runner.sh`: see §3.
  - Both wrappers append one JSON line per call to `.claude/prod-access.log`, with keys `ts, tool, env, tenant, service, target, summary, exit`.
- **Config:**
  - `config/service-db-map.json` maps `tenant:service` → `{prod: VAR, uat: VAR}`. Keys: 9 shivalik services, `atspl:package`, `atspl:pulse`, and `rtl:banking|kyc|workflow`. Only RTL has `uat` entries.
  - `config/service-api-map.json` has only `shivalik:harbor` and `shivalik:rhythm`.
  - `config/allowed-non-get-requests.json` has the shape `{_comment, allowed:[{prefix, hosts:["env:VAR"|literal|"*.x"], methods:["POST"], reason}]}`. It holds 4 entries: two Finacle custom-script read paths on `env:SHIVALIK_FINACLE_PROXY_GW`, the bro dry-run, and the bro reference-query hook, both on `env:SHIVALIK_DEBUG_HARBOR_API`.
- **Entities.** The skill is written for all three tenants, but API mapping exists only for Shivalik.
- **Direct CBS exception.** `shivalik/scripts/cbs_curl_via_eventbus.sh` does ssh + kubectl exec and then runs curl inside the pod, with its own GET-only guard. It shares the non-GET allowlist (l.32-37).
- **Entity-agnostic?** The method is. The configs mix entities in single files keyed by `tenant:service`. The prod/uat axis is built into every flag.

### aspora-logs-finder (in depth in §2)
- Entities: SSFB/shivalik and ATSPL only.

### aspora-harbor-shivalik-sim-binding-issue
- **Purpose.** Given one or more form_ids and a time window, search Shivalik `logs-v1`, group hits by normalised `message`, and print a Markdown table for Slack.
- **Flags:** `--form-id` (repeatable) or `--form-ids-file`; `--last-days N` or `--from/--to`; `--service`; `--level` (default `error`, or `all`); `--max-hits 1000`; `--no-normalize`; `--raw-json` (SKILL.md l.45-57).
- **Script:** `scripts/search_sim_binding.py`
  - Uses stdlib urllib directly, not `safe_curl`.
  - Host, port and index are hardcoded as constants: `quickwit.vance.local`, `7080`, `logs-v1` (l.34-36). It ignores env vars.
  - It does a TCP pre-probe and then `GET /api/v1/indexes/logs-v1` (l.56-71).
  - Search is `GET /api/v1/logs-v1/search?...` with `start_timestamp/end_timestamp` (l.161).
  - To match a form_id it splits it on non-alphanumerics and ANDs the tokens against `raw_message` (SKILL.md l.97-103).
  - If Quickwit is unreachable it exits 2 with a VPN checklist.
- **Entity-agnostic?** No. It serves SSFB/harbor only and is a specialised variant of logs-finder.

### aspora-triage-slack-report
- **Purpose.** Post a finished `refs/{ref-id}` report as a threaded Slack reply.
- **Inputs.** A Slack URL (or `channel_id` + `thread_ts`) and a ref-id. Both are required, and the skill stops if either is missing.
- **Steps:**
  1. Parse `p<digits>` into a ts by inserting a dot 6 digits from the right.
  2. Resolve the reviewer by searching Slack for `abhilash.shinde@aspora.com`. If that account is inactive, or the reviewer is the sender, fall back to `@nri-banking-on-call` (l.34-40).
  3. Compose from the fixed template (l.45-57).
  4. Run `redact.py --check`.
  5. Show the operator the verbatim text and get an explicit yes.
  6. Post once with `slack_send_message` in the thread, without `reply_broadcast`.
- **Tools it relies on:** the claude.ai Slack MCP tools `slack_read_user_profile`, `slack_search_users` and `slack_send_message`. It shells out only to redact.py.
- **Entity-agnostic?** Yes.

### continuous-setup
- **Purpose.** Onboarding and share-zip sync for the workspace itself. It runs:
  - `triage-initial-setup/verify-setup.sh`
  - `apply-update.py`
  - `bootstrap.sh`
  - `merge-claude-md.sh`
  - `repos/git-clone.sh`
- It also lists human-only prerequisites: WARP, GitHub `Vance-Club` access, the lit bastion key, AWS on the bastion, DB replica credentials, and Slack access (l.109-126).
- **Entity-agnostic?** Yes, but it has nothing to do with triage at runtime. It is workspace maintenance.

## 2. aspora-logs-finder in depth

### Two modes (SKILL.md l.8-11, 34-43)
- `--qw` selects Quickwit API mode. It reads `references/env/<env>/qw.md` and `references/sources/quickwit-api.md`.
- The default is Grafana mode. It reads `env/<env>/grafana.md` and `sources/quickwit.md`, then drives a browser with `playwright-cli`:
  - `open --headed` or `-s=<session> goto`.
  - Login uses `GRAFANA_USER` / `GRAFANA_PASSWORD` if set; otherwise a person logs in by hand in headed mode; headless with no credentials is an error.
  - It closes the session unless `--close-session false` (l.151-190).
- **Environments.** The default env is `shivalik` (l.43). Routing by service name (l.55-59):
  - `package*`, `pulse-backend`, `canopy`, `engage`, `horus` → atspl
  - `harbor`, `rhythm`, `guardian`, `workflow-op` → shivalik
  - `comms` exists in both; ask which one is meant.

### Endpoints per entity (FACT)
- **SSFB/shivalik** (`references/env/shivalik/qw.md`):
  - Base URL `http://quickwit.vance.local:7080`, no auth, VPN only. `/etc/hosts` maps it to `192.168.66.1`. Port-forwarding is explicitly ruled out (l.45-47).
  - Quickwit 0.8.0-nightly.
  - Default index `logs-v1`. Others: `otel-logs-v0_9`, `otel-traces-v0_9`, `otel-logs-v0_7`.
  - Search route is `POST /api/v1/{index}/search`, not `/indexes/{index}/search` (l.58).
- **ATSPL** (`references/env/atspl/qw.md`):
  - Uses the `qw` CLI v0.3.0 at `~/.local/bin/qw`, context `envoy-prod`.
  - Endpoint `https://quickwit-proxy.vance.finance`, OIDC issuer `https://freeway.aspora.com` (Okta, browser login). Quickwit 0.9.0-nightly.
  - Index `envoy-logs`, retained from about 2026-02-05. `envoy-logs-v1` is a near-duplicate.
  - Verbs: `search | count | histogram | tail | indexes | ping | whoami | login`. Flags: `--since`, `--from/--to`, `--max-hits`, `-o raw|json`, `--jq`, `--explain` (l.83-96).
  - Auth: check `qw whoami` then `qw ping`. `qw login` blocks on a browser login, so the operator has to run it.
  - `service:harbor` in this index is actually a kafka-ui container, not SSFB harbor (l.78-81).
  - Hyphenated field names must go bare, e.g. `x-req-id:...`, and `level` is lowercase (l.119-130).
- **Grafana (shivalik only)** (`references/env/shivalik/grafana.md`): a hardcoded internal ELB host `internal-k8s-asporasharedinter-...elb.amazonaws.com:4443`, dashboard `addt9ws`.
- **RTL:** there is no `env/rtl/` reference at all.

### Why ATSPL is the `qw` exception
`safe_curl.sh` cannot reach the proxy: the host is not in the allowlist (`safe_curl.sh:474-476`), and it needs a bearer token that `qw` keeps. `qw` is read-only because it has no write verb. It does not write to `prod-access.log`, which leaves an audit gap (`atspl/qw.md:132-138`; `CLAUDE.md:117`).

### How search.py builds queries (`scripts/search.py`)
- **Filters.** Each filter becomes a clause, and all clauses are ANDed (`build_query` l.84-114):
  - `service:X` and `level:X`
  - `--message` becomes a phrase query on `message`
  - `--error` becomes per-word ANDs, e.g. `(error:w1 AND error:w2)`, because `error` has no positions indexed and a phrase query returns HTTP 400 (l.73-81)
  - `--field NAME VALUE` (repeatable)
  - bare positional terms; a dashed UUID is cut to its first segment, with a warning (l.99-106)
  - `--query` for a raw fragment
  - `--from/--to` become `timestamp:[a TO b]`; accepted forms are `2d`, `6h`, a date, or ISO
- **Request.** `POST {url}/api/v1/{index}/search` with body `{query, max_hits, sort_by_field: timestamp}`. It retries 5 times, 2s apart, on connection errors (l.117-140).
- **Output modes:** `--count`, `--group-by`, `--raw` (drops the duplicated `_source`), `--fields`, `--desc`, `--print-query`, `--list-indexes`.
- **Zero hits.** A zero-hit result prints an escalation ladder (`ZERO_HINT` l.40-47; also `quickwit-api.md` l.7-26): drop message/error → drop level → drop service → drop the time window → try other indexes.
- **Field model** (`quickwit-api.md` l.28-64):
  - In Go services, `message` is the developer's label and `error` holds `err.Error()`.
  - `workflow-op` (Java) is the exception: everything is in `message`.
  - `x_req_id` and `x_txn_id` are reused across requests, so one ID can pull in unrelated lines (l.70-75).
  - One failure usually produces more than one log line (l.77-81).

## 3. Eval loop end to end

1. **Capture trigger** (`.claude/hooks/triage-eval-capture.sh`), on the Stop hook:
   - It skips if `stop_hook_active` is set, or a sentinel `.claude/.triage-captured-<session_id>` exists, or there is no access log or transcript.
   - It reads the session start time from the first timestamped entry in the transcript (l.60-66).
   - It fires only if some `prod-access.log` line has `ts >= session_start` (l.70-73). The log carries no session id, so concurrent sessions can trigger each other; the author accepted that (l.20-23).
   - search.py, search_sim_binding.py and `qw` do not log, so a session that only read logs never fires (l.25-27).
   - When it fires, it writes the sentinel and returns `{decision:"block", reason:<questionnaire>}` to the harness.
2. **Questionnaire** (l.79-131): Claude runs it via `AskUserQuestion`.
   - A gate question, then:
   - A: the issue and identifiers (masked).
   - B: what the investigation concluded, the service, the DB evidence, and the key queries.
   - C: ground truth — correct / partial / wrong / pending — plus the actual cause and any faster path.
   - D: whether to save, and notes.
3. **Stored case:** `refs/eval-cases/<YYYY-MM-DD>-<slug>.md`, gitignored.
   - YAML front matter: `id, type, input{problem, identifiers, ref}, investigation{root_cause, service, db_evidence, queries[]}, ground_truth{verdict, actual_root_cause, actual_service, faster_path}, notes, captured_at`.
   - There are 4 cases: nre-opened-nro-missing (rhythm, correct), transfers-disabled (rhythm, partial: it reported a stale DB state as final), mpin-city-required (harbor, correct), and harbor-cbs-fuzzycheck-pan-mismatch (harbor, correct).
   - The cases also carry extra keys not in the template: `code_evidence` and `notes_on_queries`.
   - The mpin case's `faster_path` records a remediation done with mutating admin POSTs (`/admin/v1/customers/:id/sync-address`, `/admin/v1/forms/:id/trigger-customer-creation`).
   - The fuzzycheck case lists full-UUID identifiers and notes that its DB reads used raw psql, which predates the wrapper rule.
4. **Replay** (`eval_runner.sh`):
   - Dry run is the default; `--execute` is needed for a real run. Other flags: `--case`, `--list`.
   - A lenient front-matter parser written in inline Python extracts `input.problem`, `input.identifiers`, `input.ref`, `investigation.service` and `investigation.root_cause`. The expected service is `ground_truth.actual_service`, falling back to `investigation.service` (l.86-157).
   - The prompt template asks for a line `Service: <service>` and says "Do not ask clarifying questions" (l.160-173).
   - The run itself is `claude -p "$prompt" --output-format json` from the repo root, taking `.result`. It uses live prod; there is no fixture cache (l.212-216).
5. **Grading:**
   - Only service attribution is graded: `grep -qiw "$expected"` over the whole conclusion. It does not check the `Service:` line specifically, so a conclusion that merely mentions the expected service elsewhere still passes (INFERENCE from l.220).
   - A case with no service is SKIPped.
   - Root cause is printed next to the ground truth for a human to judge.
   - Output goes to `refs/eval-runs/<ts>.md` and `latest.md`.
   - Planned but not built: an LLM judge and replay against recorded responses (l.28-30).
   - `refs/eval-runs/` does not exist, so INFERENCE: `--execute` has never completed, or its output was removed.

## 4. Mapping to a new agent runtime

**Maps cleanly to tools (deterministic, typed):**
- `safe_sql.sh` becomes `sql_select(entity, service, query, params)`. Keep the regex, the read-only transaction, the row cap and the audit log. Drop `--env`.
- `safe_curl.sh` becomes `http_get` / `http_call` with host allowlisting and the per-entity non-GET allowlist.
- `search.py` becomes `logs_search(entity, ...)`. Port the query builder, the zero-hit ladder and the field-model guards.
- `qw` CLI calls become an ATSPL backend for `logs_search`, or a proxy client with OIDC.
- `search_sim_binding.py` becomes a preset on `logs_search`, or its grouping logic becomes a `logs_group` tool.
- `redact.py` becomes middleware on every tool result and every outbound message.
- `cbs_curl_via_eventbus.sh` becomes a `cbs_read` tool behind an env flag.
- Slack posting becomes an output-channel adapter that requires approval.

**Maps to skills/prompts (knowledge):**
- The aspora-triage method: evidence ladder, confidence score, output footer.
- The quickwit-api.md traps.
- The per-entity qw.md facts. These should become config plus per-entity context, not hardcoded constants.
- The Slack message template and reviewer-fallback rule.

**Candidate subagents:**
- A log-investigator, one per entity, which fits multi-entity fan-out.
- A code-walkthrough agent using codegraph.
- A DB/ID-chain agent.
- Possibly a report and redact composer.

**Claude-Code-specific glue (replace or drop):**
- The PreToolUse `block-raw-curl-psql.py` hook. A runtime that exposes only typed tools has no raw shell, so this goes away. Its pragma allowlist hardcodes `.claude/...` paths (`block-raw-curl-psql.py:110-113`).
- The Stop-hook questionnaire using `AskUserQuestion` and sentinel files. Replace it with a post-run eval-capture step keyed by run id.
- The SessionStart hooks for the DB tunnel and repo/codegraph refresh. Replace them with a runtime health check and a background indexer.
- Grafana mode via `playwright-cli`, and `continuous-setup`, which is workspace onboarding.
- The `.agents` and `.codex` duplicates.
- The `claude -p` replay and grep grading. Replace them with an eval harness that runs against recorded fixtures, as the user's no-live-calls rule requires.

**MCP and code-graph config:**
- `.mcp.json` defines one server: `codegraph` (stdio: `codegraph serve --mcp`), for code navigation over `repos/`. `settings.local.json` enables it via `enabledMcpjsonServers:["codegraph"]`, and `.codex/config.toml` registers it too.
- `.serena/` is Serena project config (`language_servers: [bash]`) with empty memories. No MCP entry points to it, so INFERENCE: it is unused.
- `.code-review-graph/graph.db` is a SQLite graph from the code-review-graph tool (its `.gitignore` says "Auto-generated by code-review-graph"). It is not registered as an MCP server here, so INFERENCE: stale or unused.
- The Slack tools come from the claude.ai connector, not from `.mcp.json`. `settings.local.json` allow-lists `slack_read_thread`, `slack_read_file` and `slack_search_users`.

## Key facts

- 5 skills exist: aspora-triage, aspora-logs-finder, aspora-harbor-shivalik-sim-binding-issue, aspora-triage-slack-report, continuous-setup (.claude/skills/)
- .agents/skills is a copy of .claude/skills with only SKILL.md text renamed; the paths point at a nonexistent .Codex/ dir (e.g. .agents/skills/aspora-triage/SKILL.md:18,69)
- There are no .claude/agents or .claude/commands, and .claude/tasks is empty; slash commands are just skill names (CLAUDE.md:64-110)
- Hooks: PreToolUse Bash→block-raw-curl-psql.py, Stop→triage-eval-capture.sh, SessionStart→ensure_db_tunnel.sh + refresh-repos.sh (.claude/settings.json:1-46)
- .codex/hooks.json hardcodes /Users/varun/code/work/triage-shivalik, a different checkout from /Users/varun/code/aspora/triage-shivalik (.codex/hooks.json)
- Evidence ladder: Admin API → DB → Logs → Direct CBS, with a High/Medium/Low confidence required (aspora-triage/SKILL.md:39-64)
- Non-GET allowlist shape is {allowed:[{prefix,hosts:['env:VAR'|host|'*.x'],methods,reason}]} with 4 entries, all Shivalik (aspora-triage/config/allowed-non-get-requests.json)
- service-db-map covers 9 shivalik services, atspl package/pulse, and rtl banking/kyc/workflow; service-api-map has only shivalik harbor and rhythm (aspora-triage/config/*.json)
- SSFB Quickwit: http://quickwit.vance.local:7080, index logs-v1, no auth, VPN, POST /api/v1/{index}/search, v0.8.0 (aspora-logs-finder/references/env/shivalik/qw.md)
- ATSPL Quickwit: qw CLI, context envoy-prod, https://quickwit-proxy.vance.finance behind Okta OIDC, index envoy-logs, v0.9.0; not reachable via safe_curl and not logged to prod-access.log (references/env/atspl/qw.md:9-20,132-138)
- There is no RTL Quickwit reference anywhere in logs-finder; only shivalik and atspl env dirs exist (aspora-logs-finder/references/env/)
- search.py calls urllib directly and is exempted via pragma plus PY_SCAN_ALLOWLIST (search.py:22-24; block-raw-curl-psql.py:110-113)
- search.py uses per-word AND on the error field (no positions indexed), phrase queries on message, cuts dashed UUIDs to their first segment, and prints a 5-step ladder on zero hits (search.py:40-114)
- search_sim_binding.py hardcodes host, port and index and uses GET /api/v1/logs-v1/search with start/end_timestamp (search_sim_binding.py:34-36,161)
- The eval capture Stop hook fires only when prod-access.log has a line with ts >= session start; logs-only sessions never fire (triage-eval-capture.sh:25-27,70-73)
- Eval cases are stored as YAML front matter in refs/eval-cases/<date>-<slug>.md; 4 cases exist (refs/eval-cases/)
- eval_runner.sh defaults to dry run; --execute runs `claude -p` against live prod and grades only service attribution, via grep -qiw over the whole conclusion (eval_runner.sh:16-30,212-224)
- refs/eval-runs/ does not exist, so no executed eval run is on disk (ls refs/)
- .mcp.json registers only codegraph (stdio `codegraph serve --mcp`); enabled via settings.local.json enabledMcpjsonServers
- Slack reporter hardcodes reviewer lookup abhilash.shinde@aspora.com with @nri-banking-on-call fallback and requires redact --check plus an explicit operator yes (aspora-triage-slack-report/SKILL.md:34-77)
- Both wrappers log JSON lines with keys ts, tool, env, tenant, service, target, summary, exit (.claude/prod-access.log key shape)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `.claude/skills/aspora-logs-finder/scripts/search.py` | Quickwit query builder, retry logic, zero-hit ladder, group-by/count/raw output | port: the query-building logic and guards are the core of a logs_search tool; make URL and index come from per-entity .env instead of constants |
| `.claude/skills/aspora-logs-finder/references/sources/quickwit-api.md` | Field-model traps (message vs error, workflow-op exception), correlation-ID reuse, false-negative patterns | reuse as-is: domain knowledge for the log subagent's prompt/skill |
| `.claude/skills/aspora-logs-finder/references/env/atspl/qw.md` | ATSPL qw CLI endpoint, OIDC, index, exact service names, query gotchas | port: split into entity config (.env) plus per-entity context notes |
| `.claude/skills/aspora-logs-finder/references/env/shivalik/qw.md` | SSFB Quickwit endpoint, index list, schema | port: move endpoint and index into .env; keep schema notes as context |
| `.claude/skills/aspora-harbor-shivalik-sim-binding-issue/scripts/search_sim_binding.py` | form_id batch lookup with error normalisation and Markdown table output | port: fold the grouping/normalisation into a logs_group tool or preset; drop the hardcoded host |
| `.claude/skills/aspora-triage/SKILL.md` | Evidence ladder, confidence rubric, output footer, HITL rules | reuse as-is: orchestrator system prompt content; strip the prod/uat and wrapper-path wording |
| `.claude/skills/aspora-triage/scripts/safe_sql.sh` | SELECT-only guard, read-only transaction, row cap, audit log | port: reimplement as a typed sql_select tool with the same rules; drop --env |
| `.claude/skills/aspora-triage/scripts/safe_curl.sh` | Host allowlist, non-GET allowlist, method detection, audit log | port: reimplement as an http tool; the allowlist moves to resources/{entity}.allow.api.json |
| `.claude/skills/aspora-triage/config/allowed-non-get-requests.json` | Existing non-GET read-only allowlist with env:VAR host indirection and reasons | port: migrate the 4 entries to resources/ssfb.allow.api.json; the user's target format {api, source} lacks hosts/methods/reason, which needs a decision |
| `.claude/skills/aspora-triage/config/service-db-map.json` | tenant:service to DB env-var map | port: becomes per-entity service registry; drop the prod/uat keys |
| `.claude/skills/aspora-triage/scripts/redact.py` | PII/secret masker with --check gate | port: output middleware on tool results and outbound messages |
| `.claude/skills/aspora-triage-slack-report/SKILL.md` | Thread-ts parsing, reviewer resolution with fallback, message template, approval gate | port: Slack output adapter; move the reviewer email and on-call group to .env |
| `.claude/skills/aspora-triage/scripts/eval_runner.sh` | Case parser, prompt template, service-attribution grader | replace: rebuild with recorded fixtures, stricter parsing of the `Service:` line, and an LLM judge; keep the lenient front-matter parser idea |
| `.claude/hooks/triage-eval-capture.sh` | Stop-hook questionnaire and case template | port: keep the questionnaire and schema as a post-run capture step; drop the sentinel/AskUserQuestion mechanics |
| `refs/eval-cases/` | 4 labeled ground-truth cases (2 rhythm, 2 harbor) | reuse as-is: seed eval set; needs recorded tool fixtures added; contains identifiers to re-check for redaction |
| `.claude/hooks/block-raw-curl-psql.py` | Bash command-position deny hook | drop: irrelevant if the new runtime exposes only typed tools and no raw shell; keep only for the Claude Code/Codex entry point |
| `.claude/skills/continuous-setup/SKILL.md` | Workspace onboarding/share-sync | drop: workspace maintenance, not triage runtime |
| `.agents/skills/` | Codex copies of the skills with broken .Codex/ paths | drop: duplicate with broken paths |
| `.mcp.json` | codegraph MCP server registration | reuse as-is: codegraph MCP is the code-navigation tool for the code-walkthrough subagent |
| `.serena/ and .code-review-graph/` | Serena bash LSP config with empty memories; code-review-graph SQLite db | drop: not registered as MCP servers and no evidence of use |

## Unknowns

- The user says Quickwit is now deployed in RTL and ATSPL too, but the files document only SSFB (logs-v1) and ATSPL (envoy-logs via the OIDC proxy). What is the RTL Quickwit endpoint, index, auth model and service list?
- Is ATSPL Quickwit reachable only through the Okta-OIDC proxy (qw CLI), or is there now a direct endpoint? How should a headless agent authenticate (service token vs. device flow)?
- Is Grafana/Playwright mode still wanted in the new agent, or is Quickwit API mode the only log path?
- The target allowlist format [{api, source}] drops the existing hosts/methods/reason fields. Should host scoping (env:VAR) and method be kept, since the current design treats path-only matching as unsafe?
- Has eval_runner.sh --execute ever been run? No refs/eval-runs exists. Were the results deleted or never produced?
- Should the reviewer (abhilash.shinde@aspora.com) and fallback group @nri-banking-on-call stay hardcoded or become .env config? Is the reviewer still current?
- Is the .codex setup pointing at /Users/varun/code/work/triage-shivalik intentional (a second checkout), and which checkout is canonical?
- Are Serena and code-review-graph used by anyone, or safe to ignore?
- Should eval ground truth that records mutating remediation (the mpin-city-required case's admin POSTs) be graded, given the new system forbids non-allowlisted non-GETs?

## Contradictions

- The logs-finder SKILL.md tooling table (l.52) says shivalik uses scripts/search.py 'via safe_curl.sh', but search.py calls urllib directly and is exempted by pragma/allowlist (search.py:22-24, 127-130).
- The logs-finder SKILL.md says the URL/index resolve from DEBUG_AI_QUICKWIT_URL / DEBUG_AI_QUICKWIT_INDEX (l.66-67, 86-93), but search.py argparse defaults are hardcoded constants and never read os.environ (search.py:35-36,173-174), and those keys are not in .env.example.
- User brief: Quickwit is in all entities. Files: 'quickwit.vance.local:7080 / logs-v1 is SSFB only' (atspl/CLAUDE.md:26), and no RTL log reference exists.
- User brief: no stage/prod checks. Every wrapper requires --env prod|uat, and both config maps are keyed by env (aspora-triage/SKILL.md:74; config/*.json).
- The .agents/skills SKILL.md files reference .Codex/skills/... and .Codex/prod-access.log, but the directory is .codex/ (lowercase) and contains no skills; the hook pragma allowlist only lists .claude/ paths, so .agents copies of search.py would be denied.
- .codex/hooks.json points at /Users/varun/code/work/triage-shivalik while this workspace is /Users/varun/code/aspora/triage-shivalik.
- The sim-binding SKILL.md (l.101) says the form_id tokens are ANDed against raw_message; the quickwit-api.md traps and search.py say bare-term or field queries are the reliable path, and case 2026-07-03-nre notes use raw_message:*substr* wildcards, which quickwit-api.md l.85 says silently return 0 across whitespace. Each gives different advice on the same UUID-matching problem.
- eval_runner.sh asks for a 'Service: <x>' line but grades with grep -qiw over the whole conclusion, so any mention of the expected service passes (eval_runner.sh:169-170 vs 220).
- The capture hook claims wrappers are the only prod path, but its own header concedes search.py/qw do not log, so logs-only triages are never captured (triage-eval-capture.sh:14-18 vs 25-27).
- aspora-triage SKILL.md §6 says never put full identifiers in refs/, yet eval case 2026-09-03-harbor-cbs-fuzzycheck-pan-mismatch stores full form_id/userId/customer_id UUIDs. Policy treats UUIDs as non-PII, so this may be acceptable, but it is inconsistent with the masked style of the other cases.
