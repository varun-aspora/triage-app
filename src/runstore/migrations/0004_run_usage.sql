-- Token usage of a run (D59): one row per submission, model, agent and
-- purpose.
--
-- seq 0 holds the intake calls (classifier, prior-cases embedding) made before
-- the first submission, so seq does not always name a submission. There is no
-- foreign key (D60): putUsage checks the run exists and deleteRun removes the
-- rows with the run. A write replaces every row of one seq. usd is priced
-- when the row is captured and is null when no price is known. final is false
-- for a live snapshot taken while the submission runs; a non-final write never
-- replaces final rows.
--
-- The text columns hold a model spec, an agent name and a fixed purpose,
-- checked by UsageRowSchema; they are not persisted-profile text.

CREATE TABLE triage.run_usage (
  run_id             text    NOT NULL,
  seq                integer NOT NULL CHECK (seq >= 0),
  model              text    NOT NULL,
  agent              text    NOT NULL,
  purpose            text    NOT NULL,
  calls              integer NOT NULL,
  failed_calls       integer NOT NULL,
  input_tokens       integer NOT NULL,
  output_tokens      integer NOT NULL,
  cache_read_tokens  integer NOT NULL,
  cache_write_tokens integer NOT NULL,
  usd                double precision,
  final              boolean NOT NULL,
  updated_at         timestamptz NOT NULL,
  PRIMARY KEY (run_id, seq, model, agent, purpose)
);
