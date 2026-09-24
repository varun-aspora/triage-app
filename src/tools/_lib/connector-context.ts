// For tools whose real() calls a T04 connector that goes through withMock
// itself (the field-crypto tools, cbs_call).
//
// runIoTool already does the mock lookup and fixture recording through
// deps.fixtures.resolveIo. The connector gets a ConnectorContext whose mock
// port is off and has no recorder: withMock then just runs the real call, and
// the fixture layer is not consulted or written twice.

import type { MockPort } from '../../connectors/mock.ts';
import { ConnectorError, type ConnectorContext, type ConnectorOutcome } from '../../connectors/types.ts';
import type { ToolContext } from '../types.ts';

const PASS_THROUGH_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: false,
  lookup: async () => {
    throw new ConnectorError('refused', 'fixture lookup belongs to the tool pipeline, not the connector');
  },
});

/** A ConnectorContext for a real call made from inside runIoTool's real(). */
export function realConnectorContext(ctx: ToolContext, signal: AbortSignal): ConnectorContext {
  return Object.freeze({
    signal,
    now: () => ctx.deps.now(),
    mock: PASS_THROUGH_PORT,
    runId: ctx.runId,
    redactionNames: ctx.deps.run.redactionNames,
  });
}

/** The data of a connector outcome. A miss cannot happen with the pass-through port. */
export function outcomeData<T>(out: ConnectorOutcome<T>): T {
  if (out.fixture_miss === true) throw new ConnectorError('unreachable', 'connector answered with a fixture miss in real mode');
  return out.data;
}
