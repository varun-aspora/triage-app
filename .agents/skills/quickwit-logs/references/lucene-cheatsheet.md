# Quickwit query-language cheat sheet (verified against our stack)

Quickwit's query language is Lucene-*like* but **not** identical — the deltas below are where models
go wrong. This is the string you pass as the `<query>` arg to `qw search|count|histogram|tail`. Time
is **not** part of the query — it's the `--since` / `--from` / `--to` flags.

## ⚠️ Stack-specific rules that override generic Lucene (read first)

1. **Levels are lowercase & exact.** `level:error` matches; `level:ERROR` → **0 hits** (raw
   tokenizer, case-sensitive). Same for `service` — `service:email-service`, exact full value.
2. **No exact-phrase `"..."`.** The `message` field is whole-word without positions, so a phrase
   query fails. For a two-word phrase use `message:connection AND message:refused`.
3. **Never put time in the query.** Use `--since 1h` / `--from … --to …`. Time bounds prune at
   storage and are far cheaper than a `timestamp` range clause.
4. **Partial words = wildcards, and direction sets cost** (see below). There is **no substring/ngram
   index anymore** — a bare fragment like `eout` does not match `timeout`; use `*eout` or `time*`.
5. **Sorting** is a CLI flag: `--sort-by timestamp` (Quickwit sorts descending / newest-first by
   default). Don't try to sort inside the query.

## Wildcards (partial word) — mind the cost

Wildcards match **inside one word**, not across spaces (`*payment*` → `prepayment`, not `late payment`).

| Pattern | Matches | Cost |
|---|---|---|
| `some*` (prefix) | starts with `some` | **cheap** — seeks a sorted word dictionary |
| `*some` (suffix) | ends with `some` | **expensive** |
| `*some*` (contains) | `some` anywhere | **most expensive** — scans every word × segment × time range |

A **leading `*`** can't seek. Before using one: narrow `--since`, add a `service:` / `level:` filter,
and keep the stem specific (`*id*` crawls). Prefer `some*`.

## Clauses

| Want | Query | Notes |
|---|---|---|
| Term | `level:error` | lowercase, exact for raw fields |
| Bare term | `timeout` | searches the bare-term fields (message + id fields on app indexes) |
| Two-word phrase | `message:connection AND message:refused` | no `"..."` phrase support |
| Prefix | `service:email*` · `message:time*` | cheap wildcard |
| Term set (IN) | `level:IN [error warn]` | OR-set, space-separated, brackets |
| Exists | `x-txn-id:*` | field is present/set |
| Match all | `*` | always pair with a `--since` bound |
| Nested JSON | `kubernetes.container_name:email-service` | dotted path into the `kubernetes` object |

## Ranges & comparisons

- Inclusive: `status:[400 TO 599]`
- Exclusive: `latency_ms:{100 TO 200}`
- Half-open: `status:[500 TO *]`
- Comparison: `status:>=500` · `>500` · `<50` · `<=50`

## Booleans

- `AND` (implicit between clauses), `OR`, `NOT` (or `-`) — **UPPERCASE**.
- **Precedence:** `NOT` > `AND` > `OR` — **group with parentheses** to be safe.
- Pure negation works: `NOT level:info`.
- Field-grouped OR: `(level:error OR level:warn) AND service:email-service`.
- Dash negation: `level:error -message:health`.

## Escaping

Escape with `\`:  `+ ^ : { } " [ ] ( ) ~ ! \ *` and space. Common case — a value containing `:` or
`/` (a URL or `namespace/pod`) must be escaped, e.g. `message:https\:\/\/api`.

## Quick "don't get it wrong" checklist

- [ ] Right context? (`core-stage` vs `core-prod-london` — `qw context list`)
- [ ] Right index? (app vs system — `qw indexes`)
- [ ] `level` / `service` **lowercase & exact**
- [ ] Booleans **UPPERCASE**
- [ ] Time in `--since` / `--from`, **not** the query
- [ ] Partial word → `some*` (prefix, cheap); avoid leading `*` without a tight time + service filter
- [ ] Bound the window + keep `--max-hits` small; page with `--offset`
