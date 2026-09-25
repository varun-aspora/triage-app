---
name: ssfb-pdfgen
description: SSFB pdf-generator, the async PDF render and upload service. Use when a Shivalik statement, letter or other document was not generated or not delivered.
metadata:
  kind: service
  entity: ssfb
  service: pdfgen
  sources: shivalik/pdf-generator/AGENTS.md, shivalik/AGENTS.md
  status: ported
---

# pdf-generator (SSFB)

pdf-generator renders PDFs asynchronously. A caller submits a job against a
template; the service renders it with Gotenberg (a separate deployment) and
uploads the result.

- Registry service: `pdfgen`, repo `pdf-generator`.
- Database: `sql_select` with `service: "pdfgen"`.
- Logs: `logs_search` with `service: "pdfgen"` (the log service name is
  `pdf-generator`).
- No admin API is known.

The same service also runs for RTL on a different cluster with different
data. This note covers the Shivalik copy only.

## Tables

| Table | Purpose |
|---|---|
| `jobs` | One row per render request. Columns that matter: `status`, `upload_status`, `upload_url`, `error_message`, `retry_count`, `max_retries`, `client_id`, `template_id`, `external_ref_id`, `idempotency_key`, `processed_at`. |
| `templates` | Registered templates. |

## Common checks

Find the job by the caller's reference:

```
sql_select {
  service: "pdfgen",
  sql: "SELECT status, upload_status, error_message, retry_count, max_retries, template_id, processed_at FROM jobs WHERE external_ref_id = $1",
  params: ["<external_ref_id>"]
}
```

If you only have the idempotency key, filter on `idempotency_key` instead.

- Read `status` and `upload_status` separately. The render can succeed while
  the upload fails.
- A job stuck in `PENDING`: compare `retry_count` with `max_retries`
  (default 3). When retries run out, the reason is in `error_message`.
- Rendering itself failing points at the Gotenberg deployment, not at this
  service.

## Known issues

- **Rendered but not delivered.** `status` shows success while
  `upload_status` shows a failure. The document exists but never reached
  storage; report the upload failure and the `error_message`.
- **Retries exhausted.** `retry_count` equals `max_retries` and the job never
  finished. The last error is in `error_message`.

## Deploy

The app folder is `pdf-generator/` inside the deploy manifests folder your
instructions name. `base/` holds the deployment and `overlay/` the config per
region, with shared values in a `common` folder. Gotenberg is deployed from
the same folder. Check it when the question is what runs and with which
settings, and cite the file.