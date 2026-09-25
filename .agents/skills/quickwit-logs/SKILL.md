---
name: quickwit-logs
description: >-
  Search and investigate Aspora service logs across the core-stage and core-prod
  clusters using the `qw` CLI (OIDC-authenticated Quickwit client). Fires whenever
  someone wants to look at logs — "check the logs", "why is X service failing /
  throwing 500s", "any errors in the last hour", "what's erroring in stage/prod",
  "find this request id / txn id / trace", "grep the logs for timeout", "log volume
  for goms-service", "tail the logs", "show me errors for banking-service" — even
  without saying "quickwit", "qw", or "logs". Read-only — run the query and report
  findings, always echoing the context + index + exact query used. Endpoints are
  VPN-only; every query is audited to the caller's SSO identity.
---

# quickwit-logs (qw CLI)

Investigate Aspora service logs through the **`qw`** CLI — a multi-context, OIDC-authenticated
client for our Quickwit log stores, covering **three clusters**: `core-stage`, `core-prod-london`, and `envoy-prod`.
Read-only by design: when someone asks a log question, **run the query and report back** — no need to
ask permission. Always echo the **context + index + exact query** so they can rerun it.

Stack: **Vector → Kafka → Quickwit → S3**, queried directly (not Grafana). The two ways to get it
wrong both fail *silently* (empty / misleading results, not an error): **wrong index** or **broken
query-language rule**. This skill exists to prevent that.

## 0. Setup (contexts are baked in — no external info needed)

If `qw` isn't installed or the contexts are missing, set them up. Endpoints are internal, **VPN-only**
(`*.internal.genorim.xyz` for the core clusters; `quickwit-proxy.vance.finance` via Kong for envoy-prod).
Login is Aspora SSO via `https://freeway.aspora.com` (same identity as Grafana / ArgoCD), interactive browser flow.

```bash
# install (macOS/Linux, amd64/arm64)
curl -fsSL https://raw.githubusercontent.com/agarwalvivek29/quickwit-cli/main/install.sh | sh

# core-stage (ap-south-1 / mumbai — application cluster)
qw context create core-stage \
  --endpoint https://vance-core-stage-mumbai-01-application-quickwit-proxy.internal.genorim.xyz \
  --issuer https://freeway.aspora.com --client-id 0oa25rp8owsWsoi871d8 --use

# core-prod-london (eu-west-2 / london — observability cluster)
qw context create core-prod-london \
  --endpoint https://vance-core-prod-london-01-observability-quickwit-proxy.internal.genorim.xyz \
  --issuer https://freeway.aspora.com --client-id 0oa25rs1vlrXjonjf1d8

# envoy-prod (ap-south-1 / mumbai — envoy-prod backend cluster; fronted by Kong)
qw context create envoy-prod \
  --endpoint https://quickwit-proxy.vance.finance \
  --issuer https://freeway.aspora.com --client-id 0oa25rq4s1u5DNcip1d8

# ssfb-prod (ap-south-1 / mumbai — Shivalik bank cluster). qwproxy is ClusterIP-only
# (no internal ALB yet) and the cluster API is private, so port-forward first, then
# point the context at localhost. Login still uses freeway.aspora.com from your laptop.
kubectl --context ssfb-prod -n quickwit-proxy-system port-forward svc/quickwit-proxy 9000:9000 &
qw context create ssfb-prod \
  --endpoint http://localhost:9000 \
  --issuer https://freeway.aspora.com --client-id 0oa25rs5nghZ8XvEY1d8

qw login                                       # logs in the current context
qw context use core-prod-london && qw login    # log prod in too
```

Check state anytime: `qw context list` (shows current + logged-in), `qw whoami` (identity of the
cached token). Switch with `qw context use <name>` — or per-command `--context core-prod-london`.
**Default to `core-stage`** unless the ask is explicitly about prod.

**Keep the CLI matched to the server.** Each cluster's proxy advertises its version on `/health`;
`qw upgrade` downloads and checksum-verifies a matching `qw` (defaults to the **current context's
server**, or `--latest` / `--version vX.Y.Z`; `--check` previews without installing). Run it after
switching to a cluster on a newer proxy, or if a command errors with a version mismatch.

**Unattended access without repeated browser logins (API keys).** For an agent, cron, or CI that
shouldn't do the interactive SSO flow every run: after `qw login`, mint a long-lived key —
`qw apikey create --ttl-days 30 --description "<who/what>"`. It is **saved into the current context**
and sent as an **`X-API-Key`** header on every later call — authorized by the proxy with no OIDC round
trip, valid up to 30 days. It inherits **your SSO identity** in the audit trail and the same read-only
allowlist (it can only read, and a key can never mint another key). Manage with `qw apikey list` /
`qw apikey revoke <id>`. To use a key elsewhere, copy it from the `create` output (**shown once**) and
set `QW_API_KEY` in that environment (or pass `--api-key`). **Revoke immediately if one leaks.**

**`ssfb-prod` is a bank cluster** — treat it like `core-prod-london` for PII (§4) and default
away from it unless the ask is explicitly about ssfb.

## 1. Pick the index FIRST — discover it, don't hardcode

Index names differ per cluster and have changed over time, so **run `qw indexes`** for the selected
context and pick from what's actually there. Two axes:

**Axis A — app vs system** (whose logs? routed by k8s namespace suffix):
- **app** logs → application workloads (namespaces ending `*-service`: `goblin-service`,
  `banking-service`, `goms-service`, …). **This is what people want ~95% of the time.**
- **system** logs → platform/infra (namespaces ending `*-system`: `quickwit-system`, `grafana-system`,
  `vector-system`, controllers, kafka). Only for investigating the platform itself.

**Axis B — index model (⚠️ changed Aug 2026):** the old substring **ngram** indexes are **retired**.
There is now **one word-based app-logs index, ~1-year retention**. Matching is **whole-word**; for
partial words use **wildcards** (§3). If `qw indexes` still shows multiple, prefer the plain
word-based app index; treat any `*-ngram` as legacy.

If a context has a sensible default you can bake it in: `qw context create <ctx> … --default-index
<app-index>` lets you omit `[index]` in queries. Otherwise pass the index explicitly.

## 2. CLI workflow

```bash
qw indexes                                           # what's queryable in this context
qw search <index> 'level:error AND service:goms-service' --since 1h
qw search 'x-txn-id:TXN-123' --since 6h -o json      # index omitted -> default-index
qw count  <index> 'level:error' --since 24h
qw histogram <index> 'level:error' --since 6h --interval 15m   # volume over time
qw tail   <index> 'service:api' -o raw --fields message        # live follow (Ctrl-C)
```

Flags that matter:
- **Time:** `--since 15m|2h|1d` (default 15m), or precise `--from` / `--to` (epoch, RFC3339,
  `YYYY-MM-DD`, `now`, or a duration-ago).
- **Projection:** `--fields timestamp,service,level,message` — keep responses lean.
- **Output:** `-o table|json|raw`; **built-in `--jq '<expr>'`** (implies json; no shell `jq` needed).
- **Size/paging:** `--max-hits` (default 20), `--offset`; `--sort-by timestamp` for newest-first.
- **Debug:** `--explain` prints the index + query actually sent; `-v` traces HTTP.

## 3. Query language (Quickwit) — the rules that bite

- **Bare term** (no `field:`) hits `message` **and** the id fields → `abc-123` alone finds a request.
- `message` — **whole words, case-insensitive**: `message:timeout`.
- `level` — **exact, lowercase**: `level:error` (NOT `ERROR`).
- `service` — **exact, full value**: `service:goms-service`.
- ids — `x-txn-id:TXN-123`, `x-req-id:…`, `x-requester-id:…` (also `attributes.*` for OTLP services).
- `kubernetes.*` — pod/namespace metadata: `kubernetes.pod_name:goms*`.
- anything else is **auto-indexed** — query by name: `status:>=500`, `status:[400 TO 499]` (range),
  `x-txn-id:*` (existence).
- **Booleans UPPERCASE:** `AND` / `OR` / `NOT`.
- **No `stats` / `sort` / `limit` / regex in the query, and no exact-phrase `"..."`** — for a phrase
  use `message:connection AND message:refused`.

**Wildcards (partial word) — mind the cost.** They match **inside one word**, not across spaces
(`*payment*` → `prepayment`, not `late payment`):

| Pattern | Matches | Cost |
|---|---|---|
| `some*` (prefix) | starts with `some` | **cheap** — seeks a sorted dictionary |
| `*some` (suffix) | ends with `some` | **expensive** |
| `*some*` (contains) | `some` anywhere (old substring behaviour) | **most expensive** |

A **leading `*`** can't seek — it scans every word × segment × the time range on the **shared**
searchers. Before using one: **narrow the time window**, add a `service:` / `level:` filter, and keep
the stem specific (`*id*` crawls). Prefer `some*`.

## 4. Guardrails

- **VPN required** — internal ALB endpoints. Connection failures usually mean off-VPN, not a bug.
- **Always bound time** (`--since`/`--from`) and keep `--max-hits` small (20–50). An unbounded `*`
  over 1y of logs is a bad day for the shared searchers.
- **Project fields** to keep payloads lean (`--fields …`).
- **Prod is real user data.** `core-prod-london` and `ssfb-prod` logs can contain **PII** (banking/remittance
  product). Query for what you need, don't bulk-export, and never paste raw prod log bodies into
  tickets/Slack without scrubbing.

## 5. Auditing — assume every query is on the record

The proxy writes an **append-only audit row for every call** (`qw_audit`, 12-month retention):
your SSO **email + subject**, client IP, CLI version, HTTP method/path, **index**, the **exact
`query_body`**, status, latency, bytes. It **never stores response bodies** — only the request
envelope. Practically: query freely (that's the point), but everything is attributable to *you*.
API-key calls are recorded the same way — attributed to the **user who minted the key**, with an
`auth_method` column marking `api-key` vs `oidc`.

## 6. Reporting to the requester

- **Summarize first** (what's erroring, how often, since when), then representative lines as
  `timestamp · service · level · message`.
- Surface `x-txn-id` / `x-req-id` when present — the join key to trace a request across services.
- **Always echo context + index + exact query**, e.g.
  `core-stage :: <app-index> :: level:error AND service:goms-service (--since 1h)`.

## 7. References

- **`references/lucene-cheatsheet.md`** — Quickwit query-language deltas from generic Lucene (the
  rules that bite: lowercase exact fields, uppercase booleans, wildcards, ranges, escaping).
- **`references/query-cookbook.md`** — copy-paste `qw` recipes (errors for a service, trace a txn,
  5xx, error-rate-over-time, tail, pagination) plus the field schema.

When a query behaves oddly, `qw search … --explain` shows exactly what was sent to Quickwit.
