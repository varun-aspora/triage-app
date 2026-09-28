---
name: braintrust-triage-app-vs-shivalik
description: Compare a triage-app run with a triage-shivalik run of the same ticket using their Braintrust traces, explain why triage-shivalik did better, and turn the gap into actionables for triage-app (changes that win the ticket, make the agentic workflow cheaper and faster, and make it more dynamic without weakening its guards), each with span-id evidence and target files. Use this whenever the user passes --app-span-id / --shivalik-span-id, pastes two Braintrust span or trace ids (projects varun-test / varun-test-2), or asks why shivalik beat triage-app on a ticket, what triage-app missed on a run, or how to close the gap between the two triage agents — even if they don't say "compare" or name the skill.
---

# triage-app vs triage-shivalik from Braintrust traces

Two agents investigate the same support tickets and both trace to Braintrust:

- **triage-app** (`/Users/varun/code/work/triage-app`): a Flue agent. Spans are named `flue.prompt` (a task or subagent run), `flue.turn` (one model call), and `tool:<name>`. Delegated work shows as `tool:task` with a child `task:<name>` run. The decision-model (`decide …`) and embedding calls are logged as **separate one-span traces** in the same project, so the fetch script gathers them into `nearby.json`.
- **triage-shivalik** (`/Users/varun/code/work/triage-shivalik`): Claude Code running the `aspora-triage` skill. Spans are named `Claude Code: triage-shivalik` (session), `Turn N`, `claude-opus-*` (model calls), `Terminal: <cmd>`, `Read: <file>`, `MCP: …`, `skill: …` and `subagent: …`.

triage-shivalik currently gives better answers. The user wants more than a diff of the two runs. They want actionables for triage-app in three groups:

1. **Win**: changes that would have made triage-app reach an answer as good as shivalik's, or better, on this ticket and tickets like it.
2. **Optimize**: changes that reach the same answer with fewer turns, tokens and wall time, or fewer dead ends.
3. **Dynamic but secure**: places where triage-app's fixed structure stopped it from following a lead, and how to open that up while keeping it safe.

The diff is the evidence. The actionables are the deliverable.

## Inputs

```
/braintrust-triage-app-vs-shivalik --app-span-id <id> --shivalik-span-id <id>
    [--app-project <name>]       default varun-test
    [--shivalik-project <name>]  default varun-test-2
    [--input "<prompt given to both>"]
```

Any span id in a trace works: root, child, or the row id. If the user pastes ids without flags, work out which is which from the id format (triage-app ids are 16 or 32 hex chars, shivalik ids are UUIDs) and confirm only if that's still ambiguous.

## Step 1: fetch both traces

Use the bundled script. It uses the `bt` CLI, which is already logged in, and writes files you can read in parts instead of pulling megabytes of JSON into context:

```bash
S=<this skill dir>/scripts/fetch_trace.py
W=<scratch dir>   # session scratchpad if one is listed, else $(mktemp -d)
python3 $S --project varun-test   --span-id <app-id>      --out $W/app      --label app
python3 $S --project varun-test-2 --span-id <shivalik-id> --out $W/shivalik --label shivalik
```

Run both even if the first one fails, so the user learns about every bad id at once. Each output directory holds `summary.json` (totals, errors, root input/output), `timeline.md` (one line per span in tree order, with previews), `raw.json` (full rows) and `nearby.json` (other root traces in the same project that started while this one ran).

- Exit code 2 means the project or span wasn't found. The script prints any close matches (a typo away, or a prefix). **Stop there and tell the user** which id was missing from which project, list the close matches as suggestions, and say whether the other id was found. Don't run the comparison on a suggested id until the user confirms it: one wrong character can mean a different run or a different ticket.
- Exit code 3 means `bt` failed. If `bt` is missing or not logged in, use the Braintrust MCP server if this session has it, or the REST API with `BRAINTRUST_API_KEY` (`POST https://api.braintrust.dev/btql`), and pull the same data.
- If `summary.json` has `"complete": false`, or spans have cut-off outputs, say so in the report. Don't fill gaps with guesses.

Keep traces in the scratch dir. They contain customer data and don't belong in the plans folder.

## Step 2: check the inputs match

Use `--input` if the user gave it. Otherwise take the prompt from each trace: the first user message of the root `flue.prompt` in the app trace, and the `Turn 1` input in the shivalik trace. triage-app wraps the ticket in its own request template, so compare the ticket content (user id, summary, description), not the exact text. If the tickets differ, say so at the top of the report. The comparison can still be useful, but every conclusion is weaker.

Also check whether either agent had notes from an earlier look at the same case, for example a shivalik `Read:` of `refs/…` or a doc paragraph that names this user, or triage-app prior cases. If one did, say so in the Summary. It makes the comparison unfair in a way the user needs to know about.

## Step 3: rebuild each run

Read `timeline.md` for both runs. When a preview is too short to judge a step, pull the full span from `raw.json` with jq, for example `jq '.[] | select(.span_id=="<id>") | .output' raw.json`. For each run, write down:

- the steps in order: what the model decided, which tool it called with what arguments, and what came back (rows, log hits, empty, error)
- the hypotheses it formed and when it dropped or confirmed them
- the final answer: the root cause it named and the evidence it cited. For triage-app this is usually the `finish-report` tool call or the last `flue.prompt` output. For shivalik it's the `Turn 1` output.
- for triage-app, where the decision-model calls in `nearby.json` fit (they usually run just before the agent starts)
- how the run ended: finished, timed out, aborted, blocked. Look at root errors and the `flue.stop_reason` metadata.

triage-app also keeps its own run log at `triage-app/.data/runs/<run-id>/` (the run id is in the root span's metadata or input). Earlier runs for the same user show whether a failure repeats. That's worth a look when this run ended early.

## Step 4: compare

Treat shivalik as the reference, not the truth. Check each run's conclusion against the tool outputs it actually saw. An answer is better when its cause is specific and backed by rows or log lines in the trace. Compare on:

1. **Final answer**: root cause, correctness against the evidence, how specific it is, and whether it is actionable.
2. **Investigation path**: which systems, tables, log indexes and code each run touched, and in what order. Name the first point where the paths split, and what triage-app never looked at or reached too late.
3. **Tool use**: failed calls, wrong tools, retries, queries that returned nothing, and repeated calls that added no information.
4. **Errors and missing data**: what each run did when a tool failed or data was missing, and whether it fell back (read code, tried another source) or stalled.
5. **Cost**: model calls, tool calls, tokens (prompt, completion, cached), wall time, and dollars. If triage-app spans have no `estimated_cost` (`cost_missing_on_llm_spans` > 0) or all show 0, say it's unpriced. Don't report $0.

For each difference, ask why triage-shivalik could do what triage-app didn't. Usually the answer is in what shivalik had available: the `aspora-triage` skill and its references under `triage-shivalik/.claude/skills/`, the docs it read (the `Read:` and `Terminal: cat …` spans show which files), and its tools (a shell, codegraph, logs finder). Open those files to confirm. "Shivalik read X and triage-app has nothing like X" is a strong finding.

If triage-app did better on some point, say so.

**Confirm suspected causes cheaply when you can.** A finding like "triage-app's log search found nothing" has several possible causes: wrong service name, wrong index, wrong term, or no data. A count-only, read-only query can tell them apart. Examples: a Quickwit count through the `quickwit-logs` skill, or `bt sql` against the trace data. Keep it to counts and names, never pull customer rows, and put the query and result in the report. Label each finding **confirmed** (checked) or **inferred** (read from the trace only).

## Step 5: turn findings into actionables

Read the triage-app source so each actionable names a real file. Don't edit anything. Main places:

| Area | Where |
|---|---|
| Orchestrator / investigator / code-walker prompts | `knowledge/method/*.md`, `src/agents/instruction.ts`, `src/agents/triage-plan.ts` |
| Domain knowledge the agent loads (`activate_skill`) | `knowledge/<area>/SKILL.md` (rtl-*, ssfb-*, atspl-*), `knowledge/patterns/` |
| Tools and their result shape | `src/tools/*.tool.ts`, `src/tools/_lib/`, `src/tools/code/` |
| Subagents / delegation | `src/agents/delegates/`, `src/agents/triage.agent.ts` |
| Guards: scope, ids, budget, tripwires | `src/gate/` (scope, id-patterns, quickwit, budget), `src/agents/tripwire.ts`, `src/agents/escalation.ts` |
| Classifier / decision model | `src/classify/`, `src/decisions/`, `resources/known-ids.json` |
| Entities, log services, API rules, repos | `resources/*.json` |
| Limits and timeouts | `src/config/env.ts`, `src/config/keys.ts` (`TRIAGE_RUN_TIMEOUT_MS` and similar) |
| Tracing gaps | `src/lib/tracing/` |

Check that a file exists before you name it. A file you propose creating is fine, but mark it as new. If you can't tell where a fix belongs, say so. Don't invent a path.

Check `~/code/work/plans/triage-app/` and `triage-app/docs/` for plan items that already cover a fix. Reference the item (for example "plan 13 T3") and mark each actionable **new** or **planned**. The user doesn't need a fix they already planned re-explained. They do need to know which planned items this run supports and what's missing from the plans.

Sort every actionable into one of the three groups. Put an item in the group of its main effect and cross-reference it from the others.

**1. Win.** What would have changed the answer? Missing knowledge, a missing or broken tool path, a wrong config value, a wrong delegation order, a guard that blocked a needed lookup. Rank by how directly the fix closes the gap on this ticket, then by how many other tickets it helps. Say what "fixed" looks like: rerun the ticket and expect span X to return Y.

**2. Optimize.** Same answer, less work: wasted turns, dead ends the agent could have skipped, repeated or LIKE-fishing queries, schema discovery the notes could answer, slow or over-long model turns, serial work that could run in parallel (or parallel work that needed ordering), prompt size and caching, results lost at a timeout. Give the saving in numbers from the trace (turns, seconds, tokens) where you can.

**3. Dynamic but secure.** Where did triage-app's fixed structure stop it from following a lead? Examples: a fixed log-service registry, a fixed id chain, skills that are mounted for some agents but not others, a fixed delegation plan, per-entity tool scope. Shivalik is fully dynamic (a raw shell), but it pays in safety: its guard is hooks, and the hook denials in its trace show where they fired. For each item give both halves:
   - **Opening:** what becomes dynamic (discover services at runtime, grow the id chain from a verified lookup, let an investigator ask for a note or a second-wave brief).
   - **Guard:** what keeps it safe. Examples: the scope gate still checks every id, reads stay read-only, PII is masked in results, budgets and allowlists cap it, and the action is audited. Name the file where the guard lives or would live.
   Never propose removing a guard without a replacement. If an opening has no workable guard, say so and leave it out.

Each actionable carries:
- **Change**: one or two sentences.
- **Evidence**: span ids from both traces, and whether it's confirmed or inferred.
- **Target files**
- **Effect**: what it fixes, with numbers where the trace gives them.
- **Effort**: S (config or notes), M (one module), L (cross-cutting or needs an owner decision).
- **Status**: new or planned (plan reference).
- **Verify**: how to tell it worked.

## Step 6: write the report

Save to `~/code/work/plans/triage-app/comparisons/<YYYY-MM-DD>-<first 8 chars of the app root span id>.md`. Create the folder if needed, and add a `-2` suffix instead of overwriting an existing file. If you can't write the file, give the full report in your reply instead. Don't route around a write block with a shell redirect. Use this structure:

```markdown
# triage-app vs triage-shivalik: <short ticket title>

## Inputs
- triage-app: project <name>, root span <id> (requested <id>), <n> spans
- triage-shivalik: project <name>, root span <id> (requested <id>), <n> spans
- Ticket: <the ticket, PII masked>. <Whether the two inputs match, and whether either agent had prior notes on this case.>

## Summary
<3–5 plain sentences: what each concluded, which is better supported and why, and the single most valuable actionable from each group.>

## Side-by-side timeline
| # | triage-app | triage-shivalik |
|---|---|---|
<Group spans into steps; don't list every span. Each cell: what it did → what it got, with span id(s). Line up the steps that do the same job, mark where the paths split, and end with the final answers and how each run ended.>

## Numbers
| | triage-app | triage-shivalik |
|---|---|---|
| Wall time | | |
| Model calls / tool calls | | |
| Tool errors / empty results | | |
| Prompt / completion / cached tokens | | |
| Cost | | |

## Why triage-shivalik is better
<Numbered findings. Each: the claim, the evidence (span ids from both traces), confirmed or inferred, and the cause (the file, knowledge or tool shivalik had that triage-app lacked). Include points where triage-app did better.>

## Actionables

### 1. Win
| # | Change | Evidence | Target files | Effect | Effort | Status | Verify |
|---|---|---|---|---|---|---|---|

### 2. Optimize the agentic workflow
<same table>

### 3. More dynamic, still secure
| # | Opening | Guard | Evidence | Target files | Effect | Effort | Status |
|---|---|---|---|---|---|---|---|

### Suggested order
<3–6 lines: which items to do first and why. Usually cheap Win items first, then the Optimize items that stop runs from timing out, then the Dynamic items that need an owner decision.>

## Open questions
<What the traces can't answer, incomplete spans, owner decisions the actionables need, and things worth checking in the next pair of runs.>
```

Then print the Summary, the Suggested order and the report path in chat.

## Writing rules

- Plain, factual language. Say "the query returned 0 rows", not "the agent was completely lost".
- Back every claim about a run with a span id. If you can't point to a span, it's a guess, and either drop it or list it under Open questions.
- Traces contain customer data. The report may use the internal user id from the ticket, but never quote names, phone numbers, emails, addresses, device ids, account, card or document numbers, or free-text customer content from tool outputs. Describe them instead ("the KYC row for the user", "3 inbound SMS rows"), or give counts and field names.
- Read-only: don't change either repo and don't write anything to Braintrust (no scores, comments or tags). The count-only checks in Step 4 are the only live queries.
