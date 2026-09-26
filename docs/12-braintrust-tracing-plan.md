# Braintrust tracing for triage-app

Status: implemented on branch `feat/braintrust-tracing` (D82 in [05-decisions.md](05-decisions.md)), 2026-09-26. Plan approved 2026-09-26 (answers in section 9). Section 12 lists where the build differs from this plan.

Source docs:
- Braintrust: https://www.braintrust.dev/docs/integrations/agent-frameworks/flue#typescript
- Flue 2.0.8 bundled page `ecosystem/tooling/braintrust` (in `.claude/skills/flue-framework/references/ecosystem_tooling-braintrust.md`)

## 1. Goal

Send a trace of every triage run to Braintrust: the Triage root operation, each model turn (input, output, tokens, cost), each tool call (args, result, error), delegated tasks and compactions, all nested under one trace per submission. It sits next to what we already have (events.jsonl from D54, the usage meter from D59). It does not replace either.

Out of scope for this plan: Braintrust evals/datasets (promptfoo stays, D42), prompt management, the web console.

## 2. What the two docs say, and what the package actually does

The two docs disagree.

| | Flue 2.0.8 bundled page | Braintrust docs |
| --- | --- | --- |
| Braintrust version | 3.17 | 3.27.0 or later |
| Hook | `observe(event => braintrustFlueObserver(compatibleEvent(event), ctx))` | `instrument(braintrustFlueInstrumentation())` |
| Setup | `bunx flue add tooling braintrust` writes `src/braintrust.ts` | hand-written `src/braintrust.ts` |

Checked in `braintrust@3.35.0` (latest on npm today, unpacked in the session scratchpad):

- `braintrustFlueInstrumentation()` returns `{ key: Symbol.for('braintrust.flue.instrumentation'), observe, interceptor, dispose }`. This matches Flue 2.0.8's `FlueInstrumentation` type in `node_modules/@flue/runtime/dist/instrumentation-*.d.mts`.
- The observer accepts both `tool_call` and `tool` event types, so the `compatibleEvent` shim from the Flue page is no longer needed.
- The interceptor is what nests spans (operation → model turn → tool). The observe-only path from the Flue page gets flatter traces.
- `setMaskingFunction(fn)` runs `fn` on `input`, `output`, `expected`, `metadata`, `context`, `scores`, `metrics` of each span before export. Span names (`llm:<model>`, `tool:<name>`) are not masked.
- `flush()` is exported. Node flushes on process exit as a fallback, but that fallback does not run on `process.exit()`.
- Peer dependency: `zod ^3.25 || ^4`. The repo uses valibot, so zod may need adding.

Decision: follow the Braintrust docs, `instrument(braintrustFlueInstrumentation())` on `braintrust` pinned to an exact 3.x version (3.35.0 or whatever is latest when this lands).

Flue's `instrument()` allows several instrumentations with different keys. The tripwire (`src/agents/tripwire.ts`) already uses one under its own key, so both can be installed. Their interceptors chain in install order.

## 3. Rules in this repo the integration must follow

1. Only `src/config/` reads `process.env` (source guard). The blueprint's `process.env.BRAINTRUST_API_KEY` would fail it. The key must come through `src/config/keys.ts` and `loadConfig()`.
2. Config is read from `TRIAGE_HOME`, not from a `.env` in the cwd (`bunfig.toml` has `env = false`).
3. `childEnv()` copies `process.env` into every child process (qw, ssh, git). The Braintrust key must not be copied into `process.env`, so it never reaches a child.
4. Every stored copy of run data goes through `redactPersisted` (`src/gate/redact.ts`), with the run's ingress names when known (`setRunRedactionNames` in `src/runlog/event-log.ts`). Braintrust is another stored copy, and it is outside our infrastructure, so the same rule applies at the least.
5. No real calls in dev, tests or evals. Tests run behind the no-I/O guard (`test/support/no-io-guard.ts`), which throws on `fetch` to a remote host. Test homes blank secret keys.
6. Vendor SDKs are imported in one place only (like `src/decisions/providers/`).
7. Mock mode stays the default.

## 4. Design

### 4.1 Config keys

New key group `tracing` in `src/config/keys.ts`, mirrored in `.env.example` (a test keeps them in sync):

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `TRIAGE_BRAINTRUST_ENABLED` | bool | `false` | Explicit opt-in. A key alone does not turn tracing on. |
| `BRAINTRUST_API_KEY` | string, secret | none | Vendor name kept so it matches Braintrust docs. Never copied to `process.env`. |
| `BRAINTRUST_PROJECT_NAME` | string | `triage-app` | Picked from the env of each home (Q2). The eval home has its own `.env`, so evals land in whatever project that env names. |
| `TRIAGE_BRAINTRUST_CONTENT` | enum `metadata` \| `redacted` | `metadata` | What leaves the process (see 4.3 and Q1). |
| `BRAINTRUST_APP_URL` | string | none | Only if a Braintrust hybrid/self-hosted data plane is used (Q1). |

Tracing is on only when `TRIAGE_BRAINTRUST_ENABLED=true` and the key is set. If enabled without a key, `loadConfig` fails with a clear config error rather than silently skipping.

### 4.2 Module

New directory `src/tracing/` (added to the CONVENTIONS.md layout), one file `src/tracing/braintrust.ts`, the only file allowed to import `braintrust` (new source-guard rule in `test/guards/rules.ts`).

```ts
// shape only
export function installBraintrust(config: Config, deps = {}): void
export async function flushBraintrust(timeoutMs = 3000): Promise<void>
```

`installBraintrust`:
1. Returns if tracing is off. Idempotent under a `Symbol.for` key, like the usage meter and the event log.
2. Calls `setMaskingFunction(...)` (4.3, second layer) before `initLogger`.
3. `initLogger({ projectName, apiKey, appUrl? , asyncFlush: true })`.
4. Builds `braintrustFlueInstrumentation()` and wraps its `observe` with our redaction (4.3, first layer). The `key`, `interceptor` and `dispose` are passed through unchanged.
5. `instrument(wrapped)`.

`flushBraintrust` awaits Braintrust's `flush()` with a timeout, and swallows and counts errors. Tracing must never fail a run or block shutdown.

### 4.3 Redaction (two layers)

Layer 1, on the event, before Braintrust sees it (wrapped `observe`):
- Only the event types Braintrust reads are processed (`run_*`, `operation*`, `turn_request`, `turn`, `tool*`, `task*`, `compaction*`). Deltas and the rest are dropped here, which also saves work.
- `metadata` mode: content fields (messages, system prompt, tool args, results, error messages, task prompts and results) are replaced with their size and type. Model, tool names, timings, token usage, finish reasons, error codes and correlation ids stay.
- `redacted` mode: the event goes through `toPlain` and `redactPersisted` with the run's ingress names. The run id is the agent instance id, same as event-log. `event-log.ts` gets a small exported getter for the names it already keeps (`runRedactionNames(runId)`).
- Correlation fields are restored after redaction: `type`, `instanceId`, `runId`, `submissionId`, `operationId`, `turnId`, `toolCallId`, `taskId`, `toolName`, `model`, `provider`, `usage`. `redactPersisted` masks any run of 6+ digits, which would otherwise change model ids with dates and some provider tool-call ids, and break span pairing.

Layer 2, on the span, at export (`setMaskingFunction`):
- `redactPersisted` without names on every masked field. This catches anything Braintrust builds itself from the events. Known effect: a model id with a date inside `metadata` shows masked there; the span name keeps it.

### 4.4 Where it is installed and flushed

- `bootRuntime` in `src/ingress/runtime.ts`, next to `installUsageMeter()`, with a `braintrust?: boolean` boot option (default true, so tests and evals can pass false). That covers the server, CLI `run`, the detached CLI worker, `stop`, and the eval driver.
- The Flue docs also say to import the module from `'use agent'` files. That is for Cloudflare, where each Durable Object is its own isolate. We run on Node in one process, so `bootRuntime` is enough.
- Flush:
  - `src/server/shutdown.ts`: await `flushBraintrust()` in the SIGINT/SIGTERM path, after `flushRunEventLogSync()`.
  - `src/cli/main.ts`: await `flushBraintrust()` before ending the pg pools (D68), so CLI runs and the detached worker do not lose the last spans.
- Eval driver (`src/evals/driver.ts`): no override. Whether evals are traced, and into which project, comes from the eval home's env (Q2).

### 4.5 Correlation with our own ids

Braintrust traces already carry the Flue instance id (our run id) and `submissionId` in metadata, so a run is findable by run id in Braintrust search. No extra work in v1.

Feedback as scores (Q5, in scope):
- Capture the Braintrust root span id of each submission. Proposed: a thin interceptor installed after Braintrust's that reads `currentSpan()` at the first agent operation of a submission. The exact API is for the research step to confirm.
- Store it with the run in the run store (new column in a new migration, no foreign keys per D60), keyed by run id and seq.
- On feedback at any phase (D54: `triage feedback`, `POST .../feedback`, console accept/reject/Cancel), call `logger.logFeedback({ id, scores: { accepted: 1 | 0 }, metadata })` against the latest submission's root span. Per-finding verdicts go in as `finding:<id>` scores. Notes go in `comment` only in `redacted` mode, through `redactPersisted` with the run's names. In `metadata` mode notes are not sent.
- Feedback export is best effort: a failure is logged as a pipeline line in events.jsonl and never fails the feedback command.

### 4.6 What is not traced

The decision model (`src/classify/classify.ts`, `src/decisions/`) and embeddings (prior-cases lookup, `embedRun`) call pi-ai or the embed provider directly, outside Flue, so the instrumentation does not see them. They are traced too (Q3):
- `src/tracing/braintrust.ts` exports a small helper, `traceModelCall(kind, meta, fn)`, so no other file imports `braintrust`. With tracing off it just calls `fn`.
- Each call becomes an `llm` span (`decision:<model>`, `embed:<model>`) with run id in metadata, token usage and cost from the existing pricer (`src/usage/price.ts`), and input/output under the same content mode and redaction as 4.3.
- The decision model runs at ingress, before Flue dispatch, so its span is a separate trace tagged with the run id, not a child of the Flue trace. The research step checks whether it can be parented under the run's trace instead.
- `runs reembed` and `doctor` embeddings are not traced (same line as D59).

### 4.7 `triage doctor`

One line: tracing off, or on with project name and content mode. Config only, no network call.

## 5. Tests

All in mock mode, behind the no-I/O guard, no network.

1. Config (`src/config/env.test.ts`): defaults, enabled-without-key error, key is secret and not in `process.env` or `childEnv()`.
2. Unit (`src/tracing/braintrust.test.ts`), with Braintrust's in-memory test logger (`_exportsForTestingOnly`):
   - off by default, no `instrument()` call, no `initLogger` call;
   - idempotent install;
   - `metadata` mode: no content field survives; ids, model, usage survive;
   - `redacted` mode: `checkEgress` is ok on every exported span's `input`/`output`/`metadata`, including an event with an email, a phone, a 12-digit account number and a supplied name;
   - correlation fields unchanged after redaction;
   - `flushBraintrust` returns within the timeout when flush hangs or throws.
3. Contract (`test/contract/tracing.contract.ts`): run the existing fake-model flow with tracing on and the in-memory logger. Assert the span tree (operation → llm → tool), closed tool spans, usage metrics on llm spans, and that the tripwire still stops a delegation with both instrumentations installed.
4. Guards: new rule that only `src/tracing/braintrust.ts` imports `braintrust`; the existing `process.env` rule already covers `src/tracing/`.
5. `bun run build`: confirm Vite bundles `braintrust` for the Node target (it pulls in express, esbuild and others). If it does not, mark it external in `vite.config.ts`.
6. `bun run ci` green.

## 6. Manual check (owner, after merge)

Against a non-production Braintrust project, with `TRIAGE_MOCK_MODE=true` so only fixture data is in the run:

1. Set the four keys in `TRIAGE_HOME/.env`, content mode `metadata`.
2. `triage run` on a fixture thread that makes at least one model turn and one tool call.
3. In Braintrust: one trace per submission, nested spans, closed tool spans, tokens and cost on llm spans, run id and submission id in metadata, no content.
4. Repeat with `redacted`, and read a few spans for anything `redactPersisted` missed.
5. Stop the server with Ctrl-C mid-run and confirm the spans up to that point arrived.

## 7. Implementation steps

One branch and one Workflow (deep web research, implement, review and fix, fix tests), then verification in the main session until every test passes.

1. Inline first: `bun add braintrust@<exact>` (plus `zod` if the peer is needed at runtime), config keys and `.env.example`, `Config.tracing` type.
2. Workflow, one agent per subject:
   - A: `src/tracing/braintrust.ts` + unit tests + `runRedactionNames` getter in event-log;
   - B: wiring in `bootRuntime`, server shutdown, CLI main, eval driver, doctor line;
   - C: `traceModelCall` wired into the decision model and embeddings;
   - D: root span capture, run store column and migration, feedback export from CLI, HTTP and console paths;
   - E: source-guard rule, contract test, CONVENTIONS.md layout line, decision entry in `docs/05-decisions.md`, README env section.
3. Main session: typecheck, `bun run test --only-failures`, `bun run test:contract`, `bun run build`, `bun run ci`.
4. One commit per subject, PR to main when all green.

## 8. Options considered and rejected

- `bunx flue add tooling braintrust`: writes `process.env` reads (fails the source guard), pins Braintrust 3.17, and uses the observe-only path. We take the idea and write the module ourselves.
- Braintrust auto-instrumentation (Node import hook / diagnostics channel): subscribes to Flue contexts directly, so it would bypass the redaction wrapper.
- OpenTelemetry to Braintrust's OTLP endpoint: more moving parts for the same spans; Flue's OTel adapter would be a second integration to keep in step.
- Turning tracing on when the key is present (the blueprint's behavior): too easy to enable by accident in a banking app. Explicit flag instead.
- Masking only through `setMaskingFunction`: it has no run context, so the per-run ingress names would not be masked, and it runs after Braintrust has built the span from raw content.

## 9. Owner answers (2026-09-26)

- Q1: ok. `metadata` stays the default, `redacted` is allowed through config, no hybrid data plane.
- Q2: pick from env. `BRAINTRUST_PROJECT_NAME` in each home's `.env`; evals follow the eval home's env.
- Q3: yes, trace the decision model and embeddings (4.6).
- Q4: branch name to be given by the owner. If none has come by the time the simplify signal arrives, use `feat/braintrust-tracing`.
- Q5: yes, feedback verdicts go to Braintrust as scores (4.5).

## 10. Questions as asked

- Q1. Data leaving our infrastructure. Braintrust SaaS stores span content outside India. Is `redacted` content (persisted profile) acceptable for SSFB, ATSPL and RTL runs, or only `metadata`, or should we use Braintrust's hybrid deployment (data plane in our own cloud, `BRAINTRUST_APP_URL`)? Default in this plan: `metadata`.
- Q2. Project names per environment (for example `triage-app-dev`, `triage-app-prod`), and should eval runs be traced too (separate project)?
- Q3. Trace the decision model and embedding calls that run outside Flue?
- Q4. Branch name. The current branch is `chore/simplify-src` with your unstaged edits in `src/usage/`.
- Q5. Send accept/reject verdicts from `triage feedback` to Braintrust as scores (later phase)?

## 11. Files (checked against origin/main 2c45fe5)

New:
- `src/tracing/braintrust.ts`: installBraintrust, flushBraintrust, observe wrapper, masking, traceModelCall, root span capture, logRunFeedback
- `src/tracing/redact-event.ts`: metadata/redacted projection of Flue events, id restore
- `src/runstore/migrations/0003_submission_trace_span.sql`: `trace_span_id` on submissions
- tests: `src/tracing/braintrust.test.ts`, `src/tracing/redact-event.test.ts`, `test/contract/tracing.contract.ts`

Changed:
- `package.json`, `bun.lock`: braintrust pinned exact (+ zod if needed)
- `src/config/keys.ts`, `src/config/env.ts`, `.env.example`: `tracing` group, five keys, `Config.tracing`
- `src/ingress/runtime.ts`: install in bootRuntime, `braintrust` boot option, root span id → store
- `src/runlog/event-log.ts`: export `runRedactionNames(runId)`
- `src/server/shutdown.ts`, `src/cli/main.ts`: await flushBraintrust
- `src/decisions/decide.ts`, `src/classify/classify.ts`: traceModelCall around the model call
- `src/embed/index.ts`: traceModelCall around embedder calls (not reembed/doctor)
- `src/runstore/types.ts`, `postgres.ts`, `folder.ts`, `fake-pg.ts`, `contract.ts`: set/read trace span id
- `src/report/feedback.ts`: send verdicts as scores after the store write, best effort
- `src/ops/doctor/checks-config.ts`: tracing line
- `test/guards/rules.ts`: only src/tracing/braintrust.ts imports braintrust
- `vite.config.ts`: only if the build needs braintrust external
- docs: `CONVENTIONS.md`, `README.md`, `docs/05-decisions.md`, this plan moved to `docs/12-braintrust-tracing-plan.md`

## 12. Deviations

Where the build differs from the sections above, and why.

- **Span tree (4.2, 5.3)**: the tree is operation → llm and operation → tool, side by side, not operation → llm → tool. The bridge parents a tool span on the operation, not on the turn that asked for it. A delegation is a `task:<agent>` span under the operation, with the delegate's prompt, turns and tools under it. The turn span is named `flue.turn`, not `llm:<model>`; the model is in metadata.
- **One trace per submission (1, 4.5)**: true for the root agent, but the strong synthesis inside `finish_report` is a nested `harness.prompt()` that the bridge makes a second trace, with the same submission id. The first root is the one stored for feedback. The contract test pins this.
- **Model fields (4.3)**: Flue 2.0.8 keeps the model at `request.requestedModel` and `response.responseModel`, not at a top-level `model`.
- **Redaction, layer 1 (4.3)**: instead of redacting the event and restoring the correlation fields, `redact-event.ts` builds a new event from an allowlist. Ids and model fields are copied as sent and only content goes through `redactPersisted`, so nothing needs restoring. Error objects are projected as well, because the SDK does not mask its `error` column (nor span names, tags, feedback comments or feedback metadata): stacks are dropped in both modes, and `metadata` mode keeps only `type`, `name` and `code`.
- **Redaction, layer 2 (4.3)**: the masking function puts back id-shaped values of known id keys in metadata after `redactPersisted`, so a dated model id or a ULID in metadata stays searchable.
- **`installBraintrust` is async (4.2)**: it loads `braintrust` with `await import()`, so a process with tracing off never runs the SDK's import side effects and `cli/main.ts` can import the module cheaply. `bootRuntime` awaits it.
- **Root span capture (4.5)**: on Flue 2.0.8 the prompt operation's interceptor context has no `submissionId` (only the outer submission operation carries it, and it has no span). The capture takes the submission id from the prompt's `operation_start` event, which the observe wrapper keeps by operation id. The contract test found this; the unit tests had used a context that carried the id.
- **Where the root span id is written (4.5)**: `traceRootRecorder` in `src/ingress/runtime.ts` writes it, finding the submission by its stored Flue submission id and retrying at 250 ms, 1 s and 4 s when the root is captured before ingress has written that id. `src/ingress/submit.ts` also writes it by seq through `onTraceRoot` once the dispatch receipt is back, and logs `trace_span_write_failed` when that write fails. The stored value is the root's row id (`span.id`), which `logFeedback` takes, not its span id. A retried attempt in the same process is captured again (Flue's `submission_running` resets the capture).
- **Images (4.3)**: image parts and other long binary base64 are replaced by their type and size in both modes and in both layers; `redactPersisted` cannot mask a picture.
- **Feedback comment (4.5)**: sent only when the run's ingress names are known. `triage feedback` and `triage stop` do not know them, so from there only the scores go. In those processes `logRunFeedback` waits for the send, so a failed send is logged as `feedback_trace_failed`; in the server a failed send is only counted.
- **CLI exit (4.4)**: when the flush in `main()` times out, `bin/triage.mjs` exits the process itself after stdout and stderr drain, since the SDK's requests would otherwise keep it up.
- **Scores (4.5)**: the four verdicts map to `accepted` 1 (correct), 0.5 (partial), 0 (wrong) and no score (pending). Feedback metadata is only `{ run_id, verdict, cancelled? }`. Feedback goes to the project of the process that sends it.
- **Model calls (4.6)**: `traceModelCall` sits in `decide()` and in the classifier's completion path (anthropic, openai, openrouter chat, ollama, faux), which the plan did not name. `decide.ts` does not import the pricer (an import cycle, and decision specs price as null), so decision spans use the provider-reported cost. Embeddings are traced only when the caller passes `trace`.
- **Server flush (4.4)**: the awaited flush is in `bin/triage-server.mjs`'s `exit()`, after `server.stop()`, through `flushTracesBeforeExit` in `src/server/shutdown.ts`. `noteShutdown` is sync and runs before `stop()` ends the aborted submissions' spans.
- **Doctor (4.7)**: the row prints the project name and content mode. The key and the app URL are only named.
- **zod (7.1)**: not added; it comes through pi-ai. The SDK's postinstall (it only fetches the `bt` CLI) stays blocked.
- **Guard (5.4)**: test files may import `braintrust`, for the SDK's in-memory logger; the rule covers the non-test files under `src/`.
- **Contract test (5.3)**: it boots through the agent harness (`bootTriage`), not `bootRuntime`, so it installs Braintrust itself before the harness starts Flue, and writes the Flue submission id to the store the way ingress does.

Left open when this was written:

- A failed write of the root span id by the runtime's recorder logs no pipeline line (the write in `submit.ts` does).
- Plan step 5.5: `bun run build` passes. Vite leaves `braintrust` as an external dynamic import, so `vite.config.ts` is unchanged.
