---
title: Redis
source: https://flueframework.com/docs/ecosystem/databases/redis/
section: ecosystem
flue_version: "2.0.8"
---

# Redis

Use Redis as durable, shared Flue runtime storage only with a persistent standalone or managed single-shard deployment.

## Target and when to choose

- Choose Redis when the Node deployment already operates Redis as durable storage, not merely as a cache.
- Use a standalone server or managed single-shard endpoint.
- Require `maxmemory-policy noeviction`.
- Configure AOF and/or durable snapshots to match the recovery objective.
- Redis Cluster and cache-only deployments are unsupported.
- Shared storage still requires one live Node owner per agent conversation.
- Do not use this adapter on Cloudflare; the target supplies Durable Object SQLite and rejects `db.ts`.
- Redis and Valkey are wire-compatible forks sharing the same origin codebase and the same `@flue/redis` adapter; nothing in the runner or migration format differs between them. Choose Redis when the deployment is already on Redis (self-hosted or a Redis-branded managed offering) or needs a Redis-specific feature or module not carried by Valkey. Choose Valkey (see the sibling page) when the deployment standardized on it instead, typically for licensing reasons following Redis's 2024 license change to SSPL/RSALv2 — Valkey stayed BSD-licensed under Linux Foundation stewardship. Flue does not take a side; both are supported the same way under the same constraints.

## Prerequisites and environment

- A Flue Node-target project.
- Persistent Redis with Cluster disabled and eviction policy `noeviction`.
- `REDIS_URL` for the selected server or managed single-shard endpoint.
- Credentials and TLS configured through the application-owned node-redis client.
- An explicit AOF fsync policy and/or snapshot strategy.

For local development, `vite dev` loads the project `.env`; `flue run --env <file>` loads another environment file. Production supplies secrets in the real process environment.

## How to add Redis

### 1. Read and apply the blueprint

```bash
bunx flue add database redis --print
```

The command prints an implementation guide; it is not a dependency installer and does not edit files.

### 2. Install the adapter and client

```bash
bun add @flue/redis redis@^5.12.1
```

`@flue/redis` does not bundle a production client. The application owns credentials, TLS, timeouts, reconnect behavior, and topology.

### 3. Create source-root `db.ts`

```ts
// flue-blueprint: database/redis@1
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
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

The pipeline must preserve one result per command and reject any `Error` result. String coercion is safe because the adapter base64-encodes attachment bytes before the runner boundary.

### 4. Configure inspection and isolation

At startup, `inspectServer` tries `CONFIG GET`, then `INFO`, to verify Cluster is off and eviction is `noeviction`. Startup fails if either cannot be verified.

Set `inspectServer: false` only when a managed single-shard provider blocks both commands and the deployment requirements have been independently verified.

Use a dedicated Redis database or pass a stable unique `{ keyPrefix: '...' }` as the second argument to `redis()`. The default prefix is `flue`. Changing it selects a new namespace; it does not move existing keys.

### 5. Let Flue migrate and verify

There is no separate migration command. `migrate()` inspects the server, initializes format-version metadata idempotently, and rejects an unsupported newer format.

```bash
bunx tsc --noEmit
bunx vite build
REDIS_URL='redis://...' bunx vite preview
```

Use a throwaway persistent deployment. Verify Flue restart recovery, then separately test AOF or snapshot restoration after Redis server loss.

## Recommended production patterns

- Configure `maxmemory-policy noeviction` and monitor memory before writes fail.
- Enable AOF with an explicit fsync policy and/or durable snapshots.
- Use a dedicated database or stable per-application `keyPrefix`.
- Leave server inspection enabled whenever the provider permits it.
- Keep pipeline error checks and close the client through `close()`.
- Configure TLS, credentials, reconnect, and timeouts in node-redis for the provider.
- Route one live process owner per conversation.
- Test Redis recovery separately from restarting the Flue process.

## Avoid

- Do not use Redis Cluster, cache-only plans, or any eviction policy other than `noeviction`.
- Do not mistake `noeviction` for disk durability.
- Do not disable inspection without independently checking topology and policy.
- Do not remove pipeline error handling or argument normalization.
- Do not change `keyPrefix` expecting a migration.
- Do not manually mutate Flue's keys or format-version metadata.
- Do not test against production.
- Do not use this adapter on Cloudflare.

## Gotchas

- Flue process restart proves only client reconnection, not survival of Redis server loss.
- Durability depends on the Redis deployment's AOF fsync and snapshot choices: the default `appendfsync everysec` can lose up to about one second of acknowledged writes on a crash or `kill -9`. `appendfsync always` closes that window at a real latency cost; treat `everysec` as a throughput/durability tradeoff, not a bug, and pick deliberately for what a lost second of submissions/state means for the deployment.
- Managed providers may deny `CONFIG GET` and `INFO`; disabling checks transfers verification responsibility to the operator.
- Startup fails for Cluster, eviction, connectivity, TLS, auth, or format-version problems.
- The default namespace is `flue`; prefix changes expose an apparently empty store.
- Canonical streams append for the instance lifetime and have no per-session deletion.
- Standalone `start()` scripts bypass `db.ts`; pass the adapter through `db`.
- The adapter is Node-only.

## Related

- [Valkey](https://flueframework.com/docs/ecosystem/databases/valkey/) - Valkey over the same adapter
- [Database](https://flueframework.com/docs/guide/database/) - adapter selection and discovery
- [Durability](https://flueframework.com/docs/guide/durability/) - accepted-work recovery
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - storage invariants
- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) - AOF and snapshots
- [node-redis](https://github.com/redis/node-redis) - client configuration and lifecycle
