# P5. Standardise on gh CLI for GitHub; repo clone/sync

Source: workflow wf_d09cca81-92f, 2026-09-23. Research agent (Opus) then adversarial critic (Opus). Read-only; no file in either workspace was changed. Status: **proposal, not decided**. Decisions it touches: D37, D11, D2, D32, D5, D20, D41, D19, D27.

## Summary

Recommendation: port git-clone.sh to TypeScript as `triage repos clone|sync|status`. It uses gh for auth, default-branch lookup and the first clone, git for fetch and checkout, and codegraph for indexing, and all of it is driven by resources/repos.json. HTTPS through gh's credential helper replaces SSH keys, so the same code works on a laptop (`gh auth login` once) and on a server (a read-only fine-grained PAT passed in as GH_TOKEN). The model never gets git or gh. This is operator code only.

Three things I found that change the plan:
- All 21 clones are shallow and single-branch (their fetch refspec names one branch only). D37's "check out the branch in repos.json" fails on today's clones unless sync fetches that branch explicitly. The recommended sync does that and moves the clone to the fetched commit with `checkout -B --force` instead of `git pull`.
- The branches people call "mostly pre-prod" are the GitHub default branches recorded at clone time. So "default branch" (Q15) changes nothing for most repos, and it is not the deployed code.
- 16 of the repos ship CLAUDE.md, AGENTS.md or .cursorrules files, meant for coding agents. code_walker will read them, so the repos dir is untrusted input.

Decisions for you: (1) should triage-app get its own repos dir (a fresh clone over HTTPS) or reuse triage-shivalik/repos, which uses SSH remotes? (2) should the code walker get a local `repo_log` (commit history) tool? That needs clones with history (`--shallow-since`) instead of depth 1.

## Questions for the owner

- Should triage-app clone fresh into its own TRIAGE_REPOS_DIR over HTTPS (A), or reuse triage-shivalik/repos and convert its SSH remotes (B)?
- Should HTTPS through gh's credential helper replace SSH keys for GitHub on both laptop and server, with a read-only fine-grained PAT as TRIAGE_GITHUB_TOKEN in server mode? Yes/no.
- Add a local repo_log (commit history) tool for code_walker, which means switching clones from depth 1 to --shallow-since N days? Yes/no, and N.
- Should repo_read exclude repo-level CLAUDE.md/AGENTS.md (A), or keep them readable but labelled untrusted (B)?
- Make resources/repos.json the only repo-to-entity map and drop repos_extra from the entity registry? Yes/no.
- Local preflight: warn only when repos are stale (A), or also start a background sync when TRIAGE_REPOS_AUTO_SYNC=true (B)?

---

## Critic verdict: sound_with_changes

**Conflicts with decisions**

| Decision | Conflict | Resolution |
|---|---|---|
| D11 / D2 (code tools on deep investigators) | The prompt-injection mitigation assumes repo text only reaches code_walker, whose worst case is 'a wrong analysis'. But 02:131-132 mounts code_explore/repo_read/repo_grep on the deep investigators too, and those also hold sql_select, http_call and logs_search (02:123-125). The proposal also adds repo_log to them. | Restate the risk: injected repo text can steer DB, HTTP and log calls on investigate_<entity>_deep. Name what bounds it: D26 scope rule, D31/D40 GET-only, D33 read-only transactions, budget.ts. Or mount repo_log on code_walker only. |
| D11(c) (no git-clone.sh in the request path) | With TRIAGE_REPOS_AUTO_SYNC=true, preflight starts a detached network sync at the start of a run. That sync then rewrites files and indexes while code_walker reads them. The report itself says preflight must not sync for this reason (§3.4), and then offers it as an opt-in. | Drop TRIAGE_REPOS_AUTO_SYNC for v1. Preflight only warns. |
| D43 rejected option (blue/green swap) and the 'sync changes files during a run' risk row | The lock only stops two syncs from racing. It does not stop a sync racing a run. In server mode the CronJob fires no matter which runs are in flight. The rejection reason 'a race the lock already handles' is wrong. | Either have runs take a shared or read lock, or swap one repo at a time (clone or fetch into a sibling dir, then rename atomically). Or accept the race and record it as a residual risk. The owner should choose. |
| D19/D27 and the owner's rule 'never real calls in dev/evals' | Q7's default is to ignore mock mode for `triage repos *`. That lets a developer, or Claude during implementation, clone from GitHub with the default config. Also, code tools are not in mock.ts coverage (02:151), so evals read the live repos dir. repo_log would make eval results depend on when the last sync ran. | Make `repos clone/sync` refuse while TRIAGE_MOCK_MODE=true unless an explicit flag is given, or record the owner's explicit exception. Pin eval inputs by recording the repo sha per eval case, or add code-tool fixtures. |
| D4/D5 (structure lives in resources/, not in env) | TRIAGE_GITHUB_ORG puts structure in env. The org is part of the repo map, not a deployment setting. | Add a top-level `org` to repos.json. Drop the env key. |
| D37 (schema) | D44 changes the D37 shape from `[{repo, entities[], branch}]` to `{repos:[{repo, entities[], branch?, role}]}`, but it only says it 'changes 02 §4.2'. | D44 should say it supersedes the D37 schema. D5's registry text should say repos come only from services.*.repo plus repos.json. |
| D4 (one .env per deployment) | In server mode the app process has no use for the GitHub token; only the sync job does. Putting TRIAGE_GITHUB_TOKEN in the shared .env hands it to the process that runs the model. | Say the token goes only in the sync job's environment (a CronJob secret) and stays blank in the app's .env. Record this as a stated exception to 'one .env'. |

**Factual errors found**

- 'No sh -c' is not fully true. git runs credential helpers through a shell, and the report admits this for the `!` form. So every git network call does go through a shell snippet built from TRIAGE_GH_BIN. The charset check is the real control, not the absence of a shell.
- D46 says the env allowlist applies to 'every execFile'. That would break cbs_call's ssh (SSH_AUTH_SOCK, D30) and the preflight aws/kubectl login (D32), which need their own env. Scope it to the repo and code tools.
- The server-mode lock is described as ported from refresh-repos.sh:41-53 with a pid liveness check. `kill -0 <pid>` means nothing across pods or PID namespaces, so an app pod or a second job could treat a live CronJob's lock as stale and remove it.
- The claim that Flue's schedules guidance applies is loosely cited. advanced_schedules.md:19-27 is about admitting signals into agent conversations with dispatch(). `triage repos sync` is not an agent dispatch, so this is a general ops choice, not a Flue rule.
- `gh repo clone` does more than clone: for forks it adds an `upstream` remote and sets the default remote (FACT, local `gh repo clone --help`). The argv in §2 step 3 does not pass `--no-upstream`.
- Minor: the stale '20' count also appears in refresh-repos.sh:7 and triage-initial-setup/bootstrap.sh:182 ('cloning 20 repos'), not only in docs 00:18 and survey 01.

**Missing**

- The report never labels pieces as v1 or later. Suggested split: v1 is src/repos clone/sync/status plus D42-D44. Later: D45 repo_log, `status --remote` steps 9 and 10, org drift, and the GitHub App token.
- The interaction with CODEGRAPH_SYNC_BEFORE_QUERY (.env.example:102, D11 'optional codegraph sync once per repo per run', 05:57) is not covered. An in-run codegraph sync can overlap with repos sync on the same .codegraph/ and does not take the lock. With a synced mirror it is also redundant.
- repo_log argv lacks `--literal-pathspecs` (or GIT_LITERAL_PATHSPECS=1). A model-supplied path starting with ':' is read as pathspec magic, and the realpath jail does not stop that.
- The git child env does not isolate global and system config (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null or a fixed file). Operator config such as log.showSignature, core.fsmonitor or diff settings can make `git status`/`git log` run other programs.
- Server mode, separate uids: if the CronJob and the app run as different users, git's safe.directory check makes the app's `git rev-parse`, `git status` and repo_log fail with 'dubious ownership'.
- Behaviour when TRIAGE_REPOS_DIR is empty on a fresh server (first 3 GB clone not yet done): code tools should answer 'unavailable', and the run should record a gap.
- Fine-grained PAT expiry and rotation: who renews it, and whether the doctor warns before it expires (UNKNOWN; not stated).
- repo_log output (commit subjects, author names) should pass through the model-facing redaction profile and be persisted through note_evidence's masked profile (D24). The report says it drops author emails but does not say which redaction profile applies.

**Security or data risks**

- Repo content reaches agents that hold DB, HTTP and log tools (the deep investigators, 02:131-132), not only code_walker. The report understates the prompt-injection impact.
- TRIAGE_GITHUB_TOKEN in the app's .env in server mode puts a GitHub credential in the process that runs the model, which does not need it.
- The shell-evaluated credential helper string built from TRIAGE_GH_BIN is an injection point. Dropping TRIAGE_GH_BIN, so the helper is the fixed string `!gh auth git-credential` resolved through the allowlisted PATH, removes it.
- Auto-sync from preflight means GitHub network access and working-tree changes can happen while a run is in progress.
- No customer data flows to GitHub in this proposal: all calls are read-only fetches or metadata, and the PAT is Contents and Metadata read. I found no PII egress path.

**Simplifications**

- Use one transport path. Run all network git operations, first clone included, as plain `git` with the gh credential helper. Keep gh for `auth status`, `auth git-credential` and `repo view`. That drops the dependence on the unverified A-g1 and the fork/upstream behaviour of `gh repo clone`. If the owner insists on `gh repo clone`, add `--no-upstream`.
- Drop TRIAGE_GH_BIN and TRIAGE_GIT_BIN (use PATH), TRIAGE_REPOS_SYNC_CONCURRENCY (the `--jobs` flag is enough), TRIAGE_REPOS_AUTO_SYNC (drop the feature), and TRIAGE_GITHUB_ORG (move it to repos.json). That leaves TRIAGE_GITHUB_TOKEN, TRIAGE_REPOS_MAX_AGE_HOURS, and TRIAGE_REPOS_HISTORY_DAYS only if D45 is accepted.
- Once repos sync re-indexes after every checkout, retire CODEGRAPH_SYNC_BEFORE_QUERY. That leaves one writer of .codegraph/.
- Drop `--fix-remote` and the SSH-remote reuse path. Clone fresh into TRIAGE_REPOS_DIR (the report already recommends this).
- Fold D46 into D11/D2 as a sentence rather than a new decision, and scope it to the repo and code tools.
- Defer `status --remote` steps 9 and 10 (ls-remote, org listing) to after v1. The doctor does not use them.

### Critique

## Critique of Proposal 5 (gh CLI, repo clone and sync)

**Verdict: sound, with changes.** The facts I checked hold, and the core plan fits D37 and D11(c). The plan is: TS operator code, an injected runner, a mirror of a pinned branch, and a token that never goes to the model. The problems are in the extras, in one understated risk, and in the number of knobs.

### Facts I verified
- The clone script: `git-clone.sh:9-10` (ORG, MAX_JOBS=4), 21 repos at `:13-35`, pull of the current branch at `:82-84`, `git clone --depth=1 git@github.com:` at `:90`, and the exclude line and codegraph modes at `:40-76`. All match.
- The hook: `refresh-repos.sh:21` (6h), `:24` (30 min retry), `:41-53` (the lock) and `:78` (the nohup worker) match. It is registered at `.claude/settings.json:39`, and the `.codex` copy is identical.
- Bootstrap: the SSH check is at `bootstrap.sh:179` and the clone at `:183`. Correct.
- Design docs: D37 is at `05:179-181`, D11(c) at `05:58` and D2 at `05:13-16`. `02:132` excludes dotfiles, `02:178` has `repos_extra`, `02:274` lists only `repos sync`, and `02:304` says "needs GitHub SSH". All correct.
- Env keys: `.env.example:33,101,102` have TRIAGE_REPOS_DIR, CODEGRAPH_BIN and CODEGRAPH_SYNC_BEFORE_QUERY. I checked key names only.
- gh: local gh 2.100.0 `--help` lists `defaultBranchRef`, `isArchived`, `sshUrl` and `auth git-credential`. So the default-branch lookup is FACT, not INFERENCE.
- Not verified: the state of the clones (shallow, one branch each) and the 16 repos with agent files. I did not re-run those.

### Main problems
1. **The prompt-injection impact is understated.** The risk table says repo text only reaches code_walker, so "the worst outcome is a wrong analysis". But the code tools are also mounted on the deep investigators (`02:131-132`), and those agents hold `sql_select`, `http_call` and `logs_search` (`02:123-125`). The proposal also adds `repo_log` to them. The real bounds are D26 (scope), D31/D40 (GET/HEAD only) and D33 (read-only transactions), plus `budget.ts`. The table should name them. Consider mounting `repo_log` on code_walker only.
2. **The lock does not do what the risk table says.** It stops two syncs from racing. It does not stop a sync racing a run. In server mode the CronJob fires whatever runs are in flight, so a run can read a half-finished checkout. D43 rejects blue/green because of "a race the lock already handles", and that reason is wrong. A per-repo swap (clone into a sibling dir, then rename) costs one repo's size, not 3 GB. Also, the `kill -0` liveness check does not work across pods.
3. **Auto-sync contradicts the report's own reasoning and D11(c).** §3.4 says preflight must not sync because it changes files under code_walker, then offers `TRIAGE_REPOS_AUTO_SYNC=true` to start a sync from preflight. Drop it.
4. **The in-run `codegraph sync` is not addressed.** D11 (`05:57`) and `CODEGRAPH_SYNC_BEFORE_QUERY` (`.env.example:102`) allow a codegraph sync during a run, which is a second writer of `.codegraph/` outside the lock. Once `repos sync` re-indexes after every checkout, that flag is redundant. Retire it.
5. **Mock mode and the owner's rule.** Q7's default ("ignore mock mode") lets anyone, including Claude during implementation, run real GitHub clones with the default config. That conflicts with the owner's "never real calls in dev/evals". Suggest: `repos clone/sync` refuses while `TRIAGE_MOCK_MODE=true` unless a flag such as `--network` is passed. Separately, the code tools have no fixtures (`02:151` lists sql, http, logs, identity, Slack and doctor probes only). Evals therefore read live repos, and `repo_log` would make results depend on the last sync. Record the repo sha per eval case.
6. **"No sh -c" is not quite true.** git runs credential helpers through a shell, so the charset check on `TRIAGE_GH_BIN` is the actual control. Removing `TRIAGE_GH_BIN` makes the helper a fixed string, and the injection point goes away.
7. **D46 is scoped too broadly.** "An env allowlist for every execFile" would break `cbs_call`'s ssh (D30) and the preflight aws/kubectl login (D32). Scope it to the repo and code tools, and fold it into D11 rather than making it a new decision.

### Smaller points
- `gh repo clone` adds an `upstream` remote for forks (local `--help`), and the proposed argv lacks `--no-upstream`. The simpler option is to use git for every network call, with gh as the credential helper. That gives one auth path and removes assumption A-g1. gh stays for `auth status`, `auth git-credential` and `repo view`, which still meets "standardise on gh" for everything gh is good at. **The owner's call.**
- `repo_log` needs `--literal-pathspecs`, because a path starting with `:` is pathspec magic and the realpath jail does not catch it. It also needs git config isolation (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`), and it should say which D24 redaction profile its output goes through.
- Server mode with different uids for the CronJob and the app will hit git's `safe.directory` check ("dubious ownership") on `rev-parse`, `status` and `log`.
- `TRIAGE_GITHUB_ORG` is structure, which D4/D5 place in `resources/`, so put `org` in repos.json. D44 changes the D37 schema (from an array to `{repos:[…]}` with `role`), so it should say it supersedes D37's shape and not only 02 §4.2.
- In server mode the token belongs only in the sync job's secret, not in the app's `.env`. The model-running process does not need it. This is a stated exception to D4.
- A fresh server with an empty `TRIAGE_REPOS_DIR` needs defined behaviour: the code tools answer "unavailable" and the run records a gap.
- PAT expiry and rotation ownership is not covered.

### Too many knobs
There are eight new env keys. Keep `TRIAGE_GITHUB_TOKEN` and `TRIAGE_REPOS_MAX_AGE_HOURS`, plus `TRIAGE_REPOS_HISTORY_DAYS` only if D45 is accepted. `--jobs` replaces the concurrency key. PATH replaces the two bin keys. repos.json replaces the org key. Auto-sync goes.

### v1 or later
The report does not say which parts are v1. Suggested split:
- **v1**: D42 (git over HTTPS with the gh helper), D43 (mirror plus sha recording), D44 (repos.json as the only map), and `repos clone/sync/status` with local checks only.
- **Later**: D45 `repo_log` with history clones, `status --remote` (ls-remote, org listing), and the GitHub App token.

D45 is also a scope question under D17. It adds a model-facing tool and grows disk use, so it needs an explicit owner yes, not a default.

### PII
No customer data goes to GitHub. All calls are read-only fetches or metadata, and the PAT is read-only. I found no egress path.

---

## Full report

# Proposal 5: standardise on gh CLI for GitHub; repo clone and sync

Legend: **FACT** means I read it in a file or saw it in local command output. **INFERENCE** means I concluded it. **UNKNOWN** means I could not check it. Every command I ran was local. There was no network call and no `gh auth status`, and no file was changed.

## 1. What exists today (facts)

### 1.1 The clone script
`/Users/varun/code/work/triage-shivalik/repos/git-clone.sh`
- `ORG="Vance-Club"`, `MAX_JOBS=4` (:9-10). There are **21** repos in a hardcoded array (:13-35), which now includes `cohort-service`. Docs 00 and survey 01 say 20, so they are out of date.
- `clone_one` (:78-92): if `repo/.git` exists, it runs `git -C repo pull origin <current branch>` (:82-84). Otherwise it runs `git clone --depth=1 git@github.com:Vance-Club/<repo>.git` (:90). The script only follows whatever branch is checked out. It does no pinning, no `--ff-only` and no state output.
- `index_one` (:40-76): adds `.codegraph/` to `.git/info/exclude` (:48-51), then runs `codegraph init` on a first clone or `codegraph sync` on later runs. It backfills `init` when the index is missing (:72-75) and logs to `codegraph-index.log`. It skips indexing when `CODEGRAPH_INDEX=0` or `codegraph` is not on PATH (:97-103).
- It runs `xargs -P 4` over the list (:106).
- **Auth**: SSH only, through the `git@github.com:` URL. There is no gh anywhere. `~/.ssh/config` has a `Host github.com` block (FACT, key names only). No global git credential helper or `url.*.insteadOf` is set (FACT, `git config --global` printed nothing).

### 1.2 What calls it
- `.claude/hooks/refresh-repos.sh` (the `.codex/` copy is byte-identical) is a SessionStart hook (`.claude/settings.json:39`).
  - It runs `git-clone.sh` in a detached `nohup` worker (:78) when `repos/.last-refresh` is older than 6h (:21).
  - It retries after 30 min (:24), takes an mkdir lock with a pid liveness check (:41-53), and always exits 0.
- `triage-initial-setup/bootstrap.sh:173-187` checks `ssh -T git@github.com` (:179), then runs `./git-clone.sh` (:183). It skips the step when 18 or more repos are already cloned.
- `verify-setup.sh:122-128` counts clones and indexes.
- `README.md:43` lists the prerequisite as "GitHub `Vance-Club` org, SSH key added".

### 1.3 State of the 21 clones (FACT, local `git` output)
- **All are shallow**, and `remote.origin.fetch` names **one branch only**. For example, harbor has `+refs/heads/pre-prod:refs/remotes/origin/pre-prod`.
- `origin/HEAD` equals the checked-out branch in every repo.
  - pre-prod: 14 repos.
  - main: audit, comms-svc, kyc-service, prod-ssfb-aspora-argo, shivalik-cbs-go.
  - stage-env: java-commons.
  - develop: vance-android.
  - dev: vance-ios.
- **INFERENCE**: a clone with no `-b` checks out the remote's HEAD, so these branches are the GitHub default branches at clone time. The Q15 answer "map to the default branch" will not move any repo today. Default ≠ deployed.
- Every remote is `git@github.com:Vance-Club/<repo>.git`. Every repo has `.codegraph/`, and the exclude line is present.
- Size: `repos/` is 3.0 GB. The largest indexes are vance-android (447 MB) and vance-ios (255 MB).
- `vance-ios/.gitattributes` uses Git LFS. `git-lfs` is not installed here.
- vance-android and vance-ios each have an **uninitialised submodule**, `Vance-Club/vance-kmm` (SSH URL in one, HTTPS in the other). The shared Kotlin Multiplatform code is therefore not in code navigation today.
- Agent-instruction files inside repos: 13 repos carry `CLAUDE.md` and/or `AGENTS.md`, and 5 carry `.cursorrules`. Together that is 16 repos, for example `harbor/CLAUDE.md` and `rhythm/.cursorrules`.
- Local tools: `gh` 2.100.0, `git` 2.54.0, `codegraph` 1.6.0. `gh config get git_protocol` returns `https`, which does not match the SSH remotes.
- **UNKNOWN**: whether gh is logged in on this machine. Checking would need `gh auth status`, which makes a network call.

### 1.4 What gh 2.100.0 offers (FACT, local `--help`)
- `gh repo clone <repo> [<dir>] [-- <gitflags>...]` passes git flags through. The protocol comes from `git_protocol` unless the argument carries a scheme.
- `gh repo view --json` lists `defaultBranchRef`, `isArchived`, `sshUrl` and `url` among its JSON fields. So the default branch can be resolved.
- `gh auth token`, `gh auth status [--hostname]` (exits 1 on a problem), `gh auth setup-git`, and `gh auth git-credential`, which implements the git credential-helper protocol.
- `gh help environment`: `GH_TOKEN`, then `GITHUB_TOKEN`, take precedence over stored credentials. Also `GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, `GH_CONFIG_DIR`.
- `gh repo list --no-archived --json`.
- `gh repo sync` fast-forwards a branch from a *source* repository, and hard-resets with `--force`.

### 1.5 What the triage-app design already says
- D37 (`docs/05-decisions.md:179-181`): repos.json is `[{repo, entities[], branch}]`. `triage repos sync` checks out, pulls and re-indexes outside the request path. The doctor warns on drift. The report records the commit per repo.
- `docs/02-hld-detailed.md:304` says sync "needs GitHub SSH". `:274` lists only `repos sync`.
- D11(c) (`05:58`) rejects running git-clone.sh in the request path.
- D2 (`05:13-16`): no shell and no sandbox for the model. `repo_read`/`repo_grep` exclude `.git/` and dotfiles (`02:132`).
- `.env.example` already has `TRIAGE_REPOS_DIR` (:33), `CODEGRAPH_BIN` (:101) and `CODEGRAPH_SYNC_BEFORE_QUERY` (:102).
- The SSFB entity registry has `repos_extra` (`02:178`), a second place that maps repos to entities.
- Flue has no scheduler. Its guidance is to use in-process cron on a single Node owner, or an external scheduler, and not an ungated cron in every replica (`.claude/skills/flue-framework/references/advanced_schedules.md:19-27,210-213`).

## 2. Every GitHub interaction the system needs

| # | Interaction | When | Today | Proposed command |
|---|---|---|---|---|
| 1 | Auth check | before clone/sync; doctor | `ssh -T git@github.com` (bootstrap only) | `gh auth status --hostname github.com` |
| 2 | Resolve the default branch when repos.json has no `branch` | clone, sync | implicit via clone | `gh repo view Vance-Club/<r> --json defaultBranchRef,isArchived --jq …` |
| 3 | First clone | `repos clone`/`sync` | `git clone --depth=1 git@…` | `gh repo clone https://github.com/Vance-Club/<r> <dir> -- --depth=1 --single-branch --branch <b> --no-tags` |
| 4 | Point the clone at the pinned branch | sync | not done | `git remote set-branches origin <b>` then `git fetch --depth=1 --no-tags origin +refs/heads/<b>:refs/remotes/origin/<b>` |
| 5 | Update the working tree | sync | `git pull origin <cur>` | `git checkout --force -B <b> refs/remotes/origin/<b>` (mirror semantics, no merge) |
| 6 | Record the commit | sync, report | not done | `git rev-parse HEAD` → `.data/repos/state.json` |
| 7 | Index | after 3 or 5 | `codegraph init`/`sync` | same, via `CODEGRAPH_BIN` |
| 8 | Drift and staleness | doctor, preflight | `verify-setup.sh` counts | `git rev-parse --abbrev-ref HEAD`, `git status --porcelain`, `state.json` age (all local) |
| 9 | Behind remote? (optional) | `repos status --remote` | none | `git ls-remote origin refs/heads/<b>` |
| 10 | Org drift (optional) | `repos status --remote` | none | `gh repo list Vance-Club --no-archived --json name -L 500` |
| 11 | "What changed recently" | during triage | not in the design | see §3.5: local `git log` only, no gh in the request path |

What needs to be on PATH: `gh`, `git` and `codegraph` (binaries can be overridden by env). `git-lfs` is **not** required, and sync sets `GIT_LFS_SKIP_SMUDGE=1` so an installed LFS does not trigger downloads.

## 3. Options considered and recommendation

### 3.1 Options
- **A. Keep `git-clone.sh` as is (copy it in).** It duplicates the repo list, supports SSH only (no clean headless story), follows the current branch instead of repos.json, has no state output, and cannot be unit-tested. Rejected.
- **B. Rewrite in bash, reading repos.json with `jq` and using gh.** Meets the gh ask, but it adds `jq`, is a second language in a TS app, and the argv cannot be tested the way the gate is tested. Rejected.
- **C. TS port using git over SSH only.** A server would need an SSH key for a machine user; deploy keys are per repo, which would mean 21 keys. It does not meet "standardise on gh". Rejected.
- **D. TS port: gh for auth, metadata and clone; git for fetch and checkout; codegraph for index.** Recommended.
- **E. TS port using `gh repo sync` for updates.** It is built to sync a branch from a *source* repository and hard-resets with `--force`. Its behaviour on shallow single-branch clones is unverified, and it hides the refspec. Rejected; git fetch plus checkout is explicit.
- **F. Octokit REST (tarball download, metadata).** No incremental update (full downloads, 3 GB), no commit history, a new dependency, and not what the owner asked for. Rejected. gh covers the metadata need.
- **G. GitHub App installation token instead of a PAT.** Short-lived and org-owned, but needs app setup and minting code. Deferred. gh accepts an installation token as `GH_TOKEN`, so switching later is a config change.

### 3.2 Recommendation (option D)
`src/repos/` is plain operator code, not a Flue tool.
- It exports `clone`, `sync` and `status`, and takes an injected `Runner` (an `execFile` wrapper) so unit tests assert argv without spawning anything. This follows the rule of no real calls in dev or evals.
- Every child process gets `execFile(bin, fixedArgs, {env: childEnv})`:
  - No `sh -c`.
  - `childEnv` is an allowlist: `PATH`, `HOME`, `LANG`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GIT_LFS_SKIP_SMUDGE=1`, plus `GH_TOKEN` taken from `TRIAGE_GITHUB_TOKEN` only when that is set.
- **Auth in one path for both modes**: HTTPS through gh's credential helper.
  - Every git network call runs with `-c credential.helper= -c credential.helper=!<TRIAGE_GH_BIN> auth git-credential`. This means no global gitconfig change, and no token in any remote URL or `.git/config`.
  - `TRIAGE_GH_BIN` is charset-checked because git runs `!` helpers through a shell.
  - **INFERENCE**: `gh repo clone` injects the same helper for its own clone. To be confirmed once, manually, by the operator.
  - Local mode: `gh auth login` once, and gh uses the stored login.
  - Server mode: set `TRIAGE_GITHUB_TOKEN`. gh uses it as `GH_TOKEN`.
  - No code branches on `TRIAGE_DEPLOY_MODE`, so D32 holds.
- **Branch names** from repos.json or `defaultBranchRef` are validated with `git check-ref-format --branch` and must not start with `-`.
- **Mirror, not working copy**: if `git status --porcelain` (with `.codegraph/` excluded) is not empty, sync refuses that repo unless `--force`. It never runs `git clean -x`, because that would delete `.codegraph/`.
- **Lock**: `TRIAGE_REPOS_DIR/.sync.lock` with a pid liveness check, ported from `refresh-repos.sh:41-53`, so two syncs never race.

### 3.3 `triage repos` subcommands

| Command | Network | What it runs |
|---|---|---|
| `triage repos status [--repo r] [--remote] [--json]` | none by default | Per entry: present, current vs expected branch, HEAD sha, dirty, shallow, remote protocol, `.codegraph/` present, last sync age from `state.json`, and the default branch last resolved. `--remote` adds step 1 (`gh auth status`), step 9 (`git ls-remote`) and step 10 (`gh repo list`) to report "behind by", renamed or archived. The doctor calls the local part only. |
| `triage repos clone [--repo r]` | yes | Step 1, then for each entry **missing on disk**: step 2 when `branch` is empty, step 3, write `.git/info/exclude`, `codegraph init <dir>`, then step 6. It never touches an existing directory. |
| `triage repos sync [--repo r] [--jobs n] [--force] [--dry-run]` | yes | Takes the lock, runs step 1, calls `clone` for missing repos, then for each present repo: checks the remote URL is `https://github.com/<org>/<repo>` (warns and stops for that repo otherwise, unless `--fix-remote`), steps 2, 4, 5, `codegraph sync` (or `init` if the index is missing), step 6. Runs `n` repos in parallel (default from env, 4 as today). `--dry-run` prints the argv plan and runs nothing. Output is one line per repo, like the current log. |

`repos sync` exists only in the CLI. There is no HTTP route and no Flue tool.

### 3.4 Periodic pull
- **Local**: `preflight.ts` compares the `state.json` age with `TRIAGE_REPOS_MAX_AGE_HOURS` (default 6, as today) and adds a `preflight.warnings[]` entry: "repos 9h old; run `triage repos sync`". Preflight does not start the sync, because a sync during a run changes files under code_walker.
  - Opt-in: `TRIAGE_REPOS_AUTO_SYNC=true` starts a detached sync, as `refresh-repos.sh` does today.
  - A run that starts while the lock is held records "repos syncing" in `gaps[]`.
- **Server**: a platform scheduler (a k8s CronJob or similar) runs `triage repos sync` against the same persistent volume, with a single writer enforced by the lock. Following the Flue schedules guidance, there is no in-process cron in the app.

### 3.5 "What changed recently" (not in the current design; I think a narrow version is worth adding)
- Past cases often ask whether a recent merge broke a flow. The harbor pull on 2026-09-23 changed `customer_service.go`, which is the kind of change a triage wants to see.
- Depth-1 clones hold **one commit**, so `git log` is useless today.
- Proposal: an optional `repo_log` tool on `code_walker` and `investigate_<entity>_deep`.
  - Model input: `{repo: enum, since?: date, path?: string, max?: ≤50}`.
  - It runs `execFile(git, ['-C', dir, 'log', '--no-color', '--no-ext-diff', '--format=%H%x1f%ad%x1f%an%x1f%s', '--date=iso-strict', `--since=${iso}`, '-n', max, '--', jailedPath])`.
  - `since` is parsed by code, `path` is realpath-jailed and placed after `--`, and there is no free-form flag. Git options such as `--output` write files, so argv is fixed.
  - It is purely local, with no gh and no token in the request path. Author emails are left out of the format.
- It needs clones with history: `TRIAGE_REPOS_HISTORY_DAYS=30` switches clone and fetch to `--shallow-since=<date>` instead of `--depth=1`. When the value is `0`, the tool is not mounted.
- **INFERENCE**: `prod-ssfb-aspora-argo` history shows when SSFB image tags changed. That is the closest thing to a deploy timeline we have, and it answers "was this deployed before the incident".
- Reading PRs through `gh pr list`/`gh api` during a run is **not** recommended for v1. It adds network access and a token to the request path, and PR bodies are more untrusted text.

## 4. Env keys to add (names only)

```
TRIAGE_GITHUB_ORG=              # GitHub owner for all repos in resources/repos.json (Vance-Club)
TRIAGE_GITHUB_TOKEN=            # server mode: fine-grained PAT, read-only Contents+Metadata; passed to gh/git child processes as GH_TOKEN only; blank = use `gh auth login`
TRIAGE_GH_BIN=                  # path to gh (default gh); charset-checked, used in the git credential helper
TRIAGE_GIT_BIN=                 # path to git (default git)
TRIAGE_REPOS_SYNC_CONCURRENCY=  # parallel repos during clone/sync (default 4, as MAX_JOBS today)
TRIAGE_REPOS_MAX_AGE_HOURS=     # preflight warns when the last sync is older (default 6)
TRIAGE_REPOS_AUTO_SYNC=         # local preflight starts a detached sync when stale (default false)
TRIAGE_REPOS_HISTORY_DAYS=      # 0 = depth-1 clones and no repo_log tool; N = --shallow-since N days (only if §3.5 is accepted)
```
`TRIAGE_REPOS_DIR` already exists (`.env.example:33`); its default becomes `$TRIAGE_HOME/repos` (gitignored).

**Why not `GH_TOKEN` in `.env`**: if the CLI loads `.env` into `process.env`, every child process inherits it, codegraph included. A triage-specific name that is copied into `GH_TOKEN` for gh/git children only keeps the token out of every model-facing process. It also stops an operator's exported `GH_TOKEN` from overriding their own login by surprise.

**PAT scope**: fine-grained, resource owner Vance-Club, selected repositories (the 21, plus vance-kmm if added), Contents: read, Metadata: read. **UNKNOWN**: whether the org requires approval for fine-grained PATs or enforces SAML SSO authorisation. A classic PAT needs `repo`, which includes write, so it is rejected.

### `resources/repos.json` schema

```json
{
  "repos": [
    { "repo": "harbor",          "entities": ["ssfb"],               "role": "service" },
    { "repo": "workflow-op",     "entities": ["ssfb", "rtl"],        "role": "service" },
    { "repo": "go-commons",      "entities": ["ssfb", "atspl", "rtl"], "role": "library" },
    { "repo": "java-commons",    "entities": ["ssfb", "atspl", "rtl"], "role": "library", "branch": "stage-env" },
    { "repo": "prod-ssfb-aspora-argo", "entities": ["ssfb"],         "role": "manifests" },
    { "repo": "vance-android",   "entities": ["ssfb", "atspl", "rtl"], "role": "mobile" }
  ]
}
```
- `repo`: `^[A-Za-z0-9._-]+$`. The owner comes from `TRIAGE_GITHUB_ORG`.
- `branch` is optional. When it is absent, the default branch is resolved on every sync and recorded in `state.json`. When present, it wins (Q15).
- `role` feeds the `repo-map` skill.
- Entities per survey 01 §3: 12 SSFB, 2 ATSPL, 3 RTL; libraries and mobile apps cover all three; workflow-op covers both SSFB and RTL copies.
- Loader checks: no duplicates; every `services.*.repo` in `<entity>.entity.json` exists here; every entity is enabled or known.
- **Proposed**: remove `repos_extra` from `ssfb.entity.json` (`02:178`) so this file is the only repo→entity map.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Prompt injection from repo content.** 16 repos ship CLAUDE.md, AGENTS.md or .cursorrules, and any file or comment could carry text meant to steer a model. | The model gets no git, gh or shell tool (D2, D11); `instrument()` denies unknown tool names. code_walker has only read-only code tools and `note_evidence`, so the worst outcome is a wrong or wasted analysis, capped by `budget.ts`. `repo_read`/`repo_grep`/`repo_log` results are wrapped as `{untrusted: "repository content", …}` and the instruction says file text is data, not instructions. Dotfiles are already excluded (`02:132`), which covers `.cursorrules`. `CodeFindings` must cite `file:line`, and the orchestrator treats them as claims. Whether to exclude CLAUDE.md/AGENTS.md as well is open (§7). |
| Token leaks into a model-facing process or a file | `TRIAGE_GITHUB_TOKEN` is passed only to gh/git children. The codegraph `execFile` gets the same env allowlist without it. The token is never written into a remote URL. Audit lines name the env var, never the value (D20). |
| Code execution from a cloned repo | Hooks are not cloned. Submodules are not recursed (default; stated in argv). `GIT_LFS_SKIP_SMUDGE=1`. Git stays current via doctor version check (INFERENCE: past clone CVEs involved submodules and symlinks). |
| Sync changes files during a run | Lock file. Preflight never syncs unless opted in. The report records the sha per repo taken at code-walk time (D37). |
| Checkout fails on shallow single-branch clones | Explicit refspec fetch plus `set-branches` (§2 step 4). Unit-tested argv. |
| Default branch ≠ deployed code | Stated in the `repo-map` skill. The argo repo history (§3.5) is the deploy signal. Pin `branch` where deployed ≠ default. |
| Mixed SSH/HTTPS remotes if triage-shivalik/repos is reused | Sync refuses a non-HTTPS remote unless `--fix-remote`. Recommend a fresh dir (§7). |
| Evals or dev accidentally hit GitHub | Injected `Runner`; tests use a fake; `--dry-run`; evals never import `src/repos`. |

## 6. Decisions to add or change (numbering to be assigned on merge)

### D42. GitHub access is operator code only, through gh and git over HTTPS (refines D37, D11(c))
- **Chosen**: `src/repos/` in TypeScript. `gh auth status`, `gh repo view --json defaultBranchRef` and `gh repo clone` for auth, metadata and first clone; `git fetch`/`checkout` with gh as a per-invocation credential helper for updates; codegraph for indexes. The same code serves local (`gh auth login`) and server (`TRIAGE_GITHUB_TOKEN` → `GH_TOKEN`, fine-grained PAT, Contents and Metadata read-only). CLI only: no HTTP route, no Flue tool.
- **Rejected**: copying `git-clone.sh` (hardcoded list, SSH only, follows the current branch); bash with `jq`; git over SSH (a machine key or 21 deploy keys headless); `gh repo sync` (source-repo semantics, hard reset); Octokit tarballs (no incremental update, no history); `gh auth setup-git` (mutates the global gitconfig); `GH_TOKEN` directly in `.env` (every child process would inherit it).
- **Consequence**: `02:304` "needs GitHub SSH" becomes "needs gh auth". `bootstrap.sh`'s SSH check becomes `gh auth status`.

### D43. The repos dir is a read-only mirror of the pinned branch
- **Chosen**: sync fetches `+refs/heads/<b>` explicitly into shallow clones and runs `checkout --force -B <b>`. It refuses a dirty tree unless `--force`, never cleans `.codegraph/`, and writes `state.json {repo, branch, default_branch, sha, synced_at}` that the report and doctor read. It is locked, with parallelism from env.
- **Rejected**: `git pull` (merges, fails on divergence, cannot switch branch on single-branch clones); blue/green directory swap (doubles the 3 GB for a race the lock already handles).

### D44. `resources/repos.json` is the only repo → entity map (changes 02 §4.2)
- **Chosen**: `{repos: [{repo, entities[], branch?, role}]}`; the owner comes from `TRIAGE_GITHUB_ORG`; `repos_extra` is removed from entity registries; the loader cross-checks `services.*.repo`.
- **Rejected**: keeping both (two places to update, and they drift).

### D45 (pending owner). Commit history as a local, typed tool
- **Chosen if accepted**: `repo_log` on code_walker and the deep investigators. It is fixed-argv `git log` over the local clone and is mounted only when `TRIAGE_REPOS_HISTORY_DAYS > 0`, which switches clones to `--shallow-since`.
- **Rejected**: PR or commit reads through gh during a run (network and token in the request path, more untrusted text); giving the model `git`.

### D46. The repos dir is untrusted input
- **Chosen**: repo tool results are labelled untrusted, dotfiles are excluded, and the child-process env is an allowlist for every `execFile`, codegraph included.
- **Rejected**: trusting repo content because it is "our code". Third-party agent files are in 16 repos.

## 7. Open questions for the owner
1. A fresh `TRIAGE_REPOS_DIR` cloned over HTTPS, or reuse `triage-shivalik/repos` (3 GB, SSH remotes)? Reusing it and converting remotes to HTTPS would break the old workspace's plain `git pull`.
2. Add `repo_log` and history clones (`TRIAGE_REPOS_HISTORY_DAYS`)? If yes, what default: 30 days?
3. Should `repo_read` also exclude repo-level `CLAUDE.md`/`AGENTS.md`, or keep them readable and labelled untrusted? They sometimes carry useful domain notes.
4. Add `vance-kmm` (the shared mobile code, currently an uninitialised submodule in both apps) as its own repos.json entry?
5. Server scheduler: who owns the CronJob, and at what interval (6h, as today)?
6. Does Vance-Club require approval for fine-grained PATs or SAML SSO authorisation? Who issues the token?
7. Should `triage repos *` refuse to run while `TRIAGE_MOCK_MODE=true` (the default), or ignore mock mode because it touches no entity data? My default: ignore it, but never call it from evals.

## 8. Rejected alternatives (summary)
- Keep `git-clone.sh`.
- Bash with `jq`.
- git over SSH only.
- `gh repo sync`.
- Octokit/REST tarballs.
- GitHub App token for v1: deferred, not rejected.
- `gh auth setup-git`.
- `GH_TOKEN` in `.env`.
- `git pull` for updates.
- Blue/green directory swap.
- Sync inside preflight by default.
- In-process cron in the app.
- PR reads through gh during a run.
- A generic git tool for the model.
- Keeping `repos_extra` alongside repos.json.

## Assumptions
- **A-g1**: `gh repo clone` over HTTPS authenticates through gh's own helper (INFERENCE; confirm manually once).
- **A-g2**: the 21 repos in `git-clone.sh:13-35` are the complete v1 set, plus optionally vance-kmm.
- **A-g3**: `.env` is loaded into `process.env` by the CLI. That is why the separate token name matters; if it is not, the rule still costs nothing.
- **A-g4**: the server volume is persistent and shared between the CronJob and the app.
