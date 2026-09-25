---
name: ssfb-audit
description: SSFB audit service, the platform audit trail that stores events emitted by other services. Use when a case needs an entity's history or asks why an event is missing from the audit trail. Triage has its logs and code only.
metadata:
  kind: service
  entity: ssfb
  service: audit
  sources: shivalik/audit/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# audit (SSFB)

audit is the platform audit trail. A Kafka consumer inside the service takes
audit payloads emitted by other services and writes them to an append-only
event store partitioned by `occurred_at`. It serves read-only timeline
queries.

- Registry service: `audit`, repo `audit`.
- Logs: `logs_search` with `service: "audit"` (the log service name is
  `audit-svc`).
- The registry has no database or API key for audit, so triage cannot read
  the store. Its logs and its code are all there is.

## Tables

Known from the code; triage cannot query them.

| Table | Purpose |
|---|---|
| `events` | The append-only event store, partitioned by range on `occurred_at`. Inserts ignore conflicts, so redeliveries are safe. |
| `events_default` | The catch-all partition. Rows here mean no partition existed for that `occurred_at`. |
| `domains` | The domains allowed to emit audit events. |

## Common checks

Look for ingest errors in the window:

```
logs_search({ service: "audit", level: "error", from: "<from>", to: "<to>" })
```

## Known issues

- **No history for this entity.** The store is not readable, so say that and
  record it as a gap. A missing partition (rows in `events_default`) or an
  unregistered domain are the usual causes in the code, which is a
  code_walker question at most.

## Deploy

The app folder is `audit/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.