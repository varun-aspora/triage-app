# Logs

`logs_search` queries the entity's log index. Quickwit covers every entity:
SSFB, ATSPL and RTL each have their own. Whether it is set up in this
deployment shows in the answer; `not_configured` is a gap, not a reason to
stop the investigation. The note for your entity follows this one.

## Inputs

The tool description lists the inputs. What it leaves out:

- `any_of` suits several levels (`error` or `warn`), several labels, several
  id tokens or several services.
- `exclude` drops each value on its own.
- `contains` with a wildcard over several words returns 0 hits with no error.
- `group_by` and `count_distinct` take the fields the entity note lists, plus
  `service`. `normalize` folds messages that differ only by UUIDs, long hex
  strings and long numbers, so a group-by over messages groups the same
  failure together.

## Query forms

The result's `query` is the string the tool built. A query pasted from the log
dashboard uses the same syntax; its `NOT 'a' AND NOT 'b'` is
`exclude: ["a", "b"]` (`NOT ('a' AND 'b')` means "not both").

Every call is sorted by timestamp and sends both ends of its window in UTC.
The dashboard shows the window in the viewer's local time (IST on a laptop),
and tickets quote IST: convert to UTC before you set `from` or `to`. The tool
does not yet ask Quickwit for the query it actually ran (unverified: waits for
one manual check by the owner).

## Start free-form

Start with bare `terms` for one of the run's ids, with no `service`. Then read
one full hit (`raw: true`, or `columns`) for the real service name and field
names before you write a scoped query. Do not guess field names twice.

## The window is set by the tool

Every query runs in a bounded time window. With no `from` or `to` it is the
request window from the brief, which by default starts 30 days before the
thread's first message and ends now. You can narrow it or move `from` earlier;
you cannot run an unbounded query. The result reports the window it searched:
state that window.

Retention is about 30 days, and the oldest day comes back partial. Before you
state current state, search forward to now.

## Limits

- Over 5,000 hits the call returns early with the count, the window and no
  hits. Narrow the window, add an id or a field filter, or run `count` or
  `group_by` first.
- A run gets at most 50 `logs_search` calls, counted inside its tool-call
  limit. Past that the tool refuses log searches and says so; other tools
  still work, so finish with the evidence you have.

## Paging and counting

- A page is at most 250 hits (`offset` 0, 250, 500 and so on), and
  `next_offset` is present when more remain. Fetch the next page only when you
  need the lines themselves.
- To count, do not page: use `count`, `group_by` or `count_distinct`. A tally
  reads at most 5,000 hits and says how many it read in `tally_base`.
- `group_by: ["message", "error"]` over one service's errors in a short
  window is the first look at what is failing. `count_distinct` on a customer
  field turns "N lines" into "M customers".

## The field model: message is a label, error is the text

- In the Go services, `message` is the short label the developer passed the
  logger, and `error` holds the error text. The text a user or CX quotes is in
  `error`, not `message`. A quoted error searched as `message` returns zero
  while thousands of lines exist.
- So: user-quoted error text goes in `error`; a developer-sounding label goes
  in `message`.
- The exception is `workflow-op`, a Java service: the whole line is in
  `message` and there is no `error` field. Search its text with `message`.
- Each key the logger was given becomes its own field. `raw_message` holds the
  full JSON line with every quote escaped. Read fields from the hit; do not
  pattern-match inside `raw_message`, and do not use it as a search field.

## UUIDs and other ids

On RTL and ATSPL a UUID always goes in `terms`, sent whole in single quotes
(`'<uuid>'`); the tool refuses a UUID in any field there. On SSFB a UUID can
also go in its exact id fields (the SSFB note lists them) with the full value.
Check the full id in each hit before you count it.

## Correlation ids are reused

`x_req_id` and `x_txn_id` (hyphenated on some entities) are not unique per
request. One transaction id has been seen across well over a hundred lines
about unrelated records. Do not collect every id in a transaction and
attribute them. To tie a line without customer context to the customer, fetch
the lines around it sorted by time and walk back from that exact line to the
nearest earlier line that carries the customer's id.

A correlation id shaped like a UUID or a long number counts as an id for the
scope rule. Once an earlier `logs_search` result in this run showed it in
`x_req_id`, `x_txn_id`, `x-req-id` or `x-txn-id`, it is allowed in `fields`
under one of those names or as a whole `terms` value. Anywhere else, or before
any result has shown it, the tool refuses it with the reason. So search by the
run's ids first and read the correlation ids from the hits.

To follow one request across services, pull the whole request with no
`service`, in a narrow window around the hit (about 20 minutes), then read the
lines in time order (`order: "oldest"`). On SSFB use
`fields: { x_txn_id: "<id>" }`. On ATSPL and RTL a UUID goes in terms, so use
`terms: ["<id>"]` (the ATSPL field is `x-txn-id`, and RTL has no correlation
field). The ids are reused, so count requests, not lines:

- Grouping by the request id (`x_req_id` on SSFB, `x-req-id` on ATSPL)
  collapses a cascade of errors to the requests behind it.
- The same transaction id on several attempts is one retried request.
- Name the correlation ids you used in the evidence.

## One failure is not one line

A single failure often logs several lines, such as a raw response dump and a
summary error. When you report a number, say whether it counts raw lines or
distinct occurrences.

## Logs carry no run id

Our queries are not tagged in the logs, and log lines do not carry the run id.
Tie log lines to rows and API state by timestamp, by the run's ids and by
correlation ids.

## Traps

- The tokenizer splits words on `_` and `.`: `failed_check_reason` matches
  `failed`, and a dotted label breaks `contains`.
- Some paths log nothing, such as a rejection before the handler logs. Then
  the evidence is a missing label: the label that should follow never
  appears. Say which label you expected and where the code writes it.
- CX and admin lookups show up as the customer's own hits. Split them with
  `columns: ["User-Agent"]`: ReactorNetty, go-resty or Java is an admin or
  service caller; okhttp or CFNetwork is the app. Leave out lines made by this
  investigation's own admin calls.
- `unreachable` is not zero. A search that could not run says nothing about
  the logs.

## Zero hits is not an answer

A zero-hit result means the query is probably wrong. Before you report that
something was not logged, run this ladder and stop at the first step that
returns hits:

1. Your first guess, scoped to a field (`message` or `error`).
2. The same words as bare `terms`. This searches the whole document and is the
   step that usually finds it. Then read one full hit and write the precise
   query.
3. Drop `service`. The first guess of service is often wrong.
4. Run `group_by: ["service"]` for the same terms, to see which services log
   them.
5. Move `from` earlier. The window may be too narrow.
6. Drop `level`. The text may be logged at `info` or `warn`.

Steps 3 to 6 are the order the tool's 0-hit note gives. A `service_absent`
note means the service has no lines at all in that window, so the name is
wrong: drop it. For a full id inside a response body, try `contains` with the
id. To prove a zero is real, `count` the id alone with no other filter. For an
empty lookup by the known id, the investigator note ("Empty means ask why")
says what comes after this ladder.

If the ladder still returns zero, report the absence as a finding and list the
queries you ran.

## Query templates

Ids are placeholders; take them from the brief or an earlier hit.

1. First look at a service: `service`, `level: "error"`, a 2-hour window
   after the event, `group_by: ["message", "error"]`.
2. Where an id shows up: `terms: ["<id>"]`, no service, one day either side,
   `group_by: ["service", "level", "message"]`.
3. One customer's timeline: `service` plus the id (in `terms`, or an exact id
   field on SSFB), `order: "oldest"`.
4. Did the step finish: `service`, `message: "<label>"` and the id; run it
   again with the success label and compare.
5. A quoted error: `service` and `error: "<w1> <w2>"` over the run's window
   with `count`, then `count_distinct` on a customer field.
6. A vendor response body: the account or id and a topic word as `terms`,
   `message` set to the response label, `raw: true`, a 10-minute window.
7. Walk a request: the correlation id as above, about 20 minutes,
   `raw: true`, `order: "oldest"`, back to the line that carries the id.
8. Blast radius: `service`, `message: "<label>"`, `scope: "systemic"`, `count`
   over the window, then per day, and `count_distinct` on a customer field.
9. App or admin: the id and the request path as `terms`, with
   `columns: ["status", "latency", "User-Agent"]`.
10. A vendor callback: compare the gateway's count for the callback path
    with the service's count for its own label.
