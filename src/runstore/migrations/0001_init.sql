-- Run store tables for the postgres provider (D43, HLD 02 §7, P2 §3.3).
--
-- Everything lives in schema triage on TRIAGE_DB_URL, next to Flue's own
-- tables, which this file never touches. src/runstore/migrate.ts applies it
-- once inside a transaction and records it in triage.schema_migrations.
--
-- Left out on purpose (D43): an audit table (audit stays in the JSONL), a
-- vector index (exact scan at this volume) and a fixed-dimension vector
-- column. Embeddings go into one table per model, triage.emb_<slug>, which the
-- provider creates on first use and registers in triage.embedding_models.
--
-- No foreign keys (D60). The code keeps the links instead: every write checks
-- that its run (and submission) exists, and deleteRun deletes the run's rows
-- from every table itself. The rule is in migrations/AGENTS.md.
--
-- Text columns hold persisted-profile (redacted) text only. category and the
-- other labels are text, not enums, so a new class of case needs no migration.

CREATE SCHEMA IF NOT EXISTS triage;

-- pgvector supplies the vector type the per-model embedding tables use.
CREATE EXTENSION IF NOT EXISTS vector;

-- Same definition as the migrator's bootstrap, so either can run first.
CREATE TABLE IF NOT EXISTS triage.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- input_request holds the open question to the person who started the run
-- (null when none) and input_history the closed ones, each with its
-- resolution (P6 §4.3, D53). block holds the open block, a run parked on a
-- system that did not answer, and block_history the closed ones (D55).
CREATE TABLE triage.runs (
  run_id text PRIMARY KEY,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  phase text NOT NULL,
  phase_reason text,
  worker_pid integer,
  category text,
  subcategory text,
  tier_proposed text,
  tier_final text,
  rule_fired text,
  matched_pattern_id text,
  report_status text,
  escalated boolean,
  request jsonb NOT NULL,
  classification jsonb,
  id_chain jsonb,
  input_request jsonb,
  input_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  block jsonb,
  block_history jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX runs_created_at_idx ON triage.runs (created_at);

-- A submission of kind 'answer' carries question_id and answer, the question
-- it resolves and the answer text. One of kind 'resume' carries block_id and
-- note, the block it closed and the note from the person who resumed.
CREATE TABLE triage.submissions (
  run_id text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  kind text NOT NULL,
  question text,
  created_at timestamptz NOT NULL,
  question_id text,
  answer text,
  block_id text,
  note text,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE triage.evidence (
  run_id text NOT NULL,
  key text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  findings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, key, version)
);

CREATE TABLE triage.reports (
  run_id text NOT NULL,
  seq integer NOT NULL,
  report jsonb NOT NULL,
  report_md text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

-- Append-only; the row with the highest id is the current verdict.
CREATE TABLE triage.feedback (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  verdict text NOT NULL,
  given_by text NOT NULL,
  given_at timestamptz NOT NULL,
  body jsonb NOT NULL,
  body_md text
);

CREATE INDEX feedback_run_id_idx ON triage.feedback (run_id, id);

-- A claim can be made before its run row exists.
CREATE TABLE triage.idempotency (
  key_sha256 text PRIMARY KEY,
  run_id text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX idempotency_expires_at_idx ON triage.idempotency (expires_at);

-- One row per embedding model. table_name is the per-model table in schema
-- triage and dims is fixed by the first vector stored for the model.
CREATE TABLE triage.embedding_models (
  model text PRIMARY KEY,
  table_name text NOT NULL UNIQUE,
  dims integer NOT NULL CHECK (dims >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Token usage of a run (D59): one row per submission, model, agent and
-- purpose.
--
-- seq 0 holds the intake calls (classifier, prior-cases embedding) made before
-- the first submission, so seq does not always name a submission. A write
-- replaces every row of one seq. usd is priced when the row is captured and is
-- null when no price is known. final is false for a live snapshot taken while
-- the submission runs; a non-final write never replaces final rows.
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
