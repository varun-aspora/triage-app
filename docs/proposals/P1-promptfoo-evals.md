# P1. Eval tooling: integrate promptfoo

Source: workflow wf_d09cca81-92f, 2026-09-23. Research agent (Opus) then adversarial critic (Opus). Status: **decided 2026-09-23 → D42 in 05-decisions.md** (owner: eval models configurable per provider; pseudonyms yes; commit reviewed cases starting with the 4 verified; v1 = contract + classifier suite; no root_cause.service field). Decisions it touches: D4, D9, D18, D19, D24, D25, D27, D29, D41, A9.

## Summary

Recommendation: add promptfoo on top of Vitest; don't replace Vitest. Vitest keeps the fixed-script tests that run on every PR: the fake model (pi-ai fauxProvider) plus mock mode, no model spend. promptfoo runs the case-file suites against real models and compares models. There are two suites: (1) the classifier alone, with the IdChain passed in, so it needs no fixtures, and (2) the full Triage run, which reads recorded fixtures in strict mock mode and is graded on the report JSON. Both are driven by one TypeScript provider that calls the same run function the CLI uses.
Drop vitest-evals. Its generated harness needs createAgentRouter, which D25 keeps unmounted.
No real prod calls, in layers: a separate .env.eval with no entity credentials at all; the provider refuses to start unless TRIAGE_MOCK_MODE=true, TRIAGE_MOCK_STRICT=true and TRIAGE_RECORD_FIXTURES=false; every case fails if its audit lines show any I/O that did not come from a fixture.
Facts that shape this: there are 4 labelled cases and 89 refs folders with both a thread and findings, but no recorded tool outputs anywhere. The full-run suite can therefore start with only the 4 cases, and only after fixtures are written for them. One of the 4 cases has unmasked account numbers, so conversion must run the redactor and cannot trust the old questionnaire.
Design risk: Flue's docs say agents that import SKILL.md (this design does) don't load in plain in-process test runners. Promptfoo and the planned in-process Vitest evals both hit this. A spike is needed, with the `triage run --json` subprocess as the fallback.
Decisions for you: (a) may evals call real LLM APIs (Anthropic/OpenAI) with redacted fixture content, or only Ollama and the fake model; (b) may reviewed, redacted cases and fixtures be committed to git.

## Questions for the owner

- A or B: A = promptfoo for real-model suites on case files plus Vitest for fixed-script (fake-model) contract tests; B = promptfoo for everything. (Recommend A.)
- Yes/no: may evals call real LLM APIs (Anthropic/OpenAI) with redacted fixture content, as long as every entity I/O is mocked and the eval env holds no entity credentials? If no, the default is Ollama plus the fake model.
- Yes/no: drop vitest-evals, since its generated harness needs createAgentRouter, which D25 keeps unmounted?
- Yes/no: commit human-reviewed, redacted eval cases and fixtures to the triage-app repo (otherwise they live outside git, next to refs/)?
- Yes/no: record redacted fixtures by default on real runs (into fixtures/_unreviewed/<run_id>/) so `triage evalset add <run_id>` turns feedback into full-run eval cases?
- Yes/no: add root_cause.service {entity, service} to the Report schema so service attribution can be graded in code instead of by the judge?

---

## Critic verdict: sound_with_changes

**Conflicts with decisions**

| Decision | Conflict | Resolution |
|---|---|---|
| D4 | Fallback option E runs `triage run ... --env .env.eval`. D4 explicitly rejects `--env` flags, and the Mistakes list names `--env` as a past failure. The new EVAL_* prefix is also outside D4's naming list (MODEL_*, TRIAGE_*, entity prefixes). | Select the eval config with `TRIAGE_HOME` pointing at an eval home (02:157), and rename the keys to TRIAGE_EVAL_*. |
| D20 | The `no_real_io` hard gate reads `transport: mock` from audit lines. The audit schema at 02-hld-detailed.md:149 has no transport field, so the proposal adds an audit field without naming D20. | Add a D20 refinement that adds a `transport: real/mock` field, or have the mock layer write a separate marker. |
| D5 | The `.env.eval` file leaves every entity credential and URL blank. D5's loader 'fails at startup if a listed var is missing', and the docs do not say whether a blank value counts as missing. | State that the loader checks for presence only when mock mode is off, or give `.env.eval` placeholder non-routable values. Then test it. |
| D29 / LLD 04 §2.10 | `triage feedback` writes feedback.md with the old front-matter (04-lld:262). The proposal adds case.yaml as a second ground-truth format, plus a separate `evalset add` command. | Keep one format: have `triage feedback` write the case.yaml draft directly, or make case.yaml the feedback format. Drop `evalset add`. |
| D27 / 02 §3 mock.ts | Per-case `evals/cases/<id>/fixtures/` and `triage evalset review` add a second fixture location and a second promotion command. The design already has `fixtures/`, TRIAGE_FIXTURES_DIR and `triage fixtures review` (02:151). | Use one fixtures tree with case ids as subfolders, and one review command that promotes both fixtures and cases. |
| 02:78 (static SKILL.md imports) / D18 | The proposal treats the SKILL.md loading problem as a spike with three workarounds. It does not consider changing how skills are loaded. | Offer defineSkill() built from knowledge/**/SKILL.md read at runtime via TRIAGE_HOME (guides_skills.md:97-111). This removes the build dependency for Vitest, promptfoo and bun alike. |
| D26 | The `scope` hard gate passes only when there is no audit deny for injected out-of-scope ids. A deny means the gate worked, so a hard gate on 'no deny' grades model behaviour, not safety. | Hard gate: no out-of-scope id was ever allowed. Soft metric: the model did not attempt one. |

**Factual errors found**

- Citation path is wrong: `refs/2026-08-22-mpin-city-required.md:30` does not exist. The file is `refs/eval-cases/2026-08-22-mpin-city-required.md`. Line 30 is `notes:` and does contain a 9+ digit run (checked by count only).
- A-e3 is understated. Real pi-ai `Model` has a required `cost: ModelCost` (pi-ai/dist/types.d.ts about line 660) and `calculateCost` exists (models.d.ts:170). But `Report.cost` holds token counts only, with no USD (04-lld:254), so EVAL_MAX_COST_USD needs the driver to compute USD itself or the schema to change.
- The `point_in_time` metric is presented as a new graded check, but `current_state[].taken_at` is already a required string in the Report type (04-lld:242), so the `schema` gate covers it unless it also checks that the timestamp is valid and fresh.
- The `tier_delta` metric is described as 'binary' ('Every assert is binary') yet scores over-by-one as 0.5. The two statements contradict each other.
- The process note admits printing three default flag values from .env.example, which breaks the key-names-only instruction. Harmless here, but it should not repeat.

**Missing**

- No v1 or later label. Suite 2 cannot run in v1 because zero fixtures exist (verified: no fixture dirs in refs/). The report should say that v1 = contract tests plus classifier suite, and full Triage suite later.
- Masking ids as `****last4` (persisted profile, 02:148) breaks eval consistency. The IdChain var, the thread text, the fixture semantic keys (sorted param values, 02:151) and the scope.ts id-shape checks (D26) all need the same well-formed stand-in id. Eval material needs deterministic pseudonymisation (keyed, format-preserving), not masking.
- Offline `evalset import` has no Slack profile lookup, and the persisted profile's name masking depends on names collected by ingress (02:148). Customer names in free text of 89 imported threads will pass, which widens the D24 residual risk well beyond live runs.
- Suite 1 'needs no fixtures' only because IdChain and basic state are vars. The 89 refs folders have no recorded state, so someone must hand-write basic state per case from prose. If that is skipped, suite 1 tests thread-only classification, which D22 rejected.
- The race on process.env: suite 1 runs several promptfoo providers in one process, each with a different MODEL_CLASSIFIER. That is only safe if classify() takes the model as an argument rather than reading env.
- Driver lifecycle: one Flue runtime per process (advanced_evals.md:225). The driver needs separate boot/stop and runCase functions. If faux is used, start({providers}) replaces the default set (index.d.mts:78-84), which clashes with 02:306's rule to call start() without providers. The report does not say who calls start().
- Taxonomy drift: the owner's item 4 says categories will change. Case files hard-code `expected.category` against the enum at 04-lld:130-132 and need a taxonomy version or a migration rule.
- promptfoo's llm-rubric falls back to a default grading provider (INFERENCE: OpenAI) when none is set. The report does not say that EVAL_JUDGE_MODEL must be wired as the explicit grader, or that a missing grader must fail rather than fall back.
- D-number collision: the proposals for the other four items in this workflow will also draft D42+. These need renumbering on merge.
- Ownership of promptfoo (INFERENCE from general knowledge, unverified: acquired by OpenAI in 2026). This is relevant to the telemetry, sharing and remote-generation defaults the report disables.

**Security or data risks**

- Names in imported refs threads pass the persisted redaction profile, because no ingress name list exists offline (02:148, D24). The risk is highest if Q2 answers 'commit cases to git'.
- promptfoo's local results DB and HTML viewer store vars and outputs, including tool_calls[] with model-facing inputs. PROMPTFOO_CONFIG_DIR under .data helps, but only if that key name is right, and it is unverified.
- Suite 1 sends converted thread text to OpenRouter models. D41 allows OpenRouter only for the classifier and only on the redacted thread. This holds only if import redaction is reliable, and the report already shows the old redaction was not.
- If mock were bypassed, blank credentials give nothing to connect to. But if the D5 loader forces non-blank values, someone may paste real ones into .env.eval to 'make it start'. The refuse-if-set check in the driver is the real guard and needs a unit test.
- The judge receives expected root-cause text and the report. This is acceptable under D41 only if the judge model is Anthropic, OpenAI direct or Ollama, and never OpenRouter.

**Simplifications**

- Replace the three SKILL.md loading workarounds with runtime defineSkill() over knowledge/**/SKILL.md (guides_skills.md:97-111). One change to 02:78 makes the agent loadable under bun, Vitest and promptfoo with no spike.
- Derive service attribution from `root_cause.code_refs[].repo` through the D5 registry, which already maps services to repos, before adding `root_cause.service` to the Report (D45). Add the field only if that mapping proves ambiguous.
- Cut the 11 env keys to about 3 (TRIAGE_EVAL_JUDGE_MODEL, TRIAGE_EVAL_MAX_COST_USD, PROMPTFOO_CONFIG_DIR). Trials, cases dir and output dir are promptfoo config or CLI flags (`--repeat`, `-o`). The telemetry and update keys go in the package.json script, not in env docs.
- Merge `triage evalset add` into `triage feedback`, and `triage evalset review` into `triage fixtures review`. That gives one capture path and one promotion path.
- Drop the separate `point_in_time` metric, which is covered by schema.
- For v1, consider running only the classifier suite (suite 1) in promptfoo and deferring suite 2 and the driver's promptfoo provider until there are enough reviewed full-run cases with fixtures to make it meaningful.

### Critique

## Critique: Proposal 1 (promptfoo)

**Verdict: sound, with changes.** The layering is right: Vitest with the fake model for contract tests, promptfoo for real-model case suites, one shared driver. Most of the proposal's own citations check out. The problems are gaps and quiet conflicts, not the core idea.

### What I verified (FACT)
- 02-hld-detailed.md:309, :151, :277, :285, :302 and :78 say what the report claims.
- advanced_evals.md:13, :18, :44, :225 and :227 match, including "Build-resolved imports break in-process evals".
- ecosystem_tooling-vitest-evals.md:24-25 does require `createAgentRouter`, which D25 does not mount. :171-175 and :196-204 match too.
- `start({providers})` replaces the default provider set (node_modules/@flue/runtime/dist/node/index.d.mts:78-84).
- The fake-model factory signature is right (faux.d.ts:29-31, 51).
- Old workspace: 4 cases, 126 lines, verdicts 3 correct and 1 partial. The two hooks are identical. 151 entries in refs/, 118 threads, 94 findings, 89 folders with both, and no fixture directories. The hook comment at :14 says "67 sentinel files against 3 saved cases".
- One citation is wrong: the PII file is `refs/eval-cases/2026-08-22-mpin-city-required.md:30`, not `refs/…:30`. Line 30 is `notes:` and holds a 9+ digit number (checked by count, not printed).

### Decision conflicts the report does not name
1. **D4.** Fallback E uses `triage run … --env .env.eval`. D4 rejects `--env` flags, and the Mistakes section lists `--env` as a past failure. Use `TRIAGE_HOME` pointing at an eval home (02:157). The `EVAL_*` prefix is also outside D4's list; use `TRIAGE_EVAL_*`.
2. **D20.** The `no_real_io` hard gate reads `transport: mock` from audit lines. The audit schema (02:149) has no such field, so this is an audit-schema change and should be named as one.
3. **D5.** A credential-free `.env.eval` may not start: the registry loader "fails at startup if a listed var is missing". The docs do not say whether a blank value counts as missing (UNKNOWN). State that presence is checked only when mock mode is off.
4. **D29 and LLD 04 §2.10.** `triage feedback` already writes the old front-matter (04-lld:262). case.yaml plus `evalset add` makes a second ground-truth format and a second capture command. Keep one.
5. **D27.** `evals/cases/<id>/fixtures/` and `triage evalset review` duplicate `fixtures/`, `TRIAGE_FIXTURES_DIR` and `triage fixtures review` (02:151). Use one fixtures tree and one review command.
6. **D26.** The `scope` hard gate passes when there is "no deny for injected out-of-scope ids". A deny is the gate working. Make the hard gate "no out-of-scope id was ever allowed" and the model's restraint a soft metric.
7. **02:306 against the driver.** 02:306 says `start()` is called without `providers`, so the Ollama registration survives. The fake-model path passes `providers`, which replaces that registration. Also, one runtime per process means the driver must separate boot/stop from `runCase`. The report does not say who owns `start()`.

No conflict found with D2, D3, D13 or D35: the driver adds no tools, no shell and no Slack path. D40 makes `no_mutation` trivially true today, which is fine as a regression guard.

### PII leaving the boundary
- **Offline import cannot mask names.** The persisted profile masks names "collected by ingress from Slack profiles and the bot template fields" (02:148). An offline import of 89 old threads has no such list, so customer names in free text pass. That turns D24's accepted residual risk from "occasional" into "systematic" for the eval set. Keep this in mind when answering Q2 (commit cases to git).
- **Masking breaks the evals.** `****last4` cannot satisfy scope.ts's id-shape checks (D26). It collapses distinct accounts that share the same last four digits, and it must match exactly across the thread text, the IdChain var and the fixture semantic keys (02:151). Eval material needs deterministic, format-preserving pseudonyms: keyed, so they are consistent across a case, and well-formed, so the gates behave as they do in production. This is a design addition the report misses (INFERENCE).
- **Judge fallback.** The judge must be wired explicitly. INFERENCE: promptfoo's llm-rubric falls back to a default grading provider (OpenAI) when none is set. A missing EVAL_JUDGE_MODEL should fail, not fall back. Under D41 the judge must not be OpenRouter.
- **Unverified env names.** All PROMPTFOO_* names are INFERENCE, as the report says. They must be verified before relying on sharing and telemetry being off. INFERENCE, unverified: promptfoo was acquired by OpenAI in 2026. Check its current defaults when pinning a version.

### Flue and pi-ai API claims
- The loading problem is real (advanced_evals.md:227). The report misses the simplest fix: `defineSkill()` (guides_skills.md:97-111) built at runtime from `knowledge/**/SKILL.md` through `TRIAGE_HOME`. This changes 02:78 only. It removes the build dependency for bun, Vitest and promptfoo, and it removes the spike. The cost is losing build-time frontmatter validation, which a unit test can replace.
- A-e3 can be upgraded to FACT. Real pi-ai `Model` has a required `cost` field (pi-ai types.d.ts about line 660) and `calculateCost` exists (models.d.ts:170). But `Report.cost` holds tokens only (04-lld:254), so the USD cap must be computed in the driver, and it is checked between cases, not mid-run.
- Suite 1's "one provider entry per MODEL_CLASSIFIER" races on `process.env` inside one promptfoo process. `classify()` must take the model as an argument.

### Second mechanisms and bloat
- There are 11 new env keys. Trials, cases dir and output dir are promptfoo config or CLI flags (`--repeat`, `-o`). About 3 keys are enough.
- `point_in_time` duplicates the `schema` gate, because `taken_at` is required at 04-lld:242.
- Before adding `root_cause.service` (D45), try deriving the service from `code_refs[].repo` through the D5 registry, which already maps services to repos.
- `tier_delta` is called binary but scores 0.5. Pick one.

### v1 or later
The report never says. Given zero fixtures (FACT), suite 2 is not runnable in v1 except on hand-written fixtures for the 4 cases. My suggestion: v1 = contract tests plus the classifier suite in promptfoo. Suite 2 and the full-run provider come once reviewed full-run cases exist. Note also that suite 1's "all 89 from day one" needs hand-written basic state per case. Without it, suite 1 grades thread-only classification, which D22 rejected.

### Also missing
- A taxonomy version on `expected.category`, because the owner's item 4 says categories will change (enum at 04-lld:130-132).
- D42-D45 will collide with the drafts from the other four proposals and need renumbering.

### Questions I would add for the owner
1. Should eval material use keyed pseudonyms rather than masking? Yes or no.
2. May `defineSkill()` at runtime replace static SKILL.md imports, which removes the spike? Yes or no.
3. v1 = contract tests plus classifier suite only? Yes or no.

---

## Full report

# Proposal 1: eval tooling with promptfoo

Legend: **FACT** = read in a file. **INFERENCE** = my conclusion. **UNKNOWN** = not verified. Anything I say about promptfoo comes from general knowledge, because promptfoo is not installed anywhere I could read (no `promptfoo` under `triage-app/node_modules`, and `package.json` only lists pi-ai, @flue/cli and @flue/runtime). So every promptfoo claim below is INFERENCE unless a file is cited.

## 1. What exists today (facts)

**Old workspace (triage-shivalik)**
- `refs/eval-cases/` holds 4 files, 126 lines in total. Each is YAML front-matter with `input` (problem, identifiers, ref), `investigation` (root_cause, service, db_evidence, queries, sometimes code_evidence) and `ground_truth` (verdict, actual_root_cause, faster_path).
  - Verdicts: 3 `correct` and 1 `partial`. The partial case reported a stale DB read as final (`refs/eval-cases/2026-07-03-transfers-disabled.md:22-24`).
- None of the 4 cases has a `category` label, a tier label or an entity list. They record the problem as one line, not the thread. Three of the matching threads survive as `refs/<dir>/slack_thread.md`, for example `refs/harbor-cbs-fuzzycheck-zenduty-6849/`, `refs/transfers-disabled-fd87cf3c/` and `refs/mpin-processing-stuck-dc295f43/`. The link from each case to its folder is my INFERENCE, based on the id prefixes.
- `refs/2026-08-22-mpin-city-required.md:30` carries unmasked account numbers in `notes`. The questionnaire's "REDACT PII" instruction (`.claude/hooks/triage-eval-capture.sh:83`) was therefore not reliable.
- `refs/` has 151 entries. 89 folders contain both `slack_thread.md` and `findings.md`. Across all folders there are 118 `slack_thread.md` and 94 `findings.md`, plus some `investigation.md`/`report.md`. **No folder contains recorded tool outputs** (I found no fixtures directory). Survey 08 counts 14 folders that contain a correction of a first-pass conclusion (`docs/survey/08-past-cases-taxonomy.md:27`).
- `.claude/hooks/triage-eval-capture.sh` and `.codex/hooks/triage-eval-capture.sh` are byte-identical (`diff` returned nothing). The Stop hook fires when `prod-access.log` has a line newer than session start (`:68-73`). It injects an AskUserQuestion questionnaire (`:79-104`) and writes `refs/eval-cases/<date>-<slug>.md` with the template at `:106-129`. Its own comment reports "67 sentinel files against 3 saved cases" (`:14`), and survey 06 counts 82 sentinels against 4 cases today. Capture is high-friction and rarely completed.

**New design (triage-app)**
- Plan (`docs/02-hld-detailed.md:309`): Vitest `*.eval.ts`, in-process, mock and strict on, `fauxProvider().provider` via `start({providers})` when the model must be scripted. Seeds are the 4 cases plus redacted `refs/` conversions. Grading covers classification, tier delta, entity coverage, service attribution and an LLM judge for root cause. `triage feedback` writes the old front-matter.
- D18 (`docs/05-decisions.md:89-91`) picks Vitest because Flue's harness is Vitest. D19 (`:93-95`) and D27 (`:137-140`) make mock the default and strict in evals, with fixtures recorded to `fixtures/_unreviewed/` and promoted by a human. D29 (`:147-150`) turns eval capture into `triage feedback`. A9 (`:215`) assumes `refs/` may be converted after redaction.
- Mock layer: fixtures keyed by a semantic key per tool, and a strict miss is a loud tool error (`docs/02-hld-detailed.md:151`).
- The CLI is built on `start()` + `init().dispatch()` + `read()` (`docs/02-hld-detailed.md:277`). `createAgentRouter(Triage)` is not mounted in v1 (`:285`, D25 `docs/05-decisions.md:127-130`).
- Skills are static SKILL.md imports "via a generated import map" (`docs/02-hld-detailed.md:78`).
- Report schema (`docs/04-lld-multi-entity-request.md:238-255`) has `classification.proposed.category`, `tier_final`, `entities_consulted`, `root_cause {statement, code_refs, matched_pattern_id}`, `status`, `cx_answer` and `cost`. **It has no field naming the service the root cause lives in.** Classification enum: `04:130-145`.

**Flue and pi-ai (verified in files)**
- Flue has no eval framework. An eval is a Vitest test over `init()` or `@flue/sdk`, and "they spend real tokens" (`.claude/skills/flue-framework/references/advanced_evals.md:13,18`).
- One runtime per process (`advanced_evals.md:225`).
- **"Build-resolved imports break in-process evals … such as a SKILL.md import … should be evaluated over HTTP instead"** (`advanced_evals.md:227`). SKILL.md imports are resolved by the Flue Vite plugin at build time (`guides_skills.md:58,95`). The plugin ships in `node_modules/@flue/vite/dist/markdown-import-plugin-*.mjs`.
- The vitest-evals blueprint requires `createAgentRouter(...)` in `app.ts` (`ecosystem_tooling-vitest-evals.md:24-25`) and warns that judges roughly double spend (`:196-204`).
- `start()` accepts `providers?: readonly Provider[]`, which **replaces** the default set (`node_modules/@flue/runtime/dist/node/index.d.mts:78-84`).
- `fauxProvider()` is in-memory, with `setResponses` and `FauxResponseFactory(context, options, state, model)` (`node_modules/@earendil-works/pi-ai/dist/providers/faux.d.ts:29-31,51,96`). It can only be scripted from inside the same process.
- `flue run <path> --data <json> --env <path> --json` exists and works with SKILL.md imports (`cli_run.md:18,30`; `guides_skills.md:95`).

## 2. Options considered

| # | Option | Summary |
|---|---|---|
| A | Keep the current plan: Vitest plus vitest-evals only | Nothing new to learn. But the vitest-evals harness needs the router D25 rejects, and it has no case-file format, no side-by-side model comparison, no viewer and no built-in repeat. |
| B | Replace Vitest with promptfoo for everything | One tool. But faux-scripted tests need per-call factories and tight in-process control, which promptfoo is not built for. PR gating also works better as a normal test job. |
| C | **Add promptfoo on top**: Vitest for faux-scripted contract tests, promptfoo for case-file and real-model suites | Two tools, one shared driver. |
| D | promptfoo against the HTTP API with its built-in http provider | No custom code. But it needs a running server and polling, only sees the egress-redacted report, and cannot read the audit log or tool trajectory. |
| E | promptfoo `exec:` provider that spawns `triage run --json` per case | Always works if the CLI works. Slower, and no faux. |
| F | Hosted platforms (Braintrust, Jetty) | Send content to a third party; D41 limits which providers may receive data. |

## 3. Recommendation (option C) and how it plugs in

### 3.1 Three layers

| Layer | Runner | Model | Entity I/O | Cadence | What it proves |
|---|---|---|---|---|---|
| Unit | `bun test` | none | none | every PR | gate, rules, sql, redact, scope (as today, D18) |
| Contract | Vitest `src/evals/contract/*.test.ts` | faux, scripted | mock, strict | every PR | pipeline plumbing: ingress → classify → policy → dispatch → `finish_report`; the `instrument()` tripwire; strict miss surfaces; escalation triggers fire the strong synthesis; redaction refusal loop. Costs nothing and gives the same result every run. |
| Model evals | promptfoo | real models (Ollama, Anthropic, OpenAI per D41) | mock, strict | on demand / nightly | classifier accuracy per model; full Triage quality per tier config |

vitest-evals is not installed. Vitest stays because D18 already has it, and contract tests need faux, which only works in-process.

### 3.2 One driver, three callers

`src/evals/driver.ts` exports `runCase(caseSpec, {models?, faux?})`. It does the same thing as `triage run`: normalise → identity (mock) → classify → policy → `init(Triage).dispatch()` → `read()`. It returns `{report, tool_calls[], audit[], cost, wall_ms}`. Tool calls come from `read()`'s `onEvent` `tool-input` chunks (`advanced_evals.md:44`). Audit lines are read from the run folder. The CLI, the Vitest contract tests and the promptfoo provider all call it, so "a case" means the same thing everywhere.

**Loading problem (must be spiked first).** The driver imports the Triage agent, which imports SKILL.md files. Under promptfoo's own TS loader, and under plain Vitest, that import is not resolved (`advanced_evals.md:227`). This also affects the current plan in `02:309`. Three ways out, in order of preference:
1. Build the driver as a second Node entry with the Flue Vite plugin and have promptfoo load the built file. Whether Flue's build can emit an extra library entry is UNKNOWN.
2. Add the `flue()` Vite plugin to `vitest.evals.config.ts` for the contract layer. INFERENCE: Vitest runs Vite plugins, so the markdown import plugin should apply. Not verified.
3. Fallback (option E): the promptfoo provider spawns `triage run --thread-file … --json --wait` with `--env .env.eval`. No faux, but promptfoo never needs faux.

### 3.3 promptfoo layout

```
evals/
  promptfoo/
    classifier.yaml        # suite 1
    triage.yaml            # suite 2
    provider-classifier.ts # file:// provider
    provider-triage.ts     # file:// provider -> driver.runCase
    asserts/*.ts           # javascript asserts shared by both suites
  cases/<case_id>/case.yaml     # reviewed; request + labels + provenance
  cases/<case_id>/fixtures/     # reviewed fixtures (or refs into fixtures/)
  _unreviewed/                  # gitignored, like fixtures/_unreviewed (D27)
```

**The prompt for an agent.** promptfoo requires a `prompts` entry, but an agent has no single prompt. Use a pass-through prompt such as `prompts: ['{{case_id}}']`. The provider ignores the rendered text and reads `context.vars`: `case_path`, `fixtures_dir` and `expected`. `tests: file://evals/cases/*/case.yaml` loads the case files (INFERENCE: glob support in `tests`).

**Suite 1, classifier** (`provider-classifier.ts`). It calls `classify()` and `policy()` directly. The IdChain and basic state come from the case file as vars, so **this suite needs no fixtures** and can use all 89 conversions from day one. Each promptfoo `providers:` entry sets a different `MODEL_CLASSIFIER` (Ollama model, OpenAI mini, OpenRouter model), so one run compares models side by side. This is where promptfoo helps most. Caching can stay on here, because the classifier call is one deterministic-ish structured call.

**Suite 2, full Triage** (`provider-triage.ts`). It runs `driver.runCase` in strict mock mode and returns the JSON above as `output`, so asserts parse `output` rather than relying on version-specific context fields. Tier models are one fixed config per invocation, because `modelForTier` reads env and one Flue runtime serves the process. To compare tier configs, run the suite several times and compare the runs in `promptfoo view`. Cache off, `--repeat k` for trials. Keep `--max-concurrency` low, because one runtime serves concurrent `init()` conversations.

### 3.4 Graded fields and asserts

Code asserts come first. Every assert is binary with a named `metric`.

| Metric | Assert | Gate? |
|---|---|---|
| `schema` | report validates against `ReportSchema` | hard |
| `no_real_io` | every audit line for the run has `transport: mock`, and the driver's pre-start check passed | hard |
| `no_mutation` | every non-GET decision in the audit is `deny`; no `allow` on a non-GET | hard |
| `scope` | no audit `deny` for out-of-scope ids caused by injected text (injection cases only) | hard on those cases |
| `classification` | `classification.proposed.category == expected.category` | yes |
| `tier_delta` | signed ordinal distance of `tier_final` from `expected.tier`. Under-tiering fails; over by one passes with score 0.5 | yes |
| `entity_coverage` | `expected.entities ⊆ entities_consulted`; precision recorded, not gated | yes |
| `service_attribution` | `expected.service == root_cause.service` (**needs the schema addition, D45**) | yes |
| `point_in_time` | every `current_state[*]` has `taken_at` (the partial case's lesson) | yes |
| `status` | `status == expected.status` where ground truth is known | soft |
| `root_cause` | `llm-rubric`, binary: same service, same failing step, same mechanism as `expected.root_cause`; reasoning before verdict | soft until aligned |
| `cost`, `latency` | promptfoo `cost` / `latency` asserts from `report.cost` and `wall_ms` | soft |

The judge runs on `EVAL_JUDGE_MODEL`, from a different model family than the tiers under test (writing-evals skill, `SKILL.md` "An LLM judge is a proxy"). It is not a gate until its agreement with the owner's labels is measured (true positive rate and true negative rate separately) on a held-out split.

`fixture_miss` is reported as its own metric, so "the agent asked a question we have no fixture for" does not look like "the agent was wrong".

### 3.5 Dataset and feedback

- `triage evalset import --from <refs dir>` is offline and makes no network calls. It reads `slack_thread.md` plus `findings.md`, `investigation.md` or `report.md`, runs the **persisted** redaction profile (D24), and writes a draft `case.yaml` to `evals/_unreviewed/`. The draft has the request `messages[]`, draft labels (category, entities, service, root_cause, status, money_moved), `label_source: triager_findings | verified` and provenance. A human reads it and promotes it (`triage evalset review`), the same way fixtures are promoted under D27. The 4 existing cases are converted first with `label_source: verified`.
- Fixtures for suite 2 do not exist today. For the first cases they are written by hand from the prose findings. After that they come from real runs recorded with `TRIAGE_RECORD_FIXTURES=true` into `fixtures/_unreviewed/<run_id>/`.
- `triage feedback <run_id>` (D29) stays the ground-truth entry. A new `triage evalset add <run_id>` packages the run's redacted `input.json`, its classification, the feedback labels and any recorded fixtures into `evals/_unreviewed/<run_id>/`. A run with no recorded fixtures still becomes a suite-1 case.

### 3.6 Keeping evals free of real prod calls (non-negotiable)

1. `.env.eval` (committed as `.env.eval.example`) contains **no entity credentials**: every `*_DB_URL`, `*_API_URL`, `*_QUICKWIT_*`, `SSFB_CBS_*` and `SLACK_BOT_TOKEN` is blank. If mock were bypassed, there is nothing to connect with. This fits D4: an eval run is its own deployment with its own `.env`.
2. The provider and driver, before `start()`: force `TRIAGE_MOCK_MODE=true`, `TRIAGE_MOCK_STRICT=true`, `TRIAGE_RECORD_FIXTURES=false`. Throw if any entity credential key is non-empty in the loaded env. Preflight is skipped in mock mode (`02:302`).
3. Per case: the `no_real_io` assert reads the run's audit lines.
4. CI runners have no VPN, WARP or bastion key.

LLM API calls are a separate question (see §7 Q1).

### 3.7 Cost

- Contract layer: zero model cost (faux).
- Suite 1: one classifier call per case per model. With Ollama it costs no money, only local time.
- Suite 2: cost is roughly cases × k × (agent tokens bounded by `TRIAGE_MAX_TOOL_CALLS_PER_RUN`/`TRIAGE_MAX_TASKS_PER_RUN` + one judge call). No per-case token numbers exist yet (UNKNOWN). The first suite-2 run is how we measure them.
- `EVAL_MAX_COST_USD` is a suite budget: the driver sums `report.cost` and refuses new dispatches once over it. INFERENCE: USD pricing comes from pi-ai model cost metadata, since `FauxModelDefinition.cost` exists (`faux.d.ts:8-13`) and real models likely carry the same fields.

## 4. Env keys to add (names only)

```
EVAL_JUDGE_MODEL=                 # model spec for llm-rubric; different family from the tier models
EVAL_TRIALS=                      # k repeats per case for suite 2 (e.g. 1 on demand, 3 nightly)
EVAL_MAX_COST_USD=                # suite spend cap; driver stops dispatching when reached
EVAL_CASES_DIR=                   # promoted cases (default evals/cases)
EVAL_OUTPUT_DIR=                  # results json/html, under .data (gitignored)
PROMPTFOO_CONFIG_DIR=             # promptfoo's local sqlite + cache, pointed under .data (INFERENCE: key name)
PROMPTFOO_DISABLE_TELEMETRY=      # 1 (INFERENCE: key name)
PROMPTFOO_DISABLE_UPDATE=         # 1, no update check network call (INFERENCE)
PROMPTFOO_DISABLE_SHARING=        # 1, blocks `promptfoo share` uploads (INFERENCE)
PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION=  # 1, if red-team is ever used (INFERENCE)
PROMPTFOO_CACHE_ENABLED=          # false for suite 2; suite 1 may cache (INFERENCE)
```

These live only in `.env.eval`, not in deployment `.env` files. Exact PROMPTFOO_* names must be checked against the pinned version's docs when it is installed.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| SKILL.md imports do not resolve in promptfoo's or Vitest's loader (`advanced_evals.md:227`) | Spike before the LLD. Options in §3.2 order; the `exec` fallback always works if the CLI works |
| A real prod call during an eval | §3.6, four independent layers; `no_real_io` is a hard gate |
| Suite 2 is dominated by fixture misses because model-written SQL varies | Semantic keys (D27); `fixture_miss` reported separately; start with the 4 cases; grow from recorded runs |
| Labels from `findings.md` are wrong (14 folders show first-pass corrections) | `label_source` field; only `verified` cases gate; human review on promotion |
| PII in case files and promptfoo's local DB or HTML output | Persisted redaction on import (already needed: `2026-08-22-mpin-city-required.md:30`); config dir under `.data`; sharing and telemetry off; no CI artifact upload without review (same warning as `ecosystem_tooling-vitest-evals.md:171-175`) |
| Judge noise gates merges | Judge metric is soft until aligned; judge on a different family; merges gated only by contract tests and code asserts |
| Model spend grows with CI frequency | Suite 2 on demand or nightly only; `EVAL_MAX_COST_USD`; suite 1 on Ollama by default |
| Two tools to learn | One driver; `bun run evals:contract`, `bun run evals:classifier`, `bun run evals:triage` wrap them |
| promptfoo is a large dependency with network features | devDependency, pinned version, all network features disabled via env; INFERENCE: MIT licensed |

## 6. Decisions to add or change (drafts)

### D42. Evals use two runners: Vitest for scripted contract tests, promptfoo for case-file model evals (refines D18, 02 §7)
- **Chosen**: Vitest contract tests with `fauxProvider` and strict mock on every PR. promptfoo suites (`classifier`, `triage`) driven by one `file://` TS provider that calls `src/evals/driver.ts`, the same path as `triage run`. vitest-evals is not installed.
- **Rejected**: (a) vitest-evals only: its generated harness needs `createAgentRouter`, which D25 does not mount, and it has no case-file format or model comparison. (b) promptfoo for everything: faux scripting is in-process and per-call, so it fits a test runner, not promptfoo. (c) promptfoo over HTTP: needs a server and cannot see audit lines or tool calls. (d) Braintrust/Jetty: third-party data recipients (D41).
- **Open**: how the driver loads SKILL.md imports (spike: built entry, Vite plugin in Vitest, or `exec` of the CLI).

### D43. Evals run in a credential-free eval env and prove they made no real I/O (refines D19, D27)
- **Chosen**: `.env.eval` with every entity credential and host blank. The provider forces mock and strict on and recording off, and refuses to start if any entity credential is set. Each case asserts from its audit lines that every I/O came from a fixture.
- **Rejected**: relying on `TRIAGE_MOCK_MODE` alone (one flag between an eval and prod); non-strict mock in evals (hides misses); filling fixture gaps by live calls during an eval.

### D44. Eval cases are converted offline, reviewed by a human, and grown from `triage feedback` (refines D29, A9)
- **Chosen**: `triage evalset import` (refs → `evals/_unreviewed/`, persisted redaction), `triage evalset review` (promotion), `triage evalset add <run_id>` (feedback plus recorded fixtures). Each case carries `label_source`. Suite 1 needs no fixtures, because the IdChain is a var.
- **Rejected**: trusting the old questionnaire's redaction (an existing case has unmasked account numbers); auto-promoting converted cases; keeping the Stop-hook questionnaire.

### D45. Grading is code-first; one binary LLM judge for root cause; Report gains `root_cause.service` (refines LLD 04 §2.9)
- **Chosen**: the metrics in §3.4. Hard gates: schema, no_real_io, no_mutation. `root_cause.service: {entity, service}` is added to the Report so service attribution is checkable in code. The judge uses `EVAL_JUDGE_MODEL` from a different family and gates nothing until its agreement with the owner's labels is measured.
- **Rejected**: 1–5 judge scores; embedding similarity for root cause (measures wording, not mechanism); Python asserts (a second toolchain).

## 7. Open questions for the owner

1. Does "never real calls in evals" also cover LLM API calls? Option (a): real Anthropic/OpenAI calls are allowed, with redacted fixture content, as long as every entity I/O is mocked. Option (b): evals use only Ollama and faux by default, and cloud models run only when you ask.
2. May reviewed, redacted eval cases and fixtures be committed to this repo, or should they live outside git (for example next to `refs/`)?
3. Who labels the 89 converted threads: you directly, or model-drafted labels that you confirm?
4. Should real runs record fixtures to `fixtures/_unreviewed/<run_id>/` by default, so `triage evalset add` produces full-run cases? This changes the `TRIAGE_RECORD_FIXTURES=false` default.
5. Where do the model suites run: laptop only for now, or a CI job with model-provider secrets?
6. Is adding `root_cause.service` to the Report schema acceptable?
7. Red-team: handwritten prompt-injection threads only for v1 (my recommendation), or promptfoo red-team with local generation later?

## 8. Rejected alternatives (with reason)

- **vitest-evals blueprint**: requires `createAgentRouter` (`ecosystem_tooling-vitest-evals.md:24`), which D25 rejects for v1.
- **promptfoo replacing Vitest**: faux scripting (`faux.d.ts:29-31`) needs in-process control; a fixed-output PR gate fits a test runner better.
- **promptfoo built-in http provider against `POST /triage`**: needs a live server and polling, and the egress-redacted GET hides the audit and tool calls that the `no_real_io` and `no_mutation` gates need. Could come back later as a "deployed boundary" suite.
- **`exec:` provider as the primary path**: kept only as the fallback, because of process start cost per case and no access to faux.
- **Faux model driven over a subprocess** (for example a `TRIAGE_FAUX_SCRIPT` env in the prod binary): adds a test-only code path to the shipped CLI.
- **Braintrust / Jetty**: hosted; content leaves the machine; D41.
- **promptfoo cloud / `share`**: same reason; disabled by env.
- **promptfoo red-team with remote generation**: INFERENCE: it sends the app purpose and prompts to promptfoo's service. Handwritten injection threads first.
- **Same-family judge**: self-preference bias (writing-evals skill).
- **Embedding `similar` assert for root cause**: rewards wording, not the mechanism.
- **Python asserts**: a second toolchain for no gain.
- **Recording fixtures by making live calls during an eval**: violates the no-real-calls rule.
- **Non-strict mock in evals**: already rejected by D27; restated.

## Assumptions (explicit)

- A-e1: promptfoo's config keys, `file://` TS providers, `javascript`/`llm-rubric`/`cost`/`latency` asserts, `--repeat`, `--no-cache`, `promptfoo view`, a local sqlite results store and the PROMPTFOO_* env names behave as I describe. None of this is verified from files.
- A-e2: the case-to-refs folder mapping in §1 is inferred from id prefixes.
- A-e3: pi-ai real models carry USD cost metadata like `FauxModelDefinition.cost`.
- Process note: while grepping `triage-app/.env.example` for "mock", I printed three flag lines with their default values (`true`/`true`/`false`, no credentials). Every other env inspection printed key names only.
