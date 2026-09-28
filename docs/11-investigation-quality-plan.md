# 11. Investigation quality plan

Status: in implementation from 2026-09-28 on branch `feat/investigation-quality`, one wave
at a time. Decisions D73 to D81, D83 to D85 and D92 are reserved for the choices below (D82 is
Braintrust tracing; D86 to D91 are proposed by the trace 6d4d fix plan); each is written into
`docs/05-decisions.md` when its wave lands.

## 1. Why this plan exists

Two runs on the same SIM-verification ticket ended **Inconclusive**:

| Run | Tier | Tool calls | Cost | Why it stopped |
|---|---|---|---|---|
| `01M3DWB315N8CX9A9P1709CCDG` | strong | 120 (limit hit) | $1.23 | Out of tool calls before the follow-up that mattered |
| `01M3DZKZKYS4YYQEHS5BB2VQYA` | mid | ~125 | $1.36 | Never found the user's device, so no attempts were found |

The same ticket, investigated by hand with the older workspace, found the answer in about 53
tool calls: the user tried SIM binding 17 times from one device, every attempt stayed
`PENDING`, and no SMS ever reached the vendor or guardian. The second run was rejected with
that expectation (`triage feedback`, eval draft in
`evals/_unreviewed/01M3DZKZKYS4YYQEHS5BB2VQYA`).

The gap is not the model. It is config, tool shape, method and knowledge:

| # | Cause | Evidence |
|---|---|---|
| C1 | RTL log service names are wrong (`workflow-op` instead of `workflow-op-service`), so every RTL log search returned 0 hits | `resources/rtl.entity.json:8`; a search for the word "workflow" since 09-07 returned 0 |
| C2 | `logs_search` always adds `service:<name>`, so a wrong name cannot be spotted and one request cannot be followed across services in one call | `src/gate/quickwit.ts:102` |
| C3 | No path from user id to device id; the guardian skill only offers the `refresh_tokens.subject` join, which is empty for users who never verified | `knowledge/ssfb-guardian/SKILL.md:100-106` |
| C4 | Expected empty results were read as problems (harbor has no form until SIM binding is VERIFIED) | report gaps and engineering actions of run 2 |
| C5 | `timestamp without time zone` and `date` are read as local time (IST on a laptop), so RTL times come out 5h30 early | `pg-types` registers 1082, 1114 and 1184 with `parseDate`; `src/connectors/sql/pg-client.ts:128` uses the defaults |
| C6 | The method fixes the order admin API → DB → logs → code, and `http_call` offers services whose URL is blank | `knowledge/method/investigator.md:18-45`; 6 `not_configured` calls in run 2 |
| C7 | Deep investigators repeat the first investigators' queries; the brief carries conclusions, not what was tried | run 2 briefs; same UUID searches and schema lookups repeated |
| C8 | Log text is guessed ("SIM", "workflow", "submission") instead of taken from code | 39 log searches in run 2, most with 0 hits |
| C9 | The default 7-day window misses the start of the story (attempts began 19 days before the run) | `TRIAGE_DEFAULT_LOOKBACK_DAYS=7` |
| C10 | Local code calls count against the same 120-call limit as production reads | run 1: 56 of 120 were `repo_grep`/`repo_read`/`code_explore` |
| C11 | Code navigation lacks find/tree/ls; a guessed file path failed, and route hunting took 6 greps | run 1 |
| C12 | Knowledge ported from the Shivalik workspace on 09-23 is a snapshot; the device-path and service-name notes written there on 09-25 never reached triage-app | `sources:` lines in `knowledge/*/SKILL.md` |
| C13 | Correlation ids (`x_req_id`, `x_txn_id`) are in the skills but were used in 0 of 112 log searches across all runs | run event logs |
| C14 | Past cases do not help: `TRIAGE_PRIOR_CASES=false`, and when on, the projection strips free text, so a lesson like "correlate by device id" would not carry | `docs/05-decisions.md` (prior cases rule) |
| C15 | Report: 16 gaps with repeats; on a strong-tier run, fired escalation reasons are not recorded; `triage status` shows "completed" without the verdict | run 1 and run 2 reports; `src/tools/finish-report.tool.ts:410` |

## 2. What other teams do

Short notes from published work, and what each means for us.

| Source | What they do | What we take |
|---|---|---|
| Datadog, [How we built Bits AI SRE](https://www.datadoghq.com/blog/building-bits-ai-sre/) | Hypothesis-driven loop: form a hypothesis, run targeted queries to confirm or reject it, go deeper on the ones that hold. Early versions that queried "all the telemetry at once" were misled by unrelated signals. They reference past investigations of the same monitor, and grade on real incidents labelled by responders with an LLM judge. | Method is hypothesis-first with targeted queries (W7). Past investigations feed later runs (W14). Grade on real, labelled cases (section 5). |
| Microsoft, [RCACopilot (EuroSys 2024)](https://arxiv.org/pdf/2305.15778) | Per-incident-type "handlers" collect the diagnostic data first; then the LLM predicts the root cause with an explanation. Retrieval of similar past incidents weights recency (93.8% of repeats happen within 20 days). | A "handler" per known pattern: for SIM-binding stuck, the first queries are fixed (W13). Past-case retrieval (W14). |
| Meta, [Leveraging AI for efficient incident response](https://engineering.fb.com/2024/06/24/data-infrastructure/leveraging-ai-for-efficient-incident-response/) | Heuristics (ownership, code graph) cut the search space before the LLM ranks; 42% top-5 accuracy; they refuse low-confidence answers because wrong ones mislead engineers. | Cheap narrowing first (ids, pivots, code). Keep the honest "inconclusive" when evidence is weak; the fix is better evidence, not bolder claims. |
| Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Pagination, range selection, filtering and truncation with sensible defaults; tool descriptions are the main lever; error messages should steer the next call; many small targeted searches beat one broad one. | `logs_search` paging and filters (W4); zero-hit results that say what to try next (W4); tool descriptions updated with the change (all waves). |
| Anthropic, [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Just-in-time context: keep light references (paths, stored queries) and load on demand; agentic search with grep/glob/ls; notes kept outside the context window; subagents return condensed summaries. | find/tree/ls (W10); repo AGENTS.md loaded on demand (W11); a run-level action log outside the model's context (W8). |
| Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Each subagent needs an objective, output format, tool guidance and clear boundaries; vague briefs cause duplicate work and gaps. | Briefs carry the queries already tried and what they returned (W8). |
| Claude Code, [memory docs](https://code.claude.com/docs/en/memory) | Nested `CLAUDE.md` files load on demand when a file in that subtree is read; reading a file loads every `CLAUDE.md` between the root and the file, not the ones below. | Same rule for repo AGENTS.md/CLAUDE.md in W11. |
| [AGENTS.md](https://agents.md/) standard | Nested files; the one closest to the touched file wins; root sets defaults. | Attach root to leaf, in that order, so the nearest file is read last (W11). |
| Honeycomb, [Hard stuff nobody talks about](https://www.honeycomb.io/blog/hard-stuff-nobody-talks-about-llm) | Query generation works only with the real schema in context; guessing field names fails. | Service and field names come from real hits (service discovery, W4); column lists in skills (W13). |
| OpenTelemetry / [W3C Trace Context](https://www.dash0.com/knowledge/w3c-trace-context-traceparent-tracestate) | One trace id propagated across every hop; logs carry it, so one query pulls the whole request. Copying an arbitrary correlation id is weaker than real propagation. | Follow `x_req_id`/`x_txn_id` across services in one query (W5), but keep the existing warning that ours are reused, so walk by time. |
| node-postgres, [issue #1071](https://github.com/brianc/node-postgres/issues/1071) | `timestamp without time zone` is parsed as local time; the fix is a type parser (return the string, or parse as UTC). | Per-pool type parsers, no `TZ=UTC` (W1). |
| PagerDuty, [SRE agent with memory](https://www.pagerduty.com/blog/ai/we-built-an-sre-agent-with-memory-and-its-transforming-incident-response/); [Cleric](https://cleric.ai/resources/reports/the-state-of-ai-sre); [Resolve AI](https://resolve.ai/product/ai-sre) | Every resolved incident becomes reusable knowledge (runbooks, patterns, service maps). | Reviewed feedback (actual root cause, faster path) becomes pattern notes (W14). |

Principles for this plan, taken from the above:

1. Start with a hypothesis and the cheapest targeted evidence (logs and DB), not a fixed ladder.
2. When a lookup is empty, find out why (code) and pick a new key. Do not repeat the same key.
3. Names (services, fields, log messages, columns) come from real data or code, never from a guess.
4. Tools page, filter and explain. A zero-hit result tells the model what to try next.
5. Context is loaded when needed (repo docs, skills), and what was already done is written down outside the model's context and handed to every agent.
6. Every reviewed case teaches the next run.

## 3. Scope

In scope: the changes below, their tests, the mock-mode eval for the SIM case, and the
decisions they need.

Not in scope: new entities, write actions, Slack or web changes, real calls during
development or evals (mock mode only, `TRIAGE_MOCK_MODE=true`), and any change to the
Shivalik workspace itself.

## 4. Work items

Each item lists the problem it fixes, the change, the files, the decision, the tests and
when it is done.

### Wave 1: correctness and config

#### W1. Read timestamps and dates as stored (fixes C5, D73)

- **Change.** Pass a `types` override on the pool config in `defaultPgFactory`
  (`src/connectors/sql/pg-client.ts:128`); pg 8.23 supports per-client `types`, so global
  `pg.types` stays untouched.
  - 1114 (`timestamp`): return the string as stored. When the service's registry entry says
    its naive timestamps are UTC (new optional field `naive_timestamp_zone`, default `UTC`),
    return ISO with `Z`; for any other zone, return the stored string plus the zone name.
  - 1082 (`date`): return `YYYY-MM-DD` as stored. Today it becomes the previous day at 18:30Z
    on an IST machine.
  - 1184 (`timestamptz`): unchanged.
  - No `TZ=UTC` in scripts or the server.
- **Verify during the fix.** Confirm on a fixture that 1082 shifts today (it is registered
  with `parseDate` in `pg-types/lib/textParsers.js:174`), and list every column of these types
  in the key tables of each service (from the skills' column lists) so we know which reads were
  affected.
- **Files.** `src/connectors/sql/pg-client.ts`, `src/config/registry.ts` (schema),
  `resources/*.entity.json`, `src/connectors/sql/pg-fake.ts`.
- **Tests.** Fake pool returns `2026-09-07 10:03:57.437` for 1114 and `2026-09-07` for 1082;
  output is `2026-09-07T10:03:57.437Z` and `2026-09-07` whatever `process.env.TZ` is (run the
  test under `TZ=Asia/Kolkata` and `TZ=UTC`).
- **Done when.** Replaying run 2's RTL rows gives Part 1 completion at 10:03:57Z.

#### W2. Correct RTL log service names (fixes C1, D74)

- **Change.** `resources/rtl.entity.json`: `workflow-op` → `workflow-op-service`; add
  `app-server-service` (device id and app headers) and `verification-service`.
  `banking-service` returned 0 for this user in both workspaces; keep it, and mark it
  unverified until service discovery (W4) confirms the real name.
  Add `user-vault-service` too (Q1). Its lines carry phone, name and date of birth, so the
  RTL logs note says never to quote them; the persisted redaction profile masks them in stored
  output.
- **Files.** `resources/rtl.entity.json`, `knowledge/method/logs-rtl.md`.
- **Tests.** Registry test: every RTL `quickwit_service` ends in `-service`; logs-rtl note
  lists the same names as the registry.
- **Done when.** A mock-mode replay of run 2's RTL searches uses the new names.

#### W3. Offer only configured admin APIs (fixes part of C6, D75)

- **Change.** In real mode, when `http_call` is built, drop services whose API URL or auth
  token is blank (mock and eval homes keep every service, because their URLs are always blank
  and the scope and budget contracts probe `http_call`; see D75) from the `service` picklist and from the description. If an entity has none,
  do not mount `http_call` for it. Keep the `not_configured` answer as a second check.
- **Files.** `src/tools/http-call.tool.ts:81-110`, `src/tools/index.ts` (mount rule).
- **Tests.** RTL with all three URLs blank: no `http_call` on RTL investigators. SSFB with
  guardian URL blank: `guardian` not in the picklist.
- **Done when.** Run 2's six `not_configured` calls cannot happen.

### Wave 2: log search

#### W4. Give `logs_search` the options `search.py` has (fixes C2, C8, C9, D76)

- **Inputs** (new or changed):
  - `service`: optional. With no service, the query searches the whole index. A
    selective filter is still required (terms, fields, message or error), and the id scope
    rule still applies.
  - `terms`: bare words ANDed over the whole document. This is the default way to start.
  - `message`: the exact label from the code, sent as a single-quoted string
    (`'Api execution completed'`), which is the form the owner confirmed works in `qw` and
    Grafana. The old double-quoted field phrase (`message:"…"`) is what RTL rejected with HTTP
    400, so it goes.
  - `exclude`: strings that must not appear. Built as `NOT 't1' AND NOT 't2'`, never
    `NOT ('t1' AND 't2')`, which does not work.
  - `error`: unchanged (words ANDed).
  - `fields`, `level` (`level: "error"` for error-only), `group_by`, `count`, `normalize`:
    unchanged, and `group_by: "service"` is allowed so service names can be discovered.
  - `query`: not added. A raw query fragment would bypass escaping and the scope rule.
  - `offset`: paging. Each call returns one page of 250 hits (`qw --max-hits 250 --offset N`,
    sorted with `--sort-by timestamp`), also staged to a file. The result carries `num_hits`,
    `offset`, `next_offset` (absent on the last page) and the staged file. The tool never
    fetches the next page by itself; the model decides whether another page, a narrower query
    or a `count`/`group_by` is worth it.
  - **Too many hits.** When `num_hits` is over 5,000, the call returns early with no hits and
    a reason the model reads in the loop, for example: "12,431 hits for this query in
    2026-08-27..2026-09-26, over the 5,000 limit. Narrow the window, add an id or field filter,
    or use count/group_by first." It is an ordinary tool result with the real numbers, not a
    swallowed error (owner rule: every refusal goes back to the model with its reason).
  - **Per-run cap.** At most 50 `logs_search` calls per run (`TRIAGE_MAX_LOG_CALLS_PER_RUN`),
    counted inside the run's tool-call limit. The refusal at the cap says so.
  - `denoise` (SSFB only): wraps the query in the owner's noise filter, which drops kong and
    kafka lines and the `Api execution completed` access lines unless they are errors:
    - `denoise: "with_message"`:
      `((* AND NOT service:'kong'* AND NOT service:'kafka'* AND NOT 'Api execution completed') OR level:error) OR <message>`,
      so the message's own lines are kept even when they come from a filtered service;
    - `denoise: "only"`:
      `((* AND NOT service:'kong'* AND NOT service:'kafka'* AND NOT 'Api execution completed') OR level:error)`;
    - no `denoise`: the message (or terms) alone.
    The skill says to use it on the first SSFB query of an investigation, and, when the error
    could be in kong or kafka, to run a `count` without it first. Other filters (ids, fields,
    window) are ANDed with the whole expression. The 5,000-hit early return keeps a broad
    `only` query safe.
  - Values with a space, a dash or other non-alphanumeric characters (UUIDs, labels, device
    ids): sent whole in single quotes (`'26caff50-d980-4c95-bcc9-fdd3b7fac43f'`), per the
    owner's sample queries. This replaces the first-segment cut and the ANDed-segments idea.
    The quoting rules go into the logs skill (W12) exactly as the owner gave them, including
    the Grafana form next to the `qw` form. Per the owner (Q8), the single-quoted whole value
    is the form for any UUID, on every entity. On RTL and ATSPL a UUID is always searched as
    `'<uuid>'`, never as a field (`customer_id:<uuid>`); the tool refuses the field form for a
    UUID there and says why. On SSFB the exact id fields in its registry allowlist
    (`customer_id`, `form_id`, `x-device-id`, `x-customer-id`) stay available as well, because
    the old refs used them with success; `contains` stays as the fallback after a zero.
  - `--explain` on `qw` calls, so the result shows the query Quickwit actually ran. Not sent
    yet: it waits for one manual run by the owner (section 8).
- **More inputs, from the refs survey (Appendix A).** Each one unblocks a pattern the old
  investigations used and today's tool cannot express:
  - `any_of`: OR groups, for example levels `error` or `warn`, several message labels, several
    id tokens, or several services (`service:a OR service:b`).
  - `contains`: a substring match on `raw_message` (`raw_message:*<value>*`), the fallback that
    finds a full UUID or an id inside a response body when the bare term misses. No spaces; the
    skill says multi-word wildcards return a silent 0.
  - `group_by`: up to four fields (`message,error`; `service,level,message`;
    `iso_country_code,error`), tallied over at most 5,000 hits in one call, with the tally's
    base stated in the result.
  - `count_distinct`: number of distinct values of one field (for "N lines, M customers").
  - `raw: true`: full documents (model-facing redaction applied), for reading CBS response
    bodies, XML payloads and unknown field names.
  - `columns`: extra fields in each hit (`status`, `latency`, `client-ip`, `User-Agent`,
    `path`), for the app-vs-admin split.
  - `order`: `newest` (default) or `oldest`, for timelines and walks.
  - ~~`index`: another index from the entity's registry allowlist~~ Dropped by the owner
    (2026-09-28): RTL and ATSPL already search `core-prod-app-logs` and `envoy-logs`.
  - `fields`: hyphenated names bare (`x-device-id`, `x-customer-id`), and ranges on numeric
    fields (`status_code: "[400 TO 599]"`).
  - Warnings in the result: `error` on workflow-op or kong (the whole line is in `message`);
    a phone search on guardian (redacted); a service name with no hits in the index at all.
  - Status: `unreachable` is a separate result from `0 hits`, so a down Quickwit is never read
    as "not logged". About 14 of the old refs lost log evidence to an unreachable Quickwit.
  - Pacing on SSFB: keep concurrency 1 (single-CPU instance), and never page past the
    instance's 10,000 offset cap.
- **Window.** Every call sends both ends: `--from` and `--to` on `qw`, in UTC (Grafana shows
  the same window in the machine's zone, IST on a laptop; the logs skill says so). Default
  lookback 30 days (`TRIAGE_DEFAULT_LOOKBACK_DAYS=30`); the model narrows it once it knows when
  the journey started. Today the `qw` transport passes `--since` only and drops the upper bound;
  it moves to `--from`/`--to`.
- **Transports.** `qw`: `qw --context <CTX> search <INDEX> '<query>' --sort-by timestamp
  --explain --max-hits 250 --offset <N> --from <UTC> --to <UTC>`. HTTP (SSFB): the equivalent
  search body (`max_hits`, `start_offset`, `start_timestamp`, `end_timestamp`, sort by
  timestamp); check against the Quickwit version SSFB runs and the Shivalik `quickwit-api.md`
  reference that single-quoted values behave the same over HTTP, and note any difference in
  the skill. Confirm every flag on the installed `qw` (`qw search --help`, which reads no data)
  before wiring.
- **Zero hits.** The result says what to try next, in this order: drop the service filter, run
  `group_by: "service"` for the same terms, move `from` earlier, drop `level`. This replaces the
  bare "0 hits".
- **Mock keys.** `semanticKey('logs_search', …)` gains `service?`, `offset`; existing
  fixtures keep matching when `service` is set.
- **Files.** `src/gate/quickwit.ts`, `src/gate/quickwit-window.ts`,
  `src/tools/logs-search.tool.ts`, `src/connectors/quickwit/*`, `src/mock/key.ts`,
  `src/config/keys.ts`, `docs/02-hld-detailed.md` (§ quickwit.ts).
- **Tests.** No service + terms builds a query without `service:`; `service` alone still
  refused; a label and a dashed UUID are sent single-quoted and whole; `exclude` builds
  `NOT 'a' AND NOT 'b'`; `group_by: service` allowed; `qw` argv carries `--sort-by timestamp`,
  `--explain`, `--max-hits 250`, `--offset`, `--from` and `--to`; the page is staged;
  `next_offset` absent on the last page; no automatic second page; over 5,000 hits returns
  early with the count and window in the reason; the 51st call in a run is refused with its
  reason; `denoise` builds the owner's two expressions exactly and is refused outside SSFB; the
  zero-hit note is present; every argv element passes `assertQwSafe`.
- **Done when.** A mock replay of run 2 with a free-form London search returns hits from the
  real service names.

#### W5. Follow one request across services (fixes C13, D77)

- **Change.**
  - Scope rule (D26): a value in a correlation field (`x_req_id`, `x_txn_id`, and the
    hyphenated forms) is in scope when it appeared in an earlier tool result in the same run.
    Other ids keep today's rule. The earlier result is recorded in the run log (W8), so the
    check is exact.
  - Method: when a hit is the right request, pull the whole request with
    `fields: { x_txn_id: … }` and no service filter, then read the lines in time order. Keep
    the existing warning that these ids are reused, so the walk uses a narrow window around
    the hit.
  - How the Shivalik refs use them (14 of 145 refs; counts only, refs hold customer data). In
    every case the id was read from an earlier hit, never given in the ticket, which is the
    rule above:
    - group every line of one request by `x_req_id`, so a cascade of errors collapses to the
      one real error;
    - walk an `x_txn_id` inside a narrow slice (about 20 minutes) back to the anchor line that
      carries the customer's id, because lower-level client lines carry none;
    - `x_txn_id` plus a message filter to fetch one payload line of that request;
    - the same `x_txn_id` on several attempts shows one retried request, not several;
    - list the ids as evidence in the findings;
    - leave out ids produced by the investigation's own admin calls.
- **Files.** `src/gate/scope.ts`, `src/gate/id-patterns.ts`, `knowledge/method/logs.md`,
  `knowledge/method/logs-ssfb.md`.
- **Tests.** A dashed-UUID `x_req_id` seen in an earlier `logs_search` result is allowed; one
  never seen is refused; a non-correlation field with the same value is still refused.

### Wave 3: method and run memory

#### W6. Rewrite the investigation method (fixes C4, C6, C8, D81)

`knowledge/method/investigator.md`, `orchestrator.md`, `brief-template.md`:

- **No fixed ladder.** Start with logs and DB selects, with code navigation (find, grep,
  tree, ls, read) alongside to learn table, field and message names. Use an admin API only for
  live state the DB does not hold, and only if it is mounted. The report keeps recording which
  sources were used, in order.
- **Hypothesis first.** Each step states the hypothesis it tests and what result would reject
  it. Stop a branch when the evidence rejects it.
- **Empty means ask why.** When a lookup by the known id is empty, read the code that writes
  that row or log line to learn when it is written. If it is written only later in the
  journey, the empty result is expected; say so and pick another key (device id, phone,
  verification id, form id). Do not repeat the same key with different wording.
- **Where log text comes from.** A `message` or `error` value must come from the code (grep
  for the logger call), an earlier hit, or a skill. When the text cannot be pinned down (for
  example `err.message` built at runtime), search by the customer's own id with a time window
  (`aspora_user_id` on RTL, `customer_id` or `x-customer-id` on SSFB) and
  `group_by: "message"` to see what the service logged.
- **Window.** Start at 30 days, then set `from` to the start of the relevant journey (for
  example the end of RTL Part 1) once known.
- **Client code.** When the backend is shown to behave correctly and the remaining leg is the
  device, read the app code that sends or receives on that leg.

#### W7. Pattern handlers for known issues (from RCACopilot handlers, D80)

- A known pattern can carry "first queries": the fixed evidence to collect before
  hypothesising. Start with SIM binding stuck (W13). The orchestrator puts the handler's first
  queries into the brief when the classifier or the ids match the pattern.
- **Files.** `knowledge/patterns/patterns.json` (new optional `first_queries`),
  `knowledge/patterns/SKILL.md`, orchestrator method.

#### W8. Run-level action log and repeat cache (fixes C7, D79)

- **Log.** Every tool call in a run (root and all delegates) is appended to a run action log:
  agent, tool, arguments, one-line outcome (rows, hits, status, refusal reason), evidence id
  if any, time. Source: the existing run event stream (`src/runlog`), projected to a compact
  form. Arguments pass the persisted redaction profile before storage.
- **Handed to agents.** Every `task` brief gets the log's compact form for the calls that
  matter to that entity, capped (for example the last 60 lines), plus a tool to read the rest.
  The root sees it too when deciding the next delegation.
- **Exact repeats.** A call whose semantic key (reuse `src/mock/key.ts`) and window match an
  earlier call in the same run returns the earlier result with a note ("already run by
  investigate_ssfb at 04:30:18; result reused") and does not count against the budget. Paging
  calls differ by `offset`, so they are not repeats.
- **Files.** `src/runlog/*`, `src/tools/_lib/pipeline.ts`, `src/agents/triage-plan.ts`,
  `src/agents/delegates/*`, `knowledge/method/brief-template.md`.
- **Tests.** Second identical `sql_select` in a run returns the cached result and a note;
  same query with another window runs; brief contains the prior calls; budget unchanged on a
  cached repeat.

#### W9. Code tools leave the run limit (fixes C10, D78)

- `repo_grep`, `repo_read`, the new find/tree/ls tools and the `code_*` tools stop counting
  toward `TRIAGE_MAX_TOOL_CALLS_PER_RUN`. They get their own loop guard,
  `TRIAGE_MAX_CODE_CALLS_PER_RUN` (default 400, owner's answer to Q4). A cap, not a target:
  the model makes further code or log calls only when the next step needs them.
- **Files.** `src/gate/budget.ts`, `src/tools/code/_lib/code-tool.ts`, `src/config/keys.ts`,
  `.env.example`.
- **Tests.** 120 production reads plus 50 code reads: production refused at 121, code still
  allowed; code refused at its own cap.

### Wave 4: code tools

#### W10. find / tree / ls, and better grep (fixes C11)

- **New tools** (same jail and repo list as `repo_read`):
  - `repo_find`: paths matching a glob, optionally with a name regex; capped, paged.
  - `repo_tree`: directory tree under a path to a depth, with file counts; capped.
  - `repo_ls` could be `repo_tree` with depth 1; one tool is enough if the description says
    so.
- **`repo_grep` options:** `context_lines` (like `-C`, max 5), `files_only` (like `-l`),
  `count_only`.
- **`repo_read`:** keep; its 400-line page is enough once find/tree stop the guessing.
- **Files.** `src/tools/code/*`, `src/tools/code/_lib/grep.ts`, tool index.
- **Tests.** Jail refuses `..` and dot paths; caps and `truncated` flags; `files_only` returns
  unique paths.

#### W11. Attach repo AGENTS.md / CLAUDE.md on demand (D83)

How Flue allows it (checked against the Flue references):

| Option | Verdict |
|---|---|
| Sandbox workspace context (root `AGENTS.md` into the system prompt at start) | Root file only, once; not per path |
| Add text to the agent's system instructions on each render | Changes the system prompt each time, which breaks prompt caching |
| **Attach to the code tool's result** | Chosen |

- **Rule** (as Claude Code and the AGENTS.md standard do): when a code tool touches a path in
  repo R, attach every `AGENTS.md` and `CLAUDE.md` on the directory chain from R's root down to
  that path (root first, nearest last, so the nearest reads last), that this conversation has
  not been sent yet. Never files from sibling or child directories.
  - `repo_read`, `repo_find`, `repo_tree`: the chain of the target path.
  - `repo_grep`: the root file only, plus the list of matched directories that have such
    files, so the model can read them.
- **Once per conversation per file path.** Kept in a `WeakMap` keyed by the `ToolContext`,
  which each delegate render builds new, so each task tracks its own set.
  `usePersistentState` throws in a delegate render, and the root mounts no code tool (D83).
- **Caps.** 8 KB per file and 16 KB per result, with a note when cut. `@imports` inside
  CLAUDE.md are not followed.
- **Result shape.** `repo_docs: [{ path, text, truncated }]` next to the normal data.
- **Size check.** Today: vance-android 9 files (1,178 lines), vance-ios 12 (1,403), audit 10
  (996), rhythm 3 (613), pulse-backend 589 lines, go-commons 466; most repos have 0 or 1.
- **Files.** `src/tools/code/_lib/code-tool.ts`, `src/tools/code/_lib/repo-docs.ts` (new).
- **Tests.** First read under `a/b/` attaches `AGENTS.md`, `a/AGENTS.md`, `a/b/CLAUDE.md` in
  that order; second read in the same conversation attaches nothing; a new delegate gets them
  again; sibling `a/c/AGENTS.md` never attached; caps applied.

### Wave 5: knowledge

#### W12. Port logs-finder and rewrite `rtl/NRI_ONBOARDING.md` for triage-app

- **logs-finder → `knowledge/method/logs*.md`.** Port, in triage-app tool terms:
  - the field model (`message` is the developer's label, `error` is the text users quote,
    workflow-op puts everything in `message`);
  - start free-form (terms, no service), then read one full hit for real service and field
    names;
  - the zero-hit escalation ladder, matching W4's zero-hit note;
  - the owner's Quickwit query notes, kept verbatim with the Grafana form next to the `qw`
    form: single quotes for values with spaces or dashes, `NOT 'a' AND NOT 'b'` for exclusions,
    `--explain`, `--sort-by timestamp`, `--from`/`--to` in UTC (Grafana in local time), and
    paging with `--max-hits 250 --offset 0/250/500`;
  - the SSFB noise filter and when to use each `denoise` form (W4);
  - from the refs survey (Appendix A): the services in `logs-v1`; recurring message labels and
    fields per service (harbor, rhythm, guardian, workflow-op, kong); the zero-hit order the
    old investigations followed; the ten query templates; the traps (tokenizer splits on `_`
    and `.`; redacted guardian fields; paths that log nothing, so a missing label is the
    evidence; CX and admin lookups showing up as the customer's hits, split by `User-Agent`;
    leave out the investigation's own admin calls; retention about 30 days with the oldest day
    partial; search forward to now before stating current state);
  - the 5,000-hit limit and the 50-calls-per-run cap, and what to do when either is hit;
  - correlation ids are reused (existing text), and how to walk them (W5);
  - paging and `group_by` use;
  - per entity: SSFB over HTTP, ATSPL and RTL over `qw`.
- **`rtl/NRI_ONBOARDING.md` → new `knowledge/rtl-nri-onboarding/SKILL.md`** (and trim the
  overlap from `rtl-overview`). Sections:
  1. What RTL owns (Part 1 steps, the `NRI_ONBOARDING_UAE` definition, the terminal step and
     its `next_step` to device binding on SSFB).
  2. Where the data is: RTL workflow DB (`workflow_executions`, `workflow_definitions`,
     `ui_templates`), with column lists and the note that timestamps are naive UTC.
  3. Logs: London index `core-prod-app-logs`, `-service` suffixed names, what each service
     logs (workflow-op-service logs full outbound request and response bodies, including
     personal data and admin tokens: never quote them), how to get the device id.
  4. Handoff to SSFB: what arrives at harbor and guardian, and why an empty harbor result is
     expected before SIM binding succeeds.
  5. Known issues, and the first queries for "stuck after Part 1".
  6. What not to use: RTL admin APIs are not configured in this deployment.
- Written in triage-app tool terms (`logs_search`, `sql_select`, `repo_*`), not Shivalik
  scripts. Lands after W4, because it describes the new `logs_search` inputs.

#### W13. Skill updates (fixes C3, C4, D84)

- `ssfb-guardian`: the device path for users who never verified (id → device id from app
  logs → `device_auth_attempts WHERE device_id`); `PENDING` forever for abandoned attempts;
  guardian logs redact phone numbers, so a phone search in logs means nothing; the inbound SMS
  log trail by exact message; confirmed column list.
- `ssfb-harbor`: `external_user_ref` is written only after VERIFIED; harbor logs only
  `has_data_token`; the poll log messages carry `device_id` and `verification_id`.
- Schema examples in every skill use the multi-table form
  (`WHERE table_name IN ($1, $2, $3)`), and a lookup is needed only when the skill has no
  column list for that table. No generated schema files; the skills' lists are kept current by
  W14's sync and by edits after reviewed cases.
- SIM-binding pattern in `knowledge/patterns/patterns.json` with `first_queries` (W7): device
  attempts, harbor polls, guardian callbacks per attempt window, vendor webhook count, a UAE
  baseline, the 5-per-24h limit, and the note that the app cannot report whether the SMS was
  sent (read `vance-android` `device_binding/` when the backend is clean).
- `frontend-routing`: add "the client cannot report X" as a reason to read app code.
- Each SSFB service skill gets its recurring log labels and fields from Appendix A (for
  example harbor's `checking verification status`, rhythm's `HTTP Response`, guardian's
  `Failed to verify token and create session`), marked as seen in past investigations, so the
  model searches exact labels instead of guessing words.

#### W14. Keep knowledge in step with the Shivalik workspace, and learn from reviewed cases (fixes C12, C14, D85, D92)

- **Sync check, no copies.** `knowledge/sources.lock.json` records, for every `AGENTS.md` and
  `NRI_ONBOARDING.md` under `atspl/`, `rtl/`, `shivalik/` and `frontend/`, the upstream path,
  the SHA-256 of the file and the skills written from it. `bun scripts/check-knowledge-sources.ts`
  compares them with the Shivalik workspace when `TRIAGE_SHIVALIK_DIR` is set, lists changed,
  missing and new files with the skills that port them, and exits non-zero on drift;
  `--update` rewrites the hashes after the skills are updated. CI skips it when the variable
  is unset. Verbatim copies as skill resources were dropped by the owner on 2026-09-28 (D85).
- **Learning from reviewed cases.** When a run is reviewed with `--actual-root-cause` and
  `--faster-path`, `triage fixtures review` offers a pattern note draft (category, trigger,
  first queries, lesson) with ids stripped. An owner accepts it into
  `knowledge/patterns/patterns.json`. This is how a lesson like "correlate by device id"
  reaches later runs; the prior-cases projection strips free text and cannot carry it.
- **A pattern is a lead, not an answer.** The current run can differ from the past case. The
  method (W6) treats a matched pattern as a hypothesis: run its first queries, and drop it when
  this run's evidence does not match. The report says when a pattern was tried and rejected.

### Wave 6: report and status

#### W15. Report and status fixes (fixes C15)

- Merge gaps that say the same thing: normalise and compare, and keep the more specific
  text.
- Record fired escalation reasons on strong-tier runs too (`finish-report.tool.ts:410`), with
  "already on strong" as the action taken.
- `triage status` shows the report verdict (for example "completed · inconclusive") next to
  the phase.
- CX reply: when the evidence supports it, give the user concrete steps; "wait for guidance"
  only when nothing can be said.

## 5. How we know it worked

- **SIM eval case.** From the rejected run's draft, build a mock-mode eval case with
  pseudonymised fixtures (no real data, no real calls): London hits that carry a device id,
  guardian attempt rows keyed by device, harbor polls, guardian callbacks, RTL workflow rows
  with naive timestamps. The expected outcome is the rejected run's expectation.
- **Pass criteria for the SIM case.**
  - Report status is root cause found, confidence medium or high.
  - The report cites device-keyed attempts and says no SMS arrived.
  - RTL Part 1 completion is `2026-09-07T10:03:57Z`.
  - Zero `not_configured` calls; zero exact repeats that ran again.
  - Production tool calls ≤ 60 (code calls not counted).
  - No `message` or `error` value in a log search that did not come from code, a hit or a
    skill (checked from the run log).
- **Regression.** The existing contract and classifier suites pass; every changed tool has
  unit tests; `bun run ci` is green.
- **Real-mode check (by the owner, after merge).** Re-run the same ticket once and compare
  with the expectation. Development and evals stay in mock mode.

## 6. Order of work

```
Wave 1  W1 timestamps · W2 RTL names · W3 configured APIs only       (independent)
Wave 2  W4 logs_search · W5 correlation ids                          (W5 after W4)
Wave 3  W6 method · W7 handlers · W8 run log + repeat cache · W9 code budget
Wave 4  W10 find/tree/grep · W11 repo docs                          (after W9)
Wave 5  W12 logs + RTL note · W13 skills · W14 sources + learning    (after W4, W6, W10)
Wave 6  W15 report and status
Then    SIM eval case, full CI, owner real-mode check
```

Runs as a Workflow, one agent per work item within a wave, shared type edits made inline
first, and verification (typecheck, unit, contract tests, `bun run ci`) by the main session
after each wave. Each approved choice is recorded in `docs/05-decisions.md` with what was
rejected and why.

## 7. Decisions reserved

| Id | Decision | Proposed |
|---|---|---|
| D73 | Naive timestamps and dates | As stored, zone per service, default UTC; no `TZ=UTC` |
| D74 | RTL log names | `-service` suffix; add `app-server-service`, `verification-service` |
| D75 | Admin APIs offered | Configured services only |
| D76 | `logs_search` shape | Optional service, plain-word message, paging, 30-day default, UUID segments ANDed |
| D77 | Correlation ids in scope | When seen in an earlier result of the same run |
| D78 | Code tool budget (W9) | Outside the run limit; own cap |
| D79 | Run action log (W8) | Every call logged, handed to briefs; exact repeats reuse results |
| D80 | Pattern first queries (W7) | A matched pattern's first queries go into the brief as a lead |
| D81 | Method order (W6) | No fixed ladder; logs and DB first; empty → why → new key |
| D83 | Repo docs (W11) | Attached from root to path, once per conversation, capped |
| D84 | Schema lookups (W13) | Skills' column lists first; multi-table lookups; no generated files |
| D85 | Shivalik sources (W14) | Lock of upstream hashes and a drift check; no copies |
| D92 | Learning from reviews (W14) | Faster path → reviewed pattern note |

D82 is Braintrust tracing (on `main`). D86 to D91 are proposed by the trace 6d4d fix plan, so
the next free number after D85 is D92.

## 8. Owner answers (2026-09-26)

| # | Question | Answer |
|---|---|---|
| Q1 | Add `user-vault-service` to RTL? Its logs carry phone, name and date of birth. | Yes (confirmed). Its lines are personal data: the model-facing output keeps the phone (a search key) and the persisted profile masks the rest, as for other sources |
| Q2 | Past cases | Pattern notes (W14). A past case is a hypothesis to test, not an answer: the current run can differ, so a pattern's first queries are checked against this run's evidence before any claim uses them |
| Q3 | Correlation ids in scope when seen earlier in the run | Yes. Checked against the Shivalik refs (W5) |
| Q4 | Page size and caps | 250 hits per page (`--max-hits 250`, and the HTTP equivalent); at most 50 `logs_search` calls per run; over 5,000 hits the call returns early with the reason; always send the time window; 400 code calls. No lookups just because the budget allows them; the model decides each further query |
| Q8 | UUID quoting | Settled: the single-quoted whole UUID (`'<uuid>'`) works for any UUID. On RTL and ATSPL use `'<uuid>'`, never `customer_id:<uuid>`. SSFB keeps its exact id fields too |
| Q7 | SSFB noise | The owner's noise filter as the `denoise` option (W4), used on the first SSFB query; a `count` without it when the error could be in kong or kafka |
| Q5 | UUIDs and other values | Owner's `qw`/Grafana samples: values with spaces or dashes go whole in single quotes; `NOT 'a' AND NOT 'b'` for exclusions; `--explain`; `--sort-by timestamp`; `--from`/`--to` in UTC; paging with `--offset`. Captured in the tool (W4) and the logs skill (W12) |
| Q6 | Time window | Always pass both `--from` and `--to`; enforced in the tool (W4) |

Answers given on 2026-09-28, to the questions left open by wave 2:

| # | Question | Answer |
|---|---|---|
| Q9 | Owner's local `.env` still set `TRIAGE_DEFAULT_LOOKBACK_DAYS=7` | Now 30, changed outside the repo. The method notes point to the run's window rather than a number of days |
| Q10 | `qw --explain` output | Skipped for now. `--explain` stays unsent until the owner runs it by hand; still open |
| Q11 | SSFB denoise on Quickwit 0.8, where a group of only NOTs may match nothing | Yes: the NOT group starts with `*`, so `(* AND NOT service:'kong'* AND NOT service:'kafka'* AND NOT 'Api execution completed') OR level:error` (D76) |
| Q12 | The `logs_search` `index` input | Dropped from the plan |
| Q13 | Device ids and verification ids found in a result are refused by the scope check, so the SIM device path dead-ends | Extend the D77 rule to them in wave 5 (with W13): `device_id`, `x-device-id` and `verification_id` are in scope once an earlier result in the same run, fetched by a chain id, has shown them. Briefs may carry them, and the method's pivot to them comes back. Until then the method records them as a gap |

## Appendix A. Logging patterns in the Shivalik refs (survey, 2026-09-26)

Read-only survey of about 150 ref folders (258 `.md` files, about 95 with log work, 36 read in
full, 4 eval cases). Structure only: every id is a placeholder, no customer data. Counts are
approximate. About 14 refs lost log evidence because Quickwit was unreachable, so "no log
evidence" in a ref often means the tool was down.

### A.1 Patterns

| Pattern | Query shape | Services | ~Refs |
|---|---|---|---|
| Bare id token + service + topic word | `service:<svc> AND <id8> AND <topic>` | rhythm, harbor | 20 |
| Exact field with the full dashed UUID | `service:<svc> AND customer_id:<uuid>` / `form_id:<uuid>` | harbor, rhythm | 12 |
| Hyphenated header field | `x-device-id:<device_id>` | guardian, harbor, rhythm | 9 |
| Developer label phrase | `service:<svc> AND message:"<label>" [AND <id>]` | guardian, harbor, rhythm | 15 |
| User-quoted text on `error` | `(error:<w1> AND error:<w2>)` + count | harbor | 2 |
| First-look error sweep | `service:<svc> AND level:error`, 2 h, group by `message,error` | harbor | 3 |
| Id anywhere, no service | `<id>`, ±1 day, group by service | all | 9 |
| `raw_message` wildcard | `raw_message:*<id_or_substr>*` | harbor, rhythm | 2 |
| `raw_message` AND-terms | `raw_message:<w1> AND raw_message:<w2>` | workflow-op | 1 |
| OR | levels, labels, id tokens, services | harbor, rhythm, ATSPL | 4 |
| NOT | `… AND NOT message:<noise>` | harbor | 1 |
| Field equality and paths | `status_code:500`, `path:"<path>"`, flags | harbor, rhythm | 6 |
| CBS response bodies | `<account_number> <topic> --message "HTTP Response" --raw`, newest first, 10-min slice | rhythm | 10 |
| Walk a txn to an anchor | `x_txn_id:<txn_id>`, 20-min slice, raw, oldest first | harbor | 3 |
| Group by request | group by `x_req_id`; count requests and entities, not lines | harbor, rhythm | 3 |
| Baseline per window | same query per day or slot; other customers | all | 10 |
| Compare counts across services | same device or path in 2+ services (kong-vendor vs guardian) | kong-vendor, guardian, rhythm | 4 |
| Missing expected label | label A repeats, label B never appears | harbor, guardian | 8 |
| App vs admin traffic | split by `User-Agent` and `/admin/` path | rhythm, harbor | 6 |
| Sweep with paging | 4 h windows, offset paging, 2 s pacing, 10k offset cap | harbor | 2 |
| Other cluster | London `core-prod-app-logs` (`workflow-op-service`); ATSPL `envoy-logs` | RTL, package | 2 |

Pivots seen: user id → London logs → phone and device → guardian DB; form id → customer id →
account ids → txn ref → txn lifecycle; account number → CBS inquiry body; `x-device-id` from a
log line → guardian; request uuid → retry timeline; RRN or UTR → one disbursement status line.

Zero-hit order they followed: bare terms instead of the field; drop `level`; drop `service`;
widen the window; try another index; confirm the service exists (`service:<x>` count; this is
how `kyc-service`, `banking-service` and `appserver` were found to return 0); count the id with
no filters to prove the zero is real.

### A.2 Recurring labels and fields

- **harbor**: `generating challenge`; `failed to generate challenge for forget MPIN` / `…for
  token refresh`; `rate limit exceeded for phone number`; `refresh access token request
  completed successfully`; `MPIN attempt counter reset`; `record MPIN fail`; `checking
  verification status`; `verification status check completed successfully`; `calling CBS API
  to create customer`; `CBS API error`; `[CBS API] Unknown Error - Raw Response`; `==== XML
  PAYLOAD (before encryption) ====`; `failed to create accounts in rhythm`; `get customer by
  form ID`; `package delivery created successfully`; `package webhook received`; `package
  delivery failed`; `admin trigger delivery request received`; `notarylive webhook received`;
  `id pre-upload failed…`; `notarylive id preupload http error`; `review step handler status
  check` / `…submit`; `reference data request received`; `get personal details request
  received`; `HTTP request started` / `completed`. Fields: `form_id`, `customer_id`,
  `x-customer-id` (a form id before the customer exists), `x-device-id`, `document_type`,
  `status_code`, `requires_verification`, `flow`, `delivery_id`, `provider_order_id`.
- **rhythm**: `HTTP Response`; `HTTP Request`; `HTTP request error` (`context canceled`);
  `Api execution completed`; `Api ended with Error`; `listing accounts for customer`;
  `accounts_home_v2:`; `failed to get debit card`; `deposits: invalid deposit request`;
  `td.create_fd.failed`; `CBS disbursement status response received`; `publishing disbursement
  status check`; `bank_identifier … max retries dropping`; `[CBS API] Payment Disbursement
  Failed (IMPS)`; `CBS submit ambiguous…`. CBS topic words: `savingaccount`, `carddetail`,
  `channelflagandlimit`, `GetStatementwithPagination`, `beneficiarynamelookupservice`, `dcms`,
  `ListFDsByCIF`, `security/oauth`, `BenefBankIFSC`. Fields: `path`, `status`, `latency`,
  `client-ip`, `User-Agent`, `request_uuid`, `x-customer-id`; `ActionCode` / `ESBStatus` inside
  `raw_message`.
- **guardian**: `generating challenge`; `challenge generated successfully`; `verifying
  challenge`; `challenge verified`; `failed to verify challenge`; `refresh token is not valid`;
  `Twilio callback received`; `Processing Twilio callback`; `Failed to verify token and create
  session` (errors `Request validation failed`, `Verification ID does not exist`, `Verification
  token has expired`). Fields: `x-device-id`, `reference_id`, `iso_country_code`.
- **workflow-op** (Java): the whole line is in `message`; no `error` field. London:
  `LoggingOkHttpInterceptor` lines.
- **kong, kong-internal, kong-vendor**: the access line is in `message`
  (`POST /guardian/api/v1/callbacks/vendors/twilio/sms`, `Missing Authorization header`).
- **All Go services**: `x_req_id`, `x_txn_id`, `error`.
- **Services in `logs-v1`** (over 30 days): kong, eventbus, audit, kong-internal, harbor,
  kafka-connect, workflow-op, rhythm, reminder, guardian, comms, cohort, pdf-generator,
  kong-vendor, schema-registry.

### A.3 Traps

1. Phrase queries on the default field, `raw_message` or `error` returned HTTP 400 (no
   positions) on SSFB `logs-v1`; phrases worked only on `message`. Superseded for UUIDs by the
   owner's answer to Q8: a single-quoted whole UUID works everywhere.
2. A dashed UUID as a bare term failed; the first-segment cut can collide. Full UUIDs worked as
   an exact field or a `raw_message` wildcard.
3. A bare-term zero is not proof: a device id as a bare term gave 1 hit, as
   `x-device-id` 785. Wrong field names (`user_id`, `flow_type`) return a clean 0.
4. The tokenizer splits on `_` and `.`: false positives on `failed_check_reason`; dotted labels
   break wildcards; multi-word wildcards return a silent 0.
5. `message` is the label, `error` the text users quote (workflow-op is the exception).
6. Guardian redacts `from`, `to`, `sim_card_number`, `token`, `message_sid`.
7. Some paths log nothing (guardian rate-limit rejection; harbor webhook failure reason): the
   evidence is a missing label.
8. `x_txn_id` / `x_req_id` are reused; one failure emits 2 to 52 lines. Count requests or
   entities, not lines.
9. CX and admin lookups show up as the customer's hits. Split by `User-Agent`: ReactorNetty,
   go-resty or Java for admin; okhttp or CFNetwork for the app.
10. Times are UTC; tickets quote IST. Search forward to now before stating current state.
    Retention is about 30 days; the oldest day comes back partial.
11. Wrong service or cluster: RTL London and the app-server order backend are not in
    `logs-v1`; in ATSPL `service:harbor` is a kafka-ui container, and pulse is `pulse-backend`.
12. SSFB Quickwit has one CPU: parallel day-scale scans knocked it over. Pace queries; 10k
    offset cap; report "unreachable" apart from "0 hits".

### A.4 Ten query templates for the skill

1. `service:<svc> AND level:error`, 2 h after `<t0>` → group by `message,error`.
2. `<id>` with no service, ±1 day → group by `service,level,message`.
3. `service:<svc> AND customer_id:<uuid>` (or `form_id:<uuid>`, `x-device-id:<device_id>`) →
   oldest-first timeline.
4. `service:<svc> AND message:"<label>" AND x-device-id:<device_id>`; run again with
   `"<success_label>"` and compare.
5. `service:<svc> AND (error:<w1> AND error:<w2>)` over 30 days → count, then group by
   `customer_id`.
6. `service:rhythm AND <account_number> AND savingaccount`, ±5 min → raw, newest first.
7. `x_txn_id:<txn_id>`, ±10 min → raw, oldest first; walk back to the anchor line.
8. `service:<svc> AND message:"<label>"` over 30 days → count per day and distinct
   `customer_id` (blast radius, baseline).
9. `service:rhythm AND <id8> AND path:"<path>"` → columns `status,latency,User-Agent`.
10. After a zero: `raw_message:*<uuid>*`, or `<id8>` with no filters (count); then
    `service:<svc>` count to check the service exists; for vendor callbacks compare the
    kong-vendor path count with the service's own label count.
