# 10. Implementation notes (v1)

What was built against the plan in [09-implementation-plan.md](09-implementation-plan.md), where it differs from the design docs, and what the owner still needs to decide. The source for everything here is the body of each sub-ticket commit on main (`git log 9a88097..HEAD`), where every implementer recorded departures from the plan and notes for later tickets.

## Status

- All 12 tickets and 101 sub-tickets from [plan/plan.json](plan/plan.json) are merged to main, one commit per sub-ticket (subjects like `feat(T05.3): ...`), landed in 15 waves (0 to 14). Last sub-ticket commit: `576c127 test(T10.9)`.
- Verification on main, 2026-09-24, mock mode with the no-I/O guard:

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | ok, no changes |
| `bun run typecheck` | pass (exit 0) |
| `bun run test` | 4604 pass, 0 fail, 148 files |
| `bun run test:contract` | 160 pass, 0 fail, 15 files |
| `bun run build` | pass (writes `dist/`, which is gitignored) |
| `bun run ci` | pass: typecheck, unit tests (4603 pass, 1 skip), contract suite (160 pass), classifier suite (6 pass, 0 fail, faux, judge off) |
| `bun test ./evals` | 70 pass, 0 fail (promptfoo suite unit tests, outside `bun run test`) |

  The one skip under `ci` is `test/server/triage-server.test.ts` "with a token and no build, says to build first", which skips itself when `dist/server.mjs` exists. It ran and passed in the plain `bun run test` before the build.
- No fixes were needed.

How to run things (all from the repo root, see `package.json`):

| Script | What it does |
|---|---|
| `bun run gen` | Regenerates the gitignored `*.gen.ts` import lists (also run by postinstall, test, typecheck and build) |
| `bun run typecheck` | gen, then `tsc --noEmit` |
| `bun run test` | `bun test ./src ./test ./scripts ./integrations` with the no-I/O guard preloaded |
| `bun run test:contract` | gen, then Vitest over `test/contract/**/*.contract.ts` on Node |
| `bun run build` | gen, then `vite build` into `dist/` |
| `bun run triage -- <command>` | The CLI (`node bin/triage.mjs`) |
| `bun run serve` | HTTP server (`node bin/triage-server.mjs`, runs from `src/`, needs `TRIAGE_HTTP_AUTH_TOKEN`; D50) |
| `bun run dev` | `serve` under `node --watch` |
| `bun run evals:classifier` | promptfoo classifier suite (faux providers by default) |
| `bun run ci` | The CI gate: temp eval home, then typecheck, unit tests, contract suite, classifier suite |

Repo conventions (layout, naming, tool and command file shapes, test placement, commit format) are in [../CONVENTIONS.md](../CONVENTIONS.md), linked from `AGENTS.md`.

## Deviations from the design docs

Only places where what was built differs from the HLD, LLD, decisions or plan text. API shape choices that do not change behaviour are left out.

| Area | What the docs say | What was built | Why | Sub-ticket |
|---|---|---|---|---|
| Flue persistence | HLD §7 (D38): sqlite and postgres are both Flue ecosystem adapters (libsql, postgres) | Flue's built-in `node:sqlite` adapter for sqlite; `@flue/postgres` for postgres. No libsql or better-sqlite3 | Built-in adapter covers sqlite; repo rule forbids better-sqlite3 | T01.1, T01.7, T09.1 |
| SQL parser | Plan: node-sql-parser or pgsql-ast-parser | libpg-query (Postgres grammar as WASM, loaded by top-level await); pgsql-ast-parser removed | Real Postgres grammar. A few SQL-standard forms parse as `pg_catalog.*` calls (btrim, timezone, similar_to_escape) and are allowed with that qualifier only | T02.1 |
| HTTP rule matching | HLD §4.4 examples write templates relative to the service base; T02.4 `decideHttp` matches rules on the full built pathname | `http_call` composes `buildUrl` and `evaluateRule` itself and matches base-relative paths. If any rule template for a service starts with the base path prefix, every call to that service is refused (fails closed). `decideHttp` is still used by `cbs_call` and `get_account_statement` | The two conventions only agree when the base has no path prefix. HLD §4.4 now says templates are base-relative. Owner question 1 | T05.3 |
| Screenshots | Plan (coverage gap 9): check whether Flue dispatch takes image parts, with a sandbox-file fallback if not | Images go inline in Flue `dispatch` as attachments when `tier_final` accepts images; on a text-only tier they are dropped with `images_dropped` and a warning. No sandbox fallback | Flue 2.0.8 dispatch accepts image parts | T07.4 |
| Flue send condition | LLD 04 and HLD §5: `dispatch({..., uid: null})` | `init(Triage, {id: run_id, uid: null}).dispatch({message, initialData})` | Flue 2.0.8 takes `uid` on `init()`, not on the handle's `dispatch()` | T07.4 |
| Pipeline order | Data flow: classifier, then tier policy (with the known-pattern index) | Separate pattern match step between classify and policy: `matchPattern` sets `matched_pattern_id`; a `matched_pattern_id` returned by the classifier model is dropped | Only patterns.ts may set it, because it lowers the tier under policy rule 5 | T06.3, T07.4 |
| Prior cases | `PriorCaseSchema` in src/types carried `run_id` | `PriorCaseSchema` is the store projection: category, subcategory, report_status, matched_pattern_id, escalated, feedback_verdict, age_days, similarity. No run id, id chain, root cause or reply text | `TriageInit.prior_cases` must accept what `priorCasesFor` returns; keeps other runs' data out of the prompt | T09.7, T07.4 |
| eventbus and audit | T12 assumed these were not registry services | They are `ssfb:eventbus` and `ssfb:audit` in the registry (logs and code, no data access). T12.8 added `knowledge/ssfb-eventbus` and `knowledge/ssfb-audit` skills so the coverage test passes | Registry lists them | T01.5, T12.8 |
| Read-only role check | Plan: `checkReadOnlyRole` / `enforceRolePolicy` as free functions around the select | Methods on the SQL connector (they need its pools). The check runs in its own `BEGIN READ ONLY` / `SET LOCAL` transaction, once per env var name per process; a failed check is not cached | Keeps the check off the data transaction | T04.2 |
| Read-only role check on replicas | D33: a role with INSERT, UPDATE or DELETE on some table is a doctor warning, or a real-mode block with `TRIAGE_REQUIRE_READONLY_DB_ROLE=true` | The same statement also returns `pg_is_in_recovery()`. On a replica a writable role passes: no warning, no block, and doctor reports `ok` naming the replica. On a primary the D33 policy applies unchanged. The `db_writable` doctor fixture takes an optional `reader` (default false) | SSFB is read through the Aurora `cluster-ro` endpoint as the service's own role, which has write grants a replica cannot use. The server is asked rather than the host name matched: the DSN points at the local tunnel port, and a reader endpoint routes to the writer when the cluster has no replicas. The result is cached per env var name per process like before, so a failover after the first check is covered by the read-only transaction and `default_transaction_read_only`, not by this check | follow-up 2026-09-25 |
| Quickwit `group_by` on qw | HLD §2 logs_search row: `count`/`group_by` map to `qw count`/`qw histogram` | `group_by` on the qw transport runs `qw search` projected to the group field and counts groups in code, marked truncated when more hits matched than were returned. `search` adds `--max-hits` so the entity cap applies instead of qw's default of 20 | `qw histogram` is a date histogram; qw has no terms aggregation | T04.5 |
| Fixture path for Slack reads | Plan: `fixtures/slack_read/<channel>-<ts>.json` | `fixtures/shared/slack_read/global/<hash>.json` | The fixture store only reads `<kind>/<entity>/<hash>.json` | T07.2 |
| Extra fixture kinds | T03.1 kind list | Added `field_crypto`, `code_query`, `slack_user` | `withMock` accepts only known kinds; these tools had no kind | T04.7, T05.10, T08.7 |
| Finacle headers | T04.6 ticket env keys and acceptance list | Every CBS API request also sends a fresh `RequestUUID` header ("asp" plus 7 alphanumerics); the OAuth mint does not | The survey docs and the reference script show the gateway expects it | T04.6 |
| note_evidence on the root | Plan mounts note_evidence on triage | Mounted, but on the triage mount the call is refused and the model is told to let the delegate record findings | Evidence is keyed by entity or `code`; the root has neither | T05.9 |
| resolve_identity and code tools | Every I/O tool goes through `runIoTool` | `resolve_identity` (multi-hop, up to five databases, per-hop fixtures) and `repo_read`/`repo_grep` (local disk in both modes, no fixture kind) have their own wrappers with the same budget, audit and redaction steps | `runIoTool` assumes one backing env var and one fixture per call | T05.5, T05.11 |
| Identity statements | Scope and SQL gate apply to SQL | The fixed identity-chain statements are wrapped with `buildReadOnlyTxn` and run through the connector, skipping the model SQL gate on purpose | They are constants, not model SQL | T05.12 |
| Redaction patterns | T02.7 pattern list | Extra `credential` pattern in both profiles (DSN passwords, key=value secrets, bearer tokens, private key blocks) | Secrets in tool output | T02.7 |
| HTTP path checks | T02.4 listed checks | Also refuses `;` and a trailing `/` in paths | Servers that strip matrix params or trailing slashes could reach a path a block rule meant to stop | T02.4 |
| Repo pins | `resources/repos.json` pins are {repo, entities, branch?} | Optional `remote` added so `repos sync` can clone a missing checkout. Shipped `repos.json` has no remotes | Sync needs a remote to clone | T11.4 |
| Knowledge assignment | HLD does not assign `frontend-routing` | Given to Triage and code_walker | Needed a home | T12.1, T06.6 |
| Patterns seed | HLD: seed from `taxonomy.json` | 35 entries seeded from the `## Known issues` sections of the service notes, frontend-routing and the sim-binding skill; `taxonomy.json` left out | Nothing taken from past case folders | T12.8 |
| Report markdown | `affected_count` printed as a number | Printed with thousands separators (`250,000`) | Stops the persisted `digits6` detector masking a count | T08.4 |
| Delegate factories | `investigatorFor(entity, runId)`, `codeWalkerFor(runId)` | Both also take `env {config, registry, deps, knowledge?}` | They need config, registry and run deps to build a ToolContext | T06.6 |
| Entity mounting | HLD §1.1, LLD 04 §2.4, plan T06.8: the root mounts investigators for `TRIAGE_ENTITIES` narrowed by `request.hints.entities` | The root mounts investigators for every enabled entity. The hinted entities become `plan.focus` and the instruction's "Named in the request" line, where the root starts | Most triage-shivalik flows cross entities, and every eval case hints `[ssfb]`, so a follow-up to rtl or atspl had no investigator to brief. HLD §1.1 and LLD 04 are updated | review 01 |
| `triage wait` timeout | Not specified | Exits 3, the same value as a config error; the JSON `status: 'timeout'` tells them apart | `output.ts` had no timeout code | T07.5 |

## Questions for the owner

1. **Which pathname convention do `api.rules.json` templates use?** `http_call` matches templates relative to the service base (as the HLD §4.4 examples are written); T02.4's `decideHttp`, used by `cbs_call` and `get_account_statement`, matches the full pathname. They only agree when the base URL has no path prefix. Today a template carrying the base prefix makes `http_call` refuse the whole service. Recommended: base-relative everywhere, and change `decideHttp` to strip the base path before `evaluateRule`. Settle this before writing real block rules for harbor, bro, rhythm or cohort. (T05.3, T02.4)
2. **Should the scope rule deny every 9-plus digit literal not in the ID chain?** `checkScope` scans SQL literals as well as params, so an epoch-millis timestamp (13 digits) or any long numeric constant in a `WHERE` clause is denied unless it is in the chain. Recommended: keep the deny, and tell the model in `investigator.md` to write time bounds as ISO timestamps or bind them through `from`/`to`. If that proves too tight, exempt numeric literals compared against columns named like `*_at`/`*_ts`. (T02.5)
3. **Rename one of the two `workflow` services?** ssfb and rtl both register a service called `workflow` (separate copies of workflow-op), so per-entity service picklists are not literally disjoint. Tools are per-entity, so nothing is ambiguous at run time. Recommended: leave as is; the T05.8 test allows shared names only when both entities back them with different values. Rename only if reports read as confusing. (T05.8)
4. **Are the byte-budget defaults right?** `TRIAGE_MAX_RESPONSE_BYTES_PER_CALL=1048576` (1 MiB) and `TRIAGE_MAX_BYTES_PER_RUN=20971520` (20 MiB) were chosen without a source. Recommended: keep them for v1 and revisit after real runs, using the budget state in the audit to see how close runs get. (T01.3, T02.6)
5. **Should Indian PAN card numbers (ABCDE1234F) be masked?** The HLD says the model-facing profile masks "PAN"; the `pan` detector is card PAN (Luhn-checked 13-19 digits). There is no Indian PAN pattern, so these strings reach the model and are not masked by the persisted profile either (four digits is below `digits6`). Recommended: add a `pan_card` detector (`[A-Z]{5}[0-9]{4}[A-Z]`, word-bounded) to both profiles. (T02.7, T05.2)
6. **How should plain eval runs reach fixtures when the eval home has every credential blank?** The tool pipeline answers `not configured` for a blank backing env var before it looks for a fixture, so in an eval home `sql_select`, `http_call` and `logs_search` never reach the mock layer. T10.5's strict-miss contract works around it by wrapping `loadRegistry` so ATSPL's capabilities report ok with a placeholder. Recommended: in mock mode only, skip the not-configured check and go to the fixture store, so a missing fixture shows as a strict miss rather than `not configured`; keep the check as is in real mode. (T10.5, T05.1)
7. **Keep `ssfb:eventbus` and `ssfb:audit` as registry services?** They have logs and code but no triage data access. T12 assumed they were not services; T12.8 added short skills for them. Recommended: keep them, since Quickwit and code_walker can use the service names. (T01.5, T12.8)
8. **Confirm the Finacle `RequestUUID` header.** Added from the survey and the reference script, not the ticket. Recommended: confirm with whoever owns the gateway before enabling `SSFB_CBS_VIA_KUBECTL_ENABLED`. (T04.6)
9. **Confirm the codegraph argv.** The code tools run `<command> -p <repo dir> -- <query>` for explore, node, callers and impact; the survey showed `-p` and `--` only for explore and node. Recommended: check against the installed codegraph before first real use. (T05.10)
10. **Confirm the rhythm state columns.** The identity core reads `account_status` and `debit_allowed` from rhythm account mappings, taken from the admin API response and not checked against the schema. Recommended: check against the rhythm schema before real mode. (T05.12)
11. **`encrypt_lookup_value` is not scope-checked.** The HLD scope rule names only `sql_select`, `http_call`, `logs_search` and `cbs_call`, and the IdChain has no email or CIF key, so a check would refuse those lookups. The encrypted value it returns is still scope-checked when used in `sql_select`. Recommended: accept. (T05.7)
12. **Masked run ids in stored reports.** A ULID can hold six digits in a row; the persisted profile then masks it in the stored `report.json`, which no longer parses back through `ReportSchema`. Readers put the run id back from the path (T07.4, T07.7, T08.7). Recommended: have the persisted profile skip fields that are exactly a valid run id, or mint run ids with no six-digit run. (T08.4, T10.9)

## Known gaps and follow-ups

| Gap | Sub-ticket |
|---|---|
| The no-I/O guard patches fetch, WebSocket, net, tls, http, https and named binaries through child_process and Bun spawn. It does not cover a child `node` process's own I/O or DNS lookups. | T01.2 |
| `libpg-query` loads its WASM at import. `bun run build` passes, but running the bundled `dist/` with the SQL gate was not verified, so the WASM file may not be found in the bundle. Nothing runs `dist/` since D50. | T02.1 |
| The postgres run store migrator defaults to `./migrations` next to the module. A bundled build has to pass `migrationsDir`, and nothing in the server boot passes it yet. The server runs from `src/` since D50, where the default holds. | T09.3, T09.4, T07.10 |
| CONVENTIONS.md said `bun test ./src ./test ./scripts`; T07.8 added `./integrations`. Fixed with these notes. | T07.8 |
| `evals/promptfoo/*` tests are outside `bun run test`; run them with `bun test ./evals`. `bun run ci` runs the suite itself, not these tests. | T10.7 |
| promptfoo full-Triage suite (`triage evals triage`) is refused as not in v1. | T10.8 |
| HTTP `POST /triage/:run_id/post-to-slack` answers 403, or 501 when enabled; posting is CLI only. | T07.7 |
| `GET /doctor` runs the `triage doctor` checks on the server (`check=`, `errors_only=`, `sort_by=`) and answers 200 `{checks, counts}` with fail rows included. Requests during a run share it. Preflight stays CLI only: in server mode it is a subset of these probes, and in local mode it starts the tunnel and logins. | T11 |
| `POST /triage` answers 202 before the background submission writes the run record, so a `GET /triage/:run_id` sent straight after can answer 404 for a moment. Found by `test/contract/server.contract.ts`, which polls through it. | T07.7 |
| just-bash defence-in-depth patches cannot install under bun, so the bun unit tests run the virtual sandbox with it off. Node, where the app runs, has it on. | T06.7 |
| ~~`resources/repos.json` pins carry no `remote`, so `triage repos sync` cannot clone a repo that is not checked out.~~ Fixed by D46: a pin without a remote is cloned from `TRIAGE_GIT_PROTOCOL`, `TRIAGE_GIT_HOST` and `TRIAGE_GIT_ORG`. | T11.4 |
| Decrypted values that the `credential` detector would read as a secret come back as null with a note (about 4 in 10,000). | T05.7 |
| Stored `report.json` can hold a masked run id (question 12). | T08.4 |
| HLD §7 still says libsql and LLD 04 still shows `uid` on `dispatch()`; the tables above are the correction. | T01.1, T07.4 |
| Knowledge notes carry `(unverified: ...)` markers where the sources disagreed or were silent: harbor `/v1/device/register`, whether adminV1 checks `x-customer-id`, IMPS COMPLETED vs SUCCESS, comms tables, cohort (a stub), canopy, RTL logs (a stub), CodeGraph YAML indexing. | T12.4, T12.5, T12.6, T12.7, T12.3 |
| Pattern entries marked `stable: true` only where a note states the cause as fact; the sim-binding entries stay `stable: false` until reviewed. | T12.8 |
| ~~`test/server/triage-server.test.ts` skips its "says to build first" case when `dist/server.mjs` exists.~~ Gone with D50: the server needs no build, and the test boots it from `src/` and checks a request and SIGTERM. | T07.10 |

## Follow-ups on 2026-09-24

Owner review items, decided in D46 to D49 and the D44 update.

| Change | Decision |
|---|---|
| SSFB logs over HTTP; ATSPL and RTL over `qw` with `--context` on every call | D44 |
| Repos cloned from `TRIAGE_GIT_ORG` over `ssh` or `https`; token through git's environment | D46 |
| Repo sync every `TRIAGE_REPOS_SYNC_INTERVAL` (default 24h) on a server timer and before runs on `TRIAGE_REPOS_SYNC_INTERFACES`; `POST /repos/sync`, `GET /repos/sync/:sync_id`, `GET /repos`; sync ids in memory only | D47 |
| `encrypt_lookup_value` and `decrypt_fields` per service; rhythm added | D48 |
| `code_callers` removed | D49 |

Assumptions made, not verified against a real system:

- The host's git is 2.31 or later, which reads `GIT_CONFIG_COUNT`. The local git is 2.54. An older git ignores the variables, so an https clone falls back to the credential helper.
- GitHub accepts `AUTHORIZATION: basic base64(x-access-token:<token>)` for a fine-grained or classic token, as actions/checkout sends it. No clone has been run with a token.
- Rhythm's `FIELD_ENCRYPTION_SECRET_KEY` differs from harbor's. The code reads it per deployment (`rhythm/cmd/orchestrator/encryption.go`); the values were not looked at.
- `customer_nominees` in rhythm is the only rhythm table with encrypted columns (from the gorm tags in `rhythm/internal/model`).
- `TRIAGE_REPOS_DIR` points at a folder used only for these checkouts. A sync checks out the pinned branch in every clean clone there.

For an existing `.env`:

- `SSFB_RHYTHM_FIELD_ENC_KEY=` must be added (blank is fine). The registry refuses to start when a key it names is missing.
- `SSFB_QUICKWIT_TRANSPORT=http` switches SSFB logs to HTTP; `.env.example` ships that value.
- The `TRIAGE_GIT_*` and `TRIAGE_REPOS_SYNC_*` keys can be left out; their defaults apply.

## Follow-ups on 2026-09-25

| Change | Decision |
|---|---|
| Five deploy manifests repos pinned; `<ENTITY>_INFRA_REPO` names the one this deployment reads; agents get a "Deploy manifests" line; the repos are fetched before each run; doctor `infra` check | D51 |

Assumptions made, not verified against a real system:

- `non-prod-aspora-argo` is SSFB's stage manifests repo, rooted at `.`, and SSFB only. The owner's table row for SSFB had one field missing; the owner confirmed the reading.
- The app folders and `base/` + `overlay/` layout in the service notes' Deploy sections and in repo-map come from folder listings of local checkouts of `prod-ssfb-aspora-argo`, `non-prod-aspora-argo`, `prod-envoy-services-aspora-argo` and `stage-atspl-aspora-argo` on 2026-09-25 (names only, no file contents). `k8s-manifests` was not checked out, so the RTL notes have no Deploy section.
- `prod-envoy-services-aspora-argo` has `stage-env` as its default branch; `main` was last changed in 2026-02. The pin has no branch, so sync follows `stage-env`.
- `k8s-manifests` has `environments/vance-core/prod/eu-west-2` and `environments/vance-core/stage/ap-south-1`, as the owner's table says. The doctor fails the row when the folder is missing.
- All five repos live in `TRIAGE_GIT_ORG` on the default branch. None has a `branch` or `remote` in `repos.json`.

For an existing `.env`:

- `SSFB_INFRA_REPO`, `ATSPL_INFRA_REPO` and `RTL_INFRA_REPO` must be added. The registry refuses to start when a key it names is missing; blank turns the line off for that entity. Prod values are in `.env.example`; the stage values are in the comment above each key.
- Run `triage repos sync` once to clone the four new repos.

### Mid-run input (P6, D53)

| Change | Decision |
|---|---|
| `ask_requester` on the Triage root; `needs_input` phase and input requests in both run stores (`0002_input_requests.sql`); `answerRun` and the `triage.input_answer` signal; `triage input`; `run`/`wait` ask at a terminal; `status` shows the question; `ask` refuses while one is open; `TRIAGE_MAX_ASKS_PER_RUN`; the run's id chain mirrored into persistent state | D53 |

Departures from the P6 design, all the owner's scope (CLI only):

- No HTTP/web or Slack adapter. `GET /triage/:run_id` shows a parked run as `status: running` with `phase: needs_input`; `POST .../ask` is not refused while a question is open.
- No `do` requests (they wait for the D32 answer) and no deadline for an unanswered question (`triage input --skip` is the manual one).
- No ingress-time ask when a thread carries no id; the run asks mid-run instead.

Assumptions made, not verified against a real system:

- Flue 2.0.8 delivers a `kind: 'signal'` message to an idle conversation as a new response with the full history, and `useDelivery()` in the root's render sees that signal's `attributes`. The contract test `test/contract/agents/input.contract.ts` drives this through the runtime with the fake model; no real model has asked a question yet.
- A response that ends on `ask_requester` settles `completed` from Flue's point of view; the pipeline tells it apart by the run's phase after the read. If a tool ever moves the phase to `needs_input` before the pipeline writes `investigating`, the parked state would be missed; the tool runs during the read, after that write.
- Whether current models ask only when blocked, rather than instead of investigating, is not measured. The tool description and the method text say when to ask; an eval for over-asking is not written.

For an existing `.env`:

- `TRIAGE_MAX_ASKS_PER_RUN` can be left out; the default (10, raised from 2 on 2026-09-25) applies. `0` leaves the tool unmounted.
- A postgres run store gets `0002_input_requests.sql` on the next start; the folder store needs nothing.

### Model catalog refresh

Flue 2.0.8 pins pi-ai `^0.83.0`, whose bundled catalog has no `gpt-6-*` and no `claude-opus-5-5`, so those specs failed at `resolveModel`. pi-ai's `refreshModels()` only works for providers built with a `fetchModels`, and its built-in `anthropic` and `openai` providers are static.

- `src/model-catalog.ts` rebuilds both providers with `createProvider` and a `fetchModels`, and delegates streaming to the built-in provider. `fetchModels` reads the latest published pi-ai catalog for the provider from jsDelivr (`@earendil-works/pi-ai/dist/providers/data/<provider>.json`, the same generated data pi-ai ships). It keeps only models the installed catalog lacks, on an API the provider already serves, and only the `Model` fields the installed pi-ai reads.
- The extra models are cached in `<TRIAGE_DATA_DIR>/cache/models/<provider>.json`. `src/models.ts` registers them at import, without a network call.
- `bootRuntime()` refreshes once before `start()` when a configured anthropic/openai model is not found (`src/model-refresh.ts`). A failed refresh goes to stderr and does not block the start. `triage models refresh [--provider] [--json]` does the same ahead of time. The doctor `models` check refreshes the same way before its rows, reports each refreshed provider in its own row, and fails a slot whose anthropic/openai model is still unknown. When every model is found it makes no network call, as before.

Rejected:

- Bumping pi-ai to 0.87: Flue's `^0.83.0` would install a second copy, and Flue resolves models through its own copy.
- The providers' own `/v1/models` endpoints: they need the API key and return ids only, with no image input, cost, context window or thinking levels.
- models.dev directly: pi-ai generates its catalog from it but adds compat flags and thinking-level maps that the stream code depends on.

Assumption: the 0.83 stream code for `openai-responses` and `anthropic-messages` handles the newer models, because the refresh only adds models on those APIs. Checked for catalog resolution only (gpt-6-sol, gpt-6-astra, gpt-6-luna, claude-opus-5-5 resolve with image input); no model was called.

### Verdicts, stop and the step log (D54, 2026-09-26)

| Change | Decision |
|---|---|
| Feedback at any phase, with `notes`, per-finding verdicts, the run's `phase`, `submission_seq`, `report_seq` and `cancelled`; `accept`/`reject` on the CLI; finding ids from `src/report/finding-refs.ts`, listed as `findings` on `GET /triage/:run_id` | D54 |
| `stopped` phase and status; `RunStore.markStopped`; `setPhase` returns false on a stopped run unless `resume` is set; `putInputRequest` refuses a stopped run; the input resolution `cancelled` | D54 |
| `stopRun` (`src/ingress/stop.ts`), `triage stop`, `POST /triage/:run_id/stop`; the pipeline's stop watcher; `triage wait` and `triage run` exit 5 on a stopped run | D54 |
| `src/runlog/` (the event log, its reader and summaries), installed by `bootRuntime`; `triage logs`, `GET /triage/:run_id/events` | D54 |
| Console: the Accept or reject panel with per-finding ticks and Cancel, the Steps panel and tab, the stopped view | D54 |

No migration: feedback rows keep the whole record in `body`, and `phase` is text. Shared edits: `src/runstore/types.ts` (phase, schemas, the store interface), `src/types/input-request.ts`, `src/cli/lib/output-schemas.ts`, the coding-agent skill.

Checked in mock mode on 2026-09-26: typecheck; `bun run test` 5032 pass, 2 fail (the two `.env.example` checks that already failed before this change: `TRIAGE_UI_DEV_PORT` is missing from `evals/home/.env.example`, and the `TRIAGE_MAX_ASKS_PER_RUN` default shown in `.env.example` differs from `keys.ts`); `bun run test:web` 78 pass; `bun run test:contract` 169 pass, including a check that a scripted run's `events.jsonl` holds the pipeline lines and the root's and delegate's Flue events; `bun run build`. The console was also driven by hand against the real server on an eval home with the fake model: Cancel on a run whose delegate was waiting stopped it within a second (Flue aborted the delegate, the submission settled `aborted`, the pipeline's `failed` write was refused and the run stayed `stopped`), and a reject with notes and two finding ticks was stored with the finding text.

Assumptions made, not verified against a real system:

- A stop from a process other than the one running the run reaches it. The HTTP route aborts through the server's own runtime, which was checked. `triage stop` from a second shell against a detached worker was not run. It relies on Flue 2.0.8 checking `abortRequestedAt` for live submissions on its lease scans (`enforceLiveAttemptDeadline` in `@flue/runtime`), and on the worker's own 2 s store check as a second path.
- `triage stop` starts a Flue runtime to record the abort, like `triage run` does. While it is up, its coordinator can pick up other submissions whose lease has expired.
- The folder store's stopped check is serialised per process only. A phase write from the worker that reads `meta.json` just before the stop writes it can still land after the stop. The Flue abort then settles the run as failed, with the Cancel verdict recorded. Postgres does the check in the `UPDATE`, so it does not have this gap.
- A long run's log size is not measured. A small scripted run wrote 72 lines and 132 KB, 43 KB of it the first turn's system prompt and tools. Nothing rotates or caps the file.

Known gaps:

- With the Postgres run store, `triage runs delete` and retention remove the run from the database but leave `<TRIAGE_RUNS_DIR>/<run_id>/` with `events.jsonl` (as they already leave `audit.jsonl`). The folder store removes the whole folder.
- The persisted profile masks digit runs inside ids, so tool call ids read like `tool:****1584:...` in the log. They still match between a `tool_start` and its `tool`.
- A verdict given before the report has no eval draft; a later report does not create one for it. The next verdict on the finished run does.
- The Steps panel reads the whole file on every poll.

### Blocked runs and resume (D55, 2026-09-26)

| Change | Decision |
|---|---|
| `blocked` phase (not terminal) and status; `block` and `block_history` on the run, `RunStore.putBlock` and `resolveBlock`; `markStopped` closes an open block as `cancelled`; a submission of kind `resume` with `block_id` and `note`; migration `0003_blocks.sql` | D55 |
| `src/tools/_lib/connector-failures.ts`: the tool pipeline records every "did not answer" outcome per run (system, tool, code, time); `stop_blocked` on the Triage root, checked against that record, refused while a question or block is open, egress check with refuse semantics on the reason; the finish check treats it as a valid end; one instruction line | D55 |
| `resumeRun` and `resumeRefusal` (`src/ingress/submit.ts`), the `triage.resume` signal (`renderResume`), settle status `blocked` with nothing embedded, `blocked` and `resume` lines in the step log | D55 |
| `triage resume <run_id> [message]`; `triage ask` refuses a blocked run; `status`, `wait` and `run` show the block, exit 6 (`EXIT_BLOCKED`); `triage logs --follow` settles on blocked | D55 |
| `POST /triage/:run_id/resume` (202, 404, 400, 409 with the phase and a hint); `POST .../ask` answers 409 on a blocked run; `block` and `block_history` on `GET /triage/:run_id`; list status `blocked` | D55 |
| Console: the blocked view with the block panel and the Resume form (name, multi-line message), the same form on the failed and stopped views when the run has a submission, earlier blocks, a `waiting` step state | D55 |
| `test/contract/agents/blocked.contract.ts`: park, resume on the same conversation, a refused stop, a failed-after-dispatch resume, with the fake model | D55 |

A Postgres run store gets `0003_blocks.sql` on the next start; the folder store needs nothing. Shared edits: `src/runstore/types.ts`, `src/types/block.ts` (new), `src/cli/lib/output-schemas.ts`, `src/ingress/http/run-list.ts`, `src/ingress/worker-payload.ts`, the console enums.

Built as a workflow, one agent per subject (store; tools and ingress; CLI, HTTP, console and the contract test), after the shared edits. Checked in mock mode on 2026-09-26: typecheck clean; `bun run test` 5144 pass; `bun run test:web` 88 pass; `bun run test:contract` 173 pass; `bun run ci` all steps passed.

Deviations from the spec, kept:

- `triage resume` does not write phase `dispatched` after the spawn, unlike `triage ask`: `resumeRun` refuses every non-blocked, non-terminal phase, so the worker would refuse the run the CLI had just marked. The worker records its pid while keeping the phase and reason, and the command polls the store (250 ms, 30 s cap) until the worker has taken the run over, so a `triage wait` right after never sees the old state. It exits 1 if the worker dies first. The worker also pre-checks `resumeRefusal` before it writes, so two resumes started within seconds cannot clobber each other.
- `resumeRun` closes an open block whenever one exists, not only in phase `blocked`, so a run that failed right after `stop_blocked` stored its record is not wedged. A stopped run with no submission is refused like a failed one.
- The resume message (`note` in the store and the API, up to 4,000 characters, multi-line) is a positional argument on the CLI and a text box on the console; the signal shows it as "Message from <person>" and tells the model to take it into account.
- Console: Cancel stays available on a blocked run; follow-up polling stops once the newer submission exists and the run is no longer running; a blocked run that already has a report keeps the report view with the block panel on top.
- The contract test records the connector failure itself: in mock mode the resolver answers from fixtures or reports a miss and cannot raise a connector error.

Assumptions made, not verified against a real system:

- The per-run failure record lives in the process that ran the tools. After a crash, a run recovered by another process has no record, so `stop_blocked` is refused there and the model finishes with gaps, as before D55.
- A resume into a system that is still down blocks again on the next "did not answer"; nothing probes the system first. D56 brings the SSFB tunnel back before a resume; the databases themselves are still not probed.
- `stop_blocked` is only as good as the model's judgement of "cannot go on"; the recorded-failure check stops it from citing a system that answered, not from blocking on one that did not matter.

Known gaps:

- No deadline for a blocked run (as for questions, D53).
- The Ollama keyless auth in `src/models.ts` resolved to an empty credential, so a run on an `ollama/*` tier failed at the first model call (`No API key for provider: ollama`, seen on 2026-09-25). Fixed on 2026-09-26: the provider now resolves to the placeholder key `ollama`, which Ollama ignores. Later the same day: the provider sends `OLLAMA_API_KEY` when it is set, for an Ollama behind a proxy that checks the key, and falls back to the placeholder when it is blank.

### Postgres connection loss and the resume tunnel check (D56, 2026-09-26)

- The crash: pg-pool takes its `error` listener off a client at checkout and puts it back at release, and pg emits `error` on the client, as well as rejecting the query, when the socket closes under a query. Both manual checkouts in the app (`transaction()` in `src/db/pg.ts`, `execute()` in `src/connectors/sql/pg-client.ts`) had no listener, so Node ended the process with `Unhandled 'error' event`. `pool.query()` was never exposed: pg-pool adds a listener of its own for those calls.
- The fix: a listener for the life of each checkout, removed just before release; the client is released with the error so the pool discards it; the connector sends no ROLLBACK on a dead socket. The test fakes are EventEmitters and raise the event from a macrotask, the way pg does, so the new tests hang and fail without the fix.
- Resume: `runTunnelPreflight` (the tunnel step only, local mode) runs in `resumeRun` before the block is closed, and in `triage resume` before the worker starts. A tunnel warning refuses with `ResumeNotReadyError`, handled wherever `RunNotResumableError` is (worker: exit 1, run left as it was; HTTP: 409 with the hint).
- Left as they were: no probe of the databases before a resume. Retries came next (D57).

### Retries on a lost connection (D57, 2026-09-26)

- `src/db/pg-retry.ts` holds the policy, the classifier and the wait; `src/db/pg.ts` and `src/connectors/sql/pg-client.ts` use it. The runner now checks clients out itself for single statements too, so a connect that failed can be told from a statement that failed; pg-pool's own `query()` gave one error for both.
- Keys: `TRIAGE_DB_RETRY_ATTEMPTS` / `_DELAY_MS` / `_MAX_DELAY_MS` (store, postgres only; defaults 100, 1000, 5000) and `TRIAGE_SQL_RETRY_*` (entity databases; defaults 20, 1000, 5000). The wait is exponential from DELAY_MS, capped at MAX_DELAY_MS, with jitter from the upper half of the range; tests pass a constant `random`. `createPgRunner` retries only when given a policy; `getSharedPgRunner` passes `config.db.retry`. The doctor passes `NO_RETRY`.
- The reconnect hook is wired in `realConnectors` (src/agents/triage-plan.ts): for `ssfb` it runs `runTunnelPreflight` with a real ExecRunner and probe; other entities have nothing to redo. `onRetry` writes `sql_retry` to the run's event log.
- Tests drive the fakes with a fake sleep, so no test waits; the fakes count refused connects and dropped clients.
- Not done: retries in the HTTP and Quickwit connectors; a probe of the databases before a resume.

### Decision model classifier (D58, 2026-09-26)

- `src/classify/decision.ts` builds the questions from the categories file and the enabled entities and maps the answers back to a `Classification`, checked with `ClassificationSchema`. `src/classify/classify.ts` picks the path with `decisionRoute()` from `src/decisions/registry.ts`; `deps.decisions` lets tests pass `fakeDecisionProvider`.
- `src/classify/prompt.ts` shares its redaction between the text prompt and `buildDecisionState()`, the JSON state sent to the decision model. `PERSISTED_PROFILE_PROVIDERS` covers `openrouter` and `typesafe`. The `LATEST` tag on thread lines is gone; it only served `current_ask`.
- `src/models.ts` accepts `typesafe/<model>` for `MODEL_CLASSIFIER` only; the doctor checks `TYPESAFE_API_KEY` for it. `src/ingress/http/routes.ts` and `src/embed/case-text.ts` read `current_ask` from the report only.
- The classifier eval provider builds the decision provider itself and meters the reported cost through `CostMeter.addUsd`. The `current_ask` rubric is gone from the classifier suite; `--judge` stays, with no case using it yet.
- `OPENAI_BASE_URL` is declared in `keys.ts`; nothing reads it yet.
- Tests use the fake decision provider, and the route tests stub `fetch`, so no test calls TypeSafe or OpenRouter.
- Not done: a classifier eval run against a real jev model (question wording, the one-call subcategory and the derived confidence are untried); an eval case that runs the decision path; a separate time limit for decision models.

### Run usage and cost (D59, 2026-09-26)

| Change | Decision |
|---|---|
| `src/types/usage.ts`: `UsageRowSchema`, `SubmissionUsageSchema`, `RunUsageViewSchema`, the model and agent patterns | D59 |
| `src/usage/price.ts`: `priceUsage` and `EMBEDDING_PRICES`; `usageCostUsd` moved here from `src/evals/cost.ts`, which re-exports it | D59 |
| `src/usage/meter.ts`: the meter, installed by `startOnce` in `src/ingress/runtime.ts` (`BootOptions.usageMeter: false` turns it off in tests); `src/usage/summary.ts`: `summariseUsage` | D59 |
| `RunStore.putUsage`, `RunRecord.usage`, `RunSummary.usd_total` / `tokens_total` / `usd_partial`; migration `0004_run_usage.sql`; `usage/<seq>.json` in the folder store; `checkUsage` in `src/runstore/types.ts` | D59 |
| `src/classify/classify.ts`: `ClassifyDeps.onUsage` on both paths; `src/embed`: `onUsage` on `embed()` with the provider's token count | D59 |
| `src/ingress/submit.ts`: seq 0 at intake, the live flush, the settle writes, the embed rows; new key `TRIAGE_USAGE_FLUSH_MS` | D59 |
| `finish_report` sums the meter's rows; the tripwire no longer counts usage; `report.cost` and the `report.md` Cost section gain cache, USD and partial columns | D59 |
| `GET /triage/:run_id` carries `usage`; the web usage panel, the Submissions table's Cost column and the runs list's Cost column | D59 |
| `triage usage`; usage in `triage status`, `wait` and `run`; `tokens` in `runs reembed` | D59 |
| Eval drafts and promoted eval cases carry no `cost` (`draftReport` in `src/report/feedback.ts`, `dropDraftCost` in `src/mock/promote.ts`) | D59 |
| `test/contract/usage-attribution.contract.ts`: records the Flue events of one faux run with a delegate and the strong synthesis | D59 |

A Postgres run store gets `0004_run_usage.sql` on the next start; the folder store needs nothing. Runs from before the change show `not recorded`.

What Flue 2.0.8 puts on its events (checked in `@flue/runtime` dist and by the contract test):

- `createFlueContext`'s `createEvent` stamps `instanceId` (the run id), `submissionId`, `agentName`, `v`, `eventIndex` and `timestamp` on every event. The harness adds `harness`; `Session.emit` adds `conversationId`, `session`, `operationId` and `turnId`.
- Every turn carries the dispatch receipt's `submissionId`. A follow-up dispatch on the same run gets a new one, and all its turns carry it. So the per-run current seq and the HTTP 409 on ask while running, planned as a fallback, were not built.
- `task_start` carries the delegate's name (`agent`) and a `taskId`. The delegate's turns carry that `taskId`, session `task:default:<taskId>` and parent session `default`.
- The strong synthesis turn has harness `default`, session `default` and agent name `triage`, the same as a root turn, and no `taskId`. It runs as its own `prompt` operation that starts while the root operation is still open; the root's `operation` end event comes after it. The meter uses that. Its `operation` end event carries usage equal to the sum of its turns.
- A `finish_required` continuation stays inside the root operation and is charged to `triage`.
- `useAgentFinish` (and `settleRun`) runs before `agent.read(receipt)` resolves, and `submission_settled` arrives before it too; no turn comes after it. So the settle write sees every turn.
- Faux turns report `cacheWrite` equal to input on the first turn and `cacheRead` on later ones, with `cost.total` 0.
- Flue's `PromptUsage` has no `cacheWrite1h`.

Embedding prices (`EMBEDDING_PRICES`, USD per million input tokens): `openai/text-embedding-3-small` 0.02, `openai/text-embedding-3-large` 0.13, `openai/text-embedding-ada-002` 0.10, from https://developers.openai.com/api/docs/pricing (standard tier), read 2026-09-26. pi-ai 0.83.0 has no embedding models in its anthropic (15) or openai (41) catalogs. Ollama is $0. Another OpenAI embedding model is unpriced.

Deviations from the plan, kept:

- Synthesis is found by the nested prompt operation, not by an envelope field or a marker in `synthesis.ts`, which is unchanged. The meter reads `operation_start`, `operation` and `submission_settled` for that structure and to clear it, but never adds their usage.
- A classifier on a decision model takes the cost the provider reports (plan 3.5a); the plan's 3.2 had said decision costs would be ignored. `priceUsage` returns null for those specs, and the intake code passes the reported cost, or null.
- When `decide()` refuses the answers, the provider has already returned usage, so that failed call keeps its real tokens and reported cost. Other failures after the request was sent record one failed call with 0 tokens. A timeout or abort counts as a failed call on the decision path and is not counted on the completion path, where no message exists.
- `summariseUsage` takes `{ running }` instead of a run status. The CLI passes `status === 'running'` from `runStatusOf`, which is already false for a dead worker; the HTTP route passes the same rule through a new `isAlive` dependency, wired to `pidAlive`. The server now imports `pidAlive` from `src/cli/commands/status.command.ts`.
- The runs list gained `usd_partial`, so it can mark a partly priced total.
- The store refuses a count above 2,147,483,647, the same (model, agent, purpose) twice in one call, and a non-finite `usd` (the schema has `v.finite()`). It reads rows with `COLLATE "C"` so Postgres and the folder store give the same order.
- `TRIAGE_USAGE_FLUSH_MS` has a maximum of 3,600,000; a larger value would overflow `setInterval`, which Node then runs every 1 ms. `keys.ts` has min 0, and `env.ts` refuses 1 to 1999. The flush timer is injected (`SettleDeps.usageFlushTimer`) instead of a clock.
- Mock-mode embed rows are recorded as `faux/hash-embed` (the plan said only "marked fake"), so the run shows as fake. `EmbedUsage` has an optional `usageMissing`, so a missing count can be logged apart from a real 0.
- `finish_report` no longer prices: `defaultPricing`, `PricingLookup`, `ModelPricing` and `FinishReportOptions.pricing` are gone, and `computeCost` is synchronous. The gap reads "cost is partial: no pricing for X; the total leaves it out". The null-cost line in `report.md` now reads "Not costed: no token usage was recorded for this run."
- `triage wait`'s live stderr line adds `(partial)` when pricing is partial and shows `unknown` when nothing is priced. `runs reembed` counts tokens by wrapping the embedder in the command; `embed-run.ts` only passes `onUsage` through.
- The web `UsagePanel` takes `running` and `now` as well, for "waiting for the first count" and the "updated Ns ago" ticker. The completed view without a report gained a side column for it.
- New run event types: `usage_write_failed {submission_seq, final, error}`, `usage_flush_failed {submission_seq, error}`, `usage_unassigned {rows, calls, tokens}`, `usage_missing {submission_seq, agent, calls}`. All carry counts and class names only.

Assumptions made, not verified against a real system:

- The OpenAI (`usage.prompt_tokens`) and Ollama (`prompt_eval_count`) token fields are present in real responses. The test fixtures follow the documented shapes; they were not recorded from live calls.
- `report.cost` covers every submission in memory when `finish_report` runs, which can be two when an HTTP ask lands on a running run. Only the eval driver reads it; the store rows stay exact per submission.

Known gaps:

- A report whose Cost section names a model id with a run of six or more digits (for example `anthropic/claude-haiku-4-5-20251001`) is refused by the `report.md` egress check in `src/report/write.ts`, so the report is never written. This was already true before D59; D59 adds the id to the partial line and to `cost.unpriced_models`. Today's configured specs have no such run. Blanking `cost` in the model-text check (as `run_id` and `env_label` are) would fix it.
- A classifier on the fake decision provider is recorded under its `typesafe/*` spec with `usd` null, so a test or eval run that uses it shows partial pricing and is not marked fake. Production mock mode does not use that provider.
- `droppedUsageEvents()` counts turns the meter could not store (a model or agent the schema refuses, a turn with no request model); nothing logs it yet.

### No foreign keys in the run store (D60, 2026-09-26)

- 2026-09-26: removed every foreign key from the run store, per the owner's rule in `src/runstore/migrations/AGENTS.md`. `0004_run_usage.sql` lost its `REFERENCES`; the new `0005_drop_foreign_keys.sql` drops the rest with a `DO` block over `pg_constraint`; the per-model embedding table DDL has none. `deleteRun` in `postgres.ts` deletes from every table itself; `putFeedback`, `putEmbedding` and `putUsage` check the run under `FOR KEY SHARE`; the feedback and embedding inserts are plain `VALUES` now. `fake-pg.ts` enforces no foreign key and cascades nothing. New contract cases: `deleteRun` clears every kind of row across two embedding models and leaves other runs alone; every write on a deleted run throws `RunNotFoundError`; `putReport` on an unknown run throws `RunNotFoundError`. The folder provider is unchanged.
- A Postgres run store gets `0005_drop_foreign_keys.sql` on the next start. It was checked against fake-pg and the Postgres grammar (libpg-query, including the PL/pgSQL body), not against a live database.

## Commit trailer note

The trailer was pinned in CONVENTIONS.md and plan.json after wave 1 (`74cfcb3`, later `58b12b3`), because implementers had each picked their own model name. Commit T01.3 (`a70343b`) still carries a different co-author line from the rest, and T01.2 (`bb11e37`) was one of the two commits the wave log flagged at the time; on main today only `a70343b` differs. The commits before `58b12b3` also carry a `Claude-Session` line. History was left as is.
