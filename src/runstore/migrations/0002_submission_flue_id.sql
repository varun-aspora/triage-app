-- D71: Flue's submission id on each run store submission, recorded from the
-- dispatch receipt. Stalled detection reads the submission's lease with it.
-- Null on submissions from before D71 and until the receipt arrives.
ALTER TABLE triage.submissions ADD COLUMN flue_submission_id text;
