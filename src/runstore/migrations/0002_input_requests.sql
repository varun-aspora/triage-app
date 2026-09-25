-- Input requests (P6 §4.3, D52): the question a run asks the person who
-- started it, and the answers.
--
-- runs.input_request holds the open question (null when none) and
-- runs.input_history the closed ones, each with its resolution. A submission
-- of kind 'answer' carries the answer text and the question it resolves.
-- Text inside the jsonb is persisted-profile text, like every other column.

ALTER TABLE triage.runs
  ADD COLUMN input_request jsonb,
  ADD COLUMN input_history jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE triage.submissions
  ADD COLUMN question_id text,
  ADD COLUMN answer text;
