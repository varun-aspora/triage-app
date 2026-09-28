---
name: rtl-nri-onboarding
description: The NRI onboarding journey on RTL end to end - what Part 1 owns, where the workflow data and logs are, how to get the device id, the handoff to SSFB device binding and harbor, and the first queries when a user is stuck after Part 1. Use for any NRE/NRO onboarding case that starts on RTL or stalls between RTL and SSFB.
metadata:
  kind: journey
  entity: rtl
  sources: rtl/NRI_ONBOARDING.md
  status: ported
---

# NRI onboarding on RTL

The service details are in `rtl-workflow`, `rtl-banking` and `rtl-kyc`. This
note is the journey across them and the handoff to SSFB.

## 1. What RTL owns

Part 1: every step the app marks `workflowOwner = ASPORA_RTL`. The CBS tail
(`SHIVALIK_BANK` steps) is SSFB.

```
app -> workflow-op (engine; asks each step's handler over HTTP)
         |- banking-service  (Part-1 data: basics, income, eVisa, survey)
         |- kyc-service      (Persona KYC and eVisa verdicts)
         '- harbor, guardian (Part 2 on SSFB: device binding, then the form)
```

- The variant is picked once: UAE users get `NRI_ONBOARDING_UAE`; others stay
  on the variant of their existing execution, else V4, then V3, then legacy.
- Steps advance on the app's status call: workflow-op asks the handler, and a
  satisfied step is skipped. No Kafka is involved, so a stuck step means the
  handler keeps answering "not satisfied" or fails, not that an event was lost.
- Persona and eVisa verdicts reach kyc-service by SQS, not HTTP (see
  `rtl-kyc`).
- The last RTL step of `NRI_ONBOARDING_UAE` hands the user to device binding
  on SSFB through its `next_step` (unverified: the step identifier is not in
  the sources; read the definition's `steps`).

## 2. Where the data is

The RTL workflow DB works (checked on 2026-09-25; it holds the
`NRI_ONBOARDING_UAE` runs). The banking and kyc DBs were not re-checked.

| Table | Columns to read |
|---|---|
| `workflow_executions` | `reference_id`, `reference_type`, `workflow_identifier`, `status`, `sub_status`, `current_step_identifier`, `current_step_index`, `step_data` |
| `workflow_definitions` | `steps` (ordered), `definition_settings` |
| `ui_templates` | the template rendered per step |
| `workflow_execution_actions` | go-back and revert rows, for a stuck revert |

Timestamps here are naive and stored in UTC; `sql_select` returns them with a
`Z`. Tickets quote IST.

```
sql_select { service: 'workflow', sql: "SELECT workflow_identifier, status, sub_status, current_step_identifier, current_step_index, step_data FROM workflow_executions WHERE reference_id = $1", params: ['<aspora_user_id>'] }
```

Which id `reference_id` holds for a Part-1 run is not documented (unverified).
Try the `aspora_user_id`, then the `account_form_id` with
`reference_type = 'FORM'`. For the time columns, read
`information_schema.columns` for the tables you need in one call
(`WHERE table_name IN ($1, $2)`).

## 3. Logs

Service names end in `-service` (`workflow-op-service`, `app-server-service`,
`user-vault-service`, `verification-service`); the RTL logs note has the full
list.

- `workflow-op-service` logs full outbound request and response bodies,
  including personal data and admin tokens. Never quote them; cite the field
  name and the line's timestamp.
- `user-vault-service` lines carry phone, name and date of birth. Never quote
  them.

To get the device id, search the app server by the user id over a short
window, such as one day around the last Part-1 activity or the ticket time,
and ask for the column:

```
logs_search { service: 'appserver', terms: ['<aspora_user_id>'], columns: ['x-device-id'], from: '<day_start>', to: '<day_end>' }
```

The app server logs every app request, so a longer window can pass 5,000 hits
and come back with no hits. On that answer, narrow the window; do not switch
to `group_by` (`x-device-id` is not a filterable field here). One page is
enough: the device id repeats on every line.

A device id seen this way can be searched as a whole `terms` value in this
run. Name it in your findings with where you saw it, so the parent can pass it
to SSFB as a journey key.

## 4. Handoff to SSFB

- Harbor pulls the finished Part-1 form from banking-service's
  `form-submission-data` endpoint, with `data_token` = `aspora_user_id`. The
  endpoint checks the phone (`PHONE_NUMBER_MISMATCH`) and the NRI execution
  (`WORKFLOW_EXECUTION_NOT_FOUND`); see `rtl-banking`.
- guardian runs device and SIM binding first. Until SIM binding is VERIFIED,
  harbor has no form with the user's id (`external_user_ref` is written after
  that), guardian has no refresh token for the user, and harbor logs only
  `has_data_token`, not the user id. So an empty harbor or refresh-token
  lookup for a user stuck here is expected: it is not the fault. Follow the
  device id instead (`ssfb-guardian`, `device_auth_attempts` by `device_id`).

## 5. Known issues and first queries

| Symptom | Start with |
|---|---|
| Stuck on a step or wrong screen | `workflow_executions` above, then `rtl-workflow` |
| Revert or go-back stuck | pattern `rtl-workflow-revert-stuck` |
| KYC or Persona not passing | pattern `rtl-persona-verdict-not-landing`, `rtl-kyc` |
| CBS creation never starts | patterns `form-submission-phone-mismatch`, `form-submission-execution-not-found` |
| SIM binding stuck, no SMS reached the vendor | pattern `sim-binding-no-vendor-callback` (the device id here, the attempts on SSFB) |

Stuck after Part 1, in order:

1. The execution: `status` and `current_step_identifier`. If it is at or past
   the last RTL step, Part 1 is done and the case is on SSFB.
2. `workflow-op-service` lines for the user (`terms: ['<aspora_user_id>']`),
   oldest first, to see the last step it served.
3. The device id from `app-server-service`, as in section 3.
4. Hand the user id and device id to SSFB. There, device attempts by
   `device_id` come first; an empty harbor form is expected.

## 6. What not to use

- RTL admin APIs are not configured in this deployment, so `http_call` has no
  RTL services. Use the DB, the logs and the code.
- Never call the step endpoints (`/submit`, `/go-back`): they change the
  user's state.
- RTL's own eventbus, pdf-generator and reminder-service are out of scope;
  there is nothing to query for them.
