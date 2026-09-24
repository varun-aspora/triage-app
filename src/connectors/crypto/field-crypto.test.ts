import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { hkdfSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { testEnvRecord } from '../../../test/support/home.ts';
import { configFromRecord, type Config } from '../../config/env.ts';
import { keyHash, keyString, semanticKey, type FieldCryptoFacts } from '../../mock/key.ts';
import { createFixtureStore } from '../../mock/store.ts';
import { mockPortFromFixtures, type MockLookup, type MockPort } from '../mock.ts';
import { ConnectorError, type ConnectorContext, type ConnectorOutcome } from '../types.ts';
import {
  createFieldCrypto,
  ENC_PREFIX,
  MAX_DECRYPT_VALUES,
  normaliseLookupValue,
  SIV_HKDF_INFO,
  type DecryptResult,
  type FieldCrypto,
  type FieldCryptoState,
} from './field-crypto.ts';

const FIELD_ENC_KEY_ENV = 'SSFB_HARBOR_FIELD_ENC_KEY';
/** Harbor's registry entry: the service and its key name. */
const HARBOR = { service: 'harbor', keyEnv: FIELD_ENC_KEY_ENV } as const;

// The non-secret base key from go-commons lib/crypto/siv_test.go. Harbor reads
// the env key as base64, so the env value is the base64 of these 32 bytes.
const GO_TEST_BASE_KEY = '0123456789abcdef0123456789abcdef';
const GO_TEST_ENV_KEY = Buffer.from(GO_TEST_BASE_KEY, 'utf8').toString('base64');

const GOLDEN = [
  { kind: 'cif', plain: 'ABCDEF', enc: 'enc:46pdXr8EbuAVM1AhnMQaLy3eg4SaAQ==' },
  { kind: 'phone', plain: '+919000000001', enc: 'enc:RzNnTdZoSaEAFfQSnHaHJ6fOgVnTA7MFzlyQOX0=' },
  { kind: 'email', plain: 'TEST@EXAMPLE.COM', enc: 'enc:YfU4gWdBOUK/02Cq3LseKX30BzEmfN/fbF9a1RR4iyc=' },
] as const;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Record<string, string | undefined>): Config {
  const record: Record<string, string> = { ...testEnvRecord(), TRIAGE_MOCK_MODE: 'false' };
  for (const [k, val] of Object.entries(overrides)) {
    if (val === undefined) delete record[k];
    else record[k] = val;
  }
  return configFromRecord(record, '/triage/home');
}

const realPort: MockPort = Object.freeze({
  enabled: false,
  strict: true,
  lookup: () => Promise.reject(new Error('lookup must not be called in real mode')),
});

function ctx(port: MockPort = realPort, signal: AbortSignal = new AbortController().signal): ConnectorContext {
  let t = Date.parse('2026-09-23T10:00:00.000Z');
  return {
    signal,
    now: () => new Date((t += 3)),
    mock: port,
    runId: '01J8ZZZZZZZZZZZZZZZZZZZZZZ',
  };
}

function ok(state: FieldCryptoState): FieldCrypto {
  if (state.status !== 'ok') throw new Error(`expected ok, got ${state.status}`);
  return state;
}

function realCrypto(envKey = GO_TEST_ENV_KEY): FieldCrypto {
  return ok(createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: envKey }), ...HARBOR }));
}

function data<T>(out: ConnectorOutcome<T>): T {
  if (out.fixture_miss === true) throw new Error('unexpected fixture miss');
  return out.data;
}

async function caught(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ConnectorError) return err;
    throw err;
  }
  throw new Error('expected a ConnectorError');
}

function tamper(enc: string, at: number): string {
  const bytes = Buffer.from(enc.slice(ENC_PREFIX.length), 'base64');
  bytes[at] = (bytes[at] as number) ^ 0x01;
  return ENC_PREFIX + bytes.toString('base64');
}

describe('golden vectors (go-commons test base key, no AD)', () => {
  for (const g of GOLDEN) {
    test(`${g.kind} ${g.plain} encrypts to the Go output and decrypts back`, async () => {
      const fc = realCrypto();
      const out = await fc.encryptLookupValue(ctx(), g.plain, g.kind);
      expect(data(out)).toBe(g.enc);
      expect(out.transport).toBe('real');
      expect(String(out.target_env)).toBe(FIELD_ENC_KEY_ENV);
      const back = data(await fc.decryptFields(ctx(), [g.enc]));
      expect(back.items).toEqual([{ ok: true, value: g.plain, passthrough: false }]);
      expect(back.counts).toEqual({ decrypted: 1, passthrough: 0, failed: 0 });
    });
  }

  test('the HKDF label is the Go one', () => {
    expect(SIV_HKDF_INFO).toBe('vance-aes-siv-v1');
  });
});

describe('encryptLookupValue', () => {
  test('is deterministic and round-trips through decryptFields', async () => {
    const fc = realCrypto();
    const a = data(await fc.encryptLookupValue(ctx(), 'CIF00991', 'cif'));
    const b = data(await fc.encryptLookupValue(ctx(), 'CIF00991', 'cif'));
    expect(a).toBe(b);
    expect(a.startsWith(ENC_PREFIX)).toBe(true);
    expect(data(await fc.decryptFields(ctx(), [a])).items[0]).toEqual({ ok: true, value: 'CIF00991', passthrough: false });
  });

  test('a different key gives a different ciphertext that the first key cannot open', async () => {
    const other = realCrypto(Buffer.from('another-test-key-of-32-bytes!!!!').toString('base64'));
    const enc = data(await other.encryptLookupValue(ctx(), '+919000000001', 'phone'));
    expect(enc).not.toBe(GOLDEN[1].enc);
    expect(data(await realCrypto().decryptFields(ctx(), [enc])).items[0]).toEqual({ ok: false, error: 'auth_failed' });
  });

  test('every kind is trimmed only, as harbor calls EncryptValue without normalising', async () => {
    const fc = realCrypto();
    expect(data(await fc.encryptLookupValue(ctx(), '  +919000000001\t', 'phone'))).toBe(GOLDEN[1].enc);
    expect(data(await fc.encryptLookupValue(ctx(), ' ABCDEF ', 'cif'))).toBe(GOLDEN[0].enc);
    // Case is kept: harbor stores email and CIF as given, so upper-casing would miss rows.
    expect(data(await fc.encryptLookupValue(ctx(), 'test@example.com', 'email'))).not.toBe(GOLDEN[2].enc);
    expect(data(await fc.encryptLookupValue(ctx(), 'abcdef', 'cif'))).not.toBe(GOLDEN[0].enc);
    expect(normaliseLookupValue(' Test@Example.com ', 'email')).toBe('Test@Example.com');
    expect(normaliseLookupValue(' 91 90000 ', 'phone')).toBe('91 90000');
    expect(normaliseLookupValue('\ncif-1 ', 'cif')).toBe('cif-1');
  });

  test('a blank value and an unknown kind are refused', async () => {
    const fc = realCrypto();
    expect((await caught(fc.encryptLookupValue(ctx(), '   ', 'phone'))).code).toBe('refused');
    expect((await caught(fc.encryptLookupValue(ctx(), 'x', 'pan' as never))).code).toBe('refused');
  });

  test('a pre-aborted signal rejects', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(realCrypto().encryptLookupValue(ctx(realPort, ac.signal), 'ABCDEF', 'cif')).rejects.toThrow();
  });
});

describe('decryptFields', () => {
  test('a tampered tag or ciphertext fails that item only', async () => {
    const fc = realCrypto();
    const values = [GOLDEN[0].enc, tamper(GOLDEN[1].enc, 0), GOLDEN[1].enc, tamper(GOLDEN[2].enc, 20), GOLDEN[2].enc];
    const res = data(await fc.decryptFields(ctx(), values));
    expect(res.items).toEqual([
      { ok: true, value: 'ABCDEF', passthrough: false },
      { ok: false, error: 'auth_failed' },
      { ok: true, value: '+919000000001', passthrough: false },
      { ok: false, error: 'auth_failed' },
      { ok: true, value: 'TEST@EXAMPLE.COM', passthrough: false },
    ]);
    expect(res.counts).toEqual({ decrypted: 3, passthrough: 0, failed: 2 });
  });

  test('garbage after the prefix is a per-item error, not a throw', async () => {
    const res = data(await realCrypto().decryptFields(ctx(), ['enc:!!not base64!!', 'enc:', 'enc:AAAA', 'enc:QUJD', GOLDEN[0].enc]));
    expect(res.items).toEqual([
      { ok: false, error: 'not_base64' },
      { ok: false, error: 'too_short' },
      { ok: false, error: 'too_short' },
      { ok: false, error: 'too_short' },
      { ok: true, value: 'ABCDEF', passthrough: false },
    ]);
    expect(res.counts).toEqual({ decrypted: 1, passthrough: 0, failed: 4 });
  });

  test('a value without the enc: prefix passes through unchanged', async () => {
    const res = data(await realCrypto().decryptFields(ctx(), ['legacy-plain', '', 'ENC:abc', GOLDEN[1].enc]));
    expect(res.items).toEqual([
      { ok: true, value: 'legacy-plain', passthrough: true },
      { ok: true, value: '', passthrough: true },
      { ok: true, value: 'ENC:abc', passthrough: true },
      { ok: true, value: '+919000000001', passthrough: false },
    ]);
    expect(res.counts).toEqual({ decrypted: 1, passthrough: 3, failed: 0 });
  });

  test(`${MAX_DECRYPT_VALUES} values are accepted and ${MAX_DECRYPT_VALUES + 1} are refused`, async () => {
    const fc = realCrypto();
    const twenty = Array.from({ length: MAX_DECRYPT_VALUES }, () => GOLDEN[0].enc);
    expect(data(await fc.decryptFields(ctx(), twenty)).counts.decrypted).toBe(20);
    const err = await caught(fc.decryptFields(ctx(), [...twenty, GOLDEN[0].enc]));
    expect(err.code).toBe('refused');
    expect(err.message).toContain('at most 20');
  });

  test('an empty list or a non-string item is refused', async () => {
    const fc = realCrypto();
    expect((await caught(fc.decryptFields(ctx(), []))).code).toBe('refused');
    expect((await caught(fc.decryptFields(ctx(), [1 as never]))).code).toBe('refused');
  });
});

describe('key handling', () => {
  test('a blank key is not_configured', () => {
    expect(createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: '' }), ...HARBOR })).toEqual({
      status: 'not_configured',
      envName: FIELD_ENC_KEY_ENV,
      reason: 'blank',
    });
    expect(createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: '   ' }), ...HARBOR }).status).toBe('not_configured');
  });

  test('a missing key is not_configured', () => {
    expect(createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: undefined }), ...HARBOR })).toEqual({
      status: 'not_configured',
      envName: FIELD_ENC_KEY_ENV,
      reason: 'missing',
    });
  });

  test('a base key under 16 bytes is refused naming the env var only', () => {
    const short = Buffer.from('fifteen-bytes!!', 'utf8').toString('base64');
    const state = createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: short }), ...HARBOR });
    expect(state).toEqual({
      status: 'refused',
      envName: FIELD_ENC_KEY_ENV,
      reason: 'too_short',
      message: `${FIELD_ENC_KEY_ENV} must decode to at least 16 bytes`,
    });
    expect(JSON.stringify(state)).not.toContain(short);
    expect(JSON.stringify(state)).not.toContain('fifteen');
    // Exactly 16 bytes is enough.
    expect(createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: Buffer.alloc(16, 7).toString('base64') }), ...HARBOR }).status).toBe('ok');
  });

  test('a key that is not standard base64 is refused naming the env var only', () => {
    for (const bad of ['not base64 at all!', 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY', 'MDEy-_Q1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=']) {
      const state = createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: bad }), ...HARBOR });
      expect(state.status).toBe('refused');
      expect(state.status === 'refused' ? state.reason : '').toBe('not_base64');
      expect(JSON.stringify(state)).not.toContain(bad);
      expect(inspect(state)).not.toContain(bad);
    }
  });

  test('no result, error, inspect output or log line contains the key in any encoding', async () => {
    const baseBytes = Buffer.from('seeded-secret-key-for-leak-check', 'utf8');
    const envKey = baseBytes.toString('base64');
    const derived = Buffer.from(hkdfSync('sha256', baseBytes, new Uint8Array(0), SIV_HKDF_INFO, 64));
    const forbidden = new Set<string>();
    for (const b of [baseBytes, derived, derived.subarray(0, 32), derived.subarray(32)]) {
      forbidden.add(b.toString('hex'));
      forbidden.add(b.toString('hex').toUpperCase());
      forbidden.add(b.toString('base64'));
      forbidden.add(b.toString('base64url'));
      forbidden.add(b.toString('base64').replace(/=+$/, ''));
    }
    forbidden.add(baseBytes.toString('utf8'));

    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => inspect(a, { depth: 10 })).join(' '));
      }),
    );
    const outputs: string[] = [];
    try {
      const fc = realCrypto(envKey);
      outputs.push(inspect(fc, { depth: 10, showHidden: true }), JSON.stringify(fc));
      const enc = await fc.encryptLookupValue(ctx(), '+919000000001', 'phone');
      outputs.push(JSON.stringify(enc), inspect(enc, { depth: 10, showHidden: true }));
      const dec = await fc.decryptFields(ctx(), [data(enc), tamper(data(enc), 3), 'enc:%%', 'plain']);
      outputs.push(JSON.stringify(dec), inspect(dec, { depth: 10, showHidden: true }));
      for (const p of [
        fc.encryptLookupValue(ctx(), '  ', 'phone'),
        fc.encryptLookupValue(ctx(), 'x', 'bad' as never),
        fc.decryptFields(ctx(), Array.from({ length: 21 }, () => 'x')),
        fc.decryptFields(ctx(), []),
      ]) {
        const err = await caught(p);
        outputs.push(err.message, err.stack ?? '', inspect(err, { depth: 10, showHidden: true }));
      }
      const refused = createFieldCrypto({ config: config({ [FIELD_ENC_KEY_ENV]: `${envKey}!` }), ...HARBOR });
      outputs.push(JSON.stringify(refused), inspect(refused, { showHidden: true }));
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const all = [...outputs, ...logged].join('\n');
    for (const secret of forbidden) expect(all).not.toContain(secret);
    expect(logged).toEqual([]);
  });
});

describe('mock mode', () => {
  function mockConfig(key: string): Config {
    return config({ TRIAGE_MOCK_MODE: 'true', [FIELD_ENC_KEY_ENV]: key });
  }

  function fakePort(answer: (facts: FieldCryptoFacts) => MockLookup): { port: MockPort; calls: FieldCryptoFacts[] } {
    const calls: FieldCryptoFacts[] = [];
    const port: MockPort = {
      enabled: true,
      strict: true,
      lookup: mock(async (tool: string, facts: unknown) => {
        expect(tool).toBe('field_crypto');
        calls.push(facts as FieldCryptoFacts);
        return answer(facts as FieldCryptoFacts);
      }) as MockPort['lookup'],
    };
    return { port, calls };
  }

  test('never reads the env key: an invalid key still gives ok', () => {
    // In real mode this key is refused (see above); in mock mode it is not looked at.
    expect(createFieldCrypto({ config: mockConfig('not base64 at all!'), ...HARBOR }).status).toBe('ok');
    expect(createFieldCrypto({ config: mockConfig(''), ...HARBOR }).status).toBe('ok');
  });

  test('never derives a key', async () => {
    const cryptoModule = await import('node:crypto');
    const spy = spyOn(cryptoModule, 'hkdfSync');
    try {
      const fc = ok(createFieldCrypto({ config: mockConfig(GO_TEST_ENV_KEY), ...HARBOR }));
      const { port } = fakePort(() => ({ hit: true, value: 'enc:fixture', hash: '0123456789abcdef' }));
      await fc.encryptLookupValue(ctx(port), 'ABCDEF', 'cif');
      await fc.decryptFields(ctx(port), ['enc:x']).catch(() => undefined);
      expect(spy).not.toHaveBeenCalled();
      // The spy does see the module's calls: a real-mode setup derives once.
      realCrypto();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('encrypt answers from the fixture with keyInput {op, kind, values}', async () => {
    const fc = ok(createFieldCrypto({ config: mockConfig(GO_TEST_ENV_KEY), ...HARBOR }));
    const { port, calls } = fakePort(() => ({ hit: true, value: 'enc:FROMFIXTURE', hash: '0123456789abcdef' }));
    const out = await fc.encryptLookupValue(ctx(port), ' +919000000001 ', 'phone');
    expect(out.transport).toBe('mock');
    expect(data(out)).toBe('enc:FROMFIXTURE');
    expect(calls).toEqual([{ op: 'encrypt', service: 'harbor', kind: 'phone', values: ['+919000000001'] }]);
  });

  test('decrypt answers from the fixture, with counts recomputed from the items', async () => {
    const fc = ok(createFieldCrypto({ config: mockConfig(GO_TEST_ENV_KEY), ...HARBOR }));
    const fixture: DecryptResult = {
      items: [
        { ok: true, value: '+919000000001', passthrough: false },
        { ok: true, value: 'plain', passthrough: true },
        { ok: false, error: 'auth_failed' },
      ],
      counts: { decrypted: 9, passthrough: 9, failed: 9 },
    };
    const { port, calls } = fakePort(() => ({ hit: true, value: fixture, hash: '0123456789abcdef' }));
    const res = data(await fc.decryptFields(ctx(port), ['enc:a', 'plain', 'enc:b']));
    expect(res.items).toEqual(fixture.items);
    expect(res.counts).toEqual({ decrypted: 1, passthrough: 1, failed: 1 });
    expect(calls).toEqual([{ op: 'decrypt', service: 'harbor', values: ['enc:a', 'plain', 'enc:b'] }]);
  });

  test('the 20-value cap applies before the fixture lookup', async () => {
    const fc = ok(createFieldCrypto({ config: mockConfig(''), ...HARBOR }));
    const { port, calls } = fakePort(() => ({ hit: false, key_string: 'k', hash: '0123456789abcdef' }));
    expect((await caught(fc.decryptFields(ctx(port), Array.from({ length: 21 }, () => 'enc:x')))).code).toBe('refused');
    expect(calls).toEqual([]);
  });

  test('a strict miss throws strict_miss', async () => {
    const fc = ok(createFieldCrypto({ config: mockConfig(''), ...HARBOR }));
    const { port } = fakePort(() => ({ hit: false, key_string: 'k', hash: '0123456789abcdef' }));
    expect((await caught(fc.encryptLookupValue(ctx(port), 'ABCDEF', 'cif'))).code).toBe('strict_miss');
  });

  test('a fixture with the wrong shape is a loud error', async () => {
    const fc = ok(createFieldCrypto({ config: mockConfig(''), ...HARBOR }));
    const bad = fakePort(() => ({ hit: true, value: { nope: true }, hash: '0123456789abcdef' }));
    await expect(fc.encryptLookupValue(ctx(bad.port), 'ABCDEF', 'cif')).rejects.toThrow('fixture has the wrong shape');
    await expect(fc.decryptFields(ctx(bad.port), ['enc:a'])).rejects.toThrow('fixture has the wrong shape');
    const short = fakePort(() => ({ hit: true, value: { items: [], counts: { decrypted: 0, passthrough: 0, failed: 0 } }, hash: '0123456789abcdef' }));
    await expect(fc.decryptFields(ctx(short.port), ['enc:a'])).rejects.toThrow('wrong number of items');
  });

  test('set up in mock mode, a real context cannot run without the key', async () => {
    const fc = ok(createFieldCrypto({ config: mockConfig(GO_TEST_ENV_KEY), ...HARBOR }));
    const err = await caught(fc.encryptLookupValue(ctx(realPort), 'ABCDEF', 'cif'));
    expect(err.code).toBe('not_configured');
    expect(err.message).toContain(FIELD_ENC_KEY_ENV);
    expect(err.message).not.toContain(GO_TEST_ENV_KEY);
  });

  test('works end to end with a field_crypto fixture file in the store', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triage-field-crypto-test-')));
    made.push(dir);
    const key = semanticKey('field_crypto', { op: 'encrypt', service: 'harbor', kind: 'phone', values: ['+919000000001'] });
    const path = join(dir, 'shared', 'field_crypto', 'global', `${keyHash(key)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schema: 1,
        kind: 'field_crypto',
        entity: 'global',
        key,
        key_string: keyString(key),
        result: GOLDEN[1].enc,
        meta: { source: 'hand', recorded_at: '2026-09-23T10:00:00.000Z' },
      }),
    );
    const port = mockPortFromFixtures({
      settings: { mockMode: true, strict: true, record: false },
      store: createFixtureStore({ fixturesDir: dir }),
    });
    const fc = ok(createFieldCrypto({ config: mockConfig(''), ...HARBOR }));
    expect(data(await fc.encryptLookupValue(ctx(port), '+919000000001', 'phone'))).toBe(GOLDEN[1].enc);
    expect((await caught(fc.encryptLookupValue(ctx(port), '+919000000002', 'phone'))).code).toBe('strict_miss');
  });
});
