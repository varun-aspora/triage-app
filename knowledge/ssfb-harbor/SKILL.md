---
name: ssfb-harbor
description: SSFB harbor service note. Onboarding forms, KYC documents, e-sign, notary, RFIs, CBS customer (CIF) creation and the customer state machine, MPIN counters. Tables, state machines, symptom-to-first-check rows, log anchors and known issues as sql_select, http_call and logs_search calls. Use it for any SSFB onboarding, CIF, document, RFI or MPIN question.
metadata:
  kind: service
  entity: ssfb
  service: harbor
  sources: shivalik/harbor/AGENTS.md, shivalik/NRI_ONBOARDING.md, shivalik/AGENTS.md
  status: ported
---

# harbor (SSFB)

harbor runs NRI onboarding Part 2: the onboarding form, KYC documents, e-sign
(Zoho), notarisation (NotaryLive), RFIs, CBS customer (CIF) creation, the
customer state machine and MPIN. It creates the CIF and then asks rhythm to
create the NRE and NRO accounts.

Device and SIM binding belong to guardian, not harbor (see ssfb-guardian).
harbor's `/v1/device/register` stores the app's FCM push token and does not
bind a device (unverified: stated by the onboarding notes only, the handler
was not read). harbor calls guardian for the session's phone and to reset a
device's attempt counter.

- Tool service key: `harbor` (database, admin API and logs).
- Log service: `harbor`. Extra log fields: `form_id` (also `x-form-id`),
  `document_type`. On CBS client errors the `error` field carries the CBS
  `ESBStatus.Message`.
- Code: repo `harbor`; the CBS client is the `shivalik-cbs-go` library.

## Tables

| Table | What to look at |
|---|---|
| `account_forms` | One row per onboarding attempt. `form_id`, `external_user_ref` (Aspora user id), `session_id`, `status_v2`, `status`, `is_deleted`, `created_at`. `submission_data` is encrypted; see below. |
| `customer` | Created when CBS accepts the customer. `customer_id`, `account_form_id`, `state`, `sub_state`, `external_reference_id` (the CIF, encrypted), `mpin_setup_status`, `biometric_setup_status`. |
| `digital_forms` | e-sign state. `status` must reach `signed`; also `signing_url`, `provider`. Unsigned blocks CBS. |
| `notary_orders` | `status`, `sub_status`, `order_id`. |
| `document_verifications` | KYC document checks (PAN, passport). |
| `form_proofs` | `type` (passport_front, passport_back, poa, selfie_front, custodian_certificate); `status` pending, notary_pending, rfi_pending, requires_resubmission. |
| `form_stp_checks` | STP check results for the form (bro evaluates them). |
| `form_checklists` | Per-step ledger: `step_key`, `status`. |
| `rfi_requests_v3`, `rfi_items_v3` | RFIs. `reference_id` is the form_id. |
| `audit_logs` | harbor's own action trail: `entity_id`, `action`, `performed_by`, `performed_at`, `payload`. |
| `mpin_attempt_trackers` | MPIN challenge and failure counters by `customer_id`. They live in harbor, not guardian. |
| `device_registrations` | Rows from `/v1/device/register`. |

Resolved naming, stated once here:

- The customer table is `customer`, singular (basis: the id chain queries in
  shivalik/AGENTS.md and the LLD hop table; the plural name in the old harbor
  note was wrong).
- `rfi_requests_v3` and `rfi_items_v3` are the RFI tables. `rfi_requests` is
  legacy and empty (basis: the harbor note's RFI section).
- `document_verifications` holds document checks. `form_attachments` is legacy
  and empty (basis: the same section). The columns of `document_verifications`
  are not documented, so read a few rows before filtering on anything else.
- `digital_forms`, `form_checklists` and `document_verifications` are joined
  to the form by `form_id` in the queries below (unverified: the sources show
  their status columns, not their join key).
- `account_forms.status_v2` is authoritative. `status` is a lossy legacy
  projection: `formStatusToOld` folds `sign_pending`, `under_review` and
  `verified` into `VERIFIED`, so `status = VERIFIED` does not mean done.
- `customer.external_reference_id` holds the CIF, AES-SIV encrypted. It is set
  by the `NEW` state handler; null means CBS customer creation never
  succeeded. AES-SIV is deterministic, so a lookup by CIF encrypts the CIF
  first with `encrypt_lookup_value` (kind `cif`) and passes the ciphertext as a
  parameter. `decrypt_fields` reads a fetched value. Both tools answer "not
  configured" when the field key is not set; record that as a gap.
- `account_forms.submission_data` (the full onboarding JSON: phone_number,
  residence_country, nri_documents, fatca_details) is encrypted. Read it from
  the workflow-op step-handler response in the logs instead; there is no tool
  that decrypts the whole document.

## Queries

Form, status and session for a user:

```
sql_select({ service: "harbor",
  sql: "SELECT form_id, status_v2, status, session_id, created_at FROM account_forms WHERE external_user_ref = $1 AND is_deleted = false ORDER BY created_at DESC",
  params: ["<user_id>"] })
```

Customer state and whether a CIF exists:

```
sql_select({ service: "harbor",
  sql: "SELECT customer_id, state, sub_state, external_reference_id IS NOT NULL AS has_cif, mpin_setup_status, created_at FROM customer WHERE account_form_id = $1",
  params: ["<form_id>"] })
```

Customer by CIF:

```
encrypt_lookup_value({ value: "<cif>", kind: "cif" })
sql_select({ service: "harbor",
  sql: "SELECT customer_id, account_form_id, state, sub_state FROM customer WHERE external_reference_id = $1",
  params: ["<cif_ciphertext>"] })
```

Live customer state (fastest; use it before the database). The tool sets
`x-customer-id` from the id chain.

```
http_call({ service: "harbor", path: "/admin/v1/customers/<customer_id>" })
```

It returns `state`, `sub_state` (`ACTIVATED` means onboarding is done),
`phone`, `email`, `mpin_setup_status`, `biometric_setup_status`.

E-sign, documents and step ledger:

```
sql_select({ service: "harbor",
  sql: "SELECT status, provider FROM digital_forms WHERE form_id = $1",
  params: ["<form_id>"] })
sql_select({ service: "harbor",
  sql: "SELECT * FROM document_verifications WHERE form_id = $1 LIMIT 20",
  params: ["<form_id>"] })
sql_select({ service: "harbor",
  sql: "SELECT step_key, status FROM form_checklists WHERE form_id = $1",
  params: ["<form_id>"] })
```

MPIN counters:

```
sql_select({ service: "harbor",
  sql: "SELECT * FROM mpin_attempt_trackers WHERE customer_id = $1",
  params: ["<customer_id>"] })
```

Onboarding JSON (phone, residence country) from workflow-op's logged
step-handler response:

```
logs_search({ service: "workflow", terms: ["<form_id>", "step-handler"] })
```

## State machines

Form status (`account_forms.status_v2`):

```
open -> submitted -> downloading -> nstp_review -> notary_pending -> sign_pending -> under_review -> verified | rejected
```

`under_review` means signed and waiting for the bank. `notary_pending` is
skipped when no notary is needed.

CBS trigger chain:

```
form submitted                 status_v2 = submitted
workflow-op advances           nstp_review -> notary_pending (if required) -> sign_pending
digital form signed            harbor publishes DocumentSigningProcessRequested
consumer picks it up           sign_pending -> under_review, then HandleCustomerCreation(form)
customer state machine         CIF create -> AML -> rhythm account create -> MPIN
```

Customer state (`customer.state`, `internal/service/orchestration_service.go`):

| State | Handler does | Next |
|---|---|---|
| `NEW` | `cbsService.CreateCustomer`; sets `external_reference_id` to the CIF; maps the CBS AML status | `AML_*` |
| `AML_VERIFIED` | builds the account request (product NRE savings, account types NRE and NRO) and calls rhythm CreateAccount | `MPIN_SET` |
| `AML_WAIT` | returns an error, so the message goes to the DLQ (AML still pending) | none |
| `AML_REJECTED` | skipped | none |
| `UNDER_REVIEW` | creates a Pulse KYC ticket | none |
| `KYC_VERIFIED` | publishes welcome-letter delivery (ATSPL package-svc) | `ACTIVATED` |

All states: `NEW`, `AML_WAIT`, `AML_VERIFIED`, `AML_REJECTED`, `MPIN_SET`,
`UNDER_REVIEW`, `RFI`, `RFI_CERTIFICATION`, `KYC_VERIFIED`, `ACTIVATED`,
`REJECTED`, `DELETED`.

CBS `AML Status` to state (`determineState`, `orchestration_service.go:430`):
`C` becomes `AML_VERIFIED`, `R` becomes `AML_REJECTED`, anything else
(including `P` and empty) becomes `AML_WAIT`.

NSTP review is two-stage (`internal/service/nstprfi/crm_actions.go`):

```
StageQCFail (system)            rfi_requests_v3.state = DRAFT, invisible to the customer
agent edits items in CRM        rfi.item.removed / rfi.item.pending, performed_by = crm_agent
SubmitFirstLevelReview          escalates; log "NSTP_INTERNAL_REVIEW pulse ticket created"
SubmitInternalReview            publishes: state AWAITING_INPUT, published_at set,
                                proofs -> requires_resubmission, comms sent
```

Only the second stage publishes. A healthy RFI goes from DRAFT to published in
about five seconds.

CBS error codes mapped by harbor (`shivalik-cbs-go` `pkg/errors/error_codes.go`):
`CUSTOMER_EXISTS` (handled; the CIF is reused), `AML_MATCH_FOUND` (retry after
30 minutes), `VALIDATION_ERROR`, `INTERNAL_ERROR`, `SIGNATURE_ADD_FAILED`,
`UNKNOWN`.

## Symptom to first check

| Symptom | First check |
|---|---|
| Form not progressing | `account_forms.status_v2` and `form_checklists`; then workflow-op logs for the step-handler call with the form_id |
| CX says "stuck at step X" | Do not trust the label. Compare `status_v2` with `workflow_executions.current_step_identifier`; a finished step is often reported as stuck |
| "We hit a snag" on an onboarding screen | Not harbor. See ssfb-workflow: the stuck step in `workflow_executions`, then `JsonTemplateHandler` errors (a raw tab or newline in OCR data breaks the template render) |
| "A specialist is reviewing" never clears | `rfi_requests_v3` by `reference_id`; see Known issues |
| Document verification failing | `document_verifications` for the form, then open RFIs in `rfi_requests_v3` |
| E-sign never completes | `digital_forms.status` must be `signed` |
| Stuck at CBS customer creation | `customer.state`, `sub_state` and `has_cif`; the CBS response in logs (Known issues) |
| AML pending or rejected | `customer.state` = `AML_WAIT` (DLQ) or `AML_REJECTED`; check the CBS response before believing it |
| Account not created after the CIF | `customer.state` should go `AML_VERIFIED` to `MPIN_SET`; then rhythm (see ssfb-rhythm) |
| SIM binding stuck | guardian (see ssfb-guardian); harbor only holds the form and session |
| MPIN setup blocked | `mpin_attempt_trackers` and `customer.mpin_setup_status`; the guardian token scope (see ssfb-guardian) |

Endpoints that change state exist, for example
`POST /admin/v1/forms/<form_id>/trigger-customer-creation`, which re-runs CBS
customer creation for a stuck form. `http_call` refuses them. Name them as a
possible fix in the findings; never try to call them.

## Known issues

### PAN and passport name mismatch at harbor's own check

harbor's pre-submit fuzzy check (`internal/service/document_verification/pan_handler.go`)
fails with `error` = "Pan name & passport name doesn't match, please reach out
to support". The line carries the form_id, so no correlation is needed.

```
logs_search({ service: "harbor", level: "error",
  message: "document verification handler failed",
  error: "Pan name passport name match support",
  fields: { form_id: "<form_id>" }, from: "<from>", to: "<to>" })
```

### CBS rejects the customer with FZYCHCKREVIEW

A later, separate failure: the user passed harbor's check, but CBS `RetCustAdd`
(customer create) returns code `FZYCHCKREVIEW`, "two or more fuzzy ratios are
lesser than minimum fuzzy check ratio (75%)". CBS client lines carry no
form_id. Find the anchor that has one, then walk its `x_txn_id` back from the
error line:

```
logs_search({ service: "harbor", message: "calling CBS API to create customer",
  fields: { form_id: "<form_id>" }, from: "<from>", to: "<to>" })
logs_search({ service: "harbor", fields: { x_txn_id: "<x_txn_id>" },
  from: "<from>", to: "<to>" })
```

`x_txn_id` is reused across requests, so take the lines nearest in time to the
anchor. Each CBS failure writes two error lines, `[CBS API] Unknown Error - Raw
Response` (the raw `ESBStatus`) and `CBS API error` (the `error` text). Count
failures, not lines.

### The CBS customer response: read ESBStatus, not AML Status

The customer-create request is JWE-encrypted and unreadable in logs; the
plaintext XML is logged separately (`message` "==== XML PAYLOAD (before
encryption) ===="). The response is plain JSON and logged whole, one document
per attempt:

```
logs_search({ service: "harbor", message: "HTTP Response", terms: ["RetCustAdd"],
  from: "<from>", to: "<to>" })
```

Shape: `RsData.RetCustAdd.RetCustDetails` has `CustId` (the CIF, only when
`AML Status` is `C`), `AML Status` (`C` cleared, `P` pending, `R` rejected),
`AML TrackId`, `Status`, `Desc`; `RsData.ESBStatus` has `Status`, `Code`,
`Message`, `Description`, `ReferenceId`.

The AML fields are almost never where the failure is. In one sampled window of
over a thousand responses every one was `AML Status` `C` and no customer moved
to `AML_WAIT` or `AML_REJECTED`. Real failures come through `ESBStatus` while
`AML Status` still reads `C`:

| `ESBStatus` | Meaning |
|---|---|
| `Message` "CIF already exists" (with `MINKYC`, a CIF present, no `AML Status` key) | a retry of a call that already worked; harbor recovers the CIF in `handleExistingCustomer` |
| `Code` `FZYCHCKREVIEW` | PAN and passport fuzzy ratio under 75% (above) |
| `Code` `INPROGRESS`, "last request still in progress, please wait for 45 sec and retry" | a duplicate submit in flight |
| `Description` with CRMEJB code 0306, "Expiry Date has to be greater than or equal to Today's Date" | an expired document in the payload |
| `Description` with CRMEJB code 0024 on attribute `PhoneEmail.Email` | email too long or too short for Finacle |
| `RetCustDetails.Status` "PAN Name does not match with NSDL records" | NSDL name mismatch |

Read `ESBStatus` first and use `AML Status` only as a tiebreaker.

### "PAN verification failed, please try again" hides the real error

`pan_handler.go:153` returns this text for any error from the CBS PAN
validation client. The cause is one HTTP hop below. Walk the `x_txn_id` and
read the `message` "HTTP Response" lines' `raw_message` response body:

- `status_code` 500 with an error path naming a CBS-internal upstream means a
  bank-side failure. Escalate with the `request_uuid`.
- The retry right after it returns 200 with `ESBStatus.Status` "Failure" and
  `Message` "Request UUID Already Submitted on ...". That is harbor reusing the
  same request UUID on retry, not a result. Report the 500, not the "Already
  Submitted".

The same text appears when the fuzzy-check call itself errors
(`verifyPassportPanNameMatch`); an "error in fuzzy check" log line tells them
apart. A fuzzy mismatch has its own message (the first issue above).

```
logs_search({ service: "harbor", error: "PAN verification failed",
  fields: { form_id: "<form_id>" }, from: "<from>", to: "<to>" })
logs_search({ service: "harbor", message: "HTTP Response",
  fields: { x_txn_id: "<x_txn_id>" }, from: "<from>", to: "<to>" })
```

### Document verification rate limit

`checkRateLimit` (`document_verification_service.go:129`) allows 3 attempts in
a sliding window per form, then returns "Too many attempts - please contact
customer support". Concurrent double submits each use a slot. The window in
the repo defaults (1 hour and 24 hours on two config structs) does not match
the observed window of about 18 minutes, so check the deployed config in the
deploy manifests repo (prod-ssfb-aspora-argo) before quoting one.

```
logs_search({ service: "harbor", error: "Too many attempts",
  fields: { form_id: "<form_id>" }, from: "<from>", to: "<to>" })
```

### "A specialist is reviewing" never clears: RFI still in DRAFT

While `rfi_requests_v3.state = 'DRAFT'` and `published_at` is null, the app
shows "a specialist is now reviewing" with no action for the user. That is the
designed screen for the first NSTP review stage, not a bug. A DRAFT older than
a few minutes is a review waiting in someone's queue.

```
sql_select({ service: "harbor",
  sql: "SELECT r.rfi_id, r.state, r.published_at, i.type, i.state AS item_state, i.agent_reason FROM rfi_requests_v3 r JOIN rfi_items_v3 i ON i.rfi_id = r.rfi_id WHERE r.reference_id = $1 AND i.deleted_at IS NULL",
  params: ["<form_id>"] })
sql_select({ service: "harbor",
  sql: "SELECT performed_at, action, performed_by, payload FROM audit_logs WHERE entity_id IN ($1, $2, $3) ORDER BY performed_at",
  params: ["<form_id>", "<rfi_id>", "<item_id>"] })
logs_search({ service: "harbor", message: "NSTP_INTERNAL_REVIEW pulse ticket created",
  fields: { form_id: "<form_id>" }, from: "<from>", to: "<to>" })
```

The last query answers "did stage 1 complete?". The log line "failed to get
customer by form ID: record not found" on the CRM read path is normal before
CBS and is not the failure.

### Digital form never signed, so customer creation never starts

If `digital_forms.status` never reaches `signed`, harbor never publishes
DocumentSigningProcessRequested and `HandleCustomerCreation` never runs.
Nothing errors. For "form submitted but nothing happened", check the digital
form before anything else.

```
sql_select({ service: "harbor",
  sql: "SELECT status, provider FROM digital_forms WHERE form_id = $1",
  params: ["<form_id>"] })
```
