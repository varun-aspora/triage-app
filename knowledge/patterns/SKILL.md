---
name: patterns
description: The known-issue index. patterns.json lists known failure signatures, each with a query recipe to try first, a tier hint and whether its root cause is confirmed. Use it when the classification carries a matched_pattern_id, or when the thread's error text looks like a known issue, to pick the first checks for an investigator brief.
metadata:
  kind: patterns
  entity: shared
  sources: the Known issues sections of the knowledge service notes, skills/aspora-harbor-shivalik-sim-binding-issue/SKILL.md, docs/02-hld-detailed.md
  status: written
---

# Known patterns

`patterns.json`, next to this note, is the index of known issues. Read it with
`read_skill_resource`. Ingress already ran a cheap match against it, so the
classification may carry a `matched_pattern_id`. You can also look an entry
up yourself when a delegate's answer quotes an error text that looks familiar.

## What a match means

- A match is a hint about where to look first, not a conclusion. It says
  "this error text has been seen before, and this is the quickest way to check
  it". It says nothing yet about this customer.
- Try the entry's `query_recipe` first, then investigate as usual. If the
  recipe finds nothing, drop the pattern, say so in the report and carry on
  with the normal evidence ladder.
- A `stable` entry has a root cause that the source confirmed. It still needs
  evidence for this customer before it goes into the report. The tier policy
  may run a stable match one tier lower; that changes the model, not the
  standard of proof.
- A match on its own is `low` confidence. Record `matched_pattern_id` in the
  report's root cause only when evidence for this customer confirms the
  pattern.

## Using an entry

| Field | What to do with it |
|---|---|
| `id` | The id to record as `matched_pattern_id` once confirmed. |
| `category` | The classifier category the entry belongs to. A match only counts in that category. |
| `signature.regex` | Error texts that point at the entry. Matched case-insensitively. |
| `signature.services` | Registry services (`entity:service`) the error comes from. Empty means any service. |
| `entities` | The entities to brief. Send the recipe's part for each entity to that entity's investigator. |
| `query_recipe` | The first checks, written as investigator tool calls. Copy them into the brief with the ids and window from the id chain. |
| `tier_hint` | The tier that usually settles it. `strong` means brief `investigate_<entity>_deep`, or escalate. |
| `stable` | True only when the source records a confirmed root cause. |
| `source_ref` | The note and heading the entry came from. Activate that note if you need the detail. |

The recipes use `<placeholder>` ids. Replace them with ids from the id chain,
never with ids you guessed. A brief still needs everything the brief template
asks for: ids, window, services, the question and what to return.

## Out of reach: remittance orders

The remittance order backend (`/appserver/v3/order`) is not mapped to any
entity. None of the investigators can read it, and past cases about it ended in
escalation. When a thread points at it (entry `remittance-order-out-of-reach`):

- Do not loop looking for another way in.
- At most, ask `investigate_ssfb` to show from the account statement whether a
  credit arrived in the window.
- List the order backend in `gaps`, and fill `action_owner` and
  `escalate_to` so the report says who takes it from here.

## Curating the index

- Entries come from the `## Known issues` sections of the service notes and
  from the old workspace's skills. Never from past case folders: they hold
  customer data.
- Every entry names its source in `source_ref`: `knowledge/<note>/SKILL.md#<heading>`,
  or the old workspace's skill file by its path in that workspace.
- `stable` is set to true in a reviewed change, and only when the source
  records a confirmed root cause. Hedged sources ("usually", "suspect",
  "often") stay false.
- Entries are matched in file order and the first match wins, so put the more
  specific entry first.
