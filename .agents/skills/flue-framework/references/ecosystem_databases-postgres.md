---
title: Postgres
source: https://flueframework.com/docs/ecosystem/databases/postgres/
section: ecosystem
flue_version: "2.0.8"
---

# Postgres

Use Postgres to give Flue agents durable, shared runtime state on the Node target.

## Target and when to choose

- Choose Postgres when state must survive host loss or replacement processes.
- Choose it when multiple Node replicas need shared conversation state.
- Prefer it when Postgres is already the deployment's operational standard.
- Keep file-backed `sqlite()` for simpler single-host persistence.
- This does not make one agent conversation active-active: route each conversation to one live Node owner.
- Do not use this adapter on Cloudflare. Durable Object SQLite is automatic there, and Cloudflare rejects `db.ts`.

## Prerequisites and environment

- A Flue Node-target project with an existing source root: `.flue/`, then `src/`, then the project root.
- A reachable Postgres database.
- `DATABASE_URL`, for example `postgresql://user:pass@host:5432/db`.
- Runtime credentials supplied through the platform secret store, never committed.
- Provider-required TLS configured on the chosen Postgres driver.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` selects another `.env`-format file. A built server reads the real process environment.

## How to add Postgres

### 1. Read and apply the blueprint

```bash
bunx flue add database postgres --print
```

`flue add` prints a Markdown implementation guide; it is not a package installer. Apply the guide to the existing project rather than expecting this command to edit files.

### 2. Install the adapter and driver

Reuse an existing compatible Postgres driver when possible. The default blueprint uses `pg`:

```bash
bun add @flue/postgres pg@^8.21.0
bun add -d @types/pg@^8.20.0
```

`@flue/postgres` is driver-free. The application owns pooling, credentials, TLS, timeouts, and connection lifecycle.

### 3. Create source-root `db.ts`

```ts
// flue-blueprint: database/postgres@1
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

The runner's `query` uses numbered `$N` placeholders and returns row objects. Every transaction query must use the same checked-out client.

### 4. Let Flue migrate at startup

There is no migration command. Flue discovers `db.ts`, calls the adapter's `migrate()` before `connect()`, creates the `flue_*` tables idempotently, and stamps the Flue format version. An unreachable database or unsupported newer format fails startup.

### 5. Verify against a throwaway database

```bash
bunx tsc --noEmit
bunx vite build
DATABASE_URL='postgresql://...' bunx vite preview
```

Confirm first startup creates the tables, create agent state, restart, and confirm the same state reloads. Never use a production database for this verification.

## Recommended production patterns

- Use a bounded pool sized for the process and database connection limits.
- Keep the complete `BEGIN`/`COMMIT`/`ROLLBACK` runner and release clients in `finally`.
- Configure TLS and certificate verification according to the database provider.
- Supply `DATABASE_URL` only at runtime through secret management.
- Keep Flue runtime data separate from application business-data ownership.
- Use instance-affine routing so one live process owns a conversation at a time.
- Exercise restart and process-replacement recovery before launch.
- Close the pool through the runner's `close()` so Flue shutdown can release resources.

## Avoid

- Do not call `pool.query()` from inside the transaction callback.
- Do not use a driver that cannot hold an interactive transaction on one connection.
- For Neon, do not use the HTTP query client; use its WebSocket `Pool` for this callback contract.
- Do not hand-create or hand-run Flue migrations.
- Do not rename, drop, or repurpose `flue_*` tables.
- Do not hardcode credentials or connection strings.
- Do not use this database as an assumption of active-active execution.
- Do not expect Flue persistence to store sandbox files or application business records.

## Gotchas

- The adapter package does not bundle `pg` or another production driver.
- A pool cannot provide transaction atomicity if callback queries move between connections.
- Startup runs migration before connection, so schema, TLS, permission, and network failures are boot failures.
- A shared database permits recovery and shared state, not overlapping owners for one conversation.
- Canonical streams are append-only and are the sole transcript; sessions have no per-session deletion contract.
- `close()` must end the pool; releasing only transaction clients is not enough for process cleanup.
- Standalone scripts using `start()` do not discover `db.ts`; pass the adapter through `start({ db: ... })` instead.
- The adapter is Node-only; a resolved `db.ts` is a hard build error on Cloudflare.

## Related

- [Database](https://flueframework.com/docs/guide/database/) - discovery, defaults, and adapter selection
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery and the one-live-owner rule
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - adapter invariants and format versioning
- [Supabase](https://flueframework.com/docs/ecosystem/databases/supabase/) - managed Postgres connection guidance
- [Deploy Agents on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/) - Node deployment
- [node-postgres](https://node-postgres.com/) - driver pooling, TLS, and connection options
