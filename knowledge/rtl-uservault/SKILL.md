---
name: rtl-uservault
description: RTL user-vault-service logs, which carry users' personal data. Use when a RTL case needs to confirm that a user's details were read or stored. Logs only; a stub.
metadata:
  kind: service
  entity: rtl
  service: uservault
  status: stub
---

# uservault (RTL)

- Registry service: `uservault`. No repo, database or admin API is registered.
- Logs: `logs_search` with `service: "uservault"`. The log service name is
  `user-vault-service`.
- Its lines carry phone, name and date of birth. Never quote them; cite the
  field name and the line's timestamp instead.
