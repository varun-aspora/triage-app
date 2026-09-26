---
name: atspl-overview
description: ATSPL at a glance - its two services (package for physical delivery, pulse for the staff ops console), how ATSPL joins to SSFB harbor, and when to send a brief to investigate_atspl. Use when a case involves a welcome letter, a debit card or other parcel delivery, or staff being unable to action something in the ops console.
metadata:
  kind: overview
  entity: atspl
  sources: atspl/AGENTS.md, atspl/NRI_ONBOARDING.md
  status: ported
---

# ATSPL overview

ATSPL (Aspora Technology Services) runs two services that matter for triage.
It is peripheral to NRI onboarding: it has one real handoff (welcome-letter
delivery) and an ops console that sits over harbor. The customer-facing
onboarding flow runs through RTL (Part 1) and SSFB (Part 2).

## Services

| Registry key | What it is | Note |
|---|---|---|
| `package` | Go physical delivery service ("PSE"). Ships welcome letters and debit cards through country carriers (DocketHub in the UK, Shipa/Aramex in the UAE). Driven by SQS, not Kafka. | `atspl-package` |
| `pulse` | Java Spring Boot server-driven-UI back office for Aspora staff, with maker-checker approval. It proxies the harbor and rhythm admin APIs over synchronous HTTP. It is not in the customer flow. | `atspl-pulse` |

package is not a product or plan master, and ATSPL has no product master.
pulse is an ops/CX console; its only Kafka use is an audit topic.

canopy is not in the registry and is not investigated (unverified: it shows up in ATSPL logs, but no repo, database or code reference was found for it).

## Data access

- Each service's database and admin API are reachable when they are
  configured for this deployment. When one is not, the investigator's tool
  answers "not configured for atspl:<service>", and that goes into the
  findings as a gap rather than a guess.
- Quickwit covers ATSPL. The log service names differ from the registry keys
  (pulse logs as `pulse-backend`; the package workers log under their own
  names), and the log tool maps the registry key for the investigator.
- The admin APIs are read with GET only. Retries and re-triggers are
  recommended in the report, never called.

## Join keys to SSFB

| ATSPL side | SSFB side | Meaning |
|---|---|---|
| package `delivery_requests.external_ref_id` | harbor `customer.customer_id` | The delivery a harbor customer asked for. harbor sends `ExternalRefID` = `UserID` = its customer_id. |
| package `delivery_requests.user_id` | harbor `customer.customer_id` | Same value as `external_ref_id` for welcome letters. |
| package `delivery_requests` address reference (`address_id`) | harbor address record | package fetches the address from harbor on demand and does not store address fields. |
| package delivery status | harbor `customer_deliveries` (keyed by customer_id) | harbor mirrors the delivery status in its own table. |
| pulse tickets and review queues | harbor form, keyed by `form_id` | pulse reads onboarding state live from harbor. |

## The welcome-letter flow

1. A harbor customer reaches KYC-verified.
2. harbor publishes `WelcomeLetterDeliveryRequested` on its critical SQS
   queue. Its consumer creates a delivery in package with
   `PackageType=WelcomeLetter`, `UserID` and `ExternalRefID` set to the
   harbor customer_id, and the `AddressID`.
3. package fetches the canonical address from harbor's admin API, ships
   through the vendor, and on each status change calls harbor's package
   delivery callback with the `external_ref_id`.
4. On `DELIVERED`, harbor activates the customer's overseas communication
   address.

A manual re-trigger goes through harbor's admin API (trigger-delivery for the
customer), so it is an SSFB action, not an ATSPL one.

## When to brief investigate_atspl

- A welcome letter or debit card was not delivered, or the overseas
  communication address is not active after KYC. Send
  `customer_id = <customer_id>` (package `external_ref_id` holds the same
  value) with services `package`, and name the harbor address id in the
  question if the thread gives one. Ask for the delivery rows, the vendor events in
  their exact text, and how many other customers hit the same failure in the
  window.
- Staff cannot action a KYC review, RFI or change request in the ops console.
  Check harbor state on SSFB first, because pulse only proxies harbor. Brief
  `investigate_atspl` with services `pulse` only when harbor looks healthy.

Do not brief ATSPL for onboarding step problems in the app. Those are RTL
(`ASPORA_RTL` steps) or SSFB (`SHIVALIK_BANK` steps).
