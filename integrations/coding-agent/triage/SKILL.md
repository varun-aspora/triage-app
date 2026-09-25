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
- `needs_input` (exit 4): the run is paused on a question only the user can
  answer. Go to step 2a, then wait again.
- `blocked` (exit 6): the run is parked because a system it needs did not
  answer. Go to step 2b; wait again once the run is resumed.
- `failed` or `stalled` (exit 1): tell the user the `reason` and stop. Do not
  start a new run unless they ask. To see what went wrong, read the run's
  steps with `triage logs <run_id>` (step 7). If the user asks to try again,
  `triage resume <run_id>` (step 2b) continues a run that failed after it had
  started; the CLI says so when a new run is needed instead.
- `stopped` (exit 5): someone stopped the run. Tell the user. A follow-up
  (step 4) or `triage resume` (step 2b) starts it again.

Exit 3 is also a config error. That one prints `{"error":{"code":"CONFIG",...}}`
instead of a `status`; show the message to the user and stop.

For progress without waiting, `triage status <run_id> --json` shows the phase,
tier and submission count.

### 2a. When the run asks a question

The JSON carries `input_request` with `question`, `why`, `options` and
`free_text`. Put the question to the user as it is, with its options: in
Claude Code use the AskUserQuestion tool with the options as the choices
and free text allowed; in other agents ask in plain text. Then send their
answer to the run and wait again:

```sh
triage input <run_id> "<the user's answer, in their words>" --requested-by '<user email or Slack id>' --json
triage wait <run_id> --timeout 90 --json
```

- Never answer for the user and never guess. If they cannot answer, run
  `triage input <run_id> --skip --json`; the report lists the question under
  its gaps.
- If the answer names an id (a customer id, an account number, a form id),
  pass it as well with `--ids key=value`, so the run can verify it before it
  is used.
- A run may ask more than once. Each time, ask the user and send the answer.

### 2b. When the run is blocked on a system

The JSON carries `block` with `systems` (the ones that did not answer, as
`<entity>:<service>`), `reason`, `failures` (each failed call, with its time)
and `blocked_at`. Tell the user which systems did not answer and the reason,
as the run states them. Do not probe, restart or fix anything yourself, and
do not resume on your own: the run needs the system back first.

When the user says the system is back, or asks to try again, resume the run
and wait again:

```sh
triage resume <run_id> "<what the user said was fixed, and anything new to consider>" --requested-by '<user email or Slack id>' --json
triage wait <run_id> --timeout 90 --json
```

- The message is optional. When the user said what changed, or added anything the run should consider, pass their words.
- `triage resume` prints `{"run_id":"...","submission_id":...}` once the run
  is on its way. It refuses a run that is still going, is waiting on a
  question or has completed, and says what to do instead; show that message
  to the user.
- If the system still does not answer, the run blocks again. Tell the user
  and wait for them.
- `triage ask` is refused while a run is blocked. Resume it first.

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

If the user says whether the run was right, record it. It can be given while
the run is still going:

```sh
triage feedback <run_id> --verdict accept|reject --notes '<what the user said>' --given-by '<user email or Slack id>'
```

- Record only what the user said. Never judge the run yourself.
- `--notes` is optional. `--actual-root-cause '<what it really was>'` and
  `--finding <id>=accept|reject` are optional too; finding ids such as
  `ssfb.v2.e1` are listed in the run's findings.
- `correct`, `partial`, `wrong` and `pending` still work as verdicts.

## 7. Stopping a run, and its steps

Only when the user asks to stop or cancel a run that is still going:

```sh
triage stop <run_id> --given-by '<user email or Slack id>' --json
```

This stops the agent and records the run as rejected, with no notes. A
follow-up (step 4) or `triage resume` (step 2b) starts it again.

Every step of a run is logged. When the user asks what a run did, or why it
failed, print the steps:

```sh
triage logs <run_id>
triage logs <run_id> --type tool --type failed
```

Show the lines the user asks about. Do not paste the whole log.

## Workspace

Use this skill from a workspace that holds no bank or database credentials.
If the workspace does hold them, the operator can install the PreToolUse
hook from `integrations/coding-agent/pretooluse-triage-only.json` in the
triage-app repository, which lets only `triage` commands through the shell
tool there.
