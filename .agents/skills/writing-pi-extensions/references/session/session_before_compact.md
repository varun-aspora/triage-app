# session_before_compact

**Fires:** before compaction runs, whether manual (`/compact`), threshold, or
context overflow.
**Can change:** yes — can cancel, or replace the summary entirely.

## Signature

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  return { cancel: true };

  // or supply your own summary:
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage,  // optional, counted in session totals
    },
  };
});
```

## Event

| Field | Meaning |
|---|---|
| `preparation` | pi's plan: `firstKeptEntryId`, `tokensBefore`, and related figures |
| `branchEntries` | The entries on the active branch being compacted |
| `customInstructions` | Instructions passed to `/compact` or `ctx.compact()` |
| `reason` | `"manual"` \| `"threshold"` \| `"overflow"` |
| `willRetry` | Whether the aborted turn is retried after compaction (overflow recovery) |
| `signal` | Abort signal — pass it to your summarizing model call |

## Where to use it

- **Domain-aware summaries** — keep the file paths touched, the failing test
  names, and the open questions, instead of a generic prose recap.
- **Cheaper compaction** — summarize with a small fast model rather than the
  session model.
- **Structured carry-over** — emit a summary in a fixed shape the rest of your
  extension can parse back out later.
- **Refuse to compact** mid-operation, e.g. while your extension is holding a
  half-applied migration.

## Gotchas

- Pass `event.signal` into your summarizer call. Without it, Esc won't cancel a
  slow compaction.
- Reuse `preparation.firstKeptEntryId` unless you genuinely mean to keep a
  different cut point; inventing one can drop messages the model still needs.
- On `reason: "overflow"`, cancelling means the turn that overflowed still has
  nowhere to go. Cancel deliberately.
- Report `usage` if you called a model, otherwise session cost totals under-count.

## See also

[session_compact.md](session_compact.md) · [session_compact_failed.md](session_compact_failed.md)
