---
name: ssfb-guardian
description: SSFB guardian service (auth, device and SIM binding, OTP, tokens). Use when a Shivalik user is stuck on SIM binding, device registration, OTP or login, or when you need the userId link inside guardian.
metadata:
  kind: service
  entity: ssfb
  service: guardian
  sources: shivalik/guardian/AGENTS.md, shivalik/AGENTS.md, shivalik/NRI_ONBOARDING.md
  status: ported
---

# guardian (SSFB)

guardian owns authentication and device binding on Shivalik: SIM-based
binding, SMS OTP verification, device registration, JWT challenge-response
and token management. Device and SIM binding belong to guardian, not harbor.

- Registry service: `guardian`. Logs: `logs_search` with `service: "guardian"`.
- Database: `sql_select` with `service: "guardian"`.
- Admin API: `http_call` with `service: "guardian"`. The base URL may be
  blank, in which case the tool answers "not configured"; record that as a gap.
- Challenge state lives in Redis, which no tool reads.

## Tables

Only `device_auth_attempts` and `refresh_tokens` have confirmed columns. The
others are known to exist by name only.

| Table | Purpose | Columns confirmed |
|---|---|---|
| `device_auth_attempts` | SIM-binding attempts. | Yes, see below |
| `refresh_tokens` | Refresh tokens. Holds the link to the Aspora userId. | `verification_id`, `subject`, `scopes` |
| `device_verification_sessions` | Session state around a binding attempt (unverified: inferred from the name). | No |
| `access_tokens` | Access tokens per device or session. | No |
| `passkeys` | Passkey and biometric credentials. | No |

The tables `device_bindings`, `otp_records` and `tokens` do not exist. An
older version of the notes named them by mistake.

Before you write a query against a table without confirmed columns, list its
columns first:

```
sql_select {
  service: "guardian",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
  params: ["device_auth_attempts"]
}
```

## SIM binding flow

The flow is inbound. The app sends an SMS with a one-time token from the
device SIM to a single UK virtual mobile number (UAE SIMs send there too). The
SMS vendor's callback then resolves the sending number and its country.

`device_auth_attempts` columns:

- `sim_country_code` and `registration_country_code` are ISO 3166-1 numeric
  codes, not dial codes: 826 is the UK, 784 the UAE, 356 India.
- `sim_country_code = 0` means the inbound SMS never arrived. No vendor
  callback came, so no sending number was captured. These are the PENDING,
  EXPIRED and FAILED attempts, and they cluster on SIMs outside the UK, UAE
  and India.
- `sim_card_number` is stored in national format, with no country code and no
  `+` (for example 10 digits for a UK number), although a model comment in the
  code says otherwise. Build the E.164 form by prefixing the dial code that
  matches `sim_country_code`.
- A status column (VERIFIED, PENDING, EXPIRED, FAILED) and a timestamp column
  exist, but their names are not confirmed (unverified: counts from an earlier
  audit prove they exist; the column names were never written down). List the
  columns before you filter or order by them.

## ID fields

guardian has no `user_id` column. The link to the Aspora userId is indirect:

```
device_auth_attempts.verification_id
  -> refresh_tokens.verification_id
  -> refresh_tokens.subject   (the Aspora userId)
```

This path comes from an earlier audit and was not checked against a known
userId (unverified: no independent check). Cross-check the first result before
you rely on it.

The harbor `account_forms.session_id` also leads into guardian through the
admin API, when that API is configured:

```
http_call { service: "guardian", path: "/admin/verification/session/<session_id>/phone" }
```

## Queries

SIM-binding attempts for a userId, joined through `refresh_tokens.subject`:

```
sql_select {
  service: "guardian",
  sql: "SELECT daa.* FROM refresh_tokens rt JOIN device_auth_attempts daa ON daa.verification_id = rt.verification_id WHERE rt.subject = $1",
  params: ["<user_id>"]
}
```

The query is not ordered. Confirm the timestamp column name before you add
`ORDER BY` or `LIMIT`.

When a log line already gives you a `verification_id`, skip the join:

```
sql_select {
  service: "guardian",
  sql: "SELECT * FROM device_auth_attempts WHERE verification_id = $1",
  params: ["<verification_id>"]
}
```

## Known issues

- **SIM binding stuck, SMS never arrived.** `sim_country_code = 0` on the
  user's attempts means no vendor callback came. This is not a guardian bug by
  itself; check the SIM's country against the supported ones and the vendor
  webhook handling in the logs (`logs_search` with `service: "guardian"` and
  the `<verification_id>` as a term).
- **Number looks wrong.** `sim_card_number` has no country code. Compare it to
  the registered phone only after you add the dial code from
  `sim_country_code`.

## Code layout

Repo `guardian`:

```
internal/device_binding/
  controller/   HTTP endpoints
  service/      device binding logic
  repo/         DB access
  model/        GORM models
  vmn/          SMS vendor webhook handling
```

## Deploy

The app folder is `guardian/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.