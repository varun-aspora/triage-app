# PAST TRIAGE CASES -> REQUEST TAXONOMY (refs/)

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## Scope and method
All paths below are relative to `/Users/varun/code/aspora/triage-shivalik/refs/`. There are 151 entries: 143 directories and 8 loose CSV/.numbers files. File counts: 118 `slack_thread.md`, 94 `findings.md`, 9 `investigation.md`, 7 `report.md`, 5 `notes.md`, 2 `triage_report.md`. I read about 35 cases in depth (thread plus notes) and ran grep-level stats over all of them. Nothing was executed and no network was touched. PII is masked below. Some directory names contain customer first names; I show those as `<name>`.

## 1. Proposed classification taxonomy (FACT-grounded counts by directory)
Counts come from my hand-bucketing of the directory list plus each thread's Summary line (INFERENCE where a case spans buckets). Total triage-type dirs is about 129; non-triage dirs are 14.

| # | Category | Sub-categories seen | Count | Entities / systems touched | Data sources | Typical difficulty |
|---|---|---|---|---|---|---|
| C1 | Onboarding: KYC docs, notary, AOF/e-sign, RFI/NSTP, CBS customer creation | notary won't connect/stuck (9), AOF/e-sign loop (4+1), PAN-passport/NSDL name mismatch (5), POA re-upload/RFI (3), manual review/NSTP stuck (3), RTL Part-1 stuck (2), CBS fuzzy-check/AML (2), misc (5) | ~34 | SSFB harbor, workflow_op_db, NotaryLive, CBS RetCustAdd; RTL kyc-service/workflow-op for Part-1 | harbor DB (account_forms, digital_forms, notary_orders, form_proofs, workflow_executions, rfi_requests_v3), Quickwit harbor, code (harbor) | Mostly multi-hop. Repeat patterns (PAN mismatch, AOF loop) are known-pattern matches |
| C2 | Auth: MPIN, session, token, device security | MPIN setup stuck (4), reset/forget fails or lockout (6), wrong-MPIN or challenge limiter (3), token/refresh or session timeout (3), jailbreak/RASP (1), passkey sig (1) | ~18 | harbor, guardian (passkeys, rate limits), vance-android/ios | harbor mpin_attempt_trackers, forget_mpin_attempts; guardian passkeys, device_auth_attempts; Quickwit; client code | Hard. Root cause is often a client bug or another stage (e.g. `mpin-setup-stuck-5b88ed04` = passport renewal; `mpin-processing-stuck-dc295f43` = address, then CIF) |
| C3 | Welcome letter / physical delivery / address / debit freeze | delivery failed (8), not triggered (2), wrong address (3), follow-up batches (2), final checks (1), address sync (1) | ~17 | SSFB harbor customer_deliveries plus ATSPL package-svc `package_db`, DocketHub/PSE vendor | harbor DB, ATSPL package_db (delivery_requests, vendor_deliveries, delivery_events), Quickwit | Usually a single lookup plus a vendor-wide scope check. Often ends in a write request (re-trigger) |
| C4 | Outward transfers (IMPS/NEFT/IFT) | reversal reason (5), stuck "Processing" / SUBMITTED (4), "something went wrong" / decoding error (3), disabled (1), false-failure copy (1), delay (2) | ~16 | rhythm, CBS/Finacle, NPCI (opaque) | rhythm transfer_transactions, beneficiaries; `GET /rhythm/admin/v1/accounts/<id>/transactions` (CBS statement); Quickwit rhythm | Medium. Two known rhythm bugs cover most cases |
| C5 | Inward funding / remittance / add money | credit not visible (2), wrong account credited (1), payment-gateway stuck (1), add-funds error (3), first-funding proof (1), balance not reflected (1) | ~9 | SSFB rhythm/CBS plus the non-Shivalik remittance backend (`POST /appserver/v3/order`) and RTL banking-service (UAE) | CBS statement, rhythm, Quickwit; upstream systems unmapped | Hard, because the answer lives in another entity (see §4) |
| C6 | Cards | debit card not visible or spinner (3), inactive (1), online payment (1), virtual issue failed (1), 3rd-party OTP (1) | 7 | rhythm, CBS savingaccount DebitInfo, DCMS | rhythm admin cards API, Quickwit CBS responses, client code | Medium to hard |
| C7 | Beneficiary | add/save fails (3), wrong-MPIN on add (1), cool-off (1), misdirected funds (1) | 6 | rhythm, beneficiary-service catalogue, RTL bulk import | rhythm DB, Quickwit, code | Hard. `beneficiary-misdirected-funds-56e2ccee` turned into real money reaching another customer |
| C8 | Account/balance view | accounts missing, blank bank details, stale balance, banner stuck | 5 | rhythm, CBS | rhythm API, Quickwit latency | Medium |
| C9 | UPI / third-party linking | OTP not received (3), link fail (2) | 5 | NPCI/PSP (outside Aspora) | account state only | Easy. The known answer is "not in Aspora's path, UK number / intl-UPI" |
| C10 | FD/TD | booking failed (2), FD created but invisible (1) | 3 | rhythm, CBS CreateFD | Quickwit rhythm, CBS ListFDsByCIF, code | Hard |
| C11 | Systemic / outage / bank escalation | CBS outage (`cbs-outage-2026-07-16`), blank IFSC cutover (`ifsc-missing-bank-escalation-20260917`), Zenduty alert (`harbor-cbs-fuzzycheck-zenduty-6849`), DocketHub GB outage (`welcome-letter-delivery-failed-b27629c3`) | 2 dedicated (+2 inside C1/C3) | CBS, vendor | Quickwit aggregations, cohort SQL | Hard, analytical, fleet-wide |

### Difficulty signals (FACT, grep counts across refs/*.md)
- 39 notes say the root cause matched an already-documented pattern ("known issue", "same pattern", "matches documented"). These are the candidates for a cheaper model plus a pattern KB.
- 14 dirs contain a correction of a first-pass conclusion. Examples: `beneficiary-wrong-mpin-p1788771204/report.md` ("Correction notice ... That conclusion is wrong"), `sim-verification-paused-a4817a03/findings.md` (two corrections, L104 and L190), `stale-balance-cache` (hypothesis REFUTED), and `eval-cases/2026-07-03-transfers-disabled.md` (verdict `partial`: a stale point-in-time DB read was reported as final).
- 61 cite code as `file.ext:line`, 124 query DBs, 28 call `GET /rhythm|/harbor` admin APIs, 34 run a systemic scope check (distinct-customer counts), 21 recommend a bank/Shivalik escalation, and 46 recommend a write action.

### Proposed routing tiers (INFERENCE from the above)
- **T1 cheap (single lookup or known answer):** C9 UPI; 3rd-party OTP (`blinkit-card-otp-not-received-76667a53`); freeze-status checks (`upi-otp-not-received-0d6928d5`, part 1 "already in debit freeze"); delivery status or bulk status (`dockethub-89-11-status-check-20260907`); timing-only inward credit (`transfer-not-in-horus-4d9c0016`, "timing, not a bug"); jailbreak/RASP; a repeat PAN mismatch (`pan-passport-name-mismatch-c521d169/triage_report.md` "third occurrence").
- **T2 mid (known pattern, multi-table confirmation):** rhythm SUBMITTED-stuck (`imps-neft-stuck-processing-p1789990708`), malformed-account reversal (`imps-reversal-<name>-p1788279171`), AOF/e-sign loop (`aof-notary-esign-loop-89801727`), token-refresh rate limit (`token-refresh-ratelimit-ec55534f`), DocketHub fast-reject.
- **T3 strong (novel, multi-hop, code reading, possibly cross-entity or systemic):** client-bug root causes (`mpin-lockout-a032b368`, `fd-booking-failed-p1789539001`, `debit-card-view-stuck-199fb32a`), non-idempotent CreateFD (`fd-not-created-901da461`), silent rejections (`beneficiary-wrong-mpin-p1788771204`), anything with money movement or misdirection, outages, and every C5 case.
- **Classifier caveat (FACT):** the Slack Summary and Tag are unreliable for classification. `transfer-not-in-horus-4d9c0016` is tagged Onboarding but is an inward SWIFT credit. `mpin-forget-guardian-ratelimit-769cd61c` has the summary "Unable to use debit card". `blinkit-card-otp-not-received-76667a53` has the summary "error while adding funds". `notarization-stuck-verify-docs-p1788429215` says "notarization" but the user was actually at RTL Part-1 Persona. `mpin-reset-pan-3c9c0a05` has the summary "Ask user to do the notary". The classifier should expect to be re-routed after the first data lookup.

## 2. What an incoming Slack thread contains
- **Channel (FACT):** 130 of 142 archive links point to `C0A9VPA17D5` (#nri-banking-cx). Others: `C0BG18KL411` (#ssfb-prod-dev-alerts, Zenduty), `C0A1ZPYQ1GD` (#banking-devs), `C0A7M05GPNE` (internal dogfooding), and 2 misc.
- **Bot template (FACT):** 60 threads carry "New CX Issue Raised" / "NRI Banking CX Queries". Fields: `Priority` (Urgent/High/Normal, sometimes emoji), `Alphadesk user ID`, `Horus Customer ID`, `Horus NSTP Application ID`, `Tag` (Onboarding / Transaction (Bank Transfer) / Transaction (Remittance Transfer) / Card / Account Details / Other / General Query), `Country` (UK 49, UAE 14 among those that tag it), `Raised by` (CX email), `Owner`, `Summary`, `Description`, and sometimes `VOC` (9) and a ClickUp link (11, older threads). Example: `mpin-lockout-a032b368/slack_thread.md` L5-20.
- **Older template (May–Jul, FACT):** a single `UserId:` field. It was sometimes actually the harbor customer_id (`esign-rfi-under-review-flip-p1783531662/slack_thread.md`: "turned out to be harbor.customer.customer_id, NOT external_user_ref"). It was once corrected by CX mid-thread (`renotarization-mpin-error-2458d148`). `preetha-action-approval-tray/investigation.md` has an "ID correction" section.
- **ID presence (FACT, first-match regex over 118 threads):** Horus Customer ID UUID present in 75; Alphadesk UUID in 22; both in 3; no customer UUID of any kind in 13. The 13 are mostly non-CX or free-form: Zenduty, bank audit, icon URL, Utrack, dogfooding. NSTP Application ID is filled in about 3 threads. form_id appears in 21 files, mostly written by the triager, not CX. Phone appears in about 23, mostly in screenshots or triager notes.
- **ID semantics (FACT, repeated in ~25 notes):** "Horus Customer ID" = `harbor.customer.customer_id` directly, NOT the Aspora userId (`account_forms.external_user_ref`). You go customer -> account_form_id -> account_forms to reach the userId. "Alphadesk user ID" is treated as the Aspora userId, but it can fail to resolve: `sim-verification-paused-a4817a03/findings.md` L6-15 found no harbor match for a returning-user device re-bind and correlated via device_id instead. "NSTP Application ID" = `account_forms.form_id` (`pan-nsdl-name-mismatch-poa-stuck-p1789576466`).
- **Screenshots (FACT):** 73 of 118 threads reference images. The key evidence is often only in the screenshot: exact error text ("No challenge required", "{failed_check_reason}", "Securely taking you to payment gateway"), device clock and platform. The triager transcribed images into markdown, and some notes say screenshots were "not downloaded".
- **Timestamps:** IST in threads. Device time in screenshots often differs from the ticket time (`add-funds-nre-identity-verification-76667a53/findings.md` L118-121).
- **Long, pivoting threads (FACT):** 38 contain "move(d) to tech". Many reopen with a new issue for the same customer (`debit-card-view-stuck-199fb32a`: 13 replies spanning address, delivery, then card; `welcome-letter-delivery-608663ff`: 44 replies; `upi-otp-not-received-0d6928d5`: freeze ask, then UPI). The system must work out what the current ask is (latest message), not just read the parent.

## 3. What a good final triage output looked like
The common `findings.md` structure (FACT, e.g. `imps-neft-stuck-processing-p1789990708/findings.md`, `mpin-lockout-a032b368/findings.md`, `fd-booking-failed-p1789539001/findings.md`):
1. Title with symptom and ref.
2. **ID chain** table: Horus customer_id -> form_id -> userId -> CIF -> NRE/NRO account_number/account_id -> device_id.
3. **Current state** (harbor state/sub_state, account status, freeze, balance), with the timestamp checked.
4. **What happened**: a UTC timeline table from Quickwit and DB, with raw log snippets and the queries used.
5. **Root cause**: code citation `file:line`, and whether it matches a known issue (it links `shivalik/<svc>/CLAUDE.md` sections).
6. **Scope**: one customer or systemic (distinct-customer count).
7. **Recommended actions**, split by audience: CX (what to tell the user, e.g. "stop retrying", "no money left the account", "don't reset MPIN"), Eng (client or backend fix), Ops/Bank (write action or bank escalation with UTR).
8. **Status** line (ROOT CAUSE CONFIRMED / RESOLVED / pending on user), plus dated "Update/re-check" appendices.

What CX needed (INFERENCE from the "Answer for CX" / "Recommendation for CX" sections):
- Is this a user action or a backend action?
- Is the money safe?
- Should the user retry?
- A copy-pasteable reply.
- Who to escalate to.

The Slack-post format is fixed by `.claude/skills/aspora-triage-slack-report/SKILL.md` L41-54: "*Triage Report* — ref", a reviewer tag with a validate disclaimer, TL;DR, 2–5 bullets, and Recommended actions. It requires a `redact.py --check` pass and explicit operator approval before posting (L58-73). Eval capture (`.claude/hooks/triage-eval-capture.sh` L100-128, instances in `eval-cases/`) records `input / investigation(root_cause, service, db_evidence, queries, code_evidence) / ground_truth(verdict correct|partial|wrong|pending, faster_path)`. That is reusable as the eval schema.

## 4. Multi-entity investigations and the hop
- **SSFB harbor -> ATSPL package-svc (package_db):** all welcome-letter cases. For example, `welcome-letter-delivery-608663ff/findings.md` L25-31 uses delivery_events/vendor_deliveries to get the real failure reason. `welcome-letter-delivery-failed-b27629c3/investigation.md` switched to package_db when the SSFB tunnel was down and found a vendor-wide outage (43/43 failed, 71 customers). `welcome-letter-delivered-debit-freeze-aff9bb71` goes package_db -> rhythm debit-unfreeze.
- **SSFB -> RTL (Part-1 onboarding: kyc-service, workflow-op, banking-service):** `confirm-details-not-clickable-f601f596/findings.md` L73-99 and `notarization-stuck-verify-docs-p1788429215/findings.md` L34-48. Both are dead ends: RTL london logs were not in `logs-v1`, and RTL DB env vars were placeholders. `add-funds-nre-identity-verification-76667a53/findings.md` L89-122 involves UAE add money via RTL banking-service or Lulu-KYC. `beneficiary-wrong-mpin-p1788771204/report.md` L172-194 has a possible race with `bulk_beneficiary_import_from_rtl`.
- **SSFB -> remittance backend (`/appserver/v3/order`, not mapped to any ecosystem):** `nre-nro-transfer-credit-mismatch-acd0c2df/findings.md` L35-41, `payment-gateway-txn-stuck-f726674c/findings.md` L25-33, and `account-under-review-remittance-processed-p1788241767`. All ended in "escalate, no visibility".
- **SSFB rhythm -> beneficiary-service catalogue (master_ifsc):** `beneficiary-misdirected-funds-56e2ccee/findings.md` L25-60.
- **SSFB -> Shivalik bank / NPCI (opaque):** IMPS reversal reason by UTR (`imps-reversal-<name>-p1788279171`), `ifsc-missing-bank-escalation-20260917`, PAN verify service (`pan-stage-stuck-fbdfc16c/findings.md` L64), and direct Finacle reads via `cbs_curl_via_eventbus.sh` (blocked by bastion/AWS in `imps-reversal-<name>-p1788462097/findings.md` L35 and `account-balance-not-visible-28b90d99/report.md` L38).
- **Hop trigger (INFERENCE):** the hop happens when SSFB state is clean ("Shivalik side is clean") or when the object's source of truth lives elsewhere (delivery, pre-CBS onboarding, remittance order).

## 5. Non-triage content in refs/
- **Bulk ops / data fixes (writes):** `dockethub-89-11-status-check-20260907/update_queries*.sql`; `pse-yodel-ref-remap/fix_refs.sql` (package_db UPDATE in BEGIN/COMMIT); `utrack-carrier-service-code/` (config change plus one real prod delivery run, runbook/plan). **Recommendation: do not support** in the triage agent beyond read-only status checks. Writes should be at most "proposed" artefacts.
- **Cohort/status reports:** `dockethub-89-11-status-check-20260907/notes.md` (100-customer status) and `welcome-letter-delivery-followup-*`. These are read-only bulk lookups and could be supported as a "batch status" mode (T1).
- **Analytics/classification studies:** `harbor-error-classification/` (taxonomy.json with category/subsystem/count per error signature, plus scripts), `fd-td-issues-30d-2026-07-21/classification.md` (FD-<AREA>-NN buckets from Quickwit), `rtl-form-download-sim-binding/*.csv` (cause/daily failures), `pan-passport-fuzzy/`. These are useful seed data for a known-pattern KB, but they are not a triage request type.
- **BRO rules-engine dry runs:** `bro-dry-run/REPORT.md` (2506 forms; inverted CEL rule makes 91.8% hard-stop), `bro-dry-run-v2/` (924 forms scored against outcomes), `bro-config-export/`, `bro-stage-db-migration/` (stage seeding via safe_sql). These are product/engineering analysis. **Drop** from triage scope.
- **Bank/compliance data pulls:** `bank-audit-sim-sms-report-2026-08-18` (unmasked MSISDN export to the bank). Drop or keep human-only.
- **Non-banking dev asks:** `nri-landing-icon-url-2026-08-26` (S3 icon). Drop.
- **Incident analyses:** `cbs-outage-2026-07-16/` (impact list, `recovery_app.py`, intended API per user; the recovery check overloaded Quickwit, per `RECOVERY-CHECK-README.md` L7-27). Could be an "incident impact" mode later. It needs rate limits on Quickwit.
- **Loose PII CSVs** at refs root (`in-progress-dockethub-89.csv`, `*-contact-details.csv`, `RFI-experiment-customer-list.csv` with 587 rows of phone/account/customer ids, `items_status_report_100_customers_7.*`). These are exports, not triage.

## Risks worth carrying into design
- refs notes contain unredacted names, phones, PANs and addresses, despite `aspora-triage/SKILL.md` L108-130 rules.
- Point-in-time DB reads got reported as final (eval partial verdict).
- Quickwit has a single-CPU instance, and aggressive fan-out took it down.
- Several recommended fixes need admin POSTs: `trigger-delivery`, `sync-address`, `trigger-customer-creation`, `debit-unfreeze`, `/admin/v1/digital-forms/force-sign` (dead code). These are allowlist candidates.

## Key facts

- refs/ has 151 entries (143 dirs + 8 loose CSV/.numbers); 118 slack_thread.md, 94 findings.md, 9 investigation.md, 7 report.md, 5 notes.md, 2 triage_report.md (find over refs/*/)
- 130 of 142 Slack archive links point to C0A9VPA17D5 (#nri-banking-cx); others: C0BG18KL411 Zenduty alerts, C0A1ZPYQ1GD #banking-devs, C0A7M05GPNE dogfooding (grep refs/*/*.md)
- Bot template fields: Priority, Alphadesk user ID, Horus Customer ID, Horus NSTP Application ID, Tag, Country, Raised by, Owner, Summary, Description (+VOC, ClickUp) (e.g. refs/mpin-lockout-a032b368/slack_thread.md L5-20)
- Horus Customer ID UUID present in 75/118 threads, Alphadesk UUID in 22, NSTP App ID in ~3, no customer UUID at all in 13 (regex over refs/*/slack_thread.md)
- 'Horus Customer ID' = harbor customer.customer_id, not the Aspora userId; the chain to the userId is customer.account_form_id -> account_forms.external_user_ref (repeated in ~25 notes, e.g. refs/aof-signing-mpin-stuck-458c083b/findings.md)
- The older template's 'UserId' field was sometimes actually the harbor customer_id (refs/esign-rfi-under-review-flip-p1783531662/slack_thread.md; refs/preetha-action-approval-tray/investigation.md 'ID correction')
- An Alphadesk user ID can fail to resolve in harbor for returning-user device re-binds; correlated via device_id instead (refs/sim-verification-paused-a4817a03/findings.md L6-15)
- 73/118 threads reference screenshots; the exact error text is often only in the image (refs/add-funds-phone-check-template-bug-1788659404/findings.md)
- 39 notes explicitly match an already-documented known pattern; 14 dirs contain corrections of first-pass conclusions (grep refs/*/*.md)
- 61 notes cite code file:line, 124 query DBs, 34 do a systemic distinct-customer scope check, 46 recommend a write action (grep refs/*/*.md)
- Largest categories: onboarding (notary/AOF/PAN/RFI) ~34, MPIN/auth ~18, welcome-letter/delivery ~17, outward transfers ~16, inward funding ~9 (hand-bucketed from dir list)
- Welcome-letter cases always hop SSFB harbor -> ATSPL package_db (refs/welcome-letter-delivery-608663ff/findings.md L25-31; refs/welcome-letter-delivery-failed-b27629c3/investigation.md)
- RTL Part-1 onboarding was invisible from Shivalik Quickwit logs-v1 and RTL DB env vars were placeholders (refs/confirm-details-not-clickable-f601f596/findings.md L73-99; refs/notarization-stuck-verify-docs-p1788429215/findings.md L34-36)
- Remittance order backend POST /appserver/v3/order is not mapped to any ecosystem; cases ended in escalation (refs/nre-nro-transfer-credit-mismatch-acd0c2df/findings.md L37; refs/payment-gateway-txn-stuck-f726674c/findings.md L25-33)
- Slack posting format: TL;DR + bullets + Recommended actions, reviewer tag, redact.py --check, operator approval required (.claude/skills/aspora-triage-slack-report/SKILL.md L41-73)
- Eval case schema: input/investigation/ground_truth with verdict correct|partial|wrong|pending and faster_path (.claude/hooks/triage-eval-capture.sh L100-128; refs/eval-cases/*.md)
- Tag/Summary misclassify often: transfer-not-in-horus-4d9c0016 is tagged Onboarding but is an inward SWIFT credit; mpin-forget-guardian-ratelimit-769cd61c has the summary 'Unable to use debit card'
- The Quickwit instance is 1 CPU and was knocked over by 10 concurrent workers during outage recovery analysis (refs/cbs-outage-2026-07-16/RECOVERY-CHECK-README.md L7-27)
- Write actions were actually executed in some cases: sync-address + trigger-customer-creation (refs/mpin-processing-stuck-dc295f43/investigation.md L59-62); a package_db UPDATE (refs/pse-yodel-ref-remap/fix_refs.sql)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `/Users/varun/code/aspora/triage-shivalik/refs/eval-cases/` | 4 labelled eval cases with input/investigation/ground_truth front-matter | port: seed eval set; schema maps directly to an eval harness |
| `/Users/varun/code/aspora/triage-shivalik/refs/*/slack_thread.md + findings.md` | ~118 real threads with the triager's final findings | port: redact, then convert into eval cases and classifier training/few-shot examples |
| `/Users/varun/code/aspora/triage-shivalik/refs/harbor-error-classification/taxonomy.json` | harbor error signature -> category/subsystem/count/confidence | port: seed for a known-pattern KB used by cheap-tier routing |
| `/Users/varun/code/aspora/triage-shivalik/refs/fd-td-issues-30d-2026-07-21/classification.md` | FD-<AREA>-NN failure buckets with the Quickwit query tokens per bucket | port: FD sub-category taxonomy + query recipes |
| `/Users/varun/code/aspora/triage-shivalik/.claude/skills/aspora-triage-slack-report/SKILL.md` | Slack reply format + redaction gate + operator-approval flow | port: output-channel formatter and human-in-the-loop gate for the Slack/claude-code output |
| `/Users/varun/code/aspora/triage-shivalik/.claude/hooks/triage-eval-capture.sh` | post-triage eval capture questionnaire and front-matter template | port: turn into a post-run feedback step in the new system |
| `/Users/varun/code/aspora/triage-shivalik/refs/bro-dry-run*, bro-config-export, bro-stage-db-migration` | BRO rules-engine dry runs and stage DB seeding | drop: product analysis, not triage |
| `/Users/varun/code/aspora/triage-shivalik/refs/pse-yodel-ref-remap, dockethub-89-11-status-check-20260907/update_queries*.sql, utrack-carrier-service-code` | data-fix SQL and prod config/run runbooks | drop: write operations, out of scope for a read-only triage agent |
| `/Users/varun/code/aspora/triage-shivalik/refs/*.csv (root)` | PII exports (contact details, RFI customer list, DocketHub batches) | drop: raw PII exports, not triage inputs |

## Unknowns

- Is 'Alphadesk user ID' always the Aspora userId (account_forms.external_user_ref)? Some cases resolved it that way; sim-verification-paused-a4817a03 could not resolve it at all.
- Should the new system support batch/cohort requests (e.g. the 100-customer DocketHub status check) and incident impact analysis (cbs-outage-2026-07-16), or only single-customer triage?
- Which backend and entity owns POST /appserver/v3/order (the remittance/funding order flow), and will its logs/DB be exposed to the agent?
- Now that Quickwit is deployed in RTL and ATSPL too, are they separate endpoints/indexes per entity, and do they carry RTL london Part-1 (kyc-service, workflow-op) traffic?
- Should write actions that recur in recommendations (trigger-delivery, sync-address, trigger-customer-creation, debit-unfreeze) go into resources/{entity}.allow.api.json, or stay human-only?
- Do any past cases involve stage environments? None were seen in the sampled triage cases; bro-stage-db-migration is the only stage artifact.
- Should screenshot OCR/vision be in scope? 73/118 threads rely on images, and the current notes contain hand-transcribed image content.
- What is the ground-truth label for difficulty? Only 4 eval cases carry a verdict; cost/latency of past triages is not recorded.

## Contradictions

- aspora-triage-slack-report/SKILL.md says the report is 'usually notes.md', but refs/ has 94 findings.md vs 5 notes.md (plus report.md, investigation.md, triage_report.md)
- add-funds-nre-identity-verification-76667a53/findings.md L89 says RTL workflow-op is 'also indexed in this Quickwit', while confirm-details-not-clickable-f601f596/findings.md L73-85 says logs-v1 does not carry RTL london Part-1 traffic; the user brief says Quickwit is now in all entities
- aspora-triage/SKILL.md L108-130 says everything under refs/ must be PII-redacted, but many slack_thread.md/findings.md contain full names, phone numbers, PANs and addresses, and root CSVs hold contact details
- The workspace is framed as read-only triage, but some cases record executed writes: sync-address + trigger-customer-creation in mpin-processing-stuck-dc295f43/investigation.md L59-62, the package_db UPDATE in pse-yodel-ref-remap/fix_refs.sql, and a real prod delivery run planned in utrack-carrier-service-code/plan.md
- Slack Tag/Summary often contradicts the real category (transfer-not-in-horus-4d9c0016 tagged Onboarding; notarization-stuck-verify-docs-p1788429215 was actually RTL Persona, not notary; mpin-reset-pan-3c9c0a05 summary says notary)
- The old template field 'UserId' sometimes held the harbor customer_id rather than the Aspora userId (esign-rfi-under-review-flip-p1783531662/slack_thread.md), which conflicts with its label
