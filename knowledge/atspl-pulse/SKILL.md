---
name: atspl-pulse
description: The ATSPL pulse service, the staff ops/CX console that proxies harbor and rhythm admin APIs - what it owns, what it does not, and how to check it. Use when staff cannot view or action a KYC review, RFI, change request or onboarding queue item in the ops console.
metadata:
  kind: service
  entity: atspl
  service: pulse
  sources: atspl/pulse/AGENTS.md, atspl/NRI_ONBOARDING.md
  status: ported
---

# pulse (ATSPL)

Repo `pulse-backend`. A Java Spring Boot server-driven-UI back office for
Aspora staff, with maker-checker approval. For onboarding it is the admin
surface over harbor: it lists the onboarding queue, shows document
verifications, lets staff action KYC as maker and checker, raises RFIs and
change requests, and shows package delivery status. It acts on onboarding
after the fact, so it matters for ops triage, not for the customer journey.

## What it owns

- Every handoff is a synchronous HTTP proxy call into the harbor admin API or
  the rhythm admin API. Onboarding data is read live from harbor; pulse does
  not keep a copy.
- Its database holds no onboarding tables. Only an `iam` schema (staff users
  and permissions) is migrated.
- Audit history goes to MongoDB, which triage cannot read.
- Kafka is used only for the pulse audit log topic, and that consumer is
  currently disabled. pulse does not publish or consume account or product
  lifecycle events.

So pulse data rarely answers a customer question. The answer is usually in
harbor (SSFB).

## Checks

1. Say in the findings that harbor state should be checked first. If harbor
   already shows the action as done, or rejects it, the problem is not pulse.
2. Look for the proxy call failing in pulse's logs. The registry key `pulse`
   maps to the log service `pulse-backend`.

   ```
   logs_search { service: 'pulse', terms: ['<form_id>'], level: 'error' }
   ```

   ```
   logs_search { service: 'pulse', error: 'harbor', count: true }
   ```

   A count over the window tells a pulse-wide outage from one stuck item.
3. The `iam` schema answers staff permission questions only (a maker or
   checker who cannot see a button). Its table names are not documented
   (unverified: the source names the schema only), and catalog queries are
   refused, so if a permission question needs it, record the missing table
   names as a gap instead of guessing them.

The pulse admin API is reachable when configured; otherwise `http_call`
answers "not configured for atspl:pulse" and that is a gap to record.

## Known issues

- **Staff cannot action a KYC review or RFI in the console.** pulse proxies
  harbor admin, so check harbor state first, then pulse to harbor
  connectivity in pulse's error logs. Past tickets raised in pulse (for
  example internal review queues) are keyed by the harbor `form_id`.

## Deploy

The app folder is `pulse-backend/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.