---
name: atspl-engage
description: ATSPL engage service (callback requests, survey responses and the user waitlist). Use when an ATSPL user asked for a callback, submitted a survey or joined a waitlist and the record is missing or wrong. A stub, with the log name unverified.
metadata:
  kind: service
  entity: atspl
  service: engage
  sources: engage repo migrations and package layout, infrastructure-v2 database lists
  status: stub
---

# engage (ATSPL)

engage stores callback requests, survey responses and waitlist sign-ups. It
has a Kafka consumer, so some of its writes come from events rather than
direct calls (unverified: taken from its migrations and package names only).

- Registry service: `engage`, repo `engage` (Go).
- Database: `sql_select` with `service: "engage"`.
- Logs: `logs_search` with `service: "engage"`. The log service name is
  `engage-service` (unverified: taken from the deployment name). If a search returns nothing at all
  for a busy window, suspect the name before you conclude nothing happened.
- No admin API is known.

engage runs for ATSPL only.

## Tables

From the repo's migrations (unverified: the deployed schema may differ):

| Table | Purpose |
|---|---|
| `callback_requests` | Callback requests from users. |
| `survey_responses` | Survey answers. |
| `user_waitlist` | Waitlist sign-ups. |

Check which tables exist before you query:

```
sql_select {
  service: "engage",
  sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
}
```

Then list the columns of the tables you need, all in one call:

```
sql_select {
  service: "engage",
  sql: "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ($1, $2) ORDER BY table_name, ordinal_position",
  params: ["<table_a>", "<table_b>"]
}
```

## Common checks

- **Record missing.** If the user's action is not in its table, search the
  logs for consumer errors in the window: the event may not have been
  consumed.

## Deploy

The app folder is `engage/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.