# RTL logs

Notes for `logs_search` on RTL. The general rules are in the logs note above.
This note is a stub (unverified: no RTL log source was documented before this
port, and no RTL log line has been sampled yet).

## What is known

- RTL has its own Quickwit, like the other entities. It may not be set up in
  this deployment yet. If `logs_search` answers `not_configured`, add the gap
  `rtl logs not configured`, say so in the reply, and work from the DB and API
  rungs.
- The tool accepts only `service`, `level`, `message`, `error`, `raw_message`
  and `timestamp` as fields. No correlation id field is configured for RTL, so
  search the run's ids as `terms`.

## Services

| Registry name | Logs as |
|---|---|
| `workflow` | `workflow-op` |
| `banking` | `banking-service` |
| `kyc` | `kyc-service` |

The log names come from the registry (unverified: not checked against sampled
lines).

## What to assume until it is confirmed

- `workflow-op` is the same Java service as on SSFB, so its text is probably in
  `message` with no `error` field (unverified: RTL lines not sampled).
- The Go services probably follow the same label and error split as the other
  entities (unverified: RTL lines not sampled).

## First queries

Start with bare `terms` for one of the run's ids, with `service` set and a
small `max_hits`. Read one full hit and note the field names you see. Put the
field names, and the service strings that returned hits, in the findings, so
this note can be filled in.
