// What encrypt_lookup_value and decrypt_fields share (D34, D48): which of the
// investigator's services can be used, and the per-service key.
//
// Every service with `field_encryption` in its registry entry has its own key
// (field_encryption.key_env). A service is offered only while its key is
// non-blank; the key itself is read inside run(), through createFieldCrypto,
// and never kept here.

import type { Config } from '../../config/env.ts';
import { createFieldCrypto, type FieldCrypto } from '../../connectors/crypto/field-crypto.ts';
import { ConnectorError } from '../../connectors/types.ts';
import type { BackingRef } from './pipeline.ts';
import type { ToolContext, ToolEnabled } from '../types.ts';

export type FieldService = { readonly service: string; readonly keyEnv: string; readonly keySet: boolean };

/** Every service of the context's entity that declares field encryption, sorted by name. */
export function declaredFieldServices(ctx: Pick<ToolContext, 'entity' | 'registry'>): readonly FieldService[] {
  const entity = ctx.entity;
  if (entity === null || !ctx.registry.isEnabled(entity)) return [];
  const out: FieldService[] = [];
  for (const service of [...ctx.registry.services(entity)].sort()) {
    const fe = ctx.registry.fieldEncryption(entity, service);
    if (fe !== undefined) out.push({ service, keyEnv: fe.envName, keySet: fe.status === 'ok' });
  }
  return out;
}

/** The services the tools offer: declared, with a non-blank key. */
export function fieldServices(ctx: Pick<ToolContext, 'entity' | 'registry'>): readonly string[] {
  return declaredFieldServices(ctx)
    .filter((s) => s.keySet)
    .map((s) => s.service);
}

/** enabled() for both tools: on when at least one service has its key. */
export function fieldCryptoEnabled(ctx: Pick<ToolContext, 'entity' | 'registry'>): ToolEnabled {
  const declared = declaredFieldServices(ctx);
  if (declared.length === 0) return { on: false, reason: 'no service of this entity has field encryption' };
  if (declared.every((s) => !s.keySet)) {
    const names = declared.map((s) => s.keyEnv);
    return { on: false, reason: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} blank` };
  }
  return { on: true };
}

/** The key env name for a service the tool offers, or undefined for any other value. */
export function keyEnvFor(ctx: Pick<ToolContext, 'entity' | 'registry'>, service: unknown): string | undefined {
  if (typeof service !== 'string') return undefined;
  return declaredFieldServices(ctx).find((s) => s.service === service && s.keySet)?.keyEnv;
}

/** The audit target of a call naming a service without a key; the gate refuses such a call. */
export const NO_FIELD_KEY = 'NO_FIELD_KEY';

export function fieldBacking(keyEnv: string | undefined): BackingRef {
  return keyEnv === undefined ? { envName: NO_FIELD_KEY, status: 'blank' } : { envName: keyEnv, status: 'ok' };
}

/**
 * Builds the field-crypto helpers for one real call. The key is read from
 * config here and stays inside createFieldCrypto's closure. A key that is
 * blank, not base64 or too short becomes a ConnectorError whose text names
 * the env var only.
 */
export function openFieldCrypto(config: Config, service: string, keyEnv: string): FieldCrypto {
  const state = createFieldCrypto({ config, service, keyEnv });
  if (state.status === 'ok') return state;
  if (state.status === 'not_configured') throw new ConnectorError('not_configured', `${keyEnv} is ${state.reason}`);
  throw new ConnectorError('refused', state.message);
}
