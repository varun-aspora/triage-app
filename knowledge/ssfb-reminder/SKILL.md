---
name: ssfb-reminder
description: SSFB reminder-service, scheduled reminders and jobs run by an API and a worker. Use when a Shivalik user never got a reminder, got duplicates, or a scheduled job did not run.
metadata:
  kind: service
  entity: ssfb
  service: reminder
  sources: shivalik/reminder-service/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# reminder-service (SSFB)

reminder-service schedules and runs reminder jobs. It runs as two
deployments: the API (`reminder`) and the executor (`reminder-worker`). A
reminder that was created but never fired is usually a worker problem, not an
API problem.

- Registry service: `reminder`, repo `reminder-service`.
- Database: `sql_select` with `service: "reminder"`.
- Logs: `logs_search` with `service: "reminder"` finds the API
  (`reminder-service`). The worker logs under another name that is not
  confirmed (unverified: the old notes do not give it). If the API logs look
  clean, say that the worker logs were not searched.
- No admin API is known.

The same service also runs for RTL on a different cluster with different
data. This note covers the Shivalik copy only.

## Tables

| Table | Purpose |
|---|---|
| `workflow` | Reminder workflow definitions. |
| `job` | Scheduled job per subject. Has an `idempotency_key`. |
| `job_execution` | One record per attempt, including `external_identifier`. Start here. |

The join columns between `job` and `job_execution` are not written down. List
the columns before you join:

```
sql_select {
  service: "reminder",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["job_execution"]
}
```

## Common checks

- **User never got the reminder.** Find the `job` row, then check whether any
  `job_execution` rows exist for it. None means the worker never picked the
  job up. Rows with failures mean the problem is downstream, usually in comms
  (see the `ssfb-comms` note).
- **Duplicate reminders.** Check `idempotency_key` on `job`.

## Known issues

- **Job with no executions.** A `job` row with no `job_execution` rows means
  the worker did not pick it up. This is a worker problem; the API side is
  fine.
- **Executions that failed.** The send failed after the worker ran; continue
  in comms.

## Deploy

The app folder is `reminder/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. It covers both the API and
the worker. Check it when the question is what runs and with which settings,
and cite the file.