---
title: libSQL
source: https://flueframework.com/docs/ecosystem/databases/libsql/
section: ecosystem
flue_version: "2.0.8"
---

# libSQL

Use `@flue/libsql` for a local SQLite file, self-hosted libSQL server, or embedded replica on the Node target.

## Target and when to choose

- Choose libSQL when SQLite's model should be local, network-accessible through `sqld`, or synced as an embedded replica.
- Use a local `file:` URL for development or a single-host Node deployment.
- Use a self-hosted libSQL server when more than one process needs server-coordinated writes.
- Use Turso for hosted, managed, replicated libSQL.
- For the simplest single-host persistence, the built-in `sqlite()` adapter may need fewer dependencies.
- Do not use `db.ts` on Cloudflare; Durable Object SQLite is automatic and the build rejects the entry module.

## Prerequisites and environment

- A Flue Node-target project.
- `LIBSQL_URL` at runtime.
- A supported target URL such as `file:./data/flue.db` or `http://127.0.0.1:8080`.
- Any server credentials configured through the application-owned `@libsql/client` options.
- Secrets stored outside source control.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` loads another `.env`-format file. Production supplies the real process environment.

## How to add libSQL

### 1. Read and apply the blueprint

```bash
bunx flue add database libsql --print
```

The command prints the blueprint; it does not install packages or edit the project.

### 2. Install the adapter and client

```bash
bun add @flue/libsql @libsql/client@^0.17.3
```

`@flue/libsql` does not bundle a database driver. The project owns client target, authentication, synchronization, and lifecycle.

### 3. Create source-root `db.ts`

```ts
// flue-blueprint: database/libsql@1
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

// Local file: `file:./data/flue.db`
// Self-hosted libSQL server: `http://127.0.0.1:8080`
const client = createClient({ url: process.env.LIBSQL_URL! });

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

let tail: Promise<unknown> = Promise.resolve();
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = tail.then(operation, operation);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export default libsql({
  query: (text, params = []) =>
    serialize(async () => toRows(await client.execute({ sql: text, args: params }))),
  transaction: (fn) =>
    serialize(async () => {
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
    }),
  close: () => client.close(),
});
```

The runner uses `?` placeholders, maps `ResultSet` rows to plain objects, and keeps each callback in one `write` transaction.

### 4. Choose the connection target

| Target | Client configuration |
| --- | --- |
| Local SQLite file | `{ url: 'file:./data/flue.db' }` |
| Self-hosted `sqld` | `{ url: 'http://127.0.0.1:8080' }` |
| Embedded replica | `{ url: 'file:local.db', syncUrl, authToken }` |
| Hosted Turso | Use the Turso blueprint and guide |

Keep the shared promise chain for `file:` databases. It prevents this process's top-level queries and transactions from overlapping and producing `SQLITE_BUSY`.

### 5. Let Flue migrate and verify

There is no migration command. At startup Flue calls `migrate()` before `connect()`, creates `flue_*` tables idempotently, and stamps the format version.

```bash
bunx tsc --noEmit
bunx vite build
LIBSQL_URL='file:./data/flue-test.db' bunx vite preview
```

Use throwaway storage, create state, restart, and confirm state reloads.

## Recommended production patterns

- Keep the serializer for every embedded `file:` client operation.
- Use a self-hosted server or Turso instead of sharing one local file across processes.
- Keep transactions in `client.transaction('write')` with rollback and `tx.close()` cleanup.
- Map every `ResultSet` into plain row objects.
- Close the client through the runner's `close()` hook.
- Supply connection and authentication values through secret management.
- Route each conversation to one live Node owner, even against remote shared storage.
- Use embedded replicas only when lower read latency justifies sync operations and local-file management.

## Avoid

- Do not remove serialization for local `file:` operation paths.
- Do not treat that in-process serializer as multi-process coordination.
- Do not share one embedded file across multiple Flue processes or tenants.
- Do not return raw `ResultSet` objects from `query`.
- Do not omit rollback or transaction/client cleanup.
- Do not hand-run or modify the Flue schema.
- Do not use the generic libSQL environment setup for hosted Turso; use its URL and token blueprint.
- Do not add the adapter to Cloudflare.

## Gotchas

- Embedded asynchronous writes can overlap and surface `SQLITE_BUSY` without the serializer.
- A self-hosted libSQL server and Turso serialize writes server-side.
- An embedded replica needs additional `syncUrl` and `authToken` client configuration, and its local reads are not automatically current: without a `syncInterval` or an explicit `client.sync()`, a read can return data older than the remote primary. See the Turso page's embedded-replica section for why that matters under Flue's exact-retry persistence contract.
- File-backed storage survives process restarts, but host-disk loss still loses state.
- Startup fails for inaccessible URLs, authentication, schema, or incompatible format versions.
- Canonical streams are append-only; no per-session deletion is promised.
- Standalone `start()` scripts bypass source-root `db.ts`; pass the adapter through the `db` option.
- The adapter is Node-only.

## Related

- [Turso](https://flueframework.com/docs/ecosystem/databases/turso/) - hosted and replicated libSQL
- [Database](https://flueframework.com/docs/guide/database/) - persistence choices and discovery
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery and ownership
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - adapter contract
- [libSQL](https://github.com/tursodatabase/libsql) - database project
- [libSQL TypeScript client](https://docs.turso.tech/sdk/ts/reference) - client configuration and transactions
