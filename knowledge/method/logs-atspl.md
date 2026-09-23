# ATSPL logs

Notes for `logs_search` on ATSPL. The general rules are in the logs note above.
ATSPL logs are a separate cluster from SSFB. SSFB services (harbor, rhythm,
guardian, workflow-op) are not in them.

## Services: use the exact strings

`service` is matched as an exact term, so a wrong name returns a clean zero
rather than an error. On ATSPL a zero usually means the wrong service name, not
missing logs.

| Registry name | Logs as | What it is |
|---|---|---|
| `package` | `package` | the package API |
| `pulse` | `pulse-backend` | the ops and CX console backend; `pulse` alone returns zero |

The package service has two workers that log under their own names:
`package-worker-sync` (the delivery sync worker) and `package-worker-queue`
(the queue consumer). A delivery that was accepted by the API and then failed
is usually in the worker lines. The registry does not list the workers as
services, so if the tool refuses them, record the gap and say the worker logs
were not searched (unverified: whether the registry will add them).

Other services in these logs are not registry services here: `canopy`,
`comms`, `comms-consumer`, `comms-ui` (a different comms from SSFB's),
`engage`, `horus`, the gateways `kong`, `kong-internal` and `kong-vendor`, and
`kafka-connect`. The gateways dominate any query without a service filter.

A line with service `harbor` in these logs is an unrelated container, not SSFB
harbor.

## Document schema

Only `timestamp` and `message` are declared in the mapping; every other field
is dynamic but still searchable. The convention matches SSFB: `message` is the
developer's label and `error` is the text a user would quote. Search both.

Fields seen on package lines: `service`, `level`, `message`, `error`,
`raw_message`, `timestamp`, `time`, `status`, `method`, `path`, `latency`,
`client-ip`, `user-agent`, `x-req-id`, `x-txn-id`, and Kubernetes fields such
as `kubernetes.container_name` and `kubernetes.pod_name`. When a field is not
promoted to the top level, read it from `raw_message` in the hit.

## Fields you can filter and group by

The tool accepts `x-req-id` and `x-txn-id` in `fields` and `group_by`. Note the
hyphens: on ATSPL the correlation ids are `x-req-id` and `x-txn-id`, not the
underscore forms. Pass them as `fields: { "x-req-id": <req_id> }`; the tool
writes the query.

## Traps seen on ATSPL

- Error volume on `package` is low: a handful of error lines a week, and none
  on a typical day. Move `from` back to `30d` before treating an empty error
  search as meaningful.
- Logs are kept only from about February 2026. An older issue has no logs;
  record that as a gap.
- `level` values are lowercase; the tool lowercases what you pass.
