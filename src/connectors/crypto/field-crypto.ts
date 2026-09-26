// Field encryption as go-commons lib/crypto/siv.go does it (D34, D48). Every
// Go service that stores columns through that library (harbor and rhythm
// today) has its own FIELD_ENCRYPTION_SECRET_KEY, so one FieldCrypto serves
// one service: the registry's field_encryption.key_env for that service
// names the .env key (SSFB_HARBOR_FIELD_ENC_KEY, SSFB_RHYTHM_FIELD_ENC_KEY).
//
// - The base key is that env value decoded from standard base64 (the
//   services' cmd/fle decodes FIELD_ENCRYPTION_SECRET_KEY the same way). It
//   must be at least 16 bytes, as InitSIV requires.
// - The AES-SIV key is 64 bytes from HKDF-SHA256(base key, empty salt,
//   info 'vance-aes-siv-v1'), so AES-SIV runs on AES-256.
// - Seal uses no associated-data components (Seal(nil, nil, pt, nil) in Go)
//   and the stored form is 'enc:' + base64(tag || ciphertext).
// - Decrypt passes a value without the 'enc:' prefix through unchanged, as
//   DecryptValueBytes does for rows written before encryption.
//
// java-commons encrypts differently (AES-GCM with a random IV and an
// 'ENC:v1:' prefix): no in-scope service uses it, and a random IV means no
// lookup by ciphertext is possible, so it is not handled here.
//
// Normalisation, from harbor's call sites (read for structure only):
// customer_repo GetByPhone, GetByEmail and GetByExternalReferenceID (the CIF),
// the admin search by email or mobile and the OTP attempt repo all call
// crypto.EncryptValue on the value as given. EncryptValueNormalized (trim and
// upper-case) is used only for PAN. So every kind here is trim only: harbor
// stores these values as given, and upper-casing an email or a CIF with
// letters would miss the row. The trim only drops stray spaces copied from a
// thread.
//
// The base key and the derived key stay inside createFieldCrypto's closure.
// They are never returned, logged or put in an error. In mock mode the env
// key is not read and no key is derived: both functions answer from
// fixtures through withMock.
import { hkdfSync } from 'node:crypto';
import * as v from 'valibot';
import { lookupEnv, type Config } from '../../config/env.ts';
import { FIELD_VALUE_KINDS } from '../../mock/types.ts';
import { withMock } from '../mock.ts';
import { ConnectorError, type ConnectorContext, type ConnectorOutcome } from '../types.ts';
import { AesSivError, sivOpen, sivSeal } from './aes-siv.ts';

export const SIV_HKDF_INFO = 'vance-aes-siv-v1';
export const ENC_PREFIX = 'enc:';
export const MIN_BASE_KEY_BYTES = 16;
export const DERIVED_KEY_BYTES = 64;
export const MAX_DECRYPT_VALUES = 20;

export type FieldKind = (typeof FIELD_VALUE_KINDS)[number];
export { FIELD_VALUE_KINDS as FIELD_KINDS };

const DECRYPT_FAILURES = ['not_base64', 'too_short', 'auth_failed'] as const;
/** Why one value could not be decrypted. Never carries the value. */
export type DecryptFailure = (typeof DECRYPT_FAILURES)[number];

export const DecryptItemSchema = v.union([
  v.strictObject({ ok: v.literal(true), value: v.string(), passthrough: v.boolean() }),
  v.strictObject({ ok: v.literal(false), error: v.picklist(DECRYPT_FAILURES) }),
]);
export type DecryptItem = v.InferOutput<typeof DecryptItemSchema>;

export const DecryptCountsSchema = v.strictObject({
  decrypted: v.number(),
  passthrough: v.number(),
  failed: v.number(),
});
/** For the audit line: counts only, never values. */
export type DecryptCounts = v.InferOutput<typeof DecryptCountsSchema>;

/** items[i] answers values[i]. */
export const DecryptResultSchema = v.strictObject({
  items: v.array(DecryptItemSchema),
  counts: DecryptCountsSchema,
});
export type DecryptResult = v.InferOutput<typeof DecryptResultSchema>;

const EncryptFixtureSchema = v.pipe(v.string(), v.startsWith(ENC_PREFIX));

export type FieldCrypto = {
  readonly status: 'ok';
  readonly service: string;
  readonly envName: string;
  /** Returns 'enc:' + base64, usable as a $n param against harbor's encrypted columns. */
  encryptLookupValue(ctx: ConnectorContext, value: string, kind: FieldKind): Promise<ConnectorOutcome<string>>;
  /** At most MAX_DECRYPT_VALUES values. A bad value fails its own item only. */
  decryptFields(ctx: ConnectorContext, values: readonly string[]): Promise<ConnectorOutcome<DecryptResult>>;
};

export type FieldCryptoUnavailable =
  | { readonly status: 'not_configured'; readonly envName: string; readonly reason: 'blank' | 'missing' }
  | {
      readonly status: 'refused';
      readonly envName: string;
      readonly reason: 'not_base64' | 'too_short';
      readonly message: string;
    };

export type FieldCryptoState = FieldCrypto | FieldCryptoUnavailable;

export type CreateFieldCryptoOptions = {
  readonly config: Config;
  /** The service whose columns these values belong to, for fixture keys and audit targets. */
  readonly service: string;
  /** The .env key holding that service's base key: the registry's field_encryption.key_env. */
  readonly keyEnv: string;
};

/** The trim-only normalisation harbor's lookups need (see the header comment). */
export function normaliseLookupValue(value: string, _kind: FieldKind): string {
  return value.trim();
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard padded base64, like Go's base64.StdEncoding (which skips CR and LF). null when invalid. */
function decodeBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[\r\n]/g, '');
  if (!BASE64.test(clean)) return null;
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

function unavailable(keyEnv: string, reason: 'not_base64' | 'too_short'): FieldCryptoUnavailable {
  const message =
    reason === 'not_base64'
      ? `${keyEnv} is not valid base64`
      : `${keyEnv} must decode to at least ${MIN_BASE_KEY_BYTES} bytes`;
  const refused: FieldCryptoUnavailable = { status: 'refused', envName: keyEnv, reason, message };
  return Object.freeze(refused);
}

function checkKind(kind: FieldKind): void {
  if (!(FIELD_VALUE_KINDS as readonly string[]).includes(kind)) {
    throw new ConnectorError('refused', `kind must be one of ${FIELD_VALUE_KINDS.join(', ')}`);
  }
}

function checkBatch(values: readonly string[]): void {
  if (!Array.isArray(values) || values.some((x) => typeof x !== 'string')) {
    throw new ConnectorError('refused', 'decrypt_fields takes an array of strings');
  }
  if (values.length === 0) throw new ConnectorError('refused', 'decrypt_fields needs at least one value');
  if (values.length > MAX_DECRYPT_VALUES) {
    throw new ConnectorError('refused', `decrypt_fields takes at most ${MAX_DECRYPT_VALUES} values, got ${values.length}`);
  }
}

function countItems(items: readonly DecryptItem[]): DecryptCounts {
  const counts = { decrypted: 0, passthrough: 0, failed: 0 };
  for (const item of items) {
    if (!item.ok) counts.failed += 1;
    else if (item.passthrough) counts.passthrough += 1;
    else counts.decrypted += 1;
  }
  return Object.freeze(counts);
}

function fixtureShape<T>(schema: v.GenericSchema<unknown, T>, value: unknown, op: string): T {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) throw new Error(`field_crypto ${op} fixture has the wrong shape`);
  return parsed.output;
}

type Engine = {
  encrypt(plaintext: string): string;
  decryptOne(stored: string): DecryptItem;
};

function failed(error: DecryptFailure): DecryptItem {
  return Object.freeze({ ok: false, error });
}

function engineFor(derived: Uint8Array): Engine {
  const utf8 = new TextEncoder();
  // Not fatal, like Go's string(pt): harbor only stores UTF-8 text anyway.
  const text = new TextDecoder('utf-8');
  return {
    encrypt(plaintext) {
      const sealed = sivSeal(derived, [], utf8.encode(plaintext));
      return ENC_PREFIX + Buffer.from(sealed).toString('base64');
    },
    decryptOne(stored) {
      if (!stored.startsWith(ENC_PREFIX)) return Object.freeze({ ok: true as const, value: stored, passthrough: true });
      const sealed = decodeBase64(stored.slice(ENC_PREFIX.length));
      if (sealed === null) return failed('not_base64');
      try {
        const pt = sivOpen(derived, [], sealed);
        return Object.freeze({ ok: true as const, value: text.decode(pt), passthrough: false });
      } catch (err) {
        if (err instanceof AesSivError) return failed(err.reason === 'too_short' ? 'too_short' : 'auth_failed');
        throw err;
      }
    },
  };
}

/** Reads, checks and derives the key. Returns the engine, or why the key cannot be used. */
function realEngine(config: Config, keyEnv: string): Engine | FieldCryptoUnavailable {
  const found = lookupEnv(config, keyEnv);
  if (found.state !== 'set') {
    const off: FieldCryptoUnavailable = { status: 'not_configured', envName: keyEnv, reason: found.state };
    return Object.freeze(off);
  }
  const base = decodeBase64(found.value.trim());
  if (base === null) return unavailable(keyEnv, 'not_base64');
  try {
    if (base.length < MIN_BASE_KEY_BYTES) return unavailable(keyEnv, 'too_short');
    const derived = new Uint8Array(hkdfSync('sha256', base, new Uint8Array(0), SIV_HKDF_INFO, DERIVED_KEY_BYTES));
    return engineFor(derived);
  } finally {
    base.fill(0);
  }
}

function mockOnlyEngine(keyEnv: string): Engine {
  const fail = (): never => {
    throw new ConnectorError(
      'not_configured',
      `field encryption was set up in mock mode, so ${keyEnv} was not read; a real call cannot run`,
    );
  };
  return { encrypt: fail, decryptOne: fail };
}

/**
 * Builds the field-encryption helpers for one service. A blank or missing key
 * gives not_configured, so the tools do not offer that service. A key that is
 * not base64 or is under 16 bytes gives refused, naming the env var only. In
 * mock mode (config.mock.enabled) the key is not read and the helpers answer
 * from fixtures only.
 */
export function createFieldCrypto(options: CreateFieldCryptoOptions): FieldCryptoState {
  const { config, service, keyEnv } = options;
  const built = config.mock.enabled ? mockOnlyEngine(keyEnv) : realEngine(config, keyEnv);
  if ('status' in built) return built;
  const engine: Engine = built;
  const target = { target_env: keyEnv };

  async function encryptLookupValue(
    ctx: ConnectorContext,
    value: string,
    kind: FieldKind,
  ): Promise<ConnectorOutcome<string>> {
    checkKind(kind);
    if (typeof value !== 'string') throw new ConnectorError('refused', 'value must be a string');
    const normalised = normaliseLookupValue(value, kind);
    if (normalised === '') throw new ConnectorError('refused', 'value is blank');
    const out = await withMock(
      ctx,
      'field_crypto',
      { op: 'encrypt', service, kind, values: [normalised] },
      async (signal) => {
        signal.throwIfAborted();
        return { data: engine.encrypt(normalised) };
      },
      target,
    );
    if (out.transport === 'mock' && out.fixture_miss !== true) fixtureShape(EncryptFixtureSchema, out.data, 'encrypt');
    return out;
  }

  async function decryptFields(
    ctx: ConnectorContext,
    values: readonly string[],
  ): Promise<ConnectorOutcome<DecryptResult>> {
    checkBatch(values);
    const list = [...values];
    const out = await withMock(
      ctx,
      'field_crypto',
      { op: 'decrypt', service, values: list },
      async (signal) => {
        const items: DecryptItem[] = [];
        for (const one of list) {
          signal.throwIfAborted();
          items.push(engine.decryptOne(one));
        }
        return { data: Object.freeze({ items: Object.freeze(items), counts: countItems(items) }) as DecryptResult };
      },
      target,
    );
    if (out.transport === 'mock' && out.fixture_miss !== true) {
      const data = fixtureShape(DecryptResultSchema, out.data, 'decrypt');
      if (data.items.length !== list.length) throw new Error('field_crypto decrypt fixture has the wrong number of items');
      // Counts are recomputed so a hand-written fixture cannot disagree with its items.
      return Object.freeze({ ...out, data: Object.freeze({ items: data.items, counts: countItems(data.items) }) });
    }
    return out;
  }

  const crypto: FieldCrypto = { status: 'ok', service, envName: keyEnv, encryptLookupValue, decryptFields };
  return Object.freeze(crypto);
}
