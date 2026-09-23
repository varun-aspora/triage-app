# turn_end

**Fires:** after the assistant and tool-result messages have been persisted, and
before the low-level `turn_end`.
**Can change:** yes — can rewrite the turn's proposed entries and force one
continuation.

Along with `agent_before_settle`, this is one of two *actionable boundaries*.
They share the same entries/continue contract.

## Signature

```typescript
let replacedResponse = false;

pi.on("turn_end", async (event, ctx) => {
  if (replacedResponse || event.outcome !== "completed" || event.toolResults.length > 0) return;
  replacedResponse = true;
  return {
    entries: [
      ...event.entries,
      { type: "context_edit", targetId: event.messageEntryId, replacement: null },
      {
        type: "custom_message",
        customType: "replacement-instruction",
        content: "Answer again using the persisted user request.",
        display: false,
      },
    ],
    continue: true,
  };
});
```

## Event

| Field | Meaning |
|---|---|
| `turnIndex` | Turn number within the run |
| `message` | The assistant message |
| `toolResults` | Tool results from this turn |
| `messageEntryId` | Entry ID of the assistant message — the handle for `context_edit` |
| `toolResultEntryIds` | Entry IDs of the tool results |
| `outcome` | How the turn ended |
| `entries` | Structural entries proposed so far (spread these) |
| `continue` | Current continuation decision |
| `context` | Context rebuilt from the current proposal |

## Return value

Same contract as [agent_before_settle.md](agent_before_settle.md): `entries`
(types `custom`, `custom_message`, `context_edit`, `compaction`) and `continue`.
Omitted fields keep the current proposal.

## Where to use it

- **Redact a response before it persists** — replace an assistant message
  containing a secret via `context_edit`.
- **Retry a bad answer** — drop the message and re-ask with a sharper
  instruction, without the user seeing a failed attempt.
- **Enforce a protocol** — if the model was supposed to call a tool and didn't,
  append an instruction and continue.
- **Turn-level annotations** that should sit inline in the transcript.

## Gotchas

- **Guard the continuation.** Unconditional `continue: true` re-evaluates after
  the next response and loops forever.
- Spread `event.entries`; returning a bare array drops other extensions' work.
- Error and aborted outcomes are hard exits — `continue` won't rescue them.
- Retry backoff and final-attempt recovery still happen after `agent_end`, so
  `agent_before_settle` sees the repaired projection later.
- Host integrations constructing `TurnEndEvent` must supply `messageEntryId`,
  `toolResultEntryIds`, `outcome`, `entries`, `continue`, and `context`, and
  dispatch through `emitBoundary()` rather than `ExtensionRunner.emit()`.
