// decrypt_fields: decrypt column values the investigator already fetched
// with sql_select (HLD 02 §2; D34, D48).
//
// - Mounted on any entity's investigator whose registry has a service with
//   field_encryption and a non-blank key (harbor and rhythm in SSFB today).
//   `service` picks the key; only services with a key are offered.
// - At most 20 values per call. The schema says so, and the gate refuses a
//   longer list again with an audit line, before any key is read.
// - The key is read from config inside run() and stays in the field-crypto
//   closure; it is never in the output, a log line or the audit line.
// - The plaintext passes the model-facing redaction profile in the pipeline
//   (PAN and passport masked, phone visible) and is masked again on persist
//   by note_evidence.
// - The audit line holds the number of values only; makeAuditLine rebuilds
//   the summary from that count for this tool, so no value can reach it.
// - A value without the 'enc:' prefix comes back unchanged as passthrough;
//   a value that fails to decrypt fails its own item only.
// - Mock mode answers from the 'field_crypto' fixture keyed by
//   {op: 'decrypt', service, values} and no key is read.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import {
  type DecryptCounts,
  type DecryptItem,
  DecryptResultSchema,
  MAX_DECRYPT_VALUES,
} from '../connectors/crypto/field-crypto.ts';
import { semanticKey } from '../mock/key.ts';
import type { ToolEnvelope } from '../types/tool-result.ts';
import { outcomeData, realConnectorContext } from './_lib/connector-context.ts';
import { fieldBacking, fieldCryptoEnabled, fieldServices, keyEnvFor, openFieldCrypto } from './_lib/field-crypto.ts';
import { type GateDecision, runIoTool } from './_lib/pipeline.ts';
import type { ToolModule } from './types.ts';

const NAME = 'decrypt_fields';

/** Longest single value accepted. Encrypted harbor columns are far shorter. */
export const MAX_DECRYPT_VALUE_CHARS = 4096;

type Decrypted = { readonly items: readonly DecryptItem[]; readonly counts: DecryptCounts };

function countItems(items: readonly DecryptItem[]): DecryptCounts {
  const counts = { decrypted: 0, passthrough: 0, failed: 0 };
  for (const item of items) {
    if (!item.ok) counts.failed += 1;
    else if (item.passthrough) counts.passthrough += 1;
    else counts.decrypted += 1;
  }
  return counts;
}

/**
 * Checks the answer (a fixture can be hand-written) and recomputes the counts
 * from the items, so the counts always match the items the model sees.
 */
export function checkDecrypted(value: unknown, expected: number): Decrypted {
  const parsed = v.safeParse(DecryptResultSchema, value);
  if (!parsed.success) throw new Error(`${NAME}: the field_crypto decrypt answer has the wrong shape`);
  const items = parsed.output.items;
  if (items.length !== expected) throw new Error(`${NAME}: the decrypt answer has the wrong number of items`);
  return { items, counts: countItems(items) };
}

function gateFor(services: readonly string[], keyEnv: string | undefined, values: unknown): GateDecision {
  if (keyEnv === undefined) {
    return { ok: false, message: `Refused: service must be one of ${services.join(', ')}.`, reason: 'service without a key' };
  }
  if (!Array.isArray(values) || values.some((x) => typeof x !== 'string')) {
    return { ok: false, message: 'Refused: values must be a list of strings.', reason: 'values not a string list' };
  }
  if (values.length === 0) {
    return { ok: false, message: 'Refused: pass at least one value.', reason: 'no values' };
  }
  if (values.length > MAX_DECRYPT_VALUES) {
    return {
      ok: false,
      message: `Refused: decrypt_fields takes at most ${MAX_DECRYPT_VALUES} values per call; split the list.`,
      reason: `too many values (${values.length} > ${MAX_DECRYPT_VALUES})`,
    };
  }
  if (values.some((x: string) => x.length > MAX_DECRYPT_VALUE_CHARS)) {
    return {
      ok: false,
      message: `Refused: each value must be at most ${MAX_DECRYPT_VALUE_CHARS} characters.`,
      reason: 'value too long',
    };
  }
  return { ok: true };
}

export const toolModule: ToolModule = {
  name: NAME,
  mounts: ['investigator'],
  entities: 'all',
  enabled: (ctx) => fieldCryptoEnabled(ctx),
  create: (ctx) => {
    const services = fieldServices(ctx);
    return defineTool({
      name: NAME,
      description:
        `Decrypt up to ${MAX_DECRYPT_VALUES} column values you already fetched with sql_select ` +
        "(values that start with 'enc:'), all from one service's database: each service has its own key. " +
        'items[i] answers values[i]: {ok: true, value, passthrough} or {ok: false, error}; auth_failed usually ' +
        'means the values came from another service. A value without the prefix is returned unchanged with ' +
        'passthrough true. Ask only for the fields the investigation needs; every call is audited. ' +
        '"not configured" means the key is not set.',
      input: v.object({
        service: v.pipe(
          v.picklist(services),
          v.description(`The service whose database the values came from: ${services.join(', ')}.`),
        ),
        values: v.pipe(
          v.array(v.pipe(v.string(), v.maxLength(MAX_DECRYPT_VALUE_CHARS))),
          v.minLength(1),
          v.maxLength(MAX_DECRYPT_VALUES),
          v.description(`Stored column values, in the order you want them back. At most ${MAX_DECRYPT_VALUES}.`),
        ),
      }),
      run: async ({ data, signal, toolCallId, log }): Promise<ToolEnvelope> => {
        const values: unknown = data.values;
        const list = Array.isArray(values) ? (values as unknown[]).filter((x): x is string => typeof x === 'string') : [];
        const keyEnv = keyEnvFor(ctx, data.service);
        // Only an offered service name reaches audit lines and fixture keys.
        const service = keyEnv !== undefined ? (data.service as string) : 'unknown';
        return runIoTool<'field_crypto', Decrypted>(
          {
            tool: NAME,
            service,
            input: data,
            backing: fieldBacking(keyEnv),
            scope: 'skip',
            gate: () => gateFor(services, keyEnv, values),
            fixture: () => ({ kind: 'field_crypto', key: semanticKey('field_crypto', { op: 'decrypt', service, values: list }) }),
            real: async (sig) => {
              const crypto = openFieldCrypto(ctx.config, service, keyEnv as string);
              return outcomeData(await crypto.decryptFields(realConnectorContext(ctx, sig), list));
            },
            render: (value) => {
              const { items, counts } = checkDecrypted(value, list.length);
              return { items, counts };
            },
            count: list.length,
          },
          { toolContext: ctx, toolCallId, log, ...(signal !== undefined ? { signal } : {}) },
        );
      },
    });
  },
};
