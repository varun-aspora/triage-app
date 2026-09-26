---
name: ssfb-overview
description: SSFB (Shivalik bank) map for the orchestrator. The id chain from thread ids to harbor forms, harbor customers and rhythm accounts, which service owns which part of NRI banking, the join keys between services, and the services with no triage data access (audit, eventbus). Use it to read the resolve_identity result, pick the SSFB services in play and write the investigate_ssfb brief.
metadata:
  kind: overview
  entity: ssfb
  sources: shivalik/AGENTS.md, shivalik/NRI_ONBOARDING.md, shivalik/audit/AGENTS.md, shivalik/eventbus/AGENTS.md
  status: ported
---

# SSFB overview

SSFB is the Shivalik bank side of NRI banking: NRE and NRO accounts on the
Shivalik core banking system (Finacle, called CBS below). The user reaches it
through the Aspora app. Onboarding Part 1 (the pre-CBS form) runs on RTL; SSFB
owns Part 2, the CBS tail: customer (CIF) creation, account creation, device
and SIM binding and MPIN.

`resolve_identity` runs the id chain below and returns it with a status per
hop. Anything past the chain (logs, statements, document state) is work for
`investigate_ssfb` or `investigate_ssfb_deep`, which read the `ssfb-<service>`
notes.

## ID chain

A run knows seven ids. Only these names are used in the chain and the brief:

| Id | What it is |
|---|---|
| `country` | GB or AE, the country of the customer's account. No hop. |
| `phone_number` | the customer's phone number, possibly with a +44 or +971 prefix. No hop. |
| `aspora_user_id` | the user's id in the Aspora app (a UUID). The same value is harbor `account_forms.external_user_ref`. Not a CIF and not an account number. |
| `customer_id` | the SSFB harbor `customer.customer_id` (a UUID). Not the CIF id. The bot's "Horus Customer ID" is this id. |
| `account_form_id` | the harbor `account_forms.form_id` (a UUID). Also the NSTP application id and the workflow `reference_id`. |
| `account_id` | the SSFB rhythm `customer_account_mappings.account_id` (a UUID). Not the bank account number. |
| `account_number` | the bank account number (digits), as CBS and the rhythm logs hold it. |

The chain is:

```
aspora_user_id
  -> harbor.account_forms.external_user_ref   gives account_form_id (form_id), session_id, status_v2
  -> harbor.customer.account_form_id          gives customer_id, state, sub_state, CIF present or not
  -> rhythm.customer_account_mappings.customer_id
                                              gives account_id, account_number, account_type
```

The harbor table is `customer`, singular. `account_forms.status_v2` is the
authoritative form status; the older `status` column is a lossy projection
(see the ssfb-harbor note).

Hops, in the order `resolve_identity` tries them. Every hop is a fixed
parameterised statement.

| Have | Query | Get | Notes |
|---|---|---|---|
| `account_id` | `rhythm.customer_account_mappings WHERE account_id = $1` | `customer_id` | runs only while no `customer_id` is known |
| `account_number` | `rhythm.customer_account_mappings WHERE account_number = $1` | `customer_id` | runs only while no `customer_id` is known |
| `customer_id` | `harbor.customer WHERE customer_id = $1` | `account_form_id`, `external_reference_id IS NOT NULL` (CIF exists) | the harbor `customer_id`, not the CIF id |
| `aspora_user_id` | `harbor.account_forms WHERE external_user_ref = $1 AND is_deleted = false ORDER BY created_at DESC` | `account_form_id` (the newest form) | may not resolve for a returning user's device re-bind |
| `account_form_id` | `harbor.account_forms WHERE form_id = $1 AND is_deleted = false` | `aspora_user_id` (`external_user_ref`), `session_id`; `status_v2` (authoritative) comes with the basic state | NSTP Application ID is the form_id |
| `account_form_id` | `harbor.customer WHERE account_form_id = $1` | `customer_id` | runs only while no `customer_id` is known |
| `customer_id` | `rhythm.customer_account_mappings WHERE customer_id = $1` | `account_id`, `account_number`, `account_type`, `scheme_code` | `account_id` for admin APIs, `account_number` for logs |
| `account_form_id` | `workflow_op.workflow_executions WHERE reference_id = $1 AND reference_type = 'FORM'` on the SSFB copy; if empty, the RTL copy | `status`, `current_step_identifier`, `workflow_identifier` | the two copies of workflow-op hold different forms |

`phone_number` and `country` have no hop: they reach you as the thread gave
them. There is no device hop; for a device or SIM case, go from the user to
guardian as the ssfb-guardian note says.

Basic state read with the chain: harbor customer `state` and `sub_state`,
`account_forms.status_v2`, and the rhythm account status and debit flag. Each
carries `taken_at`. A hop that could not be reached is marked `unreachable`;
treat what it would have returned as a gap, not as "no rows".

A user can have several forms (retries, re-onboarding) and a customer usually
has two accounts (NRE and NRO). Keep all of them in the brief; do not pick one
unless the thread names it.

## Which id goes where

| Id | Where it is used |
|---|---|
| `aspora_user_id` (`external_user_ref`) | harbor forms; guardian `refresh_tokens.subject` |
| `account_form_id` (`form_id`) | harbor form tables; `reference_id` in `workflow_executions` and in the v3 RFI tables; the `form_id` log field on harbor |
| `session_id` | guardian's verification session lookup by session |
| `customer_id` (harbor) | harbor customer tables and admin API; rhythm mappings, limits and beneficiaries; the `x-customer-id` header, which the HTTP tool sets from the chain |
| `account_id` (rhythm UUID) | rhythm admin APIs and `transfer_transactions` |
| `account_number` (CBS) | the best key for rhythm log searches and for CBS account reads |
| CIF | CBS customer reads; stored encrypted in `customer.external_reference_id` (see ssfb-harbor) |
| `txn_ref_id` | one transfer in `transfer_transactions` and in rhythm logs |

Log correlation ids (`x_req_id`, `x_txn_id`) are reused across requests, so
they narrow a search but do not identify one request on their own.

## Who owns what

| Area | Owner | Registry service |
|---|---|---|
| Onboarding forms, KYC documents, e-sign, notary, RFIs | harbor | `harbor` |
| CBS customer (CIF) creation and the customer state machine | harbor | `harbor` |
| MPIN storage and attempt counters | harbor | `harbor` |
| NRE/NRO account creation (called by harbor), transfers, limits, beneficiaries, cards, statements | rhythm | `rhythm` |
| Device binding, SIM binding, token scopes | guardian | `guardian` |
| Onboarding step engine (the Shivalik copy of workflow-op) | workflow-op | `workflow` |
| STP rules and results | bro | `bro` |
| Customer communications | comms | `comms` |
| Cohorts | cohort | `cohort` |
| PDF generation | pdf-generator | `pdfgen` |
| Scheduled reminders | reminder-service | `reminder` |
| The bank's own records (Finacle) | Shivalik bank; the investigator reads them only when CBS access is enabled | `finacle` |
| Event fan-out between services | eventbus | `eventbus` |
| Platform audit trail | audit | `audit` |

Guardian owns device and SIM binding, not harbor (basis: the onboarding notes'
division of labour). Welcome-letter delivery after KYC is on ATSPL
(package-svc). eventbus, pdf-generator and reminder-service also run on RTL,
with different data.

## NRI onboarding across services

```
1. form submitted in the app          harbor account_forms.status_v2 = submitted
2. workflow-op advances the steps     nstp_review -> notary_pending (if needed) -> sign_pending
3. digital form (AOF) signed          harbor publishes DocumentSigningProcessRequested
4. harbor consumes it                 sign_pending -> under_review, then HandleCustomerCreation
5. harbor customer state machine      CIF create -> AML -> rhythm account create -> MPIN
6. guardian, in parallel              device and SIM binding, token scopes that route to MPIN setup
```

If the digital form never reaches `signed`, customer creation never starts and
nothing logs an error. The ssfb-harbor note has the state machines.

## Which note to read

| Thread says | Services in play |
|---|---|
| stuck in onboarding, form not moving, documents rejected, "specialist is reviewing" | harbor, workflow |
| "We hit a snag" on an onboarding screen | workflow first, not harbor |
| CIF or customer creation failed, AML | harbor, finacle |
| account missing in the app after onboarding | rhythm, harbor |
| SIM binding, device, OTP at login | guardian, harbor |
| MPIN setup blocked | harbor, guardian |
| transfer failed, reversed, no UTR, transfers disabled | rhythm |
| card status or debit card errors | rhythm |
| UPI or Paytm linking | rhythm (to prove the account is healthy), then a bank ticket |
| event sent but never received | eventbus, plus the sending and receiving services |

## Services with no triage data access

**audit** (log service `audit-svc`). The platform audit trail: a Kafka consumer
writes events from other services into an append-only store, partitioned by
`occurred_at` (tables `events`, the catch-all partition `events_default`, and
`domains`, the registry of domains allowed to emit). The registry has no
database or API key for audit, so triage can read only its logs and its code.
If a case needs "no history for this entity", say that the audit store was not
readable and record it as a gap. Rows in `events_default` would mean a missing
partition, which is a code_walker question at most.

**eventbus** (log service `eventbus`). A Java service that takes platform
events and dispatches them through one handler per destination type: Kafka,
external Kafka, HTTP webhook, SQS. "Service A emitted it but service B never
saw it" is an eventbus question: find the destination type first, then look
for Kafka lag or topic mismatch, an HTTP non-2xx, or an SQS permission error in
its logs. It scales on consumer lag, so check scaling in the deploy manifests
repo named in your instructions before blaming throughput. No database is known
for it on SSFB, so triage has its logs and code only.
