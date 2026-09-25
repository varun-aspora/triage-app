// Per-run record of the connector failures the tool pipeline saw (D55).
//
// runIoTool records one entry every time it returns the "did not answer"
// envelope for a connector error: the system as the tool result named it
// (<entity>:<service>), the tool, the code and the time. stop_blocked checks
// the systems the model names against this record, so a run can only block
// on a system that actually failed in it. Blank config (not_configured),
// gate refusals, fixture misses, aborts and connector refusals are gaps to
// record, never failures here.
//
// The record is held in this module's closure, keyed by run id, like
// escalationFor in src/agents/escalation.ts: delegates run in the same
// process as the root, so a failure inside an investigator is seen by the
// root's stop_blocked call. settleRun releases it with the run's other
// per-run state, so a resumed run starts with an empty record and must see
// the system fail again before it can block again. Records for different
// run ids never share state.
import * as v from 'valibot';
import { type ConnectorFailure, ConnectorFailureSchema } from '../../types/block.ts';
import { type RunId, RunIdSchema } from '../../types/core.ts';

const failures = new Map<RunId, ConnectorFailure[]>();

/** Appends one failure to the run's record. The value is checked and copied. */
export function recordConnectorFailure(runId: RunId, failure: ConnectorFailure): void {
  const id = v.parse(RunIdSchema, runId);
  const entry = v.parse(ConnectorFailureSchema, failure);
  const list = failures.get(id);
  if (list === undefined) failures.set(id, [entry]);
  else list.push(entry);
}

/** The run's failures so far, oldest first. A copy; empty for a run with none. */
export function connectorFailuresFor(runId: RunId): readonly ConnectorFailure[] {
  return (failures.get(runId) ?? []).map((f) => ({ ...f }));
}

/** Drops a run's record when the run settles. Returns true when one existed. */
export function releaseConnectorFailures(runId: RunId): boolean {
  return failures.delete(runId);
}
