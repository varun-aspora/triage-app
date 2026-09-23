---
title: Turso
source: https://flueframework.com/docs/ecosystem/databases/turso/
section: ecosystem
flue_version: "2.0.8"
---

# Turso

Use Turso as hosted, managed, replicated libSQL storage for Flue agents on the Node target.

## Target and when to choose

- Choose Turso when managed replicated SQLite is preferable to operating a database server.
- Choose an embedded replica when low read latency justifies a synchronized local file.
- Use the plain remote client by default.
- Use the libSQL guide for a local file or self-hosted `sqld`.
- Keep one live Node owner per agent conversation even when replicas share Turso.
- Do not use `db.ts` on Cloudflare; Durable Object SQLite is automatic and Cloudflare rejects the file.

## Prerequisites and environment

- A Flue Node-target project.
- A Turso database and auth token.
- `TURSO_DATABASE_URL`, containing the database's `libsql://` URL.
- `TURSO_AUTH_TOKEN`.
- Runtime secrets held outside source control.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` loads another `.env`-format file. The built server reads the process environment.

## How to add Turso

### 1. Read and apply the blueprint

```bash
bunx flue add database turso --print
```

The blueprint prints implementation guidance. It does not install dependencies or create `db.ts` by itself.

### 2. Install the shared libSQL adapter and client

```bash
bun add @flue/libsql @libsql/client@^0.17.3
```

There is no Turso-specific Flue adapter. Turso uses `@flue/libsql` with hosted client configuration.

### 3. Create the database and token

```bash
turso db create flue-agents
turso db show --url flue-agents
turso db tokens create flue-agents
```

Put the returned URL and token in the runtime secret system. Do not invent or commit either value.

### 4. Create source-root `db.ts`

```ts
// flue-blueprint: database/turso@1
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

export default libsql({
  query: async (text, params = []) =>
    toRows(await client.execute({ sql: text, args: params })),
  transaction: async (fn) => {
    const tx = await client.transaction('write');
    try {
      const result = await fn({
        query: async (text, params = []) =>
          toRows(await tx.execute({ sql: text, args: params })),
      });
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  },
  close: () => client.close(),
});
```

The runner uses `?` placeholders and maps `ResultSet` values to plain row objects. Turso serializes remote writes server-side, so the local-file promise chain from the general libSQL runner is not needed here.

### 5. Optional embedded replica

Use this client configuration only when lower read latency is needed; the rest of `db.ts` stays unchanged:

```ts
const client = createClient({
  url: 'file:flue-replica.db',
  syncUrl: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
  syncInterval: 5,
});
```

Reads use local disk while writes forward to Turso. Sync is not automatic on read: without a `syncInterval` (seconds) or an explicit `client.sync()` call, the local replica only advances when something else triggers a sync, so a local read can return data older than the primary's actual state. This is a correctness question for Flue, not just a latency one — the persistence contract in `guides_database.md` requires exact retries (admission checks, idempotent submission replay) to see the same durable evidence a prior attempt already committed. A stale replica read during recovery can miss a just-committed write. Set `syncInterval` to a value comfortably under the deployment's tolerance for re-reading stale state, or call `client.sync()` before any read that guards an idempotency decision; when in doubt, use the plain remote client instead of an embedded replica.

### 6. Let Flue migrate and verify

No migration command is required. Flue calls `migrate()` before `connect()`, creates the `flue_*` tables idempotently, and stamps the format version.

```bash
bunx tsc --noEmit
bunx vite build
TURSO_DATABASE_URL='libsql://...' TURSO_AUTH_TOKEN='...' bunx vite preview
```

Use a development database, persist state, restart, and confirm it reloads.

## Recommended production patterns

- Keep the plain remote client unless measured read latency warrants an embedded replica.
- Keep URL and token in platform secret management and rotate tokens through Turso.
- Preserve one `write` transaction per runner callback.
- Roll back on error and always close the transaction.
- Map result sets to plain row objects.
- Close the client through Flue's adapter lifecycle.
- Route one live Node owner for each conversation.
- Test process replacement and token/network failure behavior before launch.

## Avoid

- Do not install or invent an `@flue/turso` package.
- Do not hardcode a URL or auth token.
- Do not return raw `ResultSet` values from `query`.
- Do not omit transaction rollback or `tx.close()`.
- Do not add embedded replicas by default without a read-latency requirement.
- Do not assume an embedded replica's local reads are current without a `syncInterval` or explicit `client.sync()`; unsynced reads can be stale relative to the Turso primary.
- Do not hand-run or alter Flue migrations.
- Do not test migration against production.
- Do not add this adapter on Cloudflare.

## Gotchas

- Turso and generic libSQL use the same Flue adapter but different environment and client configuration.
- Embedded replicas add a local file and `syncUrl`; account for local disk lifecycle.
- Embedded replicas do not support offline writes or multi-writer convergence; writes always forward to the Turso primary. That is a different feature (`@tursodatabase/sync`), not something this adapter provides.
- Shared hosted storage does not permit simultaneous owners for one conversation.
- Startup fails on bad URL, token, network, schema, or incompatible format version.
- Canonical streams append for the conversation lifetime; there is no per-session deletion contract.
- Standalone `start()` scripts do not discover `db.ts`; supply the adapter via the `db` option.
- `@flue/libsql` is Node-only.

## Related

- [libSQL](https://flueframework.com/docs/ecosystem/databases/libsql/) - local, self-hosted, and runner details
- [Database](https://flueframework.com/docs/guide/database/) - entry discovery and persistence choices
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery semantics
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - adapter contract
- [Turso CLI](https://docs.turso.tech/cli/introduction) - database and token creation
- [libSQL TypeScript client](https://docs.turso.tech/sdk/ts/reference) - remote and embedded client options
