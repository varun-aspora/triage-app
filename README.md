# triage-app

A Flue 2.0.8 agent service that triages NRI banking issues across the SSFB, ATSPL and RTL entities. It takes a Slack thread, a thread file or plain text, resolves the customer's ID chain, classifies the issue, picks a model tier, and runs a `Triage` root agent that fans out to per-entity investigators and a code walker. Every data access goes through typed, read-only tools behind a gate (SQL parser and read-only transactions, HTTP rules, scope rule, budgets, redaction, audit). The output is a report in JSON and Markdown; posting it to Slack needs a human's approval. It replaces the triage-shivalik workspace.

## Prerequisites

- Node 22.19 or later (the app runs on Node)
- bun (installs packages, runs scripts and unit tests)

## Setup

```bash
bun install
```

Configuration comes from one `.env` in a directory you name with `TRIAGE_HOME`. The loader reads `$TRIAGE_HOME/.env` and `$TRIAGE_HOME/resources/`, never the current directory.

```bash
export TRIAGE_HOME=/absolute/path/to/triage-home
mkdir -p "$TRIAGE_HOME"
cp -n .env.example "$TRIAGE_HOME/.env"
cp -R resources "$TRIAGE_HOME/"
```

Relative paths in the `.env` resolve under `TRIAGE_HOME`, so point `TRIAGE_KNOWLEDGE_DIR` and `TRIAGE_FIXTURES_DIR` at this repo's `knowledge/` and `fixtures/` (absolute paths), or copy them in as well.

Mock mode is the default (`TRIAGE_MOCK_MODE=true`, `TRIAGE_MOCK_STRICT=true`): every I/O tool answers from reviewed fixtures and a missing fixture fails loudly. Credentials in `.env.example` are blank; a blank value turns off the feature that needs it. `triage doctor` lists what is on, off and why.

## Scripts

| Script | What it does |
|---|---|
| `bun run typecheck` | Regenerates the import lists, then `tsc --noEmit` |
| `bun run test` | Unit tests (`bun test ./src ./test ./scripts ./integrations`) with the no-I/O guard |
| `bun run test:contract` | Vitest contract tests on Node with the fake model |
| `bun run build` | `vite build` into `dist/` |
| `bun run ci` | Typecheck, unit tests, contract suite and classifier suite against a temp eval home |
| `bun run triage -- <command>` | The CLI: `run`, `start`, `wait`, `status`, `ask`, `post`, `feedback`, `doctor`, `preflight`, `tunnel`, `repos sync`, `fixtures review`, `runs`, `evals` |
| `bun run serve` | The polling HTTP API (needs `bun run build` and `TRIAGE_HTTP_AUTH_TOKEN`) |
| `bun run evals:classifier` | promptfoo classifier suite (faux providers by default) |

## Docs

- [docs/README.md](docs/README.md): the design docs, in reading order
- [docs/09-implementation-plan.md](docs/09-implementation-plan.md): the build plan (12 tickets, 101 sub-tickets)
- [docs/10-implementation-notes.md](docs/10-implementation-notes.md): what was built, deviations from the design, open questions
- [CONVENTIONS.md](CONVENTIONS.md): repo layout, file shapes, test placement and commit format
