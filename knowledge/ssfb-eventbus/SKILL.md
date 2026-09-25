---
name: ssfb-eventbus
description: SSFB eventbus, the Java service that fans platform events out to Kafka, external Kafka, HTTP webhooks and SQS. Use when one service emitted an event and another never saw it. Triage has its logs and code only.
metadata:
  kind: service
  entity: ssfb
  service: eventbus
  sources: shivalik/eventbus/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# eventbus (SSFB)

eventbus takes platform events and dispatches each one through a handler for
its destination type. It sits between services, so "service A emitted it but
service B never saw it" is an eventbus question.

- Registry service: `eventbus`, repo `eventbus`.
- Logs: `logs_search` with `service: "eventbus"`.
- No database is known for it on SSFB (unverified: the service uses JDBC, but
  no database name is set for the Shivalik deployment). No admin API is known.
  Triage can read its logs and its code only.

The same service also runs for RTL. This note covers the Shivalik copy only.

## Destination handlers

One handler per destination type, picked by `EventDestinationHandlerFactory`:

| Handler | Destination | Usual failure |
|---|---|---|
| `KafkaEventDestinationHandler` | internal Kafka topic | consumer lag or topic mismatch |
| `ExternalKafkaEventDestinationHandler` | external Kafka | consumer lag or topic mismatch |
| `HttpEventDestinationHandler` | HTTP webhook | a non-2xx response |
| `SqsEventDestinationHandler` | SQS queue | a permission error |

## Common checks

Find the destination type first, then search its handler's errors in the
window:

```
logs_search({ service: "eventbus", level: "error", terms: ["<event_type>"],
  from: "<from>", to: "<to>" })
```

The failure mode differs per handler, so name the destination type in the
finding. Confirm on the receiving service that the event never arrived before
blaming eventbus.

## Known issues

- **Event emitted but never consumed.** Identify the destination type, then
  look for Kafka lag or a topic mismatch, an HTTP non-2xx, or an SQS
  permission error in the eventbus logs.
- **Slow delivery under load.** The deployment scales on consumer lag, so
  check the scaling config in the deploy manifests repo named in your
  instructions before blaming throughput.

## Deploy

The app folder is `eventbus/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Its scaling on consumer lag
is set here. Check it when the question is what runs and with which settings,
and cite the file.