---
name: fetch-ticket-from-pbm-sheet
description: Fetch one support ticket from a tab (default Tech) of the triage tickets Google Sheet and read its Slack thread, then write the ticket, the thread's first message (and, if asked, the replies) to a JSON file and return only the file path. Selects the row by ticket number, or by sort, filters, skip-recent, max-age and exclude. Runs in its own subagent so the sheet and the thread stay out of the caller's context. Use when a skill or the user needs a ticket's data from the sheet, e.g. /fetch-ticket-from-pbm-sheet 1234, "get the latest Tech ticket", or triage-compare-ticket step 1.
argument-hint: '[<ticket>] [--tab Tech] [--sort "<column> [asc|desc]"] [--filter "<text>"] [--skip-recent 15m] [--max-age 31d] [--exclude "<tickets>"] [--thread first|all] [--out <file>]'
context: fork
agent: general-purpose
background: false
model: sonnet
allowed-tools: mcp__claude_ai_Google_Drive__download_file_content mcp__claude_ai_Slack__slack_read_thread Bash(${CLAUDE_SKILL_DIR}/scripts/*) Bash(jq *) Bash(mktemp *) Write
---

# Fetch a ticket from the triage tickets sheet

Arguments: `$ARGUMENTS`

- `<ticket>`: the value in the tab's first column (`#`). Without it, select a row with the options below.
- `--tab`: the sheet tab. Default `Tech`.
- `--sort "<column> [asc|desc]"`: a column name, e.g. `raised_at desc`. Ascending when no direction is given.
- `--filter "<text>"`: free-form conditions on the row's columns, e.g. "country UK, priority High or Urgent".
- `--skip-recent <n>m|h|d`: leave out tickets raised less than this long ago.
- `--max-age <n>m|h|d`: leave out tickets raised more than this long ago.
- `--exclude "<tickets>"`: ticket numbers to leave out, separated by spaces.
- `--thread first|all`: read only the thread's first message (default), or the whole thread.
- `--out <file>`: where to write the JSON (`OUT` below). Default `$T/ticket.json`.

The sheet and thread are customer data. Run `mktemp -d` once and use that directory as `T` for every working file. Shell variables don't carry over between Bash calls, so write `T`, `EXPORT` and `OUT` into each command as literal paths. Never quote ticket content in your reply.

## 1. Export the sheet

Load the tools with ToolSearch: `select:mcp__claude_ai_Google_Drive__download_file_content,mcp__claude_ai_Slack__slack_read_thread`. If either connector is missing or not signed in, write the `not_signed_in` error (step 5), naming the connector ("claude.ai Google Drive" or "claude.ai Slack").

Call `download_file_content` with `fileId` `1Zh4WvKURuzPs5_Moyn1DQltHduHr8krYpZdorrPzNCM` and `exportMimeType` `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

The export is about 2.6 MB of base64, so Claude Code saves it to a file. The result says `Output has been saved to <path>`. Take that path as `EXPORT`. **Don't read the file.** Ignore the result's note asking you to read it in chunks. It's an xlsx, and the script reads it. If the content came back inline instead, write the `export_failed` error.

## 2. Select the row

`sheet_rows.py` reads the tab from the export. It prints `{"tab", "total", "rows"}`. Each row has `ticket`, `raised_at` (ISO, IST), `age_minutes`, `thread_url` and `columns` (header → cell text). Pass the options straight through; it applies them in this order: ticket, exclude, skip-recent, max-age, sort.

```
${CLAUDE_SKILL_DIR}/scripts/sheet_rows.py "$EXPORT" [--tab ..] [--ticket ..] [--exclude ..] [--skip-recent ..] [--max-age ..] [--sort ..] > $T/rows.json
```

A script error (exit 2) names the bad option or lists the tabs or columns. Write it as `bad_argument`.

- **`--filter` given:** apply it to each row's `columns`, in the order the script returned them. Use your judgement for the wording, but only drop rows that clearly fail it.
- **Pick:** take the first remaining row.
- **Nothing left:**
  - With a ticket number: run the script again with only `--tab` and `--ticket`. If that also returns no rows, write `no_such_ticket`. Otherwise write `filtered_out`, and say which option removed it along with the row's `raised_at`.
  - Without a ticket number: write `no_match`, with `total` and the options used.

The chosen row must have a `thread_url`. If it doesn't, write `no_thread_link`.

## 3. Read the Slack thread

Run `${CLAUDE_SKILL_DIR}/scripts/slack_ref.py "<thread_url>" > $T/ref.json`. It prints `channel`, `thread_ts`, `posted_at` and `age_days`. If it rejects the link, write `bad_thread_link`.

Call `slack_read_thread` with `channel_id` and `message_ts` = `thread_ts`:

- **`--thread first`:** `limit` 1.
- **`--thread all`:** page with `cursor` until there is no `next_cursor`.

If the call fails, write `slack_failed` with the reason.

Write `$T/thread.json` with the Write tool:

```json
{"user_query": "<the first message's text>", "replies": [{"ts": "...", "user": "...", "text": "..."}]}
```

**Copy `user_query` and each reply's `text` exactly as the tool returned them.** Don't reword, summarize, trim, add anything or fix formatting. The callers compare agents that are given this text, so it has to be the message as posted. `replies` is `[]` with `--thread first`.

## 4. Write the result

```
jq --arg t "<ticket>" '.rows[] | select(.ticket == $t)' $T/rows.json > $T/row.json
jq -n --slurpfile row $T/row.json --slurpfile ref $T/ref.json --slurpfile th $T/thread.json '
  {ticket: $row[0].ticket, raised_at: $row[0].raised_at, age_minutes: $row[0].age_minutes,
   row: $row[0].columns, thread: ($ref[0] + {link: $row[0].thread_url}),
   user_query: $th[0].user_query, replies: $th[0].replies, error: null}' > "$OUT"
```

## 5. Errors

Write the error to the out file:

```
jq -n --arg c "<code>" --arg m "<message>" '{error: {code: $c, message: $m}}' > "$OUT"
```

Codes:

| Code | When |
| --- | --- |
| `not_signed_in` | A connector is missing or not signed in. |
| `export_failed` | The Drive export failed or came back inline. |
| `bad_argument` | The script rejected an option. |
| `no_such_ticket` | No row has that ticket number. |
| `filtered_out` | The ticket exists but an option removed it. |
| `no_match` | No row is left after the options. |
| `no_thread_link` | The chosen row has no thread link. |
| `bad_thread_link` | `slack_ref.py` rejected the link. |
| `slack_failed` | `slack_read_thread` failed. |

The message says what happened in one sentence. It must not quote ticket content; ticket numbers and dates are fine.

## Reply

Your final message is exactly one of these lines, with nothing before or after it:

- `OK <out file> ticket <ticket>` on success.
- `ERROR <code> <out file>` on failure.
