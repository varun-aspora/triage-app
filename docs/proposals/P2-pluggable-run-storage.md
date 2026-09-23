# P2. Pluggable storage for runs, Postgres + pgvector

Source: workflow wf_d09cca81-92f, 2026-09-23. Research agent (Opus) then adversarial critic (Opus). Read-only; no file in either workspace was changed. Status: **proposal, not decided**. Decisions it touches: D2, D3, D19, D20, D22, D24, D26, D27, D29, D38, D41, A9, A11.

## Summary

Recommendation: add a small RunStore interface with two providers. The folder provider stays the default and keeps today's `.data/runs/<run_id>/` layout. The Postgres provider has separate tables (runs, run_evidence, run_reports, run_audit, run_feedback, run_embeddings). Tools get the store through the same closure that already carries run_id, so the model never sees it (D3). The run_id (ULID) is already the Flue conversation id and the audit key, and it becomes the store's primary key.

The run store is separate from Flue persistence (src/db.ts, D38). Flue's DB holds the model-facing transcript and the raw dispatched thread, it can't delete per session, and Flue says not to use it for business data. The run store holds only persisted-profile (redacted) data. Embeddings are built only from that text, never from the Flue stream.

pgvector: one vector per run for a short "case card" (category, current ask, root cause, status, pattern id), one for the root cause, one per entity's evidence summary, and one for feedback's actual root cause. Use cosine distance with an HNSW index. Embeddings are derived data that can be rebuilt with `triage runs reembed`. Neither pi-ai 0.83 nor Flue 2.0.8 has an embeddings API, so `MODEL_EMBEDDING` needs a small in-repo client (Ollama or OpenAI). The folder provider does brute-force cosine over embeddings.json, so both providers behave the same and evals run without Postgres.

Similar cases in v1: a deterministic ingress step passes the top 3 prior cases as data to the classifier and orchestrator. Ids are stripped, the results are advisory only, and the tier policy ignores them. A model-callable tool comes later behind a flag.

Two decisions for you: (1) "store the raw text alongside embeddings" has to mean the redacted text. Raw customer text must not persist (D24, 04:106). (2) Default embedding provider: local Ollama (nothing leaves the machine) or OpenAI.

## Questions for the owner

- Where does the run store live: A) the same Postgres server as TRIAGE_DB_URL (Flue) in a separate `triage` schema, or B) a separate database with its own DSN?
- Confirm: the 'raw text' stored next to embeddings means the persisted-profile (redacted) text only, and the raw thread never persists in the run store. Yes/no?
- Default embedding provider: A) local Ollama (nothing leaves the machine) or B) OpenAI text-embedding-3-small? Voyage is excluded unless you add it to D41.
- Similar cases in v1: A) deterministic ingress step only, with prior cases passed as data (recommended), or B) ingress step plus a find_similar_cases tool on the orchestrator from day one?
- Cold start: import the old refs/ threads and findings into the similarity corpus after redaction and human review? Yes/no.
- Build the Postgres provider in v1, or ship v1 with the interface and folder provider and add Postgres with the server deployment?

---

## Critic verdict: sound_with_changes

**Conflicts with decisions**

| Decision | Conflict | Resolution |
|---|---|---|
| D4 (TRIAGE_ENV_LABEL is display-only; 02:157 says a test greps src for any other use) | The proposal adds an `env_label` column to `runs` but gives no way to keep stage and prod runs apart when two .env files (D41: separate stage .env for SSFB/ATSPL) point at the same TRIAGE_RUNSTORE_URL. The only thing that tells them apart is env_label, and D4 forbids logic from reading it. So similarity would mix stage and prod cases. | Separate stores for each deployment (a different DSN, schema or TRIAGE_RUNS_DIR per .env), written down in the D-entry. Never filter on env_label. |
| D9 / D22 / tier policy rules 1-3 (02:188-192) | The report says 'Tier policy ignores prior cases', but prior_cases are fed to the classifier. The classifier's category and confidence decide tier rules 1-3, so similar cases do change the tier indirectly. | Either keep prior_cases out of the classifier in v1 (give them only to Triage initialData), or say plainly that they affect the tier and grade the tier delta in evals with and without them. |
| D41 (OpenRouter only for the classifier, which sees the redacted thread of this request) | The proposal refuses OpenRouter for embeddings, yet sends the same persisted-profile text from other customers' runs to the classifier, and the classifier may be on OpenRouter. D41 approved OpenRouter for one request's redacted thread, not for a corpus of other customers' cases. | Only pass prior_cases to the classifier when MODEL_CLASSIFIER is not openrouter/, or drop them from the classifier input altogether. |
| D20 / the report's own rejection of dual write (option F) | Audit is written three times: the TRIAGE_AUDIT_LOG JSONL, the run-folder mirror, and run_audit. That is the same 'tee' the report rejects for runs. | Make the JSONL the single audit source in v1 and load run_audit from it with a batch job if it is ever needed. Otherwise pick one primary copy and state it. |
| D19 / D27 and the memory rule 'never real calls in dev/evals' | The value of similarity is gated on 'evals show the ingress version helps', but evals use an empty temp store and a hashing embedder. That measures neither real retrieval quality nor any prior_cases effect. Measuring it properly needs a real embedder, which is a real call unless local Ollama counts as allowed. | Add a reviewed, redacted fixture corpus under fixtures/ (promoted by a human, D27) and recorded query vectors, or have the owner decide whether a local Ollama embed is allowed in evals. |
| D24 (the persisted profile is per run; it masks names collected by ingress for that run) | Prior cases re-enter a new run through initialData, which Flue keeps forever (guides_database.md:175; ecosystem_databases-postgres.md:127). So run B's Flue stream permanently holds run A's text, and deleteRun(A) cannot remove it. | State this in the erasure/retention decision, or keep prior_cases out of initialData and give them only through a tool result the design already accepts as non-deletable. |

**Factual errors found**

- 'Tier policy ignores them' (3.7, D45) is misleading. Prior cases go into the classifier, and classifier category and confidence drive tier rules 1-3 (02:188-192).
- 'scope.ts (D26) denies any foreign id anyway' overstates D26. scope.ts checks only id-shaped parameters to sql_select/http_call/logs_search/cbs_call (02:146). It does not stop foreign ids from prior_cases showing up in classifier output, the report text or reply_text.
- The folder provider is called the 'same layout as today', but putEvidence returns a version and run_evidence has pk(run_id,key,version). Today note_evidence writes one evidence/<entity>.json (02:133). The versioned folder layout is not specified.
- run_embeddings has pk(run_id, kind, part, model), which implies several models side by side, but the column is a fixed vector(<MODEL_EMBEDDING_DIMS>). A model with different dims cannot coexist, and 're-embed after truncate' is actually a column type migration plus an index rebuild.
- 'The classifier gets dynamic few-shot examples' is presented as new, but the classifier already has static few-shot examples from redacted refs/ cases (04:127). The report does not reconcile the two.
- Verified correct: the Flue persistence citations (guides_database.md:19,175,186; ecosystem_databases-postgres.md:43-80,87,105,127), the env key line numbers (.env.example:30-32,37-38), idempotency 'in sqlite' (02:281, 04:107), run_id = Flue id (04:90,152), and no embeddings API in pi-ai or Flue (grep over node_modules shows only error-message helpers).

**Missing**

- Follow-ups: `triage ask` is a new submission on the same conversation and run_id (02:268), so there can be several finish_report calls per run. run_reports is keyed pk(run_id) and would overwrite. The report does not model run vs submission.
- Erasure is incomplete beyond Flue. deleteRun does not reach the global TRIAGE_AUDIT_LOG JSONL, other runs' initialData/streams that carry this run as a prior case, or Postgres backups. Retention is left as an open question with no default.
- Access control: GET /triage/:run_id lets any bearer holder read any run (02:286). A shared Postgres store with findSimilar widens what one leaked token exposes. Not discussed.
- Who runs the 'post-settle embed step', and in which process, when `triage start` returns at once. Also whether it is a Flue hook (useAgentFinish) or ingress code. Not specified.
- Concurrent folder writes (server plus CLI on one TRIAGE_RUNS_DIR) and folder schema_version migrations.
- How legacy import relates to A9 (refs converted to eval cases). Two redaction and review pipelines over the same unredacted refs.
- How failures on the check-semantics re-scan behave for appendAudit and putEvidence (does a false positive drop an audit line or block note_evidence?).
- The v1 cut is stated only in 3.8. D42 as drafted reads as if Postgres is chosen now, and D45 says 'ingress step in v1' while embeddings are optional in v1.

**Security or data risks**

- The author's research step printed customer names and tracking references from refs/dockethub-*/update_queries*.sql into a subagent transcript (report 1.1). This is the same class of incident as the 2026-09-23 DSN leak and should be reported to the owner in chat, not only noted in the report.
- The persisted profile has a stated residual risk (D24: names and addresses ingress never saw). The run store then copies that residual into a shared DB, into source_text next to vectors, and into every future run's classifier prompt and Flue stream. The blast radius grows across runs, not only across machines.
- Prior cases are shown to the classifier. If the classifier is on OpenRouter (D41), redacted text from other customers goes to a provider approved only for the current request's thread.
- Embedding vectors of redacted text are still derived customer data. If OpenAI is the embedder, every run's text goes to a second endpoint besides the tier model. This needs a D-entry, not only an open question.
- UUIDs pass the persisted profile (A11). The projection scrubs UUID-shaped tokens but keeps faster_path and root_cause_statement, which are free text that may hold account numbers masked only to ****last4 or names ingress never saw.
- Persistent prompt injection. Model-written root_cause text and human faster_path become input to later runs. The mitigation (label as untrusted, cap length) is a prompt rule, and D13 says prompt rules are not enforcement.

**Simplifications**

- Split the proposal. v1 = RunStore interface plus folder provider plus meta.json (origin, schema_version), with the idempotency key moved into the store. Postgres, pgvector, embeddings and prior_cases go to a later item, tied to the server deployment and to Proposal 4, which gives them a consumer.
- At about 150 cases a year (survey 08:6), skip the HNSW index and the fixed vector(n). Use an exact scan (ORDER BY embedding <=> $q with no index), or brute force in the app for both providers. This removes the dims migration problem and MODEL_EMBEDDING_DIMS as a schema input.
- Cut embedding kinds from five to two (case, request). root_cause/evidence/feedback clustering is an offline Proposal 4 script and can embed on demand.
- Drop run_audit. The JSONL (D20) stays the one audit source; load it into the DB later if needed.
- Do not add TRIAGE_SIMILAR_CASES_TOOL now. A key for an undesigned phase-2 tool is config for nothing; add it with the decision that mounts the tool.
- Consider reusing TRIAGE_DB_URL with a `triage` schema instead of a new TRIAGE_RUNSTORE_URL. That is one fewer DSN in .env (only keep the separate key if the owner wants a separate database; open question 1).
- Give prior_cases only to Triage initialData, not to the classifier, in the first version. This avoids the D41/OpenRouter and tier-influence problems and still tests usefulness.

### Critique

## Critique: Proposal 2 (RunStore, Postgres + pgvector)

**Verdict: sound with changes.** The storage split is right: Flue persistence for conversations, and an app-owned store for run records. Flue's own guidance supports it: "Keep application business data in application-owned stores and access it through tools" (guides_database.md:172), and "Do not expect Flue persistence to store … application business records" (ecosystem_databases-postgres.md:117). The embeddings and prior-cases half is where the problems are, and at this data volume it is not v1 work.

### Claims I checked
- These citations hold: the Flue persistence facts (guides_database.md:19,175,186; ecosystem_databases-postgres.md:87,105,127), the env line numbers (.env.example:30-32, 37-38), idempotency "in sqlite" with no location given (02:281, 04:107), run_id = Flue id (04:90,152), the double writer of input.json (03:13 and 02:81), and no embeddings API in pi-ai or @flue/runtime (my grep matched only error-message helpers).
- **Wrong or overstated:**
  - "Tier policy ignores prior cases." Prior cases go to the classifier, and classifier category and confidence drive tier rules 1-3 (02:188-192), so they change the tier indirectly.
  - "scope.ts denies any foreign id anyway." D26 checks tool parameters only (02:146). It does nothing about text in the classifier output or the report.
  - The folder provider is called "same layout as today", but putEvidence adds versions. Today it is one `evidence/<entity>.json` (02:133).
  - `pk(run_id, kind, part, model)` next to a fixed `vector(n)` column contradicts itself. Two models with different dims cannot live in one column.
  - The classifier already has static few-shot examples from redacted refs (04:127). Dynamic prior_cases are a second mechanism for the same thing, and the report does not say so.

### Decisions touched but not handled
- **D4.** Stage and prod `.env` files (D41) may point at the same store. The only thing that tells them apart is `env_label`, and D4 forbids logic from reading it (02:157). The D-entry needs "one store per deployment".
- **D41.** The report refuses OpenRouter for embeddings but gives other customers' redacted cases to the classifier, which D41 allows to be OpenRouter. D41 approved OpenRouter for *this request's* redacted thread only.
- **D20 vs option F.** Audit is written three times (JSONL, run-folder mirror, run_audit). That is the tee the report rejects elsewhere.
- **D19/D27 and "no real calls in evals".** Evals use an empty temp store and a hashing embedder, so they cannot show that similarity helps. Yet D45 gates phase 2 on exactly that. Either build a reviewed fixture corpus under `fixtures/`, or the owner decides whether a local Ollama embed counts as a real call.
- **D24 residual risk, compounded.** Prior cases go into `initialData`, which Flue keeps forever with no per-session delete (ecosystem_databases-postgres.md:127). Run A's text then lives in run B's stream, and `deleteRun(A)` cannot reach it. Erasure also misses the global `TRIAGE_AUDIT_LOG`.
- D2, D3, D13, D35 and D40 are not violated. The v1 ingress step adds no model-reachable I/O. The phase-2 tool reads only the app store.

### Gaps
- **Follow-ups.** `triage ask` is a new submission on the same run_id (02:268). `run_reports pk(run_id)` would overwrite the first report. Run vs submission needs modelling.
- **Post-settle embed step.** The report does not say which process runs it after `triage start` returns, or which Flue hook it uses.
- **Access.** Any holder of the shared bearer can read any run (02:286). A shared store plus findSimilar widens what one leaked token exposes.
- **Folder provider.** Nothing on concurrent writes from the server and the CLI, and nothing on folder schema migrations.
- **Legacy import.** It runs alongside A9's refs-to-eval conversion, which means two review pipelines over the same unredacted data.
- **Failed re-scan.** The report does not say what happens when the provider re-scan fails on `appendAudit` or `putEvidence`: is the audit line dropped, or is `note_evidence` blocked?

### Data handling
- **Report this to the owner.** The author's own research printed customer names and tracking references from `refs/dockethub-*/update_queries*.sql` into a transcript (report §1.1). This is the same class of incident as the recorded DSN leak. It should go to the owner in chat, not only into the report.
- Vectors and `source_text` are derived customer data. If OpenAI embeds, every run's text reaches a second endpoint. That needs a D-entry, not only open question 3.
- "Label prior cases as untrusted" is a prompt rule, and D13's own reasoning says prompt rules are not enforcement. The real mitigations are the structured projection and keeping prior cases out of tier policy.

### v1 or later
The report half-says it. Section 3.8 puts Postgres after v1, but draft D42 reads as if Postgres is chosen now, and D45 says "ingress step in v1" while embeddings are optional in v1. Make the cut explicit in the decisions.

### Simpler version
1. **v1:** RunStore interface, folder provider with `meta.json`, and the idempotency key moved into the store. That is all.
2. **Later, with the server deployment and Proposal 4:** Postgres. At about 150 cases a year, use an exact scan instead of HNSW, and an untyped or per-model column so a model change is not a migration.
3. **Two embedding kinds** (case, request) instead of five. Clustering is an offline script and can embed on demand.
4. **No run_audit table.** Also no `TRIAGE_SIMILAR_CASES_TOOL` key until phase 2 is decided.
5. **Prior cases go only to Triage `initialData`, not the classifier**, until evals show value. This removes the D41 and tier concerns in one move.
6. **Consider one DSN** (`TRIAGE_DB_URL`, schema `triage`) unless the owner wants a separate database.

### Owner questions this critique adds
- One run store per deployment (stage and prod separate): yes/no?
- Prior cases to the classifier, or only to the orchestrator?
- Is a local Ollama embedding call allowed in evals?
- Does erasure need to cover the global audit JSONL, and other runs that cite this run as a prior case?

---

## Full report

# Proposal 2: Pluggable run storage, Postgres + pgvector

Legend: **F** = fact I read (cited), **I** = inference, **U** = unknown.

Proposed decision numbers D42–D46 are provisional. Four other proposals are being evaluated in parallel and may claim the same numbers.

## 1. What exists today (facts)

### 1.1 A "run" in triage-shivalik (the old workspace)

- **F** `refs/` has 151 entries: 143 directories and 8 loose CSV/.numbers exports. The files: 118 `slack_thread.md`, 94 `findings.md`, 9 `investigation.md`, 7 `report.md`, 5 `notes.md`, 2 `triage_report.md` (docs/survey/08-past-cases-taxonomy.md:6; my `find` over refs/ matched it).
- **F** Most case folders hold just two files: `slack_thread.md` + `findings.md` (for example refs/welcome-letter-delivery-4bdd1e51, refs/notary-stuck-960e5381, refs/fd-booking-failed-p1789539001), or `slack_thread.md` + `investigation.md` (refs/transfers-disabled-fd87cf3c). Some are thread-only (refs/mpin-setup-stuck-4d298852). Analysis and batch folders hold scripts, CSVs and SQL (refs/harbor-error-classification: taxonomy.json, signatures.tsv, *.py; refs/cbs-outage-2026-07-16: intended.json, recovery_app.py; refs/dockethub-89-11-status-check-20260907: update_queries*.sql; refs/pse-yodel-ref-remap/fix_refs.sql; plan files in refs/bro-dry-run-v2/PLAN.md and refs/utrack-carrier-service-code/plan.md).
- **F** Findings files are free-form Markdown. Their headings vary but follow one pattern: ID chain / State / Root cause / Scope or blast radius / Fix or recommendation (for example refs/transfers-disabled-fd87cf3c/investigation.md:12-77 and refs/notary-stuck-960e5381/findings.md:5-84). Titles often carry a customer UUID or first name (refs/fd-booking-failed-p1789539001/findings.md:1).
- **F** `refs/eval-cases/` has 4 files with YAML front-matter: `id, type, input{problem, identifiers, ref}, investigation{root_cause, service, db_evidence, queries[], code_evidence[]?, notes_on_queries?}, ground_truth{verdict, actual_root_cause?, faster_path}, notes, captured_at` (for example refs/eval-cases/2026-07-03-transfers-disabled.md front-matter).
- **F** refs notes contain unredacted names, phones, PANs and addresses (docs/survey/08-past-cases-taxonomy.md:85). While listing file structure I confirmed this in the dockethub `update_queries*.sql` comments: one command printed customer names and tracking references from those comments into this subagent's transcript. They are not repeated here.
- **I** A run today is "a folder a human filled in". There is no schema, no run id, and no link to the audit log. The audit log itself has no session or request id (docs/00-lay-of-the-land.md:19).

### 1.2 A run in the new design

- **F** Run id: `request_id` is a ULID and doubles as the Flue conversation id (docs/04-lld-multi-entity-request.md:90). Dispatch is `init(Triage, {id: request.request_id})` (04:152).
- **F** Run folder: `.data/runs/<run_id>/` holding input, classification, evidence/, report, feedback, audit (docs/02-hld-detailed.md:47). Keys `TRIAGE_DATA_DIR`, `TRIAGE_RUNS_DIR`, `TRIAGE_AUDIT_LOG` (.env.example:30-32).
- **F** Writers: ingress writes `input.json` (redacted) and `classification.json` (docs/03-data-flow.md:13,22). `useAgentStart` also "writes input.json if absent" (02:81). `note_evidence` writes `evidence/<entity or code>.json` after persisted-profile redaction (02:133). `finish_report` writes `report.json` + `report.md` after egress redaction with check semantics (02:134, 04:258). `audit.ts` writes one JSONL line per call to `TRIAGE_AUDIT_LOG` and mirrors it into the run folder (02:149, D20). `triage feedback` writes `feedback.md` in the eval front-matter shape (04:262, D29).
- **F** The `Report` has no summary field. The text-bearing fields are `request.current_ask`, `root_cause.statement`, `timeline[].what`, `cx_answer.reply_text`, `actions`, `gaps` (04:237-255). `EntityFindings` carry `evidence[].summary`, `hypotheses[]`, `confidence`, `gaps[]` (02:93).
- **F** `Classification.category` is a closed TypeScript union (04:131-132).
- **F** Mock fixtures live in `fixtures/`. Recording goes to `fixtures/_unreviewed/` and a human promotes it (D27, 02:151).
- **F** `patterns.json` entries are `{id, category, signature:{regex[], services[]}, entities[], query_recipe, tier_hint, stable, source_ref}` and are curated in PRs (02:257, 02:198). `patterns.ts` does a regex signature match (02:112).
- **F** The HTTP `Idempotency-Key` is "stored in sqlite" (02:281, 04:107). The doc doesn't say which sqlite.

### 1.3 Flue persistence is a different thing

- **F** Flue persistence stores "canonical conversation streams, submission admission and settlement state, `usePersistentState` records, and immutable attachment bytes. It does not replace the application's business database" (.claude/skills/flue-framework/references/guides_database.md:19).
- **F** "Admitted and settled submission data is retained" (guides_database.md:175). "Canonical streams are append-only … sessions have no per-session deletion contract" (ecosystem_databases-postgres.md:127). "Keep Flue runtime data separate from application business-data ownership" (ecosystem_databases-postgres.md:105). "Do not hand-run application-style migrations against Flue tables" (guides_database.md:186).
- **F** The conversation stream carries model-facing tool results, including account numbers and phones (02:285). The dispatched `message` is `renderThread(request)`, meaning the raw thread (04:153). `initialData` gets only the redacted request (04:154).
- **F** D38 picks the Flue adapter with `TRIAGE_DB_PROVIDER=sqlite|postgres` + `TRIAGE_DB_URL` (05:183-184, .env.example:37-38).
- **I** So the Flue DB holds model-facing data and the raw thread text, and nothing in it can be deleted per run. That contradicts "Ingress persists only the redacted copy" (04:106) for anyone who reads the Flue DB. It is outside this proposal, but it matters here because the run store must never be filled from the Flue stream.
- **F** Neither `@earendil-works/pi-ai` 0.83.0 nor `@flue/runtime` 2.0.8 exposes an embeddings API. A grep for "embedding" over both `dist/` trees found only unrelated error-message helpers. `pg` and `@flue/postgres` are not installed (node_modules listing).

## 2. Options considered

| # | Option | Verdict |
|---|---|---|
| A | Keep folder only (current design) | Works for one laptop. No cross-run queries, no shared view on a server, no similarity except a hand scan. |
| B | **RunStore interface; folder provider (default) + Postgres provider with separate tables and pgvector** | Recommended |
| C | Keep run data inside Flue persistence (`usePersistentState`, conversation stream) | Rejected. Flue says not to (1.3). It holds model-facing data and has no deletion. `flue_*` tables are off limits. |
| D | sqlite provider with the sqlite-vec extension | Deferred. **U** whether `node:sqlite` loads extensions reliably on Node 22.19. The folder provider already covers laptops. It can be added later behind the same interface. |
| E | A dedicated vector DB (Qdrant, Pinecone, Chroma) | Rejected. It adds infra and another place customer-derived text lands. Postgres is already in the design (D38). |
| F | Dual write folder + Postgres ("tee") | Rejected. It creates two sources of truth. Replaced by a one-shot `triage runs import` command. |
| G | Postgres full-text search only, no embeddings | Kept only as a complement. It misses paraphrase ("letter never came" vs "vendor delivery failed"). Exact error codes are already handled by `patterns.ts` regex. |
| H | Embed the whole raw thread | Rejected. Raw text must not persist or leave for a non-approved provider (D24, D41). |

## 3. Recommendation and how it plugs in

### 3.1 The interface (`src/store/runstore.ts`)

```ts
type RunId = string; // ULID = TriageRequest.request_id = Flue instance id = audit run_id
type Origin = 'live' | 'mock' | 'eval' | 'legacy';

interface RunStore {
  readonly provider: 'folder' | 'postgres';
  createRun(r: Persisted<RunInput>): Promise<void>;            // idempotent by run_id
  setPhase(id: RunId, phase: RunPhase): Promise<void>;
  putClassification(id: RunId, c: Persisted<ClassificationRecord>): Promise<void>; // + id_chain, tier rule fired
  putEvidence(id: RunId, key: Entity | 'code', f: Persisted<EntityFindings | CodeFindings>): Promise<number>; // returns version
  putReport(id: RunId, r: Persisted<Report>, md: Persisted<string>): Promise<void>;
  appendAudit(line: Persisted<AuditLine>): Promise<void>;
  putFeedback(id: RunId, f: Persisted<Feedback>): Promise<void>; // append-only, latest wins
  claimIdempotencyKey(key: string, id: RunId, ttlMs: number): Promise<RunId>; // replaces the unnamed sqlite
  getRun(id: RunId): Promise<RunRecord | null>;
  listRuns(q: RunQuery): Promise<RunSummary[]>;                // category, status, verdict, since, origin
  putEmbedding(e: Persisted<EmbeddingRow>): Promise<void>;
  findSimilar(q: SimilarQuery): Promise<SimilarCase[]>;
  deleteRun(id: RunId): Promise<void>;                         // erasure; Flue stream is not covered
}
```

- `Persisted<T>` is a branded type that only `redact.ts` (persisted profile) can produce. Providers also re-run the check scan before writing. This enforces D24 in both the type system and at runtime.
- Tools get the store by closure, as they already get `runId`: `toolsFor(entity, runId, store)`, `noteEvidence(runId, store)`, `finishReport(init, store)`. The model never sees a store argument (D3). No store tool is generic (D2).
- `createRun` is called once by ingress. The `useAgentStart` write in 02:81 becomes a no-op check. This removes the double writer.
- Audit: `audit.ts` always appends to `TRIAGE_AUDIT_LOG` first (local, cheap, survives a DB outage), then calls `store.appendAudit`. D20 is unchanged.

### 3.2 Folder provider (default)

Same layout as today, plus two small files: `meta.json` (`schema_version`, `origin`, `redaction_profile_version`, phase) and `embeddings.json` (only when `MODEL_EMBEDDING` is set). Writes use temp-file-then-rename. `findSimilar` does brute-force cosine over every `embeddings.json`. At hundreds to a few thousand runs this takes milliseconds (**I**), so evals exercise the same code path without Postgres.

### 3.3 Postgres provider

Schema `triage`, owned and migrated by the app (idempotent SQL files applied at startup, like Flue's own `migrate()`). It never touches `flue_*`. The DSN comes from its own key so it can point at the same server as `TRIAGE_DB_URL` or a different one.

```sql
runs(run_id text pk, origin text, env_label text, interface text, created_at timestamptz, phase text,
     category text, subcategory text, tier_proposed text, tier_final text, rule_fired text,
     matched_pattern_id text, escalated bool, report_status text, confidence text,
     entities text[], request jsonb, classification jsonb, id_chain jsonb, cost jsonb,
     schema_version int, redaction_profile_version text)
run_evidence(run_id fk, key text, version int, findings jsonb, confidence text, created_at, pk(run_id,key,version))
run_reports(run_id pk fk, report jsonb, report_md text, root_cause text, generated_at)
run_audit(id bigserial pk, run_id, ts, interface, entity, tool, decision, reason, service, target,
          rule_index, summary_redacted, duration_ms, exit)
run_feedback(id bigserial pk, run_id fk, verdict text, actual_root_cause text, faster_path text,
             given_by text, given_at, front_matter jsonb)
run_embeddings(run_id fk, kind text, part text default '', model text, dims int, text_sha256 text,
               source_text text, embedding vector(<MODEL_EMBEDDING_DIMS>), created_at,
               pk(run_id, kind, part, model))
idempotency(key_sha256 text pk, run_id text, expires_at timestamptz)
CREATE INDEX ON triage.run_embeddings USING hnsw (embedding vector_cosine_ops);
```

`category` is `text`, not an enum. When Proposal 4 adds a class of case, no migration is needed.

### 3.4 What to embed (persisted-profile text only)

| kind | text | used for |
|---|---|---|
| `case` | category, subcategory, current_ask, root_cause.statement, status, scope.kind, matched_pattern_id, services from evidence, rendered as short labelled lines | "find past cases like this new thread" |
| `request` | redacted thread: parent message + the latest messages (the current ask) | ingress lookup before a report exists; the query side of a new thread |
| `root_cause` | `root_cause.statement` (+ code_refs file names) | clustering by root cause; systemic checks |
| `evidence` (part = entity) | concatenated `evidence[].summary` + `hypotheses[]`, capped | per-entity "seen this before" |
| `feedback` | `actual_root_cause` + `faster_path` when verdict is partial or wrong | ground truth; overrides `root_cause` in clustering |

Not embedded: audit lines, raw tool results, `reply_text`, images. Screenshots can't be redacted, so neither store keeps them. Only Flue's attachment store does.

Query text for a new thread goes through the same persisted profile, so both sides of the comparison carry the same masks (**I**: this keeps the vectors comparable).

### 3.5 Embedding model and provider

- There is no embeddings API in pi-ai or Flue (1.3), so this needs `src/embed/` with two small clients: Ollama `/api/embed` (via `OLLAMA_BASE_URL`) and OpenAI `/v1/embeddings` (via `OPENAI_API_KEY`). Specifier format is `provider/model`, like the other `MODEL_*` keys.
- The following are from general knowledge and not verified in this session. Anthropic has no embeddings endpoint (it points to Voyage AI, which is not in D41's list). Candidate models: `ollama/nomic-embed-text` (768 dims), `ollama/bge-m3` or `mxbai-embed-large` (1024), `openai/text-embedding-3-small` (1536, can be shortened with the `dimensions` parameter). pgvector's HNSW indexes `vector` up to 2000 dims.
- The loader refuses `openrouter/` for `MODEL_EMBEDDING` (D41). The doctor embeds a fixed string and checks that the length equals `MODEL_EMBEDDING_DIMS`.
- Mock mode (`TRIAGE_MOCK_MODE=true`) uses a deterministic hashing-trick embedder (bag of words into N dims). It makes no call and gives lexical similarity that eval assertions can rely on. This keeps "never real calls in dev/evals" true.
- Embeddings are derived data. After `finish_report` writes the report, a post-settle step embeds. If that step fails or the process dies, `triage runs reembed --missing` backfills. Changing the model means truncating `run_embeddings` and re-embedding from `source_text`, which takes seconds at this scale.

### 3.6 Query shapes that matter

1. **Similar past cases for a new thread (ingress):** embed the redacted `request` text, then `ORDER BY embedding <=> $q` over kinds `case`/`request` with `model = $m`, `origin IN ('live','legacy')`, `run_id <> $self`, and verdict not `wrong`. Take the top k above `TRIAGE_SIMILAR_CASES_MIN_SCORE`. Rank verdict=correct first on ties.
2. **Cluster by root cause (offline, Proposal 4):** pull `root_cause` and `feedback` vectors for a window and cluster in a script. The output is candidate `patterns.json` entries or candidate categories for human review. This is not a runtime path.
3. **Is this systemic?** Compare the current draft root cause against the last N days. This is a phase-2 tool use (3.7).
4. **Plain relational queries** such as tier delta vs verdict, cost per tier, and runs with no `matched_pattern_id`. These are the main benefit of separate tables, with or without vectors.

HNSW, not IVFFlat. HNSW needs no training data and can be created on an empty table. IVFFlat's `lists` must be tuned after data exists and it needs rebuilds as data drifts. At fewer than 10k rows an exact scan would also be fine (**I**). Known HNSW catch: a filtered query can return fewer than k rows. pgvector 0.8 has iterative index scans for this, from general knowledge. **U** which pgvector version the target Postgres has.

### 3.7 Similar cases: ingress step, tool, or both

- **v1: ingress step only.** After identity and before the classifier (D22), `store.findSimilar` returns up to `TRIAGE_SIMILAR_CASES_K` prior cases. They go to the classifier as dynamic few-shot examples and into `initialData.prior_cases`. The result is projected down to `{run_id, category, root_cause_statement, status, matched_pattern_id, verdict, faster_path, similarity}`. `id_chain` is dropped and UUID-shaped tokens are scrubbed, because A11 lets UUIDs through the persisted profile. The instruction presents them as untrusted reference data. Tier policy ignores them: only curated `stable` patterns may lower a tier (02:194). If the store or embedder fails, `prior_cases` is empty and a gap is recorded. The run is never blocked. This is deterministic, needs no model decision, and adds no model-reachable I/O, so D2/D3 are untouched.
- **Phase 2: a narrow tool** `find_similar_cases {basis: 'current_ask' | 'draft_root_cause', text: string ≤ 300, k ≤ 5}` on `Triage` only, behind `TRIAGE_SIMILAR_CASES_TOOL=false`. It reads the app's own redacted store, never an entity, so it is not "entity I/O" in D3's sense. Still, it is the first orchestrator tool that takes free text, so it waits until evals show the ingress version helps.
- **patterns.json stays curated.** Similarity never edits it. Clustering produces candidates in a staging folder (like `fixtures/_unreviewed/`, D27), and a human promotes them in a PR. That is where Proposal 4 hooks in.

### 3.8 Migration path

1. v1: interface + folder provider. Tools write through the store. `origin` recorded. Embeddings optional.
2. Add the Postgres provider. `triage runs import --from folder --to postgres` is idempotent by run_id and copies files and embeddings. Then switch `TRIAGE_RUNSTORE_PROVIDER`.
3. Optional cold start: `triage runs import-legacy <refs dir>` redacts old `slack_thread.md` + `findings.md` into a staging area. A human reviews it, and it is stored with `origin='legacy'`.

Evals run against a temp folder store with `origin='eval'`, so they never enter the live corpus. The eval tool's own results (Proposal 1) are not RunStore data. Eval cases can be exported from runs that have feedback.

## 4. Env keys to add (names only)

```
TRIAGE_RUNSTORE_PROVIDER=        # folder | postgres. folder uses TRIAGE_RUNS_DIR. Separate from TRIAGE_DB_PROVIDER (Flue runtime, D38)
TRIAGE_RUNSTORE_URL=             # postgresql:// DSN for the run store (schema "triage"); may be the same server as TRIAGE_DB_URL; blank for folder
MODEL_EMBEDDING=                 # provider/model, e.g. ollama/nomic-embed-text | openai/text-embedding-3-small. openrouter refused. Blank disables embeddings and similar cases
MODEL_EMBEDDING_DIMS=            # vector size; must match the model output (doctor checks); fixes vector(n) in Postgres
TRIAGE_SIMILAR_CASES_K=          # prior cases passed by ingress to classifier and orchestrator; 0 disables
TRIAGE_SIMILAR_CASES_MIN_SCORE=  # cosine similarity floor, e.g. 0.75; tune with evals
TRIAGE_SIMILAR_CASES_TOOL=       # false in v1; true mounts find_similar_cases on Triage (phase 2)
```

Reused: `TRIAGE_RUNS_DIR`, `TRIAGE_AUDIT_LOG`, `OLLAMA_BASE_URL`, `OPENAI_API_KEY`.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unredacted text lands in a shared DB with backups (bigger blast radius than a laptop folder) | `Persisted<T>` brand from `redact.ts` only; providers re-scan; there is no raw-thread column; unit test that every store method rejects an unbranded value |
| Customer text sent to an embedding provider | Only persisted-profile text; OpenRouter refused; Ollama possible as local default; D41 already allows OpenAI to receive the more sensitive model-facing data |
| Stored model-written text re-injected into later runs (persistent prompt injection) | Structured, length-capped projection; labelled untrusted; verdict=wrong excluded; advisory only, never in tier policy |
| Cross-customer leakage via prior cases (UUIDs pass, A11) | Drop `id_chain`, scrub UUID-shaped tokens in the projection; `scope.ts` (D26) denies any foreign id anyway |
| Anchoring: the model copies a similar case's conclusion | Advisory only; evals compare runs with and without `prior_cases`; the verdict is shown next to each case |
| Eval or mock runs pollute the corpus | `origin` column; similarity filters to live/legacy |
| Embedding model change breaks dims or index | Embeddings are derived; `reembed` rebuilds from `source_text`; doctor checks dims |
| pgvector missing or no `CREATE EXTENSION` privilege | Doctor warns; similarity disabled; the rest of the store works |
| Store down | `createRun` failure stops ingress before dispatch; a mid-run write failure is a tool error the model retries; the audit JSONL is written locally first |
| Legacy refs import leaks PII (refs are unredacted, 1.1) | Staging + human review before import; `origin='legacy'`; the D24 residual risk is larger here because ingress never saw those Slack profiles |
| Flue DB holds the raw thread and model-facing data with no deletion (1.3) | Out of scope, but flagged as open question 4. The run store's `deleteRun` does not reach it |

## 6. Decisions to add or change (drafts)

### D42. Run storage is a `RunStore` interface; folder is the default, Postgres is the second provider (refines D38)
- **Chosen**: `src/store` with `folder` (today's `.data/runs/<run_id>/` layout plus `meta.json`) and `postgres` (schema `triage`: runs, run_evidence, run_reports, run_audit, run_feedback, run_embeddings, idempotency). Selected by `TRIAGE_RUNSTORE_PROVIDER` + `TRIAGE_RUNSTORE_URL`. Tools receive the store by closure. Keyed by `run_id`, which is also the Flue instance id and the audit key. The HTTP idempotency key moves into the store.
- **Rejected**: keeping run data in Flue persistence (model-facing data, no deletion, Flue says keep business data out); dual write; a dedicated vector DB; sqlite-vec for now.
- **Consequence**: `useAgentStart` no longer writes `input.json`; ingress's `createRun` is the only writer.

### D43. Only persisted-profile data reaches the run store and the embedding provider (refines D24, D41)
- **Chosen**: a `Persisted<T>` brand produced only by `redact.ts`; providers re-scan with check semantics. "Text stored alongside embeddings" means the redacted text that was embedded. Images are never stored by the run store.
- **Rejected**: storing the raw thread for better embeddings.

### D44. Embeddings are derived, configurable and rebuildable
- **Chosen**: `MODEL_EMBEDDING` + `MODEL_EMBEDDING_DIMS`; in-repo clients for Ollama and OpenAI (pi-ai has none); OpenRouter refused. Kinds: case, request, root_cause, evidence per entity, feedback. pgvector `vector(n)`, cosine, HNSW. The folder provider does brute-force cosine over `embeddings.json`. Mock mode uses a deterministic hashing embedder. `triage runs reembed` rebuilds.
- **Rejected**: IVFFlat (needs training data and rebuilds); embedding whole report Markdown or per message (noisy); Voyage (not in D41's provider list).

### D45. Similar cases are an ingress step in v1; a narrow orchestrator tool is phase 2 (refines D22; keeps D2, D3)
- **Chosen**: ingress passes up to `TRIAGE_SIMILAR_CASES_K` projected prior cases (no ids) to the classifier and in `initialData`. Tier policy ignores them. `find_similar_cases` stays behind `TRIAGE_SIMILAR_CASES_TOOL=false` until evals show value.
- **Rejected**: a tool-only design (the model decides whether to look, so the lookup is untestable); feeding similarity into tier policy (unreviewed data would lower cost tiers).

### D46. Learning from runs produces candidates; `patterns.json` changes only by PR (refines D27's pattern)
- **Chosen**: clustering output goes to a staging folder; a human promotes it. Eval runs are stored with `origin='eval'` and excluded from the corpus.

## 7. Open questions for the owner

1. Where does the run store live: the same Postgres server as `TRIAGE_DB_URL` in a separate `triage` schema, or a separate database? Both work with the proposed keys.
2. Confirm that the "raw text alongside embeddings" in the proposal means redacted text.
3. Default embedding provider: local Ollama or OpenAI `text-embedding-3-small`?
4. The Flue DB keeps the raw dispatched thread and model-facing tool results forever (1.3). Accept that as is, or open a separate item (for example, dispatch the redacted thread plus ids)?
5. Cold start: import reviewed, redacted legacy refs into the corpus?
6. Build the Postgres provider in v1, or ship v1 with interface + folder and add Postgres with the server deployment?
7. Retention: how long are runs kept, and is `deleteRun` needed for erasure requests?

## 8. Rejected alternatives (collected)

- Folder only, no interface: blocks shared server use and queries.
- Run data in Flue persistence: model-facing profile, append-only, off limits by Flue's own guidance.
- Dedicated vector DB: extra infra and another data destination.
- sqlite + sqlite-vec now: extension loading under `node:sqlite` is unknown; can be added later behind the interface.
- Dual-write tee: two sources of truth; replaced by `triage runs import`.
- Full-text only: misses paraphrase. It stays useful as a hybrid add-on, and exact codes remain the job of `patterns.ts`.
- Embedding the raw thread, whole report Markdown, or single messages: raw is disallowed; the others are noisy.
- IVFFlat: training and rebuild overhead for no gain at this scale.
- Voyage or OpenRouter embeddings: outside D41.
- Similarity as a tool only, or as a tier-policy input in v1: untestable, and lets unreviewed data change cost tiers.
- Storing fixtures in the run store: fixtures need PR review (D27) and stay files.
- An ORM: a handful of tables; plain parameterised SQL on `pg`, which the Flue Postgres blueprint already uses (ecosystem_databases-postgres.md:43-80).

## Assumptions

- The ~150-run scale of refs/ is a fair guide to volume for the first year (**I**, from survey 08:6).
- The target Postgres (RDS or other) can install pgvector (**U**; from general knowledge RDS supports it).
- The embedding model facts in 3.5 come from general knowledge and were not verified in this session.

