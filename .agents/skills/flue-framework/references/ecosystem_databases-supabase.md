---
title: Supabase
source: https://flueframework.com/docs/ecosystem/databases/supabase/
section: ecosystem
flue_version: "2.0.8"
---

# Supabase

Use Supabase's managed Postgres as durable, shared Flue storage on the Node target.

## Target and when to choose

- Choose Supabase when a persistent Node deployment already uses Supabase Postgres.
- Use a direct connection for persistent IPv6-capable Node servers.
- Use the shared pooler in session mode for persistent IPv4-only Node servers.
- Use general Postgres guidance for another managed or self-hosted Postgres service.
- Preserve one live Node owner per agent conversation even when replicas share Supabase.
- Do not add this integration on Cloudflare; Durable Object SQLite is automatic and `db.ts` is rejected.

## Prerequisites and environment

- A Flue Node-target project.
- A non-production Supabase project for initial verification.
- A connection string copied from **Supabase Dashboard > Connect**.
- `SUPABASE_DATABASE_URL`, unless the project already has a stable database-variable convention.
- Runtime secrets supplied by the deployment platform.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` loads another `.env`-format file. The built server reads the actual process environment.

## How to add Supabase

### 1. Read and apply the blueprint

```bash
bunx flue add database supabase --print
```

The blueprint is an implementation guide, not an installer. It configures the existing `@flue/postgres` adapter; there is no Supabase-specific Flue package.

### 2. Install the adapter and driver

```bash
bun add @flue/postgres pg@^8.21.0
bun add -d @types/pg@^8.20.0
```

The project owns `pg` pooling, TLS, credentials, and lifecycle.

### 3. Choose the connection mode

| Deployment | Connection |
| --- | --- |
| Persistent Node server with IPv6 | Direct connection |
| Persistent Node server with IPv4 only | Shared pooler, session mode |
| Deployment that requires transaction mode | Unnamed queries only; no prepared statements or session state |

Transaction mode can preserve the explicit transaction below, but it does not support named prepared statements or session state. Do not make it the default.

### 4. Create source-root `db.ts`

```ts
// flue-blueprint: database/supabase@1
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL });

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

Every callback query stays on the checked-out client. `@flue/postgres` uses transaction-scoped `pg_advisory_xact_lock`, not session advisory locks.

### 5. Let Flue migrate at startup

There is no separate migration command. Flue discovers `db.ts`, invokes `migrate()` before `connect()`, creates `flue_*` tables idempotently, and stamps the format version. Newer unsupported data stops startup rather than accepting incompatible writes.

### 6. Verify

```bash
bunx tsc --noEmit
bunx vite build
SUPABASE_DATABASE_URL='postgresql://...' bunx vite preview
```

Use a non-production Supabase project. Confirm table creation, persist state, restart, and confirm state reloads. If using a pooler, verify its selected mode and restrictions.

## Recommended production patterns

- Prefer direct connectivity when the host supports IPv6.
- Prefer session-mode shared pooling for persistent IPv4-only servers.
- Keep transactions on one checked-out `pg` client.
- Keep queries unnamed if transaction-mode pooling is unavoidable.
- Configure provider-required TLS in `pg` without weakening certificate validation casually.
- Store the connection string in platform secret management.
- Close the pool through the runner's `close()` hook.
- Route each conversation to one live process owner.

## Avoid

- Do not create or search for an `@flue/supabase` package.
- Do not use Supabase's HTTP application client as the persistence runner.
- Do not call the pool from inside the transaction callback.
- Do not default to transaction-mode pooling.
- In transaction mode, do not use named prepared statements or session state.
- Do not hand-run or modify Flue's migration schema.
- Do not verify against production.
- Do not add `db.ts` to a Cloudflare-target project.

## Gotchas

- `SUPABASE_DATABASE_URL` is a blueprint convention; retain an established project convention if one exists.
- Direct Supabase connectivity may require IPv6; use the shared pooler in session mode on IPv4-only hosts.
- Transaction mode does not inherently break the explicit single-client transaction, but its prepared-statement and session-state limits still apply.
- Migration and connection errors intentionally fail application startup.
- Changing database URL or pooler mode can change latency and connection behavior; verify recovery after deployment changes.
- Shared durable state does not allow two live owners to execute one conversation safely.
- Flue stores canonical streams, attachments, and submissions, not sandbox files or business data.
- Standalone `start()` scripts bypass `db.ts`; provide the adapter with the `db` option.
- The adapter and entry module are Node-only.

## Related

- [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/) - shared adapter and runner contract
- [Database](https://flueframework.com/docs/guide/database/) - `db.ts` discovery and storage choices
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery and ownership
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - adapter contract
- [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) - connection methods and poolers
- [node-postgres](https://node-postgres.com/) - driver configuration
