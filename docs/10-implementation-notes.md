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
| `bun run serve` | HTTP server (`node bin/triage-server.mjs`, needs a build and `TRIAGE_HTTP_AUTH_TOKEN`) |
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
| `libpg-query` loads its WASM at import. `bun run build` passes, but running the bundled `dist/` with the SQL gate was not verified, so the WASM file may not be found in the bundle. | T02.1 |
| The postgres run store migrator defaults to `./migrations` next to the module. A bundled build has to pass `migrationsDir`, and nothing in the server boot passes it yet. | T09.3, T09.4, T07.10 |
| CONVENTIONS.md said `bun test ./src ./test ./scripts`; T07.8 added `./integrations`. Fixed with these notes. | T07.8 |
| `evals/promptfoo/*` tests are outside `bun run test`; run them with `bun test ./evals`. `bun run ci` runs the suite itself, not these tests. | T10.7 |
| promptfoo full-Triage suite (`triage evals triage`) is refused as not in v1. | T10.8 |
| HTTP `POST /triage/:run_id/post-to-slack` answers 403, or 501 when enabled; posting is CLI only. | T07.7 |
| just-bash defence-in-depth patches cannot install under bun, so the bun unit tests run the virtual sandbox with it off. Node, where the app runs, has it on. | T06.7 |
| `resources/repos.json` pins carry no `remote`, so `triage repos sync` cannot clone a repo that is not checked out. | T11.4 |
| Decrypted values that the `credential` detector would read as a secret come back as null with a note (about 4 in 10,000). | T05.7 |
| Stored `report.json` can hold a masked run id (question 12). | T08.4 |
| HLD §7 still says libsql and LLD 04 still shows `uid` on `dispatch()`; the tables above are the correction. | T01.1, T07.4 |
| Knowledge notes carry `(unverified: ...)` markers where the sources disagreed or were silent: harbor `/v1/device/register`, whether adminV1 checks `x-customer-id`, IMPS COMPLETED vs SUCCESS, comms tables, cohort (a stub), canopy, RTL logs (a stub), CodeGraph YAML indexing. | T12.4, T12.5, T12.6, T12.7, T12.3 |
| Pattern entries marked `stable: true` only where a note states the cause as fact; the sim-binding entries stay `stable: false` until reviewed. | T12.8 |
| `test/server/triage-server.test.ts` skips its "says to build first" case when `dist/server.mjs` exists. | T07.10 |

## Commit trailer note

The trailer was pinned in CONVENTIONS.md and plan.json after wave 1 (`74cfcb3`, later `58b12b3`), because implementers had each picked their own model name. Commit T01.3 (`a70343b`) still carries a different co-author line from the rest, and T01.2 (`bb11e37`) was one of the two commits the wave log flagged at the time; on main today only `a70343b` differs. The commits before `58b12b3` also carry a `Claude-Session` line. History was left as is.
