---
name: ssfb-workflow
description: The Shivalik copy of workflow-op, the step orchestration and UI template service behind onboarding screens. Use when a Shivalik form is stuck on a step, a screen shows 'We hit a snag', or the app shows the wrong landing screen or content.
metadata:
  kind: service
  entity: ssfb
  service: workflow
  sources: rtl/workflow/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# workflow-op (SSFB copy)

This note is about the Shivalik copy of workflow-op. A second copy runs for
RTL, with its own database; it is the registry service `rtl:workflow` and its
note is `rtl-workflow`. A form or execution that is missing here may exist on
`rtl:workflow`. The SSFB investigator cannot query the RTL copy, so report the
missing row as a gap and say it may be on `rtl:workflow`, rather than
concluding the form does not exist.

workflow-op runs workflow steps and serves the UI templates for onboarding
and banking flows. harbor calls it to fetch form submission state and step
progress.

- Registry service: `workflow`, repo `workflow-op`.
- Database: `sql_select` with `service: "workflow"`.
- Logs: `logs_search` with `service: "workflow"` (the log service name is
  `workflow-op`). It is a Java service: the whole line is in `message` and
  there is no `error` field. The old notes also mention `workflow-v2` as a
  possible log name (unverified: never confirmed).
- No admin API is known.

## Tables

| Table | Purpose |
|---|---|
| `workflow_definitions` | Step definitions per workflow type. `steps` is a JSON array; `external_id` names the definition. |
| `workflow_executions` | One row per user or session. `reference_id` is the harbor `form_id` and `reference_type` is `FORM`. Read `status`, `current_step_identifier` and `current_step_index`. |
| `ui_templates` | Velocity (`.vm`) templates for each step. |

There is no `workflow_instances` table.

## Common checks

Where a harbor form is in its workflow:

```
sql_select {
  service: "workflow",
  sql: "SELECT status, current_step_identifier, current_step_index FROM workflow_executions WHERE reference_id = $1 AND reference_type = 'FORM'",
  params: ["<form_id>"]
}
```

Compare it with the step list of the definition:

```
sql_select {
  service: "workflow",
  sql: "SELECT jsonb_array_elements(steps)->>'identifier' AS step FROM workflow_definitions WHERE external_id = $1",
  params: ["<definition_id>"]
}
```

No row for the form: see the first section. The execution may be on
`rtl:workflow`.

## Templates

The database is the only source of truth for template content. Several live
templates exist only in `ui_templates` (created through the template API) and
not in the repo's `templates/` directory, for example
`NRI_ONBOARDING_LANDING_TABBED_COMPLIANCE`,
`NRI_ONBOARDING_LANDING_TABBED_VALUE_PROP` and `V1_STATUS_BASE`. Repo copies
can also be out of date. Never answer "what does the app get" from the repo;
read the row:

```
sql_select {
  service: "workflow",
  sql: "SELECT template_content FROM ui_templates WHERE template_identifier = $1 AND template_status = 'ACTIVE' AND deleted = false",
  params: ["<template_identifier>"]
}
```

### NRI landing screen

The NRI landing screen is `V1_STATUS_BASE`. It picks the hero and body by
cohort and by an app-version gate
(`$appVersion.isMin("<android_build>", "<ios_version>")`) and `#parse`s a
variant template.

The cohort names it tests must also be listed in
`workflow_definitions.definition_settings`, under `cached_resolvers` (the
entry with key `cohort_data`), in `filter_values`, for the definition the user
is on. The resolver only fetches names on that list, so a name missing there
silently turns the branch off. Check each definition on its own:
`NRI_ONBOARDING_V3`, `NRI_ONBOARDING_V4` and `NRI_ONBOARDING_UAE` differ.

```
sql_select {
  service: "workflow",
  sql: "SELECT external_id, definition_settings FROM workflow_definitions WHERE external_id = $1",
  params: ["<definition_id>"]
}
```

Cohort membership itself is in the cohort service (see `ssfb-cohort`).

Images in templates are served from S3 behind CloudFront. A missing object
answers 403 `AccessDenied`, not 404, so treat a 403 on an image as "file not
uploaded". No tool fetches these images; this only helps you read a log or a
user report.

## Known issues

- **"We hit a snag" on a step whose screen fails to render.** Suspect the UI
  template, not the step handler. Search for the Jackson error:

  ```
  logs_search {
    service: "workflow",
    fields: { raw_message: "JsonTemplateHandler" },
    terms: ["Illegal", "unquoted"]
  }
  ```

  `Illegal unquoted character ((CTRL-CHAR, code 9|10))` means a raw TAB or
  newline in user data (usually document OCR) was put bare into a JSON string
  literal by a `.vm` template, such as `"value": "$!{data.full_address}"`.
  Jackson rejects the render, the service throws
  `AppException: something went wrong` and the app shows "We hit a snag". It
  is deterministic: retrying never helps. `VelocityTemplateResolver.doRender`
  does no JSON escaping.

  The error line carries no `form_id`, so it cannot be tied to a user from
  logs alone. For the ticket's user, check whether their execution is stuck on
  that step with the query above. Counting other affected users is a systemic
  question and takes aggregate queries only.

  For `suggested_fix`: fix the data, or strip C0 control characters in
  `render()` before they reach the VelocityContext. Do not suggest a blanket
  escape on every reference insertion; it would break the `$json`, `$sdui` and
  `$jsonInclude` helpers, which emit raw JSON on purpose.
- **Landing screen branch never shows.** The cohort name is missing from the
  definition's `cohort_data` `filter_values`. See the NRI landing section.

## Deploy

The app folder is `workflow-op/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.