---
title: MySQL
source: https://flueframework.com/docs/ecosystem/databases/mysql/
section: ecosystem
flue_version: "2.0.8"
---

# MySQL

Use MySQL 8 with InnoDB for durable, shared Flue state on the Node target.

## Target and when to choose

- Choose MySQL when the Node deployment already operates MySQL 8.
- Choose it when state must survive process replacement or host loss.
- Use it when replicas need shared state, while retaining one live owner per agent conversation.
- Prefer file-backed `sqlite()` for a simple single-host deployment.
- Prefer Postgres or libSQL only when those systems better match the existing operational environment.
- Do not use this integration on Cloudflare; Cloudflare supplies Durable Object SQLite and rejects `db.ts`.

## Prerequisites and environment

- MySQL 8.
- InnoDB for all Flue transactional tables.
- A Flue Node-target project.
- `MYSQL_URL` supplied at runtime.
- Provider-required TLS configured through `mysql2`.
- Credentials held in platform secret management, not source control.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` selects another `.env`-format file. Built deployments read the real environment.

## How to add MySQL

### 1. Read and apply the blueprint

```bash
bunx flue add database mysql --print
```

This prints guidance for the coding agent; it does not install packages or edit the project.

### 2. Install the adapter and driver

```bash
bun add @flue/mysql mysql2@^3.22.5
```

`@flue/mysql` does not bundle a production driver. The project owns pooling, TLS, credentials, and connection lifecycle.

### 3. Create source-root `db.ts`

```ts
// flue-blueprint: database/mysql@1
import { mysql, type MysqlQuery } from '@flue/mysql';
import mysql2 from 'mysql2/promise';

const pool = mysql2.createPool(process.env.MYSQL_URL!);

const toRows = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result.map((row) => ({ ...row })) : [];

export default mysql({
  query: async (text, params = []) => {
    const [result] = await pool.execute(text, params);
    return toRows(result);
  },
  transaction: async <T>(fn: (tx: { query: MysqlQuery }) => Promise<T>) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn({
        query: async (text, params = []) => {
          const [rows] = await connection.execute(text, params);
          return toRows(rows);
        },
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
  close: () => pool.end(),
});
```

The runner uses `?` placeholders and converts `mysql2` results to plain row objects. Every callback query must use the checked-out connection.

### 4. Let Flue migrate at startup

No manual migration command exists. Flue discovers `db.ts`, runs `migrate()` before `connect()`, creates and verifies the complete `flue_*` InnoDB schema, then stamps its format version. Unsupported newer data or incompatible schema stops startup.

### 5. Verify

```bash
bunx tsc --noEmit
bunx vite build
MYSQL_URL='mysql://...' bunx vite preview
```

Point at a throwaway MySQL 8 database, confirm the first start creates `flue_*`, persist agent state, restart, and confirm the state reloads.

## Recommended production patterns

- Use a bounded connection pool appropriate to server concurrency and database limits.
- Keep transaction work on one checked-out connection until commit or rollback.
- Release transaction connections in `finally` and end the pool in `close()`.
- Require InnoDB rather than relying on a server's table-engine default.
- Configure TLS and certificate verification according to the provider.
- Keep `MYSQL_URL` in the deployment's secret store.
- Route each conversation to one live Node owner.
- Test both Flue process restart and actual database recovery behavior.

## Avoid

- Do not use MySQL 5.x or non-InnoDB Flue tables.
- Do not replace `pool.getConnection()` with pool calls inside transactions.
- Do not return raw non-row `mysql2` result shapes from the runner.
- Do not hardcode or invent `MYSQL_URL`.
- Do not manually create, alter, or migrate `flue_*` tables.
- Do not assume a shared MySQL database enables active-active conversation execution.
- Do not use production for migration verification.
- Do not add this adapter to a Cloudflare target.

## Gotchas

- The adapter is driver-free, so `mysql2` remains an application dependency in production.
- `pool.execute()` is correct for top-level queries, but not for transaction callback queries.
- A transaction can silently lose atomicity if its queries run on different pool connections.
- Migration verifies the full schema and InnoDB requirements before version stamping.
- Startup intentionally fails for network, TLS, credentials, permissions, schema, or format-version errors.
- Canonical conversations are append-only runtime data; there is no per-session deletion contract.
- `close()` must end the pool so process shutdown does not leak connections.
- Standalone `start()` scripts do not auto-discover `db.ts`; pass the adapter directly.
- This is a Node-only adapter.

## Related

- [Database](https://flueframework.com/docs/guide/database/) - persistence overview and target behavior
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery and ownership
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - adapter invariants
- [mysql2](https://sidorares.github.io/node-mysql2/docs) - driver, pool, and TLS documentation
- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/) - Postgres alternative
- [libSQL](https://flueframework.com/docs/ecosystem/databases/libsql/) - SQLite/libSQL alternative
