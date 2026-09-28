# Logs

`logs_search` queries the entity's log index. Quickwit covers every entity:
SSFB, ATSPL and RTL each have their own. Whether it is set up in this
deployment shows in the answer; `not_configured` is a gap, not a reason to
stop the investigation. The note for your entity follows this one.

## Inputs

Every query needs one selective part: `terms`, `fields`, `message`, `error`,
`contains`, or an `any_of` group of messages or terms. `service`, `level` and
`exclude` narrow a query but are refused on their own.

- `service`: the registry service name used in the brief. The tool maps it to
  the name the service logs under. Leave it out to search every service.
- `terms`: values that must all appear anywhere in the line. A value with a
  space, a dash or other punctuation (a UUID, a label) is sent whole in single
  quotes. A single quote inside a value is refused.
- `message`: the exact label from the code, sent whole in single quotes.
- `error`: words matched on the `error` field. The tool ANDs each word, because
  that field has no positions and a phrase query on it fails.
- `fields`: exact filters on named fields, hyphenated names included. The
  entity note lists the names. A numeric range is written `[400 TO 599]`.
- `any_of`: OR groups, such as levels `error` or `warn`, several labels,
  several id tokens or several services. Each group matches when any of its
  values does; every group must match.
- `exclude`: values that must not appear. Each one is excluded on its own.
- `contains`: one word with no spaces, matched as a substring of the full raw
  line. A wildcard over several words returns 0 hits with no error.
- `level`: one word such as `error`, `warn` or `info`.
- `denoise`: on SSFB, drops kong, kafka and access-log lines unless they are
  errors. `with_message` keeps the lines of `message` even from those services.
  Other entities refuse it.
- `from` and `to`: an ISO time in UTC or a duration such as `6h` or `30d`.
- `order`, `offset`, `max_hits`: one page of hits, newest first unless `order`
  is `oldest`. Pass `offset` for the next page; the tool never fetches it
  itself.
- `columns`: extra fields to show in each hit. `raw`: whole documents.
- `count`, `group_by` (up to four fields) or `count_distinct` (one field):
  counts instead of hits. `normalize` folds messages that differ only by
  UUIDs, long hex strings and long numbers, so a group-by over messages groups
  the same failure together.

## The window is set by the tool

Every query runs in a bounded time window. With no `from` or `to` it is the
request window from the brief, which by default starts 30 days before the
thread's first message and ends now. You can narrow it or move `from` earlier;
you cannot run an unbounded query. The result reports the window it searched:
state that window.

A run gets at most 50 `logs_search` calls, counted inside its tool-call limit.
Past that the tool refuses log searches and says so; other tools still work.

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
- When unsure which field holds the text, search it as bare `terms`, then read
  one full hit and its field names before writing the precise query. Do not
  guess field names twice.

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
`service`, in a narrow window around the hit, then read the lines in time
order (`order: "oldest"`). On SSFB use `fields: { x_txn_id: "<id>" }`. On
ATSPL and RTL a UUID goes in terms, so use `terms: ["<id>"]` (the ATSPL field
is `x-txn-id`, and RTL has no correlation field). The ids are reused, so count
requests, not lines.

## One failure is not one line

A single failure often logs several lines, such as a raw response dump and a
summary error. When you report a number, say whether it counts raw lines or
distinct occurrences.

## Logs carry no run id

Our queries are not tagged in the logs, and log lines do not carry the run id.
Tie log lines to rows and API state by timestamp, by the run's ids and by
correlation ids.

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
5. Move `from` earlier. The window may be too narrow; logs are kept for
   about 30 days.
6. Drop `level`. The text may be logged at `info` or `warn`.

Steps 3 to 6 are the order the tool's 0-hit note gives. For an empty lookup
by the known id, the investigator note ("Empty means ask why") says what comes
after this ladder.

If the ladder still returns zero, report the absence as a finding and list the
queries you ran.
