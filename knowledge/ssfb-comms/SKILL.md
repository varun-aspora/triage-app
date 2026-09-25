---
name: ssfb-comms
description: SSFB comms service (SMS and email delivery to vendors). Use when a Shivalik user did not get an SMS, OTP or email, or got it at the wrong number or address.
metadata:
  kind: service
  entity: ssfb
  service: comms
  sources: shivalik/comms/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# comms (SSFB)

comms delivers SMS and email. It takes send requests from harbor, guardian
and rhythm, dispatches them to vendors and tracks delivery status. The
reminder service also hands its sends to comms.

- Registry service: `comms`, repo `comms-svc`.
- Database: `sql_select` with `service: "comms"`.
- Logs: `logs_search` with `service: "comms"`. The log service name is
  `comms` (unverified: the old notes asked to confirm the exact name). If a
  search returns nothing at all for a busy window, suspect the name before you
  conclude there were no sends.
- No admin API is known.

## Tables

The old notes disagree on the table names, so both sets are listed:

| Table | Purpose |
|---|---|
| `messages` or `notifications` | Delivery records per event: vendor, status, timestamps (unverified: named in the comms notes, while the rhythm notes cross-check a `communications` table instead). |
| `communications` | Delivery records (unverified: named only in the rhythm notes). |
| `templates` | Message templates per event type. |

Check which tables exist before you query:

```
sql_select {
  service: "comms",
  sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
}
```

Then list the columns of the one you pick:

```
sql_select {
  service: "comms",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["<table_name>"]
}
```

## Common checks

- **SMS not received.** Find the delivery rows for the user or phone in the
  delivery table, then read `status` and the vendor response.
- **OTP sent to the wrong number.** Check harbor and guardian logs for phone
  normalisation errors before the send request reached comms.
- **Reminder never arrived.** If the reminder service shows executions that
  failed, the failure is usually downstream here.

## Known issues

- **Wrong or missing number.** A send to the wrong number usually starts
  upstream in phone normalisation in harbor or guardian, not in comms. Look at
  the upstream logs first.

## Deploy

The app folder is `comms/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.