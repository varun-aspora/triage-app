# session_compact

**Fires:** after a compaction succeeds.
**Can change:** no. Notification only.

## Signature

```typescript
pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry - the saved compaction entry
  // event.fromExtension  - true if an extension supplied the summary
  // event.reason         - "manual" | "threshold" | "overflow"
  // event.willRetry      - whether the aborted turn is retried after this
});
```

## Where to use it

- **Re-check a state rebuild that reads `buildContextEntries()`.** Compaction
  does not delete entries — "omitted raw entries remain stored" — so a rebuild
  walking `getBranch()` is unaffected. Only readers that honour compaction lose
  the pre-`firstKeptEntryId` span. If you see state vanish on `/compact`, you
  are using the wrong reader, not losing data.
- **Telemetry** — record how often threshold vs overflow compaction fires, and
  how many tokens it reclaimed, to tune `reserveTokens`.
- **Notify the user** that context was compacted, with what survived.
- **Append a marker entry** so later `/tree` navigation shows where compaction
  happened.

## Gotchas

- Check `fromExtension` before assuming the summary matches a format your own
  `session_before_compact` produced — another extension may have won.
- `willRetry: true` means a turn is about to be re-issued. Avoid firing
  user-facing notifications that will look duplicated.
