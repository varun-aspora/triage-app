---
name: ssfb-guardian
description: SSFB guardian service (auth, device and SIM binding, OTP, tokens). Use when a Shivalik user is stuck on SIM binding, device registration, OTP or login, or when you need the userId link or the device id inside guardian.
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
- Challenge state and the registration counter live in Redis, which no tool
  reads.

## Tables

| Table | Purpose | Columns confirmed |
|---|---|---|
| `device_auth_attempts` | SIM-binding attempts, one row per registration. | Yes, see below |
| `refresh_tokens` | Refresh tokens. Holds the link to the Aspora userId. | `verification_id`, `subject`, `scopes` |
| `device_verification_sessions` | Session state around a binding attempt (unverified: inferred from the name). | No |
| `access_tokens` | Access tokens per device or session. | No |
| `passkeys` | Passkey and biometric credentials. | No |

The tables `device_bindings`, `otp_records` and `tokens` do not exist. An
older version of the notes named them by mistake.

Use the columns above as they are. Look columns up only for the tables
without a list, all of them in one call:

```
sql_select {
  service: "guardian",
  sql: "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ($1, $2, $3) ORDER BY table_name, ordinal_position",
  params: ["device_verification_sessions", "access_tokens", "passkeys"]
}
```

## SIM binding flow

The flow is inbound. The app sends an SMS with a one-time token from the
device SIM to a single UK virtual mobile number (UAE SIMs send there too). The
SMS vendor's callback then resolves the sending number and its country.

`device_auth_attempts` columns (confirmed from `information_schema`):
`verification_id`, `device_id`, `platform`, `device_model`,
`device_manufacturer`, `os_version`, `app_version`, `device_token`,
`sim_card_number`, `token`, `token_expires_at`, `vmn_used`, `status`,
`verified_at`, `verification_completion_deadline`, `polling_attempts`,
`created_at`, `updated_at`, `sim_country_code`, `device_fingerprint`,
`registration_country_code`.

- `status` is VERIFIED, PENDING, EXPIRED or FAILED.
- An abandoned attempt stays PENDING for good. It turns EXPIRED only if the
  client polls after `verification_completion_deadline` (10 minutes after the
  start). An old PENDING row means no SMS matched and the client gave up, not
  that binding is in progress.
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

## ID fields

guardian has no `user_id` column. The link to the Aspora user id
(`aspora_user_id`) is indirect:

```
device_auth_attempts.verification_id
  -> refresh_tokens.verification_id
  -> refresh_tokens.subject   (the Aspora user id)
```

This path comes from an earlier audit and was not checked against a known
user id (unverified: no independent check). Cross-check the first result before
you rely on it.

The join only finds users who verified at least once. A user who never got
past SIM binding has no refresh token, no harbor form and no harbor log line
with their user id. For them an empty join is expected; follow the device
instead (next section).

The harbor `account_forms.session_id` also leads into guardian through the
admin API, when that API is configured:

```
http_call { service: "guardian", path: "/admin/verification/session/<session_id>/phone" }
```

## Users who never verified: follow the device

1. Get the device id from a result fetched by the user's id. The app sends it
   as `x-device-id`, and the RTL app server logs it: the RTL investigator
   searches `app-server-service` by the `aspora_user_id` with
   `columns: ["x-device-id"]` (see `rtl-nri-onboarding`), and the brief
   carries it on its `Journey keys:` line. For a user who verified once, the
   join above already returns `device_id`.
2. The attempts on that device:

```
sql_select {
  service: "guardian",
  sql: "SELECT verification_id, status, sim_country_code, registration_country_code, polling_attempts, created_at, verified_at, verification_completion_deadline FROM device_auth_attempts WHERE device_id = $1 ORDER BY created_at",
  params: ["<device_id>"]
}
```

3. harbor's poll lines for the device (`checking verification status`, see
   `ssfb-harbor`) give the timeline per poll.

A device id is in scope only once a result in this run, fetched by an id from
the chain, has shown it (the investigator note has the rule). Rows fetched by the device id do not bring their verification ids into scope,
so search the logs by the device id, not by those verification ids.

## Queries

SIM-binding attempts for an `aspora_user_id`, joined through `refresh_tokens.subject`:

```
sql_select {
  service: "guardian",
  sql: "SELECT daa.* FROM refresh_tokens rt JOIN device_auth_attempts daa ON daa.verification_id = rt.verification_id WHERE rt.subject = $1 ORDER BY daa.created_at",
  params: ["<aspora_user_id>"]
}
```

When a result fetched by the user's id already gave you a `verification_id`,
skip the join:

```
sql_select {
  service: "guardian",
  sql: "SELECT * FROM device_auth_attempts WHERE verification_id = $1",
  params: ["<verification_id>"]
}
```

## Registration limit

guardian allows 5 registrations per device in a fixed 24-hour window (the
deployed guardian config sets 5 per 86400 seconds; the code default is 3).
The counter is in Redis, keyed by the device id. A refused registration writes
no row and no log line, so the evidence is the count: 5 attempts on the device
inside 24 hours, then nothing. guardian's admin `POST /admin/device/reset-attempts`
(harbor calls it) clears the counter. Name it as a fix; never call it.

## Logs

Labels seen in past investigations. Search them as `message`, exactly as
written:

- Challenge: `generating challenge`, `challenge generated successfully`,
  `verifying challenge`, `challenge verified`, `failed to verify challenge`,
  `refresh token is not valid`.
- Inbound SMS, one request each: `Twilio callback received`, then
  `Processing Twilio callback` (carries `iso_country_code`), then
  `Successfully verified token and created session` or
  `Failed to verify token and create session`. The failure's `error` says
  why: `Request validation failed`, `Verification ID does not exist`,
  `Verification token has expired`.
- Fields: `x-device-id`, `reference_id`, `iso_country_code`. Search the
  device id as a whole `terms` value; the SSFB logs note says what to do when
  the count looks low.

The logs redact the phone fields (the SSFB logs note lists them). A phone
search on guardian logs proves nothing; read
`device_auth_attempts.sim_card_number` instead. The callback lines carry no
device or verification id, so read the callbacks by the exact message over
the span of the user's attempts (the first `created_at` to the last
`verification_completion_deadline`) in one call, and match the hit times to
each attempt's window:

```
logs_search { service: "guardian", message: "Processing Twilio callback", columns: ["iso_country_code"], order: "oldest", from: "<first_attempt_start>", to: "<last_attempt_deadline>" }
```

Do not run one call per attempt: 17 attempts would use up the logs budget. If
the span has more hits than one page, check the first, the last and one
middle attempt's window. Other users' callbacks fall in the same span, so a
hit shows that a callback arrived then and from which country, not whose it
was.

## Known issues

- **SIM binding stuck, SMS never arrived.** `sim_country_code = 0` on the
  user's attempts means no vendor callback came. This is not a guardian bug by
  itself. Check the SIM's country against the supported ones, read the
  callbacks over the span of the attempts (above), and compare other attempts from
  the same country in the same window. The pattern
  `sim-binding-no-vendor-callback` lists the first queries. When the backend
  is clean, the remaining leg is the phone sending the SMS, which the app
  cannot report; read the app code (`frontend-routing`).
- **Number looks wrong.** `sim_card_number` has no country code. Compare it to
  the registered phone only after you add the dial code from
  `sim_country_code`.
- **Several attempts, then nothing.** The device may be at the registration
  limit (above).

## Code layout

Repo `guardian`:

```
internal/device_binding/
  controller/   HTTP endpoints
  service/      device binding logic and the registration limit
  handler/      SMS vendor callbacks (the log labels above)
  repo/         DB access
  model/        GORM models
  vmn/          SMS vendor webhook handling
```

## Deploy

The app folder is `guardian/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Check it when the question is
what runs and with which settings, and cite the file.
