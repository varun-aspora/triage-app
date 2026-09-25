---
name: rtl-cohort
description: RTL cohort service (cohort definitions, user participations and composite cohorts used to pick surfaces). Use when an RTL user was or was not in a cohort, or saw the wrong surface or offer. A stub, with the log name unverified.
metadata:
  kind: service
  entity: rtl
  service: cohort
  sources: cohort-service repo migrations, ssfb-cohort, infrastructure-v2 database lists
  status: stub
---

# cohort (RTL)

cohort segments users: it holds cohort definitions and rules, records which
users participate in which cohort, and ranks surfaces for composite cohorts.
The same repo also deploys `cohort-evaluator-service` on this cluster, which
evaluates the rules (unverified: taken from the repo's build targets and
migrations only).

- Registry service: `cohort`, repo `cohort-service` (Go).
- Database: `sql_select` with `service: "cohort"`.
- Logs: `logs_search` with `service: "cohort"`. The log service name is
  `cohort-service` (unverified: taken from the deployment name; the evaluator
  logs under its own name). If a search returns nothing at all for a busy
  window, suspect the name before you conclude nothing happened.
- No admin API is known.

The same codebase also runs for SSFB as `ssfb:cohort`, with its own database.
This note covers the RTL copy only.

## Tables

From the repo's migrations (unverified: the deployed schema may differ):

| Table | Purpose |
|---|---|
| `cohort_definitions` | Cohorts and their rules. |
| `cohort_participations` | Which user is in which cohort. |
| `composite_cohort_definitions`, `composite_cohort_categories` | Cohorts built from other cohorts. |
| `composite_cohort_surfaces`, `composite_cohort_surface_priorities` | Surfaces per composite cohort and their order. |
| `bulk_operations` | Bulk adds and removals. |

Check which tables exist before you query:

```
sql_select {
  service: "cohort",
  sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
}
```

Then list the columns of the one you pick:

```
sql_select {
  service: "cohort",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["<table_name>"]
}
```
