// What the server writes when SIGINT or SIGTERM stops it, before stop()
// closes the Flue runtime and the coordinator aborts every running
// submission. Without it a killed run's event log shows only the aborts (a
// model stream that ended early, tool AbortErrors), which read like provider
// failures.
//
// noteShutdown writes one stderr line with the signal and the number of
// active runs, then one 'server_shutdown' pipeline line per active run, and
// flushes the event log to disk before it returns. The active runs are the
// ones the event log's Flue subscriber saw start and not settle
// (activeRuns() in src/runlog/event-log.ts): in-process, so there is no
// run store query to wait on.
//
// flushBeforeExit writes what stop() queued after that (the aborted
// submissions' Flue events) just before the process exits.
//
// flushTracesBeforeExit then waits, for a few seconds at most, for the
// Braintrust spans still queued (D82), including the ones stop() closed.
// process.exit() skips Braintrust's own beforeExit flush, so without it the
// last spans of a killed run are lost. It returns at once when tracing is
// off.
//
// None of them throws: a failure to log must not hold up the shutdown.

import { activeRuns, flushRunEventLogSync, logRunEvent, type ActiveRun } from '../runlog/event-log.ts';
import { flushBraintrust } from '../tracing/braintrust.ts';

export type NoteShutdownDeps = {
  /** Defaults to activeRuns() from the event log. */
  readonly activeRuns?: () => readonly ActiveRun[];
  /** Defaults to flushRunEventLogSync(). */
  readonly flush?: () => void;
  /** Defaults to process.stderr. */
  readonly write?: (line: string) => void;
};

/** Records a signal-driven shutdown on stderr and in each active run's event log. Returns the number of active runs. */
export function noteShutdown(signal: string, deps: NoteShutdownDeps = {}): number {
  let runs: readonly ActiveRun[] = [];
  try {
    runs = (deps.activeRuns ?? activeRuns)();
  } catch {
    // Unknown; the line below says 0.
  }
  try {
    const write = deps.write ?? ((line: string) => void process.stderr.write(line));
    write(`triage-server: ${signal} received, stopping with ${runs.length} active run${runs.length === 1 ? '' : 's'}\n`);
  } catch {
    // stderr gone; carry on.
  }
  for (const run of runs) {
    try {
      logRunEvent(run.runId, 'server_shutdown', {
        signal,
        active_runs: runs.length,
        attempt: run.attempt,
        ...(run.phase !== undefined ? { phase: run.phase } : {}),
      });
    } catch {
      // One run's line failing does not stop the others.
    }
  }
  // A failed flush leaves the lines queued; the drain may still write them.
  flushBeforeExit(deps.flush);
  return runs.length;
}

/** Writes the lines still queued (the aborts stop() caused) before the process exits. Never throws. */
export function flushBeforeExit(flush: () => void = flushRunEventLogSync): void {
  try {
    flush();
  } catch {
    // Exiting anyway.
  }
}

/** Waits for the queued Braintrust spans, bounded by flushBraintrust's timeout. Never rejects. */
export async function flushTracesBeforeExit(flush: () => Promise<unknown> = flushBraintrust): Promise<void> {
  try {
    await flush();
  } catch {
    // Exiting anyway.
  }
}
