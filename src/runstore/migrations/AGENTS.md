# Run store migrations

- No foreign key constraints. Do not write `REFERENCES`, `FOREIGN KEY` or `ON DELETE CASCADE` in a migration or in DDL built in code (such as the per-model embedding tables). Owner's rule, 2026-09-26 (D60).
- The code keeps the links instead:
  - a write checks that its run (and submission, where it needs one) exists and throws `RunNotFoundError` otherwise;
  - `deleteRun` deletes the run's rows from every table itself, in one transaction, including each table listed in `triage.embedding_models`.
- A new table that holds per-run rows must be added to `deleteRun` in both providers and to `fake-pg.ts`, with a contract case showing `deleteRun` removes them.
- Migrations are append-only: never edit a file that has been merged to `main`; add the next `NNNN_<name>.sql` instead.
