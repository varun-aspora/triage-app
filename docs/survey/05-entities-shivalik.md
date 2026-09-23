# SHIVALIK / SSFB ENTITY

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## 0. Survey incident (read first)
One redaction command was wrong: the sed pattern didn't match quoted .env values, so the 9 `SHIVALIK_DEBUG_*_DB_CONN_URL` values, credentials included, printed into this subagent's tool output. They are not repeated here. The human should decide whether rotation is warranted. For the design, the lesson is that tool output which echoes .env needs a redactor that handles quoted values.

## 1. Scope read
All paths are relative to /Users/varun/code/aspora/triage-shivalik.
- `shivalik/CLAUDE.md` (163 lines), `shivalik/NRI_ONBOARDING.md` (114), and all 10 service CLAUDE.md files. The service directory is `shivalik/cbs-go/`, not `shivalik-cbs-go`.
- All 6 scripts in `shivalik/scripts/`, read as text only.
- Supporting files that the Shivalik scripts depend on: `.claude/skills/aspora-triage/scripts/{safe_sql.sh,safe_curl.sh}`, `.claude/skills/aspora-triage/config/{service-db-map.json,service-api-map.json,allowed-non-get-requests.json}`, `.claude/skills/aspora-logs-finder/{scripts/search.py,references/env/shivalik/qw.md,references/sources/quickwit-api.md}`, `.claude/settings.json` hooks, `.claude/hooks/block-raw-curl-psql.py` (grep only), and the `.claude/skills/aspora-harbor-shivalik-sim-binding-issue/SKILL.md` header.

## 2. ID chain (FACT unless marked)
Source: `shivalik/CLAUDE.md:123-163`, implemented in `shivalik/scripts/lookup_user.sh:81-187`.

1. **Slack userId.** This is the Aspora internal user ID from #nri-banking-cx. It is not a CIF (`CLAUDE.md:125`).
2. **harbor_db `account_forms`.** Query: `WHERE external_user_ref = :'uid' AND is_deleted=false ORDER BY created_at DESC`. It returns `form_id`, `status`, `session_id` and `created_at`.
   - The userId is untrusted Slack text, so it is passed as a psql `-v` variable and never interpolated (`lookup_user.sh:7-10,90-96`).
   - `status_v2` is the authoritative status. `status` is a lossy legacy projection (`NRI_ONBOARDING.md:56`). Even so, lookup_user.sh selects `status`.
3. **harbor_db `customer` (singular).** Query: `WHERE account_form_id IN (<form_ids>)`. It returns `customer_id`, `state` and `sub_state` (`CLAUDE.md:153-157`, `lookup_user.sh:134-138`).
   - `external_reference_id` is the CIF. `CLAUDE.md:135` says it is AES-SIV encrypted and not queryable. `NRI_ONBOARDING.md:57` says `= CIF; null ⇒ CBS create never succeeded`.
4. **rhythm_db `customer_account_mappings`.** Query: `WHERE customer_id IN (<customer_ids>)`. It returns `account_id` (the rhythm UUID used by admin APIs), `account_number` (the CBS Finacle number, best key for log searches), `account_type` (NRE/NRO), `classification` and `scheme_code` (`CLAUDE.md:159-162`, `lookup_user.sh:170-174`).
5. **CIF to CBS.** `GET /customer/api/retail/<CIF>` and `GET /misc/api/crm/savingaccount/<account_number>` through `cbs_curl_via_eventbus.sh` (`CLAUDE.md:101`). The savingaccount response includes `CustId`.
6. **Side branch: guardian.** guardian has no `user_id` column. The join is `device_auth_attempts.verification_id → refresh_tokens.verification_id → refresh_tokens.subject` (= userId). This is flagged as not independently verified (`guardian/CLAUDE.md:25-34,53-58`).
7. **Other keys.**
   - `form_id` = `reference_id` in `workflow_op_db.workflow_executions` and in `rfi_requests_v3` (`NRI_ONBOARDING.md:100-101`, `harbor/CLAUDE.md:182-183`).
   - `session_id` feeds guardian `GET /admin/verification/session/:session_id/phone` (`NRI_ONBOARDING.md:73`).
   - Phone and residence country come from decrypting `account_forms.submission_data` (`CLAUDE.md:85`).

## 3. Data sources
### 3a. Postgres (read-only, all through one SSH forward)
- **Connection shape.** Every URL is `postgresql://<svc_user>:<pw>@localhost:55432/<db>?application_name=shivalik_triage_user`, and one forward serves all 9 databases.
- **Forward target.** `localhost:55432` → `ssfb-aspora-prod-cluster.cluster-ro-…ap-south-1.rds.amazonaws.com:55432` (the RDS reader), via bastion `$SHIVALIK_TUNNEL_BASTION` with key `$LITBIT_SERVER_IDENTITY` (`ensure_db_tunnel.sh:47-53,114-119`). The local port can be overridden with `SHIVALIK_TUNNEL_PORT`.
- **Why a tunnel.** The Shivalik VPC 10.201.0.0/16 has no WARP route (`ensure_db_tunnel.sh:6-8`, `.env.example` comments). RTL and ATSPL are reached directly over WARP.

| env var | db |
|---|---|
| SHIVALIK_DEBUG_HARBOR_DB_CONN_URL | harbor_db |
| SHIVALIK_DEBUG_RHYTHM_DB_CONN_URL | rhythm_db |
| SHIVALIK_DEBUG_GUARDIAN_DB_CONN_URL | guardian_db |
| SHIVALIK_DEBUG_COMMS_DB_CONN_URL | comms_db |
| SHIVALIK_DEBUG_WORKFLOW_DB_CONN_URL | workflow_op_db |
| SHIVALIK_DEBUG_COHORT_DB_CONN_URL | cohort_db |
| SHIVALIK_DEBUG_PDFGEN_DB_CONN_URL | pdfgen_db |
| SHIVALIK_DEBUG_REMINDER_DB_CONN_URL | reminder_db |
| SHIVALIK_DEBUG_BRO_DB_CONN_URL | bro_db |

`audit_db` has no env var (`audit/CLAUDE.md:3`).

`safe_sql.sh` does the following:
- Resolves `tenant:service` to an env var name through `service-db-map.json`.
- Strips comments and allows a single statement only (`^(SELECT|WITH)`).
- Denies these keywords: INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/GRANT/REVOKE/CREATE/MERGE/CALL/EXECUTE/COPY/VACUUM/REINDEX/INTO/FOR UPDATE/FOR SHARE/PG_READ_FILE/PG_LS_DIR/LO_EXPORT/LO_IMPORT/DBLINK/PG_SLEEP/REFRESH MATERIALIZED.
- Wraps the query in `SELECT * FROM (…) _capped LIMIT N`.
- Runs psql with `PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30s'`.
- Writes a JSON audit line to `.claude/prod-access.log`.

Sources: `safe_sql.sh:2-47,323-375`.

### 3b. Admin / debug HTTP APIs
- **Hosts.** `SHIVALIK_DEBUG_HARBOR_API` = `http://aspora.prod.shivalik.in:9443/harbor` and `SHIVALIK_DEBUG_RHYTHM_API` = `…:9443/rhythm`. `.env.example` labels this the "Kong internal gateway".
- **bro.** bro is served on the same host under `/bro`, and the allowlist reuses the harbor variable for it (`allowed-non-get-requests.json:17-26`). bro admin needs a token. `.env` has `SHIVALIK_DEBUG_BRO_ADMIN_TOKEN`, which is missing from `.env.example`.
- **Header rule.** "always send the `x-customer-id` header" on Shivalik admin APIs when the customer_id is known (`CLAUDE.md:109`). INFERENCE: this header scopes the request rather than authenticating it, because `rhythm/CLAUDE.md:37` says `adminV1` has NO auth middleware.

Known GET endpoints:

| Service | Endpoint | Returns / purpose | Source |
|---|---|---|---|
| harbor | `/admin/v1/customers/<customer_id>` | state, sub_state, phone, email, mpin/biometric status | `CLAUDE.md:107` |
| rhythm | `/admin/v1/accounts/<account_id>/transactions?page&limit&start_date&end_date` | CBS statement; shows reversals | `CLAUDE.md:112-119` |
| rhythm | `/admin/v1/accounts/<account_id>` | account_status, debit.allowed, account_flags | `rhythm/CLAUDE.md:143,162` |
| rhythm | `/admin/v1/cards/customer/<customer_id>` | NRE and NRO cards, live from CBS | `rhythm/CLAUDE.md:177` |
| bro | `/bro/health`, `/bro/admin/api/v1/stp-engine/rules`, `/bro/admin/api/v1/stp-engine/results/:subject_id` | STP engine health, rules, per-subject results | `bro/CLAUDE.md:25-28` |

`safe_curl.sh` enforces three gates (`safe_curl.sh:1-110`):
1. A host allowlist, derived from http(s) URLs in .env plus localhost, 127.0.0.1 and `*.vance.local`.
2. GET/HEAD only, unless host + path prefix + method match `allowed-non-get-requests.json`.
3. A curl-option allowlist: -H, -o, -s, -S, -i, -v, -f, -m, --connect-timeout, -w, -X (validated), -G.

`--allow-any-host` also needs `SAFE_CURL_ALLOW_ANY_HOST=1`.

The current allowlist shape is `{"allowed":[{"prefix","hosts":["env:VAR"|literal|"*.x"],"methods":["POST"],"reason"}]}`. It has 4 entries:
- Finacle `/custom/api/`
- Finacle `/api/channel/v1/custom/`
- `/bro/dashboard/api/v1/dry-run`
- `/bro/admin/api/v1/stp-engine/clients/harbor_client/hooks/reference-query`

The user's target format `[{api, source}]` has no host or method field. The current design deliberately binds host and prefix together (the file's `_comment`), so the new format needs a host binding too.

### 3c. Quickwit
- **Endpoint.** `http://quickwit.vance.local:7080`, VPN only, via /etc/hosts → 192.168.66.1, no port-forward. Version 0.8.0-nightly (`qw.md:9-58`).
- **Search path.** `POST /api/v1/{index}/search`, not `/api/v1/indexes/{id}/search`.
- **Indexes.** `logs-v1` (primary, 536M+ docs), `otel-logs-v0_9`, `otel-traces-v0_9`, `otel-logs-v0_7`.
- **Document fields.** `service`, `level`, `message` (a developer label), `error` (the user-quoted text; no positions, so no phrase queries), `raw_message`, `timestamp`, `kubernetes.*`.
  - Go services also carry `x_req_id`, `x_txn_id`, `x_amzn_trace_id`, `x-customer-id` and `x-device-id`.
  - Correlation IDs are NOT unique per request: one `x_txn_id` has spanned 187 lines.
  - Sources: `quickwit-api.md:28-89,241`.
- **Service field values** (FACT per the CLAUDE.md files): `harbor`, `rhythm`, `guardian`, `comms` ("confirm exact name"), `audit-svc`, `bro`, `eventbus`, `pdf-generator`, `reminder-service` plus a worker deployment whose name is not given, and `workflow-op` (Java, whole line in `message`, no `error` field).
- **Tooling.**
  - `search.py` flags: `--service --level --message --error --query --from --to --max-hits --url --index --count --group-by --raw --fields --desc --list-indexes`. The URL is hardcoded as `DEFAULT_URL` and is not read from the environment.
  - `search_sim_binding.py` is a Shivalik harbor log search by form_id that produces a Slack-ready table.

### 3d. CBS via eventbus
Source: `cbs_curl_via_eventbus.sh`, `CLAUDE.md:87-101`.

**Path.** laptop → `ssh -i $LITBIT_SERVER_IDENTITY $SHIVALIK_TUNNEL_BASTION` → `kubectl [--context $SHIVALIK_KUBE_CONTEXT] exec` into the first Running pod of `-n eventbus-service -l app=eventbus -c eventbus` → in-pod `curl` to `$SHIVALIK_FINACLE_PROXY_GW + path`.

**Why eventbus.** The OCI gateway, subnet 30.20.10.0/24, is routable only from inside the cluster. eventbus is the only image with a shell (temurin-jammy); the Go services are distroless.

**Token handling.**
- The token is minted on the bastion: it reads `FINACLE_API_USERNAME`/`PASSWORD` from secret `rhythm-external-secret` in namespace `rhythm-service`, then POSTs a password-grant to `<GW>/security/oauth` from inside the pod. The OAuth scope has a hardcoded default.
- The token is cached back into `.env` as `SHIVALIK_FINACLE_AUTH_TOKEN` and `_EXPIRY` (JWT exp) and reused while more than 30s remain (`:406-422`). This means the script writes to .env.

**Request headers.** `Authorization: Bearer`, `RequestUUID: asp<7 alnum>`, `Source: $SHIVALIK_FINACLE_API_SOURCE`, `SourceIdentifier: $SHIVALIK_FINACLE_API_SOURCE_IDENTIFIER`. A GET sends no Content-Type, because sending one gives HTTP 415.

**Guards.**
- GET is the default. POST happens only with `--data`, which must match the same allowlist on GW host + prefix.
- Extra args `-X/-T/-K/-d/--data*/--json/-F` are refused.
- tenant must be shivalik.
- A redacted audit line is written by an EXIT trap.

**Known Finacle paths.** `/misc/api/crm/savingaccount/<acct>`, `/customer/api/retail/<CIF>`, and `/custom/api/lvl2/finacle/script` (POST body with `RequestId: Custapi.scr`, `UniqId: CUST_ACCT_DET`, `CifId`).

**Design-relevant structural exception.** The OAuth mint is itself a non-GET that is not on the allowlist (`:5-33`).

### 3e. Deployment truth
`repos/prod-ssfb-aspora-argo`, one directory per app with `base/` and `overlay/`, is where `DB_NAME` and other env values are authoritative (`CLAUDE.md:58-65`). It carries prod only (`NRI_ONBOARDING.md:89`).

## 4. Per service
- **harbor**
  - Log service: `harbor`. Extra fields: `form_id`/`x-form-id`, `document_type`.
  - Tables: `account_forms`, `customer`, `digital_forms` (must be `signed`, otherwise `HandleCustomerCreation` never fires), `notary_orders`, `mpin_attempt_trackers`, `rfi_requests_v3`/`rfi_items_v3` (v3; `rfi_requests` is dead), `form_proofs`, `form_stp_checks`, `document_verifications` (supersedes the now-empty `form_attachments`), `form_checklists`, `audit_logs`, `device_registrations`.
  - Handlers: `orchestration_service.go` state machine (`determineState` :430), `cbs_service.go:52`, `document_verification/pan_handler.go` (:153), `nstprfi/crm_actions.go`, and `checkRateLimit` (`document_verification_service.go:129`, Redis key `rate:docver:<form_id>`, 3 attempts).
  - Failure signatures:
    - `Pan name & passport name doesn't match…`
    - CBS `FZYCHCKREVIEW`
    - `PAN verification failed, please try again`, which masks a CBS 500. The retry returns `Request UUID Already Submitted`.
    - ESBStatus: `CIF already exists`, `INPROGRESS`, `CRMEJB0306` (expired document), `CRMEJB0024` (email), `PAN Name does not match with NSDL records`.
    - Pair lines `[CBS API] Unknown Error - Raw Response` and `CBS API error`. These carry no form_id; walk back along `x_txn_id` to `"calling CBS API to create customer"`.
    - Anchor for NSTP stage 1: `NSTP_INTERNAL_REVIEW pulse ticket created`.
  - Mutating triage endpoint that exists: `POST /harbor/admin/v1/forms/:form_id/trigger-customer-creation`. It is not on the allowlist.
  - Sources: `harbor/CLAUDE.md` and `NRI_ONBOARDING.md:26-63`.
- **rhythm**
  - Log service: `rhythm`. Prefer `account_number` in queries.
  - Tables: `customer_account_mappings`, `transfer_transactions` (`txn_ref_id`, `status`, `initiated_at`, `bank_identifier`, `failure_reason`, `cbs_response`), `user_limit_transaction_settings` (`type`, `enabled`, `version`), `beneficiaries` (`unique_id`, `details`; `verified` defaults to true and means nothing). `sync_states`/`reconciliation_reports`/`cdc_events` are disabled scaffolding.
  - Failure signatures:
    - UTC/IST TranDate bug, 00:00–05:30 IST (`transaction_service.go:911`). Log: `bank_identifier still empty after max retries, dropping`.
    - IMPS SUCCESS in the DB but REVERSED in the statement: `IB_IMPS_PMTINQ` returns U31/Processing_001, usually because of a malformed beneficiary account number.
    - `ACCOUNT FROZEN- GSPM -(G)`, visible in the `error` field only.
    - "Transfers disabled", which is `USER_DISABLED_TRANSFERS` and by design.
    - Debit card 500 on `context canceled`, systemic (`Api ended with Error AND cards AND debit`).
    - Cards reporting `INACTIVE` is the norm. `pin_status` is mocked.
    - UPI/Paytm issues are never rhythm: raise a bank ticket.
- **guardian**
  - Log service: `guardian`.
  - Tables: `device_auth_attempts` (`sim_country_code` is ISO numeric; 0 means the SMS never arrived; `sim_card_number` is in national format), `refresh_tokens` (`verification_id`, `subject`, `scopes`), `device_verification_sessions`, `access_tokens`, `passkeys`. Status and timestamp column names are UNCONFIRMED; run `\d` first. Challenge state lives in Redis. The VMN is +447862140266.
- **comms**
  - Log service: `comms`, unconfirmed.
  - Tables: `messages`/`notifications`, `templates`. Other docs cite `comms_db.communications`.
- **audit** (`audit-svc`): `events` is partitioned by `occurred_at`; also check `events_default` for partition gaps, and `domains`.
- **bro** (`bro`): tables `form_stp_checks` (start here), `bre_evaluation_runs`, `stp_check_config`, `bro_check_config`, `bro_clients`, `bro_use_case*`. Config refreshes on a 60s poll. `PUT …/rules/:check_id` exists and must never be called.
- **eventbus** (`eventbus`): handlers `Kafka|ExternalKafka|Http|Sqs`EventDestinationHandler. Its database is unknown. KEDA scales it on lag.
- **pdf-generator** (`pdf-generator`, `pdfgen_db`): table `jobs`. Check `status` and `upload_status` separately; also `retry_count`/`max_retries` (3) and `error_message`. Rendering runs on Gotenberg.
- **reminder-service** (`reminder-service` plus a worker): tables `workflow`, `job` (`idempotency_key`), `job_execution` (start here). No executions means the worker never picked the job up.
- **shivalik-cbs-go**: a library only, the reference for CBS request and response shapes. See `pkg/client` and `pkg/errors/error_codes.go`; the codes are CUSTOMER_EXISTS, AML_MATCH_FOUND, VALIDATION_ERROR, INTERNAL_ERROR, SIGNATURE_ADD_FAILED and UNKNOWN.
- **NRI onboarding state machine** (`NRI_ONBOARDING.md:9-44,95-112`).
  - Form status: open → submitted → downloading → nstp_review → notary_pending → sign_pending → under_review → verified|rejected.
  - Customer state: NEW → AML_* → rhythm `POST /rhythm/admin/v1/orchestration/accounts` → MPIN_SET → … → ACTIVATED. AML_WAIT goes to the DLQ.
  - A symptom-to-first-check table is at :97-110. It includes the workflow-op "We hit a snag" case, caused by a TAB/newline in OCR data.

## 5. Scripts as candidate tools
| script | inputs | reaches | tool verdict |
|---|---|---|---|
| ensure_db_tunnel.sh | none; `--status`/`--stop`. Env: LITBIT_SERVER_IDENTITY, SHIVALIK_TUNNEL_BASTION, opt SHIVALIK_TUNNEL_PORT | ssh -L. Health check via pg_isready or /dev/tcp | infra precondition. Run it as a startup or lifecycle step, not an LLM tool |
| lookup_user.sh | userId; `--env prod|uat`; `--tenant` | safe_sql harbor ×2, rhythm ×1 | `resolve_identity(userId)`. Parses psql aligned output with awk, which is fragile; port to structured SQL |
| list_transactions.sh | account_id (UUID); `-c` customer_id; `--env` (required); -s/-e/-p/-l; `--raw` | safe_curl rhythm admin GET | `get_account_statement`. It probes several response keys because the schema is not pinned |
| transfer_lifecycle.sh | `--env`; `--account-id`; `-c` (required); `--since` (default 30d); `--limit` (default 100); `--raw` | safe_sql rhythm plus safe_curl statement | `detect_silent_reversals`. Deterministic join that flags REVERSED!, NO-UTR, no-match and orphans |
| harbor_field_enc.sh | a value (`enc:` prefix decrypts) or `--test` | local only; `go run repos/harbor/cmd/fle` with SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY | `decrypt_harbor_field`. Known broken under gvm; the workaround pins go1.26.2 (`CLAUDE.md:78-83`). Handles PII |
| cbs_curl_via_eventbus.sh | api-path; `--data`; `--env`; `--tenant`; `--bastion`; `--kube-context` | ssh→kubectl exec→curl. Writes the token into .env | `cbs_read`, behind an env flag, per the user brief |

## 6. Where the stage/uat vs prod split lives today (FACT)
- **CLI flag.** Every Shivalik script and wrapper takes `--env prod|uat`; `stage` is a deprecated alias for uat.
  - `lookup_user.sh` and `cbs_curl_via_eventbus.sh` default to prod, with a warning in the cbs case.
  - `list_transactions.sh`, `transfer_lifecycle.sh`, `safe_sql.sh` and `safe_curl.sh` usage A require `--env`.
  - `--tenant` defaults to shivalik.
- **JSON maps.** `service-db-map.json` and `service-api-map.json` map `tenant:service → {prod: VAR, uat: VAR}`. Every Shivalik entry has prod only, so uat fails loudly by design. Only the RTL DB entries have `uat` (`RTL_STAGE_*`).
- **Prefix-swapping.** In `cbs_curl_via_eventbus.sh:229-235`, prod uses `SHIVALIK_`* and uat uses `SHIVALIK_UAT_*` (FINACLE_*, TUNNEL_BASTION, KUBE_CONTEXT). None of the UAT keys exist in .env.
- **Hardcoded prod values.**
  - The RDS host in `ensure_db_tunnel.sh:48`.
  - The Quickwit URL in `search.py:35`.
  - k8s namespace, secret and selector in `cbs_curl_via_eventbus.sh:90-94`.
  - The OAuth scope default at `:257`.
  - The `DEBUG` prefix in the DB var names is effectively "prod".
- **Collapse to one .env per deployment.**
  - Drop `--env` everywhere and the `{prod,uat}` level from the maps.
  - Replace `SHIVALIK_UAT_`/`SHIVALIK_` prefix-swapping with un-suffixed keys.
  - Lift the hardcoded host, namespace, secret, selector and Quickwit URL into .env.
  - Stop writing the token cache back into .env.

## 7. Hooks relevant to Shivalik
From `.claude/settings.json`:
- **SessionStart** runs `shivalik/scripts/ensure_db_tunnel.sh` and `refresh-repos.sh` (codegraph freshness).
- **PreToolUse(Bash)** runs `block-raw-curl-psql.py`. It denies curl/wget/psql/mysql/nc in command position and redirects to safe_curl or safe_sql. There is a closed allowlist of files that may carry a `prod-access-lint: allow-file` pragma, for the Quickwit readers.
- **Stop** runs `triage-eval-capture.sh`.

## Key facts

- ID chain: userId → harbor_db.account_forms.external_user_ref → form_id → harbor_db.customer (singular).account_form_id → customer_id → rhythm_db.customer_account_mappings.customer_id → account_id (UUID) / account_number (CBS) / account_type (shivalik/CLAUDE.md:123-163; shivalik/scripts/lookup_user.sh:90-174)
- All 9 Shivalik DB URLs share localhost:55432 through a single SSH forward to the prod RDS reader ssfb-aspora-prod-cluster.cluster-ro-…ap-south-1 (shivalik/scripts/ensure_db_tunnel.sh:47-53)
- safe_sql.sh accepts SELECT/WITH only, denies a keyword list, caps rows, and runs with default_transaction_read_only=on and statement_timeout=30s (.claude/skills/aspora-triage/scripts/safe_sql.sh:323-375)
- Admin API bases: SHIVALIK_DEBUG_HARBOR_API=http://aspora.prod.shivalik.in:9443/harbor, SHIVALIK_DEBUG_RHYTHM_API=…:9443/rhythm; bro is served under /bro on the harbor host (shivalik/CLAUDE.md:105; allowed-non-get-requests.json:17-26)
- Always send x-customer-id on Shivalik admin APIs (shivalik/CLAUDE.md:109); rhythm adminV1 has no auth middleware (shivalik/rhythm/CLAUDE.md:37)
- admin endpoints take account_id (rhythm UUID), not the CBS account_number (shivalik/CLAUDE.md:117)
- Quickwit: http://quickwit.vance.local:7080, VPN only, POST /api/v1/{index}/search, index logs-v1; message is a label, error holds user-facing text with no phrase queries (qw.md:9-66; quickwit-api.md:28-89)
- Quickwit service values: harbor, rhythm, guardian, comms (unconfirmed), audit-svc, bro, eventbus, pdf-generator, reminder-service (+worker), workflow-op (service CLAUDE.md files; quickwit-api.md:41-47)
- x_txn_id/x_req_id are reused across requests (one spanned 187 lines); CBS error lines carry no form_id, so walk back to 'calling CBS API to create customer' (quickwit-api.md:70-72; harbor/CLAUDE.md:79-83)
- CBS path: laptop→ssh bastion→kubectl exec eventbus pod (ns eventbus-service, app=eventbus)→curl OCI Finacle gateway; creds from secret rhythm-service/rhythm-external-secret; token cached back into .env (cbs_curl_via_eventbus.sh:90-94,380-422)
- Finacle headers: Authorization Bearer, RequestUUID asp+7 alnum, Source, SourceIdentifier; no Content-Type on GET (gives 415) (cbs_curl_via_eventbus.sh:342-346,445-452; shivalik/CLAUDE.md:99-100)
- Non-GET allowlist today: {allowed:[{prefix,hosts:[env:VAR|literal|*.x],methods,reason}]}, with 4 entries (2 Finacle custom-script reads, 2 bro reads) (.claude/skills/aspora-triage/config/allowed-non-get-requests.json)
- Env split today: --env prod|uat flag on every script; {prod,uat} maps in service-db-map.json/service-api-map.json with prod only for Shivalik; SHIVALIK_ vs SHIVALIK_UAT_ prefix swap in cbs_curl_via_eventbus.sh:229-235
- Hardcoded prod values: RDS host (ensure_db_tunnel.sh:48), Quickwit URL (search.py:35), k8s ns/secret/selector (cbs_curl_via_eventbus.sh:90-94), OAuth scope default (:257)
- Hooks: SessionStart runs ensure_db_tunnel.sh + refresh-repos.sh; PreToolUse Bash runs block-raw-curl-psql.py; Stop runs triage-eval-capture.sh (.claude/settings.json)
- transfer_transactions.status can say SUCCESS while the CBS statement shows a reversal; transfer_lifecycle.sh joins the two to flag REVERSED!/NO-UTR (shivalik/rhythm/CLAUDE.md:103-135; transfer_lifecycle.sh:23-31)
- Real CIF-creation failures show up in ESBStatus, not AML Status (1,140/1,140 responses were AML C over 2026-07-15→09-10) (shivalik/harbor/CLAUDE.md:148-165)
- harbor_field_enc.sh is broken under gvm; workaround: FIELD_ENCRYPTION_SECRET_KEY=… go1.26.2 go run -C repos/harbor ./cmd/fle (shivalik/CLAUDE.md:78-83)
- A mutating manual triage trigger exists: POST /harbor/admin/v1/forms/:form_id/trigger-customer-creation, not on the allowlist (NRI_ONBOARDING.md:49)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `.claude/skills/aspora-triage/scripts/safe_sql.sh` | SELECT-only psql wrapper: service→env var resolution, keyword denylist, row cap, read-only transaction, statement timeout, audit log | port: keep the guard logic (regex plus read_only session plus timeout) as a typed SQL tool; drop --env/--tenant resolution |
| `.claude/skills/aspora-triage/scripts/safe_curl.sh` | GET-only HTTP wrapper with host allowlist, non-GET allowlist, curl-option allowlist and redacted audit log | port: the three-gate model is sound; rebuild as an HTTP client tool (no curl argv surface), keeping the host+path+method allowlist semantics |
| `.claude/skills/aspora-triage/config/allowed-non-get-requests.json` | Non-GET read-only exceptions keyed on prefix+hosts(env:VAR)+methods+reason | port to resources/ssfb.allow.api.json; the user's {api,source} shape must keep a host/source-to-base-URL binding and a method field, or it loses the host check |
| `.claude/skills/aspora-triage/config/service-db-map.json` | tenant:service → {prod,uat} env var map | replace: collapse to a flat service→var map per entity .env |
| `shivalik/scripts/lookup_user.sh` | userId→form→customer→account chain resolver | port: same 3 SQL hops as a deterministic tool returning JSON; drop the awk psql-table parsing |
| `shivalik/scripts/transfer_lifecycle.sh` | DB-vs-statement join that flags silent IMPS reversals and NO-UTR | port: high-value deterministic check; keep the narration-only reversal regex and ID masking logic |
| `shivalik/scripts/list_transactions.sh` | rhythm admin statement fetch plus table formatting | port: fold into a get_account_statement tool; overlaps with transfer_lifecycle |
| `shivalik/scripts/cbs_curl_via_eventbus.sh` | Direct Finacle read via ssh→kubectl exec→curl with OAuth mint and cache | port behind an env flag: stop writing the token into .env (keep it in memory or a separate cache), lift ns/secret/selector/scope into env; keep the method guard and audit |
| `shivalik/scripts/ensure_db_tunnel.sh` | Idempotent SSH forward to the RDS reader | reuse as-is (or port) as a lifecycle precondition, not an LLM tool; lift the RDS host to env |
| `shivalik/scripts/harbor_field_enc.sh` | AES-SIV decrypt/encrypt via the harbor fle cmd | replace: broken under gvm; reimplement the decrypt natively or call the pinned go binary; decrypt-only, and treat the output as PII |
| `.claude/skills/aspora-logs-finder/scripts/search.py` | Stdlib Quickwit search CLI (service/level/message/error/time/group-by/count) | port: good flag surface for a log-search tool; make the URL and index come from env (currently hardcoded) |
| `.claude/skills/aspora-harbor-shivalik-sim-binding-issue/scripts/search_sim_binding.py` | Quickwit search of harbor errors by form_id, grouped into a Slack-ready table | port as a specialised tool or subagent recipe; not read in full |
| `.claude/hooks/block-raw-curl-psql.py` | PreToolUse deny for raw network/DB binaries | drop for the new agent if it has no raw Bash; keep the idea as a tool-layer policy check if a shell tool is exposed |
| `shivalik/NRI_ONBOARDING.md, shivalik/*/CLAUDE.md` | Domain knowledge: state machines, tables, failure signatures, symptom→first-check table | reuse as-is as skill/knowledge files loaded per entity/service, after fixing the contradictions listed |

## Unknowns

- Should DB credentials be rotated, given that this survey accidentally printed the SHIVALIK_DEBUG_*_DB_CONN_URL values into a subagent transcript?
- Does a Shivalik stage/uat environment exist that the new agent must support (NRI_ONBOARDING.md:89 mentions config-shivalik-stg.json), and does it have its own RDS reader, bastion, Quickwit, and Finacle gateway?
- Is Quickwit on RTL/ATSPL at a different URL and index than quickwit.vance.local:7080/logs-v1, and do those deployments use the same service field values?
- What are the exact Quickwit service names for comms and for the reminder worker deployment?
- What are guardian device_auth_attempts' status and timestamp column names (the doc says run \d first)?
- Is harbor customer.external_reference_id stored encrypted (shivalik/CLAUDE.md:135) or as the plain CIF (NRI_ONBOARDING.md:57)?
- Is x-customer-id enforced server-side, or only used for scoping, given that rhythm adminV1 has no auth middleware?
- For resources/ssfb.allow.api.json [{api, source}]: is 'api' a path prefix, exact path, or full URL, and how does 'source' (harbor, rhythm, finacle) map to a base-URL env var and allowed method?
- Does the new agent run where the bastion SSH key and VPN are available (a laptop), or on a server that needs its own network path to the RDS reader, Quickwit, and the bastion?
- Where should the Finacle OAuth token cache live, now that writing it back into .env conflicts with a .env-driven, possibly read-only deployment?
- Which database does eventbus use on Shivalik, if any, and is there an audit_db connection that should be added?
- Is the OAuth password-grant POST from inside the eventbus pod acceptable under the 'non-GET blocked unless in the allowlist' rule, or should it get an explicit allowlist entry?

## Contradictions

- harbor/CLAUDE.md:12,38-40 uses table `customers` (plural); shivalik/CLAUDE.md:154 and lookup_user.sh:128 say it is `customer` (singular)
- harbor/CLAUDE.md:182 says rfi_requests is dead legacy (use rfi_requests_v3), but harbor/CLAUDE.md:18,46 and NRI_ONBOARDING.md:62,103 still point at rfi_requests
- harbor/CLAUDE.md:216 says form_attachments is empty (superseded by document_verifications), but NRI_ONBOARDING.md:58,103 and harbor/CLAUDE.md:49-50 still query form_attachments
- NRI_ONBOARDING.md:56 says account_forms.status_v2 is authoritative and status is lossy, yet shivalik/CLAUDE.md:147 and lookup_user.sh:92 select only `status`
- shivalik/CLAUDE.md:39 and bro/CLAUDE.md:3 say no debug env var exists for bro_db, but .env, .env.example and service-db-map.json:11 define SHIVALIK_DEBUG_BRO_DB_CONN_URL; .env also has SHIVALIK_DEBUG_BRO_ADMIN_TOKEN, which is absent from .env.example
- shivalik/CLAUDE.md:135 and harbor/CLAUDE.md:25 say external_reference_id is AES-SIV encrypted and not queryable; NRI_ONBOARDING.md:35,57 say it is set to the CIF (null ⇒ no CIF)
- shivalik/CLAUDE.md:85 says decrypt account_forms.submission_data with fle; NRI_ONBOARDING.md:56 says read it from a workflow-op logged step-handler response instead
- qw.md:15-22 says DEBUG_AI_QUICKWIT_URL/INDEX env vars override the defaults, but search.py:35-36 hardcodes DEFAULT_URL and DEFAULT_INDEX and never reads os.environ
- The user brief says Quickwit is now in all entities; the workspace docs treat it as Shivalik-specific (shivalik/CLAUDE.md:47-56, qw.md under env/shivalik)
- rhythm/CLAUDE.md:49-50 lists reconciliation_reports and sync_states as key tables; NRI_ONBOARDING.md:83 calls sync_state/reconciliation_reports/cdc_events disabled scaffolding with no rows (the table names also differ: sync_state vs sync_states)
- comms/CLAUDE.md:10 lists messages/notifications tables; rhythm/CLAUDE.md:167 cross-checks comms_db.communications
- cbs-go/CLAUDE.md:3 gives the module as github.com/aspora/shivalik-cbs-go; NRI_ONBOARDING.md:28 gives github.com/Vance-Club/shivalik-cbs-go
- shivalik/CLAUDE.md:75 and the cbs script header say the script is read-only, GET or allowlisted POST only, but the OAuth token mint is an unallowlisted POST and the script writes the token back into .env (cbs_curl_via_eventbus.sh:380-422)
- Env naming: the scripts and maps call the non-prod env 'uat' (stage is a deprecated alias); NRI_ONBOARDING.md:89 calls it 'stage (stg)'; .env.example uses RTL_STAGE_* names mapped under the 'uat' key
- harbor/CLAUDE.md:5 lists SIM binding and device registration as harbor's role; NRI_ONBOARDING.md:69 says guardian owns device/SIM binding and harbor's /v1/device/register is FCM push only
- shivalik/CLAUDE.md:109 says admin endpoints authorize by x-customer-id; rhythm/CLAUDE.md:37 says the adminV1 group has no auth middleware
- rhythm/CLAUDE.md:100 says rhythm marks IMPS COMPLETED on ActionCode 000; rhythm/CLAUDE.md:112 and transfer_lifecycle.sh:24 say SUCCESS (transfer_lifecycle treats both as success-ish)
