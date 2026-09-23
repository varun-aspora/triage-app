---
name: frontend-routing
description: How the mobile apps route an NRI onboarding screen to a backend, from screen_type to workflowOwner to the registry service that handles it. Use it when a customer is stuck on an onboarding screen, when a step will not advance, or when a client-side request shape or auth mode may be the cause.
metadata:
  kind: frontend-routing
  entity: shared
  sources: frontend/AGENTS.md, frontend/NRI_ONBOARDING.md, frontend/android/AGENTS.md, frontend/ios/AGENTS.md
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

## Hosts and auth, without names

- Part 1 goes to the Aspora app gateway, whose base comes from the country
  network config. The gateway routes each path prefix to its backend.
- Part 2 goes to the Shivalik bank host. The client appends a service segment
  (guardian, harbor, rhythm, workflow-op or canopy) to the base.
- Part 2 has two auth modes: an onboarding session token during onboarding and
  RFI, and a banking access token after onboarding.

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
- An older onboarding doc inside the Android repo describes a fixed linear
  flow. It is out of date; trust the server-driven model above.

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
