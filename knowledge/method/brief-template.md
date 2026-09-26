# Brief template

Every `task` you send is a brief with these six fields, in this order. A
delegate inherits nothing from you, so a field left out is something it does
not know.

- Entity: the one entity this delegate covers. One brief per entity. For
  `code_walker`, the entity whose code is in question.
- Question: one precise question the delegate can answer from its own
  entity. Say what "done" looks like.
- Ids: the ids from the run's id chain that this entity can use, written as
  `key = value` with the id key names. There are seven: `country`,
  `phone_number`, `aspora_user_id`, `customer_id`, `account_form_id`,
  `account_id` and `account_number` (the orchestrator note says what each
  one is). Only ids that are in the chain.
- Window: the time window in UTC, written `<from> .. <to>`. Use the run's
  window unless you have a reason to narrow it, and give the reason.
- Services in play: the registry service keys of that entity that matter
  here, for example `harbor`, `rhythm` or `package`.
- Return: `EntityFindings` from an investigator or `CodeFindings` from
  `code_walker`, followed by what to quote or count.

## Worked example

```
Entity: atspl
Question: Was a welcome-letter delivery created for this customer, what did the vendor last report, and is the failure isolated to this customer?
Ids: customer_id = <customer_id>, account_form_id = <account_form_id>
Window: <window_from> .. <window_to>
Services in play: package
Return: EntityFindings. Quote the exact vendor event text. Count distinct customers with the same failure in the window.
```

A brief such as "check the delivery for this user" is not enough: it has no
ids, no window and no expected return, so the delegate has to guess all
three.
