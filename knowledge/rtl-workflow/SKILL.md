---
name: rtl-workflow
description: The RTL copy of workflow-op, the onboarding engine - workflow_executions and the other tables, how steps advance, the peer check for a stuck step, SDUI template rules and known failures. Use when a user is stuck on or looping at an onboarding step, a step screen fails to render, or a go-back or revert is stuck. The SSFB copy is ssfb-workflow.
metadata:
  kind: service
  entity: rtl
  service: workflow
  sources: rtl/workflow/AGENTS.md, rtl/NRI_ONBOARDING.md, rtl/AGENTS.md, rtl/scripts/workflow_step_check.sh
  status: ported
---

# workflow (RTL copy of workflow-op)

Repo `workflow-op`. The onboarding engine and its SDUI templates. The mobile
app talks only to workflow-op for step flow. On each call it reads the active
`workflow_definitions` row for the user's `workflow_identifier` (for example
`NRI_ONBOARDING_V4`), asks each step's handler whether the step is satisfied,
auto-advances past satisfied steps, and returns the rendered screen.

This note is the RTL copy (`rtl:workflow`). workflow-op also runs on SSFB as
`ssfb:workflow`, with its own database. The same form can sit in either copy.
If this copy has no row for a form, say so in the findings so the SSFB copy
gets checked; do not conclude the form has no execution.

## How a step completes

Synchronously. On `GET status` workflow-op calls the step handler's status
check; if the downstream service reports the step satisfied, it advances and
checks the next one. There is no Kafka consumer in the control flow; its
event bus use is analytics only (`persona_completed`, `onboarding_started`).
So a stuck step means the handler keeps answering "not satisfied" or fails,
not that an event was lost.

Variant selection: UAE users get `NRI_ONBOARDING_UAE`; otherwise the user
stays on the variant of their existing execution; otherwise the app version
picks V4, then V3, then the legacy definition.

Mobile-facing API, base `/api/v1/workflow/user`: `GET /status`,
`POST /submit?type=<step_identifier>`, `POST /poll` (read-only completion
check after a KYC SDK closes; does not advance) and `POST /go-back`.

## Tables

| Table | What to look for |
|---|---|
| `workflow_executions` | First stop. One row per user run: `reference_id` and `reference_type`, `workflow_identifier`, `status` (RUNNING, COMPLETED, FAILED, MANUAL_REVIEW, REVERTING), `sub_status`, `current_step_identifier` and `current_step_index` (where the user is), and `step_data` (JSONB, per-step results). For a harbor form, `reference_id` = `form_id` and `reference_type` = `FORM`. |
| `workflow_definitions` | The ordered `steps` JSONB for a `workflow_identifier`; one active row per identifier. Also `definition_settings`. |
| `ui_templates` | The Velocity or JSON template rendered for each step. |
| `workflow_execution_actions` | Saga and audit rows for force-step-back and go-back. Check when a revert is stuck (STARTED, COMPENSATED, then DONE or STUCK). |

There is no `workflow_instances` table.

`workflow_executions` is looked up by `reference_id`, which for a harbor form
is the `form_id`. No user id column is documented for it, so do not filter on
a guessed `user_id`: get the `form_id` first (the chain's `account_form_id`,
or from harbor). To
see the real columns, read `information_schema.columns` for the table:

```
sql_select { service: 'workflow', sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position", params: ['workflow_executions'] }
```

## Queries

Where the form is:

```
sql_select { service: 'workflow', sql: "SELECT workflow_identifier, status, sub_status, current_step_identifier, current_step_index, step_data FROM workflow_executions WHERE reference_id = $1 AND reference_type = 'FORM'", params: ['<form_id>'] }
```

The step list for that definition. Set-returning functions are refused, so
fetch the `steps` JSONB whole and read the identifiers from the staged rows in
the sandbox:

```
sql_select { service: 'workflow', sql: "SELECT external_id, steps FROM workflow_definitions WHERE external_id = $1", params: ['<definition_id>'] }
```

The source filters definitions by `external_id`. It does not say which
execution column holds that id, or whether `workflow_definitions` also has a
`workflow_identifier` column (unverified). If you only have the execution's
`workflow_identifier`, read one `workflow_definitions` row first to find the
matching column.

Is it this form, or everyone at this step? An aggregate over the same step:

```
sql_select { service: 'workflow', sql: "SELECT status, COUNT(*) FROM workflow_executions WHERE workflow_identifier = $1 AND current_step_identifier = $2 GROUP BY status", params: ['<workflow_identifier>', '<step_identifier>'] }
```

A stuck revert:

```
sql_select { service: 'workflow', sql: "SELECT * FROM workflow_execution_actions WHERE workflow_execution_id = $1", params: ['<execution_id>'] }
```

The column that links actions to an execution is not documented (unverified:
the source names the table only); read one row first if the query above is
refused or returns nothing.

## SDUI templates

- The database is the only source of truth for template content. Several
  live templates exist only in `ui_templates` (created through the template
  API), not in the repo's `templates/` directory, and repo copies can be
  stale. Never answer "what does the app get" from the repo:

  ```
  sql_select { service: 'workflow', sql: "SELECT template_content FROM ui_templates WHERE template_identifier = $1 AND template_status = 'ACTIVE' AND deleted = false", params: ['<template_identifier>'] }
  ```

- The NRI landing screen is `V1_STATUS_BASE`. It picks its hero and body by
  cohort and an app-version gate, and includes a variant template. The cohort
  names it tests must also be listed in the user's definition under
  `definition_settings`, in the `cached_resolvers` entry with key
  `cohort_data`, as `filter_values`. The resolver fetches only the names on
  that list, so a name missing there silently disables the branch. Check it
  per definition: V3, V4 and UAE differ.
- Cohort membership itself is SSFB data (`ssfb:cohort`,
  `cohort_definitions` and `cohort_participations`). A parent and child cohort
  scheme means "in the experiment" is not the same as "gets the screen"; ask
  for the per-user overlap to be checked there.
- Image assets are served from a CDN in front of object storage. A missing
  file there answers 403, not 404. Asset checks are not a tool action; if a
  broken image is suspected, list the asset paths from the template in the
  findings and leave the check to a person.

## Logs

The registry maps `workflow` to the log service `workflow-op`. It may log as
`workflow-v2` instead (unverified: the source says to confirm when
investigating). If `workflow-op` returns nothing for a window where the form
clearly moved, record that as a gap.

## Known issues

- **Step reached but the screen fails ("We hit a snag").** Suspect the UI
  template, not the step handler. Look for `JsonTemplateHandler` errors:

  ```
  logs_search { service: 'workflow', fields: { raw_message: 'JsonTemplateHandler' }, terms: ['Illegal', 'unquoted'] }
  ```

  `Illegal unquoted character ((CTRL-CHAR, code 9|10))` means a raw tab or
  newline in user data (usually document OCR, such as a full address) was
  placed bare inside a JSON string by a `.vm` template. Jackson rejects the
  render, the service throws `AppException: something went wrong`, and the
  app shows the snag screen. It is deterministic: retrying never helps. The
  template renderer does no JSON escaping. The fix is to clean the data, or to
  strip control characters in the renderer before they reach the template
  context; a blanket escape on every reference would break the helpers that
  emit raw JSON on purpose. The error log carries no `form_id`, so find
  affected users through `workflow_executions` rows stuck on that step.
- **Landing variant not shown to a user who is in the cohort.** The cohort
  name is missing from `filter_values` in the user's definition (see SDUI
  templates above).
- **Revert or go-back stuck.** Read `workflow_execution_actions` for the
  execution; a row left in STARTED or STUCK is the blocker.
