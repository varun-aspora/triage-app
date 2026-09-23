---
name: ssfb-finacle
description: Shivalik Bank's Finacle core banking system (CBS) and the shivalik-cbs-go client library. Use when the admin APIs and databases cannot answer and the bank's own record of a customer or account is needed, or to read a CBS error code from harbor or rhythm.
metadata:
  kind: service
  entity: ssfb
  service: finacle
  sources: shivalik/cbs-go/AGENTS.md, shivalik/eventbus/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# Finacle CBS (SSFB)

Finacle is Shivalik Bank's core banking system. It holds the bank's own
record of each customer (the CIF) and each account. harbor creates customers
and accounts in it; rhythm runs transfers, term deposits and cards through it.

## Access

Finacle is reached through `cbs_call` when enabled; GET only unless a rules
entry allows more.

- `cbs_call` is on the SSFB investigators only, and only when the deployment
  turns it on. If it is not available, record the gap and continue with the
  admin APIs and databases.
- The ordinary HTTP tool refuses `service: "finacle"`. Use `cbs_call`.
- `path` is a plain path: letters, digits, `/`, `_`, `.` and `-`. No query
  string and no `..`.
- The rules file ships empty, so today only GET works.

Use it when the admin APIs and databases cannot answer, for example when a
record was hard-deleted on the Aspora side but still exists in CBS.

## Paths

| Path | Returns |
|---|---|
| `/misc/api/crm/savingaccount/<account_number>` | Account inquiry: balances, freeze status, card, and `CustId` (the CIF). |
| `/customer/api/retail/<cif>` | Customer details for a CIF. |

```
cbs_call { path: "/misc/api/crm/savingaccount/<account_number>" }
cbs_call { path: "/customer/api/retail/<cif>" }
```

`<account_number>` is the CBS account number from rhythm
`customer_account_mappings.account_number`, not the rhythm `account_id`. When
you need the CIF, the savingaccount response gives it as `CustId`.

A third path, `/custom/api/lvl2/finacle/script`, runs the bank's
customer-account inquiry script (`CUST_ACCT_DET`). It is a POST, so it is
refused until a rules entry allows it. Report the need for it instead of
trying it.

## shivalik-cbs-go

`shivalik-cbs-go` is a Go library, not a service. It has no deployment, no
database and no logs, and it is released by tag. It is the Go port of the
Java `shivalik-cbs` client with the same API surface, and harbor and rhythm
use it for every CBS call.

Read it to see what harbor and rhythm actually send to and receive from CBS.
When a harbor or rhythm log shows only a `responseCode` or `errorCode`, the
matching client method shows the request shape and which CBS endpoint was hit.

- `pkg/client` has one method per CBS endpoint, with request and response
  types.
- `pkg/errors/error_codes.go` maps CBS failures to these codes:
  `CUSTOMER_EXISTS`, `AML_MATCH_FOUND`, `VALIDATION_ERROR`, `INTERNAL_ERROR`,
  `SIGNATURE_ADD_FAILED` and `UNKNOWN`.
- HTTP goes through `go-resty` with logging and tracing interceptors. The
  request and response shapes you see in harbor and rhythm logs come from
  those interceptors.
- `shivalik-fuzzy-json.json` lists CBS response quirks: fields that arrive as
  different JSON types from one response to the next.

## Known issues

- **CBS says one thing, the Aspora side another.** When harbor or rhythm show
  a state that does not match what the user sees, the account inquiry path
  above gives the bank's view (freeze status, balances). Quote the fields you
  used.
- **Error code only.** A bare `errorCode` in a harbor or rhythm log maps to
  one of the codes in `pkg/errors/error_codes.go`; name the code and the client
  method in the finding.
