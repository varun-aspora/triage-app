// Shared pieces for the SSFB gated tools (encrypt_lookup_value,
// decrypt_fields, cbs_call).
//
// These tools run through runIoTool, which already does the mock lookup and
// fixture recording through deps.fixtures.resolveIo. The T04 connectors they
// call also go through withMock, so the connector gets a ConnectorContext
// whose mock port is off and has no recorder: withMock then just runs the
// real call, and the fixture layer is not consulted or written twice.

import { lookupEnv, type Config } from '../../../config/env.ts';
import { createFieldCrypto, FIELD_ENC_KEY_ENV, type FieldCrypto } from '../../../connectors/crypto/harbor-field.ts';
import type { MockPort } from '../../../connectors/mock.ts';
import { ConnectorError, type ConnectorContext, type ConnectorOutcome } from '../../../connectors/types.ts';
import type { BackingRef } from '../../_lib/pipeline.ts';
import type { ToolContext, ToolEnabled } from '../../types.ts';

/** The only entity these tools serve. */
export const SSFB = 'ssfb';

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

// ------------------------------------------------------------ field encryption

/** Harbor is the service whose columns are encrypted (D34). */
export const FIELD_SERVICE = 'harbor';

/** True when SSFB_HARBOR_FIELD_ENC_KEY holds something other than whitespace. The value is not kept. */
export function fieldKeySet(config: Config): boolean {
  return lookupEnv(config, FIELD_ENC_KEY_ENV).state === 'set';
}

/** enabled() for both crypto tools: on only when the key is non-blank. */
export function fieldCryptoEnabled(ctx: Pick<ToolContext, 'config'>): ToolEnabled {
  if (!fieldKeySet(ctx.config)) return { on: false, reason: `${FIELD_ENC_KEY_ENV} is blank` };
  return { on: true };
}

export function fieldBacking(config: Config): BackingRef {
  return { envName: FIELD_ENC_KEY_ENV, status: fieldKeySet(config) ? 'ok' : 'blank' };
}

/**
 * Builds the field-crypto helpers for one real call. The key is read from
 * config here and stays inside createFieldCrypto's closure. A key that is
 * blank, not base64 or too short becomes a ConnectorError whose text names
 * the env var only.
 */
export function openFieldCrypto(config: Config): FieldCrypto {
  const state = createFieldCrypto({ config });
  if (state.status === 'ok') return state;
  if (state.status === 'not_configured') {
    throw new ConnectorError('not_configured', `${FIELD_ENC_KEY_ENV} is ${state.reason}`);
  }
  throw new ConnectorError('refused', state.message);
}
