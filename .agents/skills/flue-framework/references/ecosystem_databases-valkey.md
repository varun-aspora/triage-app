---
title: Valkey
source: https://flueframework.com/docs/ecosystem/databases/valkey/
section: ecosystem
flue_version: "2.0.8"
---

# Valkey

Use Valkey as durable, shared Flue runtime storage through the Redis protocol and `@flue/redis` adapter.

## Target and when to choose

- Choose Valkey when the Node deployment operates persistent Valkey rather than a cache-only service.
- Use a standalone server or managed single-shard endpoint.
- Require `maxmemory-policy noeviction`.
- Configure AOF and/or durable snapshots to match the recovery objective.
- Valkey Cluster is unsupported.
- Support is specific to Valkey; do not infer that every Redis-compatible provider works.
- Valkey and Redis are wire-compatible forks of the same origin codebase, sharing the identical `@flue/redis` adapter and runner shape — nothing in this file's `db.ts` differs from the Redis page's except the URL variable name. Choose Valkey when the deployment already standardized on it (often for its BSD license and Linux Foundation governance, after Redis moved to SSPL/RSALv2 in 2024) or when the managed provider offers Valkey specifically. Choose Redis (see the sibling page) when the deployment is already on Redis or needs a Redis-specific feature or module Valkey doesn't carry. Flue supports both identically under the same constraints.
- Shared storage still requires one live Node owner per agent conversation.
- Do not use this adapter on Cloudflare; the target supplies Durable Object SQLite and rejects `db.ts`.

## Prerequisites and environment

- A Flue Node-target project.
- Persistent Valkey with Cluster disabled and `maxmemory-policy noeviction`.
- `VALKEY_URL` for the standalone or managed single-shard endpoint.
- Credentials and TLS configured through the node-redis client.
- A selected AOF fsync policy and/or snapshot strategy.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` loads another environment file. Production supplies the real process environment.

## How to add Valkey

### 1. Read and apply the blueprint

```bash
bunx flue add database valkey --print
```

The command prints an implementation guide; it does not install dependencies or modify the project.

### 2. Install the shared adapter and client

```bash
bun add @flue/redis redis@^5.12.1
```

There is no separate `@flue/valkey` package. The official Redis `redis` client speaks the Redis-protocol commands this adapter uses with Valkey.

### 3. Create source-root `db.ts`

```ts
// flue-blueprint: database/valkey@1
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.VALKEY_URL });
await client.connect();

export default redis({
  command: (command, args = []) =>
    client.sendCommand([command, ...args.map(String)]),
  eval: (script, keys, args = []) =>
    client.eval(script, {
      keys,
      arguments: args.map(String),
    }),
  pipeline: async (commands) => {
    const multi = client.multi();
    for (const { command, args = [] } of commands) {
      multi.addCommand([command, ...args.map(String)]);
    }
    const results = await multi.exec();
    for (const result of results) {
      if (result instanceof Error) throw result;
    }
    return results;
  },
  close: () => client.close(),
});
```

The pipeline returns one normalized result per command and throws on any `Error` result. Attachment bytes arrive at the runner already base64-encoded, so `String()` coercion is lossless.

### 4. Configure inspection and isolation

At startup, `inspectServer` uses `CONFIG GET`, falling back to `INFO`, to verify that Cluster is disabled and eviction is `noeviction`. Startup fails when it cannot verify either requirement.

Set `inspectServer: false` only for a managed single-shard provider that denies both commands, after independently verifying the deployment.

Use a dedicated Valkey database or pass a stable unique `{ keyPrefix: '...' }` as the second argument to `redis()`. The default is `flue`. A changed prefix selects a new namespace and does not migrate existing keys.

### 5. Let Flue migrate and verify

There is no migration command. `migrate()` inspects the server, initializes format-version metadata idempotently, and rejects unsupported newer data.

```bash
bunx tsc --noEmit
bunx vite build
VALKEY_URL='redis://...' bunx vite preview
```

Use a throwaway persistent deployment. Verify Flue process restart, then separately restore from the selected AOF or snapshot mechanism to test server-loss durability.

## Recommended production patterns

- Configure `maxmemory-policy noeviction` and monitor memory capacity.
- Enable AOF with an explicit fsync policy and/or durable snapshots.
- Use a dedicated database or a stable per-application `keyPrefix`.
- Leave server inspection enabled when provider permissions allow it.
- Keep pipeline result validation and client cleanup intact.
- Configure credentials, TLS, reconnect, and timeouts in node-redis.
- Route each conversation to one live Node process.
- Test Valkey server recovery independently from Flue restart.

## Avoid

- Do not use Valkey Cluster, cache-only deployments, or an eviction policy other than `noeviction`.
- Do not infer support for arbitrary Redis-compatible services.
- Do not mistake `noeviction` for persistence across server loss.
- Do not disable inspection without independently checking topology and policy.
- Do not remove pipeline error handling or argument normalization.
- Do not change `keyPrefix` expecting data migration.
- Do not manually mutate adapter keys or format metadata.
- Do not use this adapter on Cloudflare.

## Gotchas

- Valkey uses `@flue/redis` and the `redis` client; package names remain Redis-oriented.
- Durability depends on the Valkey deployment's AOF fsync and snapshot policy: the default `appendfsync everysec` can lose up to about one second of acknowledged writes on a crash. `appendfsync always` closes that window at a real latency cost — the same tradeoff as upstream Redis, since Valkey forked Redis's persistence engine and kept its semantics.
- Managed services may deny inspection commands; bypassing checks transfers responsibility to the operator.
- Startup fails for Cluster, eviction, connectivity, TLS, auth, or format-version issues.
- The default namespace is `flue`; a prefix change appears as a fresh store.
- Canonical streams append for the instance lifetime and have no per-session deletion.
- Standalone `start()` scripts bypass `db.ts`; pass the adapter via `db`.
- This is a Node-only adapter.

## Related

- [Redis](https://flueframework.com/docs/ecosystem/databases/redis/) - Redis over the same adapter and runner
- [Database](https://flueframework.com/docs/guide/database/) - adapter selection and discovery
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery and one-live-owner rule
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - adapter invariants
- [Valkey persistence](https://valkey.io/topics/persistence/) - AOF and snapshots
- [node-redis](https://github.com/redis/node-redis) - client configuration and lifecycle
