---
name: atspl-package
description: The ATSPL package service (physical delivery of welcome letters and debit cards) - its tables, read-only admin API, logs and known failure modes. Use when a welcome letter or card was not delivered, a delivery is stuck, or the overseas communication address did not activate after KYC.
metadata:
  kind: service
  entity: atspl
  service: package
  sources: atspl/package-svc/AGENTS.md, atspl/NRI_ONBOARDING.md
  status: ported
---

# package (ATSPL)

Repo `package-svc`. A Go physical delivery service ("PSE") that ships items
through country carriers: DocketHub in the UK, Shipa/Aramex in the UAE. Its
transport is SQS, not Kafka. In NRI onboarding its only job is the welcome
letter: harbor asks for a delivery after KYC, package ships it, and its
delivery callback lets harbor activate the customer's overseas communication
address. It is not a product or plan master.

## Ids

- `external_ref_id` = harbor `customer_id`. This is the shared key.
- `user_id` holds the same harbor customer_id for welcome letters.
- `address_id` points at the address in harbor. Address fields are not stored
  here.

## Tables

| Table | What to look for |
|---|---|
| `delivery_requests` | One row per requested delivery: `user_id`, `country`, `package_type`, `status`, `external_ref_id`, `tenant`, `address_id`. Start here. |
| `vendor_deliveries` | The carrier-side record for a request. |
| `delivery_events` | Status changes and vendor events over time. Quote vendor text from here exactly. |

harbor keeps its own copy of the delivery status in `customer_deliveries`.
That table is SSFB data; if it disagrees with package, say so in the findings
so the SSFB investigator can check it.

## Queries

The deliveries for a customer:

```
sql_select { service: 'package', sql: "SELECT * FROM delivery_requests WHERE external_ref_id = $1", params: ['<customer_id>'] }
```

Then read `delivery_events` and `vendor_deliveries` for that request. Their
columns are not documented (unverified: the source lists the tables but not
their columns), so read one row first to find the column that points back at
the request, then filter on it with the request's id as the parameter.

## Admin API

Read-only, when the base URL is configured; otherwise `http_call` answers
"not configured for atspl:package" and that is a gap to record.

- `GET /api/v1/deliveries/<delivery_id>`
- `GET /api/v1/deliveries/user/<user_id>`

`POST /api/v1/deliveries/<delivery_id>/retry`, `.../sync-status` and the
vendor webhook are writes. Do not call them; recommend a retry in the report.
The manual re-trigger for a welcome letter is on harbor, not here.

## Logs

The registry key `package` maps to the API's log service. The two workers log
as `package-worker-sync` and `package-worker-queue`. Vendor sync failures are
likely to show in the worker logs rather than the API's (unverified: inferred
from the worker names).

```
logs_search { service: 'package', terms: ['<customer_id>'], level: 'error' }
```

## Known issues

- **Welcome letter not delivered, or overseas address not active.** Look up
  `delivery_requests` by `external_ref_id` = customer_id, then
  `delivery_events` for the vendor's last status. No row means harbor never
  created the delivery (an SSFB question: did the customer reach KYC-verified
  and was `WelcomeLetterDeliveryRequested` published). A row with a vendor
  failure is a carrier problem; quote the vendor text and count other
  customers with the same failure in the window. A `DELIVERED` row with an
  inactive address points at the harbor callback side.
