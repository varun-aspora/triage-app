# 07. Review of the HLD and LLD

Three independent reviewers (Opus 5.5) read the first draft of docs 01–06 and `.env.example` on 2026-09-23, each with a different lens. This page lists what they found, what changed because of it, and what was deliberately not changed. The raw reports are in the session transcript; the substance is here.

| Lens | Question asked | Findings | Accepted | Rejected or deferred |
|---|---|---|---|---|
| Security (adversarial) | Try to break GET-only, SELECT-only, host/entity binding, approval, redaction, secrets handling | 7 high, 7 medium, 5 low | 17 | 2 deferred (per-caller auth, UUID masking) |
| Flue correctness | Check every framework claim against the reference corpus and installed types | 8 wrong or partly wrong, 12 correct, 5 features not used | all wrong items fixed; 5 features adopted | none |
| Product fit vs the brief | Goals met? stage/prod branching? classification sound? interfaces? what was dropped from the current system? | 9 blocking items, ~30 others | 9 blocking fixed; most others fixed | Grafana, batch mode, writes stay out of v1 (as the brief implies) |

## 1. Structural changes made

| # | Finding (who) | Change | Where |
|---|---|---|---|
| 1 | `deep_investigator` had no entity closure, violating D3, and would hit Flue's duplicate tool-name error when mounting three entities' tools in one render (product, Flue) | Replaced by `investigate_<entity>_deep` from the same factory on the strong model | 02 §1.3, D23 |
| 2 | Tier was fixed before any data lookup, yet the survey shows Slack tags misclassify often (product) | Identity resolution and three basic state reads moved into ingress, before the classifier; the classifier sees facts | 02 §1.5, 04 §2.2, D22 |
| 3 | A cheap orchestrator decided whether to escalate and wrote the final answer (product) | Deterministic escalation triggers set by `note_evidence`; `finish_report` becomes a harness tool that re-synthesises on the strong model when triggered | 02 §2, §4.3, 04 §2.8, D23 |
| 4 | Redacting tool results before the model would hide account numbers and UTRs the investigation needs (product) | Two redaction profiles: model-facing keeps search keys; persisted/egress masks everything, decodes before scanning, uses names collected by ingress | 02 §3, 03 §2, D24 |
| 5 | `triage post` prompted y/N on stdin, which hangs under Claude Code; a blocking `run` exceeds coding-agent shell timeouts (product) | `start`/`wait`/`status`/`ask`; `post --yes --approved-by` when stdin is not a TTY; `--thread-file` input; `TRIAGE_HOME` | 02 §5.1, §5.3, D28 |
| 6 | Report lacked the CX fields the team actually needs and a status line (product) | `status` and structured `cx_answer` added | 02 §6, 04 §2.9 |
| 7 | `transfer_lifecycle.sh` reversal detection and the eval-capture loop were dropped (product) | `detect_silent_reversals`, `get_account_statement` on SSFB; `triage feedback` + HTTP endpoint | 02 §2, 04 §2.10, D29 |
| 8 | Allowlist example used `source: harbor` for bro paths, which would build `/harbor/bro/...`; Finacle entries are POSTs but `cbs_read` was GET-only (product) | bro entries use `source: bro`; `cbs_call` replaces `cbs_read` with allowlisted POST through the kubectl transport; `http_call_allowlisted` rejects `finacle` | 02 §2, §4.4 |
| 9 | `.env.example` carried a redaction on/off flag and a decryption-key slot that contradicted A6 (product) | Both removed; `MODEL_ENTITY_INVESTIGATOR` and `SLACK_DEFAULT_CHANNEL_ID` removed; mock mode default `true`; budgets, `TRIAGE_HOME`, per-entity `QUICKWIT_MAX_HITS`, guardian API slot added | `.env.example` |

## 2. Security findings and their fixes

| Sev | Finding | Fix |
|---|---|---|
| High | SQL function denylist cannot enumerate every dangerous function; `default_transaction_read_only` is a session setting | Function **allowlist**; unknown or set-returning functions refused; read-only DB role is a launch precondition verified by `triage doctor` (Q23) |
| High | URL builder was a substring denylist; protocol-relative hosts, encoded separators and `..` could escape | Resolve with `new URL(path, base)`, assert same origin and segment-boundary path prefix, reject `..`/encoded slashes first |
| High | Allowlist prefix matching over-matched sibling paths | Segment-boundary prefix on the canonicalised built URL |
| High | CBS path interpolated into a remote shell (the current script's bug) | Charset-validated path; fixed argv; path, body and token as stdin data; no `sh -c` (D30) |
| High | Redaction was regex-only and the report check reused it | Decode before scan, structured fields, ingress-collected names, model text treated as untrusted; residual risk recorded (D24) |
| High | HTTP Slack post trusted a caller-asserted `approved_by` | Endpoint disabled by default until a Slack-signed approval exists (D25, Q22) |
| High | Recorded fixtures inherit redaction blind spots and might be committed | `fixtures/_unreviewed/` gitignored; human promotion step (D27) |
| Med | `repo_grep` option injection via a pattern starting with `-` | In-process grep over the jailed tree; no external binary |
| Med | Nothing bound queries to the ticket's customer | Scope rule: id-shaped params must be in the IdChain or the call is aggregate-only systemic (D26) |
| Med | `x-customer-id` header injection | Set only from the IdChain after a charset check |
| Med | Agent router SSE exposed model-facing data and creation behind one token | Router not mounted in v1; polling through egress redaction (D25) |
| Med | Single static bearer | Recorded as a v1 limit; per-caller tokens v2 |
| Med | Read-only enforced client-side only | Role check in doctor; real mode blocked on failure |
| Med | CBS token mint is a non-GET outside the allowlist | Explicit carve-out as tool infrastructure (D30, Q4) |
| Low | `repo_read` exposed `.git` and dotfiles | Excluded |
| Low | SQL parser edge cases (LATERAL, set-returning functions, casts) | Named in the gate spec; library choice stays a spike item |
| Low | Quickwit query DSL injection | Terms escaped; field names allowlisted per entity |
| Low | UUIDs pass redaction | Kept as an explicit assumption (A11) |
| Low | Self-contradictions: "no entity I/O" vs `resolve_identity`; anti-replay was prompt-only | Wording fixed; `never_call` registry list gives the anti-replay rule a code backstop for known endpoints (Q24) |

## 3. Flue corrections

| Claim | Verdict | Change |
|---|---|---|
| `useModel` from `useInitialData()` | correct | Added `Triage.initialData` schema and `uid: null` on dispatch so a raw create cannot skip the classifier |
| One Slack thread = one conversation (v2) | wrong | Flue ignores `initialData` on an existing instance, so the tier would freeze; each ask mints a new `run_id` |
| `investigatorAgent` exported from a `'use agent'` module | would register as a top-level agent and re-enter | Factory lives in a plain module |
| Delegates know `run_id` | gap | `investigatorFor(entity, runId)` closes over it |
| `ctx.append({kind:'signal', text})` | wrong shape | `{kind:'signal', type, body}` |
| Finish check via a state flag | fragile | `ctx.response.toolCalls.some(c => c.tool==='finish_report' && !c.isError)`; retry counter; throw on second miss (not appending settles `completed`, not `failed`) |
| `read(receipt)` snippet | receipt never assigned | fixed |
| Flue `idempotencyKey` for thread dedupe | ineffective (scoped to instance id) | Ingress-level `Idempotency-Key` stored in sqlite |
| `instrument({interceptor})` | needs `observe` and `dispose`; process-wide; allowlist must include framework tool names | fixed |
| Skill names from directory names | `overview/` ×3 would collide; `workflow` exists in two entities | Directories renamed `ssfb-overview`, `rtl-workflow`, etc.; static import map |
| Always-on method text as a skill | skills load on demand only | `useInstruction()` |
| `useResponseFinish` for per-model cost | one aggregate only | Meter from `observe()` `turn` events |
| `flue run` vs `start()` provider registration | must live where both load it | `src/models.ts` side-effect module imported by the agent module and the classifier; `start()` without `providers` |
| `fauxProvider` with `setProvider` | correct per installed types | Used in evals via `start({providers:[faux.provider]})` |
| `harness: true` rejection in D9 | correct | none |
| Durability static, delegates under parent timeout | correct | `Triage.durability` set from env; tools honour `signal`; low `maxAttempts` |

Items still marked **[verify in spike]** in the LLD: `read()` re-attach across processes with the sqlite adapter; delegate transcript resume after a crash.

## 4. Product-fit items not changed, and why

- **Grafana via Playwright, Serena, code-review-graph, headroom, ClickUp**: not restored. The brief names Quickwit as the log path (Q18 remains for confirmation).
- **Batch/cohort and incident-impact modes**: stay v2 (D17, Q11).
- **Remediation writes**: never; the report recommends them (D17, Q8).
- **Three tiers instead of two**: kept, with `CHEAP` allowed to equal `MID` (A12).
- **Timings in 03 §3**: relabelled as estimates rather than removed.
- **iOS onboarding spine**: still missing (Q from survey 02); knowledge port will note Android as the source.

## 5. Verdict

The reviewers' shared view before the fixes: structure sound, not ready to sign off. Every blocking item they listed has a change in this revision. What remains open is not design shape but facts only you can supply (docs/06) and two Flue behaviours to confirm in a one-day spike before implementation starts.
