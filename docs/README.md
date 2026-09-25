# triage-app design docs

Status: **v1 implementation landed on 2026-09-24**, verification pending the owner's review; mid-run input (P6, D52) added on 2026-09-25, CLI only. All 12 tickets and 101 sub-tickets of the plan are on main. The implementation plan is [09-implementation-plan.md](09-implementation-plan.md), with the machine-readable version in [plan/plan.json](plan/plan.json). What was built, where it departs from these docs and the questions still open for the owner are in [10-implementation-notes.md](10-implementation-notes.md). Read in order.

| Doc | What |
|---|---|
| [00-lay-of-the-land.md](00-lay-of-the-land.md) | What triage-shivalik does today, consolidated from the survey |
| [01-hld-birds-eye.md](01-hld-birds-eye.md) | One-diagram view and the rules that fall out of the survey |
| [02-hld-detailed.md](02-hld-detailed.md) | Agents, subagents, tools, gate, config model, interfaces |
| [03-data-flow.md](03-data-flow.md) | Request lifecycle and trust boundaries |
| [04-lld-multi-entity-request.md](04-lld-multi-entity-request.md) | Sequence and contracts for one request spanning SSFB + ATSPL (+ RTL) |
| [05-decisions.md](05-decisions.md) | Decisions with rejected options, assumptions, non-assumptions, mistakes to not repeat |
| [06-open-questions.md](06-open-questions.md) | Questions only you can answer, with defaults |
| [07-review.md](07-review.md) | Independent review findings on the HLD and LLD and what changed because of them |
| [08-scope.md](08-scope.md) | What v1 is, what comes later, what never. The one place to look for "is X in v1" |
| [09-implementation-plan.md](09-implementation-plan.md) | Build plan: 12 tickets, 101 sub-tickets in 15 waves, dependency graphs, and how the critique changed it. Source: [plan/plan.json](plan/plan.json) |
| [10-implementation-notes.md](10-implementation-notes.md) | What v1 built: verification results, deviations from the design docs, questions for the owner, known gaps |
| [proposals/](proposals/README.md) | Five additions under discussion, each with research, critique and outcome |
| [survey/](survey/) | Raw per-area survey reports (Opus 5.5 workflow agents, read-only) |
| [../.env.example](../.env.example) | Every configuration key the design needs; hostnames filled where known, credentials blank |

Process agreed in the brief: close the HLD first, then the LLD, then implement.
