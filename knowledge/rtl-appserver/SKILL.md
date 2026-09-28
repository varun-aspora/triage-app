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
- Its lines carry the device id (`x-device-id`) and app headers of each app
  request, so it is the place to find a user's device when no table links the
  two. Other field names are not sampled yet.

The device id, over a short window such as one day around the last app
activity:

```
logs_search { service: 'appserver', terms: ['<aspora_user_id>'], columns: ['x-device-id'], from: '<day_start>', to: '<day_end>' }
```

A device id is recorded for the run only from a search by a chain id, as
this one is; see `rtl-nri-onboarding` section 3.
