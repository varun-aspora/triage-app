# P6. Mid-run input: relaying a blocked run to the person and resuming it

Source: discussion with the owner on 2026-09-25, in the session that reviewed the built v1. Status: **decided 2026-09-25 → D53**, scoped by the owner to the CLI: park through the run store, `ask_requester` on the root, answers through `triage run`, `triage wait` and `triage input`. The HTTP/web and Slack adapters, `do` requests, the deadline and the ingress-time ask are not built; the defaults D53 records stand in for §9 questions 1, 4 and 5, and questions 2, 3, 6, 7 and 8 stay open with the parts they belong to. Decisions it touches: D13, D17, D22, D24, D25, D26, D28, D32, D35, D39, D43.

## Summary

A run that is blocked on something only a person can do or provide should stop with a typed request, not wait inside a tool. The request goes to the run store, which every front door already reads. Each transport renders it its own way (CLI prompt or JSON, HTTP record, Slack push) and sends the answer back through one shared function, which resumes the run as a new submission on the same Flue conversation, so the run keeps everything it found. The agent never knows which interface is listening.

Cheapest correct version: ask at ingress for the predictable cases (no id in the thread, screenshots on a text-only tier), and park mid-run only from the orchestrator. Code, not the model, authors "do this on the host" requests, and only in local mode.

## 1. The ask, as clarified

- Trigger from the CLI, a future web UI, or Slack. A run is part-way through and an agent is stuck on something a person must **do** (log in to `qw`, bring the tunnel up) or **provide** (which customer, which transaction, the error text in a screenshot).
- The person must hear about it now, act or answer, and the run must continue with what it already found. This rules out "fail with a gap and re-run", which is what the design does today.
- Not a follow-up after the report (`triage ask`), and not the report status `pending_user`, which means the bank customer has to act (knowledge/method/report-format.md:63).
- The ask leaves open who "the person" is: the requester, the on-call group, or whoever runs the host. In Slack these are often different people.

## 2. What exists today

Facts, each checked in the tree on 2026-09-25.

- A run ends only through `finish_report` or a failure. `useAgentFinish` sends one `triage.finish_required` signal, then throws (src/agents/triage.agent.ts:114).
- Nothing inside a run can reach a person. Slack write is not a tool (D13); Flue channels are inbound only; investigators have no messaging at all.
- A blocked tool tells the model, not the person. `qw` without a login returns "unreachable: run qw login --context <ctx> on the host" (src/connectors/quickwit/qw-transport.ts:118). The model records a gap; the person reads it in the final report.
- Follow-ups already use the mechanism a resume needs: `askRun` dispatches a new message to the same Flue conversation, whose id is the run id, with no `initialData` (src/ingress/submit.ts:312). `triage ask` and `POST /triage/:run_id/ask` both use it.
- Every interface reads the run store: `triage wait` polls it once a second, `GET /triage/:run_id` returns it, nothing streams (D25). The Slack bot is designed (HLD 02 §5.4) and not built.
- `RUN_PHASES` has no waiting state (src/runstore/types.ts:44). A parked run would show `running` over HTTP and `stalled` in the CLI once the worker exits (src/cli/commands/status.command.ts:36).
- The CLI refuses `ask` while a run is going (src/cli/commands/ask.command.ts:71); the HTTP ask route does not check (src/ingress/http/routes.ts:131).
- Ids that `resolve_identity` adds mid-run live in memory only: src/agents/triage-plan.ts:440 seeds the chain from `init.id_chain`, and :469 clears it at settle. An id a person types would come back `unverified` under the scope rule (D26) because it links to nothing in the chain. This already affects `triage ask`.
- Ingress records `no ids in request` when the thread carries none (src/ingress/identity.ts:32). 13 of 118 past threads had no customer UUID; 73 relied on screenshots (docs/00-lay-of-the-land.md:59).
- The previous workspace's prompt said "Do not ask clarifying questions" (docs/survey/04-skills-agents.md:159). Nothing in this repo has reversed that.
- Run timeout: `TRIAGE_RUN_TIMEOUT_MS=900000`, 15 minutes (.env.example:60).

## 3. Flue facts that shape the design

From the installed `@flue/runtime` 2.0.8 and the references under `.agents/skills/flue-framework/references/`.

- No pause-for-a-human primitive. A grep of the runtime dist for suspend, await-input, elicit and the like finds nothing. A submission settles exactly once: completed, failed or aborted.
- A new message to an idle conversation starts a new response with the full history. `usePersistentState` carries over between submissions; delegates cannot use it (src/agents/escalation.ts:9).
- A message sent to a busy conversation joins at the next turn boundary (`useDispatchMessage`, reference_agent-hooks-api.md). Whether a `dispatch()` from a second process reaches the CLI worker's live coordinator is **unverified**.
- An ordinary tool call interrupted by a crash settles with an unknown outcome and is never re-executed (advanced_durability.md:185). `durability.timeoutMs` counts wall-clock time, including any wait.
- Delegates render fresh per task and inherit nothing from the parent's conversation (guides_subagents.md:187, 212). Tasks in one batch run in parallel.
- `useDataWriter` is one-way, to a client of the agent router, which D25 leaves unmounted. No answer path.
- pi's `ctx.ui.confirm/select/input/notify` belongs to pi-coding-agent, the terminal app. Flue depends on `pi-agent-core` and `pi-ai` only (node_modules/@earendil-works/), and neither has a `ui` object. pi's own docs: check `ctx.hasUI` first, or `ctx.ui.confirm()` hangs in print mode (.agents/skills/writing-pi-extensions/references/tool/tool_call.md:83). Under the hood it is a promise that blocks the tool until the terminal resolves it. It works because the process is the UI: one user, no durability timeout, nothing leaves the machine.
- MCP elicitation, LangGraph `interrupt()` and A2A `input-required` are the server-side versions of the same idea: the agent emits a typed request, the run stops, the client renders it and sends the answer back, the agent resumes. They standardise the message shape and the resume call; each front door still renders and routes. Flue ships neither, so the shape is ours to build.

## 4. Design

### 4.1 Two kinds of request

| | provide | do |
|---|---|---|
| Example | which customer; which of three transactions; error text only in a screenshot | `qw login --context …`; tunnel; SSO |
| Authored by | the orchestrator, through a tool | code, with fixed text, when a tool detects the condition |
| Answered by | the requester | whoever operates the host; only meaningful in `TRIAGE_DEPLOY_MODE=local` |
| Elsewhere | — | on a server it stays a warning and a gap, as today |

The model never writes a command for a human to run mid-run. A model-authored "please run X" relayed to a person is the injection surface the gate exists to block, and thread text could steer it.

### 4.2 Ask at ingress first

Most "provide" blocks are visible before any model runs. No id in the thread, or a screenshot-only thread on a text-only tier, can be asked at `prepare` time with no agent change: the CLI prompts before starting, HTTP answers 422 naming the missing input, the Slack bot replies "which customer?". Only what surfaces during investigation needs §4.3.

### 4.3 Mid-run: park

1. One tool on the Triage root agent, `ask_requester({question, why, options?})`. Investigators do not get it; they return a `blocked_on` next to `gaps`, and the orchestrator decides whether it is worth asking.
2. The tool runs the egress redaction over the question (it leaves the process), writes an input request to the run store, and sets the phase to `needs_input`.
3. `useAgentFinish` accepts a successful `ask_requester` as a valid stop, next to `finish_report`. The submission settles; nothing runs while waiting.
4. The transport shows the request (§4.4).
5. The answer comes back through one function, `answerInput(run_id, question_id, answer, by)`: it checks the run is waiting on that question, stores the answer, and dispatches a new submission on the same run (the `askRun` path with a different rendering). The model sees its question, the evidence so far and the answer, then finishes or asks again, up to the cap.
6. Unanswered by the deadline, or skipped: the run finishes with what it has and lists the request in `gaps`.

Request record, presentation-neutral: `question_id`, kind (`provide` | `do`), text, optional fixed choices, whether free text is allowed, status (`open` | `answered` | `skipped` | `expired`), asked-at, expires-at, asked-by (tool or agent). No Block Kit, no ANSI, no HTML.

### 4.4 One core, thin adapters per transport

| Transport | Show | Answer | Notes |
|---|---|---|---|
| CLI | `wait`, `status`, `run` see `needs_input`; `--json` prints the record; with a TTY, prompt inline | inline, or `triage input <run_id> <question_id> "…"` | `input` spawns a detached worker as `ask` does |
| HTTP | `GET /triage/:run_id` includes the record | `POST /triage/:run_id/input` | 409 unless the run is waiting on that `question_id` |
| Slack | push to the requester: buttons for choices, Done, Skip, a text box | signed interaction → `answerInput` | the only push; v2, with the bot |

The future web UI and the Claude Code skill are clients, not adapters. The UI renders a card from the HTTP record. The skill reads the CLI JSON, maps it to `AskUserQuestion`, then runs `triage input` with the user's own words; it must never answer for the user or perform a `do` step itself.

### 4.5 CLI: no session

- `triage run` already holds the process for the whole run. It becomes a loop: run → `needs_input` → prompt → resume → … → report.
- `triage wait` with a TTY prompts inline and keeps waiting; with `--json` it prints the record and exits with a fourth code (today 0 done, 1 failed or stalled, 3 timeout).
- `needs_input` counts as neither running nor stalled in `runStatusOf`.
- Nobody looking: the run parks, `triage status` shows the open question, it resumes when `input` arrives. Optional: a desktop notification from the worker when it parks. The deadline is enforced by whichever command looks next; no timer runs on a laptop.

### 4.6 Slack

- Sent privately to the requester (a DM, or an ephemeral message in the thread), never as a public post in the CX channel: the question is model text and would otherwise be an unapproved post.
- The answer goes to the existing run. HLD 02 §5.4 mints a new run id per Slack ask; the answer path is the exception, found by looking up an open request for that thread and user.
- The handler checks the signature and the responder, drops duplicates, acknowledges Slack within its window, then calls `answerInput`.

### 4.7 Rules

- No interface knowledge in the agent or in the record.
- Lowest common denominator for question types: text, fixed choices, free text. Nothing one adapter cannot render (files, images, multi-select).
- Questions pass egress redaction. Masking can make a question unanswerable ("which of UTR ****1234 / ****5678"), so the tool description tells the model to phrase questions with things the reader can recognise: amount, timestamp, last four.
- An answer is untrusted text, like the thread. Only ids passed structurally (`--ids`, a JSON field) go through the ingress identity step and widen scope; free text never does.
- A cap of one or two asks per run, and an eval that the model does **not** ask when the thread already has what it needs. A model with an ask tool tends to ask instead of investigate.

## 5. Decisions proposed

Pending the owner. Each becomes a D-entry when accepted.

| # | Chosen | Rejected |
|---|---|---|
| P6.1 | Relay through the run store; the agent is interface-blind | a per-interface channel into the agent |
| P6.2 | Park: settle the submission, resume with a new one on the same run | hold inside a tool; keep investigating while waiting |
| P6.3 | Only the orchestrator asks; investigators return `blocked_on` | investigators asking directly |
| P6.4 | `do` requests are code-authored, fixed text, local mode only | model-authored commands for a human |
| P6.5 | Ask at ingress for predictable cases before spending on a model | always mid-run |
| P6.6 | One core (`answerInput`, the record, the phase) and thin adapters per transport | separate implementations per product |
| P6.7 | No CLI chat session; `run` loops, `wait` prompts, `input` spawns a worker | a resident session owning the run |
| P6.8 | Its own request record and a `needs_input` phase | a partial report with a `needs_input` status |
| P6.9 | Slack question goes privately to the requester; the answer resolves the existing run | a public thread reply; a new run per answer |

## 6. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A-P6.1 | Most "provide" blocks are visible at ingress (no id, screenshot-only) | the mid-run tool carries more weight; P6.5 still costs nothing |
| A-P6.2 | A Slack wait can take hours, so the mechanism must survive an idle run and a restart | hold would be viable for Slack; it is still ruled out for the reasons in §7 |
| A-P6.3 | `do` requests only make sense when the person is on the machine running the triage (local mode) | a server needs an ops channel, out of scope here |
| A-P6.4 | The requester is the right person to answer "provide" questions | Slack needs a configurable responder set (§9) |
| A-P6.5 | One or two asks per run is enough; more means the model is avoiding work | raise the cap after evals |
| A-P6.6 | A laptop has no timer process, so deadlines are enforced lazily | a scheduled job on the server side, as retention does |
| A-P6.7 | Cross-process `dispatch()` into a live CLI worker is not needed once hold and join are dropped | it must be verified before any "keep going while waiting" design |

## 7. Discarded, and why

- **Hold: a tool blocks and polls the store until answered.** The store holds persisted-profile text only, so the tool would read an over-masked answer. The 15-minute run timeout keeps counting. A crash settles the call with an unknown outcome instead of resuming. Its one benefit, keeping an investigator's in-flight context, is small: investigators are cheap to re-brief and their findings are already saved by `note_evidence`.
- **Keep investigating while waiting (join the message at the next turn).** Same timeout, and delivery from a second process into the CLI worker is unverified.
- **Model-authored `do` requests.** Injection surface; see §4.1.
- **A chat session on `triage run` or `triage start`.** `start`/`wait` exist because a resident process is what breaks coding agents (D28). A session owning the run dies with the terminal or leaves an orphan. A chat framing pulls the model toward conversation, and the design's unit is one structured report. There is nothing for a session to hold: state is in the run store and the Flue conversation.
- **Calling pi's `ctx.ui.*` or another framework's UI action from Flue.** Not present in Flue's dependencies; see §3. What can be borrowed is the API shape, which §4.3 does.
- **`@flue/react` and the agent router for the web UI.** D25: the raw conversation stream carries unmasked account numbers and phones. The web UI uses the `/triage` API.
- **A partial report with a `needs_input` status as the carrier.** Reuses formatting and posting, but half-finished reports would flow into evals, embeddings and Slack posting.
- **Investigators asking the person directly.** They render fresh per task and cannot use persistent state; only the orchestrator can park and resume.
- **Fail and re-run with more input as the mechanism.** Violates the ask (partial state must survive) and loses evidence unless prior cases is on, which it is not by default (D43).
- **Rich question types (file upload, images, multi-select).** Not renderable on every adapter; Slack buttons and a text box set the floor.
- **A blocking pre-flight prompt for `do` items.** Not discarded; it changes D32 ("warns, never blocks") and is left to the owner (§9).

## 8. Things to fix regardless of this proposal

- Persist ids added by `resolve_identity` across submissions, and accept structured ids on the ask/input path through the ingress identity step. `triage ask` loses them today.
- `POST /triage/:run_id/ask` should refuse (409) while the run is going, as the CLI does.
- One name for the waiting phase. The discussion used `awaiting_input` and `needs_input`; `needs_input` is the one in this document.

## 9. Questions for the owner

1. Reverse "do not ask clarifying questions" for the orchestrator? What cap per run: 1 or 2?
2. Who may answer in Slack: the requester only, or the on-call group as well?
3. May a `do` request block pre-flight in a terminal (a change to D32), or must it stay a warning?
4. Sequence: ingress-time asks first and mid-run parking later, or both together?
5. Storage: its own request record and phase (P6.8), or a partial report?
6. Slack delivery: a DM (survives a reload) or an ephemeral message in the thread (does not)?
7. The deadline for an unanswered question before the run finishes with gaps.
8. A desktop notification from the CLI worker when a run parks: wanted?
