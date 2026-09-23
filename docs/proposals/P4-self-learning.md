# P4. Self-learning from past runs and cases

Source: workflow wf_d09cca81-92f, 2026-09-23. Research agent (Opus) then adversarial critic (Opus). Read-only; no file in either workspace was changed. Status: **proposal, not decided**. Decisions it touches: D2, D5, D9, D16, D19, D23, D24, D25, D27, D29, D37, D38, D39, D41.

## Summary

Recommendation: learning happens offline and produces reviewable artifacts only. The running agent never changes itself. A new `triage learn` CLI reads finished runs and their feedback, writes proposals (JSON with run_ids and evidence), and a human turns an accepted proposal into a PR. The runtime reads only what is merged (`resources/taxonomy.json`, `knowledge/patterns/patterns.json`, `knowledge/**` skills). Past runs are also read, but only those a trusted human graded correct.

v1 includes four things. (1) Feedback becomes append-only and records who gave it and where it came from. (2) An open-set taxonomy: a fixed category enum kept in `resources/taxonomy.json`, a new `other` category with a free-text `proposed_category`, and a `taxonomy_version` stamped on every run. `other` routes to the strong tier. (3) `triage learn scan` proposes new categories, new patterns (always `stable: false`), knowledge-note fixes and eval cases. (4) Retrieval of similar past cases into the orchestrator's initial data, built behind a flag that stays off until an eval shows it helps. In v1 retrieval matches on structured fields; embeddings plug in once Proposal 2 (pgvector) lands.

Tuning tier thresholds from eval outcomes waits for v2 and only produces a report. There are 4 labelled cases today and about 30 cases a month, too few to tune 12 categories x 3 tiers.

Two decisions for you: which feedback sources count as trusted (my suggestion: CLI and signed Slack buttons, with HTTP feedback confirmed first), and whether `triage learn accept` should open the PR with gh or only create a local branch.

## Questions for the owner

- Boundary: should all learning be offline proposals that reach the runtime only through a merged PR (or, for past-case retrieval, a trusted 'correct' verdict), with no model-callable memory tool? yes/no
- Taxonomy: move categories to a versioned resources/taxonomy.json, add 'other' with proposed_category, stamp taxonomy_version on every run, and route 'other' to the strong tier? yes/no
- Retrieval of similar past cases: A) build it in v1 behind TRIAGE_RETRIEVAL_ENABLED=false and switch it on after an A/B eval, or B) defer it to v2
- Trusted feedback: A) only CLI and signed Slack buttons count, HTTP feedback needs confirming, or B) every verdict counts as given
- Proposal to PR: A) triage learn accept creates a local branch only, or B) it also opens the PR with gh after asking you
- Slack reviewer corrections in v1: A) operator enters them with triage feedback only, or B) also add a harvest-slack command that reads the reviewer's thread replies (real Slack read, off by default)

---

## Critic verdict: sound_with_changes

**Conflicts with decisions**

| Decision | Conflict | Resolution |
|---|---|---|
| D16 / D42 (proposed) PR gate | The report infers that learned changes reach the runtime only after a merged PR plus rebuild. But resources/ and knowledge/patterns/patterns.json are read from TRIAGE_HOME at runtime (02-hld-detailed.md:112, :157), and in dev Flue picks up skill edits automatically (guides_skills.md:95). `triage learn accept` applies the change on a local branch, so on a laptop where TRIAGE_HOME is that checkout, unmerged changes affect live runs straight away. | Make `accept` work in a separate git worktree outside TRIAGE_HOME. Also stamp the git commit and a dirty flag for resources/ and knowledge/ in every report, and warn in doctor when the tree is dirty and mock mode is off. |
| D42 boundary 3 (proposed) vs retrieval (D46) | The grep test covers src/agents, src/classify and src/gate. Retrieval runs in src/ingress and reads run-store feedback rows at runtime. So learning data enters through the one directory the boundary test leaves out. | Name ingress/retrieval.ts as the only runtime reader of learning data, and extend the grep test to check that nothing else reads it. |
| Rule 5 / D45 (TRIAGE_PATTERN_STALE_DAYS, last_confirmed_at) | `last_confirmed_at` either lives in patterns.json, which needs a PR for every confirmation, or is computed from the run store at runtime. The second option means the tier policy reads learning data, which breaks boundary 5 (hints never change the tier) and the PR gate. | Pick one. Simplest: drop TRIAGE_PATTERN_STALE_DAYS from v1 and handle staleness only through the offline `stale` scan and a demotion PR. |
| D29 feedback.md vs D44 append-only records | D29 writes feedback.md in the eval front-matter, which evals consume. D44 adds append-only feedback rows. The report does not say which one is authoritative, so there would be two feedback stores. | Keep one append-only source (feedback.jsonl in the run folder, or run-store rows) and generate feedback.md from it for evals. |
| D19/D27 mock default, no real calls in evals | Retrieval at ingress reads the local run store, which is not an I/O tool, so mock/strict mode does not cover it. Evals would pull whatever real (redacted) runs sit on the developer's machine. The A/B eval also cannot measure anchoring with the faux provider. | In mock mode, retrieval reads only a reviewed fixture corpus, or is forced off. Record that the A/B needs real model calls against mocked tools, and ask the owner whether D19 allows that. |
| D24 two redaction profiles | `pii_scan`/exact-value scan is a new, separate check, where the design already has persisted/egress check semantics in finish_report. | Reuse redact.ts egress check semantics (refuse on miss) for proposals. Do not add a third mechanism. |
| D40 rules files empty / D5 registries | Proposal.target.path is free-form, so a learn proposal could target resources/<entity>.api.rules.json, an entity registry or knowledge/method (the always-on instruction). | Allowlist the targets: taxonomy.json, patterns.json, knowledge/<skill>/SKILL.md, eval cases. Exclude rules files, registries and .env. knowledge/method gets its own reviewer. |

**Factual errors found**

- The report cites D38 as '(separate tables)'. D38 only says TRIAGE_DB_PROVIDER/TRIAGE_DB_URL select the Flue adapter (docs/05-decisions.md:183-184) and says nothing about app tables.
- Inference 1.2 ('knowledge changes only reach the runtime through a rebuild, so they are naturally gated by a PR') does not hold. guides_skills.md:95 says dev picks up skill edits automatically, and patterns.json and resources/ are read at runtime from TRIAGE_HOME (02-hld-detailed.md:112, :157).
- The report says 'I have not reproduced [PII] here', but it cites a refs directory by its full name, which contains a person's first name (the `imps-decoding-error-<name>-2026-07-31` row). survey/08-past-cases-taxonomy.md:6 says such directory names contain customer first names and masks them as <name>.
- Minor: the 'no scheduler' line is advanced_schedules.md:19, not :18.
- The v1 scope is inconsistent. The v1 list names taxonomy, pattern, knowledge and eval_case, but the CLI example and the risk table treat the `stale` kind and TRIAGE_PATTERN_STALE_DAYS as available.

**Missing**

- Which feedback source is authoritative (feedback.md from D29 or the D44 records), and whether evals keep reading the old front-matter.
- How evals 'pin' a taxonomy version when only one taxonomy.json exists at runtime. It needs either historical files or alias resolution in the grader.
- That taxonomy.json replaces the classifier's current prompt input, 'the category table from 00-lay-of-the-land.md §5' (04-lld-multi-entity-request.md:127). The prompt construction changes, and the classifier may go through OpenRouter (D41).
- What text is embedded or matched at query time for a new run, which has no root cause yet, and under which redaction profile.
- Whether `source: cli` can be written by a coding agent. Under D28 the Claude Code skill runs `triage feedback` non-interactively, so a model could self-grade as 'trusted cli'.
- How `accept` produces data for PR descriptions and branch names on GitHub (Proposal 5). Rationale and excerpts would leave the run boundary. The PII mitigation covers committed files only.
- A data-volume check. With about 30 cases a month, 4 labelled cases, and a threshold of 3 runs across 2 customers, how many proposals would v1 realistically produce? The report does not estimate it.
- A target allowlist for proposals, and a separate review path for knowledge/method.

**Security or data risks**

- Cross-customer exposure through retrieval. The persisted profile leaves UUIDs unmasked (A11, 02-hld-detailed.md:148), so another customer's customer_id or form_id in a past report's root-cause text or an operator's faster_path would be injected into this run's brief and sent to the tier model provider. D26 blocks querying those ids but not showing them. All hint fields need id stripping, not only query_recipe.
- PII in learned artifacts is already shown in this report, which names a customer through a refs directory name. Proposals built from run folders face the same residual risk as D24: names ingress never saw.
- GitHub egress: a PR opened by `learn accept` via gh carries the rationale and evidence excerpts outside the run boundary. The same egress check must run on the PR body and the branch name.
- Feedback poisoning through the coding-agent CLI path. 'cli' does not prove a human gave the verdict. Record the interface (tty vs skill) and do not count skill-originated verdicts as trusted unless a human confirms them.
- initialData is stored durably in Flue's tables (guides_building-agents.md:254 context). similar_cases therefore end up in the Flue store too, and a later redaction fix cannot clean them.

**Simplifications**

- v1 should capture signals only: append-only feedback, `other` + proposed_category, taxonomy_version on every run, and a `triage learn scan` that writes a Markdown report. Defer accept/PR automation, fingerprints, superseded states and JSON-patch bodies until there is enough data to need them.
- Defer retrieval (D46) to v2 entirely. An A/B on 4 labelled cases cannot show that 'agreement does not drop', so the flag would stay off and the code would sit unused.
- Drop run_relabels, retired_by and aliases from v1. With 11 categories and about 30 cases a month, a version number plus a changelog line in taxonomy.json is enough.
- Keep only the env keys that D4 allows (model ids, feature flags, paths): MODEL_LEARN, MODEL_EMBEDDING, TRIAGE_RETRIEVAL_ENABLED, TRIAGE_LEARN_DIR. Move the thresholds to constants or resources/learn.json. Hard-code the trusted feedback sources, since a security policy should not be an .env knob.
- Reuse the egress check from finish_report instead of a new pii_scan structure.
- Drop TRIAGE_PATTERN_STALE_DAYS. The offline stale scan plus a demotion PR is enough and keeps rule 5 free of runtime data.

### Critique

## Critique: Proposal 4 (self-learning)

**Verdict: sound with changes.** The core choice holds up: offline proposals, a human PR, and no model-callable memory tool. It fits D2, D16 and the "config is read-only to the runtime" mistake entry (docs/05-decisions.md:236). Most cited facts check out: the enum of 11 values plus `unknown` (docs/04-lld-multi-entity-request.md:131-133), rules 1/2/5 (docs/02-hld-detailed.md:190-198), feedback.md persisted redacted (docs/03-data-flow.md:72), 4 eval cases with verdicts (3 correct, 1 partial), 151/143 refs entries, the survey counts (survey 08:26-27, :39, :85), static skill imports (guides_skills.md:58, :222), the database cautions (guides_database.md:186, :192), `initialData` being ignored on an existing instance (guides_building-agents.md:254), and no embeddings in pi-ai (my grep found nothing). The problems are in the enforcement claims, the v1 size and some data paths.

### 1. The PR gate is not enforced as the report claims
- **FACT**: `resources/` and `patterns.json` are read from `TRIAGE_HOME` at runtime (02:112, :157). Flue dev mode picks up skill edits automatically (guides_skills.md:95).
- **INFERENCE**: `triage learn accept` "applies the change on a new local branch". On a laptop where `TRIAGE_HOME` is that checkout, the next real run uses the unmerged change. The report's inference that a rebuild gates changes "naturally" (1.2) does not hold.
- **Fix**: `accept` works in a separate worktree. The report records the commit and a dirty flag for `resources/` and `knowledge/`. Doctor warns on a dirty tree when mock mode is off.

### 2. Decisions quietly touched
- **D42 boundary 3**: the grep test covers agents, classify and gate. Retrieval runs in `src/ingress` and reads feedback rows, so the boundary test misses the one runtime reader of learning data.
- **Rule 5 / D45**: `last_confirmed_at` plus `TRIAGE_PATTERN_STALE_DAYS` means either a PR for every confirmation, or the tier policy reading the run store at runtime. The second breaks the report's own boundary 5. Drop the env key from v1.
- **D29 vs D44**: the report does not say whether feedback.md, which evals consume, or the new append-only records are the source of truth. Keep one and render the other.
- **D19/D27**: retrieval reads the local run store, which is not an I/O tool, so mock/strict mode does not cover it. Evals would pull the developer's real runs. The A/B "with vs without" cannot measure anchoring on the faux provider. It needs real model calls against mocked tools, and the owner has to say whether D19 allows that.
- **D24**: `pii_scan` is a third mechanism. Reuse the egress check semantics from `finish_report`.
- **D40/D5**: `Proposal.target.path` is free-form. Allowlist the targets and exclude `*.api.rules.json`, the registries and `.env`. `knowledge/method` is the always-on instruction and deserves its own reviewer.
- **D38** is cited as "(separate tables)". D38 says nothing about tables (05:183-184).
- **D4**: most of the 10 new keys are thresholds, not "host, credential, model id, feature flag". `TRIAGE_LEARN_TRUSTED_FEEDBACK_SOURCES` makes a security policy an env knob. Setting it to `http` quietly re-opens the poisoning path that D25 closed. Hard-code it.

### 3. PII and data leaving the boundary
- **The report leaks PII itself.** It cites a refs directory whose name contains a person's first name, right after saying it reproduced no PII. survey 08:6 masks these as `<name>`. That is exactly the failure the learn job's "exact-value scan" is meant to stop, and it slipped past a careful author.
- **Cross-customer hints.** UUIDs pass the persisted profile (A11, 02:148). A past run's root-cause text or an operator-typed `faster_path` can carry another customer's `customer_id`, which retrieval then puts into this run's brief and sends to the tier provider. D26 stops the model querying that id but not seeing it. Strip ids from every hint field, not just `query_recipe`.
- **GitHub.** A PR opened via gh (Proposal 5) puts the rationale and excerpts outside the boundary. The mitigation covers committed files only and should also cover the PR body and branch name.
- **Flue store.** `similar_cases` in `initialData` become durable rows in Flue's tables, which a later redaction fix cannot clean up.
- **Trusted "cli".** Under D28 the Claude Code skill runs `triage feedback` non-interactively, so a coding agent can grade its own run and count as a trusted source. Record the interface (tty or skill) and require human confirmation for skill-originated verdicts.

### 4. Flue claims
Verified, apart from two issues: the schedules citation is off by one line (it is :19), and the rebuild-gating inference is wrong (section 1). The report's rejection of workspace skills is right: they need a sandbox (guides_skills.md:176, :233), which D2 forbids.

### 5. Duplicate mechanisms
- `tier_floor` in taxonomy.json and `tier_hint` in patterns.json sit alongside the policy table as two more tier inputs. Say which one wins, or drop `tier_hint`.
- `kind: eval_case` duplicates A9 (refs conversion) and `triage fixtures review` (D27). It is acceptable if it only drafts into the same review queue.
- Moving the taxonomy to taxonomy.json quietly replaces the classifier's prompt input ("the category table from 00 §5", LLD:127). Say so.

### 6. v1 is too big for the data
With about 30 cases a month, 4 labelled cases, and a threshold of at least 3 runs across 2 customers, v1 will produce few proposals. Yet it ships a proposal schema with JSON patches, fingerprints, supersession, a relabels table, aliases/`retired_by`, 10 env keys and a retrieval feature that stays off. A leaner v1:
- capture only: append-only feedback, `other` + `proposed_category`, `taxonomy_version`
- `triage learn scan` producing a Markdown report
- retrieval and `accept` automation moved to v2.

The report does separate v1 from v2, but the stale scan appears in both.

### 7. What the owner has to decide
- Whether the learn A/B and LLM-judge evals may make real model calls (D19 as written covers I/O, not models).
- Whether `other` goes to `strong` (fine under D9) and whether retrieval is in v1 at all.

---

## Full report

# Proposal 4: Self-learning from past runs and cases

Legend: **F** = fact I read (path:line). **I** = my inference. **U** = unknown. Paths starting `docs/` are relative to `/Users/varun/code/work/triage-app`. `refs/` means `/Users/varun/code/work/triage-shivalik/refs/`.

## 1. What exists today (facts)

### 1.1 Learning signals already in the design
- **F** The classifier's `category` is a closed enum of 11 values plus `unknown`. `subcategory` is a free string (docs/04-lld-multi-entity-request.md:131-133). There is no `other` and no taxonomy version.
- **F** `unknown` means the classifier failed or returned invalid output. Policy rule 1 then forces the `strong` tier (docs/02-hld-detailed.md:110, :190).
- **F** Policy rule 2 hard-codes the strong categories `{beneficiary, funding_in, systemic}` (docs/02-hld-detailed.md:191). Rule 5 lets a `matched_pattern_id` whose pattern is `stable` lower the tier by one step (:194). The thresholds are "initial values to tune with evals", and `stable` is set by a human in a PR (:198).
- **F** A `patterns.json` entry looks like `{id, category, signature: {regex[], services[]}, entities[], query_recipe, tier_hint, stable, source_ref}`. It is seeded from the notes' known-issue sections, `refs/harbor-error-classification/taxonomy.json` and the FD buckets (docs/02-hld-detailed.md:257). `patterns.ts` does a cheap regex/service/category match (:112).
- **F** The classifier takes "few-shot examples from redacted `refs/` cases" (docs/04-lld-multi-entity-request.md:127). That set is static.
- **F** `triage feedback <run_id> --verdict correct|partial|wrong|pending [--actual-root-cause] [--faster-path]` writes `feedback.md` using the old eval front-matter (docs/02-hld-detailed.md:270, docs/04-lld-multi-entity-request.md:260-262, D29 at docs/05-decisions.md:147-150). `feedback.md` is persisted redacted (docs/03-data-flow.md:72).
- **F** Fixtures are recorded to `fixtures/_unreviewed/` and a human promotes them with `triage fixtures review`. Nothing is auto-committed (docs/02-hld-detailed.md:151, D27 at docs/05-decisions.md:137-140). This is the promotion pattern I reuse below.
- **F** Config is read-only to the runtime ("Token written into `.env`" is a recorded mistake, docs/05-decisions.md:236). Thread text is untrusted (rule 10, docs/01-hld-birds-eye.md:79).
- **F** The HTTP API has one shared bearer, and `requested_by` is self-declared (docs/02-hld-detailed.md:286). HTTP feedback therefore has no verified author.
- **F** The v2 Slack bot will post with Yes / No / Comment buttons, and the signed interaction counts as proof (D39, docs/05-decisions.md:186-187).

### 1.2 Framework facts that constrain the mechanism
- **F** Skill imports are static and packaged at build time. A dynamic import is a build error (`.claude/skills/flue-framework/references/guides_skills.md:58`, `:95`, `:222`). **I**: knowledge changes only reach the runtime through a rebuild, so they are naturally gated by a PR.
- **F** Flue has no scheduler; something outside Flue fires and calls `dispatch()` (`references/advanced_schedules.md:18`).
- **F** You should not run application migrations against Flue's tables, and the store format is reset-only (`references/guides_database.md:186`, `:192`). **I**: learning data (run index, proposals, embeddings) needs its own tables, which is Proposal 2's run store.
- **F** Flue ignores `initialData` on an existing instance (docs/02-hld-detailed.md:294). **I**: retrieved hints have to be computed in ingress before dispatch and passed in initial data.
- **F** The installed pi-ai has no embeddings API: grepping `node_modules/@earendil-works/pi-ai/dist` for "embedding" found nothing. **I**: embeddings need a small separate client.

### 1.3 The data
- **F** refs/ has 151 entries (143 directories). Only 4 eval cases carry a verdict (`refs/eval-cases/`). refs/ is gitignored (`triage-shivalik/.gitignore:12`).
- **F** Survey counts: about 129 triage cases bucketed into 11 categories (docs/00-lay-of-the-land.md:63-75). 39 notes matched an already documented pattern, and 14 directories correct a first-pass conclusion (docs/survey/08-past-cases-taxonomy.md:26-27).
- **I** The older template dates from May–Jul (survey 08:39), so the volume is roughly 25–35 cases a month.
- **F** Prior learning loop: the knowledge notes grew "Known issue" sections by hand. Examples are `shivalik/rhythm/AGENTS.md:85`, `:103`, `:145` ("Transfers disabled" banner, which matches eval case `2026-07-03-transfers-disabled`). The old eval runner graded by grepping for the service name anywhere in the text (docs/survey/04-skills-agents.md:277).
- **F** `refs/harbor-error-classification/` is an offline clustering precedent. It groups Quickwit error signatures into categories with a definition, count and confidence (`taxonomy.json` keys: category, confidence, count, group, role, subsystem; `README.md` "Method").
- **F** refs notes contain unredacted names and phones (survey 08:85). I saw a customer's full name in plain text in one findings file while sampling. I have not reproduced it here.

### 1.4 What a correction looks like (10 sampled hits)
I grepped refs for correction wording and read the passages around each hit.

| Case | What the first pass got wrong | Kind of lesson |
|---|---|---|
| `beneficiary-wrong-mpin-p1788771204/report.md:9-16` | Blamed a self-clearing rate limit; the failure persisted after the window | wrong mechanism; test the time window |
| `sim-verification-paused-a4817a03/findings.md:104-108` | Treated `device_registrations` as SIM binding; it is the push-token table | knowledge gap (table meaning) |
| same file `:190-249` | Correction #2 once Quickwit was reachable: SMS latency, not a harbor bug; CX advice revised | a gap filled later; conclusion overturned |
| `stale-balance-cache/findings.md:3,25-29` | Redis cache hypothesis refuted; two balance fields | knowledge gap (field semantics) |
| `transfers-disabled-fd87cf3c/investigation.md:7-10`, eval case `:22-24` (verdict `partial`) | Stale point-in-time read reported as final | method rule, not a pattern |
| `debit-card-view-stuck-199fb32a/findings.md:155-184` | Told CX to "tap Issue Card"; that path does not exist for this state | wrong CX instruction; code check |
| `mpin-confirm-fails-16dd431e/findings.md:111-114` | Misread `mpin_count_after_challenge` | knowledge gap (column semantics) |
| `bank-details-blank-loading-5db501b7/findings.md:30-35` | Mixed up an internal admin caller with the customer's app | method rule (check caller/User-Agent) |
| `imps-decoding-error-ishani-2026-07-31/findings.md:279-282` | Known UTC/IST pattern was the prior; logs ruled it out | **known-pattern false match** |
| `welcome-letter-not-triggered-44f85302/findings.md:76`, `notary-init-error-new-passport-d9d817de/findings.md:69` | Not corrections; "correction" is domain wording (data correction) | the keyword detector is noisy |

**I** from the sample:
- (a) Most corrections are knowledge gaps about what a table or field means, or method slips. Few of them are new patterns.
- (b) A matched known pattern can be wrong, so patterns and retrieved cases must be presented as hypotheses to test.
- (c) The first pass and the final answer sit in the same file, so ground truth is the last section, not the first.
- (d) Keyword detection of corrections gives false positives (2 of 10 sampled).

## 2. Options considered

| # | Option | Summary |
|---|---|---|
| O1 | Online weight updates / fine-tuning | Train on graded runs |
| O2 | Agent-writable memory (a `remember` tool writing to knowledge or patterns during a run) | Learns immediately |
| O3 | Offline proposals + human PR; runtime reads only promoted artifacts | Batch job, reviewable diffs |
| O4 | Auto-merge proposals above a confidence threshold | O3 without the human |
| O5 | Retrieval-time learning: inject similar approved past cases into the brief | No policy change, cheap |
| O6 | Automatic prompt optimisation (DSPy-style) | Rewrites instructions against evals |
| O7 | Taxonomy as a free-text category | The classifier names whatever it sees |
| O8 | Taxonomy as a fixed enum + `other` + `proposed_category`, clustered offline, promoted by PR | Open set with a review gate |
| O9 | A Flue "Learner" agent with a durable conversation | Runs learning as an agent |

## 3. Recommendation and how it plugs in

**O3 + O5 + O8.** Learning is split into two kinds.

- **Retrieval-time learning** (cheap, safe, reversible): similar approved past cases and pattern hints go into the orchestrator's initial data. No rule changes.
- **Policy learning** (taxonomy, patterns, `stable` flags, tier thresholds, knowledge text): each change is a proposal, and each proposal becomes a PR. The runtime sees it only after merge and rebuild.

**v1**: feedback capture, taxonomy open set, `triage learn scan` proposals (taxonomy, pattern, knowledge, eval case), and retrieval built behind a flag that is off by default.
**v2**: tier-threshold tuning (report only), Slack-button feedback, embedding clustering if Proposal 2 is not ready for v1.

### 3.1 Hard boundaries
1. No weight updates of any kind.
2. Everything learned is a file in git (JSON/Markdown) or a row in the run store. The file is gated by a PR. The row is gated by an explicit verdict from a trusted source.
3. The runtime (`src/agents`, `src/classify`, `src/gate`) never imports `src/learn` and never reads `TRIAGE_LEARN_DIR`. A unit test greps for both, the same trick D32 uses.
4. Learning jobs run outside the request path. They read only persisted-profile data (run folders, run store). In dev and evals they use the faux provider (D19; your rule: no real calls in dev or evals).
5. Retrieved hints never change the tier, `matched_pattern_id` or escalation. Rules 1–7 and the D23 triggers stay as they are.

### 3.2 Use cases

| # | What is learned | Signal | Artifact | Who approves | v |
|---|---|---|---|---|---|
| 1 | New categories (taxonomy drift) | runs with `category=other` (`proposed_category`), `confidence<0.6`, feedback `actual_category` ≠ classified | proposal → edit `resources/taxonomy.json`, bump `version` | PR reviewer | v1 |
| 2 | New or updated patterns | runs graded `correct` (or `partial` with `actual_root_cause`) that share a root cause across ≥`TRIAGE_LEARN_MIN_SUPPORT` runs and ≥2 distinct customers; evidence queries from `EntityFindings.evidence[].query_or_path` (docs/02-hld-detailed.md:93) with IdChain values templated to `$customer_id` etc. | proposal → `patterns.json` entry, `stable:false` | PR reviewer; flipping `stable` is a separate PR | v1 |
| 3 | Knowledge fixes | new optional `note_evidence` field `knowledge_conflicts[] {skill, claim, observed, evidence_ref}`; the method instruction asks for it when a skill note was wrong (e.g. the `device_registrations` and `mpin_count_after_challenge` corrections above) | proposal → Markdown diff to `knowledge/<skill>/SKILL.md` | PR reviewer | v1 |
| 4 | Tier thresholds | graded runs by category × tier: verdict rate, cost from `report.cost`, escalation rate | report + proposed diff to policy values | PR reviewer | v2 |
| 5 | Similar cases at ingress | run-store rows with a trusted `correct` verdict | none new; read at runtime | the verdict itself | v1 (flag off) |
| 6 | Eval fixtures and cases | real-mode runs graded `correct`/`partial` with recording on | eval-case proposal + fixtures in `_unreviewed/` | `triage fixtures review` (D27) + PR | v1 |
| 7 | Reviewer corrections ("actually it was X") | v1: operator runs `triage feedback` (the Claude Code skill asks after showing the report). v2: Slack No/Comment button (D39) | feedback row | operator (v1); signed Slack user (v2) | v1/v2 |

### 3.3 Open-set taxonomy (changes D9, 02 §4.3 rules 1–2)
- `resources/taxonomy.json` (structure lives in `resources/`, per D5):
  `{version: 3, categories: [{id, description, subcategories_hint[], tier_floor?: "mid"|"strong", aliases[], retired_by?}]}`.
- The classifier's Valibot `picklist` is built from this file at startup, plus two fixed values:
  - `other`: the classifier worked but nothing fits. It must fill `proposed_category` (snake_case) and `proposed_category_reason`.
  - `unknown`: the classifier failed (unchanged).
- Policy: rule 1 becomes "invalid output, `unknown` or `other` → strong" (fail upward, as D9 says). Rule 2 reads `tier_floor` from the file instead of the hard-coded set, so a new category can carry its own floor without a code change.
- `taxonomy_version` is recorded in `classification.json`, `report.json` and the run store. Evals pin the version they were written for.
- Categories are never deleted. They get `retired_by: <new id>`, and `aliases` keep old labels resolvable. History is never rewritten: a relabel is a separate run-store row (`run_relabels {run_id, taxonomy_version, category, by}`).
- Clustering over `other` and low-confidence runs:
  - Before Proposal 2 lands: group by normalised `proposed_category` and `subcategory`, then one `MODEL_LEARN` pass to merge near-duplicates.
  - After: agglomerative clustering on embeddings of the redacted `current_ask` + root-cause statement.
  - A cluster needs ≥`TRIAGE_LEARN_MIN_SUPPORT` runs and ≥2 distinct customers before it becomes a proposal.
  - An eval case whose expected answer is `other` stops the classifier from forcing everything into old buckets.

### 3.4 `triage learn` CLI
```
triage learn scan [--since 30d] [--kinds taxonomy,pattern,knowledge,eval_case,stale]
triage learn list [--status open] | show <proposal_id>
triage learn accept <proposal_id>      # applies the change on a new local branch, runs loaders + doctor + evals
triage learn reject <proposal_id> --reason "…"
```
- Built as plain pi-ai structured calls on `MODEL_LEARN`, not a Flue agent (same reasoning as D9a).
- Proposals go to `TRIAGE_LEARN_DIR` (default `.data/learn/`, gitignored) and to a `learn_proposals` table once Proposal 2 exists.
- Rejected proposals keep a `fingerprint`, so the same proposal is not raised again.
- Scheduling: manual in v1. Later, a weekly external cron (launchd or CI) runs `scan`; Flue has no scheduler.
- `accept` creating the PR depends on Proposal 5 (gh) and on your branch rule. See the open questions.
- The `stale` kind: for each pattern with `code_refs[{repo, file, lines, commit}]`, compare against the repo commit recorded by D37. If the cited files changed, or the pattern has not been confirmed within `TRIAGE_PATTERN_STALE_DAYS`, propose revalidation or clearing `stable`.

### 3.5 Proposal schema
```ts
type Proposal = {
  proposal_id: string; fingerprint: string; created_at: string; learn_run_id: string;
  kind: 'taxonomy_category' | 'pattern_new' | 'pattern_update' | 'pattern_demote'
      | 'knowledge_fix' | 'eval_case' | 'tier_policy';
  status: 'open' | 'accepted' | 'rejected' | 'superseded'; status_by?: string; status_reason?: string;
  taxonomy_version: number;
  target: { path: string; pointer?: string };                  // e.g. knowledge/patterns/patterns.json#/…
  change: { format: 'json_patch' | 'markdown_diff'; body: string };
  rationale: string;                                           // model draft, egress-redacted
  evidence: { run_id: string; feedback_id?: string; evidence_ref?: string; excerpt_redacted: string }[];
  stats: { support_runs: number; distinct_customers: number;
           verdicts: { correct: number; partial: number; wrong: number }; window: { from: string; to: string } };
  risks: string[];
  generated_by: { model: string; prompt_version: string };
  pii_scan: { passed: boolean; exact_values_checked: number; patterns_checked: string[] };
};
```
When `triage learn scan` re-runs, it recomputes `stats`. If a verdict it relied on was superseded and support falls below the threshold, the proposal becomes `superseded`.

### 3.6 Feedback (extends D29)
- Append-only records:
  `{feedback_id, run_id, at, by, source: cli|http|slack_button|slack_harvest, verdict, actual_root_cause?, actual_category?, actual_service?, faster_path?, supersedes?}`.
- The latest record from a trusted source wins.
- `TRIAGE_LEARN_TRUSTED_FEEDBACK_SOURCES` defaults to `cli,slack_button`. An `http` record is a candidate until someone confirms it with `triage feedback --confirm <feedback_id>`.

### 3.7 Retrieval (use case 5)
- Computed in ingress after classification, before dispatch. The result goes into `Triage.initialData.similar_cases[]` (top `TRIAGE_RETRIEVAL_TOP_K`).
- Each item carries `run_id`, category, root-cause statement, the confirming query recipe (templated) and `faster_path`, all from report and feedback fields, never raw thread text.
- The method instruction frames them as "hypotheses to test with their query; a match is not evidence". The report records `hints_shown[]` so graders can spot anchoring.
- Matching: v1 structured (same category/subcategory/`matched_pattern_id`/services); later pgvector (Proposal 2) with `TRIAGE_RETRIEVAL_MIN_SIMILARITY`.
- Enabled only after an A/B eval (with vs without) shows root-cause agreement does not drop.

### 3.8 Decisions touched
- **Changed**: D9 (classifier schema), D29 (feedback).
- **Refined**: 02 §4.3 rules 1, 2, 5.
- **Depends on**: D2 (no runtime self-modification), D5 (taxonomy in `resources/`), D16 (knowledge fixed here), D19/D27 (mock and fixture promotion), D23 (escalation unaffected), D24 (redaction plus an exact-value scan), D37 (commit per repo for staleness), D38 (separate tables), D39 (Slack buttons as feedback), D41 (which providers get data; applies to embeddings). Also depends on Proposal 2 (store, pgvector) and Proposal 5 (gh).

## 4. Env keys to add (names only)
```
# Where triage learn writes proposals (gitignored). Default .data/learn
TRIAGE_LEARN_DIR=
# Model for offline learn jobs (cluster naming, knowledge diffs). Blank = MODEL_TIER_STRONG
MODEL_LEARN=
# Minimum distinct graded runs before a pattern or category is proposed. Default 3
TRIAGE_LEARN_MIN_SUPPORT=
# Minimum distinct customers behind a proposal (stops one long thread counting three times). Default 2
TRIAGE_LEARN_MIN_DISTINCT_CUSTOMERS=
# Feedback sources that count without confirmation. Default cli,slack_button
TRIAGE_LEARN_TRUSTED_FEEDBACK_SOURCES=
# Inject similar approved past cases into the orchestrator's initial data. Default false
TRIAGE_RETRIEVAL_ENABLED=
# Number of past cases injected. Default 3
TRIAGE_RETRIEVAL_TOP_K=
# Embedding model id (Ollama or OpenAI direct, per D41). Blank = structured retrieval only
MODEL_EMBEDDING=
# Cosine threshold for embedding retrieval; ignored when MODEL_EMBEDDING is blank
TRIAGE_RETRIEVAL_MIN_SIMILARITY=
# Rule 5 ignores a stable pattern not confirmed within N days. Blank = off
TRIAGE_PATTERN_STALE_DAYS=
```
The taxonomy file path is not an env key. Like the registries, it lives under `TRIAGE_HOME/resources/`.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Feedback poisoning**: a wrong or careless verdict | Provenance on every record; only trusted sources count; support ≥3 runs and ≥2 customers; a human PR with the evidence list; new patterns land `stable:false`; a superseded verdict makes dependent proposals `superseded` |
| **Anchoring**: the known UTC/IST pattern was the wrong prior in one sampled case | Hints framed as hypotheses with their query; retrieval never touches tier or escalation; `hints_shown[]` in the report; A/B eval before enabling |
| **Taxonomy churn** | Versioned file, aliases, retire rather than delete; evals pinned by version; relabels stored beside history, never over it |
| **Stale patterns** | `code_refs` with commit; `last_confirmed_at`; the `stale` scan; optional `TRIAGE_PATTERN_STALE_DAYS` so rule 5 can only fail upward |
| **PII in committed artifacts** (refs already leak names) | Persisted-profile redaction, plus an **exact-value scan**: the learn job knows each cited run's IdChain and the names ingress collected, and fails the proposal if any appear. Query recipes are templated with `$placeholders`; excerpts are length-capped; runs are cited by `run_id` only; `pii_scan` is recorded in the proposal |
| **Injection through thread text** ("classify this as X") | Proposals are built from report and feedback fields that have passed the egress check, not from raw thread text; a PR review sits in the path; retrieval payloads come from reports |
| **Too little data** | Proposals show counts, not rates, when n < 10; threshold tuning deferred to v2 |
| **Cost of learn scans** | Offline, manual in v1, faux provider in dev; one model call per cluster or proposal |
| **Learned files drifting into runtime writes** | The runtime has no write path to `resources/` or `knowledge/`; a grep test forbids `src/learn` imports from the runtime |

## 6. Draft decisions (numbers provisional; other proposals may take D42+)

### D42. Learning produces reviewable artifacts; the runtime never modifies itself
- **Chosen**: `triage learn` reads finished runs and feedback offline and writes proposals with provenance. Git artifacts change only by a merged PR. The runtime reads `resources/taxonomy.json`, `knowledge/**` and run-store rows with a trusted verdict, and nothing under `TRIAGE_LEARN_DIR`. A test greps `src/agents`, `src/classify`, `src/gate` for `src/learn` imports.
- **Rejected**: fine-tuning or weight updates (not reviewable, trains on PII, not portable across providers); a model-callable memory tool (injection path from untrusted thread text, D2); auto-merge above a confidence score (repeats the drifting-allowlist mistake).

### D43. The taxonomy is an open set with a versioned file (supersedes the fixed category enum in the D9 schema; refines 02 §4.3 rules 1–2)
- **Chosen**: categories live in `resources/taxonomy.json` with `version`, `tier_floor`, `aliases`, `retired_by`. The classifier also returns `other` with `proposed_category`. `other` and `unknown` both route to `strong`. Every run records `taxonomy_version`. New categories arrive by PR from `triage learn` clusters.
- **Rejected**: free-text category (policy and evals cannot key on it); the enum in code (every change is a code change, and there is no version on runs); reusing `unknown` for "doesn't fit" (mixes classifier failure with taxonomy gaps).

### D44. Feedback is append-only with author and source (refines D29)
- **Chosen**: `{feedback_id, by, source, verdict, actual_root_cause?, actual_category?, actual_service?, faster_path?, supersedes?}`. `TRIAGE_LEARN_TRUSTED_FEEDBACK_SOURCES` defaults to `cli,slack_button`; HTTP feedback needs `triage feedback --confirm`.
- **Rejected**: one mutable `feedback.md` (a changed verdict erases what learning relied on); counting HTTP feedback directly (shared bearer, self-declared author, D25).

### D45. Patterns grow by proposal and start unstable
- **Chosen**: `patterns.json` entries gain `confirmed_by[]` (run_ids), `last_confirmed_at`, `code_refs[{repo, file, lines, commit}]`, `created_from` (proposal_id). New entries always have `stable:false`; flipping `stable` is its own PR. A `stale` scan proposes demotion when cited code changed or confirmation is old.
- **Rejected**: patterns promoted from a single run; `stable` set by the learn job.

### D46. Retrieval of similar approved cases is v1 behind a flag, off by default
- **Chosen**: ingress computes `similar_cases[]` from runs with a trusted `correct` verdict and passes them in initial data. Hints are hypotheses and never change tier or escalation. Structured match first, embeddings when Proposal 2 lands. The flag is enabled after an A/B eval.
- **Rejected**: retrieval over raw `refs/` (unredacted, gitignored); feeding retrieval into the classifier's tier choice (a past verdict would lower cost without evidence); a mid-run retrieval tool (another tool surface; the brief is enough in v1).

### D47. Tier-threshold tuning is v2 and report-only
- **Chosen**: `triage learn scan --kinds tier_policy` reports verdict rate, cost and escalation per category × tier and may propose a diff. It does not run until there are enough graded runs per bucket.
- **Rejected**: automatic threshold adjustment; tuning on the 4 labelled cases.

## 7. Open questions for the owner
1. Who reviews learning PRs: you, the Slack reviewer from `.env`, or both?
2. Should `triage learn accept` open the PR with gh (Proposal 5)? Your rule is to ask before creating a remote branch, so accept would ask each time. The alternative is to stop at a local branch.
3. Retrieval in v1: build it behind the flag now, or defer the whole thing to v2?
4. Should the redacted `refs/` conversions that become eval cases (A9) also seed the retrieval corpus once reviewed?
5. Record fixtures on every real run (more eval candidates, more review work), or only when the operator passes `--record`?
6. Is "`other` → strong tier" acceptable on cost, or should `other` with confidence ≥ 0.8 go to `mid`?
7. v1 Slack corrections: operator-entered only, or also a `triage learn harvest-slack` that reads the reviewer's replies after the post (a real Slack read, off by default) and drafts unconfirmed feedback?

## 8. Rejected alternatives (with reason)
- **O1 fine-tuning**: not available across the three providers; trains on customer data; no diff to review.
- **O2 agent-writable memory**: thread text is untrusted (rule 10). A write tool is the injection path, and it breaks "config is read-only to the runtime".
- **O4 auto-merge**: the old workspace's allowlist drifted to 67 entries without review. The same failure, applied to knowledge.
- **O6 prompt optimisation**: needs far more labelled cases than 4, and produces opaque instruction changes. Could be a later `kind` of proposal.
- **O7 free-text category**: rule 2 and the evals need a fixed vocabulary.
- **O9 Flue Learner agent**: a batch job needs no durable conversation. It would double the machinery for structured calls, the same reasoning as D9(a).
- **Flue workspace skills discovered at runtime** (`guides_skills.md:176`): needs a sandbox (D2 says no) and bypasses the PR.
- **Keyword correction detection over refs**: 2 of 10 sampled hits were false positives.
- **Storing learning state in Flue's tables**: Flue forbids app migrations on its store (`guides_database.md:186`).
- **promptfoo or Braintrust as the learning store**: they are eval tooling (Proposal 1). Their results feed `tier_policy` proposals, but the source of truth stays in git and the run store.

## Assumptions
- A-L1: Proposal 2 provides a run store with app-owned tables, and pgvector as an option. Without it, v1 uses the run folders plus a sqlite index.
- A-L2: About 30 cases a month (inferred from the refs dates, not measured).
- A-L3: `.data/` will be gitignored. **F**: it is not in `.gitignore` today.
- A-L4: The embedding provider falls under D41 (Ollama or OpenAI direct), and it only ever sees persisted-profile text.

## Unknowns
- **U**: how often the classifier will use `other` rather than forcing a fit. Only evals will tell.
- **U**: whether a Slack reply from someone other than the configured reviewer should ever count as feedback.
