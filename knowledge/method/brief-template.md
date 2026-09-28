# Brief template

Every `task` you send is a brief with these six fields, in this order. A
delegate inherits nothing from you, so a field left out is something it does
not know.

- Entity: the one entity this delegate covers. One brief per entity. For
  `code_walker`, the entity whose code is in question.
- Question: one precise question the delegate can answer from its own
  entity. Say what "done" looks like, which hypothesis it tests and what
  result would reject it.
- Ids: the ids from the run's id chain that this entity can use, written as
  `key = value` with the id key names. There are seven: `country`,
  `phone_number`, `aspora_user_id`, `customer_id`, `account_form_id`,
  `account_id` and `account_number` (the orchestrator note says what each
  one is). Only ids that are in the chain.
- Window: the time window in UTC, written `<from> .. <to>`. Use the run's
  window (the Window line under This run) until you know when the
  relevant journey started; then start the window there and give the reason.
- Services in play: the registry service keys of that entity that matter
  here, for example `harbor`, `rhythm` or `package`.
- Return: `EntityFindings` from an investigator or `CodeFindings` from
  `code_walker`, followed by what to quote or count.

## Worked example

```
Entity: atspl
Question: Was a welcome-letter delivery created for this customer, what did the vendor last report, and is the failure isolated to this customer? Hypothesis: the vendor rejected the address; rejected if no delivery was created or the vendor reported it delivered.
Ids: customer_id = <customer_id>, account_form_id = <account_form_id>
Window: <window_from> .. <window_to>
Services in play: package
Return: EntityFindings. Quote the exact vendor event text. Count distinct customers with the same failure in the window.
```

When your instructions have a "Known pattern lead" section, add the `Lead:`
line it shows after Question in that entity's brief.

A brief such as "check the delivery for this user" is not enough: it has no
ids, no window and no expected return, so the delegate has to guess all
three.

## Follow-up briefs

When you brief the same entity again (a follow-up, or the deep variant after
the first investigator), add to the Question what was already tried: each
query with its window and what it returned (rows, hits, empty, refused), why
an empty result was empty when the delegate found out (for example, the row
is written only at a later step), and the hypotheses already rejected. Read
the queries with `run_log`, filtered by `agent` or `for_entity`. Then ask for
something new: another key, window or source. The delegate also sees the
run's recent calls at the end of its instructions, and an exact repeat
returns the earlier result without querying again.
