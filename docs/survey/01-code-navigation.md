# CODE NAVIGATION AND REPOS

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

## Scope and method
Read-only survey of `/Users/varun/code/aspora/triage-shivalik`. FACT: `/Users/varun/code/aspora` is a symlink to `/Users/varun/code/work` (`ls -ld`), so every "work/triage-shivalik" path in logs and configs is the same tree. I ran only local commands: `codegraph --help`/subcommand `--help`, `codegraph status repos/harbor`, and `git log` on local repos. Nothing touched the network.

## 1. How codegraph is used

**Binary (FACT):** `codegraph` 1.6.0 at `~/.local/share/mise/installs/node/22.23.2/bin/codegraph`. It is an npm package (`npm i -g @colbymchenry/codegraph` is the install hint in `repos/git-clone.sh:101`). Subcommands: `init, uninit, index, sync, status, query, explore, context, node, files, daemon, unlock, callers, callees, impact, affected, install, uninstall, telemetry, upgrade`.

**MCP (FACT):** `.mcp.json` registers one stdio server: `{"codegraph":{"type":"stdio","command":"codegraph","args":["serve","--mcp"]}}`. The MCP tools named in root `CLAUDE.md:17-21` (and `AGENTS.md`, same text) are `codegraph_explore` (for a flow or an area: source, call paths and blast radius), `codegraph_node` (one symbol plus callers/callees, or a file with line numbers) and `codegraph_impact`. Every call must pass `projectPath: repos/<name>`.

**CLI fallback (FACT):** `CLAUDE.md:23-27` says: "Shell equivalent when the MCP tools aren't listed (subagents never see them): `codegraph explore -p repos/rhythm "..."`". The help text says `explore` and `node` produce the "same output as the codegraph_explore / codegraph_node MCP tool". Output flags:
- `query`, `callers`, `impact`: `-j/--json`
- `context`: `-f markdown|json`, `-n`, `--no-code`
- `explore`: only `-p`, `--max-files`. No JSON, markdown/text only.
- `node`: `-p`, `-f/--file`, `--offset`, `--limit`, `--symbols-only`. No JSON.
- `install --print-config <id>` prints MCP config snippets without writing anything.

**Index location (FACT):** there is one index per repo at `repos/<name>/.codegraph/codegraph.db` (`repos/AGENTS.md:3-8`). `repos/harbor/.codegraph/` holds `.gitignore` and `codegraph.db` (46.7 MB). `repos/vance-ios/.codegraph/` also has `errors.log`. `codegraph status repos/harbor` reports 619 files, 13,646 nodes, 41,079 edges, `node:sqlite` in WAL mode, 606 Go files. The root `.codegraph/` (codegraph.db ~1.1 MB, daemon.log, daemon.pid, daemon.sock) indexes only the workspace's own Python helpers. `repos/AGENTS.md:16-18` warns: "a bare query without `-p` answers from *that*, not from service source." All 20 repos currently have `.codegraph/`.

**Freshness model:**
- `repos/AGENTS.md:20-32` (FACT) lists three layers: a live FSEvents watcher with 2s debounce, a connect-time catch-up when the MCP server opens a project, and `git-clone.sh` running `codegraph sync` after each pull. It also admits that "the watcher binds to the *default* project (workspace root)" and that cross-project catch-up is not guaranteed.
- `.claude/hooks/refresh-repos.sh:5-8` (FACT) says: "Per-repo indexes have no file watcher (the daemon binds to one project root...), so repos/git-clone.sh is the ONLY thing that ever refreshes all 20." See Contradictions.
- `.codegraph/daemon.log` (FACT) shows "File watcher active" and "Auto-synced N file(s)" only for the root-project daemon. There is also a version mismatch line: server v1.5.0 while v1.6.0 was available.
- SessionStart hook (FACT, `.claude/settings.json:28-45`) runs `ensure_db_tunnel.sh` and then `refresh-repos.sh` (timeout 10s). `refresh-repos.sh` works like this:
  - It gates on `repos/.last-refresh` mtime. `CODEGRAPH_REFRESH_MAX_AGE_HOURS` defaults to 6.
  - A retry guard uses `refresh-repos.log` mtime. `CODEGRAPH_REFRESH_RETRY_MINUTES` defaults to 30.
  - An mkdir lock at `repos/.refresh.lock` carries a pid liveness check.
  - It detaches via `nohup "$0" --worker &`, which runs `git-clone.sh`, touches the stamp on success and overwrites the log.
  - It always exits 0.
  - `.codex/hooks/refresh-repos.sh` is byte-identical. `.codex/hooks.json:27` calls it by the absolute path `/Users/varun/code/work/triage-shivalik/...`.
- Latest log (FACT): `repos/refresh-repos.log` ends with `=== refresh OK 2026-09-23 14:12:06 ===`, including e.g. "vance-ios: Synced 474 changed files" and "harbor: Synced 3 changed files". `repos/codegraph-index.log` holds per-repo `=== sync <repo> ===` blocks ("Synced 3 changed files / Added: 1, Modified: 2 — 104 nodes in 295ms").

**Stated limits (FACT, `repos/AGENTS.md:46-57`; `CLAUDE.md:29-31`):**
- Edges are structural only: no runtime behaviour, no DB schema, no CBS error codes. "A triage finding still needs logs or a DB row."
- No cross-repo edges. `harbor → go-commons` does not appear, so those hops must be traced by hand.
- Markdown, YAML and images are not indexed. `prod-ssfb-aspora-argo` indexes as near-empty. (Harbor status nonetheless lists 8 yaml files, so YAML is at least partly indexed as file nodes. That is INFERENCE from the status output.)
- 14 Objective-C headers in vendored `AppProtectt.xcframework` fail to parse (`repos/vance-ios/.codegraph/errors.log`).
- Cost: init takes guardian 0.8s, harbor 2.4s, vance-ios 11.6s. The whole set is about 650 MB and about 50s serial. A no-op sync takes about 0.6s.

**Other graph tools (FACT):**
- `.serena/project.yml`: project_name `triage-shivalik`, `language_servers: - bash`. `memories/` is empty and `cache/bash` exists. Dated Jul 31. It is not referenced by CLAUDE.md, `.mcp.json` or settings.json.
- `.code-review-graph/graph.db` (512 KB, Sep 3) was auto-generated by the code-review-graph tool and is not referenced in the docs I checked.
- `repos/.claude/settings.json` and `repos/.codex/hooks.json` add a PreToolUse hint for `graphify-out/graph.json` (a "graphify" knowledge graph). No `graphify-out/` exists under repos/, so INFERENCE: this is leftover and currently a no-op.
- INFERENCE: Serena, code-review-graph and graphify are abandoned experiments. codegraph is the current tool.

## 2. Language/stack per repo (FACT: repo root files plus extension counts)
- **Go** (go.mod): audit, banking-service, bro, comms-svc, go-commons, guardian, harbor, package-svc, pdf-generator, reminder-service, rhythm, shivalik-cbs-go (86 .go files, a client SDK).
- **Java/Gradle**:
  - eventbus: 46 .java files, with Dockerfile-ssfb.prod and Dockerfile-stage
  - java-commons: 331 files, multi-module (ai-commons, aws-commons, core-commons, eventbus-producer, ...)
  - kyc-service: 513 files
  - pulse-backend: 914 files (api-server, iam, ingestion modules)
  - workflow-op: 210 .java files, plus a `frontend/` React+Vite+TS app (`workflow-v2-ui`)
- **Kotlin**: vance-android (4,890 .kt, build.gradle.kts).
- **Swift**: vance-ios (4,622 .swift, fastlane).
- **Manifests**: prod-ssfb-aspora-argo (344 yaml, 47 env, 7 lua). It has per-service dirs: audit, bro, cohort, comms, comms-ui, eventbus, guardian, harbor, kafka-connect, kong, kong-internal, kong-vendor, pdf-generator, reminder, rhythm, schema-registry.

Checked-out branches (FACT): most repos are on `pre-prod`. audit, comms-svc, kyc-service, prod-ssfb-aspora-argo and shivalik-cbs-go are on `main`, java-commons on `stage-env`, vance-android on `develop`, vance-ios on `dev`. All are shallow clones.

## 3. Entity ownership (FACT: `CLAUDE.md:43-52`)
- **Shivalik/SSFB:** harbor, rhythm, guardian, comms (repo `comms-svc`), audit, bro, eventbus, pdf-generator, reminder-service, shivalik-cbs-go. prod-ssfb-aspora-argo holds the deploy manifests and is documented in `shivalik/CLAUDE.md`.
- **ATSPL:** pulse (repo `pulse-backend`), package-svc.
- **RTL:** workflow-op, banking-service, kyc-service.
- **Frontend:** vance-android, vance-ios.
- **Shared libraries:** `go-commons` and `java-commons` ("no deploy, no DB").

Cross-check (FACT, from go.mod/build.gradle):
- go-commons is imported by audit, comms-svc, banking-service, bro, harbor, package-svc, guardian, rhythm, pdf-generator, shivalik-cbs-go and reminder-service. So it spans SSFB, ATSPL and RTL.
- java-commons appears in the build.gradle of kyc-service, eventbus, pulse-backend and workflow-op.
- harbor pins `shivalik-cbs-go v1.0.31`, rhythm pins `v1.0.33`.
- INFERENCE: shivalik-cbs-go is a library consumed by harbor and rhythm rather than a deployed service. The ecosystem table lists it as a Shivalik "service", and it has no Dockerfile at root.

The argo manifest dirs match the Shivalik service set, which confirms the SSFB mapping (FACT). Every table entry maps to a directory under `repos/`. None is missing.

## 4. git-clone.sh and git-bare/
**git-clone.sh (FACT, lines 1-107):**
- It `cd`s to its own dir. It uses `ORG=Vance-Club`, `MAX_JOBS=4`, and a hardcoded array of 20 repos (lines 13-34).
- `clone_one`: if a clone exists, it runs `git pull origin <current branch>` and then `index_one sync`. Otherwise it runs `git clone --depth=1 git@github.com:Vance-Club/<repo>.git` and then `index_one init`. So it tracks whatever branch is checked out, and new clones get the remote default branch.
- `index_one`:
  - It is skipped when `CODEGRAPH_INDEX=0` or when codegraph is not on PATH, in which case it warns that "Code navigation degrades to grep".
  - It appends `.codegraph/` to each repo's `.git/info/exclude`.
  - Sync runs without `-q`, and the output goes to `codegraph-index.log`.
  - A repo cloned without `.codegraph/` gets an init backfill.
- It truncates `codegraph-index.log` each run (`: >"$INDEX_LOG"`) and fans out with `xargs -P 4`.
- It needs SSH access to GitHub (`triage-initial-setup/README.md:43`).
- `repos/.gitignore` ignores everything except `.gitignore`, `git-clone.sh`, `AGENTS.md` and `CLAUDE.md`. `repos/CLAUDE.md` is a symlink to `AGENTS.md`.

**git-bare/ (FACT):** a bare repo (`core.bare = true`, HEAD `refs/heads/main`). Its `main` holds the triage workspace itself: CLAUDE.md, `.claude/skills/...`, `repos/git-clone.sh`, `atspl/`, `rtl/`, `shivalik/` docs. It does not hold service code. The root repo's `git remote -v` is `origin /Users/varun/code/aspora/triage-shivalik/git-bare`. git-bare's last commit is 2026-07-28 ("other changes"), while the root HEAD is newer (`19a5cda feat: harden prod-access wrappers...`). It is gitignored at the root (`.gitignore` line "git-bare") and pruned by `triage-initial-setup/merge-claude-md.sh:19`.

INFERENCE: it is a local "remote" used to version or share the workspace (the `.gitignore` also mentions `make-share-zip.sh`, SHARE_VERSION and SHARE_MANIFEST as the real distribution path). It has nothing to do with code navigation, and it looks stale.

## 5. Recommendation for a new (non-Claude-Code) runtime
What the files show:
- The MCP server is invisible to Claude Code subagents (`CLAUDE.md:23`).
- The server's file watcher and connect-time catch-up bind to one default project. Per-repo freshness relies on `git-clone.sh`'s `sync`.
- CLI `explore` and `node` already produce MCP-identical output.
- `query`, `callers` and `impact` offer `--json`. `context` offers `-f json`.
- The daemon is shared through a socket and auto-starts with a 300s idle timeout.

Recommended: make the **CLI the primary tool surface, wrapped as a typed tool** in the new runtime. For example, a `code_explore({repo, query, maxFiles})`, `code_node({repo, symbol|file, offset, limit})`, `code_impact({repo, symbol, depth})` or `code_callers` family, which runs `codegraph <cmd> -p repos/<repo> [--json]` via execFile (no shell).
- The `repo` argument is an enum built from an entity-to-repo map, so no model can omit `-p` and silently hit the root index.
- Output is truncated or capped.

Reasons:
- (a) It works identically for the orchestrator and every subagent.
- (b) There is no long-lived stdio process per agent and no server lifecycle to manage.
- (c) Each call is stateless and auditable, so it can be logged and mocked in evals.
- (d) Freshness is explicit: the runtime can run `codegraph sync repos/<r>` (about 0.6s no-op) before the first query per repo per run, or on a TTL. This stands in for the watcher the docs disagree about.

Tradeoffs of the CLI route:
- It pays process-spawn plus DB-open cost per call. INFERENCE: the daemon may absorb this, but I did not verify whether the CLI uses `daemon.sock`.
- `explore` and `node` return markdown, not JSON.

Optionally **also wrap the MCP server** (`codegraph serve --mcp`) through the runtime's MCP client, for runtimes like Flue that consume MCP natively, or when handing work to Claude Code or Codex. The gains are connection reuse and a worker query pool (daemon.log: "up to 16 worker thread(s)"). The costs are the server lifecycle and the unclear freshness for cross-project `projectPath`. The MCP path also exposes more tools than wanted, so it would still need an allowlist.

Either way, the runtime must:
- keep the grep/read fallback, because docs and YAML are not indexed and argo is near-empty
- have the prompt state that graph output is not evidence
- trace cross-repo hops (e.g. into go-commons or shivalik-cbs-go) with a second call against the library repo
- keep repo refresh (`git-clone.sh`-equivalent) as a separate scheduled job, not something run in the triage request path. It needs SSH or VPN and takes about 50s or more.

## Key facts

- codegraph 1.6.0 is installed via npm/mise at ~/.local/share/mise/installs/node/22.23.2/bin/codegraph (which codegraph; codegraph --version)
- .mcp.json registers a single stdio MCP server: codegraph serve --mcp
- One index per repo at repos/<name>/.codegraph/codegraph.db; root .codegraph/ indexes only workspace Python helpers, so every query must pass -p/projectPath (repos/AGENTS.md:3-18)
- MCP tools used: codegraph_explore, codegraph_node, codegraph_impact; CLI explore/node give identical output; subagents never see MCP tools (CLAUDE.md:17-27)
- CLI JSON output: query/callers/impact support --json and context supports -f json; explore and node have no JSON flag (codegraph <cmd> --help)
- Freshness: SessionStart hook .claude/hooks/refresh-repos.sh runs git-clone.sh detached when repos/.last-refresh is older than CODEGRAPH_REFRESH_MAX_AGE_HOURS (6), with a retry guard of CODEGRAPH_REFRESH_RETRY_MINUTES (30) and an mkdir lock (.claude/hooks/refresh-repos.sh:17-78; .claude/settings.json:28-45)
- git-clone.sh clones 20 Vance-Club repos with --depth=1 over SSH, or git pulls the current branch, then runs codegraph init/sync; MAX_JOBS=4; CODEGRAPH_INDEX=0 skips indexing (repos/git-clone.sh:9-107)
- Stated codegraph limits: structural edges only, no cross-repo edges, docs/YAML not indexed (argo near-empty), 14 ObjC headers fail in vance-ios (repos/AGENTS.md:46-57)
- Go repos: audit, banking-service, bro, comms-svc, go-commons, guardian, harbor, package-svc, pdf-generator, reminder-service, rhythm, shivalik-cbs-go (go.mod at root)
- Java/Gradle: eventbus, java-commons, kyc-service, pulse-backend, workflow-op (plus React/Vite TS frontend/); Kotlin: vance-android; Swift: vance-ios; YAML/argo: prod-ssfb-aspora-argo
- Entity map: SSFB = harbor, rhythm, guardian, comms, audit, bro, eventbus, pdf-generator, reminder-service, shivalik-cbs-go; ATSPL = pulse, package-svc; RTL = workflow-op, banking-service, kyc-service; Frontend = vance-android, vance-ios (CLAUDE.md:43-50)
- Shared libs: go-commons and java-commons, no deploy and no DB (CLAUDE.md:52); go-commons is imported by Go services across SSFB, ATSPL and RTL (go.mod grep)
- harbor and rhythm depend on shivalik-cbs-go v1.0.31 and v1.0.33 respectively (repos/harbor/go.mod:7, repos/rhythm/go.mod:7)
- git-bare/ is a bare repo that serves as the local 'origin' remote of the triage workspace itself; last commit 2026-07-28, older than root HEAD (git remote -v; git -C git-bare log)
- /Users/varun/code/aspora is a symlink to /Users/varun/code/work, so paths in logs and .codex/hooks.json resolve to the same tree
- Latest refresh succeeded on 2026-09-23 14:12:06 (repos/refresh-repos.log tail)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `repos/git-clone.sh` | Clone/pull 20 repos in parallel and run codegraph init/sync per repo, with a backfill | port - keep as a scheduled refresh job outside the request path; move the hardcoded repo list into config/.env or an entity-to-repo map |
| `.claude/hooks/refresh-repos.sh` | Staleness gate + lock + detached worker around git-clone.sh | port - the TTL/retry/lock logic is sound; trigger it from a scheduler or runtime startup instead of a Claude SessionStart hook |
| `.mcp.json` | codegraph stdio MCP server config | reuse as-is if the runtime consumes MCP; otherwise drop in favour of a CLI wrapper |
| `repos/AGENTS.md` | codegraph usage, freshness model, cost and limits | port - fold the limits into the code-walkthrough tool description and system prompt; fix the watcher contradiction |
| `CLAUDE.md (Code navigation + Ecosystem index, lines 9-52)` | Tool routing table and entity-to-repo mapping | port - turn it into a machine-readable entity-to-repo config that drives the repo enum on the code tools |
| `repos/<name>/.codegraph/` | Existing per-repo SQLite indexes | reuse as-is - the new runtime can query them directly via the CLI |
| `repos/.claude/settings.json, repos/.codex/hooks.json` | graphify PreToolUse hint hooks | drop - graphify-out/ does not exist, so they are no-ops |
| `.serena/, .code-review-graph/` | Earlier code-graph tooling state (bash LSP only; auto-generated graph.db) | drop - not referenced by current docs or config |
| `git-bare/` | Local bare remote of the triage workspace | drop - unrelated to code navigation and stale |

## Unknowns

- Does the codegraph CLI (explore/node/query) route through the running daemon socket (.codegraph/daemon.sock) or open the SQLite DB directly on each call? This affects per-call latency for a CLI-wrapped tool.
- Does the MCP server's connect-time catch-up actually apply to repos queried via projectPath, or only to the default project? The docs themselves say it is not guaranteed.
- Should the new agent pin each repo to a specific branch (pre-prod vs main vs prod tag) so code matches what is deployed per entity? Currently it tracks whatever branch happens to be checked out (mostly pre-prod).
- Is shivalik-cbs-go a deployed service or only a library consumed by harbor/rhythm? CLAUDE.md lists it as a Shivalik service, but go.mod usage suggests a library.
- Will the new runtime host have SSH access to github.com/Vance-Club and the ~650 MB of disk for repos + indexes, or will repos be pre-baked into an image?
- Are Serena, code-review-graph and graphify officially abandoned, or still expected in some workflow?
- Is git-bare still the intended remote for the triage workspace, given its last commit (Jul 28) is behind root HEAD?

## Contradictions

- repos/AGENTS.md:20-32 says freshness needs 'nothing to run' because a live FSEvents watcher keeps indexes fresh, while .claude/hooks/refresh-repos.sh:5-8 says 'Per-repo indexes have no file watcher ... repos/git-clone.sh is the ONLY thing that ever refreshes all 20'. daemon.log shows the watcher only for the root project.
- repos/AGENTS.md:53-54 says YAML is excluded from indexing, but codegraph status repos/harbor lists 'yaml 8' under Files by Language.
- repos/AGENTS.md:43 cites 'All 20 repos', which matches git-clone.sh's 20 entries, but the CLAUDE.md ecosystem table lists shivalik-cbs-go as a service even though harbor and rhythm import it as a versioned Go module (library).
- The user brief says Quickwit exists in all entities; that is out of scope here, but the repo-side docs I read cover only SSFB argo manifests (prod-ssfb-aspora-argo). There are no ATSPL/RTL deploy manifest repos under repos/.
- .codegraph/daemon.log shows a v1.5.0 server alongside a v1.6.0 binary at different times; the docs do not state a pinned codegraph version.
