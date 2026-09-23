# Report format

`finish_report` takes the Report draft as its input. It checks the draft
against the schema, masks and checks every text field, and writes the report.
You fill the fields below; the harness adds the run id, the display label,
the generation time, the repo commits and the cost.

## Section order

The rendered report follows the order the team already uses:

1. ID chain (`id_chain`): the ids and how each one was linked.
2. Current state (`current_state`): each item with its value, its `taken_at`
   and its source.
3. Timeline (`timeline`): UTC timestamps, oldest first, each with its entity
   and a pointer to the raw evidence.
4. Root cause (`root_cause`): one statement, with `code_refs` as repo, file and
   lines when code was read. Null when there is no supported root cause.
5. Scope (`scope`): one customer or systemic.
6. Actions (`actions`) for CX, Eng and Ops-Bank, then the suggested fixes
   (`suggested_fix`).
7. Status line (`status`), with `confidence`, `confidence_reason` and the
   evidence ladder.

The CX answer (`cx_answer`) is shown next to the actions, because it is what
the CX team replies with.

## Fields you fill

- `request`: the permalink when there is one, the current ask (the latest
  message) and who asked.
- `classification`: copy it from your input as given.
- `id_chain`: the chain after your last `resolve_identity` call.
- `current_state`: point-in-time values, each with `taken_at` and `source`.
- `timeline`: events with `at`, `entity`, `what` and `source`.
- `root_cause`: `statement`, `code_refs` and, when a known pattern was
  confirmed for this customer, `matched_pattern_id`. Null when inconclusive.
- `scope`: `kind` is `single`, `systemic` or `unknown`; add `affected_count`
  and `how_measured` when a count was taken.
- `status`: one of the status values below.
- `cx_answer`: the fields below.
- `actions`: three lists, `cx`, `eng` and `ops_bank`, in plain sentences.
- `suggested_fix`: the fixes below; an empty list when none applies.
- `confidence` and `confidence_reason`: `high`, `medium` or `low`, as the
  method describes, and one line on why.
- `evidence_ladder`: the rungs actually used, from `api`, `db`, `logs`, `cbs`
  and `code`.
- `entities_consulted`: the entities an investigator was briefed on.
- `gaps`: what could not be checked and why, one line each.
- `escalated` and `escalation_reasons`: write false and an empty list.
  `finish_report` sets them when it escalates.
- `images_seen`: true only if the thread's images were in your input and you
  read them.

## Status

Exactly one of:

- `root_cause_confirmed`: the evidence shows why the issue happened, and the
  backend still has to act.
- `resolved`: the problem no longer holds at the latest `taken_at` (for
  example the account is now active), whatever caused it.
- `pending_user`: the next step is the user's, such as retrying, uploading a
  document or updating the app.
- `pending_bank`: the next step is with the bank or a vendor.
- `inconclusive`: the evidence does not support a root cause. The gaps say
  what is missing.

When more than one fits, use the first that fits in this order: `resolved`,
`pending_user`, `pending_bank`, `root_cause_confirmed`, `inconclusive`.

## cx_answer

- `action_owner`: `user`, `backend`, `bank` or `unknown`. Who has to act
  next.
- `money_safe`: `yes`, `no` or `unknown`. `yes` only when the evidence shows
  the funds are where they should be at the latest `taken_at` (never debited,
  or credited back). `unknown` when no source showed the money.
- `should_retry`: `yes`, `no` or `wait`. `wait` when a pending step on our
  side or the bank's has to finish first.
- `reply_text`: a short reply the CX team can paste to the user. Plain words,
  no internal service names, no ids, no personal data, and no promise the
  evidence does not support.
- `escalate_to`: optional. The team or role to escalate to, when someone must
  pick it up.

## suggested_fix

A suggested fix is a command for a human to run after reading the report.
Fixes are never executed: not by you, not by a delegate and not by
`finish_report`. No tool in the run can run them.

Each fix has:

- `title`: what the fix does, in a few words.
- `kind`: `curl`, `sql` or `manual`.
- `command`: the command, or for `manual` the steps. Hosts, tokens, keys and
  personal data appear only as `$VAR` placeholders such as `$HARBOR_ADMIN_BASE`
  or `$ADMIN_TOKEN`. The run's internal ids may appear as they are.
- `preconditions`: what must be true before running it, including where each
  `$VAR` value comes from.
- `verify_with`: the read that shows the fix worked.

Write actions appear only as a suggested fix, never as something done. They
include `trigger-delivery`, `sync-address`, `trigger-customer-creation`,
`debit-unfreeze` and `force-sign`. The matching line under `actions` points
at the fix.

An example of the shape:

```
title: Retrigger the welcome-letter delivery
kind: curl
command: curl -sS -X POST "$PACKAGE_ADMIN_BASE/<delivery_path>" -H "Authorization: Bearer $PACKAGE_ADMIN_TOKEN" -d '{"customer_id": "<customer_id>"}'
preconditions: The address sync has finished. $PACKAGE_ADMIN_BASE and $PACKAGE_ADMIN_TOKEN come from the operator's own access.
verify_with: A new delivery row for <customer_id> with a created status.
```
