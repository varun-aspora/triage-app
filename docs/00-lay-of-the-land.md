# 00. Lay of the land (current state of triage-shivalik)

Consolidated from nine read-only survey reports in [`survey/`](survey/) produced on 2026-09-23. Each claim below is backed by a file citation in those reports. Nothing here was verified against a live system; no network or DB call was made.

Legend: **F** fact seen in a file, **I** inference, **U** unknown.

## 1. What exists today

The current triage setup is a Claude Code / Codex workspace at `~/code/aspora/triage-shivalik`. A human opens the CLI, pastes a Slack thread, and Claude investigates using:

| Layer | What it is | Where |
|---|---|---|
| Knowledge | Root `CLAUDE.md` (deleted in working tree, see §6) + `AGENTS.md`, per-entity `{shivalik,atspl,rtl,frontend}/CLAUDE.md`, per-service `CLAUDE.md`, `NRI_ONBOARDING.md` spines | survey 04, 05, 02 |
| Skills | `aspora-triage` (method, evidence ladder, confidence rubric), `aspora-logs-finder` (Quickwit / Grafana), `aspora-harbor-shivalik-sim-binding-issue`, `aspora-triage-slack-report`, `continuous-setup` | survey 04 |
| Guard scripts | `safe_curl.sh` (GET-only, host allowlist from `.env`, curl-option allowlist), `safe_sql.sh` (SELECT-only regex, LIMIT wrap, read-only txn, 30s timeout), `cbs_curl_via_eventbus.sh` (ssh → kubectl exec → curl to Finacle), `redact.py` | survey 06 |
| Hooks | `PreToolUse(Bash)` deny for raw curl/psql/etc. and inline Python/Node network code; `Stop` eval-capture questionnaire; `SessionStart` runs the SSH DB tunnel and a repo refresh | survey 06 |
| Config | `service-db-map.json`, `service-api-map.json` (`tenant:service → {prod, uat}: ENV_VAR`), `allowed-non-get-requests.json` (4 entries, all Shivalik) | survey 06, 03 |
| Code nav | 20 repos under `repos/`, one CodeGraph SQLite index each, `codegraph` 1.6.0 CLI and stdio MCP | survey 01 |
| Audit | `.claude/prod-access.log` JSONL `{ts,tool,tenant,env,service,target,summary,exit}`, no session or request id | survey 06 |
| History | `refs/` with ~143 investigation directories and 4 labelled eval cases | survey 08 |

## 2. Entities and data sources

| Entity | Services (F) | DB reach (F) | Admin API (F) | Logs (F / U) |
|---|---|---|---|---|
| **SSFB / Shivalik** | harbor, rhythm, guardian, comms, audit, bro, eventbus, pdf-generator, reminder-service, workflow-op (Shivalik copy), cohort (DB only, undocumented) | 9 Postgres DBs, all via one SSH forward `localhost:55432` → RDS reader (VPC has no WARP route) | harbor, rhythm on Kong internal gateway `…:9443/{harbor,rhythm}`; bro under `/bro` on the same host; `x-customer-id` header expected | Quickwit `quickwit.vance.local:7080`, index `logs-v1`, no auth, VPN only. Single-CPU instance, was knocked over by 10 concurrent workers |
| **ATSPL** | pulse (ops console proxying harbor/rhythm admin), package-svc (physical delivery), canopy (docs disagree) | package_db, pulse_db direct over WARP (Mumbai reader) | package-svc endpoints documented; **no base URL env var exists** | Quickwit via `qw` CLI, `quickwit-proxy.vance.finance` behind Okta OIDC (browser login), index `envoy-logs`. `qw` is **not installed** on this machine. No audit log |
| **RTL** | workflow-op, banking-service, kyc-service; plus London copies of eventbus, pdf-generator, reminder-service | banking_db, kyc_db, workflow_op_db direct over WARP (London reader); stage vars commented out | **no base URL env var exists** | **Nothing documented.** Past cases say Shivalik `logs-v1` does not carry RTL London traffic. Your brief says Quickwit now exists here: endpoint, index and auth are U |
| Frontend | vance-android, vance-ios | none | none | none. Code reading only |

Cross-entity joins that real cases used (F, survey 02 §3, survey 08 §4):

- Aspora `userId` = `harbor.account_forms.external_user_ref`. "Horus Customer ID" in the Slack bot template = `harbor.customer.customer_id` (not the userId).
- harbor `form_id` = `workflow_op_db.workflow_executions.reference_id` where `reference_type='FORM'` (RTL or Shivalik copy of workflow-op).
- harbor `customer.customer_id` = `package_db.delivery_requests.external_ref_id` (welcome letter, ATSPL).
- harbor `customer_id` → `rhythm.customer_account_mappings` → `account_id` (UUID, admin APIs) and `account_number` (CBS, best log key).
- Remittance backend `POST /appserver/v3/order` is not mapped to any entity; those cases ended in escalation.

## 3. How stage vs prod is handled today (what you want removed)

- Every wrapper takes `--env prod|uat` (`stage` is a deprecated alias). `safe_sql` requires it; `safe_curl` and `cbs_curl` default to prod with a warning.
- Env var names encode the environment: `_DEBUG_` means prod, `RTL_STAGE_*` means uat, `cbs_curl` swaps a `SHIVALIK_` / `SHIVALIK_UAT_` prefix. No UAT keys exist for Shivalik or ATSPL.
- Hardcoded prod values live in scripts: RDS host, Quickwit URL and index, k8s namespace/secret/selector, OAuth scope.
- **I:** env and tenant are only lookup keys into `.env` names. One `.env` per deployment collapses every map to `entity:service → VAR` with no branching. That is what the new design does.

## 4. Guardrails: what actually holds and what does not

- The PreToolUse hook calls itself "an accident-stopper, not a security boundary". It cannot see `kubectl exec … curl`, `ssh host "curl"`, variable indirection, or a Python helper run via shebang. `ssh`, `kubectl` and `qw` are not blocked at all.
- Live `.claude/settings.local.json` has drifted to 67 allow entries including `Bash(python3 *)`, `git push`, kubectl on prod contexts and a literal CBS prod call. Sandbox is off. **Lesson:** IDE-maintained allowlists drift; the new agent must own its gate in code.
- `safe_sql` is regex, not a parser. False positives on identifiers like `last_update` (matches `UPDATE`), and `-v` variable binding under `psql -c` is probably broken (never exercised: zero RTL lines in the audit log).
- `cbs_curl` puts the Finacle bearer token in argv on the laptop, the bastion and inside the pod, and writes the token back into `.env`. Its OAuth mint is itself a non-GET that is not on the allowlist.
- `search.py` and `qw` bypass the wrappers by design (pragma allowlist) and do not write audit lines.
- `.env` holds `SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY`, a field-decryption key, next to read-only DB creds.
- **Incident during this survey:** one subagent's redaction regex missed quoted values and printed the 9 Shivalik DB connection URLs, credentials included, into its own transcript. Not repeated anywhere in these docs. You should decide whether to rotate them.

## 5. Request shape and taxonomy (from ~35 cases read in depth, 129 bucketed)

- 130 of 142 archive links point to `#nri-banking-cx`. 60 threads carry the "New CX Issue Raised" bot template: Priority, Alphadesk user ID, Horus Customer ID, Horus NSTP Application ID, Tag, Country, Summary, Description.
- Horus Customer ID present in 75 of 118 threads, Alphadesk UUID in 22, no customer UUID at all in 13. 73 threads rely on screenshots and the exact error text is often only in the image.
- Slack `Tag` and `Summary` misclassify often; the classifier must expect to be re-routed after the first lookup.
- 38 threads pivot ("moved to tech"); the current ask is the latest message, not the parent.

| Category | Count | Entities | Typical difficulty |
|---|---|---|---|
| Onboarding (notary, AOF/e-sign, PAN mismatch, RFI/NSTP, CBS creation, RTL Part-1) | ~34 | SSFB harbor + workflow-op; RTL for Part-1 | multi-hop, many known patterns |
| Auth: MPIN, session, device | ~18 | harbor, guardian, mobile clients | hard, root cause often client-side |
| Welcome letter / delivery / address | ~17 | SSFB harbor → ATSPL package_db | single lookup + vendor scope; often ends in a write request |
| Outward transfers (IMPS/NEFT) | ~16 | rhythm, CBS | medium, two known rhythm bugs cover most |
| Inward funding / remittance | ~9 | SSFB + unmapped remittance backend + RTL (UAE) | hard, answer lives elsewhere |
| Cards | 7 | rhythm, CBS | medium to hard |
| Beneficiary | 6 | rhythm | hard, one case was misdirected money |
| Account/balance view | 5 | rhythm | medium |
| UPI / third-party | 5 | outside Aspora | easy, known answer |
| FD/TD | 3 | rhythm, CBS | hard |
| Systemic / outage | 2 (+2) | fleet-wide | hard, analytical |

39 notes matched an already documented pattern (cheap-tier candidates). 14 directories contain a correction of a first-pass conclusion. 46 recommend a write action (`trigger-delivery`, `sync-address`, `trigger-customer-creation`, `debit-unfreeze`); some were actually executed.

Good output shape used by the team: ID chain table → current state → UTC timeline with raw evidence → root cause with `file:line` → scope (one customer or systemic) → recommended actions split for CX / Eng / Ops-Bank → status line. CX needs: user action or backend action, is the money safe, should the user retry, a copy-pasteable reply, who to escalate to.

## 6. Workspace state worth knowing

- Root `CLAUDE.md` is deleted in the working tree; `AGENTS.md`, `.agents/`, `.codex/` are untracked. The workspace is mid-way through a Codex migration. Citations to `CLAUDE.md:L` in the surveys refer to git HEAD.
- `.agents/skills` SKILL.md files point at `.Codex/...` paths that only resolve because macOS is case-insensitive; `.codex/` holds no skills.
- `/Users/varun/code/aspora` is a symlink to `/Users/varun/code/work`.
- `.env.example` is stale versus `.env` (missing `SHIVALIK_DEBUG_BRO_ADMIN_TOKEN`, extra `SHIVALIK_KUBE_CONTEXT`).
- CodeGraph: CLI `explore`/`node` give the same output as the MCP tools; `query`/`callers`/`impact` support `--json`. Freshness comes from `repos/git-clone.sh` running `codegraph sync`; the daemon's watcher only covers the workspace root. Latest refresh succeeded 2026-09-23 14:12.
- Serena, code-review-graph, graphify hooks and `git-bare/` look abandoned.
- Batch/cohort work (DocketHub 100-customer status, BRO dry runs, outage impact) lives in `refs/` alongside single-ticket triage.

## 7. Framework layering in the new repo

`@flue/runtime` 2.0.8 depends on `@earendil-works/pi-agent-core` and `pi-ai` 0.83.0 and builds its turn loop on pi-agent-core's `Agent` class. So the choice is not Flue *or* pi; Flue sits on pi. Details and the decision are in [05-decisions.md](05-decisions.md) D1.

One gap matters for this design: pi-agent-core has a native `beforeToolCall` that sees validated arguments and can block, but Flue does not pass it through and exposes no argument-aware pre-tool hook. Flue's `instrument()` interceptor sees only the tool name. Gating therefore lives inside each tool's `run` and in what gets mounted.

## 8. Where to read more

- [survey/06-guardrails-hooks.md](survey/06-guardrails-hooks.md), [survey/05-entities-shivalik.md](survey/05-entities-shivalik.md), [survey/02-entities-atspl-rtl-frontend.md](survey/02-entities-atspl-rtl-frontend.md), [survey/04-skills-agents.md](survey/04-skills-agents.md), [survey/03-env-and-setup.md](survey/03-env-and-setup.md), [survey/08-past-cases-taxonomy.md](survey/08-past-cases-taxonomy.md), [survey/01-code-navigation.md](survey/01-code-navigation.md), [survey/07-frameworks.md](survey/07-frameworks.md), and the cross-check in [survey/09-completeness-critic.md](survey/09-completeness-critic.md).
