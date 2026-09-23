# GUARDRAILS AND HOOKS (Claude Code + Codex parity)

_Source: read-only survey of ~/code/aspora/triage-shivalik on 2026-09-23 (Opus 5.5 workflow agent). F=fact, I=inference, U=unknown. Not yet reviewed by a human._

All paths are relative to /Users/varun/code/aspora/triage-shivalik. F = FACT (seen in a file), I = INFERENCE, U = UNKNOWN.

## 1. Hook wiring and what each hook does

**Claude `.claude/settings.json` (F, L1-47)** defines three events:
- `PreToolUse`, matcher `Bash`, runs `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/block-raw-curl-psql.py"` (timeout 10).
- `Stop` runs `bash .../.claude/hooks/triage-eval-capture.sh` (timeout 15).
- `SessionStart` runs `bash .../shivalik/scripts/ensure_db_tunnel.sh` (timeout 30; brings up an SSH tunnel to the Shivalik RDS reader) and `.claude/hooks/refresh-repos.sh` (timeout 10).
- No `PostToolUse`, `UserPromptSubmit`, or matchers for Read, Write or MCP tools.

**`.claude/settings.local.json` (F)**
- `permissions.deny` (L72-90) covers only `Read(./.env)`, `Read(./.env.1)`, the `cat/head/tail/less/more/source/.` forms on `.env`, plus `env` and `printenv`.
- `.env.bak.20260913` is not covered by either the deny list or the hook (I: a gap).
- The allow list includes broad `Bash(python3 *)` (L67), both wrappers with wildcards (L60-61, L69), `kubectl config *` and a few `kubectl --context ssfb-prod|ssfb-aspora get ...` commands (L24, L36-39), and one exact bank call: `./shivalik/scripts/cbs_curl_via_eventbus.sh --env prod /customer/api/retail/<id>` (L68).
- `sandbox.enabled:false` (L103-106).
- `enabledMcpjsonServers:["codegraph"]`, backed by `.mcp.json` (`codegraph serve --mcp`).

**block-raw-curl-psql.py (F, L1-521).** The file calls itself "an ACCIDENT-STOPPER ... not a security boundary" (L50-85). How it works:
- It parses stdin JSON. A parse failure means deny, so it fails closed (L490-501). If `tool_name != "Bash"` it returns (L502).
- It joins `\`-newline continuations, turns backticks into `;`, splits on newlines, and tokenizes each line with `shlex(punctuation_chars=True)` (L274-283, L508-517).
- It walks command positions (L286-305): it steps over `VAR=val`, `COMMAND_PREFIXES` (sudo, env, nohup, time, timeout, command, builtin, exec, xargs, if/then/do/else/elif/while/until, !) and the argument-taking prefixes' flags and durations. After `find -exec/-execdir/-ok/-okdir` it treats the next token as a new command.

What it denies (deny output is `hookSpecificOutput.permissionDecision:"deny"`, L263-271):
1. These binaries in command position, matched on basename: `curl, wget, httpie, http, nc, ncat, telnet` (points to safe_curl), and `psql, pgcli, pg_dump, pg_restore, mysql` (points to safe_sql) (L116-129). Also `openssl s_client` (L430).
2. `python*`, `node`, `perl` and `ruby` with inline code (`-c`, `-e`, `-p`), a script file argument, or stdin. The code is regex-scanned for network/DB imports and calls: requests, httpx, aiohttp, socket, psycopg, pg8000, asyncpg, sqlalchemy, pymysql, urllib, http.client; node fetch, http, https, net, tls, axios, pg, mysql; perl LWP and DBI; ruby Net::HTTP and PG (L174-220, L392-413). It also denies literal `.env`/`.env.1` reads from source code (`open('.env')`, `Path(...).read_text`, `readFileSync`, `load_dotenv`) (L231-243). An unreadable script is denied, fail-closed (L362-369).
3. `eval` and `bash|sh|zsh|dash|ksh -c` payloads, re-checked recursively to depth 3 (L453-474).
4. Secret readers (cat, less, grep, awk, sed, cp, source, ., xxd, base64, diff, bat, ...) given a token that matches `(?:^|[/=])\.env(?:\.1)?$` (L162-170, L475-486).

The exemption rule for a script needs both of these (L21-31, L110-113, L356-389):
- the header pragma `# prod-access-lint: allow-file <reason>` within the first 40 lines, and
- a repo-relative path in the closed set `PY_SCAN_ALLOWLIST = {".claude/skills/aspora-logs-finder/scripts/search.py", ".claude/skills/aspora-harbor-shivalik-sim-binding-issue/scripts/search_sim_binding.py"}`.

Both allowlisted scripts are Quickwit readers that use urllib. search.py hardcodes `DEFAULT_URL = "http://quickwit.vance.local:7080"` (search.py L35).

Out of scope by the hook's own admission (L59-77): `$(which curl)`, `P=psql; $P`, `kubectl exec ... -- curl`, `ssh host "curl"`, `docker run`, `./script.py` shebang execution, and `c""url` or `\curl`. Also F: `ssh`, `kubectl` and `qw` are not in BLOCKED_BINARIES at all.

**triage-eval-capture.sh (Stop, F L1-133)**
- Loop guard: exits if `stop_hook_active` is true (L37-38).
- Sentinel path: `$root/.claude/.triage-captured-$session_id` (L43). If it already exists, the hook exits.
- Session start is the first `.timestamp` in `transcript_path`, trimmed to seconds (L60-66).
- It fires only if some line in `.claude/prod-access.log` has `ts >= session_start` (L70-73). It then touches the sentinel (L77) and emits `{"decision":"block","reason":<questionnaire>}` (L133). That tells Claude to run AskUserQuestion (gate, then sections A-D) and write `refs/eval-cases/<date>-<slug>.md` with YAML front-matter (L79-130).
- Admitted gaps: the log has no session id, so concurrent sessions cross-fire (L20-23), and search.py/qw log-only sessions never fire (L25-27).

**refresh-repos.sh (SessionStart, F)** runs `repos/git-clone.sh` in a detached background worker when `repos/.last-refresh` is older than 6h (`CODEGRAPH_REFRESH_MAX_AGE_HOURS`, default 6). It retries after 30 minutes (`CODEGRAPH_REFRESH_RETRY_MINUTES`) and uses a mkdir lock at `repos/.refresh.lock`. It always exits 0.

**Codex parity (F)**
- `.codex/hooks/*` is byte-identical to `.claude/hooks/*` (`diff -r` clean).
- `.codex/hooks.json` has the same three events and matcher `Bash`, but:
  - it hardcodes absolute paths under `/Users/varun/code/work/triage-shivalik/.codex/hooks/...` (L9, L27, L39), which is not this workspace (`/Users/varun/code/aspora/...`);
  - the SessionStart tunnel command still uses `$CLAUDE_PROJECT_DIR` (L21).
- `.codex/config.toml` only registers the codegraph MCP. There is no Codex equivalent of the Read/.env deny list.
- `.agents/skills/aspora-triage/` mirrors the skill (same config JSON), but its SKILL.md points to nonexistent `.Codex/...` paths.

I (Codex):
- The hook would not be found at that path, and how Codex treats a missing or failed hook is U.
- The hook's `PY_SCAN_ALLOWLIST` uses `.claude/` paths, so under Codex `python3 .agents/skills/aspora-logs-finder/scripts/search.py` would be denied.
- Whether Codex sends `tool_name=="Bash"` and honours `hookSpecificOutput` or `decision:block` is U. The eval-capture hook depends on Claude's AskUserQuestion.

## 2. safe_curl.sh: host derivation and allowlist shape

**Host gate (F L474-513).** Allowed hosts are:
- the fixed set `localhost, 127.0.0.1, [::1], *.vance.local`;
- the host of every uncommented key in `.env` whose value starts with http(s). Keys are extracted with a sed on `^\s*(export )?KEY=`, then the value is read from the sourced environment (L477-481). Today those keys are `SHIVALIK_DEBUG_HARBOR_API`, `SHIVALIK_DEBUG_RHYTHM_API` (http, hostname with port) and `SHIVALIK_FINACLE_PROXY_GW` (https hostname);
- any `env:VAR` host named in the non-GET allowlist (L485-499).

`url_host` takes the host after the last `@`, stops the authority at `/ ? #`, and handles bracketed IPv6 (L171-179). The escape hatch `--allow-any-host` also requires `SAFE_CURL_ALLOW_ANY_HOST=1` (L515-529).

**Method gate (F L551-604).** GET and HEAD pass. Any other method needs an entry in the allowlist where all three hold:
- `path.startswith(prefix)`;
- the method is in `methods` (default `["POST"]`);
- a host pattern resolves and `re.fullmatch`es. `*` matches one label (`[^.]*`), and `env:VAR` resolves to the host of that .env URL.

The method is derived from `-X`, `-d/--data*/--json` (which imply POST), `-G` and `-I` (L345-351).

**Curl-option allowlist (F L214-217).**
- Short booleans: `sSivIGfh`. Short with value: `HomwXd`.
- Long options: `silent show-error include verbose head get fail help header output max-time connect-timeout write-out request data data-raw data-binary data-urlencode json retry retry-delay`.
- Everything else is refused by name. Exactly one target is allowed. The script adds `--globoff`, `--max-time 30` (unless set) and a leading `-q` (L608-618).

**Allowlist file.** Real path: `.claude/skills/aspora-triage/config/allowed-non-get-requests.json`, identical copy under `.agents/`. Exact shape (F):
```
{"_comment":"...","allowed":[{"prefix":"/custom/api/","hosts":["env:SHIVALIK_FINACLE_PROXY_GW"],"methods":["POST"],"reason":"..."}, ...]}
```
It has 4 entries, all Shivalik:
- two Finacle custom-script read prefixes (`/custom/api/`, `/api/channel/v1/custom/`) on `env:SHIVALIK_FINACLE_PROXY_GW`;
- two bro paths (`/bro/dashboard/api/v1/dry-run`, and a full `/bro/admin/api/v1/stp-engine/clients/harbor_client/hooks/reference-query`) on `env:SHIVALIK_DEBUG_HARBOR_API`.

There is no ATSPL or RTL entry. `cbs_curl_via_eventbus.sh` reads the same file (L86).

**Gap to the target `resources/{entity}.allow.api.json` `[{api, source}]` (I).**
- Today there is one global file keyed by prefix+hosts+methods+reason; the target is per-entity.
- `api` maps to `prefix`. `source` roughly maps to the `env:VAR` host binding: "harbor" = `SHIVALIK_DEBUG_HARBOR_API`, and bro rides on harbor's host.
- The proposed shape drops four things the current matcher relies on:
  - `methods`;
  - `reason` (printed on every allowed call);
  - prefix vs exact semantics (the bro entry is deliberately a full path so sibling mutating endpoints stay blocked);
  - host binding (the _comment warns that a prefix without a host lets an attacker-chosen host through).
- A `source` needs a resolver from source to base-URL key. Today that resolver is `config/service-api-map.json` (`"shivalik:harbor":{"prod":"SHIVALIK_DEBUG_HARBOR_API"}`, `"shivalik:rhythm":{...}`; only 2 API services, prod only).

## 3. safe_sql.sh: SELECT-only and row cap

This is regex and keyword filtering plus a server-side session setting, not a parser (F L323-374).

1. The script strips `--` comments with sed and `/* */` comments with perl, then trims.
2. It allows one trailing `;` and rejects any other `;` (L331-334).
3. It uppercases and collapses whitespace, and requires `^\s*(SELECT|WITH)\s` (L337-342).
4. It denies these keywords using `(^|[^A-Z])KW([^A-Z]|$)`: `INSERT UPDATE DELETE DROP ALTER TRUNCATE GRANT REVOKE CREATE MERGE CALL EXECUTE COPY VACUUM REINDEX INTO "FOR UPDATE" "FOR SHARE" PG_READ_FILE PG_LS_DIR LO_EXPORT LO_IMPORT DBLINK PG_SLEEP "REFRESH MATERIALIZED"` (L347-354).
5. Row cap: the query is wrapped as `SELECT * FROM ( $CORE ) _capped LIMIT $MAX_ROWS`. The default is 200 (`--max-rows N`, positive integer, no upper bound) (L49, L184, L359).
6. It runs with `PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30s'` (L369).

The connection URL is split into PG* environment variables so the password is not in `psql` argv; unknown query parameters fall back to argv (L257-313). With no query the script does a dry run (L317-321). `-v key=value` values are validated (L186-197).

I:
- Keywords are matched inside string literals and identifiers too: `'CREATE'`, and `_` counts as a boundary, so `last_update` is refused. That means false positives.
- The `--` stripping also cuts inside literals.
- psql does not perform `:'var'` interpolation for `-c` commands (psql-specific feature), so the documented `-v uid=... :'uid'` pattern may not work at all. Verify.

The server role is U. The hook docstring says a read-only DB role "is not done yet" (L81-84). F: Shivalik DB URLs point at a loopback tunnel whose remote end is an RDS `cluster-ro` reader endpoint (`shivalik/scripts/ensure_db_tunnel.sh` L47-49). ATSPL and RTL URLs are direct hostnames.

## 4. How --env and --tenant flow

F:
- **safe_sql:** `--env` is required (prod|uat; `stage` is an alias for uat). The value is looked up in `service-db-map.json` under `"tenant:service"`, or under the bare service name if unambiguous (`workflow` is ambiguous between shivalik and rtl). The map returns an env-var name, which is resolved from the sourced .env. The tenant is back-filled from the map key (L202-241).
  - The map has 14 entries: 9 shivalik, 2 atspl, 3 rtl.
  - Only the RTL entries have `uat` (`RTL_STAGE_*`), and those keys are commented out in `.env`.
- **safe_curl:**
  - With `--service/--path`, `--env` is required and the value is resolved through `service-api-map.json`.
  - With a bare URL, `--env` is optional, defaults to prod with a warning, and is only logged (L447-452).
- **cbs_curl:** env selects the variable prefix `SHIVALIK_` or `SHIVALIK_UAT_` (L232-235). The tenant must be shivalik (L203-210).

I: env and tenant are only a naming key that picks a .env variable. Hosts and credentials already come entirely from .env, so a one-.env-per-entity design collapses each map to `service -> VAR` with no env branching. The audit log keeps tenant and env fields.

## 5. What the hooks cannot catch, and what lint covers

F: CLAUDE.md L116 says the hook "does not cover a Python helper reaching prod via requests/psycopg/urllib — those are still forbidden, just self-enforced ... and checked statically by lint_prod_access.sh". SKILL.md L18-27 adds `./script.py`, `$P`, `kubectl exec -- curl` and `ssh "curl"`, and says the real boundary (read-only role plus egress control) is "not in place yet".

**lint_prod_access.sh (F)**
- Scans every `.sh` and `.py` outside `repos/` and `.git/`, excluding itself and the two wrappers (L405-409).
- Shell: flags curl, psql or wget in command position, using the same prefix stepping as the hook (L278-313). This is stricter for exec prefixes.
- Python: flags only `^(import|from) (requests|psycopg2?|urllib)` (L386). It does not catch httpx, aiohttp, socket, sqlalchemy, or node files.
- Pragmas:
  - line-level `# prod-access-lint: allow <reason>`, `.sh` only, on the same or the previous line;
  - file-level `allow-file <reason>` in the first 40 lines.
- Baseline file: `.prod-access-lint-baseline`, which does not exist today.
- Drift warnings:
  - the lint mirrors the hook's `PY_SCAN_ALLOWLIST` and `COMMAND_PREFIXES` and diffs them on each run (L202-229, L316-330);
  - it warns when a `.py` with a pragma is not on the hook allowlist (L359-366).
- `--self-test` fixture: L128-173. Exit codes: 0 clean, 1 hits, 2 bad usage.
- U: whether it is wired into any CI or hook. It is not referenced in settings.

Other uncovered paths (F):
- The ATSPL `qw` CLI is a sanctioned direct path that does not log (CLAUDE.md L117).
- search.py talks to Quickwit directly.

## 6. `.claude/.triage-captured-*`

F:
- There are 82 files, all 0 bytes. The one read (`c0dfcfd7-...`, Sep 15) is empty.
- They are written by `triage-eval-capture.sh` L77 (`: > "$sentinel"`), named by Claude `session_id`, and gitignored (.gitignore L25).
- They are pure once-per-session markers.
- Output lands in `refs/eval-cases/`: 4 cases exist. The hook comment cites "67 sentinel files against 3 saved cases".

## 7. `.claude/prod-access.log` schema

F:
- Mode 0600, gitignored, 31 lines of one JSON object each: `{"ts":"YYYY-MM-DDTHH:MM:SSZ","tool":"safe_sql|safe_curl|cbs_curl_via_eventbus","tenant":"","env":"","service":"","target":"","summary":"","exit":int}`.
- `target` differs by tool:
  - safe_sql: the env-var name (e.g. `SHIVALIK_DEBUG_HARBOR_DB_CONN_URL`);
  - safe_curl: `host+path`;
  - cbs: `gwhost+path`, with service fixed to `finacle-cbs`.
- `summary` is the query text or `METHOD path?query`.
- Redaction: runs of 6 or more digits become `****last4`. safe_curl also redacts token-like query parameters (safe_curl L139-145; safe_sql L112-115).
- There is no session id and no user.
- All 31 current lines are `safe_sql / shivalik / prod`: bro 22, harbor 5, rhythm, guardian, comms, workflow. The first line is dated 2026-09-13.
- The log is written even on refusal (EXIT trap in safe_sql and cbs; `die()` in safe_curl).

## 8. cbs_curl_via_eventbus.sh mechanism (read as text)

F (`shivalik/scripts/`):
- **Topology** (L41): laptop → `ssh -i $LITBIT_SERVER_IDENTITY -o BatchMode=yes -o ConnectTimeout=10 $BASTION`, where BASTION comes from `--bastion` or `SHIVALIK_TUNNEL_BASTION` (L274-283). On the bastion it runs `bash -s`. Optional `kubectl --context $SHIVALIK_KUBE_CONTEXT`.
- **Pod selection:** the first Running pod in namespace `eventbus-service` with label `app=eventbus`, container `eventbus`, entered with `kubectl exec -i ... -- sh -s` (L90-92, L393-395, L439-441).
- **Token mint** (`mint_token`, L382-404):
  1. On the bastion, it reads `FINACLE_API_USERNAME` and `FINACLE_API_PASSWORD` from secret `rhythm-service/rhythm-external-secret`.
  2. Inside the pod, it runs `curl` to POST `${SHIVALIK_FINACLE_PROXY_GW}/security/oauth` with `grant_type=password`, username, password and scope. Scope comes from `SHIVALIK_FINACLE_OAUTH_SCOPE`, else a hardcoded default at L257.
  3. It greps `access_token` out of the response.
- **Caching:** the token is reused if its expiry is more than 30s away (L407-413). Otherwise it mints a new one, reads `exp` from the JWT (falling back to now+1h), and writes `SHIVALIK_FINACLE_AUTH_TOKEN` and `_EXPIRY` back into `.env` with `upsert_env`, using umask 077 (L361-378, L416-421). The script mutates .env.
- **The call itself:** in-pod `curl -sS --max-time 30` with headers `Authorization: Bearer`, `RequestUUID: asp<7 alnum>`, `Source`, and `SourceIdentifier`. POST happens only if `--data` is given and the path matches the shared allowlist (L288-331). Method-changing extra arguments are refused (L214-223). Other extra arguments are forwarded base64-encoded (L337-340).
- **Env-var flag:** none exists today. Gating is only through permissions and the operator.

I (mechanism risks):
- The line-424 comment says the token travels "via exec stdin (not argv)", but `TOK='$TOKEN'` is part of the ssh remote-command string (L430-434). That puts it in ssh argv on the laptop and the bastion. The Finacle password lands in the in-pod curl argv.
- `URL` and `EXTRA` are interpolated into heredocs inside single quotes, or unquoted. An api-path containing `'`, or crafted extra arguments, could inject shell into the bastion or the pod.
- The extra-argument filter is a denylist, so `--proxy`, `-o`, `-L` or a second URL are allowed. That is weaker than safe_curl's allowlist.

## Key facts

- Claude hooks: PreToolUse(Bash)->block-raw-curl-psql.py, Stop->triage-eval-capture.sh, SessionStart->ensure_db_tunnel.sh + refresh-repos.sh (.claude/settings.json L3-45)
- Hook blocks basenames curl,wget,httpie,http,nc,ncat,telnet,psql,pgcli,pg_dump,pg_restore,mysql and 'openssl s_client' in shlex command position (.claude/hooks/block-raw-curl-psql.py L116-129, L430)
- Hook scans python/node/perl/ruby inline/script/stdin for network/DB imports and .env reads; exemption needs allow-file pragma AND path in PY_SCAN_ALLOWLIST (2 Quickwit readers) (block-raw-curl-psql.py L110-113, L174-243, L356-389)
- Hook self-declares it is an accident-stopper, not a security boundary; kubectl exec/ssh/$(...)/var indirection/./script.py are out of scope (block-raw-curl-psql.py L50-85)
- ssh, kubectl and qw are not in BLOCKED_BINARIES (block-raw-curl-psql.py L116-129)
- .env secret regex matches only .env and .env.1; .env.bak.* is unprotected by hook and by settings.local deny (block-raw-curl-psql.py L162; .claude/settings.local.json L72-90)
- .codex/hooks/* byte-identical to .claude/hooks/*, but .codex/hooks.json hardcodes /Users/varun/code/work/triage-shivalik paths and uses $CLAUDE_PROJECT_DIR (.codex/hooks.json L9,L21,L27,L39)
- safe_curl allowed hosts = localhost,127.0.0.1,[::1],*.vance.local + host of every uncommented http(s) value in .env + env:VAR hosts from allowlist (safe_curl.sh L474-499)
- safe_curl forwards only an allowlisted set of curl options, one target, forces -q --globoff and --max-time 30 (safe_curl.sh L214-217, L358-369, L608-618)
- Non-GET allowlist shape: {allowed:[{prefix,hosts:[literal|*.x|env:VAR],methods:[POST],reason}]}, 4 entries all Shivalik (config/allowed-non-get-requests.json under .claude/skills/aspora-triage/)
- service-api-map.json has only shivalik:harbor and shivalik:rhythm, prod only (.claude/skills/aspora-triage/config/service-api-map.json)
- safe_sql: regex SELECT|WITH prefix + keyword denylist + single-statement check, wraps in SELECT * FROM (...) _capped LIMIT N (default 200), PGOPTIONS default_transaction_read_only=on, statement_timeout=30s (safe_sql.sh L323-372)
- service-db-map.json: 14 tenant:service -> {prod[,uat]: VAR}; only RTL has uat (RTL_STAGE_* commented out in .env) (config/service-db-map.json)
- --env/--tenant are just lookup keys into .env var names; bare-URL safe_curl defaults env=prod with a warning (safe_curl.sh L447-452)
- prod-access.log JSONL schema {ts,tool,tenant,env,service,target,summary,exit}, 6+ digit runs redacted to ****last4, no session id; 31 lines, all safe_sql/shivalik/prod (.claude/prod-access.log; safe_sql.sh L112-143)
- .triage-captured-<session_id> are 0-byte once-per-session sentinels written by triage-eval-capture.sh L77; 82 exist vs 4 eval cases in refs/eval-cases/
- Stop hook fires only if prod-access.log has ts >= transcript's first timestamp; emits decision:block with an AskUserQuestion questionnaire (triage-eval-capture.sh L60-133)
- lint_prod_access.sh: static scan of .sh (command position curl/psql/wget) and .py (import requests|psycopg|urllib only), pragmas + baseline + drift warnings vs hook (lint_prod_access.sh L278-392)
- cbs_curl: ssh bastion -> read secret rhythm-service/rhythm-external-secret -> kubectl exec first Running app=eventbus pod in eventbus-service -> curl POST {GW}/security/oauth password grant; token cached back into .env (cbs_curl_via_eventbus.sh L382-421)
- cbs_curl has no enabling env-var flag today; Shivalik-only; GET unless --data matches the shared allowlist (cbs_curl_via_eventbus.sh L203-210, L288-331)
- Shivalik DB URLs point to a loopback SSH tunnel to an RDS cluster-ro endpoint; ATSPL/RTL DB URLs are direct hostnames (shivalik/scripts/ensure_db_tunnel.sh L47-49; .env shape)
- No QUICKWIT_* key in .env; Quickwit reached via hardcoded quickwit.vance.local:7080 and *.vance.local wildcard (aspora-logs-finder/scripts/search.py L35; safe_curl.sh L474)

## Reusable assets

| Path | What | Verdict |
|---|---|---|
| `.claude/hooks/block-raw-curl-psql.py` | PreToolUse Bash deny hook: shlex command-position scanner, interpreter source scan, .env read block, fail-closed | port: the tokenizer and command-position logic are useful as a pre-exec check for an agent's shell tool. Replace it as the security boundary with typed tools (no raw shell) plus a DB role and egress control. |
| `.claude/skills/aspora-triage/scripts/safe_curl.sh` | GET-only HTTP wrapper with host allowlist from .env, curl-option allowlist, single target, audit log | port: turn the gates (host derivation, method gate, one target, redacted audit) into a typed http_get/http_allowed_call tool. Drop the --env/--tenant branching and the curl argv parsing. |
| `.claude/skills/aspora-triage/scripts/safe_sql.sh` | SELECT-only psql wrapper: regex/keyword guard, LIMIT wrapper, read-only txn, statement_timeout, PG* env conn split | port: keep the read-only session, timeout, row-cap wrapper and audit. Replace the regex guard with a real SQL parser, because of false positives on literals and identifiers. Also fix -v, which is likely not interpolated under -c. |
| `.claude/skills/aspora-triage/config/allowed-non-get-requests.json` | Global non-GET allowlist {prefix,hosts(env:VAR),methods,reason} | port to resources/{entity}.allow.api.json. Keep method, reason, host/source binding and exact-vs-prefix, or the matcher gets weaker. |
| `.claude/skills/aspora-triage/config/service-db-map.json` | tenant:service -> {prod\|uat: ENV_VAR} DB map | replace: with one .env per entity, collapse it to service -> VAR, or derive it by naming convention. |
| `.claude/skills/aspora-triage/config/service-api-map.json` | tenant:service -> {prod: ENV_VAR} API base map (2 entries) | replace: merge into the per-entity source registry that the allowlist 'source' field resolves against. |
| `.claude/skills/aspora-triage/scripts/lint_prod_access.sh` | Static lint for direct network/DB use in repo scripts, pragmas, baseline, drift check | drop (or keep for the legacy workspace): a new agent with only typed tools has no script surface to lint. Port the idea to a CI check on the new codebase if helper scripts remain. |
| `.claude/hooks/triage-eval-capture.sh` | Stop hook that turns prod-touching sessions into labeled eval cases via a questionnaire | port: keep the questionnaire and the refs/eval-cases front-matter schema as a post-run eval-capture step keyed by run id, not by timestamp comparison. |
| `.claude/hooks/refresh-repos.sh` | Background repos/ git pull + codegraph freshness gate with lock and retry | reuse as-is or port to a scheduled job. It is independent of the agent runtime. |
| `shivalik/scripts/cbs_curl_via_eventbus.sh` | SSFB bank CBS read via ssh bastion -> kubectl exec eventbus pod, OAuth mint + cache | port behind an explicit env flag. Fix token-in-argv and quote injection, switch the extra-args filter to an allowlist, and stop writing tokens back into .env. |
| `.claude/prod-access.log` | JSONL audit trail {ts,tool,tenant,env,service,target,summary,exit} | port the schema, adding run/session id, entity, caller interface and allow/deny decision. |

## Unknowns

- Do the DB credentials in .env map to a read-only Postgres role on the server side, for ATSPL and RTL especially, whose URLs are not the SSFB cluster-ro tunnel?
- Does Codex emit tool_name 'Bash' and honour hookSpecificOutput.permissionDecision or decision:block? Were the /Users/varun/code/work/triage-shivalik paths in .codex/hooks.json ever valid on the current machine?
- Is lint_prod_access.sh run anywhere (CI, pre-commit), or only by hand?
- Where does Quickwit live per entity (ATSPL, RTL, SSFB)? Which .env keys should hold its URLs? There is no QUICKWIT_* key today, only the hardcoded quickwit.vance.local and the ATSPL qw CLI behind OIDC.
- Should the new {api, source} allowlist keep per-entry methods, reason, and exact-vs-prefix matching, or is POST-by-prefix intended?
- What is the intended name of the env flag that enables the kubectl/bastion CBS path? Is it per-entity (SSFB only)?
- Was prod-access.log truncated or recreated around 2026-09-13? Sentinels from 2026-09-07 to 09-11, after the Sep 4 access-log gating, exist, but the first log line is 09-13.
- Does psql actually interpolate :'var' under -c in the installed psql version? If not, the documented safe_sql -v pattern silently fails.

## Contradictions

- cbs_curl_via_eventbus.sh L424 says the token goes 'via exec stdin (not argv)', but L430-434 put TOK='$TOKEN' into the ssh remote-command string, so it is in argv on the laptop and the bastion.
- block-raw-curl-psql.py PY_SCAN_ALLOWLIST says 'safe_curl.sh cannot express Quickwit's POST search body today' (L101-104). The allowlist matcher does support '*.vance.local' host patterns and POST prefixes, so the limit is policy, not mechanism.
- CLAUDE.md L118 says --env is required, but safe_curl bare-URL mode and cbs_curl default to prod with only a warning (safe_curl.sh L449-452; cbs_curl L197).
- The service-db-map.json _comment and CLAUDE.md describe uat support, but only RTL has uat entries, and the RTL_STAGE_* keys are commented out in .env. No API or CBS uat is wired.
- The user brief says Quickwit now exists in all entities. The workspace only encodes quickwit.vance.local (search.py L35) plus the ATSPL qw CLI exception (CLAUDE.md L117), and has no per-entity Quickwit config.
- .agents/skills/aspora-triage/SKILL.md references .Codex/skills/... and .Codex/hooks/... paths that do not exist; the real dirs are .agents/ and .codex/.
- The hook docstring claims parity with lint_prod_access.sh, but the lint's Python check covers only requests/psycopg/urllib imports, while the hook also scans httpx, aiohttp, socket, sqlalchemy, asyncpg, node, perl and ruby.
- The triage-eval-capture.sh comment cites '67 sentinel files against 3 saved cases'. Today there are 82 sentinels and 4 cases.
