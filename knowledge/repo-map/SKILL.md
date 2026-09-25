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
| `comms-svc` | ssfb, atspl, rtl | `ssfb:comms`, `atspl:comms`, `rtl:comms` | Go | SMS, email and push delivery through vendors, from templates. One codebase, deployed once per entity, each with its own data. The service key is `comms`, the repo is `comms-svc` (now named `comms`). |
| `audit` | ssfb | `ssfb:audit` | Go | Audit event store. Logs and code only; no database key yet. |
| `bro` | ssfb | `ssfb:bro` | Go | Form STP checks and business rule evaluation. |
| `eventbus` | ssfb | `ssfb:eventbus` | Java (Gradle) | Delivers events to Kafka, HTTP and SQS destinations. No known database. |
| `pdf-generator` | ssfb | `ssfb:pdfgen` | Go | PDF rendering jobs. The service key is `pdfgen`. |
| `reminder-service` | ssfb | `ssfb:reminder` | Go | Reminders. The service key is `reminder`. |
| `cohort-service` | ssfb, rtl | `ssfb:cohort`, `rtl:cohort` | Go | Cohort definitions and participations used by workflow templates, and composite cohorts that rank surfaces. On RTL the same repo also deploys `cohort-evaluator-service`. |
| `workflow-op` | ssfb, rtl | `ssfb:workflow`, `rtl:workflow` | Java (Gradle), plus a React and TypeScript admin UI in its `frontend/` folder | The onboarding workflow engine and server-driven screen templates. One codebase, deployed twice: the Shivalik copy is `ssfb:workflow`, the RTL copy is `rtl:workflow`. The code is the same; the data is not. |
| `package-svc` | atspl | `atspl:package` | Go | Physical delivery of welcome letters and debit cards through courier vendors. |
| `pulse-backend` | atspl | `atspl:pulse` | Java (Gradle) | Back-office console for staff with maker-checker approval. It proxies the harbor and rhythm admin APIs, so for triage check harbor state first. |
| `canopy` | atspl, rtl | `atspl:canopy`, `rtl:canopy` | Java | Support touchpoints: support chat, in-app FAQs, consent decisions and cross-sell. Deployed for ATSPL and RTL, each with its own data. |
| `engage` | atspl | `atspl:engage` | Go | Callback requests, survey responses and the user waitlist. Has a Kafka consumer. |
| `banking-service` | rtl | `rtl:banking` | Go | The pre-CBS part of NRI onboarding (NRI, eVisa and survey modules). Harbor pulls the pre-CBS form data from it. |
| `kyc-service` | rtl | `rtl:kyc` | Java (Gradle) | System of record for Persona KYC inquiries and eVisa. |
| `munin` | rtl | none | Java (Gradle) | Ingests a user's inbound email from consented channels (Google OAuth), stores each raw message as an `.eml` in S3 with one index row, and hands it to the downstream identity leg. An API server and a worker. No registry service, so code only. |
| `x-ray` | rtl | none | TypeScript (Flue) | The Munin identity-leg agent. A run API (`POST /v1/runs`) that turns the messages Munin fetched into one validated identity record per leg; passport is the first leg. No registry service, so code only. |

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
| `prod-ssfb-aspora-argo` | deploy manifests | ssfb | YAML (kustomize) | One app folder per service at the root, each with `base/` and `overlay/` (per-region folders, a `common` folder and `infra`). The database names and other environment values here are the real ones; the service repos mostly hold placeholders. |
| `non-prod-aspora-argo` | deploy manifests | ssfb | YAML (kustomize) | App folders at the root for SSFB and ATSPL services side by side, plus apps with no registry service. `overlay/` has `infra` and `application` (per-region folders and `common`); some apps also have `ephemeral/`. |
| `prod-envoy-services-aspora-argo` | deploy manifests | atspl | YAML (kustomize) | App folders at the root, laid out as in `prod-ssfb-aspora-argo`. Its default branch is `stage-env`; `main` is old. |
| `stage-atspl-aspora-argo` | deploy manifests | atspl | YAML (kustomize) | Two cluster folders at the root, one for the ATSPL backend cluster and one for the Shivalik cluster, each with app folders inside. |
| `k8s-manifests` | deploy manifests | rtl | YAML | One repo for every RTL environment, split into one folder per environment and region under `environments/vance-core/`. Layout inside not surveyed. |
| `vance-android` | mobile client | all entities | Kotlin | Android app. See the frontend-routing skill for which backend a screen talks to. |
| `vance-ios` | mobile client | all entities | Swift | iOS app. See the frontend-routing skill. |

Every manifests repo is checked out, but only one repo and folder per entity
describes the deployment this run belongs to. Your instructions name it in a
"Deploy manifests for <entity>" line. Read deploys and config from that repo
and folder only; the others describe a different environment. When the line
says not configured, record a gap instead of reading another manifests repo.
The manifests repos index as near-empty in the code graph, so search them with
`repo_grep` and read them with `repo_read`. They show what is declared, which
the cluster may not have applied yet, so cite the file you read.

Inside that folder the app folder is named after the deployment, not the repo:

| Service repo | App folder |
|---|---|
| `harbor`, `rhythm`, `guardian`, `bro`, `audit`, `eventbus`, `workflow-op`, `pdf-generator`, `canopy`, `engage`, `pulse-backend` | same as the repo |
| `comms-svc` | `comms` |
| `cohort-service` | `cohort` (in the ATSPL backend cluster folder: `cohort-service`) |
| `reminder-service` | `reminder` |
| `package-svc` | `package` |

RTL app folders are not surveyed yet; list the folder first.

## Picking a repo

- Start from the service the evidence points at, and use the repo in the
  first table.
- A call into `shivalik-cbs-go`, `go-commons` or `java-commons` does not show
  up in the service repo's graph. Make a second call against the library repo.
- For `workflow-op`, the code is shared by `ssfb:workflow` and `rtl:workflow`.
  Say which copy the evidence came from; the repo cannot tell you.
- For "is it deployed and with what settings", search the deploy manifests
  repo and folder your instructions name for that entity, not the service
  repo.
- Some backends the mobile apps call (user-vault, appserver, canopy) are not in
  any registry and have no repo here.
