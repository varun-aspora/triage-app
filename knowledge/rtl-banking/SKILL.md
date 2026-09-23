---
name: rtl-banking
description: RTL banking-service, which owns onboarding Part 1 before CBS - its modules, the form-submission-data endpoint harbor pulls from, its survey-only tables and known failures. Use when CBS account creation never started, harbor reports a Part-1 form mismatch, an exit nudge is missing, or a survey or eVisa step misbehaves.
metadata:
  kind: service
  entity: rtl
  service: banking
  sources: rtl/banking-service/AGENTS.md, rtl/NRI_ONBOARDING.md
  status: ported
---

# banking (RTL banking-service)

Repo `banking-service`, Go. It owns Part 1 of NRI onboarding on the RTL side,
the half before CBS. harbor owns the SSFB half, so an onboarding drop-off can
be on either side of that line. Establish which part the user was in before
digging.

banking-service is a thin adapter. Most onboarding state lives in workflow-op
executions and the app server; only the survey module writes to its database.
Most flows are HTTP only.

## Modules

| Module | Purpose |
|---|---|
| `nri` | NRI onboarding Part 1, including the exit nudge (`modules/nri/service/exit_nudge.go`), which schedules a callback or reminder when a user abandons Part 1. Has its own consumer. |
| `evisa` | eVisa orchestration. Stateless: it creates or fetches the KYC inquiry on STATUS and does the final check on HANDLE. All state is in kyc-service. There is no banking-side POLL, on purpose. |
| `survey` | Onboarding surveys (for example `account_suitability`). The only module with tables. |
| `shared` | Cross-module code. |

`internal/` holds bootstrapping and infrastructure only; business logic is in
`modules/<domain>/`. Workflow step handling is in `internal/workflow`.

## Endpoints (prefix `/banking/v1`)

| Path | Purpose |
|---|---|
| `POST /nri/external/form-submission-data` | harbor pulls the assembled Part-1 form here to start Part 2. `data_token` = Aspora userId. |
| `POST /nri/survey-response`, `GET` and `POST /survey/surveys/<survey_key>` and its `/responses` | Onboarding surveys. |
| `GET /nri/admin/exit-nudge`, `GET /nri/admin/excitement-survey` | Called by workflow-op with an admin token. |
| `POST /evisa/workflow/step-handler` and its `/poll` | The UK eVisa step, called by workflow-op. |

The admin API is reachable with GET only when configured; otherwise
`http_call` answers "not configured for rtl:banking" and that is a gap to
record. The form-submission-data endpoint is a POST, so it is not callable
from triage; use its logs instead.

## Tables

Only `surveys` and `survey_responses`. There are no NRI form or eVisa tables:
the form is assembled from workflow-op on request, and kyc-service holds eVisa
state. If the service runs without a database configured, the survey module
is silently disabled and every `/banking/v1/survey/*` route is missing.

```
sql_select { service: 'banking', sql: "SELECT * FROM survey_responses WHERE user_id = $1", params: ['<user_id>'] }
```

The `survey_responses` user column name is not documented (unverified: the
source names the tables only); read one row first if this is refused.

## Logs

The registry maps `banking` to the log service `banking-service`
(unverified: the registry notes the log service name is not confirmed).

```
logs_search { service: 'banking', error: 'PHONE_NUMBER_MISMATCH' }
```

```
logs_search { service: 'banking', error: 'WORKFLOW_EXECUTION_NOT_FOUND' }
```

## Known issues

- **CBS creation never starts, or harbor reports a form mismatch.** Check
  the form-submission-data handoff before blaming harbor. On each pull it
  verifies the phone (`PHONE_NUMBER_MISMATCH`), fetches the NRI execution
  from workflow-op (`WORKFLOW_EXECUTION_NOT_FOUND`), and returns the
  `FormSubmitRequest` harbor deserialises. It looks for `NRI_ONBOARDING`,
  `NRI_ONBOARDING_V3` or `NRI_ONBOARDING_UAE` executions, and account types
  default to NRE and NRO.
- **eVisa status wrong or stuck.** The state is in kyc-service, not here.
  banking-service returns kyc-service's `partner_inquiry_id` as
  `visa_inquiry_id`: the same value under two names.
- **Exit nudge missing.** Start from `modules/nri/service/exit_nudge.go`,
  then the reminder it schedules. The RTL reminder-service is out of scope
  for v1, so a missing RTL reminder is reported as out of reach.
