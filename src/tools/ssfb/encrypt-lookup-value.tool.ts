// encrypt_lookup_value: turn a phone, email or CIF into harbor's stored
// ciphertext, so the investigator can pass it as a $n param to sql_select
// against an encrypted column (HLD 02 §2; D34).
//
// - Mounted on the SSFB investigator only, and only when
//   SSFB_HARBOR_FIELD_ENC_KEY is non-blank.
// - The key is read from config inside run() and stays in the field-crypto
//   closure; it is never in the output, a log line or the audit line.
// - AES-SIV is deterministic: the same value and kind always give the same
//   ciphertext. Normalisation is trim only, as harbor stores these values.
// - Mock mode answers from the 'field_crypto' fixture keyed by
//   {op: 'encrypt', kind, values: [value]} and no key is read.
// - The audit line records a count of 1, never the value (makeAuditLine
//   rebuilds the summary from the count for this tool).
// - Not scope-checked: the HLD scope rule covers sql_select, http_call,
//   logs_search and cbs_call, and the IdChain has no email or CIF key, so a
//   check here would refuse every email and most CIF lookups. The sql_select
//   call that uses the ciphertext is still audited.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import { ENC_PREFIX, FIELD_KINDS, normaliseLookupValue } from '../../connectors/crypto/harbor-field.ts';
import { redactModelFacing } from '../../gate/redact.ts';
import { semanticKey } from '../../mock/key.ts';
import type { ToolEnvelope } from '../../types/tool-result.ts';
import { runIoTool } from '../_lib/pipeline.ts';
import type { ToolModule } from '../types.ts';
import {
  FIELD_SERVICE,
  fieldBacking,
  fieldCryptoEnabled,
  openFieldCrypto,
  outcomeData,
  realConnectorContext,
  SSFB,
} from './_lib/ssfb-io.ts';

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
    note: 'Pass ciphertext as a $n param to sql_select against the encrypted harbor column. It is not the plaintext.',
  };
}

export const toolModule: ToolModule = {
  name: NAME,
  mounts: ['investigator'],
  entities: [SSFB],
  enabled: (ctx) => fieldCryptoEnabled(ctx),
  create: (ctx) =>
    defineTool({
      name: NAME,
      description:
        'Encrypt a phone, email or CIF the way harbor stores it (AES-SIV, deterministic), so you can look it up ' +
        'with sql_select against an encrypted column such as customer.external_reference_id or the phone fields. ' +
        'Pass the returned ciphertext as a $n param; never put it into the SQL text. The value is trimmed and ' +
        'otherwise used as given. "not configured" means the key is not set; record the gap.',
      input: v.object({
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
        return runIoTool<'field_crypto', string>(
          {
            tool: NAME,
            service: FIELD_SERVICE,
            input: data,
            backing: fieldBacking(ctx.config),
            scope: 'skip',
            gate: () => {
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
              key: semanticKey('field_crypto', { op: 'encrypt', kind, values: [value] }),
            }),
            real: async (sig) => {
              const crypto = openFieldCrypto(ctx.config);
              return outcomeData(await crypto.encryptLookupValue(realConnectorContext(ctx, sig), value, kind));
            },
            render: (ciphertext) => renderCiphertext(kind, ciphertext),
            count: 1,
          },
          { toolContext: ctx, toolCallId, log, ...(signal !== undefined ? { signal } : {}) },
        );
      },
    }),
};
