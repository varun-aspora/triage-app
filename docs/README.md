# triage-app design docs

Status: **design only, nothing implemented** (2026-09-23). All open questions answered and folded into decisions D32–D41; one follow-up (Q26) remains. HLD awaiting sign-off. Read in order.

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
| [proposals/](proposals/README.md) | Five additions under discussion, each with research, critique and outcome |
| [survey/](survey/) | Raw per-area survey reports (Opus 5.5 workflow agents, read-only) |
| [../.env.example](../.env.example) | Every configuration key the design needs; hostnames filled where known, credentials blank |

Process agreed in the brief: close the HLD first, then the LLD, then implement.
