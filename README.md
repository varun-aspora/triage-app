# triage-app

A Flue 2.0.8 agent service that triages NRI banking issues across the SSFB, ATSPL and RTL entities. It takes a Slack thread, a thread file or plain text, resolves the customer's ID chain, classifies the issue, picks a model tier, and runs a `Triage` root agent that fans out to per-entity investigators and a code walker. Every data access goes through typed, read-only tools behind a gate (SQL parser and read-only transactions, HTTP rules, scope rule, budgets, redaction, audit). The output is a report in JSON and Markdown; posting it to Slack needs a human's approval. It replaces the triage-shivalik workspace.

## Prerequisites

- Node 22.19 or later (the app runs on Node)
- bun (installs packages, runs scripts and unit tests)
- With `TRIAGE_DB_PROVIDER=postgres`: a Postgres with the pgvector extension installed, for example the `pgvector/pgvector:pg17` Docker image. The run store's first migration runs `CREATE EXTENSION vector` (D43). The default `sqlite` needs neither.

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
| `bun run build` | `vite build` into `dist/`. Not needed to run the CLI or the server, which run from `src/` |
| `bun run ci` | Typecheck, unit tests, contract suite and classifier suite against a temp eval home |
| `bun run triage -- <command>` | The CLI: `run`, `start`, `wait`, `status`, `ask`, `post`, `feedback`, `doctor`, `preflight`, `tunnel`, `repos sync`, `models refresh`, `fixtures review`, `runs`, `evals` |
| `bun run serve` | The polling HTTP API (needs `TRIAGE_HTTP_AUTH_TOKEN`) |
| `bun run dev` | `serve` under `node --watch`: restarts when a file changes |
| `bun run evals:classifier` | promptfoo classifier suite (faux providers by default) |

## Repo sync

The code tools read the repos in `resources/repos.json`, checked out under `TRIAGE_REPOS_DIR`. A sync clones a missing repo, shallow and single-branch, moves every clean checkout to its pinned branch (or the default branch) and refreshes its codegraph index. A checkout with local changes is left alone. Point `TRIAGE_REPOS_DIR` at a folder that holds only these checkouts, not your own working clones.

| Key | Default | What it does |
|---|---|---|
| `TRIAGE_GIT_PROTOCOL` | `ssh` | `ssh` clones `git@<host>:<org>/<repo>.git`, `https` clones `https://<host>/<org>/<repo>.git`. Existing clones of the same repo are switched over. |
| `TRIAGE_GIT_HOST` | `github.com` | |
| `TRIAGE_GIT_ORG` | `Vance-Club` | A pin with its own `remote` ignores it. |
| `TRIAGE_GIT_HTTPS_TOKEN` | blank | `https` only. Passed to git through its environment, never in a URL or `.git/config`. Blank uses the host's git credential helper. |
| `TRIAGE_REPOS_SYNC_INTERVAL` | `24h` | Longest the checkouts go without a sync: `30m`, `2h`, `6h`, `1d` and so on. |
| `TRIAGE_REPOS_SYNC_INTERFACES` | `cli,http,claude-code,slack` | Where the automatic sync runs. A run started on a listed interface syncs first when the last sync is older than the interval, and waits for it. `http` also runs a timer in the server. `none` turns it off. It never runs in mock mode. |

From the CLI:

```bash
bun run triage -- repos sync                 # every repo, now
bun run triage -- repos sync --repo harbor   # one repo
bun run triage -- repos sync --if-stale      # only when older than the interval; for cron or launchd
```

Over HTTP, with the server's bearer token. A sync runs in the background; poll it by its id. The id is kept in the server's memory only and is gone after a restart.

```bash
curl -X POST http://localhost:3000/repos/sync \
  -H "Authorization: Bearer $TRIAGE_HTTP_AUTH_TOKEN"
# 202 {"sync_id":"01K...","status":"running"}; 409 when a sync is already running

curl -X POST http://localhost:3000/repos/sync \
  -H "Authorization: Bearer $TRIAGE_HTTP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"repo":"harbor"}'

curl http://localhost:3000/repos/sync/01K... -H "Authorization: Bearer $TRIAGE_HTTP_AUTH_TOKEN"
# {"status":"done","ok":[...],"skipped":[...],"failed":[...],"results":[...]}; status is running, done, busy or failed

curl http://localhost:3000/repos -H "Authorization: Bearer $TRIAGE_HTTP_AUTH_TOKEN"
# each checkout's branch, commit and drift, the last sync and when the next one is due
```

The same request without curl:

```http
POST /repos/sync HTTP/1.1
Host: localhost:3000
Authorization: Bearer <TRIAGE_HTTP_AUTH_TOKEN>
Content-Type: application/json

{"repo": "harbor"}
```

## Docs

- [docs/README.md](docs/README.md): the design docs, in reading order
- [docs/09-implementation-plan.md](docs/09-implementation-plan.md): the build plan (12 tickets, 101 sub-tickets)
- [docs/10-implementation-notes.md](docs/10-implementation-notes.md): what was built, deviations from the design, open questions
- [CONVENTIONS.md](CONVENTIONS.md): repo layout, file shapes, test placement and commit format
