---
name: atspl-canopy
description: ATSPL canopy service (support touchpoints, support chat, in-app FAQs and consent). Use when a ATSPL issue involves the support chat, an FAQ page or a consent decision. A stub, with the tables and log name unverified.
metadata:
  kind: service
  entity: atspl
  service: canopy
  sources: canopy repo description and module layout, infrastructure-v2 database lists
  status: stub
---

# canopy (ATSPL)

canopy owns support touchpoints and the user support experience: support chat
context, the FAQ topics, categories and questions shown in the app, consent
decisions, and cross-sell (unverified: taken from the repo description and its
module names only).

- Registry service: `canopy`, repo `canopy` (Java).
- Database: `sql_select` with `service: "canopy"`.
- Logs: `logs_search` with `service: "canopy"`. The log service name is
  `canopy-service` (unverified: taken from the deployment name). If a search returns nothing at all
  for a busy window, suspect the name before you conclude nothing happened.
- No admin API is known.

The same codebase also runs for RTL as `rtl:canopy`, with its own database.
This note covers the ATSPL copy only.

## Tables

Table names are not known yet (unverified: the repo has no SQL migrations and its
models carry no table names). List them first.

Check which tables exist before you query:

```
sql_select {
  service: "canopy",
  sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
}
```

Then list the columns of the one you pick:

```
sql_select {
  service: "canopy",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["<table_name>"]
}
```

## Deploy

The app folder is `canopy/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.