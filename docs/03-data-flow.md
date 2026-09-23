# 03. Data flow diagram

Two views: the request lifecycle (what data moves where) and the trust boundaries (what may touch what).

## 1. Request lifecycle

```mermaid
flowchart TD
    A["Caller input<br/>slack_url / free text / JSON"] --> B[Ingress adapter]
    B -->|bot token| S[(Slack Web API<br/>conversations.replies, files)]
    S -->|thread messages, images| B
    B --> C["TriageRequest<br/>request_id, messages, attachments, hints, window"]
    C --> R1[redact, persisted profile] --> P1[(runs/run_id/input.json)]
    C --> J[identity.ts<br/>deterministic ID chain + basic state]
    J -->|parameterised SELECTs, fixed GETs| DB1[(SSFB harbor_db, rhythm_db, workflow_op_db)]
    DB1 --> J --> K[IdChain + basic state, each with taken_at]
    C --> D[Classifier<br/>MODEL_CLASSIFIER, structured output]
    K --> D
    D --> E[Classification proposed]
    E --> F[Tier policy<br/>ordered deterministic rules + known-pattern index]
    F --> G[Classification final<br/>tier, entities, current_ask, flags]
    G --> P2[(runs/run_id/classification.json)]
    G --> H[dispatch Triage<br/>initialData = request + classification + id_chain]
    K --> H

    H --> I[Triage agent<br/>useModel by tier]
    I -.re-run when a new id surfaces.-> J

    I -->|task briefs, parallel| L1[investigate_ssfb]
    I -->|task| L2[investigate_atspl]
    I -->|task| L3[investigate_rtl]
    I -->|task when code needed| M[code_walker]

    L1 --> T[(Tool gate)]
    L2 --> T
    L3 --> T
    T -->|api rules: default GET| API[(Admin APIs)]
    T -->|SELECT only| DBS[(Entity Postgres readers)]
    T -->|search, time-windowed| QW[(Quickwit per entity)]
    T -->|flag on, GET| CBS[(Finacle via ssh+kubectl)]
    M -->|execFile| CG[(codegraph CLI + repos/)]

    T --> R2[redact, model-facing profile] --> L1 & L2 & L3
    L1 & L2 & L3 --> N[EntityFindings → note_evidence] --> P3[(runs/run_id/evidence/*.json)]
    M --> N2[CodeFindings → note_evidence] --> P3
    N & N2 -->|short summaries| I
    N -->|confidence low, conflict, money moved| ESC[escalation.triggered]

    I -->|task| O["investigate_<entity>_deep<br/>MODEL_TIER_STRONG"] --> T
    O --> N

    I --> Q[finish_report, harness tool] 
    ESC -->|if triggered on a non-strong run| Q2[strong-model synthesis over evidence/] --> Q
    Q --> R3[redact, egress profile + check] --> P4[(runs/run_id/report.md, report.json)]
    P4 --> FB[triage feedback → feedback.md]
    T --> AUD[(audit.jsonl<br/>one line per tool call)]
    P4 --> OUT1[CLI stdout]
    P4 --> OUT2[HTTP GET /triage/:id]
    P4 --> OUT3[Claude Code / Codex shows report]
    P4 -.->|explicit approval only| OUT4[Slack thread reply]
```

### Data objects

| Object | Produced by | Consumed by | Persisted | Contains PII? |
|---|---|---|---|---|
| `TriageRequest` | ingress | identity step, classifier, Triage (initial data) | `input.json` (persisted profile) | raw copy in memory only |
| `IdChain` + basic state | `identity.ts` (ingress) and `resolve_identity` (tool) | classifier, Triage, investigator briefs | in `classification.json` and `report.json` | UUIDs are treated as identifiers, not PII (assumption A11); account numbers masked on disk |
| `Classification` | classifier + policy | Triage (`useModel`, plan), evals | `classification.json` | masked ids only |
| `EntityFindings` / `CodeFindings` | investigators / code walker | Triage, synthesis pass | `evidence/<entity>.json` | persisted profile before write |
| `Report` | Triage via `finish_report` | all outputs, evals | `report.md`, `report.json` | egress profile with check; the tool refuses on a miss |
| `feedback.md` | `triage feedback` / HTTP | evals | run folder | verdict and free text, redacted |
| Audit line | gate | operators, evals | `audit.jsonl` | summary redacted; DSN never logged, only env var name |
| Fixtures | recording mode | mock mode, evals | `fixtures/**` | persisted profile at record time |

## 2. Trust boundaries

```mermaid
flowchart LR
    subgraph U["Untrusted input"]
        SL[Slack thread text and images]
        TX[Free text from caller]
    end
    subgraph M["Model-controlled (selects values, never hosts or credentials)"]
        ORC[Triage / investigators / code walker]
    end
    subgraph C["Trusted code"]
        ING[Ingress]
        GATE[Tool gate + registry + api rules]
        ENV[(.env)]
    end
    subgraph X["External systems"]
        DBS[(Postgres readers)]
        APIS[(Admin APIs)]
        QW[(Quickwit)]
        CBS[(Finacle gateway)]
        SLW[(Slack write API)]
        REPO[(repos/)]
    end

    SL --> ING --> ORC
    TX --> ING
    ORC -->|typed args: service, path, sql, params| GATE
    ENV --> GATE
    GATE --> DBS & APIS & QW & CBS
    ORC -->|repo enum, path| REPO
    ING -->|read only| SLR[(Slack read API)]
    ING -.->|human approval| SLW
```

Rules encoded at the boundary:

1. **The model never supplies a host, a credential, or an entity.** Host comes from `.env` via the registry; entity is fixed in the investigator's closure; credentials are read by the tool from `.env` at call time.
2. **Slack write is not a tool.** Only ingress code paths post, and only after an interactive confirmation (CLI) or an authenticated approval call (HTTP, future Slack button).
3. **Untrusted text is data.** Slack thread content is passed to the model as the problem statement. Any instruction-like text inside it (for example "run this SQL") is still subject to the gate, which does not care where the instruction came from.
4. **Every crossing writes an audit line**, including refusals.
5. **Two redaction profiles.** The model sees the identifiers it needs to search with (account numbers, UTRs, phones, UUIDs); PAN, passport and card numbers are masked even for the model. Everything persisted or leaving the run folder gets the full mask, and `finish_report` refuses to complete if the check finds unmasked PII. Tier models may be Anthropic, OpenAI direct or local Ollama; OpenRouter is allowed only for the classifier, which sees the redacted thread (Q21, D41). Decrypted harbor fields (D34) follow the same two profiles.
6. **Budgets are enforced in code.** Per-run caps on tool calls and delegations; when hit, I/O tools refuse and escalation fires.

## 3. Where time is spent (estimates, not measured)

| Phase | Typical | Bound by |
|---|---|---|
| Ingress incl. Slack fetch | 1–3 s | Slack API |
| Classification | 1–5 s | classifier model (Ollama local can be slower) |
| Identity resolution | 1–3 s | 3 SQL hops over the SSFB tunnel |
| Entity investigation (parallel) | 30–180 s | Quickwit latency and the per-entity concurrency cap; model turns |
| Code walk | 30–120 s | CodeGraph CLI calls, strong model |
| Synthesis + redaction | 10–30 s | model |

The per-entity Quickwit semaphore is the deliberate bottleneck. Removing it is a config change, not a code change, once Quickwit is sized for it.
