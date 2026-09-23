---
title: Database
source: https://flueframework.com/docs/guide/database/
section: guides
---

# Database

## What it is

Flue durably stores agent conversations in a database, configured with a single file: `db.ts` in the project source root, whose default export is a persistence adapter. The database holds the runtime's own durable state (conversation streams, accepted submissions, persisted state, attachment bytes) — not your application's business data. Without a `db.ts`, Flue runs on in-memory SQLite and loses everything on restart.

This is a **Node.js-only** concern. On the Cloudflare target every agent conversation is a Durable Object with its own built-in SQLite storage; a `db.ts` file is rejected at build time.

## What Flue stores

- **Canonical conversations** — one append-only stream of records per conversation: user messages, assistant output, tool calls and results, compaction, recovery facts. This stream is the single source of truth; every later turn, reconnecting client, and crash recovery replays it.
- **Accepted submissions** — a prompt or `dispatch(...)` input is recorded durably *before* processing begins, with claims and leases tracking which process owns the work.
- **Persisted state** — every `usePersistentState` write is recorded in the conversation's stream.
- **Attachments** — image/binary payloads stored alongside the conversation as immutable records that the canonical stream references.

Not stored: sandbox files and installed dependencies, external API side effects, provider credentials, your application's own data. When a tool writes to your app's database, Flue stores only the record that the tool was called and what it returned.

## API surface

### `db.ts` entry module

```ts
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

- Discovered by convention from the source root (`.flue/`, `src/`, or the project root) by `vite dev`, `vite build`, and `flue run`.
- Relocate it with the `db` path in the config file. Config reference: default lookup is `db.{ts,mts,js,mjs}` under the source root; on Cloudflare a resolved `db` entry is a hard error (`[flue] Custom persistence (db.ts) is not supported on the Cloudflare target. …`).
- At boot Flue calls the adapter's `migrate()` once, then awaits `connect()` — a misconfigured database fails at startup, not mid-conversation.
- Standalone scripts using `start()` don't go through the build and don't pick up `db.ts`; pass the adapter via the `db` option instead.

### `sqlite(path?: string)` from `@flue/runtime/node`

- Ships with the runtime, no extra dependencies; runs on Node's built-in `node:sqlite`.
- Creates the file and any missing parent directories on first boot, opens in WAL mode.
- `sqlite()` with no argument, or `sqlite(':memory:')`, gives the same in-memory database as the default.

### Ecosystem adapters (`flue add database <backend>`)

Installed as [blueprints](https://flueframework.com/docs/cli/add/) — a Markdown implementation guide your coding agent applies, not a package installer. The blueprint name is the backend's lowercase name:

```sh
flue add database postgres
```

| Backend | Adapter package |
| --- | --- |
| Postgres | `@flue/postgres` |
| Supabase | `@flue/postgres` |
| libSQL | `@flue/libsql` |
| Turso | `@flue/libsql` |
| MySQL | `@flue/mysql` |
| MongoDB | `@flue/mongodb` |
| Redis | `@flue/redis` |
| Valkey | `@flue/redis` |

All share a **bring-your-own-driver** design: the adapter implements Flue's storage contract but never picks, bundles, or configures a driver. You wrap your configured driver in a small runner — typically `query`, `transaction`, and `close` — and hand it to the adapter.

### Custom adapter — `@flue/runtime/adapter`

```ts
interface PersistenceAdapter {
  connect(): PersistenceStores | Promise<PersistenceStores>;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

interface PersistenceStores {
  readonly submissionStore: AgentSubmissionStore;
  readonly conversationStreamStore: ConversationStreamStore;
  readonly attachmentStore: AttachmentStore;
}
```

Contract test suites live in `@flue/runtime/test-utils` — they are the acceptance tests every built-in adapter passes.

## Patterns

### Minimal file-backed SQLite

```ts
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

### Postgres with a bring-your-own `pg` pool

```ts
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (text, params) => (await client.query(text, params)).rows,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
```

Each blueprint generates a complete `db.ts` like this for its ecosystem's standard driver.

### Custom adapter skeleton

```ts
import type { PersistenceAdapter } from '@flue/runtime/adapter';

export default {
  migrate() {
    /* create or verify backing storage */
  },
  connect() {
    return { submissionStore, conversationStreamStore, attachmentStore };
  },
  close() {
    /* release connections */
  },
} satisfies PersistenceAdapter;
```

Because `db.ts` is ordinary TypeScript, the adapter can read connection strings from the environment, construct a driver pool, and export whatever the situation calls for.

## Recommended use cases

- **Single-host Node deployment** that must survive process restarts and redeploys: file-backed `sqlite('./data/flue.db')`.
- **State must survive host loss, or multiple replicas share conversation state**: an ecosystem adapter (Postgres, libSQL, MySQL, MongoDB, Redis).
- **Developing against production storage shape**: add a `db.ts` and all three commands (`vite dev`, `vite build`, `flue run`) use your adapter instead of their defaults.
- **A backend not in the catalog**: implement `PersistenceAdapter` yourself.

## When to use / when NOT to use

**Add a `db.ts` when:** you are on the Node target and conversations, accepted submissions, or persisted state must outlive the process.

**Don't add a `db.ts` when:**
- You are on the **Cloudflare target** — storage is automatic via Durable Object SQLite, and a `db.ts` is a build-time hard error. See the Cloudflare target guide.
- You are in **local development** and the defaults are enough — add one only to develop against production storage.
- The agent is genuinely disposable in production.
- You are using **standalone `start()` scripts** — they bypass the build; pass the adapter through the `db` option instead.
- You want durable **workspace files** rather than conversation history — that's [Sandboxes](https://flueframework.com/docs/guide/sandboxes/), a separate concern. A durable database does not make a sandbox durable, and a durable workspace does not preserve conversation history.
- You want to store **your application's business data** — use your own database access in tools; Flue only records that the tool was called and what it returned.

## Defaults per command (no `db.ts`)

| Command | Without `db.ts` |
| --- | --- |
| `vite dev` | Cache file `node_modules/.cache/flue/dev.db` — history survives code reloads, resets when the dev server cold-starts |
| `flue run` | Cache file `node_modules/.cache/flue/run.db` — never reset, so `--id` continues conversations across invocations |
| `vite build` | In-memory — the deployed server keeps state only for the process lifetime |

## Gotchas & constraints

- **In-memory default loses everything on restart** — conversations, accepted submissions, persisted state.
- **Cloudflare rejects `db.ts` at build time.** Custom adapters do not apply there.
- **File-backed SQLite survives restarts and redeploys on the same machine, not loss of the host.** Move to an external database for host-loss survival or multiple replicas.
- **A shared database does NOT enable active-active scaling.** Each agent conversation still needs exactly one live Node owner at a time; route one live owner per conversation. See [Durability](https://flueframework.com/docs/guide/durability/#nodejs-recovery).
- **No hand-run migrations.** `migrate()` provisions tables idempotently on first boot, reuses them on restart, and stamps a format version — a database written by an incompatible Flue version refuses to start rather than corrupting state.
- **Startup failure is by design**: `migrate()` runs first, then `connect()` is awaited, so an unreachable database fails at boot.
- **The adapter contract has strict atomicity and ordering requirements** — idempotent admission, fenced producer claims, append-only streams. Treat the Data Persistence API as the specification and run the contract test suites.
- The adapter surface is Node-only. The `AgentSubmissionStore` settlement and lease method groups mirror the durable-execution engine and are **subject to change until 1.0**.

## Notes from the adapter contract (one level deep)

For custom adapters, from [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/):

- One contract for every backend — no SQL-only or "expert" tiers; non-SQL backends are first-class. An adapter is correct when all three contract test suites pass. If the docs page and the package differ, the package wins.
- `migrate()` is called **before** `connect()`. Adapters that create schema implicitly may omit `migrate()` but must still uphold the format-version obligation in their store-creating paths.
- Submission status: `queued → running → (terminalizing →) settled`, plus a `joining`/`joined` pair for queued deliveries absorbed into another submission's live response at a turn boundary. Sessions are append-only for the life of the agent instance; no per-session deletion.
- Exported constants: `DURABILITY_DEFAULT_MAX_ATTEMPTS` (`10`), `DURABILITY_DEFAULT_TIMEOUT_MS` (`3_600_000`), `LEASE_DURATION_MS` (`30_000`).
- `ConversationStreamStore` reads: `limit` clamped between `DEFAULT_READ_LIMIT` (`100`) and `MAX_READ_LIMIT` (`1000`); default offset `'-1'` (start); sentinel `'now'` returns no batches and the current head as `nextOffset`; an offset beyond the head throws.
- `append` is all-or-nothing per batch — a partial write corrupts the conversation graph. An exact retry of an already-appended `producerSequence` returns the original offset; a conflicting retry throws.
- The stream is the sole authoritative transcript; an adapter must not model a second transcript in session rows, snapshots, or event streams.
- Optional `putFoldCheckpoint`/`getFoldCheckpoint` is a cache over the log, never authoritative, and must be torn-write safe. Adapters without the pair stay functional; the runtime degrades to full replay and warns once per path.
- `subscribe` is best-effort in-process fan-out, not a durable or cross-process signal.
- Attachments are immutable and verified: re-`put` with different content/metadata/ownership throws `AttachmentConflictError`; byte/size/digest mismatch throws `AttachmentIntegrityError`.
- Helpers and reference implementations exported: `defineSqlConversationStreamStore(dialect)`, `InMemoryConversationStreamStore`, `StreamListenerRegistry`, `formatOffset`/`parseOffset`, `createAttachmentRef`, `verifyAttachmentBytes`, `sameAttachmentRef`, `attachmentBytesEqual`, `copyAttachmentBytes`, `InMemoryAttachmentStore`.

## Related

- [Durability](https://flueframework.com/docs/guide/durability/) — what recovery replays after an interruption, and the one-live-owner rule
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) — full adapter and store contracts
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/) — storage on Cloudflare
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) — durable workspace files, a separate concern
- [Agent Hooks — persisted state](https://flueframework.com/docs/guide/agent-hooks/#persisted-state)
- [Project Layout](https://flueframework.com/docs/guide/project-layout/) — where `db.ts` and the other entry modules live
- [Configuration — `db`](https://flueframework.com/docs/reference/configuration/#db)
- [Ecosystem: Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/), [Supabase](https://flueframework.com/docs/ecosystem/databases/supabase/), [libSQL](https://flueframework.com/docs/ecosystem/databases/libsql/), [Turso](https://flueframework.com/docs/ecosystem/databases/turso/), [MySQL](https://flueframework.com/docs/ecosystem/databases/mysql/), [MongoDB](https://flueframework.com/docs/ecosystem/databases/mongodb/), [Redis](https://flueframework.com/docs/ecosystem/databases/redis/), [Valkey](https://flueframework.com/docs/ecosystem/databases/valkey/)
- [Deploy Agents on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)
- [flue add](https://flueframework.com/docs/cli/add/)
