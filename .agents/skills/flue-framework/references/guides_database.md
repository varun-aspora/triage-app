---
title: Database
source: https://flueframework.com/docs/guide/database/
bundled_docs:
  - guide/database
  - guide/durability
  - guide/node-target
  - guide/cloudflare-target
  - reference/configuration
  - reference/data-persistence-api
version: 2.0.8
reviewed: 2026-09-17
---

# Database

## What and when

Flue persistence stores runtime-owned durable state: canonical conversation streams, submission admission and settlement state, `usePersistentState` records, and immutable attachment bytes. It does not replace the application's business database and does not persist sandbox files.

Database configuration is target-specific:

| Target | Persistence |
| --- | --- |
| Node | A `db.ts` persistence adapter; production defaults to process-local in-memory SQLite when absent. |
| Cloudflare | Per-agent-instance Durable Object SQLite; `db.ts` is unsupported and causes a build error. |

Add `db.ts` for a Node deployment whenever admitted work or conversation history must survive process exit. Use external storage when state must survive host loss or be visible to replacement replicas.

## Current API and configuration

### `db.ts`

```ts
// src/db.ts
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

The source root is the first existing location in this order: `.flue/`, `src/`, project root. The default lookup is `db.{ts,mts,js,mjs}`. Override it in project-root `flue.config.ts`:

```ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
  db: './src/persistence.ts',
});
```

Relative configured entry paths resolve from the config file's directory. Flue runs `migrate()` before `connect()` and fails startup if either cannot initialize the store.

### Built-in SQLite

```ts
import { sqlite } from '@flue/runtime/node';

function sqlite(path?: string): PersistenceAdapter;
```

- `sqlite('./data/flue.db')`: file-backed, creates missing parent directories, opens in WAL mode.
- `sqlite()` or `sqlite(':memory:')`: process-lifetime in-memory storage.
- The adapter uses Node's built-in `node:sqlite`; Flue 2.0.8 requires Node `>=22.19.0`.

### Adapter contract

```ts
import type { PersistenceAdapter } from '@flue/runtime/adapter';

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

The contract requires idempotent admission, atomic first-writer settlement, fenced producer claims, ordered append-only streams, and immutable verified attachments. Use the three contract suites from `@flue/runtime/test-utils`; package types and suites are the executable specification.

### Defaults without `db.ts`

| Consumer | Default |
| --- | --- |
| `bunx vite dev` | `node_modules/.cache/flue/dev.db`; survives reloads, reset on cold dev start. |
| `bunx flue run` | `node_modules/.cache/flue/run.db`; retained across invocations. |
| Built Node server from `bunx vite build` | In-memory; all runtime state is lost on process exit. |

Standalone `start()` scripts do not discover `db.ts`. Pass `db` directly:

```ts
import { start, sqlite } from '@flue/runtime/node';

await using flue = await start({
  agents: [Reporter],
  db: sqlite('./data/script.db'),
});
```

## How to: choose and configure production persistence

### 1. Choose from the failure boundary

| Requirement | Choice |
| --- | --- |
| Disposable local development | Command default. |
| Restart-safe, single Node host with a persistent volume | File-backed `sqlite()`. |
| Host-loss recovery or replacement processes sharing state | Ecosystem adapter for an external database. |
| Cloudflare deployment | No adapter; Durable Object SQLite is automatic. |
| Unsupported Node backend | Implement `PersistenceAdapter`. |

An external database does not make active-active processing safe. Every Node conversation still requires one live owner.

### 2. Configure a single-host Node deployment

```ts
// src/db.ts
import { sqlite } from '@flue/runtime/node';

export default sqlite('/var/lib/my-app/flue.db');
```

Mount `/var/lib/my-app` on durable storage, preserve it across releases, and ensure only the intended Node owner writes a conversation. Prefer an absolute path in deployments so a changed working directory cannot create a fresh database accidentally.

### 3. Add an external adapter

```bash
bunx flue add database postgres --print
```

Blueprints are implementation guides, not package installers. Apply the generated guide, install the named adapter and a chosen driver with Bun, then default-export the configured adapter from `db.ts`. Published mappings include:

| Backend | Adapter |
| --- | --- |
| Postgres, Supabase | `@flue/postgres` |
| libSQL, Turso | `@flue/libsql` |
| MySQL | `@flue/mysql` |
| MongoDB | `@flue/mongodb` |
| Redis, Valkey | `@flue/redis` |

These adapters are bring-your-own-driver. Follow the selected ecosystem page's exact runner contract instead of assuming all runners have the same SQL methods.

### 4. Implement a custom backend only when necessary

```ts
export default {
  async migrate() {
    await ensureCurrentFormat();
  },
  async connect() {
    return { submissionStore, conversationStreamStore, attachmentStore };
  },
  async close() {
    await closeConnections();
  },
} satisfies PersistenceAdapter;
```

Run all three suites: `defineStoreContractTests`, `defineConversationStreamStoreContractTests`, and `defineAttachmentStoreContractTests`. Do not infer correctness from happy-path CRUD tests.

### 5. Verify operationally

Admit a message, stop the process after admission, restart it, and verify the same submission settles. Also verify conversation history and attachment reads after restart. For replacement deployments, test routing so old and new processes do not overlap ownership of one conversation.

## Recommended patterns

- Treat the canonical conversation stream as the only transcript; derive views and caches from it.
- Keep application business data in application-owned stores and access it through tools.
- Make adapter migrations idempotent and perform format checks before serving traffic.
- Keep persisted payloads free of unnecessary secrets; admitted and settled submission data is retained.
- Pair external persistence with sticky or otherwise exclusive per-conversation ownership.
- Choose sandbox persistence independently from conversation persistence.

## Avoid

- Do not add `db.ts` to a Cloudflare project.
- Do not deploy a meaningful Node agent with the in-memory production default.
- Do not put a file SQLite database on ephemeral container storage and call it durable.
- Do not use one shared database as justification for round-robin active-active conversation routing.
- Do not implement partial stream appends, mutable transcript rows, or unfenced producers.
- Do not hand-run application-style migrations against Flue tables.

## Gotchas

- Admission is durable only to the configured target store. Node in-memory admission disappears with the process; Cloudflare admission lives in the target Durable Object.
- A SQLite file survives process restart and same-host redeploy, not host loss.
- The current persisted format version is `1`. Stores stamp the format; unknown or newer versions fail before reads or writes. The format boundary is reset-only, not an in-place data migration API.
- `subscribe()` on `ConversationStreamStore` is best-effort in-process fan-out, not durable cross-process notification.
- Fold checkpoints are optional caches over the log. They are never authoritative and must be torn-write safe.
- Exact retries of admissions, stream appends, attachment puts, and settlement reservations must return the original result; same identity with different content must conflict.
- Attachment bytes are immutable and verified against size and digest.

## Related

- [Durability](https://flueframework.com/docs/guide/durability/)
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/)
- [Node target](https://flueframework.com/docs/guide/node-target/)
- [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/)
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/)
- [Configuration](https://flueframework.com/docs/reference/configuration/)
