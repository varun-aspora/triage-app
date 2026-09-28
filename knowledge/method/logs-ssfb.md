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
`audit` (unverified: their field layout was not sampled). `finacle` has no
logs here; read it through CBS.

Services seen in the index over 30 days: kong, kong-internal, kong-vendor,
kafka-connect, schema-registry, eventbus, audit, harbor, workflow-op, rhythm,
reminder, guardian, comms, cohort and pdf-generator. The gateways and kafka
are not registry services, so `service` refuses them: search without
`service` and read `service` in the hits, or group by it. The registry maps
`cohort`, `reminder` and `audit` to `cohort-service`, `reminder-service` and
`audit-svc` (unverified: the index showed `cohort`, `reminder` and `audit`).

## Noise filter

Use `denoise: "only"` with the ids on the first SSFB query of an
investigation. With a label, use `denoise: "with_message"`, which keeps
that label's lines even from a filtered service. When the error could be in
kong or kafka, run a `count` without `denoise` first.

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
`form_id` and `x-customer-id`. Other fields show in hits (ask for them in
`columns`) but are not filterable; search their values as `terms`.

- A harbor form id is best matched with `fields: { form_id: <form_id> }` and
  the full value.
- A customer id is best matched with
  `fields: { "x-customer-id": <customer_id> }`. On harbor, `x-customer-id`
  holds the form id before the customer exists.
- The correlation ids here use underscores: `x_req_id`, `x_txn_id`.
- A device id searched as a bare term once found 1 line where the
  `x-device-id` field found 785. That field is not filterable here, so treat a
  low bare-term count for a device id as a floor, not the total. Search again
  with `contains: "<device_id>"` (allowed for a device id this run has seen)
  and use the higher count; if both stay low, report the count as a floor.

## Labels seen in past investigations

The labels for harbor, rhythm and guardian are in the Logs sections of
`ssfb-harbor`, `ssfb-rhythm` and `ssfb-guardian`. Search them as `message`,
exactly as written.

- `workflow-op`: the whole line is in `message`.
- kong, kong-internal, kong-vendor: the access line (method and path) is in
  `message`.

## Traps seen on SSFB

- A user-quoted error searched as `message` on harbor returned zero, while the
  same words on `error` returned hundreds of lines.
- A phrase that matches on `message` says nothing about whether it would match
  on `error`; `error` takes words, not phrases.
- `workflow-op` has thousands of error lines and none with an `error` field.
- guardian writes `from`, `to`, `sim_card_number`, `token` and `message_sid`
  as `[REDACTED]`. A phone search on guardian logs proves nothing; search by
  the device id, or read the phone from the guardian DB.
- guardian's rate-limit refusal and the reason for a harbor webhook failure
  log nothing: the missing-label trap in the logs note.
- The log index runs on one small instance. Searches run one at a time; keep
  windows short and prefer `count` and `group_by` to long paged sweeps.
