---
name: ssfb-bro
description: SSFB bro, the business rule orchestrator and STP check engine that harbor calls. Use when an onboarding form is stuck and harbor logs show no error, or when an STP check result or rule config matters.
metadata:
  kind: service
  entity: ssfb
  service: bro
  sources: shivalik/bro/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# bro (SSFB)

bro is the business rule orchestrator: a JSON-driven rule and STP
(straight-through processing) engine that was split out of harbor. harbor is a
registered client, so onboarding forms are evaluated here. A form that is
stuck with no error on the harbor side is often waiting on an STP check result
in bro.

- Registry service: `bro`. Logs: `logs_search` with `service: "bro"`.
- Database: `sql_select` with `service: "bro"`. bro has a database like the
  other SSFB services.
- Admin API: `http_call` with `service: "bro"`. The admin endpoints need a
  bearer token; the tool adds it from the registry. Never put a token in the
  path, query or body.

## Tables

| Table | Purpose |
|---|---|
| `form_stp_checks` | Check outcomes per form. Start here when a form is stuck. |
| `bre_evaluation_runs` | Evaluation run history per subject. |
| `stp_check_config` | Rule definitions per check. |
| `bro_check_config` | Declarative check config (typed rule specs, spec hash). |
| `bro_clients` | Registered calling services; harbor is one. |
| `bro_use_case`, `bro_use_case_check` | Use case to check mapping (soft-deletable). |

Column names beyond the table names are not written down. List them before
you filter:

```
sql_select {
  service: "bro",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["form_stp_checks"]
}
```

## Admin API

Paths are relative to the bro base URL. All are GET.

```
http_call { service: "bro", path: "/health" }
http_call { service: "bro", path: "/admin/api/v1/stp-engine/rules" }
http_call { service: "bro", path: "/admin/api/v1/stp-engine/results/<subject_id>" }
```

`PUT /admin/api/v1/stp-engine/rules/<check_id>` exists and changes a rule.
It is never part of triage, and `http_call` refuses it because only GET and
HEAD are allowed.

## Common checks

- **Form not progressing, harbor logs clean.** Find the form's rows in
  `form_stp_checks` by the form or subject id, then the matching
  `bre_evaluation_runs` row for the failing rule. The results endpoint above
  gives the same view per subject.
- **Rule changed recently.** Config refreshes on a 60 second poll, so a result
  can lag a config change by about a minute.

## Known issues

- **Stuck form with a failed STP check.** A form that harbor has not moved on,
  with no harbor error, usually has a failing or pending row in
  `form_stp_checks`. Report the check id and the rule from
  `bre_evaluation_runs`; do not suggest editing the rule.

## Deploy

The deploy manifests repo `prod-ssfb-aspora-argo` has a `bro/` directory with
the deployed config.
