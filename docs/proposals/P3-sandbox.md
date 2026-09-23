# P3. Sandboxed execution: local default, pluggable E2B/Daytona/Modal

Source: workflow wf_d09cca81-92f, 2026-09-23. Research agent (Opus) then adversarial critic (Opus). Status: **decided 2026-09-23 → D45** (owner: Flue `useSandbox` on Triage with the virtual just-bash backend by default, switchable to E2B or Daytona by `TRIAGE_SANDBOX_PROVIDER`; `local()` refused; D2M = Daytona; remote backends get masked text only). The report's `run_analysis`/Docker shape was not taken. Decisions it touches: D2, D3, D4, D11, D17, D19, D23, D24, D27, D29, D32, D35, D38, D41.

## Summary

Recommendation: accept a narrow version of proposal 3 that refines D2 without repealing it. Sandboxed execution becomes the backend of one typed tool, `run_analysis`. The model never gets a shell, and no agent calls `useSandbox`.

- The tool, not the model, creates the sandbox through a Flue `SandboxFactory`, stages already-fetched and redacted data from this run as read-only files, runs the model-written Python, Node or jq/awk snippet with no network and an empty env, and returns capped, redacted output.
- It is mounted on one new `analyst` delegate. Triage and the investigators never get it. Code_walker keeps `repo_read`/`repo_grep` (D11), and running repo tests or linters is deferred to v2.
- Provider is chosen by `TRIAGE_SANDBOX_PROVIDER=off|virtual|docker|e2b|daytona`, following the same pattern as D38.
- Flue's `local()` is ruled out as the "local sandbox". I read its source: it spawns a host shell on the host network and passes absolute paths straight through. In local mode that shell could `cat .env` and reach the SSFB tunnel on localhost. It isolates nothing.
- The honest local default with a real network block is Docker with `--network none`. Docker is installed on this Mac. macOS `sandbox-exec` is present but marked DEPRECATED, and bwrap/unshare are not installed. Flue's just-bash virtual sandbox needs no dependencies but only offers jq/awk-type tools and has not been checked here (just-bash is not installed).
- Flue facts that shape this: `useSandbox` throws inside a delegate, and delegates share their parent's sandbox. So "a sandbox only on code_walker" cannot be done with `useSandbox`. Calling the factory from tool code is how it gets scoped.

Needs your decision:
1. Docker or just-bash as the local default.
2. Whether remote providers (E2B plus Daytona/Modal) may receive customer-derived data at all.
3. What "D2M" was. Most likely Daytona (it has documented network blocking), possibly Modal, or Docker.

## Questions for the owner

- Accept D42: sandboxing is the backend of one typed tool (run_analysis) on a new analyst delegate, with no useSandbox and no model shell, refining D2 rather than repealing it? Yes/no.
- Local default: A) Docker with --network none (real network block, needs Docker running) or B) Flue virtual just-bash (no dependencies, jq/awk only, probably no Python)? local() is ruled out either way.
- What was "D2M": Daytona (my pick, documented networkBlockAll), Modal, or Docker (which would make it the local option)?
- May remote providers (E2B/Daytona) ever receive customer-derived data, even redacted or pseudonymised, or only literal inputs? Default proposed: no (TRIAGE_SANDBOX_ALLOW_REMOTE_DATA=false).
- Joins in the sandbox: A) per-run HMAC pseudonyms for account numbers and UTRs (refines D24) or B) stage the model-facing profile to local providers only?
- Ship run_analysis in v1, or defer it with systemic/cohort work, and confirm repo test/lint execution is v2?

---

## Critic verdict: sound_with_changes

**Conflicts with decisions**

| Decision | Conflict | Resolution |
|---|---|---|
| D3 | The `analyst` delegate has no entity. It is given raw row snapshots from every entity in the run and joins them, while D3's consequence says cross-entity reasoning happens only in the orchestrator, from summaries (docs/05-decisions.md D3). The report says 'same factory with run_id in a closure' but leaves out the entity part of that factory (docs/05-decisions.md:240). | Either build one `analyze_<entity>` per entity, staging only that entity's snapshots, or write an explicit D3 amendment that allows one entity-less compute delegate and says why. |
| D24 / HLD rule 8 | Joins only work over unmasked keys, and the persisted profile turns 6+ digit runs into ****last4 (docs/02-hld-detailed.md:148). The report's fallback is to 'stage the model-facing profile to local providers', which means writing `data/<call_id>.json` and a Docker `-v <stage>:/in` directory to disk with account numbers visible. Rule 8 says anything persisted is fully masked (docs/01-hld-birds-eye.md:83). Charts and `/out` files kept under `artifacts/` are also persisted but cannot be scanned. | Keep snapshots in memory for the run's lifetime and pipe them in (stdin or writeFile into the sandbox), never to the run folder. Refuse binary outputs, or keep them only after a persisted-profile scan. Treat HMAC pseudonyms as a D24 change, not a refinement. |
| D27 | The mock fixture for `run_analysis` is keyed by 'code hash plus input ids'. D27 rejected hash-of-input keys because model-written text varies on every run. Under TRIAGE_MOCK_STRICT=true in evals, this key misses every time. | In mock mode, run the virtual provider for real (in-process, no I/O) or use a semantic key (input ids plus language). Do not key on the code hash. |
| D19 | D19 says every I/O tool routes to fixtures in mock mode. The report lets `docker` run in mock mode, so evals would depend on a Docker daemon and spawn real processes. | Allow only `off/virtual` in mock mode, or state an explicit exception to D19. |
| D2 | `run_analysis` runs arbitrary model-written Python, Node or shell. That is generic execution, which D2's 'Nothing generic ... is mounted' clause forbids. Calling this a refinement with 'D2 stands' understates the change. The decisions file is append-only and says a reversal gets a superseding entry (docs/05-decisions.md:3). | Word D42 as partly superseding D2's 'nothing generic' clause, and keep the no-`useSandbox` and no-Flue-six-tools parts in force. |
| D17 | The report's own evidence is that scripts appeared in analytics and systemic work. Survey 08 says analytics studies are 'not a triage request type' (docs/survey/08-past-cases-taxonomy.md:77), and D29 already covers single-ticket joins. Even so, the recommendation reads as v1. | Mark it v2, or v1 behind TRIAGE_SANDBOX_PROVIDER=off by default, and say so in the D-entry. |

**Factual errors found**

- Internal inconsistency: the docker driver is described as `docker run --rm ...` per exec, while the lifecycle section says one sandbox per run is reused and '/tmp state may persist'. A `docker run --rm` per call gives a fresh container every time, so nothing persists. Also, `--read-only` with no `--tmpfs /tmp` leaves /tmp unwritable.
- 'Killed by useAgentFinish' is only true if the run-scoped handle lives outside the delegate. useAgentFinish throws inside delegate renders (guides_subagents.md:209), and the sandbox is created by a tool on the analyst delegate. The report does not name the run-keyed registry this needs, or what happens to the in-process handle when Triage.durability retries (docs/02-hld-detailed.md:84).
- Calling a factory's `createSandbox` directly from tool code is INFERENCE, not a documented pattern. The code shows it is technically possible: `bash()` returns a plain `{createSandbox}` (node_modules/@flue/runtime/dist/sandbox-DAJ0daML.mjs:289-290), and `sandboxFromDriver` is exported. The report should label it as inference rather than put it next to FACTs.
- Other citations I checked are accurate: D2 (05:14-16), 01:74, 02:91/93/136/148/309, guides_sandboxes.md:15/34/166/191/335-354, reference_sandbox-api.md:43-46/99/225, local() source node/index.mjs:168-172/254-268/292, the e2b/daytona/modal line refs, and survey/06:18-19.

**Missing**

- Vercel Sandbox is not considered. Per guides_sandboxes.md:351, Vercel and Mirage are the only providers whose SDKs really cancel a running command, which matters for the orphan risk the report accepts.
- just-bash runs in-process in the Triage server. The report does not ask whether a runaway awk or sed loop blocks the Node event loop, or whether the signal-based timeout (reference_sandbox-api.md:221) can interrupt synchronous work. UNKNOWN, and it is the recommended fallback.
- The redaction profile for `data/<call_id>.json` snapshots is never stated. Evidence inputs are persisted-profile while data snapshots are presumably model-facing, so two profiles get mixed in one `/in`.
- `note_evidence` writes `evidence/<entity or code>.json` (02:133). The analyst has neither an entity nor code, so a new evidence kind and file name is needed. Not mentioned.
- Docker Desktop licensing for company use (a paid subscription above a company-size threshold) is not raised. UNKNOWN for Aspora; Colima or OrbStack are alternatives.
- How the orchestrator learns snapshot ids is not specified. It only sees investigator summaries, so investigator return schemas (EntityFindings) must gain snapshot ids.
- D-number and Q-number collisions: D42/D43 and Q27-Q32 will probably clash with the other four proposals in this same review batch.

**Security or data risks**

- Persisting model-facing data (account numbers, UTRs, phones) to the run folder or a Docker bind-mount stage directory breaks the persisted-profile rule. This is the main data risk in the proposal as written.
- Charts and binary `/out` files under `artifacts/` are persisted customer data that the persisted-profile scanner cannot decode. Not posting them to Slack is not enough.
- The tool process needs the Docker socket, which is root-equivalent on the host. The fixed argv mitigates this, but the doctor probe also runs containers, and any later edit to the argv builder is a host-escape path. It needs a unit test that fails on `-v /var/run/docker.sock`, `--network` other than none, `--privileged`, and extra `-v` flags.
- Remote providers: with TRIAGE_SANDBOX_ALLOW_REMOTE_DATA=false they accept literal-only calls. A literal-only call can still carry customer data pasted by the model into the `code` string (account numbers written as literals). The flag does not stop that. Only scanning the code string with the model-facing or persisted profile before a remote exec would.
- Saving model code to `analysis/<n>` under the persisted profile masks literals in the code, so the saved script no longer reproduces the result. That weakens the 'show the query' evidence rule.

**Simplifications**

- Use one fresh sandbox per call, not one per run. This removes lifecycle, teardown, the TTL env key, the orphan sweep and the durability-retry problem. The claim that /tmp state carries over is already broken by `--rm`.
- For docker, drop Flue's SandboxFactory and call `execFile('docker', fixedArgv)` with inputs on stdin, the same shape as CodeGraph (D11). Flue's abstraction only earns its keep for remote providers, which are deferred anyway.
- Ship v1 provider values as `off|virtual|docker` only. Leave e2b/daytona out of code until Q29 (remote data) is answered. With ALLOW_REMOTE_DATA=false they are nearly useless.
- Cut the env keys from 11 to 3: TRIAGE_SANDBOX_PROVIDER, TRIAGE_SANDBOX_IMAGE, TRIAGE_SANDBOX_TIMEOUT_MS. Byte caps, memory and per-run call caps can be code constants; the calls already count toward TRIAGE_MAX_TOOL_CALLS_PER_RUN.
- Default TRIAGE_SANDBOX_PROVIDER=off in .env.example. This matches the mock-default posture and avoids any temptation to derive the default from TRIAGE_DEPLOY_MODE (D32).
- Drop the optional `run_analysis` on code_walker. Testing a regex against a literal does not need a sandbox, and it adds a second mount point to reason about.

### Critique

## Critic's review: Proposal 3 (sandboxed execution)

**Verdict: sound with changes.** The core call is right: no `useSandbox`, no Flue six-tool set, `local()` rejected, and sandboxing kept behind one typed tool. The facts I checked hold. `useSandbox` throws in delegates (guides_sandboxes.md:34, guides_subagents.md:209). `local()` spawns a host shell and passes absolute paths through (node/index.mjs:168-172, :292). Virtual network is off by default (guides_sandboxes.md:191, :347). `bash()` returns a plain `{createSandbox}` (sandbox-DAJ0daML.mjs:289-290), so calling a factory from tool code is technically possible. The report should still label that last point INFERENCE: nothing in the references documents it as a supported pattern.

The problems are in how it plugs into the agreed decisions.

### 1. D3 is silently bent
The `analyst` delegate is entity-less and gets raw rows from every entity's snapshots so it can join them. D3's consequence says cross-entity reasoning happens only in the orchestrator, from summaries. The design's own "mistakes" list says any new delegate goes through the same factory (05-decisions.md:240), and that factory binds the entity. Either make it `analyze_<entity>` or write an explicit D3 amendment. Do not claim "same factory" while leaving the entity out.

### 2. The join use case collides with D24
Joins need unmasked keys. The persisted profile masks 6+ digit runs (02-hld-detailed.md:148), and rule 8 says anything persisted is fully masked (01-hld-birds-eye.md:83). The report's fallback ("stage the model-facing profile to local providers") means writing `data/<call_id>.json` and a Docker bind-mount directory to disk with account numbers visible. That is a D24 violation, not a refinement. Fix: hold snapshots in memory for the run and pipe them into the sandbox. Never write them to the run folder. Charts and `/out` files in `artifacts/` are also persisted customer data that the scanner cannot read. Refuse binaries or scan them; "not posted to Slack" is not enough.

### 3. D27 and D19 conflicts in mock mode
A fixture "keyed by code hash plus input ids" is exactly the hash-of-input key D27 rejected, because model-written text varies every run. Under `TRIAGE_MOCK_STRICT=true` it misses every time. Letting `docker` run in mock mode also breaks D19 ("every I/O tool routes to fixtures") and makes evals depend on a Docker daemon. Allow only `off|virtual` in mock mode.

### 4. D2 wording
`run_analysis` runs arbitrary model-written code. That is the "generic" capability D2 excludes. The decisions file is append-only and a reversal gets a superseding entry (05-decisions.md:3). D42 should say it supersedes D2's "nothing generic is mounted" clause and keeps the rest of D2. Calling it "refines D2; D2 stands" will confuse the next reader.

### 5. Internal inconsistencies
- The docker driver is `docker run --rm` per exec, but the lifecycle section promises one sandbox per run with `/tmp` persisting between calls. `--rm` gives a fresh container each call, and `--read-only` without `--tmpfs` leaves `/tmp` unwritable.
- "Killed by `useAgentFinish`": that hook lives on Triage, and the sandbox is created by a tool on a delegate. That needs a run-keyed registry, which is not described. After a `durability` retry (02:84) the in-process handle is gone.
- The simplest fix for both is **one sandbox per call**. It removes the lifecycle, teardown, TTL key and orphan sweep.

### 6. Scope: v1 or later?
The report's own evidence is against v1. Scripts appeared in analytics and systemic work, which survey 08 calls "not a triage request type" (survey/08:77). Single-ticket joins are already covered by D29's deterministic tools. The recommendation still reads as v1, and the scope question is pushed into Q31. I would state it plainly: v2, or v1 with `TRIAGE_SANDBOX_PROVIDER=off` as the shipped default.

### 7. Second mechanisms and over-building
- `data/<call_id>.json` is a new raw-result store beside `raw_ref` and evidence files. Every row-returning tool changes to feed one optional tool.
- For docker, Flue's `SandboxFactory` adds nothing. `execFile('docker', fixedArgv)` with stdin input is the D11/CodeGraph shape and easier to test. Flue adapters only matter for remote providers.
- Remote providers with `ALLOW_REMOTE_DATA=false` accept only literal-only calls, so they are nearly useless. Leave `e2b|daytona` out of v1 code until Q29 is answered.
- Eleven env keys are too many. PROVIDER, IMAGE and TIMEOUT_MS are enough; the rest can be constants, and the calls already count toward `TRIAGE_MAX_TOOL_CALLS_PER_RUN`.
- The optional mount on code_walker adds surface for a regex check that needs no sandbox. Drop it.

### 8. Data-boundary gaps not covered
- `ALLOW_REMOTE_DATA=false` does not stop the model from pasting an account number into the `code` string as a literal. A remote exec would need a redaction scan of the code first.
- The Docker socket is root-equivalent on the host. The argv test should fail on any extra `-v`, `--privileged`, a `--network` value other than `none`, or a socket mount.
- Masking literals in the saved `analysis/<n>` script means it no longer reproduces the result. That weakens the report's own "show the query" rule.

### 9. Missing alternatives and unknowns
- Vercel Sandbox is not considered. It is one of only two providers whose cancellation really stops the command (guides_sandboxes.md:351).
- just-bash runs inside the server process. Whether a synchronous runaway loop can be interrupted by the signal-based timeout (reference_sandbox-api.md:221) is UNKNOWN, and it matters because `virtual` is the fallback.
- Docker Desktop licensing for company use is UNKNOWN. Colima or OrbStack are alternatives.
- D42/D43 and Q27-Q32 will probably collide with numbers chosen by the other four proposals in this batch.

### What holds up
The rejection of `local()`, `useSandbox` on Triage, the top-level Analyst agent, repo test/lint runs and sandbox-backed grep is well argued and matches D2(b) and D11. D13, D35 and D40 are untouched. D32 and D4 hold as long as the provider default is a literal in `.env.example` and never derived from `TRIAGE_DEPLOY_MODE`. The "D2M" question is fair; Daytona is the best guess from the Flue pages, but only the owner knows.

---

## Full report

# Proposal 3: Sandboxed execution (local default, pluggable E2B / Daytona / Modal)

Legend: **FACT** = I read it (path:line). **INFERENCE** = my conclusion. **UNKNOWN** = not verified. Paths are relative to `/Users/varun/code/work/triage-app` unless absolute. Flue references are under `.claude/skills/flue-framework/references/` (shortened to `refs/`).

## 1. What exists today (facts)

**The agreed design says no shell and no sandbox.**
- FACT: D2 says "typed tools only … Nothing generic (`bash`, `curl`, `psql`, file write) is mounted. No `useSandbox`." It rejected `useSandbox(local())` because `local()` "is not an isolation boundary" (docs/05-decisions.md:14-15).
- FACT: HLD rule 1 is "No shell for the model" (docs/01-hld-birds-eye.md:74).
- FACT: The detailed HLD repeats this and gives two reasons: a sandbox on Triage "would hand file and shell tools to every delegate", and "`useSandbox` throws inside delegates" (docs/02-hld-detailed.md:136).
- FACT: The reason behind D2 is that the old allowlist drifted to 67 entries, including `python3 *` (docs/05-decisions.md:16; docs/survey/06-guardrails-hooks.md:18). The old workspace had `sandbox.enabled:false` (survey/06:19).
- FACT: code_walker uses CodeGraph through `execFile` plus path-jailed `repo_read`/`repo_grep` (docs/02-hld-detailed.md:25, :131-132; D11 at docs/05-decisions.md:56-59).
- FACT: Remediation commands are only ever rendered, never run (D35, docs/05-decisions.md:171-173).

**How Flue sandboxes work (2.0.8).**
- FACT: Attaching a sandbox adds six tools: `read`, `write`, `edit`, `bash`, `grep`, `glob` (refs/guides_sandboxes.md:15).
- FACT: A `SandboxToolFactory` can replace all six (refs/guides_sandboxes.md:354).
- FACT: `useSandbox` may be called at most once per render, and it "throws inside a subagent's render — delegates share the parent's environment" (refs/guides_sandboxes.md:34). Delegates inherit "the sandbox and its harness tools (read, write, bash, …)" (refs/guides_subagents.md:183, :210).
- INFERENCE: You cannot give only code_walker, or only a new delegate, a sandbox through `useSandbox`. The only `useSandbox` routes are (a) on Triage, which leaks the tools to every investigator and breaks D2/D3, or (b) on a separate top-level `'use agent'`.
- FACT: `createSandbox({id})` is a plain async method on the factory. It is called once per harness, and Flue has no teardown verb (refs/reference_sandbox-api.md:43-46). `Sandbox.exec/readFile/writeFile` are ordinary methods, and operations through them are not recorded in the conversation (refs/reference_sandbox-api.md:99).
- INFERENCE: A tool's own code can call any factory's `createSandbox` and drive the sandbox directly, without `useSandbox` and without mounting Flue's six tools. My recommendation rests on this.
- FACT, `local()` source in the installed runtime:
  - It spawns the host shell (`spawn(command, {shell, detached})`, node_modules/@flue/runtime/dist/node/index.mjs:168-172).
  - `resolvePath` passes any absolute path through unchanged (`path.isAbsolute(p) ? p : …`, :292).
  - The env allowlist includes `PATH` and `HOME` (:254-268).
  - Nothing in it restricts network or filesystem. The docs say the same: "not an isolation boundary, by design" (refs/guides_sandboxes.md:348), and it "exposes the host without isolation" (refs/reference_sandbox-api.md:225).
- FACT: The virtual sandbox (`bash(() => new Bash(...))`, just-bash) uses an in-memory filesystem. "No real process is ever spawned." It has the unix toolbox (`sed`, `awk`, `jq`, `sort`, `curl`). Network is opt-in via `allowedUrlPrefixes` and is off by default. It is ephemeral (refs/guides_sandboxes.md:166, :191, :346-347). The wrapper is at node_modules/@flue/runtime/dist/sandbox-DAJ0daML.mjs:289.
- UNKNOWN: whether just-bash runs Python or Node. The docs list only shell tools. just-bash is not installed, so I could not check.
- FACT: The docs' own guidance: untrusted code should use a remote provider, "not `local()`" (refs/guides_sandboxes.md:335); a privileged action should be "a narrow application tool" (:338); and "choose the narrowest environment" (:342).

**Remote providers, as far as the Flue pages say.**

| | E2B | Daytona | Modal |
|---|---|---|---|
| Isolation | Linux microVM (refs/ecosystem_sandboxes-e2b.md:12) | managed Linux sandbox (daytona.md:12) | container (modal.md:12-13) |
| Cold start | "low hundreds of milliseconds" (e2b.md:29-30) | not stated (UNKNOWN) | median under 0.5 s for CPU (modal.md:34-36) |
| Network control | "a decision on … network policy" is a prerequisite, but no setting is named (e2b.md:39). UNKNOWN which setting it is | `networkBlockAll`, `networkAllowList`, `domainAllowList` (daytona.md:103) | not documented on the Flue page (UNKNOWN) |
| Lifetime | default 5 min, then killed unless `onTimeout:'pause'` (e2b.md:94, :129) | TTL, auto-stop, auto-delete (daytona.md:93-94, :100-101) | default 5 min, up to 24 h (modal.md:109) |
| Cancel | abort not forwarded, so orphans are possible (e2b.md:124-126) | same (daytona.md:124-125) | same (modal.md:136-138) |
| Cost | "check current pricing" (e2b.md:131-132) | not stated | $0.00003942 per core-second (modal.md:147) |
| Keys | `E2B_API_KEY` | `DAYTONA_API_KEY` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` |

- FACT: None of the provider SDKs are installed (no `e2b`, `@daytona/sdk`, `modal` or `just-bash` in node_modules).
- FACT: boxd, exe.dev and islo are persistent VMs whose isolation "does not restrict outbound internet" (boxd.md:137; exedev.md:133-135). Mirage is a mounted-resource filesystem, "not a VM" (mirage.md:12-14). None of them is a local option.

**Local isolation on this machine.**
- FACT: `/usr/bin/sandbox-exec` exists, and its man page calls it "DEPRECATED".
- FACT: `/usr/local/bin/docker` exists. `bwrap` and `unshare` are not installed. OS is macOS 27.0.
- UNKNOWN: whether the Docker daemon is running. I ran no docker commands.

**What past cases did with scripts.**
- FACT: 9 script files across 151 `refs/` directories in triage-shivalik.
- Offline transforms over dumps they had already fetched: `harbor-error-classification/normalize.py` (stdlib only, :8), `build_matrix.py`, `pse-yodel-ref-remap/build_mapping.py`.
- Scripts that call hosts over `urllib`: `harbor-error-classification/sweep.py:7,25-27` and `cbs-outage-2026-07-16/recovery_app.py:16,40-42`.
- INFERENCE: The legitimate job is the offline kind. The networked kind is exactly what D2 exists to stop. Scripts showed up in analytics/systemic work, not single-ticket triage (docs/survey/08-past-cases-taxonomy.md:77; systemic cases are about 2+2 of 118, docs/00-lay-of-the-land.md:75).

## 2. Options considered

**A. Keep D2 as is, with no sandbox.** Simplest. Loses ad-hoc compute over fetched data, such as joining two dumps, date bucketing or counting.

**B. `useSandbox` on Triage with a custom `SandboxToolFactory`.** The tools would be inherited by every delegate, including the investigators (guides_subagents.md:183). This breaks D2 and D3.

**C. A separate top-level `Analyst` agent with `useSandbox(provider)` and Flue's normal tools**, called from a Triage tool through `init()`/`dispatch()`.
- The model gets a real shell inside the sandbox.
- This adds a second durable conversation per request, a new registration and HTTP surface, and workspace discovery (`AGENTS.md`, skills) inside the sandbox.
- The gate would be the sandbox's own configuration, not code under test.

**D. The sandbox as the backend of one typed tool, `run_analysis`.** The tool code calls `createSandbox`, stages inputs, calls `exec`, reads outputs, applies redaction and writes the audit line. The model supplies code as a string argument. No `useSandbox`, no `bash` tool name.

**E. Sandbox for code_walker's read/grep.** Already rejected in D2(b). Plain jailed tools are simpler.

**F. Run repo unit tests and linters in a sandbox.**
- Go and JS builds need module downloads, meaning network egress. Private modules (e.g. `go-commons`) would also need GitHub credentials inside the sandbox.
- INFERENCE: the value for "why is this customer stuck" is low next to the cost.

**G. Run evals in the sandbox.** Evals are in-process Vitest in mock mode (D19; docs/02-hld-detailed.md:309). Nothing is gained.

**Local backends for D:**
- `local()`: no isolation (see section 1).
- just-bash `virtual`: no dependencies, network off, shell tools only.
- `docker run --network none`: a real network namespace inside Docker's Linux VM on macOS, and natively on Linux.
- `sandbox-exec` with a deny-network profile: deprecated.
- `bwrap --unshare-net`: Linux only, and not installed here.

## 3. Recommendation and how it plugs in

**Take option D, add an `analyst` delegate, and defer F.**

**Tool `run_analysis`.**
- Input: `{language: 'python'|'node'|'shell', code: string (≤ 32 KB), inputs: string[] (snapshot or evidence ids from this run), outputs?: string[] (file names under /out)}`.
- Output: `{exit_code, stdout, stderr (each capped), files: [{name, bytes, ref}], provider, duration_ms, taken_at}`.
- `language` is checked against what the provider supports. `virtual` offers `shell` only.

**Gate `src/gate/sandbox.ts`** (pure, `bun test`):
- ids must belong to `run_id`;
- size caps on code, inputs and outputs;
- output file names must match `^[a-z0-9_.-]+$`;
- per-run call cap in `budget.ts`;
- stdout and stderr go through the model-facing redaction profile before return;
- the code text is saved to `analysis/<n>.<ext>` under the persisted profile, and the audit line records code hash, length, input ids, provider, exit and duration.

**Where the data comes from.**
- The design has a `raw_ref` field on evidence (docs/02-hld-detailed.md:93) but defines no store for raw tool results. So tools that return rows (`sql_select`, `logs_search`, `get_account_statement`) also write a snapshot `data/<call_id>.json` in the run folder.
- `run_analysis` stages only those snapshots and `evidence/*.json`, read-only at `/in/<id>.json`. The model passes ids, never paths.

**What the sandbox gets:**
- no network;
- empty env;
- no host filesystem;
- no repos, `.env`, `~/.aws`, kube config or SSH agent;
- a pinned image (Python stdlib, plus pandas and matplotlib if wanted, Node LTS, jq);
- a per-call timeout;
- memory and PID limits.

**Provider selection.** `TRIAGE_SANDBOX_PROVIDER=off|virtual|docker|e2b|daytona`, read in one module (`src/sandbox/select.ts`), like `TRIAGE_DB_PROVIDER` (D38). It is not derived from `TRIAGE_DEPLOY_MODE` (D32 stays the only deploy-mode switch).

| Provider | How it runs |
|---|---|
| `docker` (recommended local default) | A hand-written `SandboxDriver` via `sandboxFromDriver`. `docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534 --memory … --pids-limit … -v <stage>:/in:ro -v <out>:/out`, image pinned by digest. |
| `virtual` | `bash(() => new Bash({fs: new InMemoryFs(staged)}))` with no `network` option. Shell language only. |
| `e2b` / `daytona` | The Flue blueprints (`flue add sandbox e2b|daytona`). Created with network blocked (Daytona `networkBlockAll`; E2B's setting to be confirmed) and a finite TTL. |

**Behaviour rules:**
- `local()` is never a provider value.
- If the chosen provider is unavailable (Docker daemon down, key missing), the tool stays mounted and answers "sandbox not configured" (the same pattern as docs/02-hld-detailed.md:91). There is no fallback to another provider.
- `triage doctor` reports provider status. For `docker` it runs a no-network probe container. This is a local operation, not a customer-data read.

**Lifecycle.**
- One sandbox per run, created lazily on the first call and reused within the run.
- It is killed by `useAgentFinish`, or by the harness after `finish_report`. The provider TTL is the backstop for crashes, since Flue has no teardown (reference_sandbox-api.md:46).
- Orphaned remote execs (e2b.md:124) are only a cost, because there is no network and a TTL applies.

**Agents.**
- New delegate `analyst`, built by the same factory pattern with `run_id` in a closure (docs/05-decisions.md:240).
- Model: `MODEL_TIER_STRONG` (INFERENCE: writing correct code is where a cheap model fails quietly).
- Tools: `run_analysis`, `note_evidence`. Skills: `analysis-method` (what inputs look like, output limits, "results are evidence only when you show the query and the inputs").
- The orchestrator's brief names the snapshot ids and the question.
- It is not mounted on Triage directly, and not on the investigators. Investigators keep the deterministic joins (`detect_silent_reversals`, D29).
- Optional: mount `run_analysis` on `code_walker` with `inputs` forced empty, for checking a regex or a date/timezone rule copied from the code against a literal string.

**Other touch points:**
- The `instrument()` tripwire allowlist gains `run_analysis` (docs/02-hld-detailed.md:136).
- Mock mode: `TRIAGE_MOCK_MODE=true` refuses `e2b`/`daytona` and allows `off|virtual|docker`, or a fixture keyed by code hash plus input ids under strict mode. This follows the "never real calls in dev/evals" rule.
- Charts go to `artifacts/` in the run folder and are linked from `report.md`. They are not posted to Slack in v1, because PNG text cannot be redaction-scanned.

**What the model can and cannot do (exact statement for the D-entry).**

It **can**:
- write one Python, Node or shell program per call;
- read the staged read-only inputs of the current run;
- write files under `/out`;
- read the capped, redacted stdout, stderr and file list;
- call again within the same run, where `/tmp` state may persist.

It **cannot**:
- reach any network, including entity hosts, the SSFB tunnel on localhost, the internet and package indexes;
- read `.env`, host files, repos, credentials or env vars;
- install packages;
- choose the provider or the image;
- stage files by path, or data from another run or entity outside what this run fetched;
- invoke any triage tool from inside the sandbox;
- keep anything after the run;
- execute a `suggested_fix` (D35). Those commands are never staged, and with no network they could not reach a host anyway.

## 4. Env keys to add (names only)

```
TRIAGE_SANDBOX_PROVIDER=            # off|virtual|docker|e2b|daytona; default docker on laptops; never "local"
TRIAGE_SANDBOX_TIMEOUT_MS=          # per exec call wall-clock cap
TRIAGE_SANDBOX_TTL_MS=              # max sandbox lifetime per run (provider TTL backstop)
TRIAGE_SANDBOX_MAX_CALLS_PER_RUN=   # run_analysis calls per run (also counts toward TRIAGE_MAX_TOOL_CALLS_PER_RUN)
TRIAGE_SANDBOX_MAX_INPUT_BYTES=     # total staged bytes per call
TRIAGE_SANDBOX_MAX_OUTPUT_BYTES=    # stdout+stderr cap returned to the model
TRIAGE_SANDBOX_MEMORY_MB=           # container / VM memory limit
TRIAGE_SANDBOX_IMAGE=               # pinned image ref (docker digest, E2B template, Daytona snapshot)
TRIAGE_SANDBOX_ALLOW_REMOTE_DATA=   # false: remote providers get literal-only calls (no staged customer data)
E2B_API_KEY=                        # only when provider=e2b; provider SDK's own name
DAYTONA_API_KEY=                    # only when provider=daytona; provider SDK's own name
# MODAL_TOKEN_ID= / MODAL_TOKEN_SECRET=   # only if "D2M" turns out to be Modal
```

D4 is unaffected: no key encodes an environment. Provider SDK keys keep their SDKs' default names. That is an assumption the SDKs read those names; I verified it only against the Flue pages (e2b.md:38; daytona.md:34; modal.md:43-44).

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt injection in the Slack text makes the model write code that exfiltrates data | No network in any provider. Inputs are data the model already holds. Output goes back only to the model, redacted. |
| Someone later sets the provider to `local()` "for speed" | `local` is not an accepted value. The loader rejects it, and a unit test greps `src/` for `local(` imports outside tests. |
| Docker's `--network none` misconfigured, or the host socket mounted | The argv is fixed in code and unit-tested, and the Docker socket is never mounted. The doctor probe checks that `getent hosts` or a TCP connect fails inside the container. |
| Remote provider receives customer data | `TRIAGE_SANDBOX_ALLOW_REMOTE_DATA=false` by default. Remote providers are also a new data processor, so this is your decision (section 7). |
| Masking breaks joins (the persisted profile turns 6+ digit runs into `****last4`, docs/02-hld-detailed.md:148) | Option: per-run HMAC pseudonyms for join keys in staged copies (refines D24). Otherwise stage the model-facing profile to local providers only. |
| Remote sandbox left running after a crash | Provider TTL (E2B timeout-kill, Daytona `ttlMinutes` or auto-delete) plus a sweep in `triage doctor`. |
| The model presents a script's result as a fact | `note_evidence` requires `query_or_path` pointing at `analysis/<n>` and the input ids. The analysis skill says the output is derived, not observed. |
| Scope creep back to "the model has a shell" | The D-entry states that no agent calls `useSandbox` and that Flue's six tools are never mounted. The tripwire denies `bash`, `read` and the rest. |
| Docker is not available on the server deployment | The provider is independent of deploy mode, so a server can use `e2b`/`daytona` or `off`. |

## 6. Decisions to add or change (drafts)

### D42. Sandboxed compute is the backend of one typed tool, not a model shell (refines D2; D2 stands)
- **Chosen**: `run_analysis` runs model-written Python, Node or shell over staged inputs of the current run. The tool calls a Flue `SandboxFactory`'s `createSandbox`/`writeFile`/`exec`/`readFile` itself. No agent calls `useSandbox`, and Flue's six sandbox tools are never mounted.
- **Mounted on**: a new `analyst` delegate (`MODEL_TIER_STRONG`, built by the standard factory with `run_id` in a closure). Optionally also on `code_walker` with inputs forced empty. Never on Triage or the investigators.
- **Provider**: `TRIAGE_SANDBOX_PROVIDER=off|virtual|docker|e2b|daytona`, selected in one module. The sandbox has no network, an empty env, no host FS, read-only `/in`, writable `/out`, and caps on time, memory, input and output. One sandbox per run, killed at finish, with a provider TTL as backstop.
- **The model can**: write code; read the staged inputs; write `/out`; read the redacted, capped output.
- **The model cannot**: reach any network; read `.env`, host files, repos or credentials; install packages; pick the provider, image or file paths; call triage tools from inside; keep state past the run; execute `suggested_fix` (D35).
- **Rejected**: (a) `useSandbox` on Triage (delegates inherit the tools; breaks D2/D3). (b) `local()` as the "local sandbox" (spawns a host shell on the host network with absolute paths passed through, `node/index.mjs:168-172, :292`; in local mode that reaches `.env` and the SSFB tunnel). (c) A separate top-level Analyst agent with a real shell (a second durable conversation, and the gate lives in sandbox config instead of tested code). (d) Running repo tests or linters (needs egress and GitHub credentials; v2). (e) Sandbox-backed read/grep for code_walker (D2(b), D11 stand). (f) macOS `sandbox-exec` (deprecated).
- **Consequences**: the tripwire allowlist gains `run_analysis`. Row-returning tools write `data/<call_id>.json` snapshots. Mock mode refuses remote providers. The doctor probes the provider. D11 is unchanged.

### D43. Remote sandbox providers receive no customer-derived data unless enabled (refines D24, D41)
- **Chosen**: `TRIAGE_SANDBOX_ALLOW_REMOTE_DATA=false`. With `e2b` or `daytona`, `run_analysis` accepts only calls with empty `inputs` until this is turned on. When it is on, staged copies use the persisted profile, with per-run HMAC pseudonyms for join keys (account number, UTR).
- **Rejected**: sending model-facing data to a third-party sandbox by default. It is one more processor for bank data, and nobody has signed off on it.

## 7. Open questions for the owner

- Q27. Local default: `docker` (real network block, needs Docker running) or `virtual` just-bash (no dependencies, jq/awk only, probably no Python)?
- Q28. What was "D2M"? Candidates: **Daytona** (Flue ships it, and its page documents network blocking), **Modal** (GPU-oriented; network controls not documented on the Flue page), or **Docker** (which would make it the local option, not a second remote one).
- Q29. May a remote sandbox (E2B/Daytona/Modal) ever receive customer-derived data, even redacted or pseudonymised? Is there a data-residency rule for SSFB data? I have read none, so this is UNKNOWN.
- Q30. For joins inside the sandbox: per-run HMAC pseudonyms (a D24 refinement), or stage the model-facing profile to local providers only?
- Q31. Ship `run_analysis` in v1, or defer it with systemic and cohort work? Single-ticket joins are already covered by D29's deterministic tools.
- Q32. Running repo tests or linters in a sandbox: confirm it is deferred to v2?

## 8. Rejected alternatives (summary)

| Alternative | Why rejected |
|---|---|
| Flue `local()` as the local sandbox | Isolates nothing. Absolute paths pass through, host network, `HOME` in env. In local deploy mode the model's shell could read `.env` and reach prod through the tunnel. |
| `useSandbox` on Triage (with or without a custom tool factory) | Every delegate inherits it (guides_subagents.md:183). Contradicts D2 and D3. |
| `useSandbox` on code_walker or another delegate | Not possible: it throws inside a delegate render (guides_sandboxes.md:34). |
| Separate top-level Analyst agent with a real shell | A second durable conversation and HTTP surface. The gate is provider config, not unit-tested code. |
| Sandbox-backed read/grep for code_walker | Already rejected (D2(b)). Jailed plain tools are simpler. |
| Running repo unit tests or linters | Needs module-download egress and private GitHub credentials in the sandbox. Low triage value. v2. |
| Evals inside a sandbox | Evals are in-process Vitest in mock mode (D19). Nothing to isolate. |
| macOS `sandbox-exec` deny-network profile | Marked DEPRECATED on this machine. Not portable to the Linux server. |
| bubblewrap / `unshare -n` | Linux only and not installed here. Could be a later `bwrap` provider value for Linux servers. |
| Modal as the second remote provider by default | Its strength is GPU and volumes, which we don't need. No network control on the Flue page. Daytona documents `networkBlockAll`. |
| boxd, exe.dev, islo, Mirage | Persistent VMs with open egress by default, or not a code sandbox at all (Mirage). |
| Running `suggested_fix` commands in a sandbox | Never in scope (D35). |

**Assumptions I made (not verified):**
- just-bash's default network block works as documented. I did not check it because it is not installed.
- Docker `--network none` on Docker Desktop for macOS leaves only loopback and cannot reach the host's `localhost:55432`. INFERENCE, to be proven by the doctor probe.
- E2B has a setting that blocks all egress. UNKNOWN until its SDK docs are read.
- The provider SDKs read the standard key names.
