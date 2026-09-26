// Event log lines and whether each counts as an error. Shared by
// src/runlog/errors.test.ts and the web parity test in
// web/src/pages/runs/verdict-logic.test.ts, which runs both copies of the
// rule over this table.

export type ErrorEventCase = { readonly name: string; readonly type: string; readonly data: unknown; readonly error: boolean };

export const ERROR_EVENT_CASES: readonly ErrorEventCase[] = [
  { name: 'tool with isError', type: 'tool', data: { toolName: 'sql_select', isError: true }, error: true },
  { name: 'tool ok', type: 'tool', data: { toolName: 'sql_select', isError: false }, error: false },
  { name: 'turn with isError', type: 'turn', data: { isError: true }, error: true },
  { name: 'task with isError', type: 'task', data: { isError: true }, error: true },
  { name: 'operation with isError', type: 'operation', data: { isError: true }, error: true },
  { name: 'isError as a string is not an error', type: 'tool', data: { isError: 'true' }, error: false },
  { name: 'failed', type: 'failed', data: { error: { message: 'x' } }, error: true },
  { name: 'submission_recovery', type: 'submission_recovery', data: {}, error: true },
  { name: 'server_shutdown', type: 'server_shutdown', data: { signal: 'SIGTERM', active_runs: 1 }, error: true },
  { name: 'submission_settled aborted', type: 'submission_settled', data: { outcome: 'aborted' }, error: true },
  { name: 'submission_settled with no outcome', type: 'submission_settled', data: {}, error: true },
  { name: 'submission_settled completed', type: 'submission_settled', data: { outcome: 'completed' }, error: false },
  { name: 'settled failed', type: 'settled', data: { status: 'failed' }, error: true },
  { name: 'settled completed', type: 'settled', data: { status: 'completed' }, error: false },
  { name: 'log error', type: 'log', data: { level: 'error', message: 'x' }, error: true },
  { name: 'log warn', type: 'log', data: { level: 'warn', message: 'x' }, error: true },
  { name: 'log info', type: 'log', data: { level: 'info', message: 'x' }, error: false },
  { name: 'phase', type: 'phase', data: { phase: 'investigating' }, error: false },
  { name: 'data null', type: 'phase', data: null, error: false },
  { name: 'data a string', type: 'failed', data: 'boom', error: true },
];
