-- D82: the tracing root span of each run store submission (a Braintrust span
-- reference, kept as the tracing code sent it). Feedback scores go to the
-- latest submission's span. Null when tracing was off, until the span is
-- captured, and on submissions from before D82.
ALTER TABLE triage.submissions ADD COLUMN trace_span_id text;
