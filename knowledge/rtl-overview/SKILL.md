---
name: rtl-overview
description: RTL at a glance - it owns NRI onboarding Part 1 (before CBS) through workflow-op, banking-service and kyc-service; the join keys to SSFB harbor; the separate RTL copy of workflow-op; what is out of scope; and when to brief investigate_rtl. Use when a user is stuck on an onboarding step owned by ASPORA_RTL, KYC or eVisa is not passing, or CBS creation never started.
metadata:
  kind: overview
  entity: rtl
  sources: rtl/AGENTS.md, rtl/NRI_ONBOARDING.md
  status: ported
---

# RTL overview

RTL owns NRI (NRE/NRO) onboarding Part 1: every step the mobile app marks
with `workflowOwner = ASPORA_RTL`. The CBS tail (`SHIVALIK_BANK` steps) is
SSFB. RTL runs on its own cluster, separate from SSFB, so SSFB databases and
logs do not show RTL rows.

## Services

| Registry key | Repo | Role | Note |
|---|---|---|---|
| `workflow` | `workflow-op` | The onboarding engine. Drives every step server-side, renders the SDUI screens, and records where the user is stuck. | `rtl-workflow` |
| `banking` | `banking-service` | Go. Part-1 data collection (modules nri, evisa, survey) and the endpoint harbor pulls the finished Part-1 form from. Mostly stateless. | `rtl-banking` |
| `kyc` | `kyc-service` | Java. Persona KYC and eVisa system of record; `kyc_inquiries.status` is the verdict. | `rtl-kyc` |

### The two copies of workflow-op

workflow-op is deployed twice: once on RTL and once on SSFB. `rtl:workflow`
is the RTL copy and `ssfb:workflow` is the SSFB copy. They are separate
databases; the same form can sit in either. If one copy has no row for a
form, the other copy should be checked before concluding the form has no
workflow execution.

### Out of scope for v1

RTL also runs its own copies of eventbus, pdf-generator and reminder-service.
They are out of scope for v1 and are not in the registry, so there is nothing
to query for them. A Shivalik-side fix to one of these services does not
imply the RTL copy is fixed; if a case points at one of them, say so in the
report and escalate.

Also out of reach: user-vault (email verification, user basics) and the app
server are Aspora core services, not RTL, and not in any registry.
verification-service is still referenced by the `NRI_ONBOARDING_V4` step
definitions for some KYC steps, but kyc-service replaces it for NRE/NRO.

## Who calls whom

```
mobile app -> workflow-op (engine; each step asks an external step handler over HTTP)
                |- banking-service  (Part-1 data: basics, income, eVisa, survey)
                |- kyc-service      (Persona KYC and eVisa verdicts)
                |- verification-service (older KYC steps in some definitions)
                |- user-vault       (Aspora core)
                '- harbor           (Part-2 device binding and account creation, SSFB)
```

The handoff to CBS is a pull: harbor calls banking-service's
`form-submission-data` endpoint to fetch the assembled Part-1 form, then
starts CBS account creation.

## Data access

- Each service's database and admin API are reachable when they are
  configured for this deployment. When one is not, the investigator's tool
  answers "not configured for rtl:<service>", and that goes into the findings
  as a gap.
- Quickwit covers RTL. The log service name for each service is in the
  registry; the investigator's log tool maps it.

## Join keys

| RTL side | Other side | Meaning |
|---|---|---|
| workflow-op `workflow_executions.reference_id` with `reference_type = 'FORM'` | harbor `account_forms.form_id` (SSFB) | The workflow run for a harbor form. |
| banking-service `form-submission-data` `data_token` | `aspora_user_id` = harbor `account_forms.external_user_ref` | What harbor sends when it pulls the Part-1 form. |
| harbor `customer.account_form_id` | harbor `form_id` | From customer back to form, on the SSFB side. |
| banking-service `visa_inquiry_id` | kyc-service `partner_inquiry_id` | The same value under two names. Not a mismatch. |
| kyc-service request context `x-user-id` | `aspora_user_id` | Who a KYC call was made for. |

Two links are not documented:

- For an RTL Part-1 execution, whether `reference_id` holds the Aspora user
  id or the form_id (unverified: no source states it). Try the
  `account_form_id` with `reference_type = 'FORM'` first, then the
  `aspora_user_id`.
- Which `kyc_inquiries` column joins to the Aspora user id or the harbor
  form_id (unverified: no source states it).

## When to brief investigate_rtl

- The step the user is stuck on has `workflowOwner = ASPORA_RTL`.
- No harbor form exists yet, or it is still open or submitted.
- The SSFB copy of `workflow_executions` has no row for the form.
- SSFB and ATSPL both come back clean on an onboarding case.
- KYC (Persona) or eVisa is not passing.
- CBS creation never started: the Part-1 handoff endpoint on banking-service
  should be ruled out before blaming harbor.

Send the ids you have (`account_form_id`, `aspora_user_id`) and name the services in
play (`workflow`, `banking`, `kyc`). If RTL is not indicated, the report says
so.
