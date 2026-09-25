---
name: ssfb-cohort
description: SSFB cohort-service, which holds cohort definitions and user membership. Use when a Shivalik user's cohort or experiment group decides what they see. This is a stub and its tables and endpoints are unverified.
metadata:
  kind: service
  entity: ssfb
  service: cohort
  sources: rtl/workflow/AGENTS.md
  status: stub
---

# cohort-service (SSFB)

This note is a stub. No service note exists for cohort in the old workspace,
so everything below is unverified until someone checks the database and the
repo.

cohort is an ordinary SSFB service (D17) with a database, a GET API and a repo
(`cohort-service`). Any investigation may read it. There is no separate batch
or cohort-status mode; a question about a whole cohort is a systemic question
like any other.

- Registry service: `cohort`.
- Database: `sql_select` with `service: "cohort"`.
- Admin API: `http_call` with `service: "cohort"`. The base URL is not known
  yet, so the tool may answer "not configured"; record that as a gap. No
  endpoints are known (unverified: none are documented).
- Logs: `logs_search` with `service: "cohort"` (the log service name is
  `cohort-service`).

## Tables

The workflow notes say cohort membership lives in `cohort_definitions` joined
with `cohort_participations` (unverified: named only in the workflow-op notes;
columns unknown). List the tables and columns before you query:

```
sql_select {
  service: "cohort",
  sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
}
```

```
sql_select {
  service: "cohort",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["<table_name>"]
}
```

## How cohorts are used

workflow-op's NRI landing template picks what to show by cohort name (see
`ssfb-workflow`). The same notes say a parent and child cohort scheme is used,
so being in the experiment is not the same as getting the screen; check the
user's membership in both (unverified: the scheme is not documented here).

## Deploy

The app folder is `cohort/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.