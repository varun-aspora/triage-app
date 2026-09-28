---
name: triage-compare-ticket
description: Run one support ticket from the Tech tab of the triage tickets Google Sheet through both triage agents, triage-shivalik (a traced Claude Code session in ../triage-shivalik) and triage-app (its HTTP API), with the same user message, then compare the two runs with /braintrust-triage-app-vs-shivalik. Picks the newest ticket it has not processed before unless given a ticket number. Use whenever the user asks to run, triage or compare a ticket on both agents, "pick a ticket from the sheet", "run the next ticket", "triage ticket 123 on shivalik and app", or passes a ticket number with --shivalik-session, even if they don't name the skill.
---

# Run a ticket through both triage agents and compare

```
/triage-compare-ticket [<ticket-number>] [--force] [--shivalik-session <name>] [--ask]
```

- `<ticket-number>`: the value in the first column of the Tech tab. Without it, pick a ticket.
- `--force`: process the ticket again even if the log says it was done. Only when the user asks for it.
- `--shivalik-session <name>`: send the prompt to a triage-shivalik session the user already started, instead of starting a new one.
- `--ask`: before starting either run, show what is about to be used and ask the user whether to go ahead (step 3).

Scripts are in `scripts/` next to this file. Keep working files (the query, notes) in the session scratchpad, or `$(mktemp -d)` if there is none. Ticket content is customer data, so it does not go into the repo.

## 1. Get the ticket

Invoke the skill `fetch-ticket-from-pbm-sheet`. It runs in its own subagent, reads the **Tech** tab of the triage tickets sheet and the ticket's Slack thread, and writes the result to a JSON file. The sheet and thread stay out of this context. Pass:

- **Ticket number given**: `<ticket> --skip-recent 15m --max-age 31d --thread first --out $W/ticket.json`
- **No ticket number**: `--sort "raised_at desc" --skip-recent 15m --max-age 31d --exclude "<tickets from scripts/log.sh seen, space-separated>" --thread first --out $W/ticket.json`. This picks the newest ticket that is at least 15 minutes old (so its thread is filled in), at most a month old, and not processed before.

It replies with one line, `OK <file> ticket <n>` or `ERROR <code> <file>`. Read what you need from the file with `jq`: `.ticket`, `.raised_at`, `.age_minutes`, `.thread` (`link`, `channel`, `thread_ts`, `posted_at`) and `.user_query`. Don't read the sheet or the thread yourself.

On `ERROR`, `.error.message` says what happened:

- `not_signed_in`: stop and ask the user to run `/mcp` and sign in to the connector it names.
- `no_such_ticket`, `filtered_out`: the ticket asked for doesn't exist in the Tech tab, or was raised in the last 15 minutes or more than a month ago. Stop and pass the message on.
- `no_match`: every eligible ticket was already processed. Say so and stop. Don't repeat one unless the user asks.
- `no_thread_link`, `bad_thread_link`: with a ticket number, stop and say so. Otherwise invoke `fetch-ticket-from-pbm-sheet` again with that ticket added to `--exclude`.
- Anything else: stop and pass the message on.

A ticket in the log (`scripts/log.sh seen`) that was asked for by number is still processed, but tell the user it was done before (the log has the earlier ref_id and run_id). `--force` is how they say it's intended.

## 2. Build the user message

`USER_QUERY` is the first message of the Slack thread, the one that opened it, as posted: `jq -r .user_query $W/ticket.json > $W/query.txt`. Replies are later discussion, and neither agent should see them. Don't reword, summarize or add anything, because the comparison only means something when both agents get exactly the same text. Show `USER_QUERY` to the user.

Generate `REF_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')`. With `--shivalik-session triage-shivalik-<uuid>`, use that uuid instead, because it's the ref the session's trace is tagged with.

## 3. Ask before starting (only with `--ask`)

Without `--ask`, go straight to step 4.

With `--ask`, nothing has been started yet. First run `scripts/app_run.sh check`, which prints the triage-app URL or says the server is down. With `--shivalik-session`, also check `ListAgents` lists that name and note whether it's idle. Then show the user the state:

```
Ticket:            <number> (raised <raised_at>, <age> ago)
Processed before:  no | yes, ref_id <old ref> run_id <old run> (--force: yes/no)
REF_ID:            <REF_ID>
triage-shivalik:   new session | existing session
  Remote Control:  triage-shivalik-<REF_ID> | <the given name> (idle / busy / not found)
  Opens in:        herdr tab in this workspace | new <Ghostty/Alacritty/iTerm/Terminal> window
  Braintrust:      project varun-test-2, tagged with REF_ID
triage-app:        <URL from app_run.sh check> | not running
  Idempotency-Key: <REF_ID>
Query file:        $W/query.txt
```

`Opens in` is herdr when `HERDR_ENV=1`; otherwise it's the first of those apps installed in /Applications or ~/Applications. Leave it out with `--shivalik-session`. The `USER_QUERY` from step 2 is shown right above this, so don't repeat it.

Ask with `AskUserQuestion`: "Start triage on both agents?", options "Start both" and "Stop". If the user picks Stop, stop without starting anything or writing to the log, and give them `REF_ID` and the query file. If they answer with something else (a different session, only one agent), do what they asked and show the state again before starting. If triage-app is not running or the given session is not found, show the state, then stop and say what to fix instead of asking.

## 4. Start both runs

Start both, then wait for both. They don't depend on each other.

**triage-shivalik.** Without `--shivalik-session`, run `scripts/shivalik_session.sh start $REF_ID`. It runs `tracing-braintrust.sh $REF_ID triage-shivalik-$REF_ID` in ../triage-shivalik, so that repo's skills and hooks load. The result is a Claude Code session named `triage-shivalik-$REF_ID`, traced to Braintrust project varun-test-2. Inside herdr it opens a new tab in the current workspace. Otherwise it opens a window in Ghostty, Alacritty, iTerm or Terminal, whichever it finds first. The shell stays open, so the user can switch to it and watch or step in. Its SessionStart hooks take up to ~30 s. Call `ListAgents` until the name shows as idle.

With `--shivalik-session <name>`, check `ListAgents` lists that name.

Then send the session this prompt with `SendMessage` (to the session name), exactly:

```
Triage using ref_id: ${REF_ID}
<user-message>
${USER_QUERY}
</user-message>
```

**triage-app.** Run `scripts/app_run.sh start $W/query.txt $REF_ID`. It POSTs `USER_QUERY` as the only message to the local triage-app server and prints the run id. `REF_ID` doubles as the Idempotency-Key, so a retry doesn't start a second run. If the server isn't running, the script says how to start it. Stop and pass that on; don't start it yourself.

Once both have started, record the ticket: `scripts/log.sh add <ticket> $REF_ID <run_id>`.

## 5. Wait for both

Run each wait as a background Bash command, so you're told when it ends:

- `scripts/shivalik_session.sh wait $REF_ID`: returns when the session finishes the turn that started with the prompt. It gives up after 120 min (`WAIT_MINUTES` to change that).
- `scripts/app_run.sh wait <run_id>`: returns when the run is completed, failed, stopped, blocked, waiting on the requester (`needs_input`), or stalled.

A shivalik session that ends its turn with a question also counts as finished. Tell the user it's waiting on them. The same goes for an app run that ended `needs_input` or `blocked`. Compare what exists, and say in the result that the run didn't finish.

## 6. Compare

Run `scripts/find_spans.sh $REF_ID <run_id>`. It finds the Braintrust root span of each run, and retries for a couple of minutes while traces land. If a span is still missing, tell the user which one and stop.

Then invoke the skill `braintrust-triage-app-vs-shivalik` with `--app-span-id <app_span_id> --shivalik-span-id <shivalik_span_id>`, and let it produce its report.

## What to tell the user

Keep it short. Give the ticket number, `REF_ID`, the shivalik session name, the app run id, both span ids, how each run ended, and then the comparison.
