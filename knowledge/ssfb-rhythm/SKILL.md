---
name: ssfb-rhythm
description: SSFB rhythm service note. NRE/NRO account creation and the account mapping, transfers (IMPS, NEFT, RTGS, internal), limits, beneficiaries, cards and statements. Tables, the transfer lifecycle, symptom-to-first-check rows and known issues as sql_select, http_call, logs_search, get_account_statement and detect_silent_reversals calls. Use it for any SSFB account, transfer, reversal, limit, card or UPI question.
metadata:
  kind: service
  entity: ssfb
  service: rhythm
  sources: shivalik/rhythm/AGENTS.md, shivalik/NRI_ONBOARDING.md, shivalik/AGENTS.md
  status: ported
---

# rhythm (SSFB)

rhythm sits between the Aspora app, harbor and Finacle for the account side:
NRE/NRO account creation, transfers (inward and outward), term deposits,
limits, beneficiaries, cards and statements. For accounts it is stateless
orchestration: it keeps a local mirror of which accounts a customer has, and
the accounts themselves live in CBS.

- Tool service key: `rhythm` (database, admin API and logs).
- Log service: `rhythm`. Search by `account_number` rather than UUIDs; it
  appears reliably in CBS call logs.
- Code: repo `rhythm`; the CBS client is the `shivalik-cbs-go` library.
- Admin APIs take `account_id` (the rhythm UUID), not the CBS
  `account_number`.

## x-customer-id on admin calls

`http_call` sets `x-customer-id` from the id chain; the model never passes it.
The old notes said the admin endpoints scope or reject requests by this
header, while the rhythm router registers the `adminV1` group with no auth
middleware. Whether the header is checked is not known (unverified: the
handlers were not read). Do not treat a successful call without it as proof
either way.

## Tables

| Table | What to look at |
|---|---|
| `customer_account_mappings` | The account table for onboarding. `account_id` (rhythm UUID), `account_number` (CBS), `customer_id` (harbor customer id, varchar), `account_type` (NRE or NRO), `classification` (SBA), `ifsc`, `scheme_code`, `created_at`. |
| `transfer_transactions` | One row per transfer: `txn_ref_id`, `account_id`, `status`, `initiated_at`, `bank_identifier` (the UTR), `failure_reason`, `cbs_response`, `created_at`. |
| `user_limit_transaction_settings` | Per-customer limits by `type`: `enabled`, `updated_at`, `version`. |
| `beneficiaries` | Saved payees per customer: `unique_id`, `details`. `verified` defaults to true and means nothing. |
| `customer_nominees` | Nominees per customer: `customer_id` (harbor customer id). `name`, `nick_name`, `relationship`, `dob`, `address` and `guardian_details` are encrypted with rhythm's own key: read them with `decrypt_fields({ service: "rhythm", values: [...] })`. |

`sync_state`, `reconciliation_reports` and `cdc_events` are disabled
scaffolding with no rows, so an empty result there says nothing (basis: the
onboarding notes; the rhythm note listed two of them as key tables without
checking them). The first may be named `sync_states` (unverified: the sources
spell it both ways).

## Queries

Accounts for a harbor customer:

```
sql_select({ service: "rhythm",
  sql: "SELECT account_id, account_number, account_type, classification, scheme_code, created_at FROM customer_account_mappings WHERE customer_id = $1 ORDER BY created_at DESC",
  params: ["<customer_id>"] })
```

Recent transfers on an account:

```
sql_select({ service: "rhythm",
  sql: "SELECT txn_ref_id, status, initiated_at, bank_identifier, failure_reason FROM transfer_transactions WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20",
  params: ["<account_id>"] })
```

Limits and the transfer switch:

```
sql_select({ service: "rhythm",
  sql: "SELECT type, enabled, updated_at, version FROM user_limit_transaction_settings WHERE customer_id = $1",
  params: ["<customer_id>"] })
```

Account health (status, debit allowed, flags) and cards, live from CBS:

```
http_call({ service: "rhythm", path: "/admin/v1/accounts/<account_id>" })
http_call({ service: "rhythm", path: "/admin/v1/cards/customer/<customer_id>" })
```

Statement (debits, credits, reversals) and the DB-vs-statement join:

```
get_account_statement({ account_id: "<account_id>", from: "<from>", to: "<to>" })
detect_silent_reversals({ account_id: "<account_id>", customer_id: "<customer_id>", since: "<from>" })
```

`get_account_statement` wraps the admin statement endpoint
(`/admin/v1/accounts/<account_id>/transactions`) and normalises its response.
`detect_silent_reversals` joins `transfer_transactions` with that statement and
flags `REVERSED`, `NO_UTR` and rows found on one side only.

## Account creation

After harbor creates the CIF and the customer reaches `AML_VERIFIED`, harbor
calls rhythm's account orchestration endpoint
(`POST /admin/v1/orchestration/accounts`). rhythm then:

```
creates the NRE and NRO accounts in Finacle
  -> writes customer_account_mappings (account_id, account_number, customer_id)
  -> adds a default nominee and a virtual card
  -> publishes a self-beneficiary event for the NRE and NRO pair
```

An account that does not show in the app: look for the mapping row by
`customer_id` and `account_number`. No row means the CBS account create or
the mapping insert failed; check rhythm logs for the customer in the window
after the customer reached `AML_VERIFIED`.

## Transfer lifecycle

```
initiated        transfer_transactions row; initiated_at is time.Now() in UTC
CBS payment      ActionCode "000" -> rhythm marks the transfer successful
status inquiry   async; only backfills bank_identifier (the UTR); never reverses
reversal         visible only in the CBS statement, never written back to the row
```

The sources name the success status both `COMPLETED` and `SUCCESS`. Treat
either as "rhythm thinks it succeeded" (unverified: the status value rhythm
writes was not checked in code). A successful row with no `bank_identifier`
means rhythm never learned the real outcome, not that rhythm reversed it.

## Symptom to first check

| Symptom | First check |
|---|---|
| Transfer reversed "without any reason" | `detect_silent_reversals` for the account; the statement shows the reversal, the row does not |
| Transfer shows no UTR | `transfer_transactions.bank_identifier`; the time of day (Known issues, the UTC/IST bug) |
| Outward transfer failed, DB row has no reason | rhythm logs by `txn_ref_id`; the reason is only in the `error` field |
| "Transfers disabled" on the amount field | `user_limit_transaction_settings` row of type `transfer` |
| Limit reached though amounts look small | `user_limit_transaction_settings`; CBS may enforce limits differently from the local row |
| Account missing in the app | `customer_account_mappings` by `customer_id` (Account creation above) |
| Card shows inactive | `/admin/v1/cards/customer/<customer_id>`, then sample another customer before concluding |
| Debit card screen errors | rhythm logs for "Api ended with Error" on the cards path |
| UPI PIN or Paytm linking fails | account health via `/admin/v1/accounts/<account_id>`, then a bank ticket |

Endpoints that change state (for example the account orchestration call above,
and `POST /v1/limits`, which only the user can make behind an MPIN challenge)
are refused by `http_call`. Never try to call them.

## Known issues

### UTC/IST date bug breaks IMPS, NEFT and RTGS confirmation (00:00 to 05:30 IST)

Symptom: an external-rail transfer is reversed or never confirmed, while CBS
accepted the payment (`ActionCode` "000"). The status-check logs show "Transaction
doesn't exist." and then "bank_identifier still empty after max retries,
dropping", so no UTR is ever recorded.

Cause: `transaction_service.go:911` builds the inquiry `TranDate` from
`InitiatedAt`, which is UTC, without converting to IST. Finacle books under
the IST date, so a transfer started between 00:00 and 05:30 IST (18:30 to
00:00 UTC the day before) is queried one day behind and the inquiry misses.
Tell: the payment `ErrorDesc1` carries the IST date and the inquiry `tran_date`
the UTC date, one day apart. The amount and the limits are unrelated.

```
logs_search({ service: "rhythm", terms: ["bank_identifier", "empty", "retries", "dropping"],
  from: "<from>", to: "<to>" })
logs_search({ service: "rhythm", terms: ["<account_number>", "bank_identifier"],
  from: "<from>", to: "<to>" })
```

Confirm: every dropped event falls between 00:00 and 05:30 IST and spans many
customers. It is systemic, not specific to one user.

### IMPS debited then reversed: invalid beneficiary account number

Symptom: the app shows the transfer succeeded, the money leaves and comes back
one to three minutes later with no reason shown.

`transfer_transactions` says the transfer succeeded and is wrong. CBS payment
returns `ActionCode` "000", so rhythm marks it successful. The `IB_IMPS_PMTINQ`
inquiry then returns `ResponseCode` "U31", `ErrorCode` "Processing_001",
`Status` "PROCESSING" (not final), but rhythm stores `BankRefNo` as
`bank_identifier` and stops polling. The reversal appears only in the
statement, as a `REVERSED : IMPS/ASP/<utr>/...` credit paired with the original
debit. Always pull the statement.

```
detect_silent_reversals({ account_id: "<account_id>", customer_id: "<customer_id>", since: "<from>" })
get_account_statement({ account_id: "<account_id>", from: "<from>", to: "<to>" })
```

Usual cause: a malformed beneficiary account number. Nothing validates it
(`model/beneficiary.go:47` defaults `Verified` to true, and the only check on
add is `rejectSelfNREAccount` in `beneficiary_service.go:511`), so a truncated
number is accepted, shown as verified, and fails at NPCI.

```
sql_select({ service: "rhythm",
  sql: "SELECT unique_id, details FROM beneficiaries WHERE customer_id = $1",
  params: ["<customer_id>"] })
logs_search({ service: "rhythm", terms: ["BenefBankIFSC", "<ifsc_prefix>", "IMPS"],
  from: "<from>", to: "<to>" })
```

Compare the beneficiary's digit count with other customers' payees at the same
bank (read `BenefAccountNumber` from `raw_message`; ICICI numbers are 12
digits). Discriminator: an internal transfer (NRE to own NRO) succeeding while
every external IMPS reverses means the account and debit rails are fine and
the beneficiary is the problem. Fix for CX: delete the beneficiary and add it
again with the full account number from the destination bank. The NPCI return
code never reaches Aspora logs; ask the bank for the IMPS return reason by
UTR.

### ACCOUNT FROZEN- GSPM -(G) on an outward transfer

The transfer fails at CBS with `error` text starting "ACCOUNT FROZEN- GSPM
-(G)", logged as `message` "CBS transaction processing failed". The DB row
has `cbs_response` null and `failure_reason` empty, so it tells you nothing;
the reason exists only in logs.

```
logs_search({ service: "rhythm", message: "CBS transaction processing failed",
  terms: ["<txn_ref_id>"], from: "<from>", to: "<to>" })
http_call({ service: "rhythm", path: "/admin/v1/accounts/<account_id>" })
```

Freezes are lifted bank-side and can clear on their own. Re-read
`account_flags.debit.allowed` on the account endpoint before reporting the
freeze as current.

### "Transfers disabled" banner: the user turned transfers off

Symptom: the transfer screen shows a red "Transfers disabled" on the amount
field and Continue is greyed out; the account is healthy.

Cause: a real (non-default) `user_limit_transaction_settings` row with
`type = 'transfer'` and `enabled = false`. The limits API returns the disabled
reason `USER_DISABLED_TRANSFERS`, whose message is "Transfers disabled". This
is by design (`limit_service.go` `getAggregateRemaining`, `beneficiary.go`
`GetDisabledInfoMessage`). It is set only through the user-facing limits
endpoint behind an MPIN challenge, so only the user can change it.

```
sql_select({ service: "rhythm",
  sql: "SELECT type, enabled, updated_at, version FROM user_limit_transaction_settings WHERE customer_id = $1",
  params: ["<customer_id>"] })
```

Re-read it live and check `version` and `updated_at` before concluding: each
toggle bumps `version`, and the user can re-enable at any time. Fix for CX:
the user re-enables transfers in the app's transfer limit settings (MPIN
prompt). No backend action.

### UPI and Paytm linking: rhythm is not in the path

rhythm's only UPI surface is a static instructions screen
(`GET /v1/mobile/upi/config`). UPI PIN registration runs Paytm or PhonePe to
NPCI to the bank's UPI switch, with no Aspora service in between. "UPI PIN set
failed" or "can't link Paytm" is a bank ticket, not a rhythm bug. Prove the
account is healthy first, then escalate:

```
http_call({ service: "rhythm", path: "/admin/v1/accounts/<account_id>" })
```

"OTP not received" is ambiguous. The instructions have two OTPs: step 2 is the
PSP login OTP (PhonePe or Paytm to the user's international number, nothing to
do with the bank) and step 7 is the issuer OTP for UPI PIN set. Only the second
is a bank ticket. Aspora sends no UPI OTP, so an empty comms result for the
customer confirms this rather than pointing at a missing SMS (see ssfb-comms).
Registered mobiles on these accounts are international; UPI on an
international number needs the bank to have mapped it at NPCI and the PSP to
support the country code. PhonePe is the safer app to suggest. Steer the user
to the account whose debit card is `ACTIVE`.

### Card status INACTIVE is normal; pin_status is a mock

`/admin/v1/cards/customer/<customer_id>` returns the NRE and NRO cards live
from CBS: `status`, `is_virtual`, `card_expiry`, per-channel limits.

- `status` `INACTIVE` is the norm: every virtual card sampled sat at
  `INACTIVE` with ECOM disabled. Never conclude "this user's card is inactive"
  without sampling another customer.
- `MapCardStatusFromCBS` (`internal/mapper/card_mapper.go:71`) maps unknown
  CBS statuses to `INACTIVE`.
- `pin_status` is hardcoded (`card_mapper.go:60`); CBS does not send it.
  Ignore it.

### Debit card 500s are the client cancelling, not a card problem

`GetDebitCards` (`internal/service/account_service.go:1243`) returns 200 with
null when there is no card. A 500 comes only from the CBS savingaccount or
card-detail call. In practice the error is `context canceled` after one to two
seconds, while successful calls take about six: the CBS card inquiry is slow
and the iOS app disconnects first. It is systemic, with dozens of customers
a week.

```
logs_search({ service: "rhythm", message: "Api ended with Error", terms: ["cards", "debit"],
  from: "<from>", to: "<to>" })
```

## Deploy

The app folder is `rhythm/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.