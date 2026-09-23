# SSFB logs

Notes for `logs_search` on SSFB. The general rules are in the logs note above.

## Services

Pass the registry name as `service`; the tool maps it to the name in the logs.

| Registry name | Logs as | Language | Text is in |
|---|---|---|---|
| `harbor` | `harbor` | Go | label in `message`, text in `error` |
| `rhythm` | `rhythm` | Go | label in `message`, text in `error` |
| `guardian` | `guardian` | Go | label in `message`, text in `error` |
| `comms` | `comms` | Go | label in `message`, text in `error` |
| `workflow` | `workflow-op` | Java | everything in `message`, no `error` field |

The registry also lists `cohort`, `pdfgen`, `reminder`, `bro`, `eventbus` and
`audit`, which log under their own names (unverified: their field layout was
not sampled). `finacle` has no logs here; use the CBS rung for it.

## Document schema

Every line has `service`, `level`, `message`, `raw_message` and `timestamp`,
plus Kubernetes fields such as `kubernetes.container_name`, `pod_name` and
`namespace_name`.

The Go services share one logger, and each key the developer passed becomes its
own field. Most error lines from the Go services carry an `error` field. Common
fields on those services are `error`, `x_req_id`, `x_txn_id` and
`x_amzn_trace_id`, often with `x-customer-id` or `x-device-id`. Fields seen per
service:

- `harbor`: `form_id`, `provider_order_id`, `document_type`.
- `rhythm`: `request_uuid`, `x-customer-id`, `path`, `status`, `latency`.
- `guardian`: `reference_id`, `x-device-id`.
- `comms`: `channel`, `communication_id`, `x_requester_id`.

## Fields you can filter and group by

The tool accepts these in `fields` and `group_by`: `x_req_id`, `x_txn_id`,
`form_id` and `x-customer-id`. Other fields show in hits but are not
filterable; search their values as `terms`.

- A harbor form id is best matched with `fields: { form_id: <form_id> }` and
  the full value.
- A customer id on rhythm is best matched with
  `fields: { "x-customer-id": <customer_id> }`.
- The correlation ids here use underscores: `x_req_id`, `x_txn_id`.

## Traps seen on SSFB

- A user-quoted error searched as `message` on harbor returned zero, while the
  same words on `error` returned hundreds of lines.
- A phrase that matches on `message` says nothing about whether it would match
  on `error`; `error` takes words, not phrases.
- `workflow-op` has thousands of error lines and none with an `error` field.
