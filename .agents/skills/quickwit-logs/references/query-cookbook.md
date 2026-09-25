# quickwit-logs — query cookbook (`qw` CLI)

Copy-paste `qw` recipes. Pick the context first (`qw context use core-stage|core-prod-london`) and
discover the index with `qw indexes` — substitute `<index>` below. Omit `<index>` entirely if the
context has a `--default-index`.

## Field schema

The app-logs index is **word-based, ~1-year retention** (the old substring/ngram indexes are retired).
`mode: dynamic`, so any field that appears in a log line is also indexed/queryable.

| Field | Type | Notes |
|---|---|---|
| `timestamp` | datetime | the time field for `--since`/`--from`/`--to` and `--sort-by` |
| `message` | text | whole words, case-insensitive; partial → wildcards (`time*`) |
| `level` | text (raw) | **exact, lowercase**: `error` `warn` `info` `debug` `trace` |
| `service` | text (raw) | **exact**, e.g. `goms-service` |
| `kubernetes` | json | nested: `kubernetes.pod_name`, `kubernetes.pod_namespace`, … |
| `x-req-id`, `x-txn-id`, `x-requester-id`, `status`, … | dynamic | indexed if present; ids also under `attributes.*` for OTLP services |

**Bare term** (no `field:`) hits `message` **and** the id fields, so `abc-123` alone finds a request.

## search recipes

**Errors for one service, last hour (newest first, lean fields):**
```bash
qw search <index> 'level:error AND service:goms-service' \
  --since 1h --max-hits 50 --sort-by timestamp \
  --fields timestamp,service,level,message,x-txn-id
```

**Tail a service live (any level):**
```bash
qw tail <index> 'service:banking-service' --since 15m -o raw --fields message
```

**Trace one transaction / request across services:**
```bash
qw search <index> 'x-txn-id:TXN-123' --since 24h --max-hits 200 --sort-by timestamp
qw search <index> 'x-req-id:abc-123'  --since 24h --max-hits 200 --sort-by timestamp
```

**5xx only, for a service:**
```bash
qw search <index> 'status:>=500 AND service:payments-svc-service' --since 6h --max-hits 50
```

**Partial-word match + drop health-check noise:**
```bash
qw search <index> 'message:time* AND NOT message:health' --since 3h --max-hits 50
```

**Older window (just widen the time bound — 1-year retention):**
```bash
qw search <index> 'message:connection AND message:refused' --from 90d --to 30d --max-hits 50
```

**Pagination (page past --max-hits):**
```bash
qw search <index> 'level:error' --since 24h --max-hits 100 --offset 0     # page 1
qw search <index> 'level:error' --since 24h --max-hits 100 --offset 100   # page 2 …
```

## count & volume-over-time

**Count matches:**
```bash
qw count <index> 'level:error' --since 24h
qw count <index> 'level:error AND service:goms-service' --since 24h
```

**Error rate over time (date-histogram equivalent):**
```bash
qw histogram <index> 'level:error' --since 24h --interval 1h
qw histogram <index> 'service:goms-service' --since 6h --interval 15m
```

> Terms/pie breakdowns (log-level distribution, noisiest-services top-talkers) aren't `qw` commands —
> use Grafana → Explore → Builder (`Count`, Group By `Terms: service`/`level`) for those.

## Common pitfalls (all fail silently — empty/misleading, not an error)

| Symptom | Cause | Fix |
|---|---|---|
| No results for a fragment you see in logs | fragment isn't a whole word | wildcard: `time*` (prefix) or `*out*` (costly) |
| `level:ERROR` returns nothing | levels are lowercase, exact | `level:error` |
| `service:goms` returns nothing | `service` is exact, not partial | full value `service:goms-service` (or `goms*`) |
| Query scans huge / very slow | no time bound, or a leading `*` | set `--since`, add `service:`/`level:`, avoid leading `*` |
| Only `--max-hits` results when more exist | that's the cap | page with `--offset` |
| `and` / `or` treated as terms | booleans must be uppercase | `AND` / `OR` / `NOT` |
| Looking for a platform component, empty | infra logs live in the **system** index | pick the system index from `qw indexes` |
| Can't connect | off VPN, or context not logged in | on VPN + `qw login` (check `qw context list`) |
| 401 with a stored API key | key expired or revoked | `qw login` again, or mint a fresh one with `qw apikey create` |
| Version mismatch vs the server | CLI out of sync with the proxy | `qw upgrade` (matches the current context's server) |
