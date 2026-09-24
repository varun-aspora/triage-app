// encrypt_lookup_value: turn a phone, email or CIF into the ciphertext a
// service stores, so the investigator can pass it as a $n param to sql_select
// against an encrypted column (HLD 02 §2; D34, D48).
//
// - Mounted on any entity's investigator whose registry has a service with
//   field_encryption and a non-blank key (harbor and rhythm in SSFB today).
//   `service` picks the key; only services with a key are offered.
// - The key is read from config inside run() and stays in the field-crypto
//   closure; it is never in the output, a log line or the audit line.
// - AES-SIV is deterministic: the same value and kind always give the same
//   ciphertext. Normalisation is trim only, as harbor stores these values.
// - Mock mode answers from the 'field_crypto' fixture keyed by
//   {op: 'encrypt', service, kind, values: [value]} and no key is read.
// - The audit line records a count of 1, never the value (makeAuditLine
//   rebuilds the summary from the count for this tool).
// - Not scope-checked: the HLD scope rule covers sql_select, http_call,
//   logs_search and cbs_call, and the IdChain has no email or CIF key, so a
//   check here would refuse every email and most CIF lookups. The sql_select
//   call that uses the ciphertext is still audited.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import { ENC_PREFIX, FIELD_KINDS, normaliseLookupValue } from '../connectors/crypto/field-crypto.ts';
import { redactModelFacing } from '../gate/redact.ts';
import { semanticKey } from '../mock/key.ts';
import type { ToolEnvelope } from '../types/tool-result.ts';
import { outcomeData, realConnectorContext } from './_lib/connector-context.ts';
import { fieldBacking, fieldCryptoEnabled, fieldServices, keyEnvFor, openFieldCrypto } from './_lib/field-crypto.ts';
import { runIoTool } from './_lib/pipeline.ts';
import type { ToolModule } from './types.ts';

const NAME = 'encrypt_lookup_value';

/** Longest value accepted. Phones, emails and CIFs are far shorter. */
export const MAX_LOOKUP_VALUE_CHARS = 320;

const CiphertextSchema = v.pipe(v.string(), v.startsWith(ENC_PREFIX), v.minLength(ENC_PREFIX.length + 1));

/**
 * The model-facing result. The pipeline runs model-facing redaction over it,
 * and a ciphertext that happens to look like a secret (for example base64
 * with 'pwd' before '==') would be masked into a wrong value. That case says
 * so instead of handing back a ciphertext that cannot match.
 */
export function renderCiphertext(kind: string, value: unknown): Record<string, unknown> {
  const parsed = v.safeParse(CiphertextSchema, value);
  if (!parsed.success) throw new Error(`${NAME}: the field_crypto encrypt answer has the wrong shape`);
  const ciphertext = parsed.output;
  const seen = redactModelFacing({ ciphertext }) as { ciphertext?: unknown };
  if (seen.ciphertext !== ciphertext) {
    return {
      kind,
      ciphertext: null,
      note: 'The ciphertext for this value would be masked by redaction, so it cannot be used in sql_select. Record the gap.',
    };
  }
  return {
    kind,
    ciphertext,
    note: "Pass ciphertext as a $n param to sql_select against the service's encrypted column. It is not the plaintext.",
  };
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
        'Encrypt a phone, email or CIF the way a service stores it (AES-SIV, deterministic), so you can look it up ' +
        "with sql_select against that service's encrypted column, for example harbor customer.external_reference_id " +
        'or the phone fields. Each service has its own key: pick the service whose table you will query. Pass the ' +
        'returned ciphertext as a $n param; never put it into the SQL text. The value is trimmed and otherwise used ' +
        'as given. "not configured" means the key is not set; record the gap.',
      input: v.object({
        service: v.pipe(
          v.picklist(services),
          v.description(`The service whose database column you will query: ${services.join(', ')}.`),
        ),
        value: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_LOOKUP_VALUE_CHARS),
          v.description('The plaintext to encrypt, exactly as harbor would store it (for example +919876543210).'),
        ),
        kind: v.pipe(v.picklist(FIELD_KINDS), v.description('What the value is: phone, email or cif.')),
      }),
      run: async ({ data, signal, toolCallId, log }): Promise<ToolEnvelope> => {
        const kind = data.kind;
        const value = typeof data.value === 'string' ? normaliseLookupValue(data.value, kind) : '';
        const keyEnv = keyEnvFor(ctx, data.service);
        // Only an offered service name reaches audit lines and fixture keys.
        const service = keyEnv !== undefined ? (data.service as string) : 'unknown';
        return runIoTool<'field_crypto', string>(
          {
            tool: NAME,
            service,
            input: data,
            backing: fieldBacking(keyEnv),
            scope: 'skip',
            gate: () => {
              if (keyEnv === undefined) {
                return { ok: false, message: `Refused: service must be one of ${services.join(', ')}.`, reason: 'service without a key' };
              }
              if (!(FIELD_KINDS as readonly string[]).includes(kind)) {
                return { ok: false, message: `Refused: kind must be one of ${FIELD_KINDS.join(', ')}.`, reason: 'bad kind' };
              }
              if (value === '' || value.length > MAX_LOOKUP_VALUE_CHARS) {
                return {
                  ok: false,
                  message: `Refused: value must be 1 to ${MAX_LOOKUP_VALUE_CHARS} characters after trimming.`,
                  reason: 'bad value length',
                };
              }
              return { ok: true };
            },
            fixture: () => ({
              kind: 'field_crypto',
              key: semanticKey('field_crypto', { op: 'encrypt', service, kind, values: [value] }),
            }),
            real: async (sig) => {
              const crypto = openFieldCrypto(ctx.config, service, keyEnv as string);
              return outcomeData(await crypto.encryptLookupValue(realConnectorContext(ctx, sig), value, kind));
            },
            render: (ciphertext) => renderCiphertext(kind, ciphertext),
            count: 1,
          },
          { toolContext: ctx, toolCallId, log, ...(signal !== undefined ? { signal } : {}) },
        );
      },
    });
  },
};
