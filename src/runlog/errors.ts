// Which event log lines count as errors: the rule behind `triage logs
// --errors` and the web console's Steps > Errors tab.
//
// A line is an error when its data says isError (tool, turn, task,
// operation), when it is a failure or recovery step (failed,
// submission_recovery, server_shutdown, which explains the aborts that
// follow it), when a submission or the run settled other than
// cleanly (submission_settled not completed, settled failed), or when it is a
// log line at warn or error level.
//
// The web console keeps its own copy (web/src/pages/runs/verdict-logic.ts),
// because no runtime code from src/ goes into the web bundle.
// web/src/pages/runs/verdict-logic.test.ts runs both over the cases in
// test/support/error-event-cases.ts so they cannot drift apart.

import type { RunEventLine } from './event-log.ts';

type Data = Record<string, unknown>;

export function isErrorEvent(e: Pick<RunEventLine, 'type' | 'data'>): boolean {
  const d = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as Data;
  if (d.isError === true) return true;
  if (e.type === 'failed' || e.type === 'submission_recovery' || e.type === 'server_shutdown') return true;
  if (e.type === 'submission_settled' && d.outcome !== 'completed') return true;
  if (e.type === 'settled' && d.status === 'failed') return true;
  if (e.type === 'log' && (d.level === 'error' || d.level === 'warn')) return true;
  return false;
}
