---
name: frontend-routing
description: Which backend each mobile app screen calls, for NRI onboarding (screen_type to workflowOwner to registry service) and for banking after onboarding (home and balances, transactions, statements, transfers, payees, limits, cards, fixed deposits, nominee, profile, MPIN and device relink, outward remittance, disputes). Use it to pick the entity and service for a report named by a screen or app feature, when a step will not advance, or when a client-side request shape, auth mode or cache may be the cause.
metadata:
  kind: frontend-routing
  entity: shared
  sources: frontend/AGENTS.md, frontend/NRI_ONBOARDING.md, frontend/android/AGENTS.md, frontend/ios/AGENTS.md, vance-android and vance-ios banking-sdk code (after onboarding)
  status: ported
---

# Frontend routing

The mobile apps (`vance-android`, `vance-ios`) are not backend triage surfaces.
They have no database and no log service. They matter when the issue is on the
client: a bad request shape, stale cached state, or a screen that does not
reflect a flow the backend already finished. Otherwise use this note to find
the backend a screen talks to, then look there.

Backends are written as `entity:service` registry keys. A backend with no
registry key says so.

## Onboarding is server-driven

There is no fixed step order in the client. Every onboarding step is a screen
the backend returns, told apart by its `screen_type` field. Each screen also
carries a `workflowOwner`, which is `ASPORA_RTL` or `SHIVALIK_BANK`. The client
sends every submit and go-back by `workflowOwner`, never by URL. Each submit or
go-back returns the next screen.

| `workflowOwner` | Part | Submit and go-back go to | Ends with screen |
|---|---|---|---|
| `ASPORA_RTL` | Part 1, before CBS | `rtl:workflow` (the RTL copy of workflow-op), through the Aspora app gateway | `nri_onboarding_completed` |
| `SHIVALIK_BANK` | Part 2, CBS | `ssfb:workflow` (the Shivalik copy of workflow-op), through the Shivalik bank host | `nri_onboarding_part2_completed` |

Part 1 also reaches `rtl:banking` and `rtl:kyc`. Part 2 also reaches
`ssfb:harbor`, `ssfb:guardian` and `ssfb:rhythm`.

The workflow user paths (`api/v1/workflow/user/submit`, `go-back`, `status`,
`poll`) are the same on both hosts. Only the host and the auth token differ.
Never infer the backend from the path alone: find the screen's
`workflowOwner` first.

## Screen to backend

"Submit" is where the step's submit and go-back land, set by the owner. "Data
calls" are the extra requests a step makes to render or check input.

| Step | `screen_type` | `workflowOwner` | Submit | Data calls |
|---|---|---|---|---|
| journey | `nri_journey_stepper` | `ASPORA_RTL` | `rtl:workflow` | none |
| user basics | `nri_onboarding_user_basics_page` | `ASPORA_RTL` | `rtl:workflow` | `rtl:banking`; email identity through user-vault (no registry key) |
| user details | `nri_onboarding_user_details_page` | `ASPORA_RTL` | `rtl:workflow` | none |
| PAN and name | `nri_onboarding_pan_details_page` | `SHIVALIK_BANK` | `ssfb:workflow` | `ssfb:harbor` PAN dedupe and document verification |
| address | `nri_onboarding_address_page` | `ASPORA_RTL` | `rtl:workflow` | `ssfb:harbor` address lookup |
| tax residency | `nri_tax_residency_page` | `ASPORA_RTL` | `rtl:workflow` | `rtl:banking` static config |
| nominee | `nri_onboarding_nominee_details_page` | `SHIVALIK_BANK` | `ssfb:workflow` | `ssfb:harbor` pin code and address lookup |
| Persona verification | `nri_v3_verification_sdk_page` | `ASPORA_RTL` | `rtl:workflow` (status poll) | Persona SDK; `rtl:kyc` holds the inquiry |
| Persona verification, older path | `nri_onboarding_verification_sdk_page` | `ASPORA_RTL` | `rtl:workflow` | same as above |
| Persona missing details | `nri_onboarding_persona_missing_details_page` | `ASPORA_RTL` | `rtl:workflow` | none |
| EFR (UAE KYC) | `nri_v3_efr_sdk_page` | `ASPORA_RTL` | `rtl:workflow` (status poll) | Lulu EFR SDK |
| EFR review | `efr_review_details` | `ASPORA_RTL` | `rtl:workflow` | none |
| eVisa | `nri_onboarding_evisa_page`, `nri_evisa_verification_page` | `ASPORA_RTL` | `rtl:workflow` | `rtl:kyc` visa endpoints, not Persona |
| notarisation | `nri_onboarding_notarization_page` | `SHIVALIK_BANK` | `ssfb:workflow` | `ssfb:harbor` notarisation order; NotaryLive in a browser tab |
| sign document | `nri_onboarding_sign_document_page` | `SHIVALIK_BANK` | `ssfb:workflow` | `ssfb:harbor` digital form; Zoho Sign in a browser tab |
| generic question | `nri_generic_question_page` | `ASPORA_RTL` | `rtl:workflow` | none |
| RFI document upload | `nri_onboarding_rfi_document_upload` and its completed variant | `SHIVALIK_BANK` | `ssfb:workflow` document upload | none |
| missing documents | `nri_onboarding_missing_document_page`, `nri_existing_documents_page` | `ASPORA_RTL` | `rtl:workflow` | none |
| account creation | a loader, then `nri_onboarding_part2_completed` | `SHIVALIK_BANK` | none; the client polls customer status | CBS customer status from `ssfb:harbor` and `ssfb:guardian` |

Screens around the main sequence:

- `review_details` is `SHIVALIK_BANK`. Field edits go to `ssfb:harbor`
  personal details.
- `nri_mpin_setup_screen` (MPIN setup) is `SHIVALIK_BANK`.
- Device binding is SIM binding in `ssfb:guardian`.
- Terms and conditions, account type selection, what you need, relationship
  manager and share existing details are `ASPORA_RTL`.
- The landing and comparison screens come before the workflow starts. The
  excitement survey and the drop-off sheet are sent to whichever owner is
  current.

Backends with no registry key, so they have no service note or repo here:

- user-vault (Aspora core): email identity verify and initiate.
- appserver (Aspora core): the older OTP resend.
- canopy: in-flow support chat. It is an ATSPL support surface, but the ATSPL
  registry has no `canopy` service.

Sumsub is present in the Android app but is not wired into NRI onboarding.

## After onboarding: banking screens

Every banking call goes to the Shivalik bank host with a service segment
(`/rhythm/`, `/harbor/`, `/guardian/`, `/workflow-op/`, `/canopy/`) and the
banking access token, unless the row says otherwise. Paths below are relative
to that segment, which helps when searching logs.

Most writes are guarded by MPIN or biometric. The client asks `ssfb:harbor`
for a challenge (`v1/customers/challenges/generate`, with a flow such as
`transaction`, `add_beneficiary`, `freeze_card`, `set_user_limit`,
`create_fd` or `break_fd`), signs it, and calls `ssfb:rhythm`, which verifies
the signature with `ssfb:harbor`. So a failed guarded write can sit in either
service: check the challenge in harbor before the action in rhythm.

| Feature | Endpoints | Backend |
|---|---|---|
| Banking tab entry (onboarded or not, device bound or not) | `api/v1/workflow/user/status` on both hosts | `rtl:workflow`, then `ssfb:workflow` |
| Login, token refresh, MPIN attempts after onboarding | `v1/customers/token/refresh`, `v1/customers/mpin/attempt-info`, `v1/customers/mpin/fail`, `global/config` | `ssfb:harbor` |
| Device or SIM relink (reinstall, new phone) | guardian `api/v1/auth/device/register`, then harbor `v1/auth/verification/status` polls; needs a data token from the Part 1 completed screen | `ssfb:guardian` and `ssfb:harbor`, with the token from `rtl:workflow` |
| Forgot MPIN, and the forced MPIN reset after a relink | `v1/recovery/mpin/forget/*` (no auth) | `ssfb:harbor` |
| Biometric enable, disable, re-enrol | `v1/customers/biometric/*` | `ssfb:harbor` |
| Account home, balances, activation checklist, welcome letter tracker | `v2/mobile/accounts/home` (Android falls back to v1), `v1/accounts/{id}/balance`, `v1/accounts/{id}/info`, `v1/mobile/accounts/details` | `ssfb:rhythm`; the checklist and welcome letter status come from `ssfb:harbor`, which reads delivery from `atspl:package` |
| Transactions list and detail | `v1/accounts/{id}/transactions[/{txn}]`, `v1/transactions/{tran_id}` | `ssfb:rhythm`; the ledger detail is CBS data (`ssfb:finacle`) |
| Statements: preview, PDF, email | `v1/accounts/{id}/statement/{metadata,preview,download}` | `ssfb:rhythm`, which uses `ssfb:pdfgen` and `ssfb:comms` for email |
| Transfers: IMPS, NEFT, RTGS, internal, NRE to NRO | draft `POST v2/accounts/{id}/transfers`, harbor challenge, `POST .../transfers/{txn}/initiate`, then polls `GET .../transfers/{txn}`; limits `v1/limits/transaction` | `ssfb:rhythm` and `ssfb:harbor` |
| Payees: list, add, delete, nickname | `v1/customers/beneficiaries[/{id}]`, `/external`, `/{id}/nickname`, `v1/mobile/recipients`; bank list and account search go to Aspora beneficiary-service | `ssfb:rhythm` and `ssfb:harbor`; beneficiary-service has no registry key |
| Bulk payee import from remittance | `v1/customers/beneficiaries/import/*` | `ssfb:rhythm` (it calls beneficiary-service) and `ssfb:harbor` for the confirm |
| Transaction and account limits | `GET/POST v1/limits` | `ssfb:rhythm` and `ssfb:harbor` |
| Debit card: issue, freeze, unfreeze, block, limits, view, set PIN | `v1/accounts/{id}/cards/*` | `ssfb:rhythm` and `ssfb:harbor`; card messages through `ssfb:comms` |
| Fixed deposits: home, list, detail, create, break, maturity instruction, rates | `v1/mobile/deposits/*`; create and closure are guarded | `ssfb:rhythm` (views use `ssfb:cohort`) and `ssfb:harbor` |
| Nominee add or edit after onboarding | `POST v1/customers/nominees/workflow` (rhythm), then workflow-op `api/v1/workflow/executions/{id}/{status,submit}`, harbor address lookups | `ssfb:rhythm`, `ssfb:workflow` and `ssfb:harbor` |
| Personal details, signature update | `v1/customers/personal-details`, `v1/customers/attributes/signature/*` | `ssfb:harbor` |
| Outward remittance from NRO, service requests | `v1/mobile/outward-remittance/*` (its challenge is issued by rhythm), `v1/mobile/service-requests` | `ssfb:rhythm`, which uses `atspl:pulse` and `ssfb:pdfgen` |
| Disputes | `v1/mobile/customer/dispute[/config]` | `ssfb:rhythm`, which publishes to `ssfb:eventbus`; the consumer (engage-service) has no registry key |
| Interest rates, schedule of charges, secure usage guidelines, UPI config | `v1/mobile/{interest-rates,schedule-of-charges,customer/secure-usage-guidelines,upi/config}` | `ssfb:rhythm` |
| Bank push notification registration | harbor `v1/device/register` | `ssfb:harbor` |
| Post-onboarding RFI | workflow `user/status`, `submit`, `go-back` with the banking token | `ssfb:workflow` and `ssfb:harbor` |
| Add money to NRE or NRO from abroad | Aspora appserver quote and beneficiary-service, then rhythm `v1/mobile/accounts/details` | Aspora core (no registry key) and `ssfb:rhythm` |
| NRI waitlist | `banking/v1/mobile/waitlist/nri-onboarding` through the Aspora app gateway | `rtl:banking` |

Account closure has no client code; a closure request did not come from the
app.

Unverified (the client calls these but no backend route was found): the
transfer OTP step (guardian `api/v1/auth/challenges/generate`, only shown if
`global/config` turns on `transaction_otp`), fixed deposit
`POST v1/mobile/deposits/{id}/identity`, and workflow
`api/v1/workflow/user/document/upload`.

## Hosts and auth, without names

- Part 1 goes to the Aspora app gateway, whose base comes from the country
  network config. The gateway routes each path prefix to its backend.
- Part 2 goes to the Shivalik bank host. The client appends a service segment
  (guardian, harbor, rhythm, workflow-op or canopy) to the base.
- Part 2 has two auth modes: an onboarding session token during onboarding and
  RFI, and a banking access token after onboarding.
- The bank gateway adds the customer id header from the banking token; the
  rhythm mobile endpoints rely on it.
- Banking screens that go through the Aspora app gateway (add money, payee
  bank search, waitlist) use the Aspora user token instead.

## Client code to read

- Android (`vance-android`, Kotlin): the modules that matter are `app`,
  `banking-sdk`, `data-layer`, `forex` and `analytics`. Routing lives in
  `WorkflowSubmitterImpl.kt`, `WorkflowOwner.kt`, `OnboardingScreenData.kt`
  and `NreNroOnboardingMoshiAdapters.kt`. Part 1 calls are in
  `AsporaRtlWorkflowService.kt`, `NreNroService.kt` and `VisaService.kt`. Part 2
  calls are in `ShivalikWorkflowApiService.kt` and `OnboardingApiService.kt`.
  Host selection is in `Environment.kt`, `NetworkModule.kt` and
  `ServiceProvider.kt`. The auth mode switch is in
  `ShivalikBankWorkflowRepositoryImpl.kt`.
- iOS (`vance-ios`, Swift and SwiftUI): the app target is `Aspora/` and local
  packages are under `Packages/`. The routing above was read from the Android
  code (unverified: iOS is assumed to follow the same server-driven screen
  contract; no iOS routing file has been checked).
- Android banking calls after onboarding live in `banking-sdk` under
  `com/aspora/banking/sdk/` (one `*ApiService.kt` per feature: account,
  transaction, beneficiary, card, fixed_deposit, statement, challenge,
  outward_remittance, dispute), with the screens under
  `app/.../ui/nre_nro_accounts/`. Auth modes are in `network/NetworkModule.kt`
  and `network/interceptors/`. iOS keeps the same paths in
  `Packages/BankingSDK/Sources/BankingSDK/Models/Network/Endpoints/`.
- An older onboarding doc inside the Android repo describes a fixed linear
  flow. It is out of date; trust the server-driven model above. Two transfer
  flow docs in the Android repo also name methods that no longer exist.

## Known issues

- **Step will not advance.** The same workflow path exists on both hosts. Find
  the `workflowOwner` of the stuck `screen_type`, then check `rtl:workflow`
  for `ASPORA_RTL` or `ssfb:workflow` for `SHIVALIK_BANK`.
- **401 or 403 on a Part 2 call.** Often the wrong auth mode: the onboarding
  session token used after onboarding, or the banking access token used
  mid-onboarding or during RFI.
- **Screen wrong or stuck, but the request succeeded.** The client only renders
  what the backend returned. The state is in the backend workflow execution,
  so go to the backend for that owner.
- **Completion markers.** `nri_onboarding_completed` means Part 1 is done.
  `nri_onboarding_part2_completed` means the CBS part is done.
- **"Session expired" or asked for MPIN again.** Once MPIN is set up, a 401 on
  a banking call does not refresh the token silently; the app asks for MPIN.
  A 401 on an onboarding call ends the onboarding session. Check the token
  refresh and MPIN attempt calls in `ssfb:harbor`.
- **Stale home or deposits screen on first open.** The first load may be
  served from a backend cache; pull to refresh fetches fresh data. A stale
  first screen alone is not a backend fault.
- **MPIN or OTP rules changed but the app still asks the old way.** The app
  caches the auth rules from `global/config` per customer until restart.
- **Transfer shows failed or unknown in the app.** The app polls the transfer
  and gives up after five errors in a row, so the app state can lag the real
  one. Read the transfer in `ssfb:rhythm` before trusting the screen.
- **Push notifications keep arriving after logout.** Android de-registers on
  a path harbor does not serve (`v1/notifications/remove-token`; harbor has
  `v1/device/remove-token`), and the bank gateway may not route the iOS path
  either (unverified at runtime).
- **Relink loops.** After a device relink the app forces an MPIN reset. A
  customer who "cannot log in after a new phone" is often mid-relink: check
  `ssfb:guardian` device registration, then the MPIN recovery calls in
  `ssfb:harbor`.
