---
title: MongoDB
source: https://flueframework.com/docs/ecosystem/databases/mongodb/
section: ecosystem
flue_version: "2.0.8"
---

# MongoDB

Use MongoDB for durable, shared Flue runtime state on the Node target.

## Target and when to choose

- Choose MongoDB when the deployment already operates a transaction-capable MongoDB topology.
- Supported topologies are Atlas, a replica set, a transaction-capable sharded cluster, or a single-node replica set.
- A standalone `mongod` is unsupported because Flue requires transactions.
- Shared state supports process replacement and replicas, but each agent conversation still needs one live Node owner.
- Do not use this adapter on Cloudflare; Durable Object SQLite is automatic and `db.ts` is rejected.

## Prerequisites and environment

- A Flue Node-target project.
- MongoDB with transaction support.
- `MONGODB_URL` containing credentials and required TLS options.
- `MONGODB_DATABASE` recommended to select a dedicated, unambiguous database.
- Runtime secrets supplied by the deployment platform.

`client.db(undefined)` may use the URL's database or the driver's default, so set `MONGODB_DATABASE` explicitly. For local development, `vite dev` loads `.env`; `flue run --env <file>` selects another environment file.

## How to add MongoDB

### 1. Read and apply the blueprint

```bash
bunx flue add database mongodb --print
```

The command prints an implementation guide. It does not install packages or change files.

### 2. Install the adapter and driver

```bash
bun add @flue/mongodb mongodb@^6.17.0
```

### 3. Create source-root `db.ts`

Keep the complete generated runner; MongoDB transaction session binding, operation serialization, topology inspection, schema validation, and retry separation are all required.

```ts
// flue-blueprint: database/mongodb@1
import {
  mongodb,
  type MongoCollection,
  type MongoOperations,
  type MongoRunner,
} from '@flue/mongodb';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URL!);
await client.connect();
const db = client.db(process.env.MONGODB_DATABASE);

const operations = (session?: import('mongodb').ClientSession): MongoOperations => {
  let pending = Promise.resolve();
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation, operation);
    pending = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    collection(name): MongoCollection {
      const collection = db.collection(name);
      const sessionOptions = session ? { session } : {};
      return {
        findOne: (filter, options) =>
          queue(() => collection.findOne(filter, { ...options, ...sessionOptions })),
        find: (filter = {}, options = {}) =>
          queue(() => collection.find(filter, { ...options, ...sessionOptions }).toArray()),
        insertOne: (document) => queue(() => collection.insertOne(document, sessionOptions)),
        insertMany: (documents) => queue(() => collection.insertMany(documents, sessionOptions)),
        updateOne: (filter, update, options) =>
          queue(() => collection.updateOne(filter, update, { ...options, ...sessionOptions })),
        updateMany: (filter, update) => queue(() => collection.updateMany(filter, update, sessionOptions)),
        findOneAndUpdate: (filter, update, options) =>
          queue(() => collection.findOneAndUpdate(filter, update, { ...options, ...sessionOptions })),
        deleteOne: (filter) => queue(() => collection.deleteOne(filter, sessionOptions)),
        deleteMany: (filter) => queue(() => collection.deleteMany(filter, sessionOptions)),
      } as MongoCollection;
    },
  };
};

const hasErrorLabel = (error: unknown, label: string): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'hasErrorLabel' in error &&
  typeof error.hasErrorLabel === 'function' &&
  error.hasErrorLabel(label);

const runner: MongoRunner = {
  ...operations(),
  async transaction(fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = client.startSession();
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
        const result = await fn(operations(session));
        for (let commitAttempt = 0; commitAttempt < 10; commitAttempt++) {
          try {
            await session.commitTransaction();
            return result;
          } catch (error) {
            if (!hasErrorLabel(error, 'UnknownTransactionCommitResult') || commitAttempt === 9) {
              throw error;
            }
          }
        }
      } catch (error) {
        await session.abortTransaction().catch(() => undefined);
        if (!hasErrorLabel(error, 'TransientTransactionError') || attempt === 4) throw error;
      } finally {
        await session.endSession();
      }
    }
    throw new TypeError('MongoDB transaction retry limit exhausted.');
  },
  async topology() {
    const hello = await db.admin().command({ hello: 1 });
    const kind = hello.setName ? 'replica_set' : hello.msg === 'isdbgrid' ? 'sharded' : 'standalone';
    return {
      kind,
      transactions:
        (kind === 'replica_set' || kind === 'sharded') &&
        hello.logicalSessionTimeoutMinutes != null,
    };
  },
  async ensureCollection(spec) {
    if (!(await db.listCollections({ name: spec.name }).hasNext())) {
      try {
        await db.createCollection(spec.name, {
          validator: spec.validator,
          validationLevel: spec.validationLevel,
          validationAction: spec.validationAction,
        });
      } catch (error) {
        if (error === null || typeof error !== 'object' || !('codeName' in error) ||
          error.codeName !== 'NamespaceExists') throw error;
      }
    }
    await db.command({
      collMod: spec.name,
      validator: spec.validator,
      validationLevel: spec.validationLevel,
      validationAction: spec.validationAction,
    });
    for (const { key, ...options } of spec.indexes) {
      await db.collection(spec.name).createIndex(key, options);
    }
  },
  async inspectCollection(name) {
    const info = await db.listCollections({ name }).next();
    if (!info) return null;
    const indexes = (await db.collection(name).listIndexes().toArray())
      .filter((index) => index.name !== '_id_')
      .map((index) => ({
        name: String(index.name),
        key: index.key as Record<string, 1 | -1>,
        ...(index.unique === true ? { unique: true } : {}),
        ...(index.partialFilterExpression
          ? { partialFilterExpression: index.partialFilterExpression } : {}),
        ...(index.collation ? { collation: index.collation } : {}),
      }));
    return {
      validator: info.options.validator,
      validationLevel: info.options.validationLevel,
      validationAction: info.options.validationAction,
      indexes,
    };
  },
  close: () => client.close(),
};

export default mongodb(runner);
```

### 4. Let Flue migrate and verify

There is no migration command. Startup rejects unsupported topology, creates strict collections and indexes, verifies their definitions, then stamps the format version.

```bash
bunx tsc --noEmit
bunx vite build
MONGODB_URL='mongodb://...' MONGODB_DATABASE='flue-test' bunx vite preview
```

Use a throwaway supported deployment. Verify restart recovery, a value larger than 4 MiB, and that a standalone `mongod` fails before version stamping.

## Recommended production patterns

- Use a dedicated database; otherwise configure a stable unique `collectionPrefix` in `mongodb()`.
- Keep transaction operations session-bound and serialized.
- Keep snapshot read concern, majority write concern, and both bounded retry loops.
- Retry the full callback only for `TransientTransactionError`.
- Retry only commit for `UnknownTransactionCommitResult`.
- Keep credentials, TLS, pool, and timeout settings in the application-owned client configuration.
- Route one live Node owner per conversation and close the client through `close()`.

## Avoid

- Do not use standalone `mongod`, database-level collections in a transaction, or parallel session operations.
- Do not remove topology, validator, index inspection, or retry logic from the generated runner.
- Do not change `collectionPrefix` expecting data migration; it selects a new namespace.
- Do not bypass adapter staging for large runtime values.
- Do not hand-run schema migrations or verify against production.

## Gotchas

- MongoDB defaults `transactionLifetimeLimitSeconds` to 60: a session-bound transaction still open past that is aborted by the server's periodic cleanup, independent of the runner's own retry loops. Keep the operations inside one `transaction()` call bounded to what a single turn's persistence write actually needs — don't widen it to wrap unrelated model or tool work.
- Lock acquisition inside a transaction defaults to a 5 ms wait (`maxTransactionLockRequestTimeoutMillis`) before aborting with a transient error. Concurrent transactions touching the same document (for example two attempts racing after a crash) are expected to hit this and rely on the runner's `TransientTransactionError` retry rather than treating it as a bug.
- BSON documents are limited to 16 MiB; the adapter stages arbitrary serialized values in immutable parts bounded to 4 MiB.
- Migration verifies validators, validation action/level, index keys, uniqueness, partial filters, and collations.
- Sessions append for the agent-instance lifetime; there is no per-session deletion.
- Startup and `client.connect()` failures are intentional boot failures.
- Standalone `start()` scripts bypass `db.ts`; pass the adapter through `db`.
- The adapter is Node-only and Cloudflare rejects the entry module.

## Related

- [Database](https://flueframework.com/docs/guide/database/) - adapter discovery and selection
- [Durability](https://flueframework.com/docs/guide/durability/) - recovery semantics
- [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) - store contract
- [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/) - supported topology and transaction behavior
- [MongoDB Node driver](https://www.mongodb.com/docs/drivers/node/current/) - client, TLS, and pooling
