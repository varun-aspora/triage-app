---
title: flue run
source: https://flueframework.com/docs/cli/run/
bundled_docs: bunx flue docs read cli/run
version: "2.0.8"
reviewed: "2026-09-17"
---

# `flue run`

## Purpose and when

Run one agent module locally without HTTP transport: admit one message, stream activity, print the terminal reply, and exit. Use it for agent iteration, scripts, and CI checks; use the Vite dev server when platform bindings or the deployed HTTP surface matter.

## Command and flags

```bash
bunx flue run <path> --message <text> [--name <agent>] [--id <id>] [--data <json>] [--uid <uid> | --new] [--env <path>] [--json]
```

| Argument or flag | Contract |
| --- | --- |
| `<path>` | Required agent module path, resolved from the current working directory. |
| `-m, --message <text>` | Required user message. |
| `--name <agent>` | Select by `agentName` static or exported function name; required when multiple agents are exported. |
| `--id <id>` | Create or continue this conversation. Default: fresh generated ULID, reported on stderr. |
| `--data <json>` | Creation data for `useInitialData()`; ignored on continuation. Cannot combine with `--uid`. |
| `--uid <uid>` | Continue only this exact conversation incarnation. Cannot combine with `--new` or `--data`. |
| `--new` | Create only; fail if the conversation id already exists. |
| `--env <path>` | Load this `.env`-format file instead of project-root `.env`. Existing shell values win. |
| `--json` | Print one terminal JSON envelope instead of reply text. |

`flue.config.*` is discovered from the current working directory. Conversation state uses the project database entry when present, otherwise `node_modules/.cache/flue/run.db`.

## Output and exit codes

Normal mode prints only the final assistant reply to stdout. Streaming text, tools, status, generated id, and errors go to stderr.

```ts
type RunResult =
  | { id: string; agent: string; submissionId: string; outcome: 'completed'; message: string; uid: string }
  | { id: string; agent: string; submissionId: string; outcome: 'failed' | 'aborted'; error: RunError; uid: string }
  | { outcome: 'error'; error: RunError };

interface RunError {
  message: string;
  type?: string;
  details?: string;
  dev?: string;
}
```

| Outcome | Exit code |
| --- | --- |
| `completed` | `0` |
| `failed` or setup/admission `error` | `1` |
| `aborted` | `130` |

## How to

```bash
# One turn
bunx flue run src/agents/hello.ts -m "Hi there"

# Continue one conversation
bunx flue run src/agents/support.ts -m "It fails." --id support-4821
bunx flue run src/agents/support.ts -m "Bun on macOS." --id support-4821

# Create once with initial data and machine-readable output
bunx flue run src/agents/triage.ts -m "Triage this" \
  --id "issue-$N" --data '{"issue":17307}' --new --json

# Alternate credentials
bunx flue run src/agents/hello.ts -m "Hi" --env .env.staging
```

## Recommended patterns

- Use `--json` and the exit code together in automation.
- Use stable `--id` values to continue conversations; add `--new` when accidental continuation must fail.
- Capture the returned `uid`, then use `--uid` for later incarnation-safe continuation.
- Keep stdout for data and route human diagnostics from stderr separately.

## Avoid

- Do not assume `--data` updates an existing instance; it is creation-only and silently ignored on continuation.
- Do not use `--uid` as a submission idempotency key. It only guards the conversation incarnation; each accepted run is new work.
- Do not import `cloudflare:*` APIs in modules run this way; use the Vite dev environment for bindings.
- Do not expect `src/app.ts` setup, routes, middleware, or top-level provider registration to load.

## Gotchas

- A module with several agents has no silent default; pass `--name`.
- The runner loads only the selected agent module and its imports, never `app.ts`.
- `--env` replaces default `.env` file loading; shell variables still take precedence.
- Durable recovery across process restarts depends on a durable configured database; the fallback cache is project-local development storage.
- A successful admission can execute tool work at least once under recovery. Make externally visible tool effects idempotent.
- `flue.config.*` resolution for `run` differs from the Vite plugin: unknown config keys are silently dropped instead of rejected, and `target`/`agents` are ignored outright (the run is always Node-local; the agent is the explicit `<path>`, not a scan). `db` is honored for persistence.
- `app` and `cloudflare` config entries are resolved but never used by `run` — except that existence is still checked: a configured entry pointing at a file that does not exist fails the run at config-resolution time, even though `run` never reads it.

## Related

- [CLI overview](cli_overview.md)
- [SDK client](sdk_flue-client.md)
- [Durability](advanced_durability.md)
- [Models](guides_models.md)
- [Database](guides_database.md)
