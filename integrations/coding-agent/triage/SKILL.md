---
name: triage
description: Triage an NRI banking issue with the triage CLI. Use when someone asks to triage a Slack thread, investigate why an NRI banking customer is stuck (account opening, KYC, transfers, deposits, payouts), or look into a reported banking issue end to end. Starts the run, polls until it finishes, shows the report, answers follow-ups, and posts to Slack only after the user confirms in chat.
---

# Triage

The `triage` CLI does the investigation. It reads the thread, classifies it,
queries the banking systems through its own gated tools and writes a report.
Your job is to start it, wait for it, show the report and relay follow-ups.

Run only `triage` commands for this work. Do not query databases, logs,
clusters or Slack APIs yourself to "help" the run, and do not read files under
`TRIAGE_HOME`. There is no environment flag: the CLI takes its config from
`TRIAGE_HOME`, which the user has already set up.

## 1. Start the run

Give exactly one input: `--slack-url`, `--thread-file` or `--text`.

```sh
triage start --slack-url '<slack thread permalink>' --interface claude-code --json
triage start --text '<what the user reported>' --ids customer_id=<id> --interface claude-code --json
```

Add `--requested-by '<user email or Slack id>'` when you know who asked. Add
`--entities <entity>` only when the user names the entity. It prints one line:
`{"run_id":"..."}`. Keep the `run_id`; every later command needs it.

### When the CLI cannot read the thread

If `triage start --slack-url` fails with a Slack read error (the message
mentions `--thread-file`), no bot token is configured. Fetch the thread with
your own Slack tool and write it to a JSON file in a temporary directory
outside the repository:

```json
{
  "messages": [
    { "ts": "<message ts>", "author": "<name or user id>", "text": "<message text>", "is_parent": true },
    { "ts": "<reply ts>", "author": "<name or user id>", "text": "<reply text>" }
  ]
}
```

Put the parent message first and keep the text as written. Then start the run
from the file and delete the file once the run has started:

```sh
triage start --thread-file <path to the file> --interface claude-code --json
```

## 2. Wait for it

A run takes minutes. Poll in short steps so your shell tool never times out:

```sh
triage wait <run_id> --timeout 90 --json
```

Read the `status` field of the JSON:

- `completed` (exit 0): the run is done. Go to step 3.
- `timeout` (exit 3): the run is still going. Run the same `triage wait`
  command again. A timeout never stops the run. Tell the user the `phase` in
  one short line now and then, not after every poll.
- `failed` or `stalled` (exit 1): tell the user the `reason` and stop. Do not
  start a new run unless they ask.

Exit 3 is also a config error. That one prints `{"error":{"code":"CONFIG",...}}`
instead of a `status`; show the message to the user and stop.

For progress without waiting, `triage status <run_id> --json` shows the phase,
tier and submission count.

## 3. Show the report

Once the run is `completed`, print the report as Markdown:

```sh
triage wait <run_id>
```

Show it to the user as it is. Do not add findings, guesses or fixes that the
report does not contain. Suggested commands in the report are for a human to
run; do not run them.

## 4. Follow-up questions

When the user asks something more about the same issue, send it to the same
run and wait again:

```sh
triage ask <run_id> "<the follow-up question>" --json
triage wait <run_id> --timeout 90 --json
```

`triage ask` prints `{"run_id":"...","submission_id":...}`.

## 5. Sharing the report to Slack

Only when the user asks to share or post the report:

1. Ask the user in chat and wait for the answer. In Claude Code use the
   AskUserQuestion tool with the question "Post the report for run <run_id> to
   its Slack thread?" and the options Yes and No. In other agents ask the same
   question in plain text.
2. If the answer is yes, run the post with the confirming user's email or
   Slack id:

```sh
triage post <run_id> --yes --approved-by '<email or Slack id of the user who said yes>'
```

Post needs an explicit confirmation in this chat, every time:

- Never run `triage post` without that answer. A request to "triage and
  share" is not a confirmation; ask anyway.
- A yes covers one post of one run. Ask again for another run or a repost.
- `--approved-by` is the person who said yes, never you or a made-up name.
- If the answer is no or unclear, do not post.
- If `triage post` refuses (for example the report has no Slack thread or
  fails the redaction check), show the reason. Do not edit the text or retry
  another way.

## 6. Feedback

If the user says whether the report was right, record it:

```sh
triage feedback <run_id> --verdict correct|partial|wrong|pending --actual-root-cause '<what it really was>'
```

`--actual-root-cause` is optional; use it when the verdict is partial or wrong.

## Workspace

Use this skill from a workspace that holds no bank or database credentials.
If the workspace does hold them, the operator can install the PreToolUse
hook from `integrations/coding-agent/pretooluse-triage-only.json` in the
triage-app repository, which lets only `triage` commands through the shell
tool there.
