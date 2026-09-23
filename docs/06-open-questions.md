# 06. Open questions for you

Deduplicated from the nine survey reports and the design. Grouped by what they block. Answers go into [05-decisions.md](05-decisions.md) as new entries.

**Status 2026-09-23**: every question below is answered (Answer column, Varun's words kept as written). Folded into D32–D41 and assumptions A2, A3, A6, A8, A10, A13. One follow-up remains open: Q26 at the bottom.

Where an answer needed interpretation, this is what was taken: Q3/Q4 → `TRIAGE_DEPLOY_MODE=local|server`, pre-flight warns and never blocks (D32). Q6/Q23 → `BEGIN READ ONLY` plus `SET LOCAL` timeouts per call; role check warns unless `TRIAGE_REQUIRE_READONLY_DB_ROLE=true` (D33). Q16 → hostnames kept where known, values blank otherwise, every key present (D41).

## Blocks the HLD sign-off

| # | Question | Why it matters | Default if unanswered | Answer |
|---|---|---|---|---|
| Q1 | Is `resources/{entity}.allow.api.json` with `{api, source, methods?, match?, reason}` acceptable, or do you want the bare `{api, source}` literally? | D6; the extra fields keep host binding, method scoping and review context | extended shape | **Answered 2026-09-23**: renamed to `{entity}.api.rules.json`, ordered `{service, method, api, action}` rules, first match wins, default GET allow. See D31 and 02 §4.4 |
| Q2 | Per entity, what are the Quickwit URL, index, auth mode and `service` field values? For ATSPL, can a non-interactive bearer token be issued for the OIDC proxy? For RTL, does the index carry London traffic? | logs tools per entity; ATSPL is browser-OIDC only today; RTL is undocumented | SSFB as today; ATSPL and RTL unconfigured until answered | So, for now, consider an API token and API url is available for every entities Quickwit.
| Q3 | Where will v1 run: your laptop (WARP + bastion key + tunnel) or a server? | network paths, tunnel ownership, HTTP deployment | laptop (A2) | Keep an env var, deploy mode, it it's local, then you can enusre that the tunnel is open. else the tunnel ownership, n/w path is the deployment infra's ownership
| Q4 | CBS via kubectl: name of the flag is proposed as `SSFB_CBS_VIA_KUBECTL_ENABLED`. Is the OAuth password-grant POST acceptable as tool infrastructure (not model-reachable), and where should the token cache live? | D14 | flag as proposed; cache under `.data/cache` | Again, if DEPLOY_ENV is local, then it'd mean we'd need to go through aws kubectl login which can be trigerred. Also we should give kubectl context profiel name as there are three entities.
| Q5 | Do admin API base URLs exist for ATSPL (package-svc, pulse) and RTL (workflow-op, banking-service, kyc-service)? | `http_call` is unusable for those entities without them | investigators use DB and logs only | Yes it exists. But again it's going to be in an Env Var, which you are not going to hard-code, so why do you need it?

## Blocks the LLD sign-off

| # | Question | Why it matters | Default | Answer |
|---|---|---|---|---|
| Q6 | Do the ATSPL and RTL DB credentials map to read-only Postgres roles server-side? SSFB uses an RDS reader endpoint, so it is read-only by topology. | the SQL gate is client-side; a server-side role is the real boundary | request roles from infra; note as a gap in the doctor output | Ideally we would but then we are also going to ensure that we are not allowing any update SQL queries to go through. The same thing was already there in triage-shivalik, where we were using a safe curl.
| Q7 | May the agent decrypt harbor fields (`SHIVALIK_DEBUG_HARBOR_DB_FIELD_ENC_KEY`)? | PII exposure; A6 excludes it | excluded | Yes, if required. For eg search by phone so you need to encrypt etc etc.
| Q8 | Should recurring remediation writes (`trigger-delivery`, `sync-address`, `trigger-customer-creation`, `debit-unfreeze`) ever get an `allow` rule, or stay human-only forever? | D17 says never in v1 | never; block rules seeded, recommendations only | No, the triaging can share the steps to fix w/o actually running the cURLs. It can share cURLs, sql queries that the user can execute explicitly if required.|
| Q9 | Which Slack credential will read threads and post? Bot token with which scopes? Should the reviewer (`abhilash.shinde@aspora.com`) and `@nri-banking-on-call` move to `.env` as proposed? | ingress adapter, `.env.example` | bot token; both in `.env` | Reviewer and @nri-banking-on-call should be moved to .env. Also we can provide a token.
| Q10 | Is the cohort DB in scope? Which service and repo own it? | A10 | in scope, read-only, no repo | Yes cohort-service
| Q11 | Are batch/cohort status requests and incident impact analysis wanted in v1, or v2? | D17 | v2 | we have cohort service integration. if required, we can use it. impact analysis is not required unless asked for
| Q12 | Should Slack screenshots be passed to the model as images? 73 of 118 threads rely on them. Requires multimodal models in every tier. | classifier and tier models; cost | pass images when the tier model supports them; otherwise note "screenshot not analysed" | Yes. So the images are present and we have selected a model which does not support them. Then we should switch to a model which does.

## Added by the reviews

| # | Question | Why it matters | Default | Answer |
|---|---|---|---|---|
| Q21 | Which model providers may receive customer data (account numbers, phones, names)? Anthropic and OpenAI direct are one thing; OpenRouter routes to third parties, and Ollama is local. | the model-facing redaction profile deliberately keeps search keys visible | allow Anthropic, OpenAI and local Ollama for tier models; restrict OpenRouter to the classifier, which sees the redacted thread only | Aligned
| Q22 | Is "human confirms in Claude Code chat, then `triage post --yes --approved-by <user>`" an acceptable approval proof for v1, given the CLI cannot verify who typed it? | D25, D28 | yes for v1; Slack-signed approval in v2 | Yes. Tomorrow let's say, if we are doing it on Slack, then in Slack we can also present a button for Yes, No, or Comment, where the user can add their comment. Make it configurable that way.
| Q23 | Can infra provision read-only Postgres roles for ATSPL and RTL so `triage doctor` can verify them before real mode is allowed? | D7; the client-side SQL gate is defence in depth only | real mode blocked for an entity whose role check fails | Aligned.
| Q24 | Should `ssfb.api.rules.json` be seeded with block rules for the four harbor trigger endpoints, rhythm debit-unfreeze and the bro `PUT rules` subtree? Anything else you know mutates behind a GET or an innocent-looking POST? | rule 3/4 backstop | seed with those | So, we only allow GET by default. Non-GET are rejected by default unless allowed explicitly. So no need to do that. |
| Q25 | Your example allows `POST /api/v1/td-calculate` on rhythm. The current workspace rule says the TD calculator and `POST /rhythm/v1/mobile/deposits/config` are prod calls that must be read from logs, never re-issued. Do you want to relax that, or was the example illustrative? | D31; which allow rules to seed | keep them blocked (no allow rule) until you say otherwise | Ignore the examples, the API are for representational purpose to not be be executed for cURL.|

## Housekeeping (does not block design)

| # | Question | Answers |
|---|---|---|
| Q13 | Should the SSFB DB credentials be rotated? A survey subagent printed the 9 DSNs, credentials included, into its own transcript on 2026-09-23. | Outside of scope
| Q14 | Is deleting the root `CLAUDE.md` in triage-shivalik in favour of `AGENTS.md` intentional? The design copies knowledge from git HEAD. | Yes. I've renamed all CLAUDE.md to AGENTS.md(except in the repos/{git-repo}/**/CLAUDE.md as they are ownership of git)
| Q15 | Should repos be pinned per entity to the deployed branch or tag? Today they track whatever is checked out (mostly `pre-prod`). | They should be mapped to the default branch. Also keep a list of repo name and branch name and we should play to that branch name for that repo.
| Q16 | Should prod hostnames appear in the committed `.env.example`? Today's file keeps them. The new one blanks them. | You can keep it.
| Q17 | Does a stage deployment exist for SSFB or ATSPL, and what are its hosts? Only RTL stage is sketched today. | Yes
| Q18 | Are Serena, code-review-graph, headroom, ClickUp and Grafana/Playwright still wanted anywhere, or can the new design ignore them? | No
| Q19 | Does the future Slack bot need Socket Mode? Flue's channel supports only the HTTP Events API. | Ok to have HTTP Events API
| Q20 | Persistence for the HTTP deployment: sqlite file or Postgres for `src/db.ts`? | Keep it configurable based on connection string or DB_PROVIDER like sqlite or postgres

## Follow-up from the answers

| # | Question | Why it matters | Default if unanswered | Answer |
|---|---|---|---|---|
| Q26 | In `local` mode, does kubectl for `cbs_call` run on the laptop against EKS (after `aws sso login` / `aws eks update-kubeconfig` with `<ENTITY>_AWS_PROFILE`), or on the bastion over SSH as `cbs_curl_via_eventbus.sh` does today? Your Q4 answer mentions "aws kubectl login", which reads as the former. | decides what pre-flight logs into and whether the bastion SSH hop stays inside `cbs_call` | laptop kubectl (A13); the bastion hop is kept only if you say so | |
| Q27 | `qw` for server deployments: is there, or will there be, a non-interactive login (service account, token file, or env token) so a server can use the `qw` transport? Until then servers use direct HTTP for logs. | D44; `TRIAGE_DEPLOY_MODE=server` | http transport on servers | |
| Q28 | Does `qw search` accept an absolute window (`--from`/`--to`)? The launch thread shows `--since` only; our tool anchors the window to the thread's first message. | D44; window rule | convert to `--since` and drop the upper bound, noted in the report | |
| Q29 | Can a `qw` query carry a note or tag (our `run_id`) into `qw_audit`, so infra's trail and ours correlate by id rather than timestamp? | D44; D20 | correlate by timestamp | |
