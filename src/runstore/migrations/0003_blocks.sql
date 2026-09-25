-- Blocks (D55): a run parked on a system that did not answer, and the
-- resume that sent it on.
--
-- runs.block holds the open block (null when none) and runs.block_history
-- the closed ones, each with its resolution. A submission of kind 'resume'
-- carries the block it closed and the note from the person who resumed.
-- Text inside the jsonb and the note are persisted-profile text, like every
-- other column.

ALTER TABLE triage.runs
  ADD COLUMN block jsonb,
  ADD COLUMN block_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE triage.submissions
  ADD COLUMN block_id text,
  ADD COLUMN note text;
