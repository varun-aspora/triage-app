# COMPLETENESS CRITIC

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

Scope: I checked the 8 survey reports against /Users/varun/code/aspora/triage-shivalik. All paths below are relative to that root. I ran nothing that touches the network or a DB, and I printed only .env key names, never values.

## A. The biggest things the reports missed

1. **The root CLAUDE.md is deleted in the working tree.** FACT: `git status` shows ` D CLAUDE.md`, and `AGENTS.md`, `.agents/` and `.codex/` are untracked (`??`). `.gitignore` also has uncommitted changes. Every report that cites "CLAUDE.md:Lnn" is quoting the HEAD version (`git show HEAD:CLAUDE.md`). AGENTS.md is that same file run through a Claude->Codex, .claude->.Codex rename (AGENTS.md L3 "Codex (Codex.ai/code)", L116 `.Codex/skills/...`). INFERENCE: the workspace is halfway through a Codex migration. A Claude Code session opened here today gets no root CLAUDE.md, only the sub-directory ones.

2. **The /Users/varun/code/work paths in .codex/hooks.json are valid.** FACT: `/Users/varun/code/aspora` is a symlink to `/Users/varun/code/work` (ls -ld, created Sep 12). The .codex/hooks.json paths point at this same tree. Two reports call it "a different checkout". That is wrong. The real problems are that the paths are absolute and machine-specific, and that the SessionStart tunnel entry still uses `$CLAUDE_PROJECT_DIR`.

3. **The .Codex/ paths in .agents SKILL.md partly resolve.** macOS APFS is case-insensitive, so `ls -d .Codex` succeeds and maps to `.codex`. `.Codex/skills/` and `.Codex/prod-access.log` still do not exist, because `.codex` holds only config.toml, hooks/ and hooks.json. The copied hook resolves REPO_ROOT from `__file__` and hardcodes `SAFE_CURL=".claude/skills/..."` (block-raw-curl-psql.py L93-94). Under Codex the guard therefore still points at the .claude wrappers. PY_SCAN_ALLOWLIST lists only .claude paths (L110-113), so the `.agents/skills/.../search.py` copies would be denied if run.

4. **RTL runs more than 3 services.** FACT: rtl/eventbus, rtl/pdf-generator and rtl/reminder-service each have a CLAUDE.md. They say these services are deployed separately in EKS prod london (`deploy-*-eks-prod-london.yml`), and that the SHIVALIK_DEBUG_PDFGEN/REMINDER DB vars "will not show RTL london jobs". No report mentions this. The entity map (HEAD CLAUDE.md L43-50: RTL = workflow-op, banking-service, kyc-service) is incomplete. Per the same files, eventbus, pdf-generator, reminder-service and workflow-op are dual-deployed.

5. **cohort has a DB but no documentation.** FACT: `SHIVALIK_DEBUG_COHORT_DB_CONN_URL` is in .env and service-db-map.json as `shivalik:cohort`. shivalik/CLAUDE.md L62 lists `cohort/` as an argo app dir. There is no shivalik/cohort/ doc and no cohort repo in the repos list.

6. **Live permissions have drifted far from the bootstrap seed.** FACT: .claude/settings.local.json has 67 allow entries. They include `Bash(python3 *)`, `Bash(python3 -c ' *)`, `Bash(git push:*)`, `Bash(kubectl config *)`, `Bash(kubectl --context ssfb-prod get pods -A)`, `Bash(kubectl --context ssfb-aspora get ns)`, `Bash(./shivalik/scripts/cbs_curl_via_eventbus.sh --env prod /customer/api/retail/1246177)`, and the MCP tools `mcp__headroom__headroom_retrieve`, `mcp__clickup__clickup_get_task`, `mcp__claude_ai_Slack__slack_read_thread/read_file/search_users`. Sandbox is off: `"sandbox":{"enabled":false}`. The survey's "allows only the safe_* wrappers" describes bootstrap.sh, not the live file. `python3 *` is auto-allowed, so the Python scan in the PreToolUse hook is the only thing standing between the agent and a direct network call. Kube context names found in the file: ssfb-prod, ssfb-aspora.

7. **The .env holds a decryption key.** FACT (key name only): `SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY` is in .env, and so is `LITBIT_SERVER_IP`. The "26 keys" report lists LITBIT_* but does not flag that an encryption key sits next to the read-only creds. The new design has to decide whether the agent may decrypt harbor fields at all (harbor_field_enc.sh / `go run ./cmd/fle`).

8. **The token leaks in more places than reported.** FACT: cbs_curl_via_eventbus.sh L424 says "token via exec stdin (not argv)". But L430-434 put `TOK='$TOKEN'` into the ssh remote command, which puts it in argv on the laptop and on the bastion. Inside the pod, L445-447 run `curl ... -H 'Authorization: Bearer $TOK'`, so the token is also in curl's argv there. The contradiction is confirmed, and it covers three hosts, not two.

9. **workflow_step_check.sh is probably broken.** FACT: safe_sql.sh L372 runs `psql ... -v ... -c "$CAPPED"`. workflow_step_check.sh L96-171 passes `-v form_id=` and uses `:'form_id'` (L100, L124, L142). INFERENCE from the official psql docs, not run: a `-c` string must be "completely parsable by the server" and gets no variable interpolation. The query would then reach Postgres with a literal `:'form_id'` and fail with a syntax error. It would not silently return 0 rows. prod-access.log has no rtl-tenant lines at all (all 31 are safe_sql/shivalik/prod, exits 29x0, 1x1, 1x2, from 2026-09-13T03:51Z to 09-17T08:09Z), so this path has never run. The fix is to feed the query through stdin or `-f`.

10. **lint_prod_access.sh runs by hand only.** This answers one of the listed unknowns. FACT: .git/hooks has no non-sample hooks, there is no CI directory, and only docs and the hook itself reference the lint.

## B. Areas no report covered (depth 2, excluding repos/.git/node_modules/.codegraph)
- `.serena/` holds Serena LSP project config (bash only, `read_only: false`) and an empty memories/. Unused.
- `.code-review-graph/graph.db` is a 512KB code-review-graph DB last written Sep 3. Stale.
- `.codex/config.toml` registers codegraph as an MCP server (`codegraph serve --mcp`). It is the Codex twin of .mcp.json.
- `AGENTS.md` (root) is the Codex-renamed copy of the deleted CLAUDE.md, 163 lines (see A1).
- `rtl/{eventbus,pdf-generator,reminder-service}/CLAUDE.md` are RTL-london deployment stubs (see A4).
- `frontend/android/CLAUDE.md` and `frontend/ios/CLAUDE.md` are pointer docs to the repos' own CLAUDE.md and GUARDRAILS.md. iOS needs Xcode 16.4+.
- `shivalik/scripts/list_transactions.sh` is a rhythm admin transactions lister. It goes through safe_curl, `--env` is REQUIRED, and it sends x-customer-id. Its header calls it read-only GET.
- `scripts/bro/` holds dry-run-use-case.py (a batch BRO dry-run over forms through safe_curl; reads BRO_HOST with a hardcoded prod default of aspora.prod.shivalik.in:9443/bro, plus BRO_API_TOKEN and BRO_USE_CASE), join_dryrun.py, and forms/form_aug CSVs. The CSVs are probable PII and are gitignored via *.csv. This is a cohort/batch use case.
- `tmp/bro/checks.json` is a dump of BRO STP check definitions (check_id, identifier, rule_spec).
- `refs/*.csv|.numbers` are 8 loose DocketHub/delivery/RFI customer lists. They are batch-analysis inputs with contact details.
- `triage-initial-setup/{apply-update.py, make-share-zip.sh, merge-claude-md.sh}`: apply-update.py does a 3-way merge of a share zip into a workspace. make-share-zip.sh uses `git archive HEAD`, so untracked AGENTS.md and .agents/.codex would NOT ship today. merge-claude-md.sh plans a CLAUDE.md-tree merge. Together with the continuous-setup skill, these are a distribution mechanism for the workspace.
- `.claude/skills/aspora-triage/scripts/redact.py` masks 6+ digit runs to ****last4 and lets UUIDs and ISO timestamps through. It is reusable as the output gate.
- `.gitignore` has uncommitted changes. It ignores `.headroom`, which matches the headroom MCP allow entry.

## C. Contradictions, resolved
- Codex "different checkout": WRONG, it is a symlink (A2).
- ".Codex dir does not exist": PARTLY WRONG. It resolves case-insensitively, but the skills/ subdir and the log are missing (A3).
- The CLAUDE.md L118 claim that `--env` is required: both sides are right. HEAD CLAUDE.md L118 and AGENTS.md L118 say required. safe_curl L447-452 defaults to prod with a warning. safe_sql, list_transactions and the workflow script do require it. The docs overstate the rule for safe_curl and cbs_curl.
- "Hook does not cover Python" (HEAD CLAUDE.md L116 / AGENTS.md L116) vs the hook: the hook is right. block-raw-curl-psql.py L12 and L172-243 scan python/node/perl/ruby, so the docs are stale. The lint's narrower import check (lint L386: requests|psycopg2?|urllib) is also confirmed. "Parity" is false.
- logs-finder SKILL.md L52 "search.py via safe_curl.sh": the file is wrong. search.py L22-24 has an allow-file pragma and uses urllib directly, and it has no os.environ or getenv at all. DEFAULT_URL and DEFAULT_INDEX are hardcoded at L35-36.
- "Quickwit POST can't be expressed" (hook L101-104): this is policy, not mechanism. The allowlist matcher supports `*.vance.local` and POST prefixes. Confirmed.
- repos/AGENTS.md watcher vs refresh-repos.sh: repos/AGENTS.md L28-31 already concedes that the watcher binds only to the default project. Per-repo freshness comes from git-clone.sh plus sync. refresh-repos.sh is right.
- Sentinel comment "67 vs 3": stale. There are now 82 sentinels in .claude/ and 0 in .agents/, and 4 eval cases.
- The service-api-map comment says "base URL only", while the HARBOR/RHYTHM_API values carry paths: this cannot be verified without reading values. It is consistent with the bro entry's reason text ("served from the same host:port behind the /bro path prefix").

## D. Spot-check summary
10 claims checked: 9 verified, 1 wrong (see spot_checks).

## E. Implications for the designer
- Treat `resources/{entity}.allow.api.json` as a replacement for `allowed-non-get-requests.json`. The current entry reasons carry real safety knowledge. Example: entry 4 deliberately uses a full path so that "the mutating admin endpoints under that prefix stay GET-only". A plain `{api, source}` loses both that and the host binding. `source` can map to an env var in the way `env:VAR` does today.
- Permission drift (A6) shows that allow-lists maintained by an IDE drift over time. The new agent should own its gate in code, not rely on host settings.
- The access log has no session_id and no request/trace id, so it cannot correlate a multi-entity triage. The new audit schema needs a request id.
- The workspace has a batch/cohort use case (scripts/bro, refs CSVs, DocketHub 100-customer) as well as single-ticket triage.

## Key facts

- Root CLAUDE.md is deleted in the working tree (git status ' D CLAUDE.md'); AGENTS.md, .agents/ and .codex/ are untracked. Reports citing CLAUDE.md:Lnn are quoting HEAD. AGENTS.md is a Claude->Codex, .claude->.Codex renamed copy (AGENTS.md L3, L116).
- /Users/varun/code/aspora is a symlink to /Users/varun/code/work, so the .codex/hooks.json absolute paths are valid on this machine. They are machine-specific, and the SessionStart entry still uses $CLAUDE_PROJECT_DIR.
- macOS is case-insensitive, so .Codex resolves to .codex. .Codex/skills and .Codex/prod-access.log still do not exist. The copied hook hardcodes SAFE_CURL/SAFE_SQL to .claude/skills paths (block-raw-curl-psql.py L93-94) and PY_SCAN_ALLOWLIST to .claude paths (L110-113).
- RTL london also runs eventbus, pdf-generator and reminder-service as separate EKS deployments (rtl/{eventbus,pdf-generator,reminder-service}/CLAUDE.md). The Shivalik DB vars do not show RTL jobs. The entity map in HEAD CLAUDE.md L43-50 is incomplete.
- shivalik:cohort DB (SHIVALIK_DEBUG_COHORT_DB_CONN_URL) exists in .env and service-db-map.json, with only an argo app dir mention (shivalik/CLAUDE.md L62). There is no service doc and no repo.
- The live .claude/settings.local.json has 67 allow entries including Bash(python3 *), git push, kubectl config/get pods on contexts ssfb-prod and ssfb-aspora, a literal cbs_curl prod call, and headroom, clickup and Slack MCP tools. Sandbox is disabled. The deny list covers only .env and .env.1, not .env.bak.*.
- .env has 26 keys, including SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY (field-decryption key) and LITBIT_SERVER_IP. .env.example lacks SHIVALIK_DEBUG_BRO_ADMIN_TOKEN and adds SHIVALIK_KUBE_CONTEXT.
- The Finacle bearer token appears in argv in three places: the laptop ssh command, the bastion remote command (cbs_curl L430-434), and curl -H inside the eventbus pod (L445-447). This contradicts the L424 comment.
- safe_sql passes the query with psql -c (safe_sql.sh L372). workflow_step_check.sh relies on -v plus :'form_id' (L96-142). Per the psql docs, -c gets no interpolation, so this path is likely broken. It has never run: prod-access.log has 0 rtl lines, 31 lines total, all safe_sql/shivalik/prod, from 09-13 to 09-17.
- lint_prod_access.sh has no git hook and no CI. It runs by hand only (.git/hooks contains only samples).
- search.py never reads os.environ. DEFAULT_URL http://quickwit.vance.local:7080 and DEFAULT_INDEX logs-v1 are hardcoded (L35-36).
- logs-finder SKILL.md L52-53: the shivalik logs-v1 row lists workflow-op; the atspl row covers package-svc, pulse-backend, canopy, engage and horus (via the qw CLI). qw is not installed (~/.local/bin/qw missing, not on PATH).
- Allowlist entry 4 intentionally uses a full path so that mutating stp-engine admin endpoints stay GET-only (allowed-non-get-requests.json). This safety knowledge would be lost with a bare {api, source} shape.
- make-share-zip.sh ships only git archive HEAD, so the untracked AGENTS.md, .agents and .codex are not distributed today.
- Batch/cohort use cases exist: scripts/bro/dry-run-use-case.py (batch BRO dry-run via safe_curl, prod BRO_HOST default hardcoded) and 8 loose customer CSVs in refs/.

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `.claude/skills/aspora-triage/scripts/redact.py` | PII masking filter with a --check gate (6+ digit runs to ****last4; UUIDs and ISO timestamps pass) | Port the logic as the output-redaction gate before Slack/CLI output |
| `.claude/hooks/block-raw-curl-psql.py` | Command-position blocklist plus a python/node/perl/ruby inline network/DB/.env scanner | Reuse the detection rules as reference for a tool-argument guard. Not needed if the new agent exposes no raw bash. |
| `.claude/skills/aspora-triage/scripts/safe_sql.sh` | SELECT/WITH guard, keyword denylist, subquery LIMIT wrap, read-only PGOPTIONS, 30s timeout | Port the guard semantics. Fix variable binding (use server-side params, not psql -c plus -v). |
| `.claude/skills/aspora-triage/config/allowed-non-get-requests.json` | Host-bound, method-scoped non-GET allowlist with reasons | Migrate its 4 entries into resources/ssfb.allow.api.json. Keep the host/method/reason semantics. |
| `triage-initial-setup/make-env-example.sh` | Derives a masked .env.example from .env and fails if a credential survives | Reuse the idea for the new .env.example check |
| `scripts/bro/dry-run-use-case.py` | Batch BRO dry-run through safe_curl subprocess | Reference for a batch/cohort tool; drop the hardcoded prod host default |
| `shivalik/scripts/list_transactions.sh` | Rhythm admin transactions lister through safe_curl | Candidate narrow GET tool (rhythm transactions by account_id) |

## Unknowns

- Is deleting the root CLAUDE.md in favour of AGENTS.md intentional? Should the new system read AGENTS.md as the knowledge source, and should both files be kept?
- What is the RTL Quickwit endpoint, index, auth model and service list? Is ATSPL still reachable only through the Okta OIDC proxy (qw CLI, not installed on this machine), and how should a headless agent authenticate to it?
- Should the new allowlist keep host binding (env:VAR), per-entry methods, reason and exact-vs-prefix matching, or is [{api, source}] meant literally? If 'source' is kept, is it a key into a base-URL env var?
- What should the env flag enabling the kubectl/bastion CBS path be called, and is it SSFB only? Does the OAuth password-grant POST need its own allowlist entry? Where should the token cache live instead of being written back into .env?
- Must the new agent be allowed to decrypt harbor fields (SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY / cmd/fle), or should that key be excluded from the agent's .env?
- Do the ATSPL/RTL DB credentials map to read-only Postgres roles on the server side?
- Where does the agent run: a laptop with VPN/WARP and a bastion SSH key, or a server? Who owns the SSH tunnel lifecycle?
- Does a Shivalik/ATSPL stage environment exist that must be supported? What are its hosts? (Only RTL stage is sketched, and it is commented out.)
- What is cohort (SHIVALIK_DEBUG_COHORT_DB_CONN_URL)? Which repo and service own it, and should triage cover it?
- Should RTL-london copies of eventbus, pdf-generator and reminder-service be in scope? Their DBs have no env vars.
- Are there admin API base URLs for RTL (workflow-op, banking-service, kyc-service) and ATSPL (package-svc, pulse)? None exist in .env.
- Are batch/cohort requests (DocketHub 100-customer lists, BRO batch dry-runs, outage impact analysis) in scope, or only single-ticket triage?
- Should recurring remediation writes (trigger-customer-creation, sync-address, trigger-delivery) ever go into the allowlist, or stay human-only?
- Which Slack credential (bot or user token) should read and post threads, now that today's path is only the interactive claude.ai connector? Should the reviewer (abhilash.shinde@aspora.com) and @nri-banking-on-call stay hardcoded?
- Should the DB credentials be rotated, given that an earlier survey subagent printed SHIVALIK_DEBUG_*_DB_CONN_URL values into a transcript?
- Are Serena, code-review-graph, headroom, ClickUp and Grafana/Playwright still wanted, or can the new design drop them?
- Should repos be pinned per entity to the deployed branch or tag (they currently track whatever is checked out, mostly pre-prod)?
- By pi-core, do you mean @earendil-works/pi-agent-core or the pi coding-agent CLI? Is leaving the Bun-only rule acceptable for Flue (Vite/Vitest/Node >=22.19)?
- Was prod-access.log recreated around 2026-09-13? Sentinels from 09-07 to 09-11 predate its first line.

## Contradictions

- '.codex/hooks.json points at a different checkout': WRONG. /Users/varun/code/aspora -> /Users/varun/code/work is a symlink (ls -ld), so it is the same tree. The real issue is absolute, machine-specific paths plus the $CLAUDE_PROJECT_DIR use in the SessionStart entry.
- '.Codex/ does not exist': PARTLY WRONG. macOS case-insensitivity maps .Codex to .codex (ls -d .Codex succeeds), but .Codex/skills and .Codex/prod-access.log are missing (ls .codex shows config.toml, hooks, hooks.json only).
- Citations to 'CLAUDE.md Lnn': the file is deleted in the working tree (git status ' D CLAUDE.md'). The citations are valid against git HEAD and the near-identical AGENTS.md.
- CLAUDE.md/AGENTS.md L116 'hook does not cover a Python helper' vs the hook: the hook is right. block-raw-curl-psql.py L12, L172-243 scan python/node/perl/ruby, so the docs are stale. lint_prod_access.sh L386 checks only requests|psycopg2?|urllib, so the claimed parity is false.
- --env required (CLAUDE.md/AGENTS.md L118) vs defaults: both sides are right per script. safe_sql, list_transactions (L20) and workflow_step_check require it. safe_curl (L447-452) and cbs_curl default to prod with a warning.
- cbs_curl 'token via exec stdin (not argv)' L424: WRONG, and worse than reported. The token is in ssh argv (L430-434) and in the in-pod curl -H argv (L445-447).
- logs-finder SKILL.md L52 'search.py via safe_curl.sh' and qw.md 'DEBUG_AI_QUICKWIT_URL overrides': both WRONG. search.py L22-24 uses urllib under a pragma and contains no os.environ/getenv. DEFAULT_URL and DEFAULT_INDEX are hardcoded at L35-36.
- repos/AGENTS.md watcher vs refresh-repos.sh 'no file watcher': refresh-repos.sh is right for per-repo indexes. repos/AGENTS.md L28-31 itself concedes the watcher binds only to the default project.
- triage-eval-capture.sh L14 '67 sentinels vs 3 cases': stale. Today there are 82 .claude/.triage-captured-* files, 0 in .agents, and 4 files in refs/eval-cases/.
- Entity map 'RTL = workflow-op, banking-service, kyc-service' (HEAD CLAUDE.md L43-50): incomplete. rtl/eventbus, rtl/pdf-generator and rtl/reminder-service CLAUDE.md document separate EKS london deployments.

## Spot checks

| Claim | Verdict | Evidence |
|---|---|---|
| PreToolUse(Bash)->block-raw-curl-psql.py, Stop->triage-eval-capture.sh, SessionStart->ensure_db_tunnel.sh + refresh-repos.sh | verified | .claude/settings.json (full file read) |
| BLOCKED_BINARIES = curl, wget, httpie, http, nc, ncat, telnet, psql, pgcli, pg_dump, pg_restore, mysql; ssh/kubectl/qw absent | verified | block-raw-curl-psql.py L116-129 |
| .env secret regex matches only .env and .env.1; .env.bak.* is unprotected by the hook and by the settings.local deny list | verified | block-raw-curl-psql.py L162 ENV_SECRET; the settings.local.json deny list has only .env and .env.1 entries |
| .codex/hooks/* byte-identical to .claude/hooks/* | verified | cmp on block-raw-curl-psql.py, refresh-repos.sh, triage-eval-capture.sh: all same |
| .codex/hooks.json paths belong to a different checkout | wrong | /Users/varun/code/aspora -> /Users/varun/code/work symlink |
| Non-GET allowlist has 4 entries, all Shivalik, shape {allowed:[{prefix,hosts,methods,reason}]} | verified | .claude/skills/aspora-triage/config/allowed-non-get-requests.json |
| service-db-map has 14 tenant:service entries; only RTL has uat | verified | config/service-db-map.json parsed: 9 shivalik, 2 atspl, 3 rtl (with uat) |
| safe_sql default LIMIT 200 via subquery wrap, read_only + 30s timeout | verified | safe_sql.sh L49 DEFAULT_MAX_ROWS=200; L359 CAPPED; L369 PGOPTIONS |
| prod-access.log 31 lines, all safe_sql/shivalik/prod, keys {ts,tool,tenant,env,service,target,summary,exit} | verified | Parsed: 31 lines, exits 29x0, 1x1, 1x2, ts 2026-09-13T03:51:30Z to 2026-09-17T08:09:58Z |
| 82 sentinels vs 4 eval cases | verified | ls .claude/.triage-captured-* \| wc -l = 82; refs/eval-cases has 4 .md files |
| .env has 26 keys; example lacks BRO_ADMIN_TOKEN and has KUBE_CONTEXT | verified | Key-name extraction and comm against .env.example (values not read) |
| eval_runner grades via grep -qiw over the whole conclusion | verified | eval_runner.sh L215-224 |

## Uncovered areas

- .serena/: Serena LSP config (bash only), empty memories. Unused.
- .code-review-graph/graph.db: stale code-review-graph DB (Sep 3).
- .codex/config.toml: Codex MCP registration of codegraph serve --mcp.
- AGENTS.md (root, untracked): Codex-renamed copy of the deleted CLAUDE.md.
- rtl/eventbus, rtl/pdf-generator, rtl/reminder-service CLAUDE.md: RTL-london deployment stubs for dual-deployed services.
- frontend/android/CLAUDE.md, frontend/ios/CLAUDE.md: pointer docs to the repos' own CLAUDE.md and GUARDRAILS.md.
- shivalik/scripts/list_transactions.sh: rhythm admin transaction lister via safe_curl, --env required.
- scripts/bro/ (dry-run-use-case.py, join_dryrun.py, CSVs): batch BRO dry-run tooling and PII CSVs.
- tmp/bro/checks.json: dump of BRO STP check definitions.
- refs/*.csv and .numbers: 8 loose DocketHub/RFI customer lists for batch analysis.
- triage-initial-setup/apply-update.py, make-share-zip.sh, merge-claude-md.sh: share-zip distribution and 3-way update tooling (git archive HEAD only).
- .claude/skills/aspora-triage/scripts/redact.py: PII masking gate (mentioned only in passing by one report).
- .gitignore: has uncommitted changes; ignores .headroom, .serena, code-review-graph.
