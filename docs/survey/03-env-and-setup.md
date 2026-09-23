# ENVIRONMENT, SETUP AND CONFIG SURFACE

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## Scope and method
I read these as text only: `.env.example`, `.gitignore`, `.mcp.json`, `triage-initial-setup/{README.md,verify-setup.sh,make-env-example.sh,bootstrap.sh}`, and parts of `make-share-zip.sh`, `apply-update.py` and `merge-claude-md.sh`. I also read `.claude/skills/aspora-triage/config/*.json`, parts of `shivalik/scripts/cbs_curl_via_eventbus.sh` and `safe_sql.sh`/`safe_curl.sh`, and the logs-finder env refs. For `.env`, `.env.1` and `.env.bak.20260913` I extracted key names only, using a regex and `sort -u` into the scratchpad, and compared the sets. No values were printed except the already-sanitised host patterns that `.env.example` itself contains. Nothing was executed against a network.

## 1. Env key inventory (26 active keys in `.env.example` and in `.env`)
FACT: `.env` and `.env.bak.20260913` have the same key set, the same key order line by line, and the same size. Their bytes differ on exactly one line, `LITBIT_SERVER_IDENTITY`; the value was masked.

### By entity and kind
**SHIVALIK (SSFB)**
- API base, Kong internal gateway (`.env.example:33-35`): `SHIVALIK_DEBUG_HARBOR_API`, `SHIVALIK_DEBUG_RHYTHM_API`. The host pattern is `http://aspora.prod.shivalik.in:9443/<svc>`. Note that the value includes a path (`/harbor`), while the comment in `service-api-map.json` says "base URL only… no trailing path". That is a contradiction.
- DB URLs, 9 of them (`.env.example:68-76`): `SHIVALIK_DEBUG_{GUARDIAN,HARBOR,RHYTHM,COMMS,WORKFLOW,COHORT,PDFGEN,REMINDER,BRO}_DB_CONN_URL`. All are `postgresql://<user>:<pass>@localhost:55432/<svc>_db?<params>`. The workflow DB name is `workflow_op_db`. They are reachable only through an SSH tunnel (`.env.example:27-29,48-50`).
- Commented-out alternates (`.env.example:37-45`): 8 of the same `SHIVALIK_DEBUG_*_DB_CONN_URL` keys point at an RDS Proxy read-only endpoint `proxy-…ssfb-aspora-prod-cluster-read-only…ap-south-1.rds.amazonaws.com:55432`, with the note "telnet failing".
- Field encryption: `SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY` (`:79`). It is used by `shivalik/scripts/harbor_field_enc.sh:40`, which needs `go`.
- Bastion/tunnel: `LITBIT_SERVER_IP` (`:51`), `LITBIT_SERVER_IDENTITY` (`:52`, a path to the SSH key; verify-setup checks it is readable and has 600/400 perms), and `SHIVALIK_TUNNEL_BASTION` (`:60`, `<user>@<bastion-ip>`, deliberately has no default). README `:44` names bastion IP `3.6.181.180`.
- Kube context: `SHIVALIK_KUBE_CONTEXT` (`:66`, optional; empty means the bastion's current context, expected to be `ssfb-aspora-prod-eks-cluster`).
- Finacle/CBS direct (`:81-85,102-103`): `SHIVALIK_FINACLE_API_SOURCE`, `SHIVALIK_FINACLE_API_SOURCE_IDENTIFIER`, `SHIVALIK_FINACLE_PROXY_GW` (an OCI API gateway host `*.apigateway.ap-mumbai-1.oci.customer-oci.com`; a commented `aspora.shivalik.bank.in/…` alternate is marked "Not woring"), `SHIVALIK_FINACLE_AUTH_TOKEN` and `SHIVALIK_FINACLE_AUTH_TOKEN_EXPIRY`. The last two are machine-written by `cbs_curl_via_eventbus.sh` and last 60 minutes (`.env.example:17-18`, `cbs_curl_via_eventbus.sh:36-37,77-78`).
- Read but never listed in any .env file: `SHIVALIK_FINACLE_OAUTH_SCOPE`. It has a hardcoded default at `cbs_curl_via_eventbus.sh:256-257`.

**ATSPL** (`.env.example:87-90`): `ATSPL_DEBUG_PACKAGE_DB_CONN_URL` and `ATSPL_DEBUG_PULSE_DB_CONN_URL`. Both are `vance-envoy-prod-mumbai-01-common-pg-db-reader.internal.genorim.xyz:65432/{package_db,pulse_db}`, direct over WARP. The comment says the same reader is "also usable for RTL *stage* DBs by swapping the db name".

**RTL** (`.env.example:92-95`): `RTL_DEBUG_{BANKING,KYC,WORKFLOW}_DB_CONN_URL`. All are `vance-core-prod-london-01-common-pg-db-reader.internal.genorim.xyz:5432/{banking_db,kyc_db,workflow_op_db}`, direct over WARP. The commented stage variants are `RTL_STAGE_{BANKING,KYC,WORKFLOW}_DB_CONN_URL` (`:97-100`, "stage = mumbai (ap-south-1)").

**Only in the live `.env`**: `SHIVALIK_DEBUG_BRO_ADMIN_TOKEN`. That is a token kind of key; I found no script consumer of this name. `scripts/bro/dry-run-use-case.py:14-37` reads `BRO_HOST` (defaults to the prod Shivalik URL `/bro`), `BRO_API_TOKEN`, `BRO_CLIENT_ID` and `BRO_USE_CASE` from `os.environ`. INFERENCE: the operator probably exports ADMIN_TOKEN as BRO_API_TOKEN by hand.

### Keys that encode environment (the new design wants these gone)
- The `_DEBUG_` infix (`SHIVALIK_DEBUG_*`, `ATSPL_DEBUG_*`, `RTL_DEBUG_*`) means prod in practice. `service-db-map.json:3-16` maps each `tenant:service` to `{prod: VAR, uat?: VAR}`.
- `RTL_STAGE_*_DB_CONN_URL` (3 keys) are the uat side. `service-db-map.json:2` says they "get renamed in .env separately", which is unfinished.
- An implicit prefix family is `SHIVALIK_UAT_*`: `cbs_curl_via_eventbus.sh:229-234` sets `VP="SHIVALIK_"` for prod and `"SHIVALIK_UAT_"` for uat. That yields `SHIVALIK_UAT_FINACLE_*`, `SHIVALIK_UAT_TUNNEL_BASTION` and `SHIVALIK_UAT_KUBE_CONTEXT`. None of these exist in any env file.
- Hosts with baked-in env: `aspora.prod.shivalik.in`, `…-prod-mumbai-01-…`, `…-prod-london-01-…`, `ssfb-aspora-prod-eks-cluster`.
- The CLI env flag is everywhere. `safe_sql.sh:7,69,151,173-181` (`--env prod|uat` required, `stage` a deprecated alias), `safe_curl.sh:5,14,194,372-377,407,448-450` (defaults to prod with a warning in URL mode), `cbs_curl_via_eventbus.sh:53-64,169,197-200` (defaults to prod), and `verify-setup.sh:221` (`--env prod` hardcoded in the probe). `service-api-map.json:2` says "only prod is wired today".
- For a single-env redesign, INFERENCE: rename to `<ENTITY>_<SVC>_DB_URL` / `<ENTITY>_<SVC>_API` style, drop `_DEBUG_`/`_STAGE_`/`_UAT_`, and let a deployment's .env simply point at the prod or stage hosts.

### Quickwit / Grafana / Slack / Jira keys
- None of these are in any .env file. FACT, from the key-set diff.
- Quickwit config is doc-driven, not env-driven. `.claude/skills/aspora-logs-finder/SKILL.md:66-67,89-91` names `DEBUG_AI_QUICKWIT_URL` and `DEBUG_AI_QUICKWIT_INDEX` (shell-exported). `references/env/shivalik/qw.md:9,18-19` gives `http://quickwit.vance.local:7080` with index `logs-v1`. `references/env/atspl/qw.md:10-15` covers the `qw` CLI (context `envoy-prod`, endpoint `https://quickwit-proxy.vance.finance`, Okta OIDC through `freeway.aspora.com`, index `envoy-logs`, browser `qw login` that is interactive-only, and not reachable via `safe_curl.sh`). There is no `references/env/rtl/` directory; only `atspl` and `shivalik` exist. `search_sim_binding.py:34-36` hardcodes `QUICKWIT_HOST`, `QUICKWIT_PORT` and `QUICKWIT_INDEX`.
- Grafana: `references/env/shivalik/grafana.md:18,25` names an internal ELB dashboard URL and the env vars `GRAFANA_USER`/`GRAFANA_PASSWORD` for headless Playwright login.
- Slack: no token keys. Posting goes through the claude.ai Slack connector (MCP `slack_send_message`), which is interactive-only and "will not work in headless/cron runs" (README `:205-206`). The channel `#nri-banking-cx` has the hardcoded ID `C0A9VPA17D5` (README `:47`, CLAUDE.md/AGENTS.md `:37`, `aspora-triage-slack-report/SKILL.md:14,28`).
- Jira: nothing found.
- Other runtime env knobs, not in .env: `TRIAGE_ACCESS_LOG` (`safe_sql.sh:47`, `safe_curl.sh:117`), `SAFE_CURL_ALLOW_ANY_HOST=1` (paired with the `--allow-any-host` flag, `safe_curl.sh:515-528`), `SHIVALIK_TUNNEL_PORT` (default 55432, `ensure_db_tunnel.sh:50`), `HARBOR_REPO` (`harbor_field_enc.sh:46`), `CODEGRAPH_REFRESH_MAX_AGE_HOURS` (default 6) and `CODEGRAPH_REFRESH_RETRY_MINUTES` (default 30) (`.claude/hooks/refresh-repos.sh:21,24`), `CODEGRAPH_INDEX=0` (README `:99-100`), and `CLAUDE_PROJECT_DIR` (hooks).

## 2. How make-env-example.sh works (`triage-initial-setup/make-env-example.sh`)
- It derives the template from the real `.env` (`:6-8,20-21`), and `--check` exits 1 when stale (`:101-109`).
- It writes a fixed header (`:27-57`) covering the regenerate command, `cp -n` setup, where values come from, the percent-encoding trap and the tunnel/WARP note.
- An inline Python block (`:65-99`) passes comments and blank lines through verbatim and drops header lines echoed back from a copied .env. It matches `^(#\s*)?KEY=VAL`, so commented assignments stay commented. `strip_value` (`:72-80`) keeps the quotes. For `scheme://user:pass@` it rewrites the credentials to `<user>:<pass>@` and keeps host, port, db and query. For anything without `://` it empties the value.
- A post-check (`:115-118`) greps for a surviving `://x:y@` credential and fails if it finds one.
- `make-share-zip.sh:49-54` refuses to build a share zip when the example is stale.
- Caveat, INFERENCE: URL-valued non-DB keys (API bases, `FINACLE_PROXY_GW`) keep their full host, and the example does ship those prod hostnames. Only `allowed-non-get-requests.json` uses `env:VAR` host indirection specifically to avoid committing hostnames (`:2`).

## 3. verify-setup.sh checks (`triage-initial-setup/verify-setup.sh`)
The script is read-only, reports PASS/WARN/FAIL, and `--quick` skips network. The sections run in this order:
1. Workspace completeness: a list of 17 critical files (`:47-62`), including `safe_sql.sh`, `safe_curl.sh`, `service-db-map.json`, `ensure_db_tunnel.sh`, `cbs_curl_via_eventbus.sh` and `.mcp.json`, plus a check for unresolved `*.incoming` files.
2. CLI tools (`:86-92`): `git ssh curl psql jq python3` are FAIL if missing; `go` and `codegraph` are WARN.
3. .env (`:96-118`): an `envget` helper sources .env in a subshell with `env -u` so an inherited export cannot mask a missing key. Core keys are `LITBIT_SERVER_IDENTITY`, `SHIVALIK_DEBUG_HARBOR_DB_CONN_URL`, `SHIVALIK_DEBUG_RHYTHM_DB_CONN_URL` and `SHIVALIK_DEBUG_HARBOR_API`. It also looks for leftover `<pass|user|you>` placeholders and checks key perms.
4. Repos: at least 18 `.git` dirs, a count of `codegraph.db` files, and a root `.codegraph`.
5. Claude wiring: `settings.json`, `settings.local.json`, at least 4 skills, and a `.mcp.json` codegraph entry.
6. Network: Quickwit `/api/v1/indexes` through `safe_curl.sh`, and DNS via `host` for the London and Mumbai readers.
7. Bastion: `ssh`, then remote `aws sts get-caller-identity` and `kubectl config current-context` (expects `ssfb-aspora-prod`).
8. Tunnel `--status`, then `SELECT 1` through `safe_sql.sh --env prod` for every prod entry in `service-db-map.json`.

It does not check WARP directly; that is only inferred from Quickwit reachability. It does not check `qw`, `kubectl` (local), `npm`, `playwright-cli` or `headroom`.

**External binaries the workspace depends on**: `git`, `ssh`, `curl`, `jq`, `psql`/`pg_isready` (libpq), `python3` 3.11+, `go` (only for `harbor_field_enc`), `codegraph` (npm `@colbymchenry/codegraph`, also the MCP server via `.mcp.json`: `codegraph serve --mcp`), `npm`, `host` (DNS), `stat`, and `mktemp`. On the bastion: `aws`, `kubectl`, `base64` (`cbs_curl_via_eventbus.sh:389-391`). Local, undocumented by verify: `qw` v0.3.0 (ATSPL logs), `playwright-cli` (Grafana mode), the `headroom` MCP (README `:195`), and the Cloudflare WARP client. Locally on this machine `codegraph`, `kubectl` and `psql` are on PATH and `qw` is not (FACT, `which`).

## 4. Key-set diffs
- `.env` has but `.env.example` lacks: `SHIVALIK_DEBUG_BRO_ADMIN_TOKEN`.
- `.env.example` has but `.env` lacks: `SHIVALIK_KUBE_CONTEXT`.
- So `.env.example` is currently stale and `make-env-example.sh --check` would fail. INFERENCE: KUBE_CONTEXT was removed from `.env`, or the example was edited by hand, which contradicts the "GENERATED. Do not hand-edit" rule.
- `.env.bak.20260913` is identical in keys to `.env`.
- `.env.1` (older, from Aug 18) has 16 keys. It lacks `LITBIT_SERVER_IDENTITY`, `LITBIT_SERVER_IP`, `SHIVALIK_DEBUG_BRO_DB_CONN_URL`, all 5 `SHIVALIK_FINACLE_*`, `SHIVALIK_KUBE_CONTEXT` and `SHIVALIK_TUNNEL_BASTION`, and it has no extra keys.
- Commented-key sets: all files carry the 3 `RTL_STAGE_*` and 8 RDS-proxy `SHIVALIK_DEBUG_*` keys commented out. The example also has a commented `PGPASSWORD` (a header line) and `SHIVALIK_FINACLE_PROXY_GW`, and `.env.1` lacks the commented `FINACLE_PROXY_GW`.

## 5. .gitignore and secrets posture
- `.gitignore` ignores `.env`, `.env.*` and `*.env`, then re-includes `!.env.example`. It also ignores `refs/` (PII), `.claude/settings.local.json`, `.claude/prod-access.log` (audit), `.claude/.triage-captured-*` (Stop-hook sentinels), `.codegraph/`, `git-bare`, `.serena`, `.headroom`, `*.csv`, `tmp/`, `*.log`, `dist/` and `/SHARE_{VERSION,MANIFEST}`.
- `bootstrap.sh:101-131` seeds `settings.local.json` with deny rules for reading and catting `.env`/`.env.1` and for `env` and `printenv`. It allowlists only `ensure_db_tunnel.sh`, `lookup_user.sh`, `verify-setup.sh`, `safe_curl.sh` and `safe_sql.sh`. The comment at `:97-98` says the Bash deny rules are literal command matches, "the PreToolUse hook is the real enforcement".
- `apply-update.py:23,42` never touches `.env*`.
- Allowlist JSON shape today (`.claude/skills/aspora-triage/config/allowed-non-get-requests.json`): `{"allowed":[{"prefix":"/custom/api/","hosts":["env:SHIVALIK_FINACLE_PROXY_GW"],"methods":["POST"],"reason":"…"}]}`. It has 4 entries: Finacle `/custom/api/` and `/api/channel/v1/custom/`, and bro `dry-run` and `reference-query`, both on the host `env:SHIVALIK_DEBUG_HARBOR_API`. It is shared by `safe_curl.sh` and `cbs_curl_via_eventbus.sh`. The user's target shape, `[{api, source}]` in `resources/{entity}.allow.api.json`, drops `hosts` and `methods`. The current comment explicitly warns that a path prefix without a host lets attacker-supplied hosts through.

## Key facts

- The live .env has 26 active keys, all for 3 entities: SHIVALIK (21 keys incl. LITBIT_*), ATSPL (2) and RTL (3). No Quickwit, Slack, Grafana, Jira or LLM keys exist in any .env (key-set diff of .env/.env.example/.env.1/.env.bak.20260913)
- .env.example is stale: .env has SHIVALIK_DEBUG_BRO_ADMIN_TOKEN and the example does not; the example has SHIVALIK_KUBE_CONTEXT and .env does not (key-set diff)
- .env.bak.20260913 has the same keys and order as .env; only the LITBIT_SERVER_IDENTITY line differs (masked diff)
- Shivalik DB URLs are all localhost:55432 through the SSH tunnel; RTL (London reader :5432) and ATSPL (Mumbai reader :65432) are direct over WARP (.env.example:27-29, 68-95)
- Env-encoded naming: _DEBUG_ means prod, RTL_STAGE_* means uat, and cbs_curl builds SHIVALIK_UAT_* by prefix (service-db-map.json:2-16; cbs_curl_via_eventbus.sh:229-234)
- safe_sql.sh requires --env prod|uat; safe_curl.sh and cbs_curl default to prod with a warning; 'stage' is a deprecated alias (safe_sql.sh:173-181; safe_curl.sh:372-377,448-450; cbs_curl_via_eventbus.sh:197-200)
- make-env-example.sh derives the example from .env via inline python: it masks URL creds to <user>:<pass>, keeps host/port/db, blanks every non-URL value, keeps comments, supports --check, and fails if a credential survives (triage-initial-setup/make-env-example.sh:65-118)
- verify-setup.sh hard-requires git ssh curl psql jq python3, warns on go and codegraph, and infers WARP only from Quickwit reachability (verify-setup.sh:86-92,155-164)
- verify-setup.sh core keys: LITBIT_SERVER_IDENTITY, SHIVALIK_DEBUG_HARBOR_DB_CONN_URL, SHIVALIK_DEBUG_RHYTHM_DB_CONN_URL, SHIVALIK_DEBUG_HARBOR_API (verify-setup.sh:103-107)
- Quickwit config is doc/shell-export only: DEBUG_AI_QUICKWIT_URL/INDEX (Shivalik http://quickwit.vance.local:7080, index logs-v1); ATSPL uses the qw CLI with Okta OIDC at quickwit-proxy.vance.finance, index envoy-logs; there is no RTL qw reference (.claude/skills/aspora-logs-finder/references/env/{shivalik,atspl}/qw.md)
- Slack posting goes through the claude.ai Slack MCP connector only, interactive, and does not work headless; channel C0A9VPA17D5 is hardcoded (triage-initial-setup/README.md:47,205-206)
- The Grafana path needs GRAFANA_USER/GRAFANA_PASSWORD plus playwright-cli (.claude/skills/aspora-logs-finder/references/env/shivalik/grafana.md:25; SKILL.md:165)
- The non-GET allowlist today is {allowed:[{prefix,hosts:[env:VAR],methods,reason}]} with 4 read-only POST entries (.claude/skills/aspora-triage/config/allowed-non-get-requests.json)
- Finacle AUTH_TOKEN/EXPIRY are written back into .env by cbs_curl_via_eventbus.sh (60 min lifetime); SHIVALIK_FINACLE_OAUTH_SCOPE is read with a hardcoded default (.env.example:17-18; cbs_curl_via_eventbus.sh:256-260)
- Runtime env knobs outside .env: TRIAGE_ACCESS_LOG, SAFE_CURL_ALLOW_ANY_HOST, SHIVALIK_TUNNEL_PORT, HARBOR_REPO, CODEGRAPH_REFRESH_MAX_AGE_HOURS, CODEGRAPH_REFRESH_RETRY_MINUTES, CODEGRAPH_INDEX (safe_sql.sh:47; safe_curl.sh:515; ensure_db_tunnel.sh:50; harbor_field_enc.sh:46; .claude/hooks/refresh-repos.sh:21,24)
- bootstrap.sh seeds settings.local.json that denies reading .env/env/printenv and allows only the safe_* wrappers and tunnel/lookup scripts (triage-initial-setup/bootstrap.sh:101-131)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `triage-initial-setup/make-env-example.sh` | Generates .env.example from .env: strips values, masks URL creds, --check staleness, leak post-check | port: good convention (derived template, --check in CI); rewrite in TS/bun for the new repo and also blank the hosts of API URL keys if hostnames should not ship |
| `triage-initial-setup/verify-setup.sh` | PASS/WARN/FAIL preflight: tools, .env keys via isolated envget, bastion/aws/kube on the bastion, tunnel, SELECT 1 per mapped DB | port: turn it into a doctor command driven by the new config schema; drop the --env prod hardcode; add WARP, qw, and LLM provider reachability checks |
| `.claude/skills/aspora-triage/config/service-db-map.json` | tenant:service -> {prod, uat} env var name map for DB URLs | replace: collapse to tenant:service -> single env var (no prod/uat keys), per the one-.env-per-deployment rule |
| `.claude/skills/aspora-triage/config/service-api-map.json` | tenant:service -> {prod} env var name map for API base URLs | replace: same collapse; also resolve the base-URL-with-path inconsistency (values include /harbor) |
| `.claude/skills/aspora-triage/config/allowed-non-get-requests.json` | Host+prefix+method non-GET allowlist with env:VAR host indirection and reasons | port into resources/{entity}.allow.api.json, but keep host (env:VAR) and method fields; the user's proposed {api, source} shape loses the host binding this file warns is required |
| `triage-initial-setup/bootstrap.sh` | Idempotent setup: cp .env, key chmod, settings.local.json deny/allow seeding, codegraph install, repo clone | port partially: the codegraph and repos steps and the .env copy are reusable; the Claude-settings seeding does not carry over to a standalone agent |
| `.gitignore` | Secrets/PII ignore rules with !.env.example negation, refs/, prod-access.log, codegraph | reuse as-is (adapt paths) |
| `.mcp.json` | codegraph MCP server registration (codegraph serve --mcp) | reuse as-is as the code-navigation tool backend |
| `triage-initial-setup/make-share-zip.sh + apply-update.py` | git-archive share zip with manifest and three-way update applier | drop: a proper repo/deployment makes zip sharing unnecessary |

## Unknowns

- What does SHIVALIK_DEBUG_BRO_ADMIN_TOKEN feed? No script reads that name; scripts/bro/dry-run-use-case.py reads BRO_API_TOKEN. Is it exported by hand as BRO_API_TOKEN?
- Was SHIVALIK_KUBE_CONTEXT removed from .env on purpose, or was .env.example hand-edited? The example is stale right now.
- What are the Quickwit endpoint, index, and auth method for RTL? There is no references/env/rtl/qw.md, and the user says Quickwit is now in all entities.
- Is ATSPL Quickwit still Okta-OIDC-only through the qw CLI (interactive browser login)? If so, how should a headless HTTP/CLI agent authenticate to it (service token)?
- For the stage deployment, what are the stage hosts for Shivalik (DB, Kong API, Finacle gateway, bastion, kube context) and for ATSPL? Only RTL stage is sketched (Mumbai reader, db-name swap).
- Should the new .env keep the RDS-proxy DB URLs (commented, 'telnet failing') or only the localhost tunnel form?
- Which Slack credential should the new agent use for reading threads and posting (bot token, user token), given today's path is only the interactive claude.ai connector?
- Are Grafana (GRAFANA_USER/PASSWORD, Playwright) and the headroom MCP still needed in the new design, or is Quickwit the only log path?
- Should prod hostnames (API bases, Finacle gateway) keep appearing in the committed .env.example, as they do today, or be blanked?
- Will the SSH tunnel (ensure_db_tunnel.sh, currently a SessionStart hook) be managed by the agent runtime, or by the operator/deployment outside the agent?

## Contradictions

- The service-api-map.json _comment says the var must hold the 'base URL only (scheme + host [+ port], no trailing path)', but SHIVALIK_DEBUG_HARBOR_API and SHIVALIK_DEBUG_RHYTHM_API values include /harbor and /rhythm paths (.env.example:34-35).
- .env.example says 'GENERATED. Do not hand-edit' and is derived from .env, yet its key set differs from .env (BRO_ADMIN_TOKEN missing, KUBE_CONTEXT extra), so it was hand-edited or not regenerated.
- The user brief says Quickwit exists in all entities; workspace docs only cover Shivalik (quickwit.vance.local) and ATSPL (qw CLI via OIDC proxy); there is no RTL Quickwit reference. atspl/qw.md says it is a 'different cluster from Shivalik/SSFB', unlike the brief's framing that it is only in SSFB.
- The user wants no prod/stage branching, but every wrapper (safe_sql.sh, safe_curl.sh, cbs_curl_via_eventbus.sh, verify-setup.sh) takes --env prod|uat, and the var naming encodes env (_DEBUG_, RTL_STAGE_, SHIVALIK_UAT_).
- The user's proposed allowlist shape [{api, source}] drops the host binding; allowed-non-get-requests.json:2 states host is required because 'a path prefix alone would let the same path on an attacker-supplied host through'.
- The service-db-map.json comment says the RTL uat entries point at RTL_STAGE_* names that 'get renamed in .env separately'; that rename never happened, and all env files still use RTL_STAGE_* (commented).
- README says verify-setup checks 'WARP/Quickwit reachability', but there is no WARP check; WARP is only inferred from a Quickwit HTTP probe, and README section 6 itself says a Quickwit timeout is not evidence WARP is down.
