# RTL logs

Notes for `logs_search` on RTL. The general rules are in the logs note above.

## What is known

- RTL logs are the London cluster's app logs, a different index from SSFB.
  The tool picks the cluster and index from config. If `logs_search` answers
  `not_configured`, add the gap `rtl logs not configured`, say so in the
  reply, and work from the DB and code.
- RTL log service names end in `-service`. A name without the suffix returns
  0 hits.
- The tool accepts only `service`, `level`, `message`, `error`, `raw_message`
  and `timestamp` as fields. No correlation id field is configured for RTL, so
  search the run's ids as `terms`. Other fields, such as `x-device-id`, show
  in hits: ask for them with `columns` or `raw: true`.

## Services

| Registry name | Logs as |
|---|---|
| `workflow` | `workflow-op-service` |
| `banking` | `banking-service` |
| `kyc` | `kyc-service` |
| `canopy` | `canopy-service` |
| `cohort` | `cohort-service` |
| `comms` | `comms-service` |
| `appserver` | `app-server-service` |
| `verification` | `verification-service` |
| `uservault` | `user-vault-service` |

`appserver`, `verification` and `uservault` have logs only: no DB or API.
`app-server-service` lines carry the device id and app headers of each app
request. The banking, kyc, canopy, cohort and comms names follow the suffix
but have not returned a hit yet (unverified: `banking-service` and
`banking-service-service` both returned 0 hits on 2026-09-25).

## Personal data

- `workflow-op-service` logs full outbound request and response bodies,
  including the user-vault user details and admin tokens. Never quote personal
  data or tokens from them; cite the field name and the line's timestamp
  instead.
- `user-vault-service` lines carry phone, name and date of birth. Never quote
  them.

## What to assume until it is confirmed

- `workflow-op-service` is the same Java service as on SSFB, so its text is
  probably in `message` with no `error` field (unverified: RTL lines not
  sampled).
- The Go services probably follow the same label and error split as the other
  entities (unverified: RTL lines not sampled).

## First queries

Start free-form, as the logs note says, with the run's `aspora_user_id`. Put
the service strings and field names you see in the findings, so this note can
be filled in. To get the device id, run the same search with
`service: "appserver"`, `columns: ["x-device-id"]` and a one-day window
around the last app activity or the ticket time; on an over-limit answer,
narrow the window.
