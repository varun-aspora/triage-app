# ATSPL, RTL and FRONTEND entities

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## Scope and method
I read, as text only, atspl/{CLAUDE.md,NRI_ONBOARDING.md,pulse/CLAUDE.md,package-svc/CLAUDE.md}, rtl/{CLAUDE.md,NRI_ONBOARDING.md,*/CLAUDE.md,scripts/workflow_step_check.sh}, frontend/{CLAUDE.md,NRI_ONBOARDING.md,android/CLAUDE.md,ios/CLAUDE.md}, plus the supporting files .env.example (key names and host patterns only), .claude/skills/aspora-triage/config/service-db-map.json, .claude/skills/aspora-triage/scripts/safe_sql.sh (grep), .claude/skills/aspora-logs-finder/{SKILL.md,references/env/atspl/qw.md}, and a few refs/*/findings.md files for evidence of real cross-entity use. I ran nothing that touches the network or a database. All paths below are relative to /Users/varun/code/aspora/triage-shivalik.

## 1. Per entity

### ATSPL
- **Services (FACT, atspl/CLAUDE.md:9-12):**
  - pulse: "ATSPL event stream". atspl/NRI_ONBOARDING.md:43-48 corrects this. Pulse is a Java Spring Boot SDUI back-office for staff, with maker-checker approval. It makes synchronous HTTP proxy calls into the harbor admin API (`HARBOR_BASE_URL`/`HARBOR_API_KEY`) and the rhythm admin APIs. pulse_db holds no onboarding tables, only an `iam` schema. Audit data goes to MongoDB. Kafka is used only for `pulse.audit.logs`, and that consumer is commented out.
  - package-svc: a Go physical-delivery service ("PSE") for welcome letters and debit cards, shipped via DocketHub UK and Shipa/Aramex UAE. Its transport is SQS (atspl/NRI_ONBOARDING.md:21,37).
  - canopy: no repo and no DB env var. The docs contradict each other on it (see Contradictions).
- **DBs (FACT):**
  - package_db → `ATSPL_DEBUG_PACKAGE_DB_CONN_URL`; pulse_db → `ATSPL_DEBUG_PULSE_DB_CONN_URL` (atspl/CLAUDE.md:14-20).
  - In .env.example both point to host `vance-envoy-prod-mumbai-01-common-pg-db-reader.internal.genorim.xyz:65432`, with `application_name=atspl_triage_user`. That section is headed "mumbai 'common' pg reader — also usable for RTL *stage* DBs by swapping the db name".
  - .env.example also says "RTL and ATSPL DBs are the opposite: direct over WARP, no tunnel". CONFIRMED as a documented claim. Shivalik DB URLs are localhost:55432 through ensure_db_tunnel.sh, while the ATSPL and RTL URLs are internal genorim.xyz hosts with no tunnel script. INFERENCE: nothing in these files tests WARP reachability.
  - Access path: safe_sql.sh `--tenant atspl --service package|pulse`, prod only. service-db-map.json has no uat entries for atspl.
- **Admin APIs (FACT, atspl/NRI_ONBOARDING.md:33-35):**
  - package-svc: `POST /api/v1/deliveries`, `GET /api/v1/deliveries/:id`, `GET /api/v1/deliveries/user/:userId`, `POST /api/v1/deliveries/:id/{retry,sync-status}`, `POST /webhook/:vendor_id`.
  - Re-trigger goes through harbor: `POST /harbor/admin/v1/customers/:customer_id/trigger-delivery`.
  - No ATSPL base-URL env var for package-svc or pulse exists in the .env.example lines I read. UNKNOWN whether a GET to package-svc is reachable at all.
- **Logs:** see section 2. The docs claim ATSPL has its own Quickwit ("envoy-prod" cluster, index `envoy-logs`), and that Shivalik's `quickwit.vance.local:7080` / `logs-v1` "is **SSFB only**" (atspl/CLAUDE.md:24-28).

### RTL
- **Services (FACT, rtl/CLAUDE.md:9-21):**
  - workflow-op: the onboarding engine and SDUI templates.
  - banking-service: Go. Covers onboarding Part 1 (pre-CBS), with modules nri, evisa, survey.
  - kyc-service: Java 21 / Spring Boot / JDBI. System of record for Persona KYC and eVisa.
  - Also deployed in RTL: eventbus, pdf-generator, reminder-service, each a stub that points to shivalik/*.
  - Deployment: prod is london (eu-west-2) on ECS/EKS, stage is mumbai (ap-south-1). This is a separate cluster from SSFB (rtl/CLAUDE.md:23, rtl/NRI_ONBOARDING.md:91).
- **Dual deployment (FACT, rtl/NRI_ONBOARDING.md:99):** workflow-op also runs on the SSFB cluster (`PROFILE=shivalik-prod`). `SHIVALIK_DEBUG_WORKFLOW_DB_CONN_URL` reaches that Shivalik copy, not RTL london.
- **DBs:**
  - Docs: workflow_op_db, kyc_service, and banking-service survey-only tables (`surveys`, `survey_responses`). banking-service's prod DB_NAME is "not in the repo" (rtl/banking-service/CLAUDE.md:6, rtl/NRI_ONBOARDING.md:63,93-97).
  - .env.example: `RTL_DEBUG_{BANKING,KYC,WORKFLOW}_DB_CONN_URL` all point to `vance-core-prod-london-01-common-pg-db-reader.internal.genorim.xyz:5432`, with db names `banking_db`, `kyc_db`, `workflow_op_db` and `application_name=rtl_triage_user`. `RTL_STAGE_*` entries are commented out.
  - service-db-map.json maps `rtl:banking|kyc|workflow` to prod `RTL_DEBUG_*` and uat `RTL_STAGE_*`.
- **Endpoints (FACT, rtl/NRI_ONBOARDING.md:29-33,53-59,71-74):**
  - workflow-op mobile API: `/api/v1/workflow/user/{status,submit?type=,poll,go-back}`.
  - banking-service: `/banking/v1/nri/external/form-submission-data`. This is the endpoint harbor pulls from; `data_token` = userId. Also `/banking/v1/nri/admin/{exit-nudge,excitement-survey}` and `/banking/v1/evisa/workflow/step-handler(/poll)`.
  - kyc-service (context `/kyc-service`): `/api/v1/inquiries/*`, `/api/v1/visa/*`, and `/api/v1/admin/inquiries/{get-or-create,{id}/sync,{id}/force-sync}`.
  - No RTL API base-URL env vars are in .env.example.
- **Key tables:**
  - workflow_executions: reference_id, reference_type, workflow_identifier, status, sub_status, current_step_identifier, current_step_index, step_data.
  - Also workflow_definitions, ui_templates, workflow_execution_actions.
  - kyc_inquiries: status is the verdict of record; also partner_inquiry_id and idempotency_id. Also kyc_verifications, kyc_sync_audit, visa_inquiries, visa_attempts.
  - Source: rtl/NRI_ONBOARDING.md:38-43,76-83.
- **Verdict delivery gotcha:** Persona verdicts arrive on the SQS `critical-webhook-events` queue, not over HTTP (rtl/NRI_ONBOARDING.md:85).
- **Logs (FACT):**
  - rtl/workflow/CLAUDE.md:26 says "Quickwit service name: `workflow-op` or `workflow-v2` (confirm when investigating)".
  - rtl/NRI_ONBOARDING.md:116 says "RTL runs on the london cluster — confirm the log index covers it".
  - logs-finder SKILL.md:51-53 lists only two environments, `shivalik` and `atspl`. There is no `rtl` environment and no references/env/rtl/.
  - refs/confirm-details-not-clickable-f601f596/findings.md:73-99 and refs/notarization-stuck-verify-docs-p1788429215/findings.md:36 state that Shivalik `logs-v1` does not carry RTL london Part-1 traffic, and that "logs are a dead end for RTL london".
  - STALE relative to the user's statement that Quickwit is now in all entities: there is no documented RTL Quickwit endpoint, index, or tool. UNKNOWN: RTL's URL, index, and auth.

### Frontend
- **Repos (FACT):** repos/vance-android (Kotlin; modules app, banking-sdk, data-layer, forex, analytics) and repos/vance-ios (Swift/SwiftUI). Both are cloned (frontend/android/CLAUDE.md, frontend/ios/CLAUDE.md).
- **Triage role (frontend/CLAUDE.md:3):** "Not backend triage surfaces — no prod DB, no Quickwit service name." They matter only for client-side issues.
- frontend/NRI_ONBOARDING.md is derived from vance-android only (line 1 heading and line 5). There is no iOS onboarding spine.

## 2. The qw CLI (ATSPL)
FACT, from .claude/skills/aspora-logs-finder/references/env/atspl/qw.md.
- **Tool and install:** the `qw` CLI, documented as `/Users/varun/.local/bin/qw` v0.3.0 (line 11). Checking the filesystem, that path does not exist and `which qw` finds nothing. So it is not installed on this machine now, or it lives somewhere else. UNKNOWN where qw comes from (vendor, repo).
- **Connection:** context `envoy-prod`; endpoint `https://quickwit-proxy.vance.finance`; OIDC issuer `https://freeway.aspora.com` (Okta, browser flow); default index `envoy-logs`; Quickwit 0.9.0-nightly.
- **Auth:**
  - `qw whoami` and `qw ping` check the token and reachability.
  - `qw context use envoy-prod && qw login` opens a browser and blocks. "Claude cannot complete it" (lines 37-39), so an operator has to do it.
  - safe_curl.sh cannot reach this proxy: it is not in the allowlist, and it needs a bearer token (lines 18-20).
- **Verbs:** search, count, histogram, tail, indexes list|describe|fields, ping, whoami, login. Flags: `--since`, `--from/--to`, `--max-hits`, `-o json|raw`, `--jq`, `--explain`.
- **Read-only by construction:** there is no write verb (lines 83-96, 134-137).
- **Audit gap:** qw does not write to `.claude/prod-access.log` (lines 132-137; atspl/CLAUDE.md:42).
- **Indexes:** envoy-logs (297M docs, retained from about 2026-02-05), envoy-logs-v1 (near-duplicate), otel-logs-v0_7/v0_9, otel-traces-v0_7/v0_9.
- **Exact service strings:** `package`, `package-worker-sync`, `package-worker-queue`, `pulse-backend` (`pulse` returns 0), `canopy`, `comms`/`comms-consumer`/`comms-ui`, `engage`, `horus`, `kong`/`kong-internal`/`kong-vendor`, `kafka-connect`.
- **Query gotchas:**
  - `service:harbor` here matches a kafka-ui container. It is NOT Shivalik harbor.
  - `level` is lowercase.
  - Hyphenated fields such as `x-req-id` must be unquoted.
  - Useful fields: `message` (developer label) vs `error` (user-facing text); `raw_message` holds the full JSON; plus x-req-id and x-txn-id.

## 3. Cross-entity flows and join keys
FACT unless marked otherwise.
1. **NRI onboarding Part 1 (RTL) → Part 2 (Shivalik).**
   - The mobile app routes each screen by `workflowOwner`: `ASPORA_RTL` or `SHIVALIK_BANK` (frontend/NRI_ONBOARDING.md:11-27).
   - Harbor pulls Part-1 data from banking-service `form-submission-data`, keyed by `data_token` = userId. banking-service in turn reads the NRI execution from RTL workflow-op (rtl/NRI_ONBOARDING.md:21,56,61).
   - Joins: Aspora userId = harbor `account_forms.external_user_ref` (shivalik/NRI_ONBOARDING.md:56). Harbor `form_id` = workflow-op `workflow_executions.reference_id` with `reference_type='FORM'` (rtl/workflow/CLAUDE.md:12). Harbor `customer.account_form_id` = form_id (workflow_step_check.sh:140-142).
   - UNKNOWN: the reference_id/reference_type of the RTL-side Part-1 execution (userId vs form_id). No doc states it.
2. **workflow-op dual deploy.** The same form can sit in the RTL copy or the Shivalik copy. The script tells the operator to retry the other tenant if one comes back empty (workflow_step_check.sh:16-22,104-106). Both prior refs actually queried the Shivalik copy.
3. **Welcome letter (Shivalik harbor ↔ ATSPL package-svc).**
   - Harbor publishes `WelcomeLetterDeliveryRequested`, then calls `POST /api/v1/deliveries` with `ExternalRefID`=`UserID`=harbor customer_id.
   - package-svc does `GET /harbor/admin/v1/addresses/:address_id` and calls back to `POST /harbor/v1/callbacks/package/delivery/:external_ref_id`.
   - Joins: `package_db.delivery_requests.external_ref_id` = `harbor_db.customer.customer_id`. Also harbor `customer_deliveries` keyed by customer_id, and `address_id` (atspl/NRI_ONBOARDING.md:23-39,73).
   - Used for real in refs/welcome-letter-not-triggered-44f85302/findings.md:15-55.
4. **Ops console (ATSPL pulse → Shivalik harbor/rhythm).** Pulse proxies harbor admin, so for triage you check harbor state first (atspl/NRI_ONBOARDING.md:47,74). Refs cite pulse tickets such as NSTP_INTERNAL_REVIEW, keyed by form_id (refs/d590fbf6-account-open-error/notes.md:28,45; refs/poa-notarised-status-16947a2c/findings.md:18).
5. **KYC/eVisa (RTL kyc-service ← banking-service ← workflow-op).** banking-service returns `partner_inquiry_id` as `visa_inquiry_id`: same value, different names (rtl/kyc-service/CLAUDE.md:27). UNKNOWN: which column in kyc_inquiries joins to the Aspora userId (the context header is `x-user-id`, rtl/kyc-service/CLAUDE.md:22).
6. **SDUI templates and cohorts.** RTL/Shivalik workflow_definitions `cached_resolvers` join to Shivalik `cohort_db` (`cohort_definitions` × `cohort_participations`) via `SHIVALIK_DEBUG_COHORT_DB_CONN_URL` (rtl/workflow/CLAUDE.md:38-47).
7. **Client → backend.** `screen_type` + `workflowOwner` decide which backend. Part-2 steps (pan_name, nominee, notary_live, sign_document, rfi, account_creation, review_details, mpin_setup) go to Shivalik. Everything else goes to RTL (frontend/NRI_ONBOARDING.md:35-61).
8. **Out of scope.** user-vault, appserver, and canopy chat are Aspora-core or ATSPL-support services that are not cloned (frontend/NRI_ONBOARDING.md:94-104).

## 4. Scripts
The only script is rtl/scripts/workflow_step_check.sh.
- **Usage:** `--env prod|uat` (required; `stage` is a deprecated alias for uat), `--tenant rtl|shivalik` (default `rtl`; `--org` is deprecated), `--form-id <id>` (required), `--peer-compare` (lines 5-6, 57-84).
- **What it runs:** three or four SELECTs through `.claude/skills/aspora-triage/scripts/safe_sql.sh`, using psql `-v` substitution (`:'form_id'`) because the input comes from untrusted Slack text (lines 13-14):
  - (a) `workflow_executions` for the tenant: `WHERE reference_id=:'form_id' AND reference_type='FORM'`.
  - (b) harbor `account_forms` (form_id, status, status_v2, session_id, is_deleted=false), always with tenant shivalik.
  - (c) harbor `customer WHERE account_form_id`.
  - (d) optional peer cohort: `status, COUNT(*)` grouped over the same workflow_identifier + current_step_identifier.
- **Output parsing:** TSV output is re-delimited with `\x1f` so NULL columns are not dropped (lines 43-48).
- **Schema caveats:** it notes `total_completion/created_at/updated_at` and `status_v2` are unverified columns (lines 27-35).
- **safe_sql.sh interface:** `--env prod|uat [--tenant shivalik|atspl|rtl] --service <svc>`. It resolves `tenant:service` to an env var via service-db-map.json and asks for `--tenant` only when the service name is ambiguous (safe_sql.sh:7-22,201-249).
- **Design note (INFERENCE):** the env-selection flag and tenant model are exactly what the user wants to drop in favour of .env-only configuration.

## 5. How frontend docs are used
FACT: code reading only. There is no DB, log, or API tooling for the clients (frontend/CLAUDE.md:3). The docs are routing aids:
- Map `screen_type` → `workflowOwner` → backend.
- Host resolution:
  - Part 2 goes to `https://aspora[-uat].shivalik.bank.in/{guardian|harbor|rhythm|workflow-op|canopy}/` (banking-sdk Environment.kt/NetworkModule.kt).
  - Part 1 goes to the Aspora Kong gateway, whose base URL comes from country config.
- Auth-mode hint: `ONBOARDING_SESSION` vs `BANKING_ACCESS_TOKEN`.
- Completion markers: `nri_onboarding_completed` and `nri_onboarding_part2_completed`.
- Key Android files (frontend/NRI_ONBOARDING.md:65-77,108-115).

The per-platform CLAUDE.md files only point to the in-repo docs. repos/vance-android/{CLAUDE.md,AGENTS.md} and repos/vance-ios/{CLAUDE.md,GUARDRAILS.md} are authoritative. Codegraph is not mentioned in the frontend docs.

## Key facts

- ATSPL services: pulse (pulse-backend ops console, proxies harbor/rhythm admin) and package-svc (Go delivery via SQS); canopy has no repo or DB (atspl/CLAUDE.md:9-20, atspl/NRI_ONBOARDING.md:21-54)
- ATSPL DBs package_db/pulse_db via ATSPL_DEBUG_{PACKAGE,PULSE}_DB_CONN_URL at vance-envoy-prod-mumbai-01-common-pg-db-reader.internal.genorim.xyz:65432 (.env.example:87-90)
- .env.example:29 states 'RTL and ATSPL DBs are the opposite: direct over WARP, no tunnel'; Shivalik uses localhost:55432 via ensure_db_tunnel.sh
- RTL DBs via RTL_DEBUG_{BANKING,KYC,WORKFLOW}_DB_CONN_URL at vance-core-prod-london-01-common-pg-db-reader.internal.genorim.xyz:5432, db names banking_db/kyc_db/workflow_op_db; RTL_STAGE_* commented out (.env.example:92-100)
- service-db-map.json maps tenant:service to env var names: atspl:package|pulse (prod only), rtl:banking|kyc|workflow (prod+uat), and 9 shivalik:* (.claude/skills/aspora-triage/config/service-db-map.json)
- RTL prod = london eu-west-2, stage = mumbai ap-south-1, separate cluster from SSFB (rtl/NRI_ONBOARDING.md:91)
- workflow-op is dual-deployed (RTL london + SSFB shivalik-prod); SHIVALIK_DEBUG_WORKFLOW_DB_CONN_URL reaches the Shivalik copy only (rtl/NRI_ONBOARDING.md:99)
- ATSPL logs: qw CLI, context envoy-prod, https://quickwit-proxy.vance.finance, Okta OIDC issuer https://freeway.aspora.com, index envoy-logs (.claude/skills/aspora-logs-finder/references/env/atspl/qw.md:9-16)
- qw documented at /Users/varun/.local/bin/qw v0.3.0 but not present on disk and not on PATH now (qw.md:11; filesystem check)
- qw login needs an interactive browser Okta login; qw writes no audit log (qw.md:37-39,132-137)
- logs-finder skill knows only the shivalik and atspl environments; no RTL log environment is documented (.claude/skills/aspora-logs-finder/SKILL.md:51-53)
- Past refs say Shivalik logs-v1 does not carry RTL london Part-1 traffic (refs/confirm-details-not-clickable-f601f596/findings.md:73-99)
- Join: harbor form_id = workflow_executions.reference_id with reference_type='FORM' (rtl/workflow/CLAUDE.md:12)
- Join: package_db.delivery_requests.external_ref_id = harbor customer.customer_id (atspl/NRI_ONBOARDING.md:33)
- Join: harbor pulls Part-1 via banking-service POST /banking/v1/nri/external/form-submission-data with data_token = userId; userId = account_forms.external_user_ref (rtl/NRI_ONBOARDING.md:56; shivalik/NRI_ONBOARDING.md:56)
- Join: harbor customer.account_form_id = form_id (rtl/scripts/workflow_step_check.sh:140-142)
- Persona verdicts arrive via the SQS critical-webhook-events queue, not an HTTP webhook (rtl/NRI_ONBOARDING.md:85)
- workflow_step_check.sh takes --env prod|uat, --tenant rtl|shivalik, --form-id and optional --peer-compare, and runs SELECTs through safe_sql.sh with -v binding (rtl/scripts/workflow_step_check.sh:5-6,95-177)
- Mobile routes each step by workflowOwner (ASPORA_RTL vs SHIVALIK_BANK), not by URL; paths are identical on both hosts (frontend/NRI_ONBOARDING.md:11-27)
- Frontend is code-reading only: no prod DB, no Quickwit service name (frontend/CLAUDE.md:3)
- frontend/NRI_ONBOARDING.md is built from vance-android only; there is no iOS onboarding spine (frontend/NRI_ONBOARDING.md:1,5)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `.claude/skills/aspora-triage/config/service-db-map.json` | tenant:service to DB env-var map covering shivalik, atspl and rtl | port: keep the entity:service to env-var idea, but drop the prod/uat split, since the new design configures environments only through .env |
| `.claude/skills/aspora-logs-finder/references/env/atspl/qw.md` | ATSPL Quickwit endpoint, auth, exact service names, field schema and query gotchas | port: move the service names and gotchas into per-entity log config and knowledge; replace the interactive qw login with a token supplied through .env, if that is allowed |
| `rtl/scripts/workflow_step_check.sh` | Cross-entity form diagnostic (RTL or Shivalik workflow_executions plus harbor account_forms/customer) with a peer-cohort check | port: turn it into a typed tool (form_id, then parallel queries per entity) without the --env/--tenant flags; keep -v bind parameters |
| `rtl/NRI_ONBOARDING.md` | RTL Part-1 flow, endpoints, tables and failure points | reuse as-is as retrievable knowledge for the triage agent, after fixing the stale 'Gap' section |
| `frontend/NRI_ONBOARDING.md` | screen_type to workflowOwner to backend routing table and host resolution | reuse as-is as a routing knowledge file for classifying which entity a stuck screen belongs to |
| `atspl/NRI_ONBOARDING.md` | Welcome-letter flow and package-svc/pulse roles, with join keys | reuse as-is as knowledge; also fold its corrections back into atspl/CLAUDE.md and pulse/CLAUDE.md |
| `rtl/workflow/CLAUDE.md` | workflow-op tables, the JsonTemplateHandler failure signature, and the SDUI template/cohort rules | reuse as-is as knowledge; fix the DB env-var line, and replace its static-asset curl sweep with a mock or allowlisted GET tool |
| `.claude/skills/aspora-triage/scripts/safe_sql.sh` | SELECT-only psql wrapper with -v binding and prod-access.log audit | port: keep SELECT-only enforcement, bind parameters and the audit log in the new SQL tool; drop the env/tenant flags |

## Unknowns

- The user says Quickwit is now in every entity. For RTL (london), what are the endpoint, index and auth model? Is it the same OIDC proxy as ATSPL (quickwit-proxy.vance.finance) or a separate one? Nothing in the workspace documents it.
- Is the ATSPL envoy-prod qw endpoint still the one to use, and can the new agent authenticate without an interactive browser login (for example a service token in .env)?
- Where does the qw CLI come from? It is documented at ~/.local/bin/qw v0.3.0, but it is not installed on this machine now.
- For an RTL-side Part-1 workflow_executions row, what are reference_id and reference_type? userId or form_id? No doc says.
- Which kyc_inquiries column joins to the Aspora userId or harbor form_id?
- What is the actual RTL kyc DB name: kyc_service (rtl/NRI_ONBOARDING.md:96) or kyc_db (.env.example RTL_DEBUG_KYC_DB_CONN_URL)?
- Are the RTL_DEBUG_* and ATSPL_DEBUG_* replicas reachable over WARP today? The refs from 2026-09-17 still describe them as unfilled.
- Are there base URLs for RTL (workflow-op, banking-service, kyc-service) and ATSPL (package-svc, pulse) admin APIs? No such env keys appear in .env.example, so GET-only API triage against these entities has no configured target.
- Which sources does the future {entity}.allow.api.json need for ATSPL and RTL (for example package-svc, pulse, workflow-op, banking-service, kyc-service)? None exist today.
- Should the iOS app get an onboarding spine equivalent to frontend/NRI_ONBOARDING.md, or is Android treated as representative?
- Is canopy a live ATSPL service that triage should cover? The qw logs show it; the code references it nowhere.

## Contradictions

- RTL DB access: rtl/NRI_ONBOARDING.md:101 ('Gap — no RTL-london read-replica env vars exist yet') and the refs from 2026-09-17 say the vars are unfilled, but .env.example:92-95 has RTL_DEBUG_* filled with a london reader host. The doc is stale.
- rtl/CLAUDE.md:27-29 and rtl/workflow/CLAUDE.md:4 list SHIVALIK_DEBUG_WORKFLOW_DB_CONN_URL as the workflow-op DB var, while rtl/NRI_ONBOARDING.md:99 says that var reaches only the Shivalik copy and RTL_DEBUG_WORKFLOW_DB_CONN_URL exists in .env.example.
- The kyc-service DB name is kyc_service in rtl/NRI_ONBOARDING.md:96 but kyc_db in the .env.example RTL_DEBUG_KYC_DB_CONN_URL.
- rtl/banking-service/CLAUDE.md:6 says the prod DB_NAME is not in the repo, but .env.example uses banking_db.
- atspl/NRI_ONBOARDING.md:63-64 says the ATSPL DB vars are 'empty', but .env.example:89-90 has them filled with a mumbai reader host.
- Quickwit coverage: atspl/CLAUDE.md:24-28 and the logs-finder SKILL.md:51-58 document Quickwit only for SSFB (logs-v1) and ATSPL (envoy-logs), and refs say RTL logs are a dead end. The user now says Quickwit is in every entity, so the docs are stale for RTL at least.
- The docs say SSFB's quickwit.vance.local/logs-v1 is 'SSFB only'. The user brief says docs claim Quickwit is only in SSFB, but the ATSPL docs already describe a separate ATSPL Quickwit (envoy-prod). So the docs claim SSFB and ATSPL, not SSFB alone.
- pulse role: atspl/CLAUDE.md:11 and atspl/pulse/CLAUDE.md:4 call it an 'event stream', but atspl/NRI_ONBOARDING.md:45-48 (verified from code) says it is an ops/CX SDUI console that proxies harbor, with Kafka used only for audit.
- canopy: atspl/NRI_ONBOARDING.md:12,52-54 says it is not present and should be treated as decommissioned, but atspl/CLAUDE.md:18 and qw.md:65 say it is a live service with about 897k log lines over 7 days.
- Log service names: atspl/NRI_ONBOARDING.md:76 suggests service:package-svc and service:pulse, but qw.md:59-64 says the exact strings are package/package-worker-* and pulse-backend (service:pulse returns 0).
- The rtl/workflow/CLAUDE.md:48-52 static-asset sweep uses raw curl, which conflicts with the rule that API calls go only through allowlisted or safe wrappers.
- workflow_step_check.sh:27-35 relies on columns (total_completion, status_v2) that it notes are not confirmed in the CLAUDE.md schema docs.
