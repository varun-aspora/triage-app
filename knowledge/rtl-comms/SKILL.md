---
name: rtl-comms
description: RTL comms service (SMS, email and push delivery through vendors). Use when a RTL user did not get an SMS, OTP, email or push notification. A stub, with the log name unverified.
metadata:
  kind: service
  entity: rtl
  service: comms
  sources: comms repo migrations, ssfb-comms, infrastructure-v2 database lists
  status: stub
---

# comms (RTL)

comms delivers communications to vendors: SMS, email and push notifications
from templates, with delivery tracking per communication. It is the same
codebase as `ssfb:comms`, so the ssfb-comms note describes the flow; the data
here is separate (unverified: the flow is taken from the SSFB copy).

- Registry service: `comms`, repo `comms-svc` (Go; the repo is now named `comms`).
- Database: `sql_select` with `service: "comms"`.
- Logs: `logs_search` with `service: "comms"`. The log service name is
  `comms-service` (unverified: taken from the deployment name). If a search returns nothing at all
  for a busy window, suspect the name before you conclude nothing happened.
- No admin API is known.

The same codebase also runs as `ssfb:comms` and `atspl:comms`, each with its own database.
This note covers the RTL copy only.

## Tables

From the repo's migrations (unverified: the deployed schema may differ):

| Table | Purpose |
|---|---|
| `communications` | One row per communication sent. |
| `communication_actions`, `communication_action_histories` | Delivery steps and their history per communication. |
| `templates`, `template_versions`, `campaign_templates` | Message templates and their versions. |
| `campaigns` | Campaign sends. |
| `vendors`, `vendor_channel_configs`, `tag_vendor_priorities` | Vendor setup and routing per channel. |
| `device_tokens` | Push notification tokens per device. |
| `events` | Events that trigger communications. |
| `recipient_overrides` | Per-recipient overrides for a template. |

Check which tables exist before you query:

```
sql_select {
  service: "comms",
  sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
}
```

Then list the columns of the one you pick:

```
sql_select {
  service: "comms",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["<table_name>"]
}
```
