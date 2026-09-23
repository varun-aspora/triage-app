---
title: Data Persistence API
source: https://flueframework.com/docs/reference/data-persistence-api/
bundled_docs: bunx flue docs read reference/data-persistence-api
version: 2.0.8
reviewed: 2026-09-17
---

# Data Persistence API

## What and when

This is the backend contract for Flue's durable submission ledger, canonical conversation log, and immutable attachment bytes. Use it to implement or review a persistence adapter. Types/helpers are public from `@flue/runtime/adapter`; executable contract suites are from `@flue/runtime/test-utils`.

This adapter surface is Node-only. Cloudflare uses per-agent Durable Object SQLite, rejects `db.ts` at build time, and does not use custom persistence adapters. The settlement/lease method groups may change before 1.0.

## Public API index

| API/type | Purpose |
| --- | --- |
| `PersistenceAdapter` | Startup migration/connect/shutdown contract. |
| `PersistenceStores` | Required three-store bundle. |
| `AgentSubmissionStore` | Queue, ownership, attempts, joins, leases, settlement. |
| `ConversationStreamStore` | Fenced append-only canonical record batches. |
| `AttachmentStore` | Conversation-scoped immutable bytes. |
| `defineSqlConversationStreamStore()` | Complete stream implementation over an async SQL dialect. |
| `InMemoryConversationStreamStore`, `InMemoryAttachmentStore`, `StreamListenerRegistry` | Reference building blocks. |
| Admission/session/attachment helpers | Shared validation, keys, chunking, hashes, and comparisons. |
| Three contract-test definers | Executable acceptance specification. |

When docs and installed package types differ, the package contract wins.

## Adapter lifecycle

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

At Node startup Flue calls optional `migrate()` once, then awaits `connect()` once. `close()` releases resources at shutdown. Put pool setup/handshakes and, when no migrate method exists, format checks in `connect()` so connectivity/version failure happens at boot.

`migrate()` creates missing schema and stamps/checks the format version. The built-in reference is `sqlite(path?)` from `@flue/runtime/node`.

## Submission store API

```ts
interface AgentSubmissionStore {
  getSubmission(id: string): Promise<AgentSubmission | null>;
  hasUnsettledSubmissions(): Promise<boolean>;
  listRunnableSubmissions(): Promise<AgentSubmission[]>;
  listUnreadySubmissions(): Promise<AgentSubmission[]>;
  listRunningSubmissions(): Promise<AgentSubmission[]>;
  listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]>;
  replaceSubmissionAttempt(
    attempt: SubmissionAttemptRef,
    nextAttemptId: string,
    lease?: { ownerId: string; leaseExpiresAt: number },
  ): Promise<AgentSubmission | null>;

  admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
  admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission>;
  markSubmissionCanonicalReady(id: string): Promise<AgentSubmission | null>;

  claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
  markSubmissionInputApplied(
    attempt: SubmissionAttemptRef,
    durability?: SubmissionDurability,
  ): Promise<boolean>;
  requestSessionAbort(sessionKey: string): Promise<string[]>;
  requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  reserveSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    settlement: { recordId: string; record: SubmissionSettledRecord },
  ): Promise<SubmissionSettlementObligation | null>;
  finalizeSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    recordId: string,
    options?: { errorMessage?: string },
  ): Promise<boolean>;
  completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;

  claimJoinableSubmissions(
    host: SubmissionAttemptRef,
    agentName: string,
  ): Promise<AgentSubmission[]>;
  finalizeJoinedSubmission(host: SubmissionAttemptRef, id: string): Promise<boolean>;
  revertJoiningSubmission(host: SubmissionAttemptRef, id: string): Promise<boolean>;
  listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]>;

  renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
  listExpiredSubmissions(): Promise<AgentSubmission[]>;
}
```

Supporting public types include `AgentSubmission`, attempt/claim refs, durability, settlement obligations, dispatch admission/receipt, and direct/dispatch inputs.

### State and query invariants

Normal state is `queued -> running -> terminalizing -> settled`; direct settle helpers may move running to settled. Join absorption uses `queued -> joining -> joined`, then host settlement propagates.

- `hasUnsettledSubmissions` includes queued, running, joining, and joined.
- Runnable results contain only each session's oldest unsettled queued head, globally in admission order; at most one head per session.
- Unready means queued but canonical input not materialized.
- Running and joined listings preserve admission order.
- Attempt replacement is atomic, only for the matching running attempt; it increments `attemptCount` and optionally installs a lease.

### Admission invariants

- `admitDispatch` is keyed by submission ID. Exact replay returns the existing admission; different payload is `conflict`; an ID retained as a receipt yields `retained_receipt` without admission.
- `admitDirect` is also exact-replay idempotent by ID and payload.
- Canonical-ready marking is idempotent only while queued; missing/non-queued returns null.

### Ownership and settlement invariants

- `claimSubmission` is an atomic queued-to-running compare-and-set, allowed only for the session's runnable head. Concurrent claims cannot both succeed.
- `markSubmissionInputApplied` once-guards durability defaults/config via `inputAppliedAt`; canonical stream content, not that timestamp, proves input persistence.
- Abort stamps first `abortRequestedAt` on all unsettled session submissions and returns IDs. It does not change status or settle rows.
- Requeue requires matching attempt ownership and clears attempt, owner, lease, and durability stamp.
- Settlement reservation atomically stores the exact canonical record obligation and terminalizes. Exact retry returns it; conflicting identity/content returns null.
- Finalization requires matching attempt, terminalizing status, and canonical record. Its error column mirrors outcome.
- Complete/fail are ownership-gated; stale/already-terminal attempts return false. First terminal state wins.
- Host settlement atomically gives joined submissions the same outcome and requeues unconfirmed joining stragglers.

### Join and lease invariants

- Claim joins only the contiguous queued prefix for a still-owned running host and sets `joinedInto`.
- Finalize joining only after that input's canonical record exists.
- Revert joining only while its canonical input does not exist.
- Lease renewal extends matching running rows owned by `ownerId`; all others are skipped.
- Expiry listing includes only running rows past lease expiry.

Constants: `DURABILITY_DEFAULT_MAX_ATTEMPTS = 10`, `DURABILITY_DEFAULT_TIMEOUT_MS = 3_600_000`, `LEASE_DURATION_MS = 30_000`.

## Conversation stream API

```ts
interface ConversationStreamStore {
  createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
  acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
  append(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: { submissionId: string; attemptId: string };
    records: readonly ConversationRecord[];
  }): Promise<{ offset: string }>;
  read(
    path: string,
    options?: { offset?: string; limit?: number },
  ): Promise<ConversationStreamReadResult>;
  getMeta(path: string): Promise<ConversationStreamMeta | null>;
  subscribe(path: string, listener: () => void): () => void;
  putFoldCheckpoint?(path: string, value: ConversationFoldCheckpoint): Promise<void>;
  getFoldCheckpoint?(
    path: string,
    options?: { atOrBefore?: string },
  ): Promise<ConversationFoldCheckpoint | null>;
}
```

The stream is the only authoritative transcript. Do not maintain a second transcript in session rows, snapshots, or event tables.

- Racing same-identity creates both succeed; conflicting identity for an existing path throws. Creation mints a new incarnation.
- Producer acquisition increments epoch, resets producer sequence, returns current head/incarnation, and fences all prior producers.
- Append requires current producer ID, epoch, incarnation, and next sequence. It writes the complete record array atomically under one offset.
- Exact sequence retry returns its original offset; conflicting retry throws.
- Records carrying submission/attempt identity require matching `submission` authorization and durable attempt ownership.
- Rejected stream operations throw `ConversationStreamStoreError` and leave state unchanged.
- Read is strictly after offset, default `-1`. Offset `now` returns no batches and current head.
- Limits clamp to default 100 and max 1000. Beyond-head offset throws. Unknown path reads empty/up-to-date.
- `subscribe` is process-local, best-effort wakeup only; it is neither durable nor cross-process.

Offsets are opaque and stream-ordered. `formatOffset`/`parseOffset` convert integer sequences only when implementing a store.

### Optional fold checkpoints

A checkpoint is one replaceable serialized fold cache per path, never authority. Runtime validates version, incarnation, and offset; mismatch silently falls back to full log replay. Implement both methods or neither. Without them Flue remains correct, warns once per path, and replays from origin.

Writes must be torn-write safe: partial data reads absent or fails, never as plausible state. `atOrBefore` returns a checkpoint only when its offset does not exceed the bound.

## Attachment store API

```ts
interface AttachmentStore {
  put(input: PutAttachmentInput): Promise<void>;
  get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
}
```

An `AttachmentRef` contains `id`, `mimeType`, `size`, SHA-256 `digest`, and optional `filename`. Filename is presentation metadata and excluded from identity comparison.

- Put is scoped by owning stream/conversation and immutable by ID.
- Exact repeated/concurrent put of the same ref and bytes succeeds.
- Reusing ID with different bytes, identity metadata, or owner throws `AttachmentConflictError`.
- Size/digest mismatch throws `AttachmentIntegrityError`.
- Get returns null for unknown ID or wrong conversation and verifies integrity on read.

Helpers include `createAttachmentRef`, `verifyAttachmentBytes`, `sameAttachmentRef`, `attachmentBytesEqual`, and `copyAttachmentBytes`.

## Cross-store storage rules

1. Exact identity/content replay is idempotent; same identity with different content conflicts rather than overwrites.
2. Producer epochs/incarnations fence stale writers; submission-owned records additionally require owned attempts.
3. Canonical record batches are append-only, totally ordered, and all-or-nothing.
4. The first terminal submission state cannot be overwritten.
5. Atomic methods allow at most one concurrent caller to observe success, regardless of backend primitive.
6. Every newly created store durably records `FLUE_FORMAT_VERSION = 1` and rejects unknown/newer versions before data access using `PersistedFormatVersionError`.

Format changes are reset-only, not in-place migrations. Built-in SQL stores use `flue_meta` key `format_version`; non-SQL adapters must provide equivalent durable behavior. `assertSupportedFlueFormatVersion()` performs validation.

## End-to-end implementation workflow

1. Implement or choose atomic transaction/conditional-write primitives for ownership, queue heads, idempotency, and immutable IDs.
2. Implement schema creation plus format stamping before exposing stores.
3. Build all three stores; do not omit attachments or model a second conversation truth.
4. Preserve input payloads and exact serialized settlement/record identity for replay comparisons.
5. Fence stream append by producer epoch, incarnation, sequence, and optional submission attempt.
6. Add optional checkpoints only as validated, replaceable caches.
7. Return all stores from one startup `connect()` and release the driver in `close()`.
8. Run every contract suite against fresh isolated storage, including concurrent cases and format-version tests.

## Contract test suites

```ts
import {
  defineAttachmentStoreContractTests,
  defineConversationStreamStoreContractTests,
  defineStoreContractTests,
} from '@flue/runtime/test-utils';
```

- `defineStoreContractTests`: submissions, queue ordering, claims, readiness, abort, settlement obligations, attempt recovery, leases, joins, durability. Optional `backend.formatVersion` enables stamp tests through raw open/read/write/delete hooks.
- `defineConversationStreamStoreContractTests`: racing create, atomic ordering, exact/conflicting retries, producer fences, attempt authorization, reads. `create()` returns `{ stream, submissionStore? }`; authorization tests need the submission store. Also exported from `/conversation-stream`.
- `defineAttachmentStoreContractTests`: byte round-trip, concurrent idempotent puts, conflicts, integrity. Also exported from `/attachment-store`.

Each registered test gets a fresh `backend.create()` result and optional cleanup runs afterward. These suites are the acceptance bar, not illustrative tests.

## Adapter helpers

- `admitSubmissionWithBackend`: shared row-oriented admission algorithm; caller owns transaction. It can return synchronously when all callbacks do.
- `isSubmissionPayload`, `parseAcceptedAt`, `clampLimit`: persisted validation/parsing/limit behavior.
- `createSessionStorageKey` / `parseSessionStorageKey`: session-lane identity. External submissions use harness/session constants both equal to `default`.
- `createDispatchAgentSubmissionInput`: normalize dispatch to persisted input.
- Attachment preparation/hydration/comparison and `sameSubmissionChunks`: oversized-row-safe submission payload chunking keyed by submission ID.

## Recommended patterns

- Treat package docblocks and all contract suites as the executable specification.
- Use database-native conditional writes/transactions for every observable atomic boundary.
- Keep canonical streams append-only and derive snapshots/state by replay.
- Compare complete replay identity before declaring an operation idempotent.
- Fail startup on connectivity or format incompatibility.

## Avoid

- Do not apply this adapter API on Cloudflare or use `db.ts` there.
- Do not notify across processes via `subscribe`; use it only as a local wakeup optimization.
- Do not update canonical records, partially append batches, or let stale producers write.
- Do not use `inputAppliedAt` as proof of canonical persistence.
- Do not migrate incompatible format versions in place or accept newer versions.

## Gotchas and errors

- Shared database storage does not itself guarantee a single live Node owner for one conversation.
- Abort is intent only; settlement remains attempt-owned and asynchronous.
- A retained dispatch receipt prevents re-admission even after the original row is gone.
- A checkpoint can improve replay but can never repair or replace the log.
- Attachment filename changes alone do not change ref identity, but owner/content metadata does.

## Related

- [Database guide](https://flueframework.com/docs/guide/database/)
- [Durability guide](https://flueframework.com/docs/guide/durability/)
- [Streaming protocol](https://flueframework.com/docs/reference/streaming-protocol/)
- [Errors reference](https://flueframework.com/docs/reference/errors/)
- [Cloudflare target guide](https://flueframework.com/docs/guide/cloudflare-target/)
