# Logs

`logs_search` queries the entity's log index. Quickwit covers every entity:
SSFB, ATSPL and RTL each have their own. Whether it is set up in this
deployment shows in the answer; `not_configured` is a gap, not a reason to
stop the investigation. The note for your entity follows this one.

## Inputs

- `service`: the registry service name used in the brief. The tool maps it to
  the name the service logs under. It is required, and it is never enough on
  its own.
- `message`: a phrase matched on the `message` field.
- `error`: words matched on the `error` field. The tool ANDs each word, because
  that field has no positions and a phrase query on it fails.
- `terms`: bare words matched over the whole document.
- `fields`: exact filters on named fields. The entity note lists the names.
- `level`: one word such as `error`, `warn` or `info`.
- `from` and `to`: an ISO time or a duration such as `6h` or `30d`.
- `count` or `group_by`: counts instead of hits. `normalize` folds messages
  that differ only by UUIDs, long hex strings and long numbers, so a group-by
  over messages groups the same failure together.
- `max_hits`: the tool caps it; the result says when it did.

## The window is set by the tool

Every query runs in a bounded time window. With no `from` or `to` it is the
request window from the brief. You can narrow it or move `from` earlier; you
cannot run an unbounded query. The result reports the window it searched, and
sometimes a window note: read it and state the window you actually searched.

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

When a field holds the id (the entity note lists such fields), filter on it
with `fields` and the full value. As a bare term, the tool cuts a dashed UUID
to its first segment, because the default field has no positions. A short
segment can match other ids, so keep `service` and another filter on, and check
the full id in each hit before you count it.

## Correlation ids are reused

`x_req_id` and `x_txn_id` (hyphenated on some entities) are not unique per
request. One transaction id has been seen across well over a hundred lines
about unrelated records. Do not collect every id in a transaction and
attribute them. To tie a line without customer context to the customer, fetch
the lines around it sorted by time and walk back from that exact line to the
nearest earlier line that carries the customer's id.

A correlation id shaped like a UUID or a long number counts as an id for the
scope rule. If the tool refuses one that is not among the run's ids, search by
the run's ids with a narrow window instead and read the correlation ids from
the hits.

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
3. Drop `level`. The text may be logged at `info` or `warn`.
4. Try another service in play. The first guess of service is often wrong.
5. Move `from` earlier, for example to `30d`. The window may be too narrow.

If the ladder still returns zero, report the absence as a finding and list the
queries you ran.
