---
name: rtl-appserver
description: RTL app-server logs (the device id and app headers of each app request). Use when a RTL case needs the user's device, app version or the requests the app made. Logs only; a stub.
metadata:
  kind: service
  entity: rtl
  service: appserver
  status: stub
---

# appserver (RTL)

- Registry service: `appserver`. No repo, database or admin API is registered.
- Logs: `logs_search` with `service: "appserver"`. The log service name is
  `app-server-service`.
- Its lines carry the device id and app headers of each app request, so it is
  the place to find a user's device when no table links the two (unverified:
  field names not sampled).
