---
name: rtl-kyc
description: RTL kyc-service, the Persona KYC and eVisa system of record - its tables, endpoints, request context and known failures, including verdicts that arrive by SQS rather than HTTP. Use when NRE/NRO KYC is stuck or failing, a Persona verdict did not land, or an eVisa step is not passing.
metadata:
  kind: service
  entity: rtl
  service: kyc
  sources: rtl/kyc-service/AGENTS.md, rtl/NRI_ONBOARDING.md
  status: ported
---

# kyc (RTL kyc-service)

Repo `kyc-service`. Java 21, Spring Boot, JDBI (raw SQL, no Flyway). A
config-driven KYC platform that replaces verification-service's Persona flows
for NRE/NRO. It is also the system of record for eVisa: banking-service is a
stateless adapter, so all inquiry and verification state is here. It sits
behind banking-service, and the mobile eVisa step also calls it directly.

The verdict of record is `kyc_inquiries.status`.

## Tables

| Table | What to look for |
|---|---|
| `kyc_inquiries` | One row per KYC inquiry; start here. `status` (the verdict), `partner_status`, `partner_inquiry_id`, `idempotency_id`. Duplicate and FAILED rows are expected: the one-active-row rule excludes FAILED. |
| `kyc_verifications` | Verification attempts per inquiry, with the Persona verdict detail (`partner_fields`, raw `partner_payload`). |
| `kyc_documents` | Submitted documents. |
| `kyc_doc_extractions`, `kyc_verification_extractions`, `kyc_ocr_fields` | Extracted and OCR field values. |
| `kyc_sync_audit` | Sync history with Persona: did we actually reach it (`trigger_source`, counts, warnings). |
| `visa_inquiries`, `visa_attempts` | eVisa state and provider data. |
| `kyc_usecases` | Template and verdict config (JSONB). |

Which `kyc_inquiries` column holds the Aspora userId is not documented
(unverified: the source does not name it). The request context carries it as
`x-user-id`, so look for a user id column on the first row you read. The
Persona inquiry id is a safe join when banking-service or the logs give it:

```
sql_select { service: 'kyc', sql: "SELECT status, partner_status, partner_inquiry_id, idempotency_id FROM kyc_inquiries WHERE partner_inquiry_id = $1", params: ['<partner_inquiry_id>'] }
```

## Request context

The request context is the first parameter on controllers and services. It is
resolved from `x-user-id` or `x-requester-id`, else `SYSTEM`. Async paths
(webhooks, background jobs) use a system context, so a verdict-driven change
shows `SYSTEM` in audit fields, not the user.

## Endpoints (context path `/kyc-service`)

- Inquiry: `POST /api/v1/inquiries/get-or-create`,
  `GET /api/v1/inquiries/active`, `POST /api/v1/inquiries/<inquiry_id>/sync`.
- eVisa (the mobile app calls these directly):
  `POST /api/v1/visa/initiate`, `.../trigger-otp`, `.../submit`,
  `GET /api/v1/visa/submit/poll`, `GET /api/v1/visa/status`.
- Admin (banking-service calls these): `POST /api/v1/admin/inquiries/get-or-create`,
  `.../<inquiry_id>/sync`, `.../<inquiry_id>/force-sync`.

The API is reachable with GET only when configured; otherwise `http_call`
answers "not configured for rtl:kyc" and that is a gap to record. Sync and
force-sync are writes: recommend them in the report, do not call them.

## Logs

The registry maps `kyc` to the log service `kyc-service` (unverified: the
registry notes the log service name is not confirmed).

```
logs_search { service: 'kyc', terms: ['<partner_inquiry_id>'] }
```

## Known issues

- **Persona verdict not landing.** Verdicts arrive by SQS, not HTTP. There is
  no webhook route. `PERSONA_INQUIRY_COMPLETED` and
  `PERSONA_VERIFICATION_COMPLETED` land on the `critical-webhook-events`
  queue, and the critical event consumer sets `kyc_inquiries.status` to
  APPROVED or FAILED. eVisa verdicts use the same queue
  (`visa.inquiry.updated`). Suspect the SQS consumer (it can be switched off
  by configuration), not a route.
- **NRE/NRO KYC stuck.** Read `kyc_inquiries.status`, then
  `kyc_verifications` for the failing attempt, then `kyc_sync_audit` to see
  whether Persona was reached at all.
- **eVisa stuck.** Read `visa_inquiries` and `visa_attempts`. banking-service's
  STATUS call runs `/sync` to create the visa inquiry and returns
  `partner_inquiry_id` as `visa_inquiry_id`. The two are the same value under
  different names, which is easy to misread as a mismatch.
