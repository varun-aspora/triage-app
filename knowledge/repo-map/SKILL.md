---
name: repo-map
description: Which repo holds the code for each entity and service, its language and role, and which repos are shared libraries or deploy manifests rather than services. Use it to pick the repo for a code tool call, or to decide which second repo to search when a call crosses into a library.
metadata:
  kind: repo-map
  entity: shared
  sources: docs/survey/01-code-navigation.md, docs/02-hld-detailed.md, resources/ssfb.entity.json, resources/atspl.entity.json, resources/rtl.entity.json, resources/repos.json, shivalik/AGENTS.md, frontend/AGENTS.md
  status: written
---

# Repo map

Every code tool takes a `repo` from a fixed list. This note says which repo to
pick. A service key is written `entity:service` as in the registry, for example
`ssfb:harbor`. A repo name is only a repo name: there is no path, URL or module
path to pass.

## Service repos

| Repo | Entity | Registry services | Language | Role |
|---|---|---|---|---|
| `harbor` | ssfb | `ssfb:harbor` | Go | Account forms, CIF creation and the onboarding state machine for the CBS part of NRI onboarding. Also PAN dedupe, document checks, address lookup, notarisation and digital forms. |
| `rhythm` | ssfb | `ssfb:rhythm` | Go | Account creation in CBS, account statements and transactions. |
| `guardian` | ssfb | `ssfb:guardian` | Go | Device and SIM binding. |
| `comms-svc` | ssfb | `ssfb:comms` | Go | Customer communications (unverified: role taken from the service name only). The service key is `comms`, the repo is `comms-svc`. |
| `audit` | ssfb | `ssfb:audit` | Go | Audit event store. Logs and code only; no database key yet. |
| `bro` | ssfb | `ssfb:bro` | Go | Form STP checks and business rule evaluation. |
| `eventbus` | ssfb | `ssfb:eventbus` | Java (Gradle) | Delivers events to Kafka, HTTP and SQS destinations. No known database. |
| `pdf-generator` | ssfb | `ssfb:pdfgen` | Go | PDF rendering jobs. The service key is `pdfgen`. |
| `reminder-service` | ssfb | `ssfb:reminder` | Go | Reminders. The service key is `reminder`. |
| `cohort-service` | ssfb | `ssfb:cohort` | unknown | Cohort definitions and participations used by workflow templates (unverified: the old workspace never cloned this repo, so its language and layout are not known). |
| `workflow-op` | ssfb, rtl | `ssfb:workflow`, `rtl:workflow` | Java (Gradle), plus a React and TypeScript admin UI in its `frontend/` folder | The onboarding workflow engine and server-driven screen templates. One codebase, deployed twice: the Shivalik copy is `ssfb:workflow`, the RTL copy is `rtl:workflow`. The code is the same; the data is not. |
| `package-svc` | atspl | `atspl:package` | Go | Physical delivery of welcome letters and debit cards through courier vendors. |
| `pulse-backend` | atspl | `atspl:pulse` | Java (Gradle) | Back-office console for staff with maker-checker approval. It proxies the harbor and rhythm admin APIs, so for triage check harbor state first. |
| `banking-service` | rtl | `rtl:banking` | Go | The pre-CBS part of NRI onboarding (NRI, eVisa and survey modules). Harbor pulls the pre-CBS form data from it. |
| `kyc-service` | rtl | `rtl:kyc` | Java (Gradle) | System of record for Persona KYC inquiries and eVisa. |

`ssfb:finacle` is the core banking system itself. It has no repo.

eventbus, pdf-generator and reminder-service are also deployed on the RTL
cluster, but the RTL registry has no service key for them, so their RTL
copies are not reachable as services.

## Libraries, manifests and clients

These repos are not services. They have no service key, no database and no log
service of their own.

| Repo | Kind | Used by | Language | Notes |
|---|---|---|---|---|
| `shivalik-cbs-go` | library | harbor, rhythm | Go | The CBS client SDK. It is a library, not a deployed service: harbor and rhythm pin it as a versioned module, and harbor and rhythm may pin different versions. |
| `go-commons` | library | the Go services of all three entities | Go | Shared Go code. No deploy, no database. |
| `java-commons` | library | eventbus, kyc-service, pulse-backend, workflow-op | Java (Gradle) | Shared Java modules. No deploy, no database. |
| `prod-ssfb-aspora-argo` | deploy manifests | the Shivalik cluster | YAML (kustomize) | One folder per app, each with a base and an overlay. It answers "is this service deployed on Shivalik, and with what config". The database names and other environment values here are the real ones; the service repos mostly hold placeholders. It indexes as near-empty in the code graph, so search it with `repo_grep` and read it with `repo_read`. |
| `vance-android` | mobile client | all entities | Kotlin | Android app. See the frontend-routing skill for which backend a screen talks to. |
| `vance-ios` | mobile client | all entities | Swift | iOS app. See the frontend-routing skill. |

Only SSFB has a deploy manifests repo. There is none for ATSPL or RTL.

## Picking a repo

- Start from the service the evidence points at, and use the repo in the
  first table.
- A call into `shivalik-cbs-go`, `go-commons` or `java-commons` does not show
  up in the service repo's graph. Make a second call against the library repo.
- For `workflow-op`, the code is shared by `ssfb:workflow` and `rtl:workflow`.
  Say which copy the evidence came from; the repo cannot tell you.
- For "is it deployed and with what settings" on Shivalik, search
  `prod-ssfb-aspora-argo`, not the service repo.
- Some backends the mobile apps call (user-vault, appserver, canopy) are not in
  any registry and have no repo here.
