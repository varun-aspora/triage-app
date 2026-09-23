import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { FixtureMissError } from '../../src/mock/errors.ts';
import { buildToolIndex } from '../../src/tools/index.ts';
import { toolModule as decryptModule } from '../../src/tools/ssfb/decrypt-fields.tool.ts';
import { toolModule as encryptModule, renderCiphertext } from '../../src/tools/ssfb/encrypt-lookup-value.tool.ts';
import type { ToolModule } from '../../src/tools/types.ts';
import { type ToolEnvelope, ToolEnvelopeSchema } from '../../src/types/tool-result.ts';
import { makeTestConfig, makeToolContext } from '../support/fake-tool-context.ts';
import { makeSsfbRun, makeSsfbWorld, memoryFixtures, type SsfbWorld } from '../support/ssfb-tools.ts';

// A synthetic key, seeded so tests can grep for it. 40 bytes of plain text.
const KEY_TEXT = 'synthetic-harbor-field-key-for-tests-042';
const KEY = Buffer.from(KEY_TEXT).toString('base64');
const PHONE = '+919876543210';
const OTHER_PHONE = '+919812345678';
const EMAIL = 'priya.sharma@example.com';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function world(mock: boolean, env: Record<string, string> = {}): SsfbWorld {
  const w = makeSsfbWorld({ mock, env: { SSFB_HARBOR_FIELD_ENC_KEY: KEY, ...env } });
  cleanups.push(w.cleanup);
  return w;
}

function run(w: SsfbWorld, fixtures = memoryFixtures()) {
  const r = makeSsfbRun(w, { fixtures });
  cleanups.push(r.release);
  const encrypt = encryptModule.create(r.ctx, 'investigator');
  const decrypt = decryptModule.create(r.ctx, 'investigator');
  return { ...r, encrypt, decrypt, fixtures };
}

function data(env: ToolEnvelope): Record<string, unknown> {
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  expect(env.output.status).toBe('ok');
  return env.output.data as Record<string, unknown>;
}

describe('encrypt_lookup_value and decrypt_fields (real mode, test key)', () => {
  test('encrypt is deterministic and round-trips through decrypt_fields', async () => {
    const r = run(world(false));
    const a = data(await r.call(r.encrypt, { value: PHONE, kind: 'phone' }));
    const b = data(await r.call(r.encrypt, { value: PHONE, kind: 'phone' }));
    const trimmed = data(await r.call(r.encrypt, { value: `  ${PHONE} `, kind: 'phone' }));
    const other = data(await r.call(r.encrypt, { value: OTHER_PHONE, kind: 'phone' }));

    expect(typeof a['ciphertext']).toBe('string');
    expect(String(a['ciphertext']).startsWith('enc:')).toBe(true);
    expect(b['ciphertext']).toBe(a['ciphertext']);
    expect(trimmed['ciphertext']).toBe(a['ciphertext']);
    expect(other['ciphertext']).not.toBe(a['ciphertext']);

    const out = data(await r.call(r.decrypt, { values: [a['ciphertext'], other['ciphertext'], 'plain-row-value'] }));
    expect(out['items']).toEqual([
      { ok: true, value: PHONE, passthrough: false },
      { ok: true, value: OTHER_PHONE, passthrough: false },
      { ok: true, value: 'plain-row-value', passthrough: true },
    ]);
    expect(out['counts']).toEqual({ decrypted: 2, passthrough: 1, failed: 0 });
  });

  test('a tampered ciphertext fails its own item only', async () => {
    const r = run(world(false));
    const ct = String(data(await r.call(r.encrypt, { value: PHONE, kind: 'phone' }))['ciphertext']);
    const flipped = `enc:${Buffer.from(Buffer.from(ct.slice(4), 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64')}`;
    const out = data(await r.call(r.decrypt, { values: [flipped, ct, 'enc:@@@'] }));
    expect(out['items']).toEqual([
      { ok: false, error: 'auth_failed' },
      { ok: true, value: PHONE, passthrough: false },
      { ok: false, error: 'not_base64' },
    ]);
    expect(out['counts']).toEqual({ decrypted: 1, passthrough: 0, failed: 2 });
  });

  test('decrypt output passes the model-facing profile: email local part masked, phone kept', async () => {
    const r = run(world(false));
    const ctEmail = data(await r.call(r.encrypt, { value: EMAIL, kind: 'email' }))['ciphertext'];
    const ctPhone = data(await r.call(r.encrypt, { value: PHONE, kind: 'phone' }))['ciphertext'];
    const out = data(await r.call(r.decrypt, { values: [ctEmail, ctPhone] }));
    const items = out['items'] as { value: string }[];
    expect(items[0]?.value).toBe('****@example.com');
    expect(items[1]?.value).toBe(PHONE);
    expect(JSON.stringify(out)).not.toContain('priya.sharma');
  });
});

describe('deny: more than 20 values', () => {
  test('the schema says at most 20', () => {
    const r = run(world(false));
    const input = r.decrypt.input as v.GenericSchema;
    expect(v.safeParse(input, { values: Array.from({ length: 20 }, (_, i) => `v${i}`) }).success).toBe(true);
    expect(v.safeParse(input, { values: Array.from({ length: 21 }, (_, i) => `v${i}`) }).success).toBe(false);
    expect(v.safeParse(input, { values: [] }).success).toBe(false);
  });

  test('21 values reaching run() are refused by the gate before any key is read', async () => {
    // A key that is not base64: if the crypto helper ran, the answer would be
    // a connector refusal instead of the gate's text.
    const r = run(world(false, { SSFB_HARBOR_FIELD_ENC_KEY: 'not base64 at all!' }));
    const env = await r.call(r.decrypt, { values: Array.from({ length: 21 }, (_, i) => `enc:v${i}`) });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('at most 20 values');
    expect(r.audit.lines).toHaveLength(1);
    const line = r.audit.lines[0];
    expect(line?.decision).toBe('deny');
    expect(line?.reason).toBe('too many values (21 > 20)');
    expect(line?.count).toBe(21);
    expect(line?.target).toBe('SSFB_HARBOR_FIELD_ENC_KEY');
  });

  test('an empty list reaching run() is refused', async () => {
    const r = run(world(false));
    const env = await r.call(r.decrypt, { values: [] });
    expect(env.output.status).toBe('refused');
    expect(r.audit.lines[0]?.decision).toBe('deny');
  });
});

describe('key never in output, log or audit', () => {
  test('seeded test key is absent from every envelope, log line and audit line', async () => {
    const r = run(world(false));
    const envelopes: ToolEnvelope[] = [];
    const ct = await r.call(r.encrypt, { value: PHONE, kind: 'phone' });
    envelopes.push(ct);
    envelopes.push(await r.call(r.encrypt, { value: EMAIL, kind: 'email' }));
    envelopes.push(await r.call(r.decrypt, { values: [String(data(ct)['ciphertext']), 'enc:AAAA', 'plain'] }));
    envelopes.push(await r.call(r.decrypt, { values: Array.from({ length: 21 }, () => 'x') }));

    // Bad keys go down the refusal paths, which build messages.
    for (const bad of [`${KEY.slice(0, 8)}!!`, Buffer.from('short').toString('base64')]) {
      const b = run(world(false, { SSFB_HARBOR_FIELD_ENC_KEY: bad }));
      const e1 = await b.call(b.encrypt, { value: PHONE, kind: 'phone' });
      const e2 = await b.call(b.decrypt, { values: ['enc:AAAA'] });
      expect(e1.output.status).toBe('refused');
      expect(e2.output.status).toBe('refused');
      const text = JSON.stringify([e1, e2, b.logs, b.audit.lines]);
      expect(text).not.toContain(bad);
    }

    const all = JSON.stringify([envelopes, r.logs, r.audit.lines]);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY_TEXT);
    expect(all).not.toContain(KEY.slice(0, 16));
    expect(r.audit.lines.length).toBe(4);
  });
});

describe('decrypt audit count only', () => {
  test('the audit line has a count and no plaintext or ciphertext', async () => {
    const r = run(world(false));
    const ct = String(data(await r.call(r.encrypt, { value: PHONE, kind: 'phone' }))['ciphertext']);
    await r.call(r.decrypt, { values: [ct, 'plain-row-value'] });

    const [encLine, decLine] = r.audit.lines;
    expect(encLine?.tool).toBe('encrypt_lookup_value');
    expect(encLine?.count).toBe(1);
    expect(encLine?.summary_redacted).toBe('encrypt_lookup_value: 1 value(s)');

    expect(decLine?.tool).toBe('decrypt_fields');
    expect(decLine?.decision).toBe('allow');
    expect(decLine?.transport).toBe('real');
    expect(decLine?.count).toBe(2);
    expect(decLine?.summary_redacted).toBe('decrypt_fields: 2 value(s)');
    const text = JSON.stringify(r.audit.lines);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('plain-row-value');
    expect(text).not.toContain(ct);
  });
});

describe('mock mode', () => {
  test('answers from field_crypto fixtures, reads no key and audits transport mock', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('field_crypto', { op: 'encrypt', kind: 'phone', values: [PHONE] }, 'enc:bW9jay1jaXBoZXJ0ZXh0');
    fixtures.add('field_crypto', { op: 'decrypt', values: ['enc:bW9jay1jaXBoZXJ0ZXh0', 'row'] }, {
      items: [
        { ok: true, value: PHONE, passthrough: false },
        { ok: true, value: 'row', passthrough: true },
      ],
      // Wrong on purpose: counts are recomputed from the items.
      counts: { decrypted: 9, passthrough: 9, failed: 9 },
    });
    // A key that cannot be decoded: mock mode must not try.
    const r = run(world(true, { SSFB_HARBOR_FIELD_ENC_KEY: 'not base64 at all!' }), fixtures);

    const enc = data(await r.call(r.encrypt, { value: PHONE, kind: 'phone' }));
    expect(enc['ciphertext']).toBe('enc:bW9jay1jaXBoZXJ0ZXh0');
    const dec = data(await r.call(r.decrypt, { values: ['enc:bW9jay1jaXBoZXJ0ZXh0', 'row'] }));
    expect(dec['counts']).toEqual({ decrypted: 1, passthrough: 1, failed: 0 });
    expect(r.audit.lines.map((l) => l.transport)).toEqual(['mock', 'mock']);
    expect(r.audit.lines[1]?.summary_redacted).toBe('decrypt_fields: 2 value(s)');
  });

  test('a strict miss throws and writes a fixture_miss audit line', async () => {
    const r = run(world(true));
    await expect(r.call(r.decrypt, { values: ['enc:AAAA'] })).rejects.toBeInstanceOf(FixtureMissError);
    expect(r.audit.lines[0]?.exit).toBe('fixture_miss');
  });

  test('a decrypt fixture with the wrong number of items is a loud error', async () => {
    const fixtures = memoryFixtures();
    fixtures.add('field_crypto', { op: 'decrypt', values: ['a', 'b'] }, {
      items: [{ ok: true, value: 'a', passthrough: true }],
      counts: { decrypted: 0, passthrough: 1, failed: 0 },
    });
    const r = run(world(true), fixtures);
    await expect(r.call(r.decrypt, { values: ['a', 'b'] })).rejects.toThrow('wrong number of items');
  });
});

describe('ciphertext rendering', () => {
  test('a ciphertext that redaction would mask comes back as null with a note', () => {
    // 'pWD' followed by '==' reads as a pwd=value secret to the credential detector.
    const masked = renderCiphertext('phone', 'enc:pWDQmgAbuKB703xmk66sE1rSgVjhrA==');
    expect(masked['ciphertext']).toBeNull();
    expect(String(masked['note'])).toContain('Record the gap');
    const kept = renderCiphertext('phone', 'enc:bW9jay1jaXBoZXJ0ZXh0');
    expect(kept['ciphertext']).toBe('enc:bW9jay1jaXBoZXJ0ZXh0');
  });

  test('a fixture that is not a ciphertext is a loud error', () => {
    expect(() => renderCiphertext('phone', 'plain')).toThrow('wrong shape');
    expect(() => renderCiphertext('phone', 42)).toThrow('wrong shape');
  });
});

describe('isEnabled false on blank key', () => {
  const modules: readonly ToolModule[] = [encryptModule, decryptModule];

  for (const [label, value] of [
    ['blank', ''],
    ['whitespace', '   '],
    ['missing', undefined],
  ] as const) {
    test(`both tools are off when SSFB_HARBOR_FIELD_ENC_KEY is ${label}`, () => {
      // The registry refuses a .env without the key, so it is built from a blank one.
      const registry = makeToolContext({ config: makeTestConfig({ SSFB_HARBOR_FIELD_ENC_KEY: '' }) }).registry;
      const config = makeTestConfig({ SSFB_HARBOR_FIELD_ENC_KEY: value });
      const ctx = makeToolContext({ entity: 'ssfb', config, registry });
      for (const m of modules) {
        const state = m.enabled(ctx, 'investigator');
        expect(state).toEqual({ on: false, reason: 'SSFB_HARBOR_FIELD_ENC_KEY is blank' });
      }
      const plan = buildToolIndex(modules).mountPlan('investigator', ctx);
      expect(plan.every((row) => !row.on)).toBe(true);
      expect(buildToolIndex(modules).toolsFor('investigator', ctx)).toEqual([]);
    });
  }

  test('both tools are on with a key, for the SSFB investigator only, without touching deps', () => {
    const config = makeTestConfig({ SSFB_HARBOR_FIELD_ENC_KEY: KEY });
    const ssfb = makeToolContext({ entity: 'ssfb', config });
    for (const m of modules) {
      expect(m.enabled(ssfb, 'investigator')).toEqual({ on: true });
      expect(m.create(ssfb, 'investigator').name).toBe(m.name);
      expect(m.entities).toEqual(['ssfb']);
    }
    const index = buildToolIndex(modules);
    expect(index.toolsFor('investigator_deep', ssfb).map((t) => t.name).sort()).toEqual([
      'decrypt_fields',
      'encrypt_lookup_value',
    ]);
    expect(index.toolsFor('investigator', makeToolContext({ entity: 'atspl', config }))).toEqual([]);
  });
});
